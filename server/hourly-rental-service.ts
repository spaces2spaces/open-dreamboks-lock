/**
 * HourlyRentalService — standalone hourly capsule rentals, fully OUTSIDE MEWS.
 *
 * A dedicated pool of rooms (rooms.hourlyPool = true, carved out of MEWS
 * inventory operator-side) is sold by the hour. Each booking lives in the
 * hourly_bookings table as its own source of truth: exact window, guest
 * contact, PIN code and the TTLock keyIds it was pushed with.
 *
 * Deliberately independent of the reservation PIN lifecycle:
 *  - no `pins` row (reservation-less pins are removed by deleteOrphanedPins),
 *  - no buildValidityWindow (the EXACT booked hours are used, minute-precise),
 *  - no activation-window gate (a booking starting in 10 minutes is pushed now).
 *
 * Offline locks (TTLock -3034) never break issuance: the code lands on every
 * reachable lock, missing locks are recorded and retried by sweep() once the
 * lock's gateway reconnects. TTLock firmware expires codes at endAt on its own,
 * and the nightly TTLock-native cleanup removes expired codes — so expiry needs
 * no active revocation.
 */
import { DateTime } from "luxon";
import type { ITenantStorage } from "./storage";
import type { AutomationEngine } from "./automation";
import { isLockOfflineError } from "./ttlock-client";
import { hasActiveLateCheckout } from "./pin-validity-window";
import { buildTwinMap, twinRoomIds, physicalRoomKey } from "./room-pairing";
import { priorityScore } from "@shared/hourly-priority";
import { mapHourlyWindowToMewsStay } from "./hourly-mews-window";
import { createNotificationClient } from "./notification-client";
import { sendOpsAlert } from "./ops-alert";
import { getSpaceDisplayName } from "@shared/display-name";
import type { HourlyBooking, Room, LockDevice } from "@shared/schema";

export interface LockKeyEntry {
  lockDeviceId: string;
  ttlockId: string;
  keyId: string;
  lockName: string;
  /**
   * Set when this lock's code was pushed because MEWS moved an ARRIVED guest
   * to that room ("grace move"): the code works on BOTH capsules until the
   * guest demonstrably unlocks the new one — booking.roomId stays on the
   * capsule the guest is physically in. The tagged room must count as
   * occupied in every availability computation (see room-pairing's
   * hourlyBookingBlocksRooms). After completion the tag points at the OLD
   * room on entries whose revoke failed (with revokePending) so the block
   * and the retry survive.
   */
  graceRoomId?: string;
  /** ISO timestamp of the grace push — only unlocks AFTER it count as "guest took the new capsule". */
  graceSince?: string;
  /** ISO timestamp of the successful "your capsule changed" guest notification (idempotence marker). */
  graceNotifiedAt?: string;
  /** Revoke failed after the move was decided — delete unconditionally on every sweep until it succeeds. */
  revokePending?: boolean;
}

export interface CreateHourlyBookingInput {
  guestName: string;
  guestEmail?: string;
  guestPhone?: string;
  startAt: Date;
  endAt: Date;
  roomId?: string; // omit → first free capsule in the pool
  amount?: string;
  currency?: string;
  paymentProvider?: string;
  paymentRef?: string;
}

// Statuses that block a time slot.
const BLOCKING_STATUSES = ["confirmed", "pending_payment"];

// MEWS reservation statuses (lowercased) whose guest physically holds a capsule.
const BLOCKING_RESERVATION_STATUSES = new Set(["confirmed", "checked-in", "started"]);

// Twin spaces ("401"/"401s") have DIFFERENT room ids, so the DB exclusion
// constraint hourly_bookings_no_overlap cannot see a concurrent insert on the
// sibling space — two simultaneous allocations could double-book one physical
// bed. Serialize allocation per physical capsule within this process (one
// Node process per deployment); the in-lock re-check closes the read-then-
// insert race the app-level twin guard otherwise has.
const allocationChains = new Map<string, Promise<void>>();
async function withPhysicalCapsuleLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = allocationChains.get(key) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  allocationChains.set(key, next);
  await prev;
  try {
    return await fn();
  } finally {
    release!();
    if (allocationChains.get(key) === next) allocationChains.delete(key);
  }
}

const MAX_DURATION_HOURS_DEFAULT = 24;
const PAST_START_GRACE_MS = 30 * 60 * 1000; // allow "book now" with clock skew

/**
 * MEWS' 403 for "the house is full in that window". Distinct from every other
 * reservations/add rejection: it is a verdict about inventory, not about the
 * shape of our request, so retrying the same 12 variants every 5 minutes is
 * pure noise (19/8-2026: 12 calls × ~180 sweeps for one booking).
 */
export function isMewsNoAvailabilityError(message: string): boolean {
  return /no availability/i.test(message);
}

// How long an oversold booking waits before ensureMewsReservation tries again.
const OVERSOLD_RETRY_INTERVAL_MS = 30 * 60 * 1000;

// Minimal structural slice of mews-client's (unexported) MewsReservation.
type MewsResSnapshot = { Id: string; State: string; AssignedResourceId?: string };

export class HourlyRentalService {
  constructor(
    private storage: ITenantStorage,
    private engine: AutomationEngine,
  ) {}

  // In-memory (per-process) count of consecutive MEWS check-in rejections per
  // booking — only feeds the ops-alert threshold; resets harmlessly on deploy.
  private checkinRejections = new Map<string, number>();
  private static readonly CHECKIN_REJECT_ALERT_AFTER = 3;

  // bookingId → earliest ms at which the sweep may retry a MEWS reservation
  // that was refused with "no availability" (same per-process lifetime as
  // checkinRejections: a deploy simply retries once more, which is harmless).
  private oversoldRetryAt = new Map<string, number>();

  // ── Availability ──────────────────────────────────────────────────────────

  /** Per-tenant feature gate — hourly rentals are opt-in (Capsule only for now). */
  async isEnabled(): Promise<boolean> {
    return (await this.storage.getSetting("hourly_rentals_enabled"))?.value === "true";
  }

