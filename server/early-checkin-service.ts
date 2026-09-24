/**
 * Early check-in at the guest info kiosk.
 *
 * A guest with an EXISTING reservation types their door code on the kiosk,
 * pays per started hour until the normal check-in time (MEWS payment request,
 * QR on screen → guest pays on their own phone → kiosk polls), and their
 * UNCHANGED code's validity window is moved earlier on every lock. The code
 * digits are never touched (point of truth).
 *
 * If the capsule is not "Inspected" in MEWS yet, the guest can leave an email
 * on the kiosk; the 5-minute sweep emails them when housekeeping marks it
 * Inspected, and they complete the flow at the screen.
 */

import { Storage, db, type ITenantStorage } from "./storage";
import { config } from "./config";
import {
  earlyCheckins,
  reservations as reservationsTable,
  type Reservation,
  type EarlyCheckin,
} from "@shared/schema";
import { and, eq, gte, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { buildValidityWindow, hasActiveLateCheckout, EARLY_CHECKIN_MAX_ADVANCE_MS } from "./pin-validity-window";
import { getSpaceDisplayName } from "@shared/display-name";
import { twinRoomIds, hourlyBookingBlocksRooms } from "./room-pairing";
import { createNotificationClient } from "./notification-client";
import type { AutomationEngine } from "./automation";

const PAYMENT_HOLD_MINUTES = 30;
const PAYMENT_EXPIRE_MINUTES = 35;

export type EarlyCheckinRejection =
  | "disabled"
  | "not_found"
  | "already_checked_in"
  | "already_active"
  // Tiered model (5/8): a FUTURE purchased start means the code isn't active
  // yet, so the already_active gate can't catch a re-buy — this one does.
  | "already_bought"
  | "owing"
  | "too_early"
  | "not_ready"
  | "not_available"
  | "occupied"
  | "mews_unavailable"
  // MEWS refuses payment requests for customers without a valid email (OTA
  // bookings often carry none) and we have nothing on file — the UI must ask
  // the guest to type one and retry with { email }.
  | "email_required";

/**
 * One buyable access-start (owner 5/8, mirrors the late-checkout tiers): the
 * guest picks WHEN their code starts working, at a fixed price per start time.
 * `from` is the ISO instant, `label` the local "HH:mm" ("now" in the legacy
 * hourly model), `hours` the distance to the normal check-in — completion
 * derives the access start back from it (validFrom − hours), no extra column.
 */
export interface EarlyCheckinOption {
  from: string;
  label: string;
  hours: number;
  dkk: number;
  eur: number;
}

export interface EarlyCheckinQuote {
  ok: true;
  reservation: Reservation;
  roomLabel: string;
  roomPmsId: string;
  inspected: boolean;
  options: EarlyCheckinOption[];
  // First (earliest) option mirrored top-level — the kiosk UI and older
  // clients read these directly.
  hours: number;
  dkk: number;
  eur: number;
  pricePerHour: number;
  currency: string;
  validFrom: Date;
}

export interface EarlyCheckinRejected {
  ok: false;
  reason: EarlyCheckinRejection;
}

async function isEnabled(storage: ITenantStorage): Promise<boolean> {
  return (await storage.getSetting("early_checkin_enabled"))?.value === "true";
}

const MEWS_EMAIL_REQUIRED_RE = /valid email address/i;
const EMAIL_SHAPE_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * paymentRequests/add REQUIRES the MEWS customer to have a valid email — OTA/
 * imported bookings often have none (25/7: a guest was hard-blocked on the
 * extend page with the generic error). Run the create; on that specific 403,
 * patch the customer with the best email we hold (guest-typed > personalEmail
 * > email) and retry once. With NOTHING on file, the guest is NEVER asked
 * (owner decision 25/7): a dead per-reservation placeholder on our own domain
 * satisfies MEWS' format requirement — SendPaymentRequestEmails is false, so
 * no mail is ever sent to it. Only a guest-typed email is persisted on the
 * reservation; placeholders never touch our data.
 */
export async function createPaymentRequestHandlingMissingEmail<T>(
  mews: NonNullable<ReturnType<AutomationEngine["getMewsClient"]>>,
  storage: ITenantStorage,
  reservation: Reservation,
  customerId: string,
  guestEmail: string | undefined,
  create: () => Promise<T>,
): Promise<{ ok: true; value: T } | EarlyCheckinRejected> {
  try {
    return { ok: true, value: await create() };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!MEWS_EMAIL_REQUIRED_RE.test(msg)) throw error;
    const typed = (guestEmail || "").trim();
    const candidate = [typed, reservation.personalEmail, reservation.email]
      .map((v) => (v || "").trim())
      .find((v) => EMAIL_SHAPE_RE.test(v));
    const email = candidate ?? `guest-${reservation.id.slice(0, 8)}@${config.guestEmailFallbackDomain}`;
    await mews.updateCustomerEmail(customerId, email);
    if (typed && EMAIL_SHAPE_RE.test(typed) && !reservation.personalEmail) {
      await storage.updateReservation(reservation.id, { personalEmail: typed });
      reservation.personalEmail = typed; // callers read it for the purchase row's email column
    }
    await storage.createLog({
      level: "info",
      message: candidate
        ? `Payment request retried after adding email to MEWS customer ${customerId} (guest ${reservation.firstName} ${reservation.lastName})`
        : `Payment request retried with PLACEHOLDER email on MEWS customer ${customerId} (guest ${reservation.firstName} ${reservation.lastName} has no email on file — no mail is ever sent to it)`,
      source: "early-checkin",
      reservationId: reservation.id,
    });
    return { ok: true, value: await create() };
  }
}

/**
 * Tiered early check-in (owner 5/8): `early_checkin_price_tiers` =
 * "10:00=119,12:00=79,14:00=49" — fixed access-START times on the arrival day
 * at fixed prices; earlier = pricier. A tier whose time has passed is simply
 * "check in now" — only the LATEST passed tier is offered (same access, lowest
 * price), plus every future tier. Tiers before `freeFromMs` (previous guest /
 * hourly booking still inside) are not sellable. `hours` is the distance to
 * the normal window start — completion derives the access start back from it.
 */
/**
 * Cleaning buffer (owner 6/8, Martin: "der skal min. være 1 time overlab"):
 * when the capsule IS occupied before the sold start (departing guest still
 * inside / hourly booking), housekeeping needs a real gap — access must never
 * start the minute the previous occupant's window ends (511: previous guest
 * until 10:00, early check-in sold FROM 10:00, guest waiting at the door of a
 * dirty capsule). A capsule that is free all morning is unaffected — 10:00
 * stays sellable there.
 */
export function withCleaningBuffer(freeFromMs: number, bufferMinutes: number): number {
  return freeFromMs > 0 ? freeFromMs + bufferMinutes * 60 * 1000 : 0;
}

export function selectEarlyCheckinTierOptions(
  tiers: Array<{ hhmm: string; dkk: number }>,
  validFromMs: number,
  nowMs: number,
  freeFromMs: number,
  tz: string,
  eurRate: number
): EarlyCheckinOption[] {
  const arrivalDay = DateTime.fromMillis(validFromMs, { zone: "utc" }).setZone(tz);
  const candidates = tiers
    .map((t) => ({ at: timeOnDay(arrivalDay, t.hhmm), dkk: t.dkk }))
    .filter((c) => c.at.toMillis() < validFromMs);
  const lastPassed = candidates.filter((c) => c.at.toMillis() <= nowMs).pop();
  return candidates
    .filter((c) => c.at.toMillis() > nowMs || c === lastPassed)
    .filter((c) => c.at.toMillis() >= freeFromMs)
    .map((c) => ({
      from: c.at.toUTC().toISO()!,
      label: c.at.toFormat("HH:mm"),
      hours: Math.max(1, Math.round((validFromMs - c.at.toMillis()) / 3600e3)),
      dkk: Math.round(c.dkk),
      eur: Math.round(c.dkk / eurRate),
    }));
}

/**
 * Validate the door code and build a price quote. Shared by lookup/pay/waitlist.
 */
