/**
 * Hourly arrival report data — operational status for TODAY's arrivals:
 *  ✅ who was checked in in MEWS via door-code use (pmsCheckinSource = 'lock'),
 *  ✔️ who was checked in another way (reception/MEWS UI),
 *  ⏳ who hasn't arrived yet,
 *  🚫 no-shows,
 *  ❌ MEWS check-in rejections/errors from today's log.
 *
 * The list lives on the admin app's /arrivals page (near-realtime polling,
 * plus the no-login share link below) — that page is the ONLY surface. The
 * report EMAILS are retired (owner decisions 28/7 + 3/8: first the routine
 * list mail, then the alarm mails too — the owner reads the page via the
 * link instead). `_jobLockArrivalReport` in the state machine still calls
 * `buildLockArrivalReportData` once per clock hour for the TTLock door audit,
 * the force-repairs and the persisted page snapshot; the daily checklist
 * reminder still mails the share link to `lock_arrival_report_email`, and
 * critical events go through ops-alert.
 */
import { DateTime } from "luxon";
import { config } from "./config";
import { randomBytes } from "crypto";
import type { ITenantStorage } from "./storage";
import type { Reservation, Pin, HourlyBooking } from "@shared/schema";
import { auditCommonDoorCodes, type DoorCodeGap } from "./door-code-audit";
import { MewsClient, type MewsResourceBlock } from "./mews-client";
import { getSpaceDisplayName } from "@shared/display-name";

export interface ArrivalBuckets {
  checkedInViaCode: Reservation[];
  checkedInOther: Reservation[];
  notArrived: Reservation[];
  noShow: Reservation[];
}

const CHECKED_IN_STATUSES = new Set(["checked-in", "started", "processed"]);

/**
 * The hotel "arrival day" the report covers. It rolls over at `rolloverHour`
 * (07:00) rather than midnight, so from 00:00 until 06:59 the report still
 * covers the PREVIOUS calendar day's arrivals (late-night check-ins stay
 * tracked); at 07:00 it switches to the new day. Exported for tests.
 */
export function resolveReportDate(now: DateTime, rolloverHour: number): DateTime {
  return now.hour < rolloverHour ? now.minus({ days: 1 }) : now;
}

/** Pure categorization — exported for tests. Cancelled reservations are skipped. */
export function categorizeArrivals(reservations: Reservation[]): ArrivalBuckets {
  const buckets: ArrivalBuckets = { checkedInViaCode: [], checkedInOther: [], notArrived: [], noShow: [] };
  for (const r of reservations) {
    const status = (r.status || "").toLowerCase();
    if (status === "cancelled") continue;
    if (CHECKED_IN_STATUSES.has(status)) {
      (r.pmsCheckinSource === "lock" ? buckets.checkedInViaCode : buckets.checkedInOther).push(r);
    } else if (status === "no-show") {
      buckets.noShow.push(r);
    } else {
      buckets.notArrived.push(r);
    }
  }
  return buckets;
}

// MEWS rejection / check-in failure log patterns (see checkinInMews and the
// remote-unlock path — both log the raw MEWS API error message).
const ERROR_PATTERNS = /MEWS check-in write-back failed|Auto check-in via remote unlock failed|Cannot check in|check-?in failed/i;

/**
 * Compact, human-readable rejection reason from a raw error log line. Raw text
 * looks like: 'MEWS check-in write-back failed: MEWS API error: 403 -
 * {"Message":"Cannot check in reservation because assigned space is blocked.
 * (Stay Night ...)","RequestId":...}' → just the Message, without the
 * parenthetical reservation detail. Exported for tests.
 */
export function compactMewsReason(raw: string): string {
  const jsonMsg = raw.match(/"Message"\s*:\s*"([^"]+)"/)?.[1];
  let reason = jsonMsg
    || raw.replace(/^.*?(write-back failed|unlock failed|check-?in failed):\s*/i, "")
          .replace(/^MEWS API error:\s*\d+\s*-\s*/i, "");
  // Drop the trailing "(Stay Night ...)" reservation detail. The parenthetical
  // contains NESTED parens, so cut at the first " (" when the text ends with ")".
  const parenIdx = reason.indexOf(" (");
  if (parenIdx > 0 && reason.trimEnd().endsWith(")")) reason = reason.slice(0, parenIdx);
  reason = reason.trim();
  return reason.length > 90 ? reason.slice(0, 87) + "…" : reason;
}

// Optional engine hook: when provided, detection triggers ACTION — every gap
// the audit finds is force-repaired on the spot and the doors re-audited, so
// the report shows what is STILL broken after auto-repair (not what was
// transiently missing). This closed the 21/7 gap where the report knew about
// missing codes for 7 hours while nothing acted on them.
export interface ArrivalReportRepairEngine {
  repairPasscodeForReservation(reservationId: string, force?: boolean): Promise<{ success: boolean; error?: string }>;
}

/**
 * Owner-controlled visibility: locks listed in the `report_ignored_locks`
 * setting (comma-separated names, case-insensitive) are muted in the report —
 * gaps, offline lines AND urgent escalation. The repair machinery is
 * untouched: codes are still pushed to a muted lock the moment its gateway
 * answers; only the reporting is silenced. Exported for tests.
 */
