/**
 * Admin inventory overview: per capsule, which time intervals are FREE for
 * hourly rentals on a given date.
 *
 * Priority model (user decision 21/7): 1) normal overnight stays incl.
 * purchased early check-in / late check-out extensions own the capsule,
 * 2) hourly rentals fill the gaps. The 10:00–15:00 turnover window is
 * hourly-bookable whenever no extension has claimed it.
 *
 * Truth source: reservations occupy their EFFECTIVE window from
 * buildValidityWindow (the operational truth that governs when door codes
 * start/stop — folds purchased earlyCheckinFrom/lateCheckoutUntil). Note the
 * SALE path (filterOutMewsOccupied) uses raw MEWS timestamps with the same
 * folds; if raw timestamps ever disagree with normalized times the two can
 * differ at the edges — deliberate, do not "fix" by touching the sale path.
 */

import { DateTime } from "luxon";
import type { ITenantStorage } from "./storage";
import type { MewsClient } from "./mews-client";
import {
  buildValidityWindow,
  LATE_CHECKOUT_MAX_EXTENSION_MS,
  EARLY_CHECKIN_MAX_ADVANCE_MS,
} from "./pin-validity-window";
import { getSpaceDisplayName } from "@shared/display-name";
import { physicalRoomKey } from "./room-pairing";

export type OccupancyCause = "guest" | "hourly" | "hourly-pending" | "block";

export interface DayInterval {
  from: string; // ISO
  to: string; // ISO
}

export interface OccupiedInterval extends DayInterval {
  cause: OccupancyCause;
  label?: string; // e.g. guest name-less descriptor or block type
}

export interface DayAvailabilityRow {
  roomId: string;
  /** All space ids of the physical capsule (twins included). */
  roomIds: string[];
  label: string;
  hourlyPool: boolean;
  free: DayInterval[];
  occupied: OccupiedInterval[];
  /** MEWS housekeeping state for the physical capsule: Dirty | Clean | Inspected | OutOfService | OutOfOrder. Null when unknown. */
  state: string | null;
  /** Capsule position from MEWS space data: "Upper" | "Lower". Null when unknown. */
  floor: string | null;
}

export interface DayAvailability {
  date: string;
  dayStart: string;
  dayEnd: string;
  rows: DayAvailabilityRow[];
  unassignedCount: number;
  /**
   * One interval per reservation that occupies SOME capsule this day without
   * being assigned to one yet (clipped to the day). Each claims a physical
   * capsule the hourly sale path must keep in reserve — see the 19/8-2026
   * oversell in hourly-rental-service.countUnassignedOccupancy.
   */
  unassignedIntervals: DayInterval[];
  blocksUnknown: boolean;
  /** True when MEWS resource states (housekeeping) could not be fetched. */
  statesUnknown: boolean;
}

// Twins share one physical bed — show the WORST housekeeping state of the pair.
const STATE_RANK: Record<string, number> = { Inspected: 0, Clean: 1, Dirty: 2, OutOfService: 3, OutOfOrder: 4 };

const MIN_GAP_MS = 60 * 60 * 1000; // only show gaps ≥ 1 hour (a sellable slot)

interface MsInterval {
  from: number;
  to: number;
  cause: OccupancyCause;
  label?: string;
}

function mergeIntervals(intervals: MsInterval[]): Array<{ from: number; to: number }> {
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  const merged: Array<{ from: number; to: number }> = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.from <= last.to) {
      last.to = Math.max(last.to, iv.to);
    } else {
      merged.push({ from: iv.from, to: iv.to });
    }
  }
  return merged;
}