export async function quoteEarlyCheckin(
  tenantId: string,
  doorCode: string,
  engine: AutomationEngine
): Promise<EarlyCheckinQuote | EarlyCheckinRejected> {
  const storage = Storage.forTenant(tenantId);
  if (!(await isEnabled(storage))) return { ok: false, reason: "disabled" };

  const code = doorCode.trim();
  if (!/^\d{4,8}$/.test(code)) return { ok: false, reason: "not_found" };

  // The door code is the guest's identity here: generated_pin is unique among
  // live bookings (enforced by both PIN generators), so code+tenant is exact.
  const rows = await db
    .select()
    .from(reservationsTable)
    .where(
      and(
        eq(reservationsTable.tenantId, tenantId),
        eq(reservationsTable.generatedPin, code),
        inArray(reservationsTable.status, ["Confirmed", "Started", "Checked-in", "confirmed", "started", "checked-in"])
      )
    );
  const now = Date.now();
  const live = rows.filter((r) => new Date(r.departure).getTime() > now);
  if (live.length === 0) return { ok: false, reason: "not_found" };
  const reservation = live.sort((a, b) => new Date(a.arrival).getTime() - new Date(b.arrival).getTime())[0];

  const status = (reservation.status || "").toLowerCase();
  if (status === "checked-in" || status === "started") {
    return { ok: false, reason: "already_checked_in" };
  }
  // A purchased FUTURE start (tier bought in advance) hasn't opened the window
  // yet — without this gate the guest could buy early check-in twice.
  if (reservation.earlyCheckinFrom) return { ok: false, reason: "already_bought" };
  if (parseFloat(reservation.owing ?? "0") > 0) return { ok: false, reason: "owing" };
  if (!reservation.roomId) return { ok: false, reason: "not_ready" };

  const room = await storage.getRoom(reservation.roomId);
  if (!room?.pmsId) return { ok: false, reason: "not_ready" };

  const { validFrom } = await buildValidityWindow(storage, reservation);
  if (now >= validFrom.getTime()) return { ok: false, reason: "already_active" };
  // Sellable 24/7 within the sale horizon (matches the fold band).
  if (validFrom.getTime() - now > EARLY_CHECKIN_MAX_ADVANCE_MS) return { ok: false, reason: "too_early" };

  // OCCUPANCY GUARD: the capsule must be physically free before the sold
  // access start — a departing guest (incl. their paid late checkout, even
  // after MEWS flips them Checked-out) or an hourly booking pushes the
  // earliest sellable start (`freeFromMs`) to when they're out; with tiers,
  // later start times stay sellable. Status matching is case-insensitive:
  // the auto-check-in webhook writes lowercase "checked-in".
  // TWIN SPACES: "401"/"401s" are the same physical bed — check both.
  const twinIds = twinRoomIds(await storage.getAllRooms(), reservation.roomId);
  const others = await db
    .select()
    .from(reservationsTable)
    .where(
      and(
        eq(reservationsTable.tenantId, tenantId),
        inArray(reservationsTable.roomId, twinIds)
      )
    );
  let freeFromMs = 0; // epoch ms the capsule becomes free (0 = free now)
  for (const other of others) {
    if (other.id === reservation.id) continue;
    const otherStatus = (other.status || "").toLowerCase();
    const occupiesAsLateCheckout = otherStatus === "checked-out" && hasActiveLateCheckout(other);
    if (!["confirmed", "started", "checked-in"].includes(otherStatus) && !occupiesAsLateCheckout) continue;
    // Their occupancy can start EARLIER than raw arrival via their own early check-in.
    const otherStart = Math.min(
      new Date(other.arrival).getTime(),
      other.earlyCheckinFrom ? new Date(other.earlyCheckinFrom).getTime() : Number.POSITIVE_INFINITY
    );
    if (otherStart >= validFrom.getTime()) continue; // starts after our guest
    const otherWindow = await buildValidityWindow(storage, other);
    if (otherWindow.validTo.getTime() > now) freeFromMs = Math.max(freeFromMs, otherWindow.validTo.getTime());
  }
  try {
    const hourly = await storage.getHourlyBookingsOverlapping(new Date(now), validFrom, ["confirmed", "pending_payment"]);
    for (const hb of hourly) {
      // Grace-aware: a moved arrived guest's code is live on the grace-target
      // capsule too — early access must not be sold into it.
      if (hourlyBookingBlocksRooms(hb, twinIds)) freeFromMs = Math.max(freeFromMs, new Date(hb.endAt).getTime());
    }
  } catch { /* hourly unavailable — no restriction */ }

  // Occupied capsules get the cleaning buffer added to the earliest sellable
  // start; free capsules keep freeFromMs = 0. Configurable, default 60 min.
  const bufferRaw = (await storage.getSetting("early_checkin_cleaning_buffer_minutes"))?.value;
  const bufferParsed = parseInt(bufferRaw || "", 10);
  const bufferMinutes = Number.isFinite(bufferParsed) && bufferParsed >= 0 ? bufferParsed : 60;
  freeFromMs = withCleaningBuffer(freeFromMs, bufferMinutes);

  const mews = engine.getMewsClient();
  if (!mews) return { ok: false, reason: "mews_unavailable" };
  let inspected = false;
  try {
    const resources = await mews.getResources([room.pmsId]);
    inspected = (resources[0]?.State || "").toLowerCase() === "inspected";
  } catch {
    return { ok: false, reason: "mews_unavailable" };
  }

  const pricePerHour = parseFloat((await storage.getSetting("early_checkin_price_per_hour"))?.value || "75") || 75;
  const eurRate = parseFloat((await storage.getSetting("early_checkin_eur_rate"))?.value || "7.45") || 7.45;
  const tiers = parseLateCheckoutTiers((await storage.getSetting("early_checkin_price_tiers"))?.value);

  let options: EarlyCheckinOption[];
  if (tiers.length > 0) {
    const tz = (await storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
    options = selectEarlyCheckinTierOptions(tiers, validFrom.getTime(), now, freeFromMs, tz, eurRate);
    if (options.length === 0) {
      return { ok: false, reason: freeFromMs > now ? "occupied" : "not_available" };
    }
  } else {
    // Legacy hourly model: one "from now" quote — the capsule must be free NOW.
    if (freeFromMs > now) return { ok: false, reason: "occupied" };
    const hours = Math.max(1, Math.ceil((validFrom.getTime() - now) / (60 * 60 * 1000)));
    const dkk = Math.round(hours * pricePerHour);
    options = [{ from: new Date(now).toISOString(), label: "now", hours, dkk, eur: Math.round(dkk / eurRate) }];
  }

  return {
    ok: true,
    reservation,
    roomLabel: getSpaceDisplayName(room.name, room.label),
    roomPmsId: room.pmsId,
    inspected,
    options,
    hours: options[0].hours,
    dkk: options[0].dkk,
    eur: options[0].eur,
    pricePerHour,
    currency: "DKK",
    validFrom,
  };
}

async function getLiveRow(reservationId: string, kind: string = "early_checkin"): Promise<EarlyCheckin | undefined> {
  const rows = await db
    .select()
    .from(earlyCheckins)
    .where(
      and(
        eq(earlyCheckins.reservationId, reservationId),
        eq(earlyCheckins.kind, kind),
        inArray(earlyCheckins.status, ["awaiting_inspection", "pending_payment"])
      )
    );
  return rows[0];
}

/**
 * Start (or resume) a payment. Idempotent: a live pending_payment row's URL is
 * returned as-is, and an awaiting_inspection row is converted in place so the
 * partial unique index never trips.
 */
export async function startEarlyCheckinPayment(
  tenantId: string,
  doorCode: string,
  engine: AutomationEngine,
  guestEmail?: string,
  fromISO?: string
): Promise<{ ok: true; id: string; paymentUrl: string; dkk: number; eur: number; hours: number; label: string } | EarlyCheckinRejected> {
  const quote = await quoteEarlyCheckin(tenantId, doorCode, engine);
  if (!quote.ok) return quote;
  // A not-yet-inspected capsule is SELLABLE (the occupancy guard already
  // ensured it is free) — completion alerts housekeeping by SMS to clean NOW.

  // Tiered: the guest picked an access-start; no `from` (kiosk / legacy
  // clients) buys the earliest available start.
  const option = fromISO ? quote.options.find((o) => o.from === fromISO) : quote.options[0];
  if (!option) return { ok: false, reason: "not_available" as EarlyCheckinRejection };

  const storage = Storage.forTenant(tenantId);
  const mews = engine.getMewsClient()!;
  const reservation = quote.reservation;

  const existing = await getLiveRow(reservation.id);
  if (
    existing?.status === "pending_payment" &&
    existing.paymentRef &&
    existing.hours === option.hours &&
    Date.now() - new Date(existing.createdAt).getTime() < PAYMENT_HOLD_MINUTES * 60 * 1000
  ) {
    return {
      ok: true,
      id: existing.id,
      paymentUrl: mews.getPaymentRequestUrl(existing.paymentRef),
      dkk: parseFloat(existing.amount || String(option.dkk)),
      eur: option.eur,
      hours: existing.hours ?? option.hours,
      label: option.label,
    };
  }

  // The guest changed their option (or the hold aged out) while an old payment
  // request exists: verify it first — if they already PAID the old one, grant
  // that instead of dangling a completed payment with no access.
  if (existing?.status === "pending_payment" && existing.paymentRef) {
    try {
      const [oldPr] = await mews.getPaymentRequestsByIds([existing.paymentRef]);
      if (oldPr?.State === "Completed") {
        await completeEarlyCheckin(existing, engine);
        return {
          ok: true,
          id: existing.id,
          paymentUrl: mews.getPaymentRequestUrl(existing.paymentRef),
          dkk: parseFloat(existing.amount || "0"),
          eur: 0,
          hours: existing.hours ?? 1,
          label: `${existing.hours ?? 1}h`,
        };
      }
    } catch { /* verification failed — proceed with a fresh request */ }
  }

  let customerId = reservation.mewsCustomerId;
  if (!customerId) {
    const customer = await mews.addCustomer({
      firstName: reservation.firstName || undefined,
      lastName: reservation.lastName || "Guest",
      email: reservation.personalEmail || reservation.email || undefined,
      phone: reservation.mobile || undefined,
    });
    customerId = customer.Id;
    await storage.updateReservation(reservation.id, { mewsCustomerId: customerId });
  }

  const prResult = await createPaymentRequestHandlingMissingEmail(
    mews, storage, reservation, customerId, guestEmail,
    () => mews.createPaymentRequest(
      customerId!,
      option.dkk,
      quote.currency,
      reservation.pmsId,
      `Early check-in Capsule ${quote.roomLabel} from ${option.label}`,
      new Date(Date.now() + PAYMENT_HOLD_MINUTES * 60 * 1000).toISOString(),
      false
    ),
  );
  if (!prResult.ok) return prResult;
  const pr = prResult.value;

  const rowValues = {
    status: "pending_payment" as const,
    paymentRef: pr.Id,
    amount: String(option.dkk),
    currency: quote.currency,
    hours: option.hours,
    updatedAt: new Date(),
  };

  let rowId: string;
  if (existing) {
    // Convert the waitlist row (or refresh an expired-hold pending row) in place.
    await db.update(earlyCheckins).set(rowValues).where(eq(earlyCheckins.id, existing.id));
    rowId = existing.id;
  } else {
    const inserted = await db
      .insert(earlyCheckins)
      .values({
        tenantId,
        reservationId: reservation.id,
        roomId: reservation.roomId,
        email: reservation.personalEmail || reservation.email || null,
        ...rowValues,
      })
      .returning({ id: earlyCheckins.id });
    rowId = inserted[0].id;
  }

  await storage.createLog({
    level: "info",
    message: `Early check-in payment started for ${reservation.firstName} ${reservation.lastName} (Capsule ${quote.roomLabel}): from ${option.label} (${option.hours}h) = ${option.dkk} DKK (payment request ${pr.Id})`,
    source: "early-checkin",
    reservationId: reservation.id,
  });

  return { ok: true, id: rowId, paymentUrl: mews.getPaymentRequestUrl(pr.Id), dkk: option.dkk, eur: option.eur, hours: option.hours, label: option.label };
}

/**
 * Completion: runs EXACTLY once per row (compare-and-set). Grants access by
 * setting reservations.early_checkin_from to the PURCHASED access start —
 * derived from the row's hours against the normal window start (validFrom −
 * hours), same derivation pattern as late checkout, so no extra column is
 * needed. Legacy hourly rows derive ≈ the purchase time. buildValidityWindow
 * folds it in, so repair/reconcile converge the locks even if the direct push
 * fails. The guest's code digits are untouched.
 */
export async function completeEarlyCheckin(
  row: EarlyCheckin,
  engine: AutomationEngine
): Promise<boolean> {
  // reservationId is only NULL on historical rows whose reservation was later
  // deleted (SET NULL, 3/8) — a row being completed is live by definition.
  const reservationId = row.reservationId;
  if (!reservationId) return true;
  const cas = await db
    .update(earlyCheckins)
    .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(earlyCheckins.id, row.id), eq(earlyCheckins.status, "pending_payment")))
    .returning({ id: earlyCheckins.id });
  if (cas.length === 0) return true; // someone else completed it — no-op

  const storage = Storage.forTenant(row.tenantId);
  // Derive the access start BEFORE the fold changes validFrom.
  const reservation = await storage.getReservation(reservationId);
  const guestName = reservation ? `${reservation.firstName} ${reservation.lastName}` : reservationId;
  let accessFrom = new Date();
  if (reservation) {
    const { validFrom } = await buildValidityWindow(storage, reservation);
    const derived = new Date(validFrom.getTime() - (row.hours ?? 1) * 3600e3);
    if (derived.getTime() < validFrom.getTime()) accessFrom = derived;
  }
  // A tier bought in advance (e.g. "from 14:00" paid at 09:05) starts LATER —
  // no immediate activation or MEWS check-in; the poller opens the folded
  // window on time and the front-door detection checks the guest in on first
  // code use.
  const startsInFuture = accessFrom.getTime() > Date.now();
  await storage.updateReservation(reservationId, { earlyCheckinFrom: accessFrom });
  if (reservation) reservation.earlyCheckinFrom = accessFrom;

  // Push the earlier window to the locks NOW. Any failure here is non-fatal:
  // the hourly reconcile + repair jobs now agree on the earlier window and
  // will converge the locks automatically.
  try {
    const pins = await storage.getPinsByReservationId(reservationId);
    const livePin = pins.find((p) => p.status === "active" || p.status === "used");
    if (livePin) {
      await engine.updatePinValidity(reservationId, { force: true });
    } else if (!startsInFuture) {
      await engine.immediatelyActivatePendingPin(reservationId);
    }
  } catch (error) {
    await storage.createLog({
      level: "error",
      message: `Early check-in: immediate lock update failed for ${guestName} — repair/reconcile will converge: ${error instanceof Error ? error.message : String(error)}`,
      source: "early-checkin",
      reservationId: reservationId,
    });
  }

  const mews = engine.getMewsClient();

  // MEWS check-in (owner decision 24/7): buying early check-in means the
  // guest is standing at the kiosk RIGHT NOW — check them in in MEWS
  // immediately instead of waiting for the front-door code detection.
  // Same semantics as the lock-arrival flow: if MEWS REJECTS, the guest
  // stays Confirmed locally (hiding the divergence would let MEWS' night
  // audit no-show an arrived guest), and the front-door detection retries
  // on first code use. Failures never block the purchase.
  try {
    const resStatus = (reservation?.status || "").toLowerCase();
    if (!startsInFuture && mews && reservation?.pmsId && !["checked-in", "started", "processed", "checked-out", "cancelled"].includes(resStatus)) {
      const result = await mews.startReservation(reservation.pmsId);
      if (result.success) {
        await storage.updateReservation(reservationId, {
          status: "checked-in",
          pmsCheckinSource: "early-checkin",
        });
        await storage.createLog({
          level: "info",
          message: `Early check-in: ${guestName} checked in in MEWS (purchase completed at the kiosk)`,
          source: "early-checkin",
          reservationId: reservationId,
        });
      } else {
        await storage.createLog({
          level: "warn",
          message: `Early check-in: MEWS check-in rejected for ${guestName}: ${result.error || "unknown"} — guest stays Confirmed; front-door detection retries on first code use`,
          source: "early-checkin",
          reservationId: reservationId,
        });
      }
    }
  } catch (error) {
    await storage.createLog({
      level: "warn",
      message: `Early check-in: MEWS check-in attempt failed for ${guestName}: ${error instanceof Error ? error.message : String(error)}`,
      source: "early-checkin",
      reservationId: reservationId,
    });
  }

  // Cleaning alert — FAIL-SAFE direction: the SMS is skipped ONLY when MEWS
  // positively confirms the capsule is Inspected. Unknown state (fetch failure,
  // missing client) sends the SMS anyway — a dirty-capsule sale must never go
  // silently unalerted. Missing phone setting is a configuration ERROR.
  try {
    const room = reservation?.roomId ? await storage.getRoom(reservation.roomId) : null;
    if (room) {
      let state = "ukendt";
      let confirmedInspected = false;
      if (mews && room.pmsId) {
        try {
          const resources = await mews.getResources([room.pmsId]);
          state = resources[0]?.State || "ukendt";
          confirmedInspected = state.toLowerCase() === "inspected";
        } catch { /* state stays unknown → SMS sent */ }
      }
      if (!confirmedInspected) {
        const phone = (await storage.getSetting("early_checkin_cleaning_sms_phone"))?.value;
        const label = getSpaceDisplayName(room.name, room.label);
        if (!phone) {
          await storage.createLog({
            level: "error",
            message: `Early check-in: capsule ${label} is NOT confirmed Inspected but early_checkin_cleaning_sms_phone is not configured — cleaning alert NOT sent!`,
            source: "early-checkin",
            reservationId: reservationId,
          });
        } else {
          const notif = await createNotificationClient(storage);
          const tzAlert = (await storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
          const accessLabel = startsInFuture
            ? `fra kl. ${DateTime.fromJSDate(accessFrom).setZone(tzAlert).toFormat("HH:mm")}`
            : "fra NU";
          const sent = await notif.sendPlainSMS({
            to: phone,
            body: `RENGØRING NU: Early check-in er købt for Capsule ${label}. Gæsten har adgang ${accessLabel} — capsulen skal rengøres omgående. (Housekeeping-status: ${state})`,
          });
          await storage.createLog({
            level: sent.success ? "info" : "error",
            message: sent.success
              ? `Early check-in: cleaning SMS sent to ${phone} for Capsule ${label} (state: ${state})`
              : `Early check-in: cleaning SMS FAILED to ${phone} for Capsule ${label}: ${sent.error}`,
            source: "early-checkin",
            reservationId: reservationId,
          });
        }
      }
    }
  } catch (error) {
    await storage.createLog({
      level: "error",
      message: `Early check-in: cleaning-alert block failed entirely: ${error instanceof Error ? error.message : String(error)}`,
      source: "early-checkin",
      reservationId: reservationId,
    });
  }

  // Book the revenue on the dedicated MEWS product so the payment (attached to
  // the reservation via the payment request) settles against a real order line.
  if (mews && reservation?.pmsId) {
    const productId = (await storage.getSetting("early_checkin_mews_product_id"))?.value;
    // Same tax-code setting as the hourly bookings — without an explicit
    // TaxCodes, Mews books the price override as VAT-exempt.
    const taxCode = (await storage.getSetting("hourly_mews_tax_code"))?.value || "DK-S";
    // Post the ACTUAL paid amount as Count 1 × amount — with tiered pricing
    // (5/8) the amount is no longer hours × a flat rate, so posting per-hour
    // units would book the wrong revenue (same fix as late checkout, 4/8).
    const amountDkk = parseFloat(row.amount || "0") || 0;
    const note = `Early check-in paid: ${row.hours}h = ${row.amount} ${row.currency || "DKK"} (payment request ${row.paymentRef})`;
    try {
      if (productId && amountDkk > 0) {
        await mews.addReservationProduct(reservation.pmsId, productId, 1, {
          currency: row.currency || "DKK",
          grossValue: amountDkk,
          taxCode,
        });
      } else {
        await mews.addReservationNote(reservation.pmsId, note);
      }
    } catch (error) {
      try {
        await mews.addReservationNote(reservation.pmsId, `${note} — PRODUCT POSTING FAILED, book manually`);
      } catch { /* note is best-effort */ }
      await storage.createLog({
        level: "warn",
        message: `Early check-in: MEWS product posting failed for ${guestName}: ${error instanceof Error ? error.message : String(error)}`,
        source: "early-checkin",
        reservationId: reservationId,
      });
    }
  }

  await storage.createLog({
    level: "info",
    message: `Early check-in COMPLETED for ${guestName}: access from ${accessFrom.toISOString()} (${row.hours}h, ${row.amount} ${row.currency || "DKK"})`,
    source: "early-checkin",
    reservationId: reservationId,
  });
  return true;
}