  async getPoolRooms(): Promise<Room[]> {
    const all = await this.storage.getAllRooms();
    return all
      .filter(r => (r as any).hourlyPool === true)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  /**
   * Free pool rooms for [startAt, endAt). A room is blocked when any
   * confirmed/pending booking overlaps the requested window, with the optional
   * cleaning buffer (hourly_buffer_minutes) applied SYMMETRICALLY: every
   * booking — including the requested one — occupies [start, end + buffer),
   * so cleaning after our checkout can't collide with the next arrival either.
   */
  async findFreeRooms(startAt: Date, endAt: Date): Promise<Room[]> {
    const pool = await this.getPoolRooms();
    if (pool.length === 0) return [];
    return this.filterFreeOfHourlyBookings(pool, startAt, endAt);
  }

  /**
   * Drop rooms with a blocking hourly booking overlapping [startAt, endAt)
   * (buffer-extended, twin-aware). Extracted from findFreeRooms so the ADMIN
   * flow can validate an explicitly chosen capsule that is NOT in the pool —
   * the admin inventory shows every capsule, and Create booking must work on
   * any of them (MEWS occupancy is checked separately by filterOutMewsOccupied).
   */
  private async filterFreeOfHourlyBookings(rooms: Room[], startAt: Date, endAt: Date): Promise<Room[]> {
    const bufferMinutes = parseInt((await this.storage.getSetting("hourly_buffer_minutes"))?.value || "0", 10) || 0;
    const bufferMs = bufferMinutes * 60 * 1000;

    // Widen the query window by the buffer on BOTH sides so every booking the
    // in-memory check needs is fetched (ending just before startAt, or
    // starting just after endAt, within the buffer).
    const overlapping = await this.storage.getHourlyBookingsOverlapping(
      new Date(startAt.getTime() - bufferMs),
      new Date(endAt.getTime() + bufferMs),
      BLOCKING_STATUSES,
    );

    // Twin spaces ("401"/"401s" = same bed): a booking on either twin blocks
    // the physical capsule — expand blocked ids to the full twin set.
    // A grace move (arrived guest moved in MEWS, code live on BOTH capsules)
    // blocks the grace TARGET too, or it could be sold while the guest's code
    // still opens it.
    const twinMap = buildTwinMap(await this.storage.getAllRooms());
    const blockedRoomIds = new Set(
      overlapping
        .filter(b => windowsOverlap(
          startAt.getTime(), endAt.getTime() + bufferMs,
          new Date(b.startAt).getTime(), new Date(b.endAt).getTime() + bufferMs,
        ))
        .flatMap(b => [
          ...(twinMap.get(b.roomId) ?? [b.roomId]),
          ...((b.lockKeyIds as any as LockKeyEntry[]) || [])
            .filter(e => e.graceRoomId)
            .flatMap(e => twinMap.get(e.graceRoomId!) ?? [e.graceRoomId!]),
        ]),
    );
    return rooms.filter(r => !blockedRoomIds.has(r.id));
  }

  /**
   * Admin inventory overview for a date: per capsule, free intervals for
   * hourly rentals. Delegates to the availability module — the engine is
   * private to this class, so routes reach the overview through here.
   */
  async getDayOverview(dateISO: string) {
    const { computeDayAvailability } = await import("./hourly-availability");
    return computeDayAvailability(this.storage, this.engine.getMewsClient?.() ?? null, dateISO);
  }

  // ── Pricing ───────────────────────────────────────────────────────────────

  /** Per-hour price from settings; null = payment not configured (public flow refuses). */
  async getPricing(): Promise<{ perHour: number; currency: string } | null> {
    const priceSetting = await this.storage.getSetting("hourly_price_per_hour");
    const perHour = parseFloat(priceSetting?.value || "");
    if (!Number.isFinite(perHour) || perHour <= 0) return null;
    const currency = (await this.storage.getSetting("hourly_currency"))?.value || "DKK";
    return { perHour, currency };
  }

  /** Whole started hours × per-hour price. */
  computeAmount(startAt: Date, endAt: Date, perHour: number): { amount: number; hours: number } {
    const hours = Math.max(1, Math.ceil((endAt.getTime() - startAt.getTime()) / 3_600_000));
    return { amount: hours * perHour, hours };
  }

  /**
   * Fixed-price packages for the guest flow (owner decision 24/7: e.g.
   * 3 h = 399, 6 h = 499 — NOT hours × per-hour). Setting `hourly_products`
   * holds a JSON array [{"hours":3,"price":399},…]; empty/invalid → per-hour
   * pricing applies as before.
   */
  async getProducts(): Promise<Array<{ hours: number; price: number }>> {
    try {
      const raw = (await this.storage.getSetting("hourly_products"))?.value;
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(p => Number.isFinite(p?.hours) && p.hours > 0 && Number.isFinite(p?.price) && p.price > 0)
        .sort((a, b) => a.hours - b.hours);
    } catch {
      return [];
    }
  }

  /**
   * SERVER-side price for a public booking window — the client never sends a
   * price. With packages configured, the duration must match a package
   * exactly (packages are the only durations on sale) and its fixed price
   * wins; otherwise whole hours × per-hour.
   */
  resolvePublicPrice(
    products: Array<{ hours: number; price: number }>,
    startAt: Date,
    endAt: Date,
    perHour: number,
  ): { amount: number; hours: number } {
    const minutes = Math.max(1, Math.round((endAt.getTime() - startAt.getTime()) / 60_000));
    const hours = Math.max(1, Math.ceil(minutes / 60));
    if (products.length > 0) {
      // Walk-in windows (29/7): a "Now" start keeps the FULL package and the
      // end rounds UP to the next whole hour (12:47 + 3h → 16:00), so the
      // window is package-length plus up to 59 bonus minutes. Match packages
      // on that band instead of exact hours.
      const product = products.find(p => minutes >= p.hours * 60 && minutes < (p.hours + 1) * 60);
      if (!product) {
        throw new Error(`Choose one of the offered durations (${products.map(p => `${p.hours} h`).join(" / ")})`);
      }
      return { amount: product.price, hours };
    }
    return this.computeAmount(startAt, endAt, perHour);
  }

  // ── Booking + issuance ───────────────────────────────────────────────────

  /**
   * Shared allocation: validate the window, pick candidates (explicit room →
   * single candidate; free-list membership also implies pool membership +
   * tenant ownership), drop MEWS-occupied capsules, then insert. Double-booking
   * is impossible at the DB level: the partial EXCLUSION constraint
   * hourly_bookings_no_overlap rejects a second confirmed/pending row for the
   * same room+window (23P01) — on violation we try the next free capsule.
   */
  private async allocate(
    input: CreateHourlyBookingInput,
    status: "confirmed" | "pending_payment",
    code: string | null,
  ): Promise<{ booking: HourlyBooking; room: Room }> {
    this.validateWindow(input.startAt, input.endAt);
    await this.assertMaxDuration(input.startAt, input.endAt);

    let candidates: Room[];
    if (input.roomId) {
      // Explicit capsule (admin flow): pool membership is NOT required — the
      // admin inventory shows every capsule. Validate the room exists and has
      // no colliding hourly booking; MEWS occupancy is checked below.
      const room = await this.storage.getRoom(input.roomId);
      if (!room) throw new Error("Den valgte capsule findes ikke");
      const [chosen] = await this.filterFreeOfHourlyBookings([room], input.startAt, input.endAt);
      if (!chosen) throw new Error("Den valgte capsule er ikke ledig i det tidsrum");
      candidates = [chosen];
    } else {
      // Pool capsules always; with dynamic inventory (opt-in per tenant) any
      // lock-mapped MEWS room becomes sellable too — the availability engine
      // already enforces overnight > early/late > hourly priority, and the
      // booking gets a REAL MEWS reservation via ensureMewsReservation, so
      // MEWS/OTA can no longer double-sell the capsule.
      const base = await this.getSellableRooms();
      if (base.length === 0) throw new Error("Ingen ledige capsules i det tidsrum");
      const free = await this.filterFreeOfHourlyBookings(base, input.startAt, input.endAt);
      if (free.length === 0) throw new Error("Ingen ledige capsules i det tidsrum");
      candidates = free;
    }

    candidates = await this.filterOutMewsOccupied(candidates, input.startAt, input.endAt);
    if (candidates.length === 0) {
      throw new Error("Capsulen er optaget af en MEWS-reservation i det tidsrum — bloker den i MEWS eller vælg en anden");
    }

    // HOUSE RESERVE (19/8-2026 oversell): a reservation MEWS hasn't assigned
    // yet occupies some capsule — just not one we can name. Selling the last
    // free capsules out from under those arrivals is exactly how capsule 604
    // ended up holding an overnight guest AND an hourly guest at the same
    // time. Keep one capsule per unassigned arrival.
    const houseReserve = await this.countHouseSellable(candidates, input.startAt, input.endAt);
    if (houseReserve.free - houseReserve.reserved < 1) {
      // An ADMIN who names the capsule is the human override (the inventory
      // screen shows the unassigned count next to it) — warn, don't block.
      // The self-service path has no such judgement and is refused.
      await this.storage.createLog({
        level: "warn",
        message:
          `Hourly booking ${input.roomId ? "WARNING" : "refused"} (house reserve): ${houseReserve.free} free capsule(s) but ` +
          `${houseReserve.reserved} unassigned MEWS arrival(s) overlap ${input.startAt.toISOString()}–${input.endAt.toISOString()} — ` +
          `the house has nothing left to sell by the hour`,
        source: "hourly-rental",
      });
      if (!input.roomId) throw new Error("Ingen ledige capsules i det tidsrum");
    }

    candidates = await this.orderCandidatesByPriority(candidates, input.startAt, input.endAt);

    for (const candidate of candidates) {
      const lockKey = `${this.storage.tenantId}:${physicalRoomKey(candidate.name)}`;
      const booking = await withPhysicalCapsuleLock(lockKey, async () => {
        // Re-check INSIDE the lock: the DB constraint only guards this exact
        // room id — a concurrent hold on the twin sibling is invisible to it.
        const [stillFree] = await this.filterFreeOfHourlyBookings([candidate], input.startAt, input.endAt);
        if (!stillFree) return null;
        try {
          return await this.storage.createHourlyBooking({
            roomId: candidate.id,
            guestName: input.guestName,
            guestEmail: input.guestEmail || null,
            guestPhone: input.guestPhone || null,
            startAt: input.startAt,
            endAt: input.endAt,
            status,
            pinCode: code,
            amount: input.amount || null,
            currency: input.currency || null,
            paymentProvider: input.paymentProvider || null,
            paymentRef: input.paymentRef || null,
            paidAt: status === "confirmed" && input.paymentProvider ? new Date() : null,
          });
        } catch (err) {
          if (isExclusionViolation(err)) return null; // lost the race for this capsule — next
          throw err;
        }
      });
      if (booking) return { booking, room: candidate };
    }
    throw new Error("Ingen ledige capsules i det tidsrum (optaget i mellemtiden)");
  }

  /**
   * Rooms the no-roomId (public/self-service) path may sell. Since the 24/7
   * "Add to priority" semantics, the flag only ORDERS candidates — every
   * MEWS-mapped room with a room-type lock is sellable (a code must be
   * issuable to the door), and double-sales are prevented by the real MEWS
   * reservation each booking creates. Kill switch: hourly_dynamic_inventory
   * explicitly "false" restricts sales to priority-marked capsules only.
   */
  async getSellableRooms(): Promise<Room[]> {
    const pool = await this.getPoolRooms();
    const dynamic = (await this.storage.getSetting("hourly_dynamic_inventory"))?.value !== "false";
    if (!dynamic) return pool;
    const [all, assignments] = await Promise.all([
      this.storage.getAllRooms(),
      this.storage.getAllRoomLockAssignments(),
    ]);
    const lockMapped = new Set(
      assignments
        .filter(a => a.lockDevice?.lockType === "room" && a.lockDevice?.ttlockId)
        .map(a => a.roomId),
    );
    const poolIds = new Set(pool.map(r => r.id));
    const extras = all
      .filter(r => !poolIds.has(r.id) && r.pmsId && lockMapped.has(r.id))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return [...pool, ...extras];
  }

  /**
   * How many PHYSICAL capsules could booking actually allocate for the
   * window? Same filters as allocate (sellable set → hourly collisions →
   * MEWS occupancy), twins counted once — keeps the public "available"
   * answer consistent with what /book will accept.
   */
  async countBookableRooms(startAt: Date, endAt: Date): Promise<number> {
    const base = await this.getSellableRooms();
    if (base.length === 0) return 0;
    const free = await this.filterFreeOfHourlyBookings(base, startAt, endAt);
    if (free.length === 0) return 0;
    const bookable = await this.filterOutMewsOccupied(free, startAt, endAt);
    // Same house reserve as allocate() — unassigned MEWS arrivals each claim a
    // capsule, so the public "available" answer must not count them as ours.
    const { free: physical, reserved } = await this.countHouseSellable(bookable, startAt, endAt);
    return Math.max(0, physical - reserved);
  }

  /**
   * Order allocation candidates by the shared hourly priority (pool →
   * Inspected → Clean → Dirty/unknown → free-rest-of-day first) so the server
   * sells the same capsule the admin inventory would recommend. Housekeeping
   * states are best-effort (MEWS down → readiness rank 2 for all).
   */
  private async orderCandidatesByPriority(candidates: Room[], startAt: Date, endAt: Date): Promise<Room[]> {
    if (candidates.length <= 1) return candidates;

    const stateByRoomId = new Map<string, string>();
    try {
      const mews = this.engine.getMewsClient();
      if (mews) {
        const all = await this.storage.getAllRooms();
        const roomById = new Map(all.map(r => [r.id, r]));
        const twinMap = buildTwinMap(all);
        const statesByPms = new Map<string, string>();
        for (const res of await mews.getResources()) statesByPms.set(res.Id, res.State);
        const RANK: Record<string, number> = { Inspected: 0, Clean: 1, Dirty: 2, OutOfService: 3, OutOfOrder: 4 };
        for (const c of candidates) {
          let worst: string | null = null;
          for (const id of twinMap.get(c.id) ?? [c.id]) {
            const pmsId = roomById.get(id)?.pmsId;
            const st = pmsId ? statesByPms.get(pmsId) : undefined;
            if (st && (worst === null || (RANK[st] ?? -1) > (RANK[worst] ?? -1))) worst = st;
          }
          if (worst) stateByRoomId.set(c.id, worst);
        }
      }
    } catch { /* readiness is a preference, never a blocker */ }

    // Free rest of the (property-tz) start day: no later hourly booking on the
    // capsule that day. Twin-aware; reservation arrivals later today already
    // removed these candidates via filterOutMewsOccupied when overlapping.
    const busyLaterRoomIds = new Set<string>();
    try {
      const tz = (await this.storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
      const dayEnd = DateTime.fromJSDate(startAt, { zone: tz }).endOf("day");
      const laterBookings = await this.storage.getHourlyBookingsOverlapping(endAt, dayEnd.toJSDate(), BLOCKING_STATUSES);
      const twinMap = buildTwinMap(await this.storage.getAllRooms());
      for (const b of laterBookings) {
        for (const id of twinMap.get(b.roomId) ?? [b.roomId]) busyLaterRoomIds.add(id);
      }
    } catch { /* tie-break only */ }

    return [...candidates].sort((a, b) => {
      const scoreA = priorityScore({ priority: (a as any).hourlyPool === true, state: stateByRoomId.get(a.id), freeRestOfDay: !busyLaterRoomIds.has(a.id) });
      const scoreB = priorityScore({ priority: (b as any).hourlyPool === true, state: stateByRoomId.get(b.id), freeRestOfDay: !busyLaterRoomIds.has(b.id) });
      return scoreA - scoreB || a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  }

  /**
   * Push the code to the booking's locks and deliver it to the guest. Never
   * throws on lock/delivery failures — returns them so the CALLER decides
   * (admin flow may cancel; a PAID booking must never be auto-cancelled, the
   * sweep retries its missing locks instead).
   */
  private async issueAndDeliver(
    booking: HourlyBooking,
    room: Room,
    opts: { skipDeliveryOnTotalFailure?: boolean } = {},
  ): Promise<{ booking: HourlyBooking; warnings: string[]; totalFailure: boolean }> {
    const push = await this.pushCodeToRoomLocks(booking, room);
    const totalFailure = push.programmed.length === 0 && push.offline.length === 0;

    // MERGE with existing entries (dedupe by lock) — never overwrite: losing a
    // keyId means cancelBooking can no longer revoke that code.
    const merged = [...((booking.lockKeyIds as any as LockKeyEntry[]) || []), ...push.programmed]
      .filter((e, i, arr) => arr.findIndex(x => x.lockDeviceId === e.lockDeviceId) === i);
    let updated = (await this.storage.updateHourlyBooking(booking.id, {
      lockKeyIds: merged as any,
    })) || booking;

    const warnings: string[] = [];
    if (push.offline.length > 0) {
      warnings.push(`Lås(e) offline — koden lægges på automatisk når de kommer online: ${push.offline.join(", ")}`);
    }
    for (const e of push.errors) warnings.push(e);

    // On TOTAL failure the admin flow cancels the booking — never text the
    // guest a code that is about to be voided. (The PAID flow still delivers:
    // the booking stays confirmed and the sweep retries the locks.)
    const skipDelivery = totalFailure && opts.skipDeliveryOnTotalFailure;
    const delivered = skipDelivery ? false : await this.deliverCode(updated, room);
    if (delivered) {
      updated = (await this.storage.updateHourlyBooking(booking.id, { codeDeliveredAt: new Date() })) || updated;
    } else if (!skipDelivery && (updated.guestEmail || updated.guestPhone)) {
      warnings.push("Besked kunne ikke leveres (hverken SMS eller email) — udlever koden manuelt");
    }

    await this.storage.createLog({
      level: totalFailure ? "error" : "info",
      message: `Hourly booking issued: ${updated.guestName} → ${getSpaceDisplayName(room.name, room.label)} ${fmtIso(new Date(updated.startAt))}–${fmtIso(new Date(updated.endAt))} (code on ${push.programmed.length} lock(s)${push.offline.length ? `, ${push.offline.length} offline deferred` : ""}${totalFailure ? " — TOTAL FAILURE" : ""})`,
      source: "hourly-rental",
      roomId: room.id,
    });

    return { booking: updated, warnings, totalFailure };
  }

  /**
   * Admin flow: create a CONFIRMED booking and issue immediately. On total
   * genuine push failure (nothing programmed, nothing merely offline) the
   * booking is cancelled and the error surfaced to the operator.
   */
  async createAndIssueBooking(input: CreateHourlyBookingInput): Promise<{ booking: HourlyBooking; warnings: string[] }> {
    const code = await this.generateUniqueCode();
    const { booking, room } = await this.allocate(input, "confirmed", code);

    const issued = await this.issueAndDeliver(booking, room, { skipDeliveryOnTotalFailure: true });
    if (issued.totalFailure) {
      await this.storage.updateHourlyBooking(booking.id, { status: "cancelled" });
      throw new Error(`Kunne ikke lægge koden på nogen lås: ${issued.warnings.join("; ") || "ukendt fejl"}`);
    }
    await this.sendBookingCleaningSms(issued.booking, room);
    const mewsRes = await this.ensureMewsReservation(booking.id);
    return { booking: issued.booking, warnings: [...issued.warnings, ...mewsRes.warnings] };
  }

  /**
   * Public flow step 1: reserve the slot as a pending_payment hold (no code
   * yet). The hold blocks availability and is protected by the exclusion
   * constraint; sweep() releases it if payment never completes.
   */
  async createHold(input: CreateHourlyBookingInput): Promise<{ booking: HourlyBooking; room: Room }> {
    return this.allocate(input, "pending_payment", null);
  }

  /**
   * Public flow step 2 (payment confirmed — webhook or poll fallback):
   * idempotently flip the hold to confirmed, generate + push the code, and
   * send it to the guest. A PAID booking is never auto-cancelled on push
   * failure — the sweep retries missing locks until the window ends.
   *
   * Late-payment edge: if the hold already expired (sweep released it) we try
   * to re-take the slot; if another booking grabbed it meanwhile (exclusion
   * violation) we log loudly and fail — operator refunds via Stripe.
   */
  async confirmAndIssue(bookingId: string, payment: { provider: string; ref?: string }): Promise<{ booking: HourlyBooking; warnings: string[] }> {
    const booking = await this.storage.getHourlyBooking(bookingId);
    if (!booking) throw new Error("Booking ikke fundet");
    if (booking.status === "confirmed") return { booking, warnings: [] }; // idempotent (webhook + poll can race)

    // Terminal guards — money arrived for a booking we can no longer honour.
    // Log REFUND REQUIRED loudly; the operator refunds via Stripe's dashboard.
    if (booking.status === "cancelled") {
      await this.logRefundRequired(booking, "bookingen var annulleret da betalingen landede");
      throw new Error("Booking er annulleret — beløbet refunderes");
    }
    if (new Date(booking.endAt).getTime() <= Date.now()) {
      await this.logRefundRequired(booking, "betalingen landede efter tidsrummets udløb");
      throw new Error("Tidsrummet er udløbet — beløbet refunderes");
    }

    const room = await this.storage.getRoom(booking.roomId);
    if (!room) throw new Error("Capsule ikke fundet");

    const code = booking.pinCode || await this.generateUniqueCode();
    let confirmed: HourlyBooking | undefined;
    try {
      // Compare-and-set: webhook and poll fallback race here — exactly ONE
      // caller wins the flip and proceeds to push + deliver. The loser sees
      // 0 updated rows, re-reads, and returns the winner's booking untouched.
      confirmed = await this.storage.confirmHourlyBookingIfNotConfirmed(bookingId, {
        status: "confirmed",
        pinCode: code,
        paymentProvider: payment.provider,
        paymentRef: payment.ref || booking.paymentRef,
        paidAt: new Date(),
      });
    } catch (err) {
      if (isExclusionViolation(err)) {
        // Hold expired and someone else took the slot before payment landed.
        await this.logRefundRequired(booking, "tidsrummet blev optaget af en anden efter hold-udløb");
        throw new Error("Tidsrummet blev desværre optaget inden betalingen gik igennem — beløbet refunderes");
      }
      throw err;
    }
    if (!confirmed) {
      // Lost the race — the other caller (webhook/poll) already confirmed and
      // is pushing/delivering. Return the current state; do NOT push again.
      const winner = await this.storage.getHourlyBooking(bookingId);
      if (winner?.status === "confirmed") return { booking: winner, warnings: [] };
      throw new Error("Booking kunne ikke bekræftes");
    }

    const issued = await this.issueAndDeliver(confirmed, room);
    await this.sendBookingCleaningSms(issued.booking, room);
    // MEWS bookkeeping AFTER code issuance — door access first. Never throws.
    const mewsRes = await this.ensureMewsReservation(confirmed.id);
    return { booking: issued.booking, warnings: [...issued.warnings, ...mewsRes.warnings] };
  }

  /**
   * Create the REAL MEWS reservation occupying the capsule for this booking
   * (user decisions 21/7): windows touching ≥15:00 → standard night 15:00→10:00
   * next day; windows entirely before 15:00 → day-use start→15:00 (MEWS may
   * reject sub-day intervals — soft failure, booking proceeds without a MEWS
   * reservation since our own table guards all internal sale channels).
   *
   * NEVER throws. Gated by hourly_mews_reservation_enabled + the three MEWS id
   * settings + room.pmsId. Returns warnings for the operator. Failure after
   * payment → loud error log; the sweep retries while the window is future
   * (Identifier=booking.id lets MEWS dedupe retries).
   *
   * 28/7 (incident aaad641b): the booked capsule is assigned+locked AT
   * CREATION (AssignedResourceId in reservations/add) so MEWS' online
   * check-in can never freeze a wrong auto-assignment before our pin lands.
   * Create-then-pin remains as fallback, now with an ops alert when the pin
   * fails — MEWS is a mirror; the guest's capsule in OUR system is the truth.
   */
  async ensureMewsReservation(bookingId: string): Promise<{ warnings: string[] }> {
    const warnings: string[] = [];
    try {
      const booking = await this.storage.getHourlyBooking(bookingId);
      if (!booking || booking.mewsReservationId) return { warnings };
      if (booking.status !== "confirmed") return { warnings };

      if ((await this.storage.getSetting("hourly_mews_reservation_enabled"))?.value !== "true") {
        warnings.push("Booket uden MEWS-reservation (funktionen er slået fra) — bloker evt. manuelt i MEWS");
        return { warnings };
      }
      const serviceId = (await this.storage.getSetting("hourly_mews_service_id"))?.value;
      const rateId = (await this.storage.getSetting("hourly_mews_rate_id"))?.value;
      const categoryId = (await this.storage.getSetting("hourly_mews_category_id"))?.value;
      const mews = this.engine.getMewsClient?.();
      const room = await this.storage.getRoom(booking.roomId);
      if (!serviceId || !rateId || !categoryId || !mews || !room?.pmsId) {
        warnings.push("Booket uden MEWS-reservation (manglende MEWS-opsætning) — bloker evt. manuelt i MEWS");
        await this.storage.createLog({
          level: "warn",
          message: `Hourly booking ${booking.id}: MEWS reservation skipped — missing ${[
            !serviceId && "hourly_mews_service_id",
            !rateId && "hourly_mews_rate_id",
            !categoryId && "hourly_mews_category_id",
            !mews && "MEWS client",
            !room?.pmsId && "room.pmsId",
          ].filter(Boolean).join(", ")}`,
          source: "hourly-rental",
          roomId: booking.roomId,
        });
        return { warnings };
      }

      const tz = (await this.storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
      const checkIn = (await this.storage.getSetting("check_in_time"))?.value || "15:00";
      const checkout = (await this.storage.getSetting("reservation_checkout_time"))?.value || "10:00";
      const stay = mapHourlyWindowToMewsStay(new Date(booking.startAt), new Date(booking.endAt), tz, checkIn, checkout);

      // Customer: reuse the payment customer when we have one, else create.
      let customerId = booking.mewsCustomerId;
      if (!customerId) {
        const nameParts = booking.guestName.trim().split(/\s+/);
        const customer = await mews.addCustomer({
          firstName: nameParts.length > 1 ? nameParts.slice(0, -1).join(" ") : undefined,
          lastName: nameParts[nameParts.length - 1] || booking.guestName,
          email: booking.guestEmail || undefined,
          phone: booking.guestPhone || undefined,
        });
        customerId = customer.Id;
        await this.storage.updateHourlyBooking(booking.id, { mewsCustomerId: customerId });
      }

      const fmtHm = (d: Date) => DateTime.fromJSDate(d).setZone(tz).toFormat("dd/MM HH:mm");
      const note = `DreamBoks time-booking ${fmtHm(new Date(booking.startAt))}–${fmtHm(new Date(booking.endAt))}` +
        (booking.amount ? ` · betalt ${booking.amount} ${booking.currency || "DKK"} via payment request` : " · uden betaling (admin)") +
        ` · booking ${booking.id}`;

      // TRUE window first (owner request 24/7: housekeeping must see the real
      // times), WITH the actually-paid amount as price override (owner
      // request 24/7: the reservation must show 399, not the rate's night
      // price — TimeUnitPrices + DK-S verified accepted). Graceful fallback
      // ladder if MEWS rejects a combination; Identifier=booking.id dedupes
      // on the MEWS side, so multiple attempts can never create duplicates.
      //
      // Product mode (owner request 1/8): when hourly_mews_product_id is set,
      // the revenue is booked on that dedicated product instead — accounting
      // wants hourly sales trackable on its own account. The reservation is
      // then created at price 0 (still tax-coded) and the paid amount posted
      // as a product line after creation. Zero-price attempts go first; the
      // old price-on-reservation attempts stay as fallback, and a fallback
      // win posts NO product line, so revenue is never double-booked.
      const base = {
        serviceId,
        rateId,
        customerId,
        identifier: booking.id,
        notes: note,
      };
      const paidAmount = parseFloat(booking.amount ?? "");
      const taxCode = (await this.storage.getSetting("hourly_mews_tax_code"))?.value || "DK-S";
      const currency = booking.currency || "DKK";
      const priceOverride = Number.isFinite(paidAmount) && paidAmount > 0
        ? { grossValue: paidAmount, currency, taxCode }
        : undefined;
      const productId = (await this.storage.getSetting("hourly_mews_product_id"))?.value;
      const zeroPrice = productId && priceOverride
        ? { grossValue: 0, currency, taxCode }
        : undefined;
      const exact = { startUtc: new Date(booking.startAt), endUtc: new Date(booking.endAt) };
      const fallback = { startUtc: stay.startUtc, endUtc: stay.endUtc };
      type Attempt = { label: string; window: typeof exact; price?: typeof priceOverride; postProduct?: boolean };
      const attempts: Attempt[] = [
        ...(zeroPrice ? [
          { label: "exact window + product line", window: exact, price: zeroPrice, postProduct: true },
          { label: `${stay.kind} shape + product line`, window: fallback, price: zeroPrice, postProduct: true },
        ] : []),
        ...(priceOverride ? [{ label: "exact window + paid price", window: exact, price: priceOverride }] : []),
        { label: "exact window", window: exact },
        ...(priceOverride ? [{ label: `${stay.kind} shape + paid price`, window: fallback, price: priceOverride }] : []),
        { label: `${stay.kind} shape`, window: fallback },
      ];
      // ── Assignment-at-creation (28/7, incident aaad641b) ────────────────
      // Create WITH AssignedResourceId + AssignedResourceLocked so the capsule
      // is correct and locked from the first second. The old create-then-pin
      // sequence had a gap: a guest completing MEWS' online check-in hard-locks
      // the AUTO-assigned space, and the pin then 403s unrecoverably ("Cannot
      // move reservation" — unlock-retry does not help).
      // Probe-verified 28/7 (scripts/probe-mews-add-assigned-resource.mts):
      // RequestedCategoryId must be the capsule's OWN category, and membership
      // is not readable via API — the mismatch-400 is deterministic and creates
      // NOTHING, so we ladder over the service's few categories and cache the
      // hit per resource in a settings JSON map.
      const CATEGORY_CACHE_KEY = "hourly_mews_resource_category_map";
      let categoryCache: Record<string, string> = {};
      try {
        categoryCache = JSON.parse((await this.storage.getSetting(CATEGORY_CACHE_KEY))?.value || "{}") || {};
      } catch { /* corrupt cache → rebuild from scratch */ }

      const catLadder: string[] = [];
      const pushCat = (id?: string | null) => { if (id && !catLadder.includes(id)) catLadder.push(id); };
      pushCat(categoryCache[room.pmsId]); // known own category first
      pushCat(categoryId);                 // then the setting category
      let catLadderComplete = false;       // service's full list appended?
      let catIdx = 0;                      // mismatch-rejected categories are never retried

      let reservationId: string | undefined;
      let assignedAtCreation = false;
      let wonAttempt: Attempt | undefined;
      let lastError: unknown;
      outer:
      for (const attempt of attempts) {
        while (catIdx < catLadder.length) {
          const cat = catLadder[catIdx];
          try {
            ({ reservationId } = await mews.createReservation({
              ...base,
              requestedCategoryId: cat,
              assignedResourceId: room.pmsId,
              assignedResourceLocked: true,
              startUtc: attempt.window.startUtc,
              endUtc: attempt.window.endUtc,
              priceOverride: attempt.price,
            }));
            assignedAtCreation = true;
            wonAttempt = attempt;
            if (categoryCache[room.pmsId] !== cat) {
              categoryCache[room.pmsId] = cat;
              await this.storage.setSetting(CATEGORY_CACHE_KEY, JSON.stringify(categoryCache)).catch(() => {});
            }
            break outer;
          } catch (error) {
            lastError = error;
            const msg = error instanceof Error ? error.message : String(error);
            if (/does not belong to the requested category/i.test(msg)) {
              catIdx++;
              if (catIdx >= catLadder.length && !catLadderComplete) {
                catLadderComplete = true;
                try {
                  for (const c of await mews.getServiceResourceCategories(serviceId)) pushCat(c.Id);
                } catch { /* cannot enumerate — ladder ends, legacy fallback below */ }
              }
              continue; // same window attempt, next category
            }
            await this.storage.createLog({
              level: "info",
              message: `Hourly booking ${booking.id}: MEWS rejected "${attempt.label}" (assigned-at-creation) — trying next variant: ${msg}`,
              source: "automation",
            });
            continue outer; // window/price problem — next attempt, category kept
          }
        }
        break; // category ladder exhausted — legacy fallback below
      }

      if (!reservationId) {
        // Legacy path (pre-28/7): create WITHOUT assignment (MEWS auto-assigns
        // within the setting category) and pin the capsule right after. Kept as
        // a fallback so a MEWS-side conflict on the exact space (e.g. an OTA
        // overlap) or changed AssignedResourceId semantics can never block the
        // reservation outright — the mismatch alert below covers the rest.
        for (const attempt of attempts) {
          try {
            ({ reservationId } = await mews.createReservation({
              ...base,
              requestedCategoryId: categoryId,
              startUtc: attempt.window.startUtc,
              endUtc: attempt.window.endUtc,
              priceOverride: attempt.price,
            }));
            wonAttempt = attempt;
            break;
          } catch (error) {
            lastError = error;
            await this.storage.createLog({
              level: "info",
              message: `Hourly booking ${booking.id}: MEWS rejected "${attempt.label}" — trying next variant: ${error instanceof Error ? error.message : String(error)}`,
              source: "automation",
            });
          }
        }
      }
      if (!reservationId) throw lastError instanceof Error ? lastError : new Error(String(lastError));

      // Persist BEFORE pinning the resource: from this instant the ingestion
      // guard recognizes the reservation and will never import it.
      await this.storage.updateHourlyBooking(booking.id, { mewsReservationId: reservationId });
      this.oversoldRetryAt.delete(booking.id); // MEWS found room after all

      // Product mode won: the reservation is at price 0, so the paid amount
      // MUST land as a product line — a failure here means missing revenue in
      // MEWS until someone books it manually, hence the loud error + note.
      if (wonAttempt?.postProduct && productId && priceOverride) {
        try {
          await mews.addReservationProduct(reservationId, productId, 1, priceOverride);
        } catch (error) {
          warnings.push("MEWS-reservation oprettet, men produktlinjen med omsætningen fejlede — bogfør beløbet manuelt i MEWS");
          try {
            await mews.addReservationNote(
              reservationId,
              `Hour Bookings-produktlinjen fejlede: bogfør ${booking.amount} ${currency} manuelt (booking ${booking.id})`
            );
          } catch { /* note is best-effort */ }
          await this.storage.createLog({
            level: "error",
            message: `Hourly booking ${booking.id}: product posting failed after zero-price reservation — revenue is MISSING in MEWS until booked manually: ${error instanceof Error ? error.message : String(error)}`,
            source: "hourly-rental",
            roomId: booking.roomId,
          });
        }
      }

      if (!assignedAtCreation) {
        // MEWS auto-assigns a space within the category on add. Any TWIN of the
        // booked room is the same physical bed — accept it; otherwise move+lock.
        const allRooms = await this.storage.getAllRooms();
        const twinIds = twinRoomIds(allRooms, booking.roomId);
        const twinPmsIds = new Set(
          (await Promise.all(twinIds.map((id) => this.storage.getRoom(id))))
            .map((r) => r?.pmsId)
            .filter(Boolean) as string[]
        );
        let assignedOk = false;
        let mewsAssignedResourceId: string | undefined;
        try {
          const [created] = await mews.getReservations([reservationId]);
          mewsAssignedResourceId = created?.AssignedResourceId;
          if (created?.AssignedResourceId && twinPmsIds.has(created.AssignedResourceId)) {
            assignedOk = true; // auto-assignment already hit the right physical bed
          }
        } catch { /* can't read back — fall through to explicit pinning */ }

        if (!assignedOk) {
          const pin = await mews.updateReservationAssignedResource(reservationId, room.pmsId);
          if (!pin.success) {
            const bookedLabel = getSpaceDisplayName(room.name, room.label);
            const assignedRoom = allRooms.find((r) => r.pmsId && r.pmsId === mewsAssignedResourceId);
            const assignedLabel = assignedRoom
              ? getSpaceDisplayName(assignedRoom.name, assignedRoom.label)
              : mewsAssignedResourceId || "ukendt plads";
            warnings.push(`MEWS-reservation oprettet men capsule-tildeling fejlede — tildel ${bookedLabel} manuelt i MEWS`);
            await this.storage.createLog({
              level: "error",
              message: `Hourly booking ${booking.id}: MEWS reservation ${reservationId} created but resource assignment failed: ${pin.error}`,
              source: "hourly-rental",
              roomId: booking.roomId,
            });
            // Guest's code/capsule in OUR system is the truth — MEWS is a
            // mirror. When the mirror shows another space, housekeeping preps
            // the wrong bed unless someone compensates (all fixes are remote:
            // reassign in MEWS admin, no on-site staff exists).
            await sendOpsAlert(
              this.storage as any,
              `hourly-mews-assignment:${booking.id}`,
              "warning",
              `Time-booking: MEWS viser forkert kapsel for ${booking.guestName} (${fmtHm(new Date(booking.startAt))}–${fmtHm(new Date(booking.endAt))})`,
              `Gæstens kode åbner Capsule ${bookedLabel} (vores system er sandheden), men MEWS-reservation ${reservationId} står på ${assignedLabel} og kunne ikke flyttes: ${pin.error}. ` +
                `Flyt reservationen til ${bookedLabel} i MEWS (fjern evt. online check-in-låsen), eller sørg for at housekeeping klargør ${bookedLabel} i stedet for ${assignedLabel}.`
            );
          }
        }
      }

      await this.storage.createLog({
        level: "info",
        message: `Hourly booking: MEWS reservation ${reservationId} created (${stay.kind}, ${stay.startUtc.toISOString()} → ${stay.endUtc.toISOString()}, ${assignedAtCreation ? "capsule assigned+locked at creation" : "pinned after creation"}) for ${booking.guestName} on ${getSpaceDisplayName(room.name, room.label)}`,
        source: "hourly-rental",
        roomId: booking.roomId,
      });
      return { warnings };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const booking = await this.storage.getHourlyBooking(bookingId).catch(() => undefined);
      // Day-use rejections are EXPECTED (nightly service may refuse sub-day
      // intervals) — soft-degrade; everything else is a loud error the sweep
      // retries via ensureMewsReservation being idempotent.
      await this.storage.createLog({
        level: "error",
        message: `Hourly booking ${bookingId}: MEWS RESERVATION MISSING (${msg}) — guest unaffected (code issued); create manually in MEWS if needed`,
        source: "hourly-rental",
        roomId: booking?.roomId,
      });

      // OVERSELL (19/8-2026): "no availability" is not a hiccup — it is MEWS
      // stating the house is full for that window, i.e. we just sold a capsule
      // that does not exist. The money is taken and the code is out, so the
      // only remaining defense is a human, immediately. Retries are throttled
      // (the verdict won't change on its own) and the alert deduped by
      // sendOpsAlert's 1h window.
      if (isMewsNoAvailabilityError(msg)) {
        this.oversoldRetryAt.set(bookingId, Date.now() + OVERSOLD_RETRY_INTERVAL_MS);
        const room = booking ? await this.storage.getRoom(booking.roomId).catch(() => undefined) : undefined;
        const label = room ? getSpaceDisplayName(room.name, room.label) : "ukendt capsule";
        const tz = (await this.storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
        const fmt = (d: Date) => DateTime.fromJSDate(d).setZone(tz).toFormat("dd/MM HH:mm");
        const windowLabel = booking
          ? `${fmt(new Date(booking.startAt))}–${fmt(new Date(booking.endAt))}`
          : "ukendt tidsrum";
        await sendOpsAlert(
          this.storage as any,
          `hourly-mews-oversold:${bookingId}`,
          "critical",
          `Time-booking OVERSOLGT: MEWS har ingen ledig kapacitet for ${booking?.guestName || "gæst"} (Capsule ${label}, ${windowLabel})`,
          `MEWS afviser reservationen med "no availability for the selected dates" — huset er fuldt i det tidsrum, ` +
            `men bookingen er betalt (${booking?.amount || "?"} ${booking?.currency || "DKK"}) og koden er sendt til gæsten. ` +
            `Capsule ${label} kan altså være optaget af en overnattende gæst samtidig. ` +
            `Handl nu: find ud af hvem der reelt har kapslen i MEWS, flyt time-bookingen til en fri kapsel i DreamBoks-admin ` +
            `(koden følger med uændret) — eller aflys og refundér gæsten. Booking-id ${bookingId}.`
        );
        return {
          warnings: [
            `MEWS melder UDSOLGT for tidsrummet — capsulen kan være dobbeltbooket. Bookingen er betalt og koden sendt; afklar i MEWS med det samme.`,
          ],
        };
      }
      return { warnings: [`MEWS-reservation kunne ikke oprettes (${msg.slice(0, 120)}) — bookingen virker, men bloker evt. capsulen manuelt i MEWS`] };
    }
  }

  /**
   * Staff/cleaning SMS for hourly bookings — sent for EVERY booking the moment
   * it is confirmed (owner decision 25/7; previously skipped when the capsule
   * was confirmed Inspected). The unmanned hotel's housekeeping must know
   * immediately: the capsule must be ready before the window AND gets an
   * extra cleaning round after it ends. Housekeeping state is included as
   * info but no longer gates the send. Called exactly once per booking
   * (admin create + payment-confirm CAS are both exactly-once).
   */
  private async sendBookingCleaningSms(booking: HourlyBooking, room: Room): Promise<void> {
    try {
      let state = "ukendt";
      const mews = this.engine.getMewsClient?.();
      if (mews && room.pmsId) {
        try {
          const resources = await mews.getResources([room.pmsId]);
          state = resources[0]?.State || "ukendt";
        } catch { /* state stays unknown — the SMS still goes out */ }
      }

      const label = getSpaceDisplayName(room.name, room.label);
      const phone = (await this.storage.getSetting("early_checkin_cleaning_sms_phone"))?.value;
      if (!phone) {
        await this.storage.createLog({
          level: "error",
          message: `Hourly booking: early_checkin_cleaning_sms_phone is not configured — booking SMS for Capsule ${label} NOT sent!`,
          source: "hourly-rental",
          roomId: room.id,
        });
        return;
      }
      const fmtHm = (d: Date) => DateTime.fromJSDate(d).setZone("Europe/Copenhagen").toFormat("HH:mm");
      const fmtDay = (d: Date) => DateTime.fromJSDate(d).setZone("Europe/Copenhagen").toFormat("d/M");
      const notif = await createNotificationClient(this.storage);
      const sent = await notif.sendPlainSMS({
        to: phone,
        body: `TIME-BOOKING: Capsule ${label} er booket ${fmtDay(new Date(booking.startAt))} kl. ${fmtHm(new Date(booking.startAt))}–${fmtHm(new Date(booking.endAt))}. Housekeeping-status: ${state} — klargør inden start, og ekstra rengøring efter kl. ${fmtHm(new Date(booking.endAt))}.`,
      });
      await this.storage.createLog({
        level: sent.success ? "info" : "error",
        message: sent.success
          ? `Hourly booking: cleaning SMS sent to ${phone} for Capsule ${label} (state: ${state})`
          : `Hourly booking: cleaning SMS FAILED to ${phone} for Capsule ${label}: ${sent.error}`,
        source: "hourly-rental",
        roomId: room.id,
      });
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Hourly booking: cleaning-alert block failed entirely: ${error instanceof Error ? error.message : String(error)}`,
        source: "hourly-rental",
        roomId: room.id,
      });
    }
  }

  private async logRefundRequired(booking: HourlyBooking, reason: string): Promise<void> {
    await this.storage.createLog({
      level: "error",
      message: `Hourly payment received for ${booking.guestName} (${booking.id}) but ${reason} — REFUND REQUIRED via Stripe (ref ${booking.paymentRef || "ukendt"})`,
      source: "hourly-rental",
      roomId: booking.roomId,
    });
  }

  /** Cancel a booking and revoke its code from every lock it reached. */
  async cancelBooking(id: string): Promise<{ booking: HourlyBooking; revoked: number; failed: string[] }> {
    const booking = await this.storage.getHourlyBooking(id);
    if (!booking) throw new Error("Booking ikke fundet");
    if (booking.status === "cancelled") return { booking, revoked: 0, failed: [] };

    const ttlockClient = this.engine.getTTLockClient();
    const entries = (booking.lockKeyIds as any as LockKeyEntry[]) || [];
    let revoked = 0;
    const failed: string[] = [];
    for (const entry of entries) {
      try {
        const keyId = parseInt(entry.keyId, 10);
        if (!ttlockClient || !Number.isFinite(keyId)) { failed.push(entry.lockName); continue; }
        await ttlockClient.deletePasscode(entry.ttlockId, keyId);
        revoked++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Offline lock: firmware still expires the code at endAt, so this is
        // a deferred tidy-up, not an access risk beyond the paid window.
        failed.push(`${entry.lockName}${isLockOfflineError(msg) ? " (offline)" : ""}`);
      }
    }

    const updated = (await this.storage.updateHourlyBooking(id, { status: "cancelled" }))!;

    // Release the MEWS reservation too (if one was created and not already
    // checked out). Best-effort: failure is a warning, not a blocker.
    if (booking.mewsReservationId && !booking.mewsCheckedOutAt) {
      const mews = this.engine.getMewsClient?.();
      if (mews) {
        const res = await mews.cancelReservation(booking.mewsReservationId, "Hourly booking cancelled");
        if (!res.success) {
          failed.push(`MEWS-reservation (${res.error?.slice(0, 80) || "ukendt fejl"})`);
          await this.storage.createLog({
            level: "error",
            message: `Hourly booking ${id}: MEWS reservation ${booking.mewsReservationId} could NOT be cancelled: ${res.error} — cancel manually in MEWS`,
            source: "hourly-rental",
            roomId: booking.roomId,
          });
        }
      }
    }

    await this.storage.createLog({
      level: "info",
      message: `Hourly booking cancelled: ${booking.guestName} (${revoked}/${entries.length} passcodes revoked${failed.length ? `; pending: ${failed.join(", ")}` : ""})`,
      source: "hourly-rental",
      roomId: booking.roomId,
    });
    return { booking: updated, revoked, failed };
  }

  // ── Sweep (interval job) ─────────────────────────────────────────────────

  /**
   * Periodic housekeeping — all steps idempotent and independent of MEWS jobs:
   *  1. release pending_payment holds older than hourly_hold_minutes (15 min),
   *  2. mark ended bookings expired (locks expire the code themselves),
   *  3. re-push codes to locks that were offline at issuance and are back.
   */
  private sweepInFlight = false;

  async sweep(): Promise<void> {
    // Overlap guard (same failure class as the 3/8 activation-sweep stampede,
    // ec760bb): a pass slowed by TTLock timeouts must not stack on the next
    // 5-min tick — duplicate passes double SMS sends and lock traffic.
    if (this.sweepInFlight) return;
    this.sweepInFlight = true;
    try {
      await this.sweepOnce();
    } finally {
      this.sweepInFlight = false;
    }
  }

  private async sweepOnce(): Promise<void> {
    // Feature is opt-in per tenant — skip entirely (no queries) when off.
    if (!(await this.isEnabled())) return;

    const now = Date.now();

    const recent = await this.storage.getHourlyBookings(500);

    // 1) Payment holds. MEWS has no webhook to us, and a guest may pay via
    // MEWS' emailed link without ever opening our confirmation page (which is
    // what polls) — so EVERY sweep pass checks pending MEWS holds against the
    // payment request state: Completed → issue the code now (≤5 min after
    // payment, worst case); Canceled/Expired → release immediately; Pending
    // past the hold TTL (default 35 min > the 30-min payment window) → release.
    const holdMinutes = parseInt((await this.storage.getSetting("hourly_hold_minutes"))?.value || "35", 10) || 35;
    for (const b of recent) {
      if (b.status !== "pending_payment") continue;
      const holdExpired = now - new Date(b.createdAt).getTime() > holdMinutes * 60 * 1000;

      if (b.paymentProvider === "mews" && b.paymentRef) {
        try {
          const mewsClient = this.engine.getMewsClient?.();
          const [pr] = mewsClient ? await mewsClient.getPaymentRequestsByIds([b.paymentRef]) : [];
          if (pr?.State === "Completed") {
            await this.confirmAndIssue(b.id, { provider: "mews", ref: pr.Id });
            continue; // paid — issued instead of released
          }
          if (pr?.State === "Canceled" || pr?.State === "Expired") {
            // "cancelled", NOT "expired": expired is reserved for FINISHED real
            // bookings (24/7 — abandoned holds showed up on the arrivals list
            // as phantom "Time booking (finished)" rows with cleaning tasks).
            await this.storage.updateHourlyBooking(b.id, { status: "cancelled" });
            continue;
          }
          // Abandoned-payment nudge (3/8: 3 holds died unpaid in one morning
          // with no signal to the guest at all): a hold still Pending after
          // 10 min gets ONE reminder with the payment link before the TTL
          // releases it. One-shot via payment_reminder_at; failures are
          // non-fatal — the hold lives or dies by the TTL exactly as before.
          if (pr?.State === "Pending" && !b.paymentReminderAt && mewsClient &&
              now - new Date(b.createdAt).getTime() > HourlyRentalService.HOLD_REMINDER_AFTER_MS && !holdExpired) {
            await this.sendHoldPaymentReminder(b, mewsClient.getPaymentRequestUrl(b.paymentRef), holdMinutes);
          }
        } catch (err) {
          // Can't verify right now — keep the hold one more sweep pass rather
          // than risk discarding a paid booking.
          await this.storage.createLog({
            level: "warn",
            message: `Hourly sweep: could not verify MEWS payment request for hold ${b.id} — retrying next pass (${err instanceof Error ? err.message : String(err)})`,
            source: "hourly-rental",
            roomId: b.roomId,
          });
          continue;
        }
      }
      if (holdExpired) {
        // Same rule: an unpaid hold that timed out was never a real booking.
        await this.storage.updateHourlyBooking(b.id, { status: "cancelled" });
      }
    }

    // 2) Mark ended bookings expired (1h grace after endAt)
    for (const b of recent) {
      if (b.status !== "confirmed") continue;
      if (new Date(b.endAt).getTime() < now - 60 * 60 * 1000) {
        await this.storage.updateHourlyBooking(b.id, { status: "expired" });
      }
    }

    // 3) Retry locks missed at issuance (e.g. offline gateway back online).
    for (const b of recent) {
      if (b.status !== "confirmed" || !b.pinCode) continue;
      if (new Date(b.endAt).getTime() <= now) continue; // window over — firmware handles it
      const room = await this.storage.getRoom(b.roomId);
      if (!room) continue;
      const assignments = await this.storage.getRoomLockAssignments(room.id);
      const have = new Set(((b.lockKeyIds as any as LockKeyEntry[]) || []).map(e => e.lockDeviceId));
      const missing = assignments.filter(a => a.lockDevice?.ttlockId && !have.has(a.lockDevice.id));
      if (missing.length === 0) continue;

      // Re-read right before pushing: the admin may have cancelled the booking
      // while this sweep pass was busy with earlier bookings — re-pushing a
      // cancelled guest's code would silently restore their access.
      const fresh = await this.storage.getHourlyBooking(b.id);
      if (!fresh || fresh.status !== "confirmed") continue;

      const push = await this.pushCodeToRoomLocks(fresh, room);
      if (push.programmed.length > 0) {
        const merged = [...((fresh.lockKeyIds as any as LockKeyEntry[]) || []), ...push.programmed]
          .filter((e, i, arr) => arr.findIndex(x => x.lockDeviceId === e.lockDeviceId) === i);
        await this.storage.updateHourlyBooking(b.id, { lockKeyIds: merged as any });
        await this.storage.createLog({
          level: "info",
          message: `Hourly sweep: code ${b.pinCode} re-pushed to ${push.programmed.map(p => p.lockName).join(", ")} for ${b.guestName}`,
          source: "hourly-rental",
          roomId: b.roomId,
        });
      }
    }

    // 4) Retry missing MEWS reservations for confirmed bookings whose window
    //    hasn't ended (creation failed at confirmation — e.g. MEWS hiccup).
    if ((await this.storage.getSetting("hourly_mews_reservation_enabled"))?.value === "true") {
      for (const b of recent) {
        if (b.status !== "confirmed" || b.mewsReservationId) continue;
        if (new Date(b.endAt).getTime() <= now) continue;
        // Oversold bookings back off (30 min): MEWS' "no availability" verdict
        // does not change between two sweeps, and the operator has been
        // alerted — hammering it 12 calls per 5 minutes helps nobody.
        const retryAt = this.oversoldRetryAt.get(b.id);
        if (retryAt !== undefined && now < retryAt) continue;
        await this.ensureMewsReservation(b.id);
      }
    }

    // 4c) FOLLOW MEWS RESOURCE MOVES (6/8 incident, Amer/302): staff moving an
    //     hourly day-use reservation on the MEWS timeline is a real workflow —
    //     the code must follow the reservation, not fight it. Guarded inside:
    //     an ARRIVED guest is grace-followed (code live on BOTH capsules until
    //     the guest uses the new door), never onto an occupied/unknown capsule.
    try {
      await this.followMewsResourceMoves(recent, now);
    } catch (err) {
      await this.storage.createLog({
        level: "warn",
        message: `Hourly sweep: MEWS move-follow step failed — retrying next pass (${err instanceof Error ? err.message : String(err)})`,
        source: "hourly-rental",
      });
    }

    // 4d) CONFLICT WATCH (19/8 incident, capsule 604): a reservation MEWS
    //     assigns AFTER we sold the capsule turns our own DB into the proof of
    //     a double-booked bed. Move the hourly guest (same code) or alarm.
    try {
      await this.watchMewsConflicts(recent, now);
    } catch (err) {
      await this.storage.createLog({
        level: "warn",
        message: `Hourly sweep: MEWS conflict watch failed — retrying next pass (${err instanceof Error ? err.message : String(err)})`,
        source: "hourly-rental",
      });
    }

    // 4b) CHECK-IN SIGNAL (owner decision 28/7): same principle as overnight
    //     bookings — MEWS check-in fires when the guest has ACTUALLY used
    //     their code on one of the booking's locks (verified against TTLock
    //     unlock records), never merely because the window opened. A
    //     reservation already Started/Processed (staff/manual/MEWS online
    //     check-in) is just flagged so we stop polling it.
    const mewsForCheckin = this.engine.getMewsClient?.();
    if (mewsForCheckin) {
      for (const b of recent) {
        if (!b.mewsReservationId || b.mewsCheckedInAt || b.mewsCheckedOutAt) continue;
        if (b.status !== "confirmed") continue;
        const startMs = new Date(b.startAt).getTime();
        // Active stays only — ended bookings go through the checkout signal,
        // which starts+processes in one go.
        if (startMs > now || new Date(b.endAt).getTime() <= now) continue;

        try {
          const [res] = await mewsForCheckin.getReservations([b.mewsReservationId]);
          const state = res?.State;
          if (!res || state === "Started" || state === "Processed" || state === "Canceled") {
            await this.storage.updateHourlyBooking(b.id, { mewsCheckedInAt: new Date() });
            continue;
          }

          // Still Confirmed in MEWS: has the code been used on any lock?
          const usedAt = await this.findCodeUsedAt(b);
          if (!usedAt) continue;

          const started = await mewsForCheckin.startReservation(b.mewsReservationId);
          if (started.success) {
            this.checkinRejections.delete(b.id);
            await this.storage.updateHourlyBooking(b.id, { mewsCheckedInAt: new Date() });
            await this.storage.createLog({
              level: "info",
              message: `Hourly check-in signal: code ${b.pinCode} used at ${usedAt.toISOString()} — MEWS reservation ${b.mewsReservationId} started for ${b.guestName}`,
              source: "hourly-rental",
              roomId: b.roomId,
            });
          } else {
            // Martinsen-lesson (20e3b09): a swallowed MEWS rejection must
            // never be silent — this retried invisibly every sweep on 6/8
            // while MEWS kept refusing (occupied/blocked space).
            const attempts = (this.checkinRejections.get(b.id) ?? 0) + 1;
            this.checkinRejections.set(b.id, attempts);
            await this.storage.createLog({
              level: "warn",
              message: `Hourly check-in signal: MEWS REJECTED start of reservation ${b.mewsReservationId} for ${b.guestName} (attempt ${attempts}): ${started.error} — retrying next sweep`,
              source: "hourly-rental",
              roomId: b.roomId,
            });
            if (attempts >= HourlyRentalService.CHECKIN_REJECT_ALERT_AFTER) {
              await sendOpsAlert(
                this.storage as any,
                `hourly-mews-checkin:${b.id}`,
                "warning",
                `Time-booking: MEWS afviser check-in for ${b.guestName}`,
                `MEWS-reservation ${b.mewsReservationId} er afvist ${attempts} gange ved check-in: ${started.error}. ` +
                  `Gæsten er upåvirket (koden virker), men MEWS viser stadig "To check in". ` +
                  `Typisk årsag: kapslen er optaget eller blokeret af en anden reservation på MEWS-timelinen — ryd op dér.`,
              );
            }
          }
        } catch (err) {
          await this.storage.createLog({
            level: "warn",
            message: `Hourly check-in signal failed for booking ${b.id} — retrying next sweep (${err instanceof Error ? err.message : String(err)})`,
            source: "hourly-rental",
            roomId: b.roomId,
          });
        }
      }
    }

    // 5) CHECKOUT SIGNAL (user decision 21/7): when the hourly interval has
    //    ended, mark the MEWS reservation checked out so the capsule frees up
    //    in MEWS for the rest of the night. Mirrors the PIN-use → check-in
    //    signal. Includes status "expired" — step 2 flips confirmed→expired
    //    1h after endAt, which must not exempt a booking from checkout.
    const mewsForCheckout = this.engine.getMewsClient?.();
    if (mewsForCheckout) {
      for (const b of recent) {
        if (!b.mewsReservationId || b.mewsCheckedOutAt) continue;
        if (b.status !== "confirmed" && b.status !== "expired") continue;
        const endMs = new Date(b.endAt).getTime();
        if (endMs > now) continue;

        try {
          const [res] = await mewsForCheckout.getReservations([b.mewsReservationId]);
          const state = res?.State;
          let done = false;
          if (!res || state === "Processed" || state === "Canceled") {
            done = true; // staff already handled it (or it's gone)
          } else {
            if (state === "Confirmed") {
              // process requires Started — mirror the check-in signal first.
              await mewsForCheckout.startReservation(b.mewsReservationId);
            }
            const out = await mewsForCheckout.processReservation(b.mewsReservationId);
            done = out.success;
            if (!done && endMs < now - 24 * 3600_000) {
              await this.storage.createLog({
                level: "error",
                message: `Hourly checkout signal GIVING UP for booking ${b.id} (MEWS ${b.mewsReservationId}): ${out.error} — check out manually in MEWS`,
                source: "hourly-rental",
                roomId: b.roomId,
              });
              done = true; // stop retrying after 24h — flagged for manual action
            }
          }
          if (done) {
            await this.storage.updateHourlyBooking(b.id, { mewsCheckedOutAt: new Date() });
            await this.storage.createLog({
              level: "info",
              message: `Hourly checkout signal: MEWS reservation ${b.mewsReservationId} checked out for ${b.guestName} (interval ended ${new Date(b.endAt).toISOString()})`,
              source: "hourly-rental",
              roomId: b.roomId,
            });
          }
        } catch (err) {
          await this.storage.createLog({
            level: "warn",
            message: `Hourly checkout signal failed for booking ${b.id} — retrying next sweep (${err instanceof Error ? err.message : String(err)})`,
            source: "hourly-rental",
            roomId: b.roomId,
          });
        }
      }
    }
  }

  // ── Follow MEWS resource moves (sweep step 4c) ───────────────────────────

  /**
   * 6/8 incident (Amer/302): staff moved two hourly day-use reservations on
   * the MEWS timeline; the codes stayed on the original capsules, the
   * timeline lied about physical occupancy, and the "occupied" target blocked
   * another hourly booking's MEWS creation for 1h43m. Owner decision:
   * DreamBoks FOLLOWS the move — the booking is reassigned, the code (same
   * digits, hard rule) moves to the new capsule, guest + housekeeping are
   * re-notified. Kill switch: hourly_follow_mews_moves = "false".
   */
  private async followMewsResourceMoves(recent: HourlyBooking[], now: number): Promise<void> {
    if ((await this.storage.getSetting("hourly_follow_mews_moves"))?.value === "false") return;
    const mews = this.engine.getMewsClient?.();
    if (!mews) return;

    const candidates = recent.filter(b =>
      b.status === "confirmed" && !!b.mewsReservationId && !b.mewsCheckedOutAt &&
      new Date(b.endAt).getTime() > now,
    );
    if (candidates.length === 0) return;

    // ONE batched read for the whole pass — getReservations takes an id array.
    let byId: Map<string, MewsResSnapshot>;
    try {
      const reservations = await mews.getReservations(candidates.map(b => b.mewsReservationId!));
      byId = new Map(reservations.map((r: MewsResSnapshot) => [r.Id, r]));
    } catch (err) {
      await this.storage.createLog({
        level: "warn",
        message: `Hourly move-follow: could not read MEWS reservations — retrying next pass (${err instanceof Error ? err.message : String(err)})`,
        source: "hourly-rental",
      });
      return;
    }

    const allRooms = await this.storage.getAllRooms();
    for (const b of candidates) {
      const res = byId.get(b.mewsReservationId!);
      if (!res?.AssignedResourceId) continue;
      // Cancel/checkout flows own the other states.
      if (res.State !== "Confirmed" && res.State !== "Started") continue;
      // Same physical bed (the booked room or its twin) → nothing to follow —
      // except cleaning up a grace move MEWS has since been moved BACK from
      // (the extra code on the abandoned target must not linger).
      const twinPmsIds = new Set(
        twinRoomIds(allRooms, b.roomId)
          .map(id => allRooms.find(r => r.id === id)?.pmsId)
          .filter((x): x is string => !!x),
      );
      if (twinPmsIds.has(res.AssignedResourceId)) {
        try {
          const bookedRoom = allRooms.find(r => r.id === b.roomId) ?? null;
          await this.rollbackGraceEntries(b, () => true, { reason: "MEWS flyttet tilbage", notifyRoom: bookedRoom });
        } catch (err) {
          await this.storage.createLog({
            level: "warn",
            message: `Hourly grace-move cleanup failed for booking ${b.id} — retrying next sweep (${err instanceof Error ? err.message : String(err)})`,
            source: "hourly-rental",
            roomId: b.roomId,
          });
        }
        continue;
      }
      try {
        await this.followMewsResourceMove(b, res, allRooms);
      } catch (err) {
        await this.storage.createLog({
          level: "warn",
          message: `Hourly move-follow failed for booking ${b.id} — retrying next sweep (${err instanceof Error ? err.message : String(err)})`,
          source: "hourly-rental",
          roomId: b.roomId,
        });
      }
    }
  }

  /** Reassign ONE booking to the capsule MEWS now shows, moving the code with it. */
  private async followMewsResourceMove(
    booking: HourlyBooking,
    res: MewsResSnapshot,
    allRooms: Room[],
  ): Promise<void> {
    const newPmsId = res.AssignedResourceId!;
    const oldRoom = allRooms.find(r => r.id === booking.roomId);
    const oldLabel = oldRoom ? getSpaceDisplayName(oldRoom.name, oldRoom.label) : "ukendt capsule";
    const window = `${fmtHmCph(new Date(booking.startAt))}–${fmtHmCph(new Date(booking.endAt))}`;
    const alert = (detail: string) =>
      sendOpsAlert(
        this.storage as any,
        `hourly-mews-move:${booking.id}`,
        "warning",
        `Time-booking: ${booking.guestName} (${window}) er flyttet i MEWS, men koden fulgte IKKE med`,
        `${detail} Gæstens kode åbner stadig Capsule ${oldLabel} — flyt enten reservationen tilbage i MEWS, eller sørg for at gæsten kan bruge ${oldLabel}.`,
      );

    const newRoom = allRooms.find(r => r.pmsId && r.pmsId === newPmsId);
    if (!newRoom) {
      await alert(`MEWS viser en plads (resource ${newPmsId}) som ikke findes i DreamBoks.`);
      return;
    }
    const newLabel = getSpaceDisplayName(newRoom.name, newRoom.label);

    // A guest who has ARRIVED is physically inside the old capsule — the code
    // must never stop opening that door. But refusing the move outright broke
    // the legitimate "capsule not ready, guest re-homed in MEWS" workflow
    // (owner decision 6/8), so an arrived guest's move is GRACE-FOLLOWED
    // instead: same code pushed to the new capsule too, guest notified, and
    // the move completes only when the guest demonstrably unlocks the new
    // door. MEWS "Started", our stamped check-in, or a fresh unlock-record
    // hit all count as arrival. (The unlock scan only runs once the window
    // has opened — before startAt the code cannot have been used.)
    // An existing grace tag is itself proof of arrival (grace only ever starts
    // after arrival) — without this, a regressed arrival signal (staff
    // un-check-in + offline unlock scan) would route a graced booking into the
    // pre-arrival full move, which its own grace tag then blocks forever.
    const graceTagged = ((booking.lockKeyIds as any as LockKeyEntry[]) || []).some(e => e.graceRoomId);
    const arrived =
      graceTagged ||
      res.State === "Started" ||
      !!booking.mewsCheckedInAt ||
      (Date.now() >= new Date(booking.startAt).getTime() - 60_000 && !!(await this.findCodeUsedAt(booking)));
    if (arrived) {
      await this.graceFollowArrivedMove(booking, newRoom, allRooms, {
        oldLabel,
        newLabel,
        windowLabel: window,
        failAlert: alert,
      });
      return;
    }

    await this.moveBookingToRoom(booking, newRoom, {
      oldLabel,
      newLabel,
      alert,
      reasonLabel: "followed MEWS move",
    });
  }

  /**
   * Move a not-yet-arrived booking to `newRoom`: reassign under the physical
   * capsule mutex, move the code (SAME digits — hard rule) off the old room
   * lock onto the new one, then re-notify guest and housekeeping.
   *
   * Shared by the MEWS move-follow (step 4c) and the conflict watch (step 4d);
   * `alert` reports every abort reason to ops in the caller's own wording.
   */
  private async moveBookingToRoom(
    booking: HourlyBooking,
    newRoom: Room,
    opts: { oldLabel: string; newLabel: string; alert: (detail: string) => Promise<unknown>; reasonLabel: string },
  ): Promise<boolean> {
    const { oldLabel, newLabel, alert, reasonLabel } = opts;

    // The new capsule must have a room lock the code can land on.
    const newAssignments = await this.storage.getRoomLockAssignments(newRoom.id);
    if (!newAssignments.some(a => a.lockDevice?.ttlockId && a.lockDevice.lockType === "room")) {
      await alert(`Capsule ${newLabel} har ingen rumlås i DreamBoks.`);
      return false;
    }

    // Target must be free: our own hourly bookings (twin-aware, buffered) AND
    // overnight MEWS occupancy. Full window — the DB exclusion constraint
    // checks the row's whole [startAt, endAt) range on UPDATE too.
    const startAt = new Date(booking.startAt);
    const endAt = new Date(booking.endAt);
    let free = await this.filterFreeOfHourlyBookings([newRoom], startAt, endAt);
    if (free.length > 0) free = await this.filterOutMewsOccupied(free, startAt, endAt);
    if (free.length === 0) {
      await alert(`Capsule ${newLabel} er optaget i tidsrummet (anden booking/reservation).`);
      return false;
    }

    // Reassign under the physical-capsule mutex; the exclusion constraint is
    // the final arbiter against races.
    let conflict = false;
    const moved = await withPhysicalCapsuleLock(`${booking.tenantId}:${physicalRoomKey(newRoom.name)}`, async () => {
      const fresh = await this.storage.getHourlyBooking(booking.id);
      if (!fresh || fresh.status !== "confirmed") return null;
      try {
        return (await this.storage.updateHourlyBooking(booking.id, { roomId: newRoom.id })) ?? null;
      } catch (err) {
        if (isExclusionViolation(err)) { conflict = true; return null; }
        throw err;
      }
    });
    if (!moved) {
      if (conflict) await alert(`Capsule ${newLabel} blev optaget af en anden booking i samme øjeblik.`);
      return false;
    }

    // Move the code: delete it from locks that are NOT assigned to the new
    // room (the old capsule lock — common doors are assigned to both rooms
    // and stay untouched), then push it to the new room's locks.
    const ttlock = this.engine.getTTLockClient();
    const newLockDeviceIds = new Set(newAssignments.map(a => a.lockDevice?.id).filter(Boolean));
    const entries = (moved.lockKeyIds as any as LockKeyEntry[]) || [];
    const kept: LockKeyEntry[] = [];
    const revokeFailed: string[] = [];
    for (const e of entries) {
      if (newLockDeviceIds.has(e.lockDeviceId)) { kept.push(e); continue; }
      const keyId = parseInt(e.keyId, 10);
      try {
        if (!ttlock || !Number.isFinite(keyId)) throw new Error("ingen TTLock-klient eller ukendt keyId");
        await ttlock.deletePasscode(e.ttlockId, keyId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Keep the entry so cancelBooking can still retry the revoke; the
        // firmware expires the code at endAt regardless.
        kept.push(e);
        revokeFailed.push(`${e.lockName}${isLockOfflineError(msg) ? " (offline)" : ""}`);
      }
    }
    let updated = (await this.storage.updateHourlyBooking(moved.id, { lockKeyIds: kept as any })) || moved;

    const push = await this.pushCodeToRoomLocks(updated, newRoom);
    if (push.programmed.length > 0) {
      const mergedKeys = [...((updated.lockKeyIds as any as LockKeyEntry[]) || []), ...push.programmed]
        .filter((e, i, arr) => arr.findIndex(x => x.lockDeviceId === e.lockDeviceId) === i);
      updated = (await this.storage.updateHourlyBooking(moved.id, { lockKeyIds: mergedKeys as any })) || updated;
    }
    // Locks offline right now self-heal via sweep step 3 (re-push missing).

    // Re-notify guest + housekeeping about the NEW capsule (same code).
    await this.deliverCode(updated, newRoom, {
      intro: `UPDATE: Your capsule has changed to Capsule ${newLabel}. Your door code is the same.`,
    });
    await this.sendBookingCleaningSms(updated, newRoom);

    await this.storage.createLog({
      level: "info",
      message: `Hourly booking ${reasonLabel}: ${booking.guestName} ${oldLabel} → ${newLabel} (code ${booking.pinCode} moved; ${push.programmed.length} lock(s) programmed${push.offline.length ? `, ${push.offline.length} offline deferred` : ""}${revokeFailed.length ? `; revoke pending: ${revokeFailed.join(", ")}` : ""})`,
      source: "hourly-rental",
      roomId: newRoom.id,
    });
    return true;
  }

  // ── Conflict watch (sweep step 4d) ───────────────────────────────────────

  /**
   * 19/8-2026 incident (capsule 604): an hourly booking was
   * sold while a walk-in reservation still sat UNASSIGNED in MEWS. 25 minutes
   * later MEWS pinned that reservation to 604s — the twin of the sold capsule
   * — and from that second our own database held the proof that one bed was
   * promised to two guests. Nothing looked.
   *
   * This step looks: every confirmed booking whose window is still open is
   * re-tested against MEWS occupancy (twin-aware). On a collision the booking
   * is moved to a genuinely free capsule with the SAME code (hard rule), and
   * if the house has nothing free, a critical ops alert goes out immediately —
   * hours before the guest stands at the door of an occupied capsule.
   *
   * Kill switch: hourly_conflict_watch = "false".
   */
  private async watchMewsConflicts(recent: HourlyBooking[], now: number): Promise<void> {
    if ((await this.storage.getSetting("hourly_conflict_watch"))?.value === "false") return;
    const active = recent.filter(b => b.status === "confirmed" && new Date(b.endAt).getTime() > now);
    if (active.length === 0) return;

    const allRooms = await this.storage.getAllRooms();
    const reservations = await this.storage.getAllReservations();
    const twinMap = buildTwinMap(allRooms);

    for (const b of active) {
      const room = allRooms.find(r => r.id === b.roomId);
      if (!room) continue;
      const startAt = new Date(b.startAt);
      const endAt = new Date(b.endAt);

      // Twin-aware: the clash may sit on "604s" while we sold "604".
      const twins = new Set(twinMap.get(b.roomId) ?? [b.roomId]);
      const clashes = reservations.filter(
        r => r.roomId && twins.has(r.roomId) && this.reservationOccupies(r, startAt, endAt),
      );
      if (clashes.length === 0) continue;

      const oldLabel = getSpaceDisplayName(room.name, room.label);
      const windowLabel = `${fmtHmCph(startAt)}–${fmtHmCph(endAt)}`;
      const who = clashes
        .map(r => `${[r.firstName, r.lastName].filter(Boolean).join(" ").trim() || "gæst"} (${r.room || "?"}, ${fmtIso(new Date(r.arrival))}→${fmtIso(new Date(r.departure))}, ${r.status})`)
        .join("; ");
      const critical = (detail: string) =>
        sendOpsAlert(
          this.storage as any,
          `hourly-mews-conflict:${b.id}`,
          "critical",
          `Time-booking DOBBELTBOOKET: Capsule ${oldLabel} er også solgt til en overnattende gæst (${b.guestName}, ${windowLabel})`,
          `${detail} Overnattende på samme fysiske kapsel: ${who}. Time-bookingens kode ${b.pinCode} åbner den dør i tidsrummet. Booking-id ${b.id}.`,
        );

      // An arrived hourly guest is physically inside — a move is a human
      // decision at that point, never an automatic one.
      const arrived =
        !!b.mewsCheckedInAt ||
        (Date.now() >= startAt.getTime() - 60_000 && !!(await this.findCodeUsedAt(b)));
      if (arrived) {
        await critical("Time-gæsten er allerede ankommet, så DreamBoks flytter ikke automatisk.");
        continue;
      }

      // Rescue target: any sellable, lock-mapped capsule that is free of both
      // hourly bookings and MEWS occupancy. The unassigned-arrival reserve
      // does NOT apply here — this is not a new sale, it is re-homing a guest
      // who has already paid.
      let targets = await this.filterFreeOfHourlyBookings(await this.getSellableRooms(), startAt, endAt);
      targets = (await this.filterOutMewsOccupied(targets, startAt, endAt)).filter(r => !twins.has(r.id));
      targets = await this.orderCandidatesByPriority(targets, startAt, endAt);

      const target = targets[0];
      if (!target) {
        await critical("Der er INGEN fri kapsel at flytte time-bookingen til.");
        continue;
      }

      const newLabel = getSpaceDisplayName(target.name, target.label);
      const moved = await this.moveBookingToRoom(b, target, {
        oldLabel,
        newLabel,
        alert: (detail: string) => critical(`Automatisk flytning til Capsule ${newLabel} mislykkedes: ${detail}`),
        reasonLabel: "moved off a double-booked capsule (conflict watch)",
      });
      if (moved) {
        // New capsule, new chance for the MEWS block — drop the oversell backoff.
        this.oversoldRetryAt.delete(b.id);
        await sendOpsAlert(
          this.storage as any,
          `hourly-mews-conflict:${b.id}`,
          "warning",
          `Time-booking flyttet automatisk: ${b.guestName} (${windowLabel}) fra Capsule ${oldLabel} til ${newLabel}`,
          `Capsule ${oldLabel} var også solgt til: ${who}. Time-bookingen er flyttet til ${newLabel} med UÆNDRET kode ${b.pinCode}, og gæsten har fået besked.`,
        );
      }
    }
  }

  /**
   * GRACE MOVE (arrived guest moved on the MEWS timeline): push the code to
   * the NEW capsule while it STAYS live on the old one — a sleeping guest can
   * never be locked out, and a guest re-homed by staff (capsule not cleaned
   * etc.) can walk straight to the new door with the same code.
   * booking.roomId keeps blocking the old capsule; the graceRoomId tag blocks
   * the new one. The move completes (roomId flips, old room-lock code
   * revoked) only when the guest demonstrably unlocks the new capsule's ROOM
   * lock AFTER the grace push; if MEWS is moved back instead, the caller's
   * moved-back branch rolls the extra code back (guarded by the same
   * unlock-record probe, so a guest who already switched is never revoked).
   */
  private async graceFollowArrivedMove(
    booking: HourlyBooking,
    newRoom: Room,
    allRooms: Room[],
    opts: {
      oldLabel: string;
      newLabel: string;
      windowLabel: string;
      failAlert: (detail: string) => Promise<unknown>;
    },
  ): Promise<void> {
    const { oldLabel, newLabel, windowLabel, failAlert } = opts;
    const graceAlert = (detail: string) =>
      sendOpsAlert(
        this.storage as any,
        `hourly-mews-move:${booking.id}`,
        "warning",
        `Time-booking: ${booking.guestName} (${windowLabel}) er flyttet i MEWS efter ankomst — koden virker nu på både ${oldLabel} og ${newLabel}`,
        detail,
      );
    const entriesOf = (b: HourlyBooking) => (b.lockKeyIds as any as LockKeyEntry[]) || [];

    // Work from a FRESH row — the sweep snapshot may be minutes old, and
    // step 3 of the same pass may have merged lock entries we must not lose.
    let current = await this.storage.getHourlyBooking(booking.id);
    if (!current || current.status !== "confirmed") return;

    // Grace entries pointing at a room that is no longer the MEWS target
    // (moved again mid-grace) are rolled back first — guest re-notified that
    // their capsule is the booked one again (the follow-up "changed to <new>"
    // SMS below then supersedes it if the new push lands). null = rollback
    // refused (guest already took that capsule into use, or unlock records
    // unreadable); nothing more to do this pass — pushing yet another capsule
    // would compound the mess.
    const targetTwinIds = new Set(twinRoomIds(allRooms, newRoom.id));
    const bookedRoom = allRooms.find(r => r.id === current!.roomId) ?? null;
    const afterCleanup = await this.rollbackGraceEntries(
      current,
      e => !targetTwinIds.has(e.graceRoomId!),
      { reason: "MEWS-mål ændret", notifyRoom: bookedRoom },
    );
    if (!afterCleanup) return;
    current = afterCleanup;

    const newAssignments = await this.storage.getRoomLockAssignments(newRoom.id);
    const targetRoomLockIds = new Set(
      newAssignments
        .filter(a => a.lockDevice?.ttlockId && a.lockDevice.lockType === "room")
        .map(a => a.lockDevice!.id),
    );
    if (targetRoomLockIds.size === 0) {
      await failAlert(`Capsule ${newLabel} har ingen rumlås i DreamBoks.`);
      return;
    }

    const graceActive = entriesOf(current).some(e => e.graceRoomId && targetTwinIds.has(e.graceRoomId));
    if (!graceActive) {
      // Fresh grace push — free-check + TTLock push + tag persist all under
      // the target capsule's mutex, so a concurrent sale of the target can't
      // interleave between check and tag (the tag is what availability sees).
      const startAt = new Date(current.startAt);
      const endAt = new Date(current.endAt);
      const outcome = await withPhysicalCapsuleLock(`${current.tenantId}:${physicalRoomKey(newRoom.name)}`, async () => {
        const fresh = await this.storage.getHourlyBooking(current!.id);
        if (!fresh || fresh.status !== "confirmed") return null;
        let free = await this.filterFreeOfHourlyBookings([newRoom], startAt, endAt);
        if (free.length > 0) free = await this.filterOutMewsOccupied(free, startAt, endAt);
        if (free.length === 0) return { occupied: true as const };
        const push = await this.pushCodeToRoomLocks(fresh, newRoom);
        if (push.programmed.length === 0) return { occupied: false as const, updated: fresh, push };
        const graceSince = new Date().toISOString();
        const tagged = push.programmed.map(e => ({ ...e, graceRoomId: newRoom.id, graceSince }));
        const merged = [...entriesOf(fresh), ...tagged]
          .filter((e, i, arr) => arr.findIndex(x => x.lockDeviceId === e.lockDeviceId) === i);
        const updated = (await this.storage.updateHourlyBooking(fresh.id, { lockKeyIds: merged as any })) || fresh;
        return { occupied: false as const, updated, push };
      });
      if (!outcome) return;
      if (outcome.occupied) {
        await failAlert(`Capsule ${newLabel} er optaget i tidsrummet (anden booking/reservation).`);
        return;
      }
      current = outcome.updated;
      if (outcome.push.programmed.length === 0) {
        // Nothing landed → no tag persisted → the target is NOT availability-
        // blocked, so retrying outside the mutex could race a concurrent
        // sale. Alert and let the next pass re-run the full guarded push.
        await failAlert(
          `Koden kunne ikke lægges på Capsule ${newLabel}s rumlås endnu (${outcome.push.offline.length > 0 ? "lås offline" : outcome.push.errors.join("; ") || "ukendt fejl"}) — prøver igen automatisk. Gæsten har IKKE fået besked om flytningen.`,
        );
        return;
      }
    }

    // The guest may only be told "go to the new capsule" once its ROOM lock
    // actually carries the code — a partial push (room lock failed, floor
    // door succeeded) must never SMS the guest to a dead door. Missing locks
    // are re-pushed every pass until they land; safe outside the mutex ONLY
    // because a persisted grace tag already blocks the target in availability.
    let covered = entriesOf(current).some(e => targetRoomLockIds.has(e.lockDeviceId));
    if (!covered && graceActive) {
      const retry = await this.pushCodeToRoomLocks(current, newRoom);
      if (retry.programmed.length > 0) {
        const graceSince = new Date().toISOString();
        const tagged = retry.programmed.map(e => ({ ...e, graceRoomId: newRoom.id, graceSince }));
        const fresh = await this.storage.getHourlyBooking(current.id);
        if (!fresh || fresh.status !== "confirmed") return;
        const merged = [...entriesOf(fresh), ...tagged]
          .filter((e, i, arr) => arr.findIndex(x => x.lockDeviceId === e.lockDeviceId) === i);
        current = (await this.storage.updateHourlyBooking(current.id, { lockKeyIds: merged as any })) || current;
        covered = entriesOf(current).some(e => targetRoomLockIds.has(e.lockDeviceId));
      }
    }
    if (!covered) {
      await failAlert(
        `Koden kunne ikke lægges på Capsule ${newLabel}s rumlås endnu (lås offline eller fejl) — prøver igen automatisk. Gæsten har IKKE fået besked om flytningen.`,
      );
      return;
    }

    const graceEntries = entriesOf(current).filter(e => e.graceRoomId && targetTwinIds.has(e.graceRoomId));

    // Notify guest + housekeeping exactly once (graceNotifiedAt marker); a
    // failed SMS retries next pass.
    if (!graceEntries.some(e => e.graceNotifiedAt)) {
      const delivered = await this.deliverCode(current, newRoom, {
        intro: `UPDATE: Your capsule has changed to Capsule ${newLabel}. Your door code is the same.`,
      });
      await this.sendBookingCleaningSms(current, newRoom);
      if (delivered) {
        const fresh = await this.storage.getHourlyBooking(current.id);
        if (fresh && fresh.status === "confirmed") {
          const stampedAt = new Date().toISOString();
          const stamped = entriesOf(fresh).map(e =>
            e.graceRoomId && targetTwinIds.has(e.graceRoomId) ? { ...e, graceNotifiedAt: stampedAt } : e,
          );
          current = (await this.storage.updateHourlyBooking(current.id, { lockKeyIds: stamped as any })) || current;
        }
      }
      await graceAlert(
        `Gæsten er ankommet, så koden er IKKE fjernet fra Capsule ${oldLabel} (en gæst må aldrig låses ude af sin kapsel). Samme kode virker nu OGSÅ på Capsule ${newLabel}, og gæsten har fået besked. Flytningen fuldføres automatisk, når gæsten bruger den nye dør — var flytningen en fejl, så flyt blot reservationen tilbage i MEWS.`,
      );
      await this.storage.createLog({
        level: "info",
        message: `Hourly grace move: ${booking.guestName} moved ${oldLabel} → ${newLabel} in MEWS after arrival — code ${booking.pinCode} live on BOTH capsules until the guest uses the new door`,
        source: "hourly-rental",
        roomId: newRoom.id,
      });
      return; // fresh grace — a qualifying unlock cannot exist yet
    }

    // Grace active — complete once the guest has used the new capsule's ROOM
    // lock (common doors prove nothing about which bed they chose). "unknown"
    // (unreadable records) just waits — completing on guesswork could revoke
    // the door the guest is behind.
    const probeEntries = graceEntries.filter(e => targetRoomLockIds.has(e.lockDeviceId));
    if ((await this.codeUsedOnLocks(current, probeEntries)) !== "used") {
      await graceAlert(
        `Venter på at gæsten bruger Capsule ${newLabel} — koden virker fortsat på begge kapsler. Var flytningen en fejl, så flyt reservationen tilbage i MEWS.`,
      );
      return;
    }

    const oldRoomId = current.roomId;
    let conflict = false;
    const moved = await withPhysicalCapsuleLock(`${current.tenantId}:${physicalRoomKey(newRoom.name)}`, async () => {
      const fresh = await this.storage.getHourlyBooking(current!.id);
      if (!fresh || fresh.status !== "confirmed") return null;
      try {
        return (await this.storage.updateHourlyBooking(current!.id, { roomId: newRoom.id })) ?? null;
      } catch (err) {
        if (isExclusionViolation(err)) { conflict = true; return null; }
        throw err;
      }
    });
    if (!moved) {
      if (conflict) await failAlert(`Capsule ${newLabel} blev optaget af en anden booking i samme øjeblik.`);
      return;
    }

    // Revoke the old capsule's room-lock code (common doors are assigned to
    // the new room too and stay untouched); drop the grace tags. A FAILED
    // revoke is re-tagged onto the OLD room with revokePending so the old
    // capsule stays blocked in availability and every later sweep retries the
    // delete unconditionally (rollbackGraceEntries skips its guard for
    // revokePending). Housekeeping for both capsules was already notified at
    // creation (old) and at the grace push (new).
    const ttlock = this.engine.getTTLockClient();
    const newLockDeviceIds = new Set(newAssignments.map(a => a.lockDevice?.id).filter(Boolean));
    const entries = entriesOf(moved);
    const kept: LockKeyEntry[] = [];
    const revokeFailed: string[] = [];
    for (const e of entries) {
      if (newLockDeviceIds.has(e.lockDeviceId)) {
        kept.push(e.graceRoomId ? { ...e, graceRoomId: undefined, graceSince: undefined, graceNotifiedAt: undefined } : e);
        continue;
      }
      const keyId = parseInt(e.keyId, 10);
      try {
        if (!ttlock || !Number.isFinite(keyId)) throw new Error("ingen TTLock-klient eller ukendt keyId");
        await ttlock.deletePasscode(e.ttlockId, keyId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        kept.push({ ...e, graceRoomId: oldRoomId, revokePending: true });
        revokeFailed.push(`${e.lockName}${isLockOfflineError(msg) ? " (offline)" : ""}`);
      }
    }
    await this.storage.updateHourlyBooking(moved.id, { lockKeyIds: kept as any });

    await this.storage.createLog({
      level: revokeFailed.length ? "warn" : "info",
      message: `Hourly grace move COMPLETED: ${booking.guestName} used Capsule ${newLabel} — booking moved ${oldLabel} → ${newLabel}, code revoked on ${oldLabel}${revokeFailed.length ? ` (revoke pending, retried every sweep: ${revokeFailed.join(", ")})` : ""}`,
      source: "hourly-rental",
      roomId: newRoom.id,
    });
  }

  /**
   * Roll back grace-tagged codes matching the predicate and persist the
   * trimmed lockKeyIds (always from a fresh DB row — never the sweep
   * snapshot). GUARD: if the guest has already unlocked a matched grace
   * capsule, nothing is revoked — an ops alert asks staff to resolve it
   * (returns null). revokePending entries (failed revokes of an already
   * completed move) skip the guard and are deleted unconditionally. A failed
   * delete keeps its entry — and thereby its availability block, because the
   * code still opens that door — for the next sweep; the firmware expires
   * the code at endAt regardless. When a notified guest's grace capsule is
   * rolled back, the guest is told their capsule is the original one again.
   */
  private async rollbackGraceEntries(
    booking: HourlyBooking,
    match: (e: LockKeyEntry) => boolean,
    opts: { reason: string; notifyRoom: Room | null },
  ): Promise<HourlyBooking | null> {
    const fresh = await this.storage.getHourlyBooking(booking.id);
    if (!fresh || fresh.status !== "confirmed") return fresh ?? booking;
    const entries = (fresh.lockKeyIds as any as LockKeyEntry[]) || [];
    const targets = entries.filter(e => e.graceRoomId && match(e));
    if (targets.length === 0) return fresh;

    const guarded = targets.filter(e => !e.revokePending);
    const probe = guarded.length > 0 ? await this.codeUsedOnLocks(fresh, guarded) : "unused";
    if (probe === "used") {
      await sendOpsAlert(
        this.storage as any,
        `hourly-mews-move:${fresh.id}`,
        "warning",
        `Time-booking: ${fresh.guestName} — MEWS-flytning kan IKKE rulles tilbage: gæsten har taget den nye kapsel i brug`,
        `Koden er ikke fjernet nogen steder (${opts.reason}). Flyt reservationen i MEWS til den kapsel, gæsten faktisk bruger (${guarded.map(e => e.lockName).join(", ")}), eller kontakt gæsten.`,
      );
      return null;
    }
    if (probe === "unknown") {
      // Unlock records unreadable (offline gateway etc.) — we cannot rule out
      // that the guest already switched capsules, so revoking now could lock
      // them out. Defer; the next sweep retries, and the firmware expires the
      // code at endAt regardless.
      await sendOpsAlert(
        this.storage as any,
        `hourly-mews-move:${fresh.id}`,
        "warning",
        `Time-booking: ${fresh.guestName} — MEWS-flytning: oprydning udskudt (kan ikke aflæse oplåsningslog)`,
        `Det kan ikke afgøres, om gæsten allerede har taget den nye kapsel i brug (${opts.reason}). Intet er ændret — der prøves igen automatisk.`,
      );
      return null;
    }

    const ttlock = this.engine.getTTLockClient();
    const targetIds = new Set(targets.map(e => e.lockDeviceId));
    const kept = entries.filter(e => !targetIds.has(e.lockDeviceId));
    const revoked: LockKeyEntry[] = [];
    for (const e of targets) {
      const keyId = parseInt(e.keyId, 10);
      try {
        if (!ttlock || !Number.isFinite(keyId)) throw new Error("ingen TTLock-klient eller ukendt keyId");
        await ttlock.deletePasscode(e.ttlockId, keyId);
        revoked.push(e);
      } catch {
        kept.push(e);
      }
    }
    const updated = (await this.storage.updateHourlyBooking(fresh.id, { lockKeyIds: kept as any })) || fresh;
    if (revoked.length > 0) {
      if (opts.notifyRoom && revoked.some(e => e.graceNotifiedAt)) {
        const label = getSpaceDisplayName(opts.notifyRoom.name, opts.notifyRoom.label);
        await this.deliverCode(updated, opts.notifyRoom, {
          intro: `UPDATE: Your capsule is Capsule ${label} again. Your door code is the same.`,
        });
      }
      await this.storage.createLog({
        level: "info",
        message: `Hourly grace move rolled back (${opts.reason}): code removed from ${revoked.map(e => e.lockName).join(", ")} for ${fresh.guestName}`,
        source: "hourly-rental",
        roomId: fresh.roomId,
      });
    }
    return updated;
  }

  /**
   * Has the booking's code been used on any of the given locks — counting
   * only unlocks AFTER each entry's graceSince? The guest's ORIGINAL arrival
   * records on a re-graced lock must never look like "guest took the new
   * capsule" (that would revoke the door the guest is physically behind).
   * Tri-state: "unknown" (records unreadable) lets callers fail SAFE in both
   * directions — completion waits, rollback defers.
   */
  private async codeUsedOnLocks(
    booking: HourlyBooking,
    entries: LockKeyEntry[],
  ): Promise<"used" | "unused" | "unknown"> {
    const ttlock = this.engine.getTTLockClient?.();
    if (!booking.pinCode || !ttlock) return "unknown";
    const startMs = new Date(booking.startAt).getTime() - 30 * 60 * 1000;
    let unreadable = false;
    for (const e of entries) {
      if (!e.ttlockId) continue;
      // graceSince alone bounds grace entries (the push can precede startAt —
      // arrival is what gates grace, not the window); untagged entries fall
      // back to the arrival-scan bound.
      const sinceMs = e.graceSince ? new Date(e.graceSince).getTime() : startMs;
      try {
        const records = await ttlock.getUnlockRecords(e.ttlockId, { startDate: sinceMs });
        if (records.some((r: any) =>
          r.success && r.keyboardPwd === booking.pinCode && new Date(r.lockDate).getTime() >= sinceMs,
        )) return "used";
      } catch {
        unreadable = true; // offline lock etc. — this lock's state is UNKNOWN
      }
    }
    return unreadable ? "unknown" : "unused";
  }

  /**
   * Was the booking's code actually used? Scans TTLock unlock records on every
   * lock the code was pushed to (room lock and common doors alike — entering
   * the building counts as arrival). keyboardPwd equality implies keypad use;
   * recordType varies by firmware (1 vs 4) and is deliberately not filtered.
   */
  private async findCodeUsedAt(booking: HourlyBooking): Promise<Date | null> {
    const ttlock = this.engine.getTTLockClient?.();
    if (!booking.pinCode || !ttlock) return null;
    const startMs = new Date(booking.startAt).getTime();
    for (const k of (booking.lockKeyIds as any as LockKeyEntry[]) || []) {
      if (!k.ttlockId) continue;
      try {
        const records = await ttlock.getUnlockRecords(k.ttlockId, {
          startDate: startMs - 30 * 60 * 1000,
        });
        const hit = records.find(r => r.success && r.keyboardPwd === booking.pinCode);
        if (hit) return hit.lockDate;
      } catch { /* offline lock etc. — try the next lock, retry next sweep */ }
    }
    return null;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private validateWindow(startAt: Date, endAt: Date): void {
    if (!(startAt instanceof Date) || isNaN(startAt.getTime())) throw new Error("Ugyldig starttid");
    if (!(endAt instanceof Date) || isNaN(endAt.getTime())) throw new Error("Ugyldig sluttid");
    if (endAt.getTime() <= startAt.getTime()) throw new Error("Sluttid skal være efter starttid");
    if (startAt.getTime() < Date.now() - PAST_START_GRACE_MS) throw new Error("Starttid er i fortiden");
  }

  private async assertMaxDuration(startAt: Date, endAt: Date): Promise<void> {
    const maxHours = parseInt((await this.storage.getSetting("hourly_max_hours"))?.value || String(MAX_DURATION_HOURS_DEFAULT), 10) || MAX_DURATION_HOURS_DEFAULT;
    const hours = (endAt.getTime() - startAt.getTime()) / 3_600_000;
    if (hours > maxHours) throw new Error(`Maks. varighed er ${maxHours} timer`);
  }

  /**
   * A code no other guest (nightly or hourly) may collide with. Collisions are
   * dangerous beyond confusion: a duplicate code on a shared front door makes
   * TTLock return -3007 and the flows would then share (and later delete!)
   * each other's keyIds. So we exclude: pins in any live state INCLUDING
   * delete_failed (still physically on a lock), every non-cancelled
   * reservation's generatedPin (held for re-push even when no pin row exists),
   * and all blocking hourly bookings.
   */
  private async generateUniqueCode(): Promise<string> {
    const pinLifecycle = this.engine.getPinLifecycle();
    const inUse = new Set<string>();

    const allPins = await this.storage.getAllPins();
    for (const p of allPins) {
      if (p.status === "pending" || p.status === "active" || p.status === "used" || p.status === "delete_failed") {
        inUse.add(p.code);
      }
    }

    const allReservations = await this.storage.getAllReservations();
    for (const r of allReservations) {
      const status = (r.status || "").toLowerCase();
      if (r.generatedPin && status !== "cancelled" && status !== "no-show") inUse.add(r.generatedPin);
    }

    const activeHourly = await this.storage.getHourlyBookingsOverlapping(
      new Date(Date.now() - 24 * 3_600_000),
      new Date(Date.now() + 365 * 24 * 3_600_000),
      BLOCKING_STATUSES,
    );
    for (const b of activeHourly) if (b.pinCode) inUse.add(b.pinCode);

    for (let i = 0; i < 100; i++) {
      const code = pinLifecycle.generateSafePasscode();
      if (!inUse.has(code)) return code;
    }
    throw new Error("Kunne ikke generere en unik kode");
  }

  /**
   * Does this reservation physically occupy a capsule during [startAt, endAt)?
   * Status + effective-window test ONLY — the capsule identity is the caller's
   * business, so an UNASSIGNED reservation (no roomId yet) answers true too.
   * That is the whole point: it occupies *some* capsule, we just don't know
   * which one until MEWS assigns it (see countUnassignedOccupancy).
   */
  private reservationOccupies(
    r: { status?: string | null; arrival: Date | string; departure: Date | string; lateCheckoutUntil?: Date | string | null; earlyCheckinFrom?: Date | string | null },
    startAt: Date,
    endAt: Date,
  ): boolean {
    const rStatus = (r.status || "").toLowerCase();
    // A paid late checkout survives MEWS's ~11:00 bulk auto-checkout as
    // status "Checked-out" with lateCheckoutUntil set — that guest still
    // physically occupies the capsule and must block hourly sales.
    const lateCheckoutOccupies = rStatus === "checked-out" && hasActiveLateCheckout(r as any);
    if (!BLOCKING_RESERVATION_STATUSES.has(rStatus) && !lateCheckoutOccupies) return false;
    // A paid late checkout keeps the capsule occupied past the raw departure —
    // without this, an hourly booking could be sold into a capsule the
    // departing guest paid to keep until e.g. 14:00.
    const effectiveEnd = Math.max(
      new Date(r.departure).getTime(),
      r.lateCheckoutUntil ? new Date(r.lateCheckoutUntil).getTime() : 0,
    );
    // …and a paid EARLY check-in starts occupancy before the raw arrival
    // (symmetric with the lateCheckoutUntil handling above).
    const effectiveStart = Math.min(
      new Date(r.arrival).getTime(),
      r.earlyCheckinFrom ? new Date(r.earlyCheckinFrom).getTime() : Number.POSITIVE_INFINITY,
    );
    return effectiveStart < endAt.getTime() && effectiveEnd > startAt.getTime();
  }

  /**
   * Human-error guard: pool capsules must be carved out of MEWS, but if a live
   * MEWS reservation nevertheless occupies one in the window, drop that
   * capsule from the candidates rather than double-occupy it.
   */
  private async filterOutMewsOccupied(rooms: Room[], startAt: Date, endAt: Date): Promise<Room[]> {
    const idSet = new Set(rooms.map(r => r.id));
    const all = await this.storage.getAllReservations();
    // Twin spaces: a guest in "401" occupies "401s" too (same bed).
    const twinMap = buildTwinMap(await this.storage.getAllRooms());
    const occupied = new Set(
      all
        .filter(r => {
          if (!r.roomId) return false;
          // Count the reservation when ANY of its twin spaces is a candidate.
          const twins = twinMap.get(r.roomId) ?? [r.roomId];
          if (!twins.some(id => idSet.has(id))) return false;
          return this.reservationOccupies(r, startAt, endAt);
        })
        .flatMap(r => twinMap.get(r.roomId as string) ?? [r.roomId as string]),
    );
    return rooms.filter(r => !occupied.has(r.id));
  }

  /**
   * How many reservations occupy the window WITHOUT an assigned capsule?
   *
   * Root cause of the 19/8-2026 oversell (capsule 604): a
   * walk-in reservation created at 14:07 sat unassigned until MEWS pinned it to
   * 604s at 16:04 — the twin of the capsule we sold at 15:39. An unassigned
   * arrival is invisible to filterOutMewsOccupied (it has no roomId to match),
   * so with one free capsule left the sale looked fine and MEWS then refused
   * the blocking reservation with "no availability" 12 times in a row.
   *
   * Each such reservation claims ONE physical capsule the house cannot sell by
   * the hour. Callers keep that many capsules in reserve. Kill switch:
   * hourly_unassigned_reserve = "false" (only that exact value disables it).
   */
  private async countUnassignedOccupancy(startAt: Date, endAt: Date): Promise<number> {
    if ((await this.storage.getSetting("hourly_unassigned_reserve"))?.value === "false") return 0;
    const all = await this.storage.getAllReservations();
    return all.filter(r => !r.roomId && this.reservationOccupies(r, startAt, endAt)).length;
  }

  /**
   * Physical capsules among `candidates` MINUS the ones unassigned arrivals
   * will need. Twins count once. Zero (or less) means the house is full even
   * though individual capsules still look free — do not sell.
   */
  private async countHouseSellable(candidates: Room[], startAt: Date, endAt: Date): Promise<{ free: number; reserved: number }> {
    const free = new Set(candidates.map(r => physicalRoomKey(r.name))).size;
    const reserved = await this.countUnassignedOccupancy(startAt, endAt);
    return { free, reserved };
  }

  /**
   * Push the booking's code to the room lock + common doors with the exact
   * booked window (60s early-start grace for book-now walk-ins). Per-lock
   * failures never abort the loop; offline locks are reported separately.
   */
  private async pushCodeToRoomLocks(
    booking: HourlyBooking,
    room: Room,
  ): Promise<{ programmed: LockKeyEntry[]; offline: string[]; errors: string[] }> {
    const ttlockClient = this.engine.getTTLockClient();
    if (!ttlockClient) return { programmed: [], offline: [], errors: ["TTLock-klient ikke initialiseret"] };

    const assignments = await this.storage.getRoomLockAssignments(room.id);
    const locks = assignments
      .map(a => a.lockDevice)
      .filter((ld): ld is LockDevice & { ttlockId: string } => !!ld?.ttlockId);
    if (locks.length === 0) return { programmed: [], offline: [], errors: ["Ingen låse tilknyttet capsulen"] };

    const already = new Set(((booking.lockKeyIds as any as LockKeyEntry[]) || []).map(e => e.lockDeviceId));
    const startDate = new Date(new Date(booking.startAt).getTime() - 60 * 1000);
    const endDate = new Date(booking.endAt);
    const shortName = booking.guestName.length > 20 ? booking.guestName.substring(0, 20) : booking.guestName;

    const programmed: LockKeyEntry[] = [];
    const offline: string[] = [];
    const errors: string[] = [];

    for (const lock of locks) {
      if (already.has(lock.id)) continue;
      try {
        const version = await this.getKeyboardPwdVersion(lock);
        if (!version) { errors.push(`${lock.name}: keyboardPwdVersion utilgængelig`); continue; }
        const result = await ttlockClient.addPasscode(lock.ttlockId, booking.pinCode!, shortName, {
          startDate,
          endDate,
          keyboardPwdVersion: version,
        });
        programmed.push({ lockDeviceId: lock.id, ttlockId: lock.ttlockId, keyId: result.id.toString(), lockName: lock.name });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isLockOfflineError(msg)) {
          offline.push(lock.name);
          await this.storage.createLog({
            level: "warn",
            message: `Hourly code push deferred on ${lock.name} — lock offline; sweep retries when it reconnects`,
            source: "hourly-rental",
            roomId: room.id,
          });
        } else if (msg.includes("-3007")) {
          // Same code already on the lock (e.g. sweep retry after a partial
          // push) — resolve the existing keyId and treat as programmed.
          let keyId = "existing";
          try {
            const existing = await ttlockClient.listPasscodes(lock.ttlockId);
            const match = existing.find((p: any) => p.code === booking.pinCode);
            if (match) keyId = match.id.toString();
          } catch { /* keep sentinel */ }
          programmed.push({ lockDeviceId: lock.id, ttlockId: lock.ttlockId, keyId, lockName: lock.name });
        } else {
          errors.push(`${lock.name}: ${msg}`);
          await this.storage.createLog({
            level: "error",
            message: `Hourly code push failed on ${lock.name}: ${msg}`,
            source: "hourly-rental",
            roomId: room.id,
          });
        }
      }
    }
    return { programmed, offline, errors };
  }

  private async getKeyboardPwdVersion(lock: LockDevice & { ttlockId: string }): Promise<number | null> {
    if (lock.keyboardPwdVersion != null) return lock.keyboardPwdVersion;
    const ttlockClient = this.engine.getTTLockClient();
    if (!ttlockClient) return null;
    try {
      const details = await ttlockClient.getLockStatus(lock.ttlockId);
      if (!details?.keyboardPwdVersion) return null;
      await this.storage.updateLockDevice(lock.id, { keyboardPwdVersion: details.keyboardPwdVersion });
      return details.keyboardPwdVersion;
    } catch {
      return null;
    }
  }

  /** Same compact 3-line message shape as the Capsule door-code flow. */
  private async buildMessage(booking: HourlyBooking, room: Room): Promise<{ subject: string; body: string }> {
    const [tzSetting, hotelNameSetting, addressSetting] = await Promise.all([
      this.storage.getSetting("property_timezone"),
      this.storage.getSetting("hotel_name"),
      this.storage.getSetting("hotel_address"),
    ]);
    const tz = tzSetting?.value || "Europe/Copenhagen";
    const hotelName = hotelNameSetting?.value || "the hotel";
    const fmt = (d: Date) => DateTime.fromJSDate(d).setZone(tz).toFormat("d LLLL yyyy HH:mm");

    const displayName = getSpaceDisplayName(room.name, room.label);
    const lines = [
      `Door code for Capsule ${displayName}: ${booking.pinCode}#`,
      `Valid ${fmt(new Date(booking.startAt))} - ${fmt(new Date(booking.endAt))}`,
    ];
    if (addressSetting?.value) lines.push(addressSetting.value);
    return { subject: `Important: Door Code to enter ${hotelName}`, body: lines.join("\n") };
  }

  // One-shot payment reminder for a pending hold (see sweep step 1). Marked
  // BEFORE sending so a crash mid-send can never turn into a reminder storm.
  private static readonly HOLD_REMINDER_AFTER_MS = 10 * 60 * 1000;

  private async sendHoldPaymentReminder(booking: HourlyBooking, paymentUrl: string, holdMinutes: number): Promise<void> {
    if (!booking.guestPhone && !booking.guestEmail) return;
    await this.storage.updateHourlyBooking(booking.id, { paymentReminderAt: new Date() });

    const minutesLeft = Math.max(
      1,
      Math.round(holdMinutes - (Date.now() - new Date(booking.createdAt).getTime()) / 60000),
    );
    const room = await this.storage.getRoom(booking.roomId);
    const label = room ? getSpaceDisplayName(room.name, room.label) : "your capsule";
    const hotelName = (await this.storage.getSetting("hotel_name"))?.value || "the hotel";
    const body = [
      `Hi ${booking.guestName.split(/\s+/)[0]}! Your capsule ${label} at ${hotelName} is still reserved for you,`,
      `but we have not received your payment yet. Complete it within ${minutesLeft} min to keep the booking:`,
      paymentUrl,
    ].join(" ");

    // Test override mirrors deliverCode: test mode must never text real guests.
    const [testEmail, testPhone] = await Promise.all([
      this.storage.getSetting("boarding_test_email"),
      this.storage.getSetting("boarding_test_phone"),
    ]);
    const phone = normalizeSmsRecipient(testPhone?.value || booking.guestPhone);
    const email = testEmail?.value || booking.guestEmail || undefined;
    const notifClient = await createNotificationClient(this.storage);
    let delivered = false;
    if (phone) {
      const r = await notifClient.sendPlainSMS({ to: phone, body });
      delivered = r.success;
    }
    if (!delivered && email) {
      const r = await notifClient.sendPlainTextEmail({ to: email, subject: `Complete your payment — ${hotelName}`, text: body });
      delivered = r.success;
    }
    await this.storage.createLog({
      level: delivered ? "info" : "warn",
      message: `Hourly hold reminder ${delivered ? "sent" : "could NOT be delivered"} for ${booking.guestName} (${label}) — ${minutesLeft} min left on the hold`,
      source: "hourly-rental",
      roomId: booking.roomId,
    });
  }

  private async deliverCode(
    booking: HourlyBooking,
    room: Room,
    opts: { intro?: string } = {},
  ): Promise<boolean> {
    const [testEmail, testPhone] = await Promise.all([
      this.storage.getSetting("boarding_test_email"),
      this.storage.getSetting("boarding_test_phone"),
    ]);
    const recipientEmail = testEmail?.value || booking.guestEmail || undefined;
    const recipientPhone = normalizeSmsRecipient(testPhone?.value || booking.guestPhone);
    if (!recipientEmail && !recipientPhone) return false;

    const message = await this.buildMessage(booking, room);
    if (opts.intro) message.body = `${opts.intro}\n${message.body}`;
    const notifClient = await createNotificationClient(this.storage);
    let delivered = false;

    if (recipientEmail) {
      const r = await notifClient.sendPlainTextEmail({ to: recipientEmail, subject: message.subject, text: message.body });
      if (r.success) delivered = true;
      else await this.storage.createLog({ level: "warn", message: `Hourly code email failed: ${r.error}`, source: "hourly-rental", roomId: booking.roomId });
    }
    if (recipientPhone) {
      const r = await notifClient.sendPlainSMS({ to: recipientPhone, body: message.body });
      if (r.success) delivered = true;
      else await this.storage.createLog({ level: "warn", message: `Hourly code SMS failed: ${r.error}`, source: "hourly-rental", roomId: booking.roomId });
    }
    return delivered;
  }
}

/** Half-open interval overlap: [aStart,aEnd) ∩ [bStart,bEnd) ≠ ∅ */
export function windowsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Postgres 23P01 exclusion_violation (hourly_bookings_no_overlap lost the race). */
export function isExclusionViolation(err: unknown): boolean {
  const code = (err as any)?.code;
  if (code === "23P01") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("hourly_bookings_no_overlap") || msg.includes("exclusion constraint");
}

function fmtIso(d: Date): string {
  return DateTime.fromJSDate(d).toFormat("yyyy-MM-dd HH:mm");
}

function fmtHmCph(d: Date): string {
  return DateTime.fromJSDate(d).setZone("Europe/Copenhagen").toFormat("d/M HH:mm");
}

/**
 * Twilio rejects international numbers written with the 00-prefix as 21211
 * ("0046762500147" from the kiosk keypad, 6/8) — rewrite to +CC… and strip
 * separators. Already-valid +numbers and short local forms pass through.
 */
export function normalizeSmsRecipient(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const p = raw.replace(/[\s\-().]/g, "");
  if (!p) return undefined;
  if (/^00\d{6,}$/.test(p)) return `+${p.slice(2)}`;
  return p;
}