export function applyReportLockMuting<TGap extends { lockName: string }>(
  input: { gaps: TGap[]; offlineDoors: string[]; offlineDoorsDetailed: Array<{ lockName: string; ttlockId: string }> },
  ignoredNamesRaw: string | null | undefined,
): { gaps: TGap[]; offlineDoors: string[]; offlineDoorsDetailed: Array<{ lockName: string; ttlockId: string }> } {
  const ignored = new Set(
    (ignoredNamesRaw || "")
      .split(/[,;]+/)
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  );
  if (ignored.size === 0) return input;
  const keep = (name: string) => !ignored.has(name.trim().toLowerCase());
  return {
    gaps: input.gaps.filter(g => keep(g.lockName)),
    offlineDoors: input.offlineDoors.filter(keep),
    offlineDoorsDetailed: input.offlineDoorsDetailed.filter(d => keep(d.lockName)),
  };
}

// ── Structured report data (consumed by both the email render and /api/arrivals) ──

export interface ArrivalUpsellLine { kind: string; guestName: string; time: string; amount: string }

export interface ArrivalRowData {
  reservationId: string;
  guestName: string;
  room: string;
  hk: { label: string; color: string };
  code: string | null;
  msgSent: boolean;
  status: { priority: number; text: string; color: string };
  reason: string;
  mewsUrl: string | null;
  /** Paid early check-in: "HH:mm" (or "d/M HH:mm" when not the report day) — null if none */
  earlyCheckinFrom: string | null;
  /** Paid late check-out: "HH:mm" (or "d/M HH:mm" when not the report day) — null if none */
  lateCheckoutUntil: string | null;
}

export interface ArrivalReportData {
  hotelName: string;
  tz: string;
  /** yyyy-MM-dd of the hotel "arrival day" covered */
  reportDate: string;
  reportDateLabel: string;
  generatedAt: string;
  generatedAtLabel: string;
  rows: ArrivalRowData[];
  counts: {
    total: number;
    viaCode: number;
    manual: number;
    notArrived: number;
    noShow: number;
    mewsRejected: number;
    awaitingPayment: number;
    /** Hourly (time) bookings on the report day — shown as ⏱-rows in the list. */
    hourly: number;
    /** Extra cleaning tasks (time bookings + late checkouts ending today): capsules freed DIRTY outside the morning round. */
    cleaning: number;
  };
  urgentReasons: string[];
  doorGaps: DoorCodeGap[];
  offlineDoors: string[];
  autoRepairedCount: number;
  /** false when the TTLock door audit was skipped (cheap page-poll builds) */
  auditRan: boolean;
  /** when the gaps/offline data was computed (page shows snapshot age) */
  auditAt: string | null;
  upsells: { lines: ArrivalUpsellLine[]; totals: string };
  blocks: Array<{ roomLabel: string; typeLabel: string; start: string; end: string; name: string | null }>;
  repairIntervalMinutes: number;
}

/** Persisted by audit-running builds so cheap page-poll builds can show the latest audit. */
export const ARRIVAL_AUDIT_SNAPSHOT_SETTING = "arrival_report_last_audit";

export interface ArrivalAuditSnapshot {
  gaps: DoorCodeGap[];
  offlineDoors: string[];
  urgentOfflineReasons: string[];
  autoRepairedCount: number;
  at: string;
}

export interface BuildArrivalDataOpts {
  engine?: ArrivalReportRepairEngine;
  /** default true. false = skip the TTLock door audit (page polling must never hammer TTLock or trigger repairs) */
  runAudit?: boolean;
  /** yyyy-MM-dd override of the report day (the 01:00 checklist links to the NEW calendar day, which the 07:00 rollover hasn't reached yet) */
  date?: string;
}