/**
 * Crash/deploy recovery for PAID early check-ins (incident 21/7: two deploy
 * restarts landed mid-activation — the room lock got the code but the pin row
 * stayed "pending" with no lock keys, and nothing re-activated it before the
 * normal pre-check-in pass hours later). completeEarlyCheckin already granted
 * access (earlyCheckinFrom is set, payment charged), so a completed row whose
 * reservation still has ONLY a pending pin means the activation push was
 * interrupted — re-run it. Called from every poller fast tick; the query is
 * one indexed select and almost always returns nothing.
 */
export async function recoverInterruptedEarlyCheckins(
  tenantId: string,
  engine: AutomationEngine
): Promise<number> {
  const rows = await db
    .select()
    .from(earlyCheckins)
    .where(
      and(
        eq(earlyCheckins.tenantId, tenantId),
        eq(earlyCheckins.kind, "early_checkin"),
        eq(earlyCheckins.status, "completed"),
        gte(earlyCheckins.completedAt, new Date(Date.now() - 48 * 3600_000))
      )
    );
  if (rows.length === 0) return 0;

  const storage = Storage.forTenant(tenantId);
  let recovered = 0;
  for (const row of rows) {
    if (!row.reservationId) continue; // historical row — reservation deleted
    const reservation = await storage.getReservation(row.reservationId);
    if (!reservation) continue;
    const status = (reservation.status || "").toLowerCase();
    if (!["confirmed", "started", "checked-in"].includes(status)) continue;
    if (new Date(reservation.departure).getTime() <= Date.now()) continue;

    const pins = await storage.getPinsByReservationId(row.reservationId);
    if (pins.some((p) => p.status === "active" || p.status === "used")) continue; // activation landed
    if (!pins.some((p) => p.status === "pending")) continue; // nothing to activate
    // A tier bought in advance starts LATER — the pin is SUPPOSED to be
    // pending until the paid start; the poller activates it on time.
    const { validFrom } = await buildValidityWindow(storage, reservation);
    if (validFrom.getTime() > Date.now()) continue;

    await storage.createLog({
      level: "warn",
      message: `Early check-in recovery: paid ${row.completedAt?.toISOString() ?? "?"} but PIN is still pending — re-running activation (interrupted by a restart?)`,
      source: "early-checkin",
      reservationId: row.reservationId,
    });
    try {
      const result = await engine.immediatelyActivatePendingPin(row.reservationId);
      if (result.success) recovered++;
      await storage.createLog({
        level: result.success ? "info" : "error",
        message: result.success
          ? `Early check-in recovery: PIN activated and pushed to locks for ${reservation.firstName} ${reservation.lastName}`
          : `Early check-in recovery: activation failed for ${reservation.firstName} ${reservation.lastName}: ${result.error || "unknown"} — will retry next tick`,
        source: "early-checkin",
        reservationId: row.reservationId,
      });
    } catch (error) {
      await storage.createLog({
        level: "error",
        message: `Early check-in recovery: activation threw for ${reservation.firstName} ${reservation.lastName}: ${error instanceof Error ? error.message : String(error)} — will retry next tick`,
        source: "early-checkin",
        reservationId: row.reservationId,
      });
    }
  }
  return recovered;
}