export async function computeDayAvailability(
  storage: ITenantStorage,
  mewsClient: MewsClient | null,
  dateISO: string
): Promise<DayAvailability> {
  // Memoized settings reader: buildValidityWindow reads 3 settings per call —
  // with ~100 windows per day view that would be 300 reads without this.
  const memo = new Map<string, Promise<{ value: string } | null | undefined>>();
  const settings = {
    getSetting(key: string) {
      if (!memo.has(key)) memo.set(key, storage.getSetting(key) as Promise<{ value: string } | null | undefined>);
      return memo.get(key)!;
    },
  };

  const tz = (await settings.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
  const checkoutHHMM = (await settings.getSetting("reservation_checkout_time"))?.value || "10:00";
  // startOf("day") + plus({days:1}) — NOT +24h: DST days are 23/25 hours long.
  const dayStart = DateTime.fromISO(dateISO, { zone: tz }).startOf("day");
  const dayEnd = dayStart.plus({ days: 1 });
  const dayStartMs = dayStart.toMillis();
  const dayEndMs = dayEnd.toMillis();

  const allRooms = await storage.getAllRooms();
  // Rooms with neither a MEWS resource nor pool membership can never carry
  // occupancy — dropping them removes eternal "free all day" noise rows.
  const relevantRooms = allRooms.filter((r) => r.pmsId || r.hourlyPool);
  const roomByPmsId = new Map(allRooms.filter((r) => r.pmsId).map((r) => [r.pmsId!, r]));
  const roomById = new Map(allRooms.map((r) => [r.id, r]));

  // ── MEWS resource states (housekeeping) + Upper/Lower position ───────────
  let statesUnknown = false;
  const resourceById = new Map<string, { State: string; floor: string | null }>();
  if (mewsClient) {
    try {
      for (const res of await mewsClient.getResources()) {
        resourceById.set(res.Id, {
          State: res.State,
          floor: res.Data?.Value?.FloorNumber ?? null,
        });
      }
    } catch {
      statesUnknown = true;
    }
  } else {
    statesUnknown = true;
  }

  // TWIN SPACES: "401" and "401s" are the SAME physical capsule (1- vs
  // 2-person pricing, shared lock). Group per physical capsule — occupancy on
  // either twin occupies the unit, and the overview shows ONE row per bed.
  interface PhysicalGroup { key: string; roomIds: string[]; label: string; hourlyPool: boolean }
  const groupsByKey = new Map<string, PhysicalGroup>();
  for (const r of relevantRooms) {
    const key = physicalRoomKey(r.name);
    if (!groupsByKey.has(key)) groupsByKey.set(key, { key, roomIds: [], label: key, hourlyPool: false });
    const g = groupsByKey.get(key)!;
    g.roomIds.push(r.id);
    if (r.hourlyPool) g.hourlyPool = true;
    // Prefer the base room's display name as the group label.
    if (r.name === key) g.label = getSpaceDisplayName(r.name, r.label);
  }
  const groups = Array.from(groupsByKey.values()).sort((a, b) => {
    if (a.hourlyPool !== b.hourlyPool) return a.hourlyPool ? -1 : 1;
    return a.label.localeCompare(b.label, undefined, { numeric: true });
  });

  // ── Reservation occupancy ─────────────────────────────────────────────────
  const ALLOWED = new Set(["confirmed", "started", "checked-in"]);
  const [checkoutH, checkoutM] = checkoutHHMM.split(":").map((v) => parseInt(v, 10) || 0);
  const reservations = await storage.getAllReservations();
  const relevant = reservations.filter((r) => {
    // Coarse prefilter with RAW timestamps: the early-check-in fold can move
    // validFrom up to 72h before raw arrival, late checkout up to 12h after
    // the raw departure day's checkout — widen accordingly, clip precisely later.
    const arr = new Date(r.arrival).getTime();
    const dep = new Date(r.departure).getTime();
    if (!(arr < dayEndMs + EARLY_CHECKIN_MAX_ADVANCE_MS && dep > dayStartMs - 24 * 3600e3)) return false;

    const status = (r.status || "").toLowerCase();
    if (ALLOWED.has(status)) return true;
    // Checked-out with a paid late checkout still occupies its departure
    // morning. DAY-truthful band test (NOT the now-relative
    // hasActiveLateCheckout — that would misrender past/future dates):
    // lateCheckoutUntil must sit within the 12h band above the normalized
    // checkout time on the departure day.
    if (status === "checked-out" && r.lateCheckoutUntil) {
      const normalizedEnd = DateTime.fromJSDate(new Date(r.departure), { zone: "utc" })
        .setZone(tz)
        .set({ hour: checkoutH, minute: checkoutM, second: 0, millisecond: 0 })
        .toMillis();
      const until = new Date(r.lateCheckoutUntil).getTime();
      return until > normalizedEnd && until - normalizedEnd <= LATE_CHECKOUT_MAX_EXTENSION_MS;
    }
    return false;
  });

  const occupiedByRoom = new Map<string, MsInterval[]>();
  const push = (roomId: string, iv: MsInterval) => {
    if (!occupiedByRoom.has(roomId)) occupiedByRoom.set(roomId, []);
    occupiedByRoom.get(roomId)!.push(iv);
  };

  let unassignedCount = 0;
  const unassignedMs: Array<{ from: number; to: number }> = [];
  for (const r of relevant) {
    const window = await buildValidityWindow(settings, r as any);
    const from = Math.max(window.validFrom.getTime(), dayStartMs);
    const to = Math.min(window.validTo.getTime(), dayEndMs);
    if (from >= to) continue; // window doesn't touch this day
    if (!r.roomId) {
      // Occupies SOME capsule but isn't assigned yet — surfacing this stops
      // the overview from overstating availability on future dates, and the
      // interval lets the public slot grid hold a capsule back for it.
      unassignedCount++;
      unassignedMs.push({ from, to });
      continue;
    }
    push(r.roomId, { from, to, cause: "guest" });
  }

  // ── Hourly-booking occupancy (± cleaning buffer, findFreeRooms semantics) ─
  const bufferMinutes = parseInt((await settings.getSetting("hourly_buffer_minutes"))?.value || "0", 10) || 0;
  const bufferMs = bufferMinutes * 60 * 1000;
  try {
    const hourly = await storage.getHourlyBookingsOverlapping(
      new Date(dayStartMs - bufferMs),
      new Date(dayEndMs + bufferMs),
      ["confirmed", "pending_payment"]
    );
    for (const hb of hourly) {
      const from = Math.max(new Date(hb.startAt).getTime() - bufferMs, dayStartMs);
      const to = Math.min(new Date(hb.endAt).getTime() + bufferMs, dayEndMs);
      if (from >= to) continue;
      push(hb.roomId, { from, to, cause: hb.status === "pending_payment" ? "hourly-pending" : "hourly" });
      // Grace move (arrived guest moved in MEWS): the code is live on the
      // grace TARGET capsule too — it must show occupied until the move
      // completes or rolls back.
      for (const e of ((hb.lockKeyIds as any) || []) as Array<{ graceRoomId?: string }>) {
        if (e?.graceRoomId) push(e.graceRoomId, { from, to, cause: "hourly" });
      }
    }
  } catch { /* hourly table unavailable — omit */ }

  // ── MEWS resource blocks ──────────────────────────────────────────────────
  let blocksUnknown = false;
  if (mewsClient) {
    try {
      const blocks = await mewsClient.getResourceBlocks(dayStart.toUTC().toISO()!, dayEnd.toUTC().toISO()!);
      for (const b of blocks) {
        const room = roomByPmsId.get(b.AssignedResourceId);
        if (!room) continue;
        const from = Math.max(new Date(b.StartUtc).getTime(), dayStartMs);
        const to = Math.min(new Date(b.EndUtc).getTime(), dayEndMs);
        if (from >= to) continue;
        push(room.id, {
          from,
          to,
          cause: "block",
          label: b.Type === "OutOfOrder" ? "Out of order" : b.Type === "InternalUse" ? "Internal use" : b.Type,
        });
      }
    } catch {
      blocksUnknown = true;
    }
  } else {
    blocksUnknown = true;
  }

  // ── Complement per PHYSICAL capsule → free gaps ≥ 60 min ─────────────────
  const iso = (ms: number) => new Date(ms).toISOString();
  const rows: DayAvailabilityRow[] = groups.map((group) => {
    // Union of occupancy across the twin spaces — either twin occupies the bed.
    const occupied = group.roomIds
      .flatMap((id) => occupiedByRoom.get(id) ?? [])
      .sort((a, b) => a.from - b.from);
    const merged = mergeIntervals(occupied);
    const free: DayInterval[] = [];
    let cursor = dayStartMs;
    for (const iv of merged) {
      if (iv.from - cursor >= MIN_GAP_MS) free.push({ from: iso(cursor), to: iso(iv.from) });
      cursor = Math.max(cursor, iv.to);
    }
    if (dayEndMs - cursor >= MIN_GAP_MS) free.push({ from: iso(cursor), to: iso(dayEndMs) });

    // Housekeeping state + Upper/Lower for the physical capsule: worst state
    // across the twin spaces (either twin being Dirty means the bed is Dirty).
    let state: string | null = null;
    let floor: string | null = null;
    for (const id of group.roomIds) {
      const pmsId = roomById.get(id)?.pmsId;
      const res = pmsId ? resourceById.get(pmsId) : undefined;
      if (!res) continue;
      if (state === null || (STATE_RANK[res.State] ?? -1) > (STATE_RANK[state] ?? -1)) state = res.State;
      if (!floor && res.floor) floor = res.floor;
    }

    return {
      roomId: group.roomIds[0],
      // ALL spaces of the physical capsule (twins) — pool toggling must flip
      // every twin, or the group would stay "pool" via the other space.
      roomIds: group.roomIds,
      label: group.label,
      hourlyPool: group.hourlyPool,
      free,
      occupied: occupied.map((o) => ({ from: iso(o.from), to: iso(o.to), cause: o.cause, label: o.label })),
      state,
      floor,
    };
  });

  return {
    date: dateISO,
    dayStart: dayStart.toUTC().toISO()!,
    dayEnd: dayEnd.toUTC().toISO()!,
    rows,
    unassignedCount,
    unassignedIntervals: unassignedMs.map((iv) => ({ from: iso(iv.from), to: iso(iv.to) })),
    blocksUnknown,
    statesUnknown,
  };
}