export async function buildLockArrivalReportData(storage: ITenantStorage, opts: BuildArrivalDataOpts = {}): Promise<ArrivalReportData> {
  const { engine, runAudit = true } = opts;
  const tz = (await storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
  const hotelName = (await storage.getSetting("hotel_name"))?.value || "Hotel";
  const now = DateTime.now().setZone(tz);

  // Hotel "arrival day" rolls over at 07:00 (configurable), NOT midnight: from
  // 00:00–06:59 we keep reporting the PREVIOUS calendar day's arrivals so late
  // night check-ins are still tracked; at 07:00 we switch to the new day.
  const rolloverHour = parseInt((await storage.getSetting("arrival_report_rollover_hour"))?.value || "7", 10) || 7;
  const dateOverride = opts.date ? DateTime.fromFormat(opts.date, "yyyy-MM-dd", { zone: tz }) : null;
  const reportDate = dateOverride?.isValid ? dateOverride : resolveReportDate(now, rolloverHour);
  const dayStart = reportDate.startOf("day");
  const dayEnd = reportDate.endOf("day");

  const reservations = await storage.getMappedReservationsByArrivalRange(dayStart.toJSDate(), dayEnd.toJSDate());
  const buckets = categorizeArrivals(reservations);

  // Perf 23/7: these are independent — fetch them concurrently, and only the
  // pins belonging to the day's reservations (getAllPins moved 2400+ rows of
  // keyId jsonb per page poll). Cold builds went from ~27s toward ~2-3s
  // together with the pool/index fixes.
  const [rooms, dayPins, recentLogs, hourlyBookingsToday, lateCheckoutsToday] = await Promise.all([
    storage.getAllRooms(),
    storage.getPinsByReservationIds(reservations.map(r => r.id)),
    storage.getAllLogs(500),
    // Hourly bookings live in their own table (never imported as
    // reservations) — the day list must fetch them explicitly. Optional call:
    // the report must never break on storages without the hourly table.
    Promise.resolve()
      .then(() => storage.getHourlyBookingsOverlapping?.(dayStart.toJSDate(), dayEnd.toJSDate(), ["confirmed", "expired"]) ?? [])
      // Only REAL time bookings (paid or code issued): the sweep used to
      // release abandoned unpaid holds as "expired" too, which put phantom
      // "(finished)" rows with cleaning tasks on the list (24/7). The sweep
      // now cancels them instead — this filter guards any legacy rows.
      .then(hbs => hbs.filter(hb => hb.pinCode || hb.paidAt))
      .catch(() => [] as HourlyBooking[]),
    // Paid late checkouts ENDING today: departing guests, so they are not in
    // the arrivals fetch — the cleaner needs them as extra cleaning tasks
    // (owner request 24/7). Optional call, must never break the report.
    Promise.resolve()
      .then(() => storage.getReservationsWithLateCheckoutBetween?.(dayStart.toJSDate(), dayEnd.toJSDate()) ?? [])
      .catch(() => [] as Reservation[]),
  ]);

  // Paid upsells (early check-in / late check-out) completed on the report day —
  // owner asked for a standing revenue line so this never has to be looked up
  // manually in MEWS/logs. Failures must never break the report.
  const upsellLines: ArrivalUpsellLine[] = [];
  let upsellTotals = "";
  // Purchases per reservation for the row badges. FALLBACK source: the
  // completed purchase rows persist forever, while reservation.earlyCheckinFrom
  // can legitimately be cleared later (e.g. the MEWS check-in adjusting
  // StartUtc used to wipe it) — the list must still show what was bought.
  const purchaseByReservation = new Map<string, { earlyAt?: Date; lateHours?: number }>();
  try {
    const upsells = await storage.getCompletedUpsellsSince(dayStart.toJSDate());
    const reservationById = new Map(reservations.map(r => [r.id, r]));
    const totals = new Map<string, number>(); // currency → sum
    for (const u of upsells) {
      // reservationId is NULL on historical rows whose reservation was later
      // deleted (SET NULL, 3/8) — today's purchases always have one, but the
      // revenue line must still count a row without it.
      if (u.reservationId) {
        const entry = purchaseByReservation.get(u.reservationId) ?? {};
        if (u.kind === "late_checkout") entry.lateHours = (entry.lateHours ?? 0) + (u.hours ?? 1);
        else if (u.completedAt) entry.earlyAt = new Date(u.completedAt);
        purchaseByReservation.set(u.reservationId, entry);
      }
      let guest = u.reservationId ? reservationById.get(u.reservationId) : undefined;
      if (!guest && u.reservationId) {
        try { guest = (await storage.getReservation(u.reservationId)) || undefined; } catch { /* name lookup only */ }
      }
      const amountNum = parseFloat(u.amount ?? "") || 0;
      const currency = u.currency || "DKK";
      if (amountNum > 0) totals.set(currency, (totals.get(currency) || 0) + amountNum);
      upsellLines.push({
        kind: u.kind === "late_checkout" ? "Late check-out" : "Early check-in",
        guestName: guest ? `${guest.firstName} ${guest.lastName}`.trim() : "(unknown guest)",
        time: u.completedAt ? DateTime.fromJSDate(new Date(u.completedAt)).setZone(tz).toFormat("HH:mm") : "-",
        amount: amountNum > 0 ? `${amountNum.toFixed(2)} ${currency}` : "—",
      });
    }
    upsellTotals = Array.from(totals.entries()).map(([cur, sum]) => `${sum.toFixed(2)} ${cur}`).join(" + ");
  } catch { /* upsell lookup must never break the report */ }
  const todayIds = new Set(reservations.map(r => r.id));

  // Room display names + first-used times (arrival time for code check-ins)
  const roomName = new Map(rooms.map(rm => [rm.id, getSpaceDisplayName(rm.name, rm.label)]));
  const pinByReservation = new Map<string, Pin>();
  for (const p of dayPins) {
    if (p.reservationId && !pinByReservation.has(p.reservationId)) pinByReservation.set(p.reservationId, p);
    // Prefer a pin with firstUsedAt
    if (p.reservationId && p.firstUsedAt) pinByReservation.set(p.reservationId, p);
  }

  // Today's MEWS rejections from the log (tied to today's arrivals when possible)
  const errors = recentLogs.filter(l =>
    new Date(l.timestamp).getTime() >= dayStart.toJSDate().getTime() &&
    (l.level === "error" || l.level === "warn") &&
    ERROR_PATTERNS.test(l.message) &&
    (!l.reservationId || todayIds.has(l.reservationId)),
  );
  // Reservations whose MEWS check-in was REJECTED today (so a still-Confirmed
  // guest shows "MEWS afvist" in the status column instead of "Nej").
  const rejectedIds = new Set(errors.map(e => e.reservationId).filter((id): id is string => !!id));

  const reasonById = new Map<string, string>();
  for (const e of [...errors].reverse()) { // oldest→newest so the newest wins
    if (e.reservationId) reasonById.set(e.reservationId, compactMewsReason(e.message));
  }

  const unpaidAmount = (r: Reservation): number => parseFloat(r.owing ?? "0") || 0;
  const msgSent = (r: Reservation) => !!(r.doorCodeSentAt || r.notificationSent);
  // Reason for unpaid not-arrived rows: amount owed + what is actually blocked.
  // If the door-code message already went out (e.g. the debt arose after the
  // send), only the PIN is blocked — saying "kode tilbageholdt" would
  // contradict the "Besked sendt: Ja" column.
  // The logged MEWS rejection reason only applies while the guest is still
  // rejected — once checked in, a stale rejection (e.g. a duplicate check-in
  // attempt) must not linger in the Årsag column.
  // Row texts are ENGLISH: they surface only on the /arrivals page (owner
  // decision 23/7 — the list is English; the summary EMAILS stay Danish and
  // render their own texts).
  const reasonFor = (r: Reservation, statusText: string): string => {
    if (statusText.includes("Awaiting payment")) {
      const base = `Owes ${unpaidAmount(r).toFixed(2)} kr`;
      return msgSent(r)
        ? `${base} — message sent, but PIN blocked until payment`
        : `${base} — code withheld until payment`;
    }
    if (statusText.includes("MEWS rejected")) return reasonById.get(r.id) || "";
    return "";
  };

  const fmtTime = (d: Date | string | null | undefined) =>
    d ? DateTime.fromJSDate(new Date(d)).setZone(tz).toFormat("HH:mm") : "-";
  const roomOf = (r: Reservation) => r.roomId ? (roomName.get(r.roomId) || r.room || "?") : (r.room || "?");

  // Single per-reservation status for the "Checket ind" column. priority also
  // orders the one flat table: problems + arrivals on top, not-arrived last.
  const statusOf = (r: Reservation): { priority: number; text: string; color: string } => {
    const s = (r.status || "").toLowerCase();
    if (CHECKED_IN_STATUSES.has(s)) {
      if (r.pmsCheckinSource === "lock") {
        const pin = pinByReservation.get(r.id);
        return { priority: 1, text: `✅ Via code at ${fmtTime(pin?.firstUsedAt || r.updatedAt)}`, color: "#059669" };
      }
      // Arrival time (owner request 24/7): first code use when known, else
      // the check-in sync moment (approximate but useful for ops).
      const pin = pinByReservation.get(r.id);
      return { priority: 2, text: `✅ Reception/app at ${fmtTime(pin?.firstUsedAt || r.updatedAt)}`, color: "#059669" };
    }
    if (s === "no-show") return { priority: 3, text: "🚫 No-show", color: "#dc2626" };
    if (rejectedIds.has(r.id)) return { priority: 0, text: "❌ MEWS rejected", color: "#dc2626" };
    // Unpaid & not arrived: the PIN cannot activate (owing>0 gate) and the
    // door-code message is withheld — reception must collect payment BEFORE
    // the guest stands at the door with nothing.
    if (unpaidAmount(r) > 0) return { priority: 0, text: "💰 Awaiting payment", color: "#d97706" };
    return { priority: 4, text: "⏳ Not arrived", color: "#6b7280" };
  };

  // All of today's arrivals in ONE list, sorted by status priority then room.
  const allRows = reservations
    .filter(r => (r.status || "").toLowerCase() !== "cancelled")
    .map(r => ({ r, status: statusOf(r) }))
    .sort((a, b) =>
      a.status.priority - b.status.priority ||
      roomOf(a.r).localeCompare(roomOf(b.r), undefined, { numeric: true }));

  const mewsRejected = allRows.filter(x => x.status.text.includes("MEWS rejected")).length;
  const awaitingPayment = allRows.filter(x => x.status.text.includes("Awaiting payment")).length;

  // Live audit of common-area doors: does every currently-valid guest code
  // actually sit on the main entrance (etc.) with a usable window? Grouped per
  // lock so an offline door (e.g. parking) is one line, not twenty.
  // Skipped entirely for cheap builds (page polling) — the /arrivals endpoint
  // overlays the persisted snapshot from the last audit-running build instead.
  let doorGaps: DoorCodeGap[] = [];
  let offlineDoors: string[] = [];
  let offlineDoorsDetailed: Array<{ lockName: string; ttlockId: string }> = [];
  let autoRepairedCount = 0;
  let auditAt: string | null = null;
  if (runAudit) {
    try {
      let audit = await auditCommonDoorCodes(storage);

      // Detection → action: force-repair every gapped reservation, then re-audit
      // so the report reflects post-repair reality. Offline doors are excluded
      // by the audit already (repair cannot reach a dead gateway).
      if (engine && audit.gaps.length > 0) {
        const gapCountBefore = audit.gaps.length;
        const reservationIds = Array.from(new Set(audit.gaps.map(g => g.reservationId).filter((id): id is string => !!id)));
        for (const reservationId of reservationIds) {
          try {
            await engine.repairPasscodeForReservation(reservationId, true);
          } catch (error) {
            await storage.createLog({
              level: "error",
              message: `Arrival-report auto-repair failed for reservation ${reservationId}: ${error instanceof Error ? error.message : String(error)}`,
              source: "arrival-report",
              reservationId,
            });
          }
        }
        if (reservationIds.length > 0) {
          audit = await auditCommonDoorCodes(storage);
          autoRepairedCount = Math.max(0, gapCountBefore - audit.gaps.length);
          await storage.createLog({
            level: audit.gaps.length === 0 ? "info" : "warn",
            message: `Arrival-report auto-repair: ${gapCountBefore} gap(s) found, ${autoRepairedCount} healed, ${audit.gaps.length} remain after force repair`,
            source: "arrival-report",
          });
        }
      }

      // Owner-muted locks (e.g. a parking door with a permanently dead gateway)
      // are removed from ALL report surfaces — repair keeps running for them.
      const muted = applyReportLockMuting(
        { gaps: audit.gaps, offlineDoors: audit.offlineLocks, offlineDoorsDetailed: audit.offlineDoorsDetailed },
        (await storage.getSetting("report_ignored_locks"))?.value,
      );
      doorGaps = muted.gaps;
      offlineDoors = muted.offlineDoors;
      offlineDoorsDetailed = muted.offlineDoorsDetailed;
      auditAt = new Date().toISOString();
    } catch {
      // audit must never break the report
    }
  }

  // Gateway-down escalation (21/7 lesson: the 15:25 report showed 20 missing
  // codes in staffed daytime and nobody reacted): a common door whose gateway
  // has been continuously offline for > 30 min becomes an URGENT headline, not
  // a footnote. Duration comes from the offline-episode settings maintained by
  // the push/repair jobs; the "last seen" recency requirement makes stale
  // state self-invalidating after recovery.
  const urgentReasons: string[] = [];
  const OFFLINE_URGENT_MS = 30 * 60 * 1000;
  const OFFLINE_FRESH_MS = 15 * 60 * 1000;
  for (const door of offlineDoorsDetailed) {
    if (!door.ttlockId) continue;
    try {
      const firstRaw = (await storage.getSetting(`lock_offline_first:${door.ttlockId}`))?.value;
      const lastRaw = (await storage.getSetting(`lock_offline_last:${door.ttlockId}`))?.value;
      const first = firstRaw ? Date.parse(firstRaw) : NaN;
      const last = lastRaw ? Date.parse(lastRaw) : NaN;
      const nowMs = Date.now();
      if (
        Number.isFinite(first) && Number.isFinite(last) &&
        nowMs - last < OFFLINE_FRESH_MS &&
        nowMs - first > OFFLINE_URGENT_MS
      ) {
        const minutes = Math.round((nowMs - first) / 60000);
        urgentReasons.push(`Fællesdør "${door.lockName}" har været OFFLINE i ${minutes} min — koder kan ikke pushes. Tjek gateway/strøm NU.`);
      }
    } catch { /* escalation must never break the report */ }
  }

  // Invariant watchdog: after the orphan-cleanup redesign there must NEVER be
  // pins stuck in the legacy "deleted" status while their guest is live. Any
  // hit here means a regression (or pre-fix leftovers) → surface in red.
  // DB-only check — cheap, so it runs in both audit and no-audit builds.
  // Must mirror recoverWronglyDeletedPins' skip rule: a deleted pin whose
  // reservation ALSO has a live (active/used) pin is normal bookkeeping (e.g.
  // a re-generated pin row), not a breach — recovery would skip it, so
  // alarming on it produced a permanent un-actionable URGENT (Klinger Lea 23/7).
  let deletedInvariantBreaches = 0;
  try {
    const deletedPins = await storage.getDeletedPinsWithinValidity();
    for (const pin of deletedPins) {
      if (!pin.reservationId) continue;
      // Deleted pins within validity are rare (usually 0-2), so per-pin
      // sibling lookups stay cheap — and they must cover ALL of the
      // reservation's pins, not just today's arrivals (the live sibling can
      // belong to a guest who arrived days ago).
      const siblings = await storage.getPinsByReservationId(pin.reservationId);
      if (siblings.some(p => p.id !== pin.id && (p.status === "active" || p.status === "used"))) continue;
      const res = await storage.getReservation(pin.reservationId);
      const status = (res?.status || "").toLowerCase();
      if (res && status !== "cancelled" && status !== "checked-out") deletedInvariantBreaches++;
    }
    if (deletedInvariantBreaches > 0) {
      urgentReasons.push(`INVARIANT-BRUD: ${deletedInvariantBreaches} kode(r) står som "deleted" med aktiv gæst — kør POST /api/automation/recover-deleted-pins`);
    }
  } catch { /* watchdog must never break the report */ }

  // Dynamic retry text — was hardcoded "hver time" long after repair moved to
  // a 5-minute cadence.
  const repairIntervalMinutes = Math.max(1, parseInt((await storage.getSetting("pin_repair_interval_minutes"))?.value || "", 10) || 5);

  // MEWS extras (resource blocks + housekeeping states) — failures must never
  // break the report.
  let mews: MewsClient | null = null;
  try {
    const clientToken = (await storage.getSetting("mews_client_token"))?.value;
    const accessToken = (await storage.getSetting("mews_access_token"))?.value;
    if (clientToken && accessToken) {
      const envValue = (await storage.getSetting("mews_environment"))?.value || "demo";
      mews = new MewsClient(clientToken, accessToken, envValue === "production" ? "production" : "demo");
    }
  } catch {
    // no MEWS client — sections below are skipped
  }

  // Resource blocks (out-of-order / internal use) touching the report day —
  // shown so the hotel can see WHY a capsule is unavailable. Endpoint enabled by
  // Mews 2026-07-17.
  const blockTypeLabel = (t: string) => t === "OutOfOrder" ? "Out of order" : t === "InternalUse" ? "Internal use" : t;
  const fmtBlockDate = (iso: string) => DateTime.fromISO(iso).setZone(tz).toFormat("d/M HH:mm");
  // Both MEWS reads are independent — run them concurrently (perf 23/7; each
  // is an external HTTP call). Failures degrade the section, never the report.
  const hkPmsIds = Array.from(new Set(
    [
      ...reservations.map(r => (r.roomId ? rooms.find(rm => rm.id === r.roomId)?.pmsId : null)),
      // Hourly bookings' capsules need the housekeeping badge too.
      ...hourlyBookingsToday.map(hb => rooms.find(rm => rm.id === hb.roomId)?.pmsId),
      // Late-checkout capsules likewise (their row is an extra cleaning task).
      ...lateCheckoutsToday.map(r => (r.roomId ? rooms.find(rm => rm.id === r.roomId)?.pmsId : null)),
    ].filter((id): id is string => !!id)
  ));
  const [blocksRaw, hkResources] = mews
    ? await Promise.all([
        mews.getResourceBlocks(dayStart.toUTC().toISO()!, dayEnd.toUTC().toISO()!).catch(() => null),
        hkPmsIds.length > 0 ? mews.getResources(hkPmsIds).catch(() => null) : Promise.resolve([]),
      ])
    : [null, null];

  let blocks: Array<{ roomLabel: string; typeLabel: string; start: string; end: string; name: string | null }> = [];
  if (blocksRaw) {
    const roomByPmsId = new Map(rooms.filter(rm => rm.pmsId).map(rm => [rm.pmsId!, getSpaceDisplayName(rm.name, rm.label)]));
    blocks = blocksRaw
      .map(block => ({
        roomLabel: roomByPmsId.get(block.AssignedResourceId) || block.AssignedResourceId,
        typeLabel: blockTypeLabel(block.Type),
        start: fmtBlockDate(block.StartUtc),
        end: fmtBlockDate(block.EndUtc),
        name: (block as MewsResourceBlock).Name || null,
      }))
      .sort((a, b) => a.roomLabel.localeCompare(b.roomLabel, undefined, { numeric: true }));
  }

  // Housekeeping state (Dirty/Clean/Inspected/OutOfService) for each arriving
  // guest's capsule — reception sees at a glance whether the capsule is ready.
  const hkStateByRoomId = new Map<string, string>();
  if (hkResources) {
    const stateByPms = new Map(hkResources.map(rs => [rs.Id, rs.State]));
    for (const rm of rooms) {
      if (rm.pmsId && stateByPms.has(rm.pmsId)) hkStateByRoomId.set(rm.id, stateByPms.get(rm.pmsId)!);
    }
  }
  const hkInfo = (r: Reservation): { label: string; color: string } => {
    const state = r.roomId ? hkStateByRoomId.get(r.roomId) : undefined;
    switch (state) {
      case "Inspected": return { label: "Inspected", color: "#059669" };
      case "Clean": return { label: "Clean", color: "#2563eb" };
      case "Dirty": return { label: "Dirty", color: "#dc2626" };
      case "OutOfService": return { label: "Out of service", color: "#6b7280" };
      case "OutOfOrder": return { label: "Out of order", color: "#6b7280" };
      default: return { label: "—", color: "#9ca3af" };
    }
  };

  // Deep-link to the reservation in MEWS Commander. The path segment is our
  // stored pmsId (verified = the Commander reservation-detail GUID); the
  // enterprise id is a per-tenant setting. groupId is an optional context param
  // and is omitted (the link resolves without it).
  const enterpriseId = (await storage.getSetting("mews_commander_enterprise_id"))?.value;
  const mewsUrl = (r: Reservation): string | null =>
    enterpriseId && r.pmsId
      ? `https://app.mews.com/Commander/${enterpriseId}/Reservation/Detail/${r.pmsId}/Status`
      : null;

  // Paid upsell times per guest ("Tilkøb" column): HH:mm on the report day,
  // date-prefixed otherwise (late check-out belongs to the DEPARTURE day, so
  // for an arriving guest it is almost always a different date).
  const fmtUpsellTime = (d: Date | string | null | undefined): string | null => {
    if (!d) return null;
    const dt = DateTime.fromJSDate(new Date(d)).setZone(tz);
    return dt.hasSame(reportDate, "day") ? dt.toFormat("HH:mm") : dt.toFormat("d/M HH:mm");
  };
  // Late-checkout fallback end: departure-day standard checkout + purchased
  // hours (when the reservation field was cleared but the purchase row exists).
  const checkoutHHMM2 = (await storage.getSetting("reservation_checkout_time"))?.value || "10:00";
  const lateFallbackUntil = (r: Reservation, hours: number): Date => {
    const [h, m] = checkoutHHMM2.split(":").map(v => parseInt(v, 10) || 0);
    return DateTime.fromJSDate(new Date(r.departure), { zone: "utc" }).setZone(tz)
      .set({ hour: h, minute: m, second: 0, millisecond: 0 }).plus({ hours }).toJSDate();
  };

  const reservationRows: ArrivalRowData[] = allRows.map(({ r, status }) => {
    const purchase = purchaseByReservation.get(r.id);
    return {
      reservationId: r.id,
      guestName: `${r.firstName} ${r.lastName}`.trim(),
      room: roomOf(r),
      hk: hkInfo(r),
      code: r.generatedPin || null,
      msgSent: msgSent(r),
      status,
      reason: reasonFor(r, status.text),
      mewsUrl: mewsUrl(r),
      earlyCheckinFrom: fmtUpsellTime(r.earlyCheckinFrom ?? purchase?.earlyAt),
      lateCheckoutUntil: fmtUpsellTime(
        r.lateCheckoutUntil ?? (purchase?.lateHours ? lateFallbackUntil(r, purchase.lateHours) : null),
      ),
    };
  });

  // Hourly bookings on the report day (owner request 24/7): they live in
  // their own table (never imported as reservations — the ingestion guard is
  // by design), so the list must fetch them explicitly and show the exact
  // window ("Time booking 12:00–18:00"). Confirmed = live/paid; expired =
  // finished today. Failures never break the report.
  let hourlyRowsOut: ArrivalRowData[] = [];
  try {
    const roomById2 = new Map(rooms.map(rm => [rm.id, rm]));
    hourlyRowsOut = hourlyBookingsToday.map(hb => {
      const room = roomById2.get(hb.roomId);
      const roomLabel = room ? getSpaceDisplayName(room.name, room.label) : "?";
      const windowLabel = `${DateTime.fromJSDate(new Date(hb.startAt)).setZone(tz).toFormat("HH:mm")}–${DateTime.fromJSDate(new Date(hb.endAt)).setZone(tz).toFormat("HH:mm")}`;
      const finished = hb.status === "expired" || new Date(hb.endAt).getTime() < Date.now();
      const endLabel = DateTime.fromJSDate(new Date(hb.endAt)).setZone(tz).toFormat("HH:mm");
      // The bare "(finished)" read as "never checked out" (28/7 owner
      // confusion) — say explicitly what happened in MEWS: checked out at
      // HH:mm, or an amber warning while the ≤8 min checkout signal is still
      // due (only relevant when the booking has a MEWS reservation at all).
      const finishedLabel = !finished
        ? ""
        : hb.mewsCheckedOutAt
          ? ` · ✅ checked out ${DateTime.fromJSDate(new Date(hb.mewsCheckedOutAt)).setZone(tz).toFormat("HH:mm")}`
          : hb.mewsReservationId
            ? " · ⏳ checkout pending"
            : " (finished)";
      return {
        reservationId: `hourly:${hb.id}`,
        guestName: hb.guestName,
        room: roomLabel,
        hk: hkInfo({ roomId: hb.roomId } as Reservation),
        code: hb.pinCode || null,
        msgSent: !!hb.codeDeliveredAt,
        status: {
          priority: 2,
          text: `⏱ Time booking ${windowLabel}${finishedLabel}`,
          color: finished
            ? (hb.mewsCheckedOutAt || !hb.mewsReservationId ? "#6b7280" : "#d97706")
            : "#7c3aed",
        },
        // Every time booking frees the capsule DIRTY at its end — that is an
        // extra cleaning round outside the normal morning sweep, and the list
        // is the cleaner's only surface (unmanned hotel).
        reason: `🧹 Extra cleaning after ${endLabel}`,
        mewsUrl: enterpriseId && hb.mewsReservationId
          ? `https://app.mews.com/Commander/${enterpriseId}/Reservation/Detail/${hb.mewsReservationId}/Status`
          : null,
        earlyCheckinFrom: null,
        lateCheckoutUntil: null,
      };
    });
  } catch { /* hourly lookup must never break the report */ }

  // Departing guests with a paid late checkout ending today: they are NOT
  // arrivals, but the capsule frees DIRTY at e.g. 14:00 — long after the
  // normal morning cleaning round. Shown as explicit extra-cleaning rows
  // (owner request 24/7). Guests also arriving today are skipped (their
  // arrival row already carries the late-checkout badge).
  let lateCheckoutRowsOut: ArrivalRowData[] = [];
  try {
    lateCheckoutRowsOut = lateCheckoutsToday
      .filter(r => !todayIds.has(r.id) && (r.status || "").toLowerCase() !== "cancelled")
      .map(r => {
        const until = DateTime.fromJSDate(new Date(r.lateCheckoutUntil!)).setZone(tz).toFormat("HH:mm");
        const done = new Date(r.lateCheckoutUntil!).getTime() < Date.now();
        return {
          reservationId: `late-checkout:${r.id}`,
          guestName: `${r.firstName} ${r.lastName}`.trim(),
          room: roomOf(r),
          hk: hkInfo(r),
          code: r.generatedPin || null,
          msgSent: msgSent(r),
          status: {
            priority: 2,
            text: `🛏 Late check-out until ${until}${done ? " (done)" : ""}`,
            color: done ? "#6b7280" : "#ea580c",
          },
          reason: `🧹 Extra cleaning after ${until}`,
          mewsUrl: mewsUrl(r),
          earlyCheckinFrom: null,
          lateCheckoutUntil: until,
        };
      });
  } catch { /* late-checkout lookup must never break the report */ }

  const rows: ArrivalRowData[] = [...reservationRows, ...hourlyRowsOut, ...lateCheckoutRowsOut].sort((a, b) =>
    a.status.priority - b.status.priority ||
    a.room.localeCompare(b.room, undefined, { numeric: true }),
  );

  const data: ArrivalReportData = {
    hotelName,
    tz,
    reportDate: reportDate.toFormat("yyyy-MM-dd"),
    reportDateLabel: reportDate.setLocale("da").toFormat("cccc d. LLLL yyyy"),
    generatedAt: new Date().toISOString(),
    generatedAtLabel: now.toFormat("HH:mm"),
    rows,
    counts: {
      total: rows.length,
      viaCode: buckets.checkedInViaCode.length,
      manual: buckets.checkedInOther.length,
      notArrived: buckets.notArrived.length,
      noShow: buckets.noShow.length,
      mewsRejected,
      awaitingPayment,
      hourly: hourlyRowsOut.length,
      // One cleaning task per time booking + per late checkout: capsules that
      // free DIRTY outside the normal morning round.
      cleaning: hourlyRowsOut.length + lateCheckoutRowsOut.length,
    },
    urgentReasons,
    doorGaps,
    offlineDoors,
    autoRepairedCount,
    auditRan: runAudit,
    auditAt,
    upsells: { lines: upsellLines, totals: upsellTotals },
    blocks,
    repairIntervalMinutes,
  };

  // Persist the audit result so cheap no-audit builds (the /arrivals page)
  // can show the latest verified gaps/offline state with its timestamp.
  if (runAudit && auditAt) {
    try {
      const snapshot: ArrivalAuditSnapshot = {
        gaps: doorGaps,
        offlineDoors,
        urgentOfflineReasons: urgentReasons.filter(r => r.includes("OFFLINE")),
        autoRepairedCount,
        at: auditAt,
      };
      await storage.setSetting(ARRIVAL_AUDIT_SNAPSHOT_SETTING, JSON.stringify(snapshot));
    } catch { /* snapshot persistence must never break the report */ }
  }

  return data;
}

// The email render + send layer that used to live here (summary mail, alarm
// signature, URGENT escalation) was removed 3/8 when the report mails were
// retired — see the module doc. Git history has the old renderer if a mail
// surface ever comes back.

/**
 * Long random capability token for the no-login share link (owner request 23/7:
 * the link must open on a phone without logging in, and must be
 * unguessable). Generated once per tenant on first use; revocable by clearing
 * the `arrivals_share_token` setting — the next link then carries a fresh one.
 */
export async function getOrCreateArrivalsShareToken(storage: ITenantStorage): Promise<string> {
  const existing = (await storage.getSetting("arrivals_share_token"))?.value;
  if (existing && existing.length >= 32) return existing;
  const token = randomBytes(32).toString("hex");
  await storage.setSetting("arrivals_share_token", token);
  return token;
}

/**
 * The share URL the daily checklist reminder links to: token-bearing, no
 * login, rendered without the admin menu (the /arrivals/t/:token route).
 * Base overridable per tenant via `admin_base_url`.
 */
export async function resolveArrivalsUrl(storage: ITenantStorage, date?: string): Promise<string> {
  const base = ((await storage.getSetting("admin_base_url"))?.value || config.appBaseUrl).replace(/\/+$/, "");
  const token = await getOrCreateArrivalsShareToken(storage);
  return `${base}/arrivals/t/${token}${date ? `?date=${date}` : ""}`;
}