// ── Late checkout ──────────────────────────────────────────────────────────
// Same machinery, other end of the stay: the guest buys hours PAST the normal
// 11:00 checkout. lateCheckoutUntil folds into buildValidityWindow's validTo,
// and three revocation paths (MEWS bulk auto-checkout ingestion, poller expiry
// cleanup, hourly expired-pin cleanup) defer while it is active.

export interface LateCheckoutOption {
  until: string; // ISO instant
  label: string; // "12:00" in property tz
  hours: number;
  dkk: number;
  eur: number;
}

const timeOnDay = (day: DateTime, hhmm: string): DateTime => {
  const [h, m] = hhmm.split(":").map((v) => parseInt(v, 10) || 0);
  return day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
};

/**
 * Tiered late-checkout pricing (owner 4/8): `late_checkout_price_tiers` =
 * "12:00=49,13:00=79,14:00=119" — fixed checkout times at fixed CUMULATIVE
 * prices measured from the standard checkout. When set, ONLY these times are
 * offered (the legacy every-hour × price-per-hour model applies when unset).
 * Prices are cumulative so a top-up pays the difference between tiers.
 * Also parses `early_checkin_price_tiers` (owner 5/8) — same "HH:MM=price"
 * format, there meaning access-START times (earlier = pricier).
 */
export function parseLateCheckoutTiers(raw: string | undefined | null): Array<{ hhmm: string; dkk: number }> {
  if (!raw?.trim()) return [];
  const tiers: Array<{ hhmm: string; dkk: number }> = [];
  for (const part of raw.split(",")) {
    const m = /^\s*(\d{1,2}:\d{2})\s*=\s*(\d+(?:\.\d+)?)\s*$/.exec(part);
    if (!m) continue;
    tiers.push({ hhmm: m[1], dkk: parseFloat(m[2]) });
  }
  return tiers.sort((a, b) => a.hhmm.localeCompare(b.hhmm));
}

export async function quoteLateCheckout(
  tenantId: string,
  doorCode: string,
  engine: AutomationEngine
): Promise<
  | { ok: true; reservation: Reservation; roomLabel: string; firstName: string | null; currentEnd: Date; options: LateCheckoutOption[] }
  | EarlyCheckinRejected
> {
  const storage = Storage.forTenant(tenantId);
  if ((await storage.getSetting("late_checkout_enabled"))?.value !== "true") {
    return { ok: false, reason: "disabled" };
  }

  const code = doorCode.trim();
  if (!/^\d{4,8}$/.test(code)) return { ok: false, reason: "not_found" };

  const rows = await db
    .select()
    .from(reservationsTable)
    .where(
      and(
        eq(reservationsTable.tenantId, tenantId),
        eq(reservationsTable.generatedPin, code),
        inArray(reservationsTable.status, ["Confirmed", "Started", "Checked-in", "confirmed", "started", "checked-in"])
      )
    );
  const nowMs = Date.now();
  const live = rows.filter((r) => {
    const end = Math.max(
      new Date(r.departure).getTime() + 12 * 3600e3,
      r.lateCheckoutUntil ? new Date(r.lateCheckoutUntil).getTime() : 0
    );
    return end > nowMs;
  });
  if (live.length === 0) return { ok: false, reason: "not_found" };
  const reservation = live.sort((a, b) => new Date(a.departure).getTime() - new Date(b.departure).getTime())[0];

  // Deliberately NO checked-in requirement (user decision 21/7): a guest may
  // buy late checkout before arriving — lateCheckoutUntil folds into the
  // validity window, so a pending pin simply activates with the extended end.
  if (parseFloat(reservation.owing ?? "0") > 0) return { ok: false, reason: "owing" };
  if (!reservation.roomId) return { ok: false, reason: "not_ready" };
  const room = await storage.getRoom(reservation.roomId);
  if (!room?.pmsId) return { ok: false, reason: "not_ready" };

  const { validTo } = await buildValidityWindow(storage, reservation);
  // Only sellable while the current window is still open. Owner decision
  // 24/7: NO departure-day band — late check-out is buyable on any day of
  // (or before) the stay; the options always extend the DEPARTURE day, and
  // the arrival/hourly/block collision checks below run against that day, so
  // an early purchase can't oversell the capsule.
  if (nowMs >= validTo.getTime()) return { ok: false, reason: "already_active" };

  const tz = (await storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
  const checkoutHHMM = (await storage.getSetting("reservation_checkout_time"))?.value || "11:00";
  // Owner decision 22/7: late checkout is sellable until 15:00 (check-in time)
  // when the capsule has NO same-day arrival. With an arrival the tighter cap
  // below applies so housekeeping keeps a window before the next guest.
  const maxHHMM = (await storage.getSetting("late_checkout_max_time"))?.value || "15:00";
  const maxWithArrivalHHMM = (await storage.getSetting("late_checkout_max_time_with_arrival"))?.value || "12:00";
  const pricePerHour = parseFloat((await storage.getSetting("late_checkout_price_per_hour"))?.value || "75") || 75;
  const eurRate = parseFloat((await storage.getSetting("late_checkout_eur_rate"))?.value || "7.45") || 7.45;
  const tiers = parseLateCheckoutTiers((await storage.getSetting("late_checkout_price_tiers"))?.value);

  // The STANDARD checkout instant on the departure day anchors pricing — an
  // already-purchased extension must not make extra hours cheaper.
  const departureDay = DateTime.fromJSDate(new Date(reservation.departure), { zone: "utc" }).setZone(tz);
  const standardEnd = timeOnDay(departureDay, checkoutHHMM);

  // Cap: an arrival on THIS capsule on the departure DAY shrinks the offer so
  // housekeeping has a window before the next guest's 15:00 check-in. Only
  // same-day arrivals count — any other future booking on the room must not
  // cap today's late checkout. TWIN SPACES: an arrival on the twin ("401s")
  // is an arrival on the same physical bed.
  const departureDayISO = DateTime.fromJSDate(new Date(reservation.departure), { zone: "utc" }).setZone(tz).toISODate();
  const lcTwinIds = twinRoomIds(await storage.getAllRooms(), reservation.roomId);
  const sameDayArrival = (await db
    .select({ id: reservationsTable.id, arrival: reservationsTable.arrival })
    .from(reservationsTable)
    .where(
      and(
        eq(reservationsTable.tenantId, tenantId),
        inArray(reservationsTable.roomId, lcTwinIds),
        inArray(reservationsTable.status, ["Confirmed", "Started", "Checked-in", "confirmed", "started", "checked-in"])
      )
    )).some((r2) =>
      r2.id !== reservation.id &&
      DateTime.fromJSDate(new Date(r2.arrival), { zone: "utc" }).setZone(tz).toISODate() === departureDayISO
    );
  const capHHMM = sameDayArrival ? maxWithArrivalHHMM : maxHHMM;
  const cap = timeOnDay(departureDay, capHHMM);

  // Candidate end times: the configured tiers, or (legacy) every full hour
  // after the standard checkout — both capped at `cap`.
  const candidates: DateTime[] = [];
  if (tiers.length > 0) {
    for (const tier of tiers) {
      const c = timeOnDay(departureDay, tier.hhmm);
      if (c > standardEnd && c <= cap) candidates.push(c);
    }
  } else {
    let t = standardEnd.plus({ hours: 1 }).startOf("hour");
    while (t <= cap) {
      candidates.push(t);
      t = t.plus({ hours: 1 });
    }
  }

  // Conflicts that eat into the window: hourly bookings + MEWS resource blocks.
  let blockedFrom = Number.POSITIVE_INFINITY;
  try {
    const hourly = await storage.getHourlyBookingsOverlapping(
      standardEnd.toJSDate(),
      cap.toJSDate(),
      ["confirmed", "pending_payment"]
    );
    for (const hb of hourly) {
      // Grace-aware: a moved arrived guest's code is live on the grace-target
      // capsule too — late checkout must not be sold into that window.
      if (hourlyBookingBlocksRooms(hb, lcTwinIds)) {
        blockedFrom = Math.min(blockedFrom, new Date(hb.startAt).getTime());
      }
    }
  } catch { /* hourly table unavailable — no restriction */ }
  const mews = engine.getMewsClient();
  if (mews) {
    try {
      const blocks = await mews.getResourceBlocks(standardEnd.toUTC().toISO()!, cap.toUTC().toISO()!);
      for (const b of blocks) {
        if (b.AssignedResourceId === room.pmsId) {
          blockedFrom = Math.min(blockedFrom, new Date(b.StartUtc).getTime());
        }
      }
    } catch { /* blocks unavailable — no restriction */ }
  }

  // Top-up pricing: INCREMENTAL from what is already paid (the folded
  // validTo) — a guest who bought "until 12:00" and extends to 14:00 pays the
  // difference, never the same window twice. For a first purchase validTo ==
  // standardEnd, so nothing changes. Tiered: paid = the cumulative price of
  // the highest tier already covered (0 when validTo sits below every tier,
  // e.g. a legacy hourly purchase — the guest then pays the full tier price).
  const paidBaseMs = Math.max(standardEnd.toMillis(), validTo.getTime());
  const tierPriceUpTo = (ms: number): number => {
    let paid = 0;
    for (const tier of tiers) {
      if (timeOnDay(departureDay, tier.hhmm).toMillis() <= ms) paid = tier.dkk;
    }
    return paid;
  };
  const options: LateCheckoutOption[] = candidates
    .filter((c) => c.toMillis() > nowMs && c.toMillis() > validTo.getTime() && c.toMillis() <= blockedFrom)
    .map((c) => {
      const hours = Math.max(1, Math.ceil((c.toMillis() - paidBaseMs) / 3600e3));
      const dkk = tiers.length > 0
        ? Math.max(1, Math.round(tierPriceUpTo(c.toMillis()) - tierPriceUpTo(paidBaseMs)))
        : Math.round(hours * pricePerHour);
      return { until: c.toUTC().toISO()!, label: c.toFormat("HH:mm"), hours, dkk, eur: Math.round(dkk / eurRate) };
    });

  if (options.length === 0) return { ok: false, reason: "not_available" as EarlyCheckinRejection };

  return {
    ok: true,
    reservation,
    roomLabel: getSpaceDisplayName(room.name, room.label),
    firstName: reservation.firstName,
    currentEnd: validTo,
    options,
  };
}

export async function startLateCheckoutPayment(
  tenantId: string,
  doorCode: string,
  untilISO: string,
  engine: AutomationEngine,
  guestEmail?: string
): Promise<{ ok: true; id: string; paymentUrl: string; dkk: number; eur: number; label: string } | EarlyCheckinRejected> {
  const quote = await quoteLateCheckout(tenantId, doorCode, engine);
  if (!quote.ok) return quote;
  const option = quote.options.find((o) => o.until === untilISO);
  if (!option) return { ok: false, reason: "not_available" as EarlyCheckinRejection };

  const storage = Storage.forTenant(tenantId);
  const mews = engine.getMewsClient();
  if (!mews) return { ok: false, reason: "mews_unavailable" };
  const reservation = quote.reservation;

  const existing = await getLiveRow(reservation.id, "late_checkout");
  if (
    existing?.status === "pending_payment" &&
    existing.paymentRef &&
    existing.hours === option.hours &&
    Date.now() - new Date(existing.createdAt).getTime() < PAYMENT_HOLD_MINUTES * 60 * 1000
  ) {
    return { ok: true, id: existing.id, paymentUrl: mews.getPaymentRequestUrl(existing.paymentRef), dkk: option.dkk, eur: option.eur, label: option.label };
  }

  // The guest changed their option (or the hold aged out) while an old payment
  // request exists: verify it first — if they already PAID the old one, grant
  // that instead of dangling a completed payment with no access.
  if (existing?.status === "pending_payment" && existing.paymentRef) {
    try {
      const [oldPr] = await mews.getPaymentRequestsByIds([existing.paymentRef]);
      if (oldPr?.State === "Completed") {
        await completeLateCheckout(existing, engine);
        return { ok: true, id: existing.id, paymentUrl: mews.getPaymentRequestUrl(existing.paymentRef), dkk: parseFloat(existing.amount || "0"), eur: 0, label: `${existing.hours}h` };
      }
    } catch { /* verification failed — proceed with a fresh request */ }
  }

  let customerId = reservation.mewsCustomerId;
  if (!customerId) {
    const customer = await mews.addCustomer({
      firstName: reservation.firstName || undefined,
      lastName: reservation.lastName || "Guest",
      email: reservation.personalEmail || reservation.email || undefined,
      phone: reservation.mobile || undefined,
    });
    customerId = customer.Id;
    await storage.updateReservation(reservation.id, { mewsCustomerId: customerId });
  }

  const prResult = await createPaymentRequestHandlingMissingEmail(
    mews, storage, reservation, customerId, guestEmail,
    () => mews.createPaymentRequest(
      customerId!,
      option.dkk,
      "DKK",
      reservation.pmsId,
      `Late check-out Capsule ${quote.roomLabel} until ${option.label} (${option.hours}h)`,
      new Date(Date.now() + PAYMENT_HOLD_MINUTES * 60 * 1000).toISOString(),
      false
    ),
  );
  if (!prResult.ok) return prResult;
  const pr = prResult.value;

  const rowValues = {
    status: "pending_payment" as const,
    paymentRef: pr.Id,
    amount: String(option.dkk),
    currency: "DKK",
    hours: option.hours,
    updatedAt: new Date(),
  };
  let rowId: string;
  if (existing) {
    await db.update(earlyCheckins).set(rowValues).where(eq(earlyCheckins.id, existing.id));
    rowId = existing.id;
  } else {
    const inserted = await db
      .insert(earlyCheckins)
      .values({
        tenantId,
        reservationId: reservation.id,
        roomId: reservation.roomId,
        kind: "late_checkout",
        email: reservation.personalEmail || reservation.email || null,
        ...rowValues,
      })
      .returning({ id: earlyCheckins.id });
    rowId = inserted[0].id;
  }

  await storage.createLog({
    level: "info",
    message: `Late checkout payment started for ${reservation.firstName} ${reservation.lastName} (Capsule ${quote.roomLabel}): until ${option.label} = ${option.dkk} DKK (payment request ${pr.Id})`,
    source: "early-checkin",
    reservationId: reservation.id,
  });

  return { ok: true, id: rowId, paymentUrl: mews.getPaymentRequestUrl(pr.Id), dkk: option.dkk, eur: option.eur, label: option.label };
}

/**
 * Late-checkout completion: derive the paid end from hours (standard checkout
 * + N hours — deterministic, no extra column), set lateCheckoutUntil, push the
 * later end to the locks. Same digits, later end.
 */
export async function completeLateCheckout(row: EarlyCheckin, engine: AutomationEngine): Promise<boolean> {
  // reservationId is only NULL on historical rows (SET NULL, 3/8) — a row
  // being completed is live by definition.
  const reservationId = row.reservationId;
  if (!reservationId) return true;
  const cas = await db
    .update(earlyCheckins)
    .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(earlyCheckins.id, row.id), eq(earlyCheckins.status, "pending_payment")))
    .returning({ id: earlyCheckins.id });
  if (cas.length === 0) return true;

  const storage = Storage.forTenant(row.tenantId);
  const reservation = await storage.getReservation(reservationId);
  const guestName = reservation ? `${reservation.firstName} ${reservation.lastName}` : reservationId;
  if (!reservation) return true;

  const tz = (await storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
  const checkoutHHMM = (await storage.getSetting("reservation_checkout_time"))?.value || "11:00";
  const departureDay = DateTime.fromJSDate(new Date(reservation.departure), { zone: "utc" }).setZone(tz);
  const standardEndMs = timeOnDay(departureDay, checkoutHHMM).toMillis();
  // hours are INCREMENTAL (see quote pricing): the new end extends the prior
  // paid end when one exists, else the standard checkout.
  const priorMs = reservation.lateCheckoutUntil ? new Date(reservation.lateCheckoutUntil).getTime() : 0;
  const baseMs =
    priorMs > standardEndMs && priorMs - standardEndMs <= 12 * 3600e3 ? priorMs : standardEndMs;
  const until = new Date(baseMs + (row.hours ?? 1) * 3600e3);

  await storage.updateReservation(reservationId, { lateCheckoutUntil: until });

  try {
    const pushResult = await engine.updatePinValidity(reservationId, { force: true });
    if (!pushResult.success) {
      await storage.createLog({
        level: "error",
        message: `Late checkout: lock validity update reported failure for ${guestName} — reconcile/repair will converge (window is folded)`,
        source: "early-checkin",
        reservationId: reservationId,
      });
    }
    // Race guard: if MEWS's ~11:00 bulk auto-checkout revoked the pin between
    // payment start and completion (lateCheckoutUntil wasn't set yet, so the
    // revocation deferral couldn't trigger), re-create the SAME code — the
    // folded window makes it valid until the paid end.
    const pins = await storage.getPinsByReservationId(reservationId);
    if (!pins.some((p) => ["active", "used", "pending"].includes(p.status))) {
      await storage.createLog({
        level: "warn",
        message: `Late checkout: pin was already revoked by checkout — re-creating the same code for ${guestName}`,
        source: "early-checkin",
        reservationId: reservationId,
      });
      await engine.createPasscodeForReservation(reservationId, true);
    }
  } catch (error) {
    await storage.createLog({
      level: "error",
      message: `Late checkout: immediate lock update failed for ${guestName} — reconcile will converge: ${error instanceof Error ? error.message : String(error)}`,
      source: "early-checkin",
      reservationId: reservationId,
    });
  }

  const mews = engine.getMewsClient();
  if (mews && reservation.pmsId) {
    // Owner decision 24/7: move the MEWS departure to the paid end, so MEWS'
    // own auto-checkout fires at the PAID time instead of checking the guest
    // out mid-stay at 10:00. Verified in production: a same-day EndUtc
    // extension is accepted cleanly and adds no night/charge. Best-effort —
    // if it fails, the guest still has lock access until the paid end (the
    // folded window), only the MEWS status turns early.
    try {
      await mews.updateReservationEndUtc(reservation.pmsId, until);
      await storage.createLog({
        level: "info",
        message: `Late checkout: MEWS departure moved to ${DateTime.fromJSDate(until).setZone(tz).toFormat("HH:mm")} for ${guestName} — auto-checkout now fires at the paid end`,
        source: "early-checkin",
        reservationId: reservationId,
      });
    } catch (error) {
      await storage.createLog({
        level: "warn",
        message: `Late checkout: MEWS departure update failed for ${guestName} (MEWS may auto-checkout at the standard time; lock access is unaffected): ${error instanceof Error ? error.message : String(error)}`,
        source: "early-checkin",
        reservationId: reservationId,
      });
    }
    const productId = (await storage.getSetting("late_checkout_mews_product_id"))?.value;
    // Same tax-code setting as the hourly bookings — without an explicit
    // TaxCodes, Mews books the price override as VAT-exempt.
    const taxCode = (await storage.getSetting("hourly_mews_tax_code"))?.value || "DK-S";
    // Post the ACTUAL paid amount as Count 1 × amount — with tiered pricing
    // (4/8) the amount is no longer hours × a flat rate, so posting per-hour
    // units would book the wrong revenue.
    const amountDkk = parseFloat(row.amount || "0") || 0;
    const note = `Late check-out paid at kiosk: until ${DateTime.fromJSDate(until).setZone(tz).toFormat("HH:mm")} (${row.hours}h = ${row.amount} DKK, payment request ${row.paymentRef})`;
    try {
      if (productId && amountDkk > 0) {
        await mews.addReservationProduct(reservation.pmsId, productId, 1, {
          currency: "DKK",
          grossValue: amountDkk,
          taxCode,
        });
      } else {
        await mews.addReservationNote(reservation.pmsId, note);
      }
    } catch (error) {
      try { await mews.addReservationNote(reservation.pmsId, `${note} — PRODUCT POSTING FAILED, book manually`); } catch { /* best-effort */ }
      await storage.createLog({
        level: "warn",
        message: `Late checkout: MEWS product posting failed for ${guestName}: ${error instanceof Error ? error.message : String(error)}`,
        source: "early-checkin",
        reservationId: reservationId,
      });
    }
  }

  // Staff/cleaning SMS (owner decision 25/7, mirrors the hourly-booking and
  // early check-in alerts): housekeeping must know immediately that this
  // capsule frees LATE — the normal morning round is over before a 14:00
  // checkout, so this is an extra cleaning task.
  try {
    const room = reservation.roomId ? await storage.getRoom(reservation.roomId) : null;
    const label = room ? getSpaceDisplayName(room.name, room.label) : (reservation.room || "?");
    const phone = (await storage.getSetting("early_checkin_cleaning_sms_phone"))?.value;
    const untilLabel = DateTime.fromJSDate(until).setZone(tz).toFormat("HH:mm");
    if (!phone) {
      await storage.createLog({
        level: "error",
        message: `Late checkout: early_checkin_cleaning_sms_phone is not configured — staff SMS for Capsule ${label} NOT sent!`,
        source: "early-checkin",
        reservationId: reservationId,
      });
    } else {
      const notif = await createNotificationClient(storage);
      const sent = await notif.sendPlainSMS({
        to: phone,
        body: `LATE CHECKOUT: Capsule ${label} — gæsten bliver til kl. ${untilLabel}. Ekstra rengøring efter kl. ${untilLabel}.`,
      });
      await storage.createLog({
        level: sent.success ? "info" : "error",
        message: sent.success
          ? `Late checkout: staff SMS sent to ${phone} for Capsule ${label} (until ${untilLabel})`
          : `Late checkout: staff SMS FAILED to ${phone} for Capsule ${label}: ${sent.error}`,
        source: "early-checkin",
        reservationId: reservationId,
      });
    }
  } catch (error) {
    await storage.createLog({
      level: "error",
      message: `Late checkout: staff-SMS block failed entirely: ${error instanceof Error ? error.message : String(error)}`,
      source: "early-checkin",
      reservationId: reservationId,
    });
  }

  await storage.createLog({
    level: "info",
    message: `Late checkout COMPLETED for ${guestName}: access until ${until.toISOString()} (${row.hours}h, ${row.amount} DKK)`,
    source: "early-checkin",
    reservationId: reservationId,
  });
  return true;
}

/** Dispatch completion by row kind — shared by the poll endpoint and sweep. */
async function completeByKind(row: EarlyCheckin, engine: AutomationEngine): Promise<boolean> {
  return row.kind === "late_checkout" ? completeLateCheckout(row, engine) : completeEarlyCheckin(row, engine);
}

/**
 * Reservation-ids with a LIVE pending late-checkout payment (hold window).
 * Both reservation-deletion paths (poller expiry cleanup + storage bulk
 * delete) must skip these: the guest may pay at 11:03 while MEWS's bulk
 * checkout ran at 11:01 — deleting the reservation mid-payment would orphan
 * the money with no access granted.
 */
export async function getReservationIdsWithPendingLateCheckout(tenantId: string): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - (PAYMENT_EXPIRE_MINUTES + 5) * 60 * 1000);
  const rows = await db
    .select({ reservationId: earlyCheckins.reservationId, createdAt: earlyCheckins.createdAt })
    .from(earlyCheckins)
    .where(
      and(
        eq(earlyCheckins.tenantId, tenantId),
        eq(earlyCheckins.kind, "late_checkout"),
        eq(earlyCheckins.status, "pending_payment")
      )
    );
  return new Set(
    rows
      .filter((r): r is typeof r & { reservationId: string } => !!r.reservationId && new Date(r.createdAt) > cutoff)
      .map((r) => r.reservationId),
  );
}

export interface PurchaseReceipt {
  kind: string; // early_checkin | late_checkout
  capsule: string;
  code: string | null;
  amount: string | null;
  currency: string;
  hours: number | null;
  accessFrom: string; // ISO — effective validFrom (folded)
  accessUntil: string; // ISO — effective validTo (folded)
  paidAt: string | null;
}

/**
 * Build the guest-facing receipt for a COMPLETED purchase row: what was
 * bought, for which capsule, the (unchanged) door code and the effective
 * access window. Shown on the kiosk confirmation page and sent by email.
 */
async function buildReceipt(row: EarlyCheckin): Promise<PurchaseReceipt | null> {
  if (!row.reservationId) return null; // historical row — reservation deleted
  const storage = Storage.forTenant(row.tenantId);
  const reservation = await storage.getReservation(row.reservationId);
  if (!reservation) return null;
  const room = reservation.roomId ? await storage.getRoom(reservation.roomId) : null;
  const window = await buildValidityWindow(storage, reservation);
  return {
    kind: row.kind,
    capsule: room ? getSpaceDisplayName(room.name, room.label) : (reservation.assignedSpace || "?"),
    code: reservation.generatedPin,
    amount: row.amount,
    currency: row.currency || "DKK",
    hours: row.hours,
    accessFrom: window.validFrom.toISOString(),
    accessUntil: window.validTo.toISOString(),
    paidAt: (row.completedAt ? new Date(row.completedAt) : new Date()).toISOString(),
  };
}

/**
 * Email the receipt to a guest-supplied address. Only for completed rows.
 */
export async function sendPurchaseReceipt(
  tenantId: string,
  id: string,
  email: string
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_completed" | "send_failed" }> {
  const rows = await db
    .select()
    .from(earlyCheckins)
    .where(and(eq(earlyCheckins.id, id), eq(earlyCheckins.tenantId, tenantId)));
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "completed") return { ok: false, reason: "not_completed" };

  const receipt = await buildReceipt(row);
  if (!receipt) return { ok: false, reason: "not_found" };

  const storage = Storage.forTenant(tenantId);
  const hotelName = (await storage.getSetting("hotel_name"))?.value || config.defaultHotelName;
  const tz = (await storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
  const fmt = (iso: string) => DateTime.fromISO(iso).setZone(tz).toFormat("d MMM yyyy HH:mm");
  const kindLabel = receipt.kind === "late_checkout" ? "Late check-out" : "Early check-in";

  const notif = await createNotificationClient(storage);
  const sent = await notif.sendPlainTextEmail({
    to: email,
    subject: `Your ${kindLabel.toLowerCase()} receipt — ${hotelName}`,
    text:
      `${kindLabel} — receipt\n` +
      `${hotelName}\n\n` +
      `Capsule: ${receipt.capsule}\n` +
      `Door code: ${receipt.code ?? "-"}# (unchanged — same code as in your booking message)\n` +
      `Your code works from ${fmt(receipt.accessFrom)} until ${fmt(receipt.accessUntil)}\n\n` +
      `Purchased: ${kindLabel}${receipt.hours ? ` (${receipt.hours} ${receipt.hours === 1 ? "hour" : "hours"})` : ""}\n` +
      `Paid: ${receipt.amount ?? "-"} ${receipt.currency}\n` +
      `Payment time: ${receipt.paidAt ? fmt(receipt.paidAt) : "-"}\n\n` +
      `Thank you for staying with us!\n`,
  });
  await storage.createLog({
    level: sent.success ? "info" : "warn",
    message: sent.success
      ? `${kindLabel} receipt emailed to ${email} (Capsule ${receipt.capsule})`
      : `${kindLabel} receipt email FAILED to ${email}: ${sent.error}`,
    source: "early-checkin",
    reservationId: row.reservationId,
  });
  return sent.success ? { ok: true } : { ok: false, reason: "send_failed" };
}

/**
 * Kiosk polling: verify the MEWS payment request and complete on payment.
 */
export async function checkEarlyCheckinStatus(
  tenantId: string,
  id: string,
  engine: AutomationEngine
): Promise<{ status: string; granted: boolean; receipt?: PurchaseReceipt } | null> {
  const rows = await db
    .select()
    .from(earlyCheckins)
    .where(and(eq(earlyCheckins.id, id), eq(earlyCheckins.tenantId, tenantId)));
  const row = rows[0];
  if (!row) return null;
  if (row.status === "completed") {
    return { status: "completed", granted: true, receipt: (await buildReceipt(row)) ?? undefined };
  }
  if (row.status !== "pending_payment" || !row.paymentRef) return { status: row.status, granted: false };

  const mews = engine.getMewsClient();
  if (!mews) return { status: "pending_payment", granted: false };
  try {
    const [pr] = await mews.getPaymentRequestsByIds([row.paymentRef]);
    if (pr?.State === "Completed") {
      await completeByKind(row, engine);
      const fresh = await db.select().from(earlyCheckins).where(eq(earlyCheckins.id, row.id));
      return { status: "completed", granted: true, receipt: fresh[0] ? (await buildReceipt(fresh[0])) ?? undefined : undefined };
    }
    if (pr?.State === "Canceled" || pr?.State === "Expired") {
      await db
        .update(earlyCheckins)
        .set({ status: "expired", updatedAt: new Date() })
        .where(and(eq(earlyCheckins.id, row.id), eq(earlyCheckins.status, "pending_payment")));
      return { status: "expired", granted: false };
    }
  } catch {
    // verification failed — stay pending, kiosk keeps polling
  }
  return { status: "pending_payment", granted: false };
}

/**
 * Waitlist: the capsule isn't Inspected yet — store the guest's email; the
 * sweep emails them when housekeeping finishes, and they complete at the kiosk.
 */
export async function joinEarlyCheckinWaitlist(
  tenantId: string,
  doorCode: string,
  email: string,
  engine: AutomationEngine
): Promise<{ ok: true } | EarlyCheckinRejected | { ok: false; reason: "already_inspected" }> {
  const quote = await quoteEarlyCheckin(tenantId, doorCode, engine);
  if (!quote.ok) return quote;
  if (quote.inspected) return { ok: false, reason: "already_inspected" };

  const existing = await getLiveRow(quote.reservation.id);
  if (existing) {
    await db
      .update(earlyCheckins)
      .set({ email, updatedAt: new Date(), notifiedAt: null })
      .where(eq(earlyCheckins.id, existing.id));
  } else {
    await db.insert(earlyCheckins).values({
      tenantId,
      reservationId: quote.reservation.id,
      roomId: quote.reservation.roomId,
      status: "awaiting_inspection",
      email,
    });
  }

  const storage = Storage.forTenant(tenantId);
  await storage.createLog({
    level: "info",
    message: `Early check-in waitlist: ${quote.reservation.firstName} ${quote.reservation.lastName} (Capsule ${quote.roomLabel}) — will be emailed at ${email} when Inspected`,
    source: "early-checkin",
    reservationId: quote.reservation.id,
  });
  return { ok: true };
}

/**
 * 5-minute sweep per tenant:
 *  - awaiting_inspection → email the guest when the capsule turns Inspected
 *  - pending_payment → verify abandoned payments (guest paid on their phone
 *    but left the kiosk) and expire stale holds
 *  - rows whose window has passed / reservation left Confirmed → expired
 */
export async function sweepEarlyCheckins(tenantId: string, engine: AutomationEngine): Promise<void> {
  const storage = Storage.forTenant(tenantId);
  if (!(await isEnabled(storage))) return;
  const mews = engine.getMewsClient();
  if (!mews) return;

  const liveRows = await db
    .select()
    .from(earlyCheckins)
    .where(
      and(
        eq(earlyCheckins.tenantId, tenantId),
        inArray(earlyCheckins.status, ["awaiting_inspection", "pending_payment"])
      )
    );
  if (liveRows.length === 0) return;

  // Resource states in ONE call for all waiting rooms
  const waiting = liveRows.filter((r) => r.status === "awaiting_inspection");
  const stateByPmsId = new Map<string, string>();
  if (waiting.length > 0) {
    const pmsIds: string[] = [];
    for (const w of waiting) {
      if (!w.roomId) continue;
      const room = await storage.getRoom(w.roomId);
      if (room?.pmsId) pmsIds.push(room.pmsId);
    }
    if (pmsIds.length > 0) {
      try {
        const resources = await mews.getResources(Array.from(new Set(pmsIds)));
        for (const rs of resources) stateByPmsId.set(rs.Id, rs.State);
      } catch { /* states unavailable this pass */ }
    }
  }

  for (const row of liveRows) {
    try {
      const reservation = row.reservationId ? await storage.getReservation(row.reservationId) : undefined;
      const status = (reservation?.status || "").toLowerCase();

      // Row is moot when the reservation is gone/cancelled — and, for EARLY
      // check-in rows only, when the guest is already in (checked-in/started)
      // or the normal window has opened. Late-checkout rows live precisely
      // while the guest IS checked in, so those conditions don't apply.
      const isLateKind = row.kind === "late_checkout";
      let windowPassed = false;
      if (reservation && !isLateKind) {
        const { validFrom } = await buildValidityWindow(storage, reservation);
        windowPassed = Date.now() >= validFrom.getTime();
      }
      if (!reservation || status === "cancelled" || (!isLateKind && (status === "checked-in" || status === "started" || (row.status === "awaiting_inspection" && windowPassed)))) {
        await db
          .update(earlyCheckins)
          .set({ status: "expired", updatedAt: new Date() })
          .where(and(eq(earlyCheckins.id, row.id), inArray(earlyCheckins.status, ["awaiting_inspection", "pending_payment"])));
        continue;
      }

      if (row.status === "awaiting_inspection" && row.email && !row.notifiedAt) {
        const room = row.roomId ? await storage.getRoom(row.roomId) : null;
        const state = room?.pmsId ? stateByPmsId.get(room.pmsId) : undefined;
        if ((state || "").toLowerCase() === "inspected") {
          const notif = await createNotificationClient(storage);
          const label = room ? getSpaceDisplayName(room.name, room.label) : "";
          const sent = await notif.sendPlainTextEmail({
            to: row.email,
            subject: `Your capsule is ready — early check-in available`,
            text:
              `Hi ${reservation.firstName || ""}!\n\n` +
              `Capsule ${label} is now cleaned and inspected. You can complete your early check-in on the info screen in the reception — type your door code under "Early check-in" and pay to get access right away.\n\n` +
              `Your door code stays the same.\n`,
          });
          if (sent.success) {
            await db
              .update(earlyCheckins)
              .set({ notifiedAt: new Date(), updatedAt: new Date() })
              .where(eq(earlyCheckins.id, row.id));
            await storage.createLog({
              level: "info",
              message: `Early check-in: capsule ${label} Inspected — guest notified at ${row.email}`,
              source: "early-checkin",
              reservationId: row.reservationId,
            });
          }
        }
      }

      if (row.status === "pending_payment" && row.paymentRef) {
        const [pr] = await mews.getPaymentRequestsByIds([row.paymentRef]);
        if (pr?.State === "Completed") {
          await completeByKind(row, engine);
        } else if (
          pr?.State === "Canceled" ||
          pr?.State === "Expired" ||
          Date.now() - new Date(row.createdAt).getTime() > PAYMENT_EXPIRE_MINUTES * 60 * 1000
        ) {
          await db
            .update(earlyCheckins)
            .set({ status: "expired", updatedAt: new Date() })
            .where(and(eq(earlyCheckins.id, row.id), eq(earlyCheckins.status, "pending_payment")));
        }
      }
    } catch (error) {
      await storage.createLog({
        level: "warn",
        message: `Early check-in sweep error for row ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
        source: "early-checkin",
        reservationId: row.reservationId,
      });
    }
  }
}
