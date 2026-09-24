/**
 * Public-facing hourly availability: cached day pictures + aggregated,
 * identity-free slot data for the guest /hourly page.
 *
 * The guest page must show REAL bookable start hours (owner request 23/7 —
 * until now guests picked a time blind and were told "no capsules" after the
 * fact), but must never see room ids, capsule labels, housekeeping states or
 * per-bed occupancy timelines. So the day picture is aggregated down to:
 * "for each start hour, how many contiguous hours can SOME capsule be booked".
 */
import type { ITenantStorage } from "./storage";
import type { MewsClient } from "./mews-client";
import { computeDayAvailability, type DayAvailability, type DayAvailabilityRow } from "./hourly-availability";

// 30s cache (arrivals-page pattern): each uncached compute costs 2 MEWS HTTP
// calls + a full reservations read. The slots endpoint fetches two days per
// request (cross-midnight stitching), so without this a public page burst
// would multiply MEWS load.
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map<string, { at: number; value: Promise<DayAvailability> }>();

export function getCachedDayAvailability(
  tenantId: string,
  storage: ITenantStorage,
  mewsClient: MewsClient | null,
  dateISO: string,
): Promise<DayAvailability> {
  const key = `${tenantId}:${dateISO}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const value = computeDayAvailability(storage, mewsClient, dateISO);
  // A failed compute must not be served for 30s — drop it so the next
  // request retries.
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  if (cache.size > 200) {
    for (const [k, entry] of Array.from(cache.entries())) {
      if (Date.now() - entry.at > CACHE_TTL_MS) cache.delete(k);
    }
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Test hook — the cache is module-global and would leak state across tests. */
export function _clearAvailabilityCache(): void {
  cache.clear();
}

export interface PublicStartHour {
  /** ISO instant of the slot start (UTC) — the client formats it in the property TZ. */
  startAt: string;
  /** Wall-clock hour label in the property tz (0-23), for display grids. */
  hour: number;
  /** Longest contiguous run (whole hours) SOME bookable capsule is free from this start. */
  maxHours: number;
  /** This slot starts RIGHT NOW (walk-in) — startAt is the actual current instant, not a whole hour. */
  now?: boolean;
}

/**
 * Walk-in fix (29/7, Martin's NY businessman at 07:42): the grid is whole-hour,
 * so a guest mid-hour was forced to wait for the next slot. Rewrite the
 * CURRENT hour's slot to start at the actual instant, and recompute its
 * maxHours from NOW against the same coverage end — a 6h package must not be
 * offered when the run from the true start would collide with the next block.
 */
export function applyStartNow(startHours: PublicStartHour[], nowMs: number): PublicStartHour[] {
  const HOUR_MS = 3_600_000;
  return startHours
    .map(s => {
      const startMs = Date.parse(s.startAt);
      if (startMs <= nowMs && nowMs - startMs < HOUR_MS) {
        const coverageEndMs = startMs + s.maxHours * HOUR_MS;
        const maxHours = Math.floor((coverageEndMs - nowMs) / HOUR_MS);
        if (maxHours < 1) return null;
        return { ...s, startAt: new Date(nowMs).toISOString(), maxHours, now: true };
      }
      return s;
    })
    .filter((s): s is PublicStartHour => s !== null);
}

/**
 * Aggregate two consecutive day pictures into bookable start hours for day A.
 * dayB extends runs across midnight (a 22:00 start can still offer 4 hours);
 * pass null to cap runs at midnight.
 *
 * `rowAllowed` filters which capsules are publicly sellable (pool-only, or
 * pool + lock-mapped rooms when dynamic inventory is enabled).
 */
export function computePublicStartHours(
  dayA: DayAvailability,
  dayB: DayAvailability | null,
  opts: {
    rowAllowed: (row: DayAvailabilityRow) => boolean;
    /** Earliest permitted slot start (ms) — "now minus booking grace" for today, day start otherwise. */
    notBeforeMs: number;
    maxHoursCap: number;
  },
): PublicStartHour[] {
  const HOUR_MS = 3_600_000;

  // Sellable free intervals for a row. NOT row.free as-is: the day engine
  // subtracts MEWS resource blocks, but a block on a PRIORITY capsule
  // (rooms.hourly_pool — since 24/7 the "Add to priority" flag) is the
  // carve-out mechanism itself (the operator blocks those beds in MEWS so
  // MEWS/OTA can't sell them) — for hourly sales those hours ARE the product.
  // Blocks still remove availability on non-priority rows, where OutOfOrder
  // genuinely means unusable. So: recompute the complement from `occupied`,
  // dropping block-cause intervals on priority rows.
  const sellableFree = (row: DayAvailabilityRow, day: DayAvailability): Array<{ from: number; to: number }> => {
    const startMs = Date.parse(day.dayStart);
    const endMs = Date.parse(day.dayEnd);
    const blocking = row.occupied
      .filter(o => !(row.hourlyPool && o.cause === "block"))
      .map(o => ({ from: Date.parse(o.from), to: Date.parse(o.to) }))
      .sort((a, b) => a.from - b.from);
    const free: Array<{ from: number; to: number }> = [];
    let cursor = startMs;
    for (const iv of blocking) {
      if (iv.from - cursor >= HOUR_MS) free.push({ from: cursor, to: iv.from });
      cursor = Math.max(cursor, iv.to);
    }
    if (endMs - cursor >= HOUR_MS) free.push({ from: cursor, to: endMs });
    return free;
  };

  // Per physical capsule (matched across the two days by its twin-id set):
  // free intervals of day A, extended into day B when they touch midnight.
  const rowKey = (row: DayAvailabilityRow) => [...row.roomIds].sort().join("|");
  const dayBFreeByKey = new Map<string, Array<{ from: number; to: number }>>();
  if (dayB) {
    for (const row of dayB.rows) {
      if (!opts.rowAllowed(row)) continue;
      dayBFreeByKey.set(rowKey(row), sellableFree(row, dayB));
    }
  }
  const dayEndMs = Date.parse(dayA.dayEnd);

  const stitched: Array<Array<{ from: number; to: number }>> = [];
  for (const row of dayA.rows) {
    if (!opts.rowAllowed(row)) continue;
    const intervals = sellableFree(row, dayA);
    const last = intervals[intervals.length - 1];
    if (last && last.to >= dayEndMs) {
      const nextDay = dayBFreeByKey.get(rowKey(row)) ?? [];
      const continuation = nextDay.find(iv => iv.from <= dayEndMs);
      if (continuation) last.to = continuation.to;
    }
    stitched.push(intervals);
  }

  // ── House reserve (19/8-2026 oversell) ──────────────────────────────────
  // A reservation MEWS hasn't assigned yet occupies SOME capsule. Per hour,
  // one free capsule per such arrival is unsellable — otherwise the grid keeps
  // offering hours that /book now refuses (allocate applies the same reserve).
  const dayBRowIntervals = Array.from(dayBFreeByKey.values());
  const parseIvs = (day: DayAvailability | null) =>
    (day?.unassignedIntervals ?? []).map(iv => ({ from: Date.parse(iv.from), to: Date.parse(iv.to) }));
  const unassignedA = parseIvs(dayA);
  const unassignedB = parseIvs(dayB);
  const houseOkCache = new Map<number, boolean>();
  const houseOk = (t: number): boolean => {
    const cached = houseOkCache.get(t);
    if (cached !== undefined) return cached;
    const inDayA = t < dayEndMs;
    const rowSets = inDayA ? stitched : dayBRowIntervals;
    const reserved = (inDayA ? unassignedA : unassignedB)
      .filter(u => u.from < t + HOUR_MS && u.to > t).length;
    const freeRows = rowSets.filter(ivs => ivs.some(iv => iv.from <= t && iv.to > t)).length;
    const ok = freeRows - reserved >= 1;
    houseOkCache.set(t, ok);
    return ok;
  };
  /** Trim a run to the first hour the house can't actually back. */
  const capToHouse = (startMs: number, run: number): number => {
    for (let k = 0; k < run; k++) if (!houseOk(startMs + k * HOUR_MS)) return k;
    return run;
  };

  // Whole-hour slot starts across day A (DST-safe: step by wall-clock hours
  // via ms — the day picture's dayStart/dayEnd already encode the real day
  // length, and slot steps of exactly 1h match how guests book).
  const out: PublicStartHour[] = [];
  const dayStartMs = Date.parse(dayA.dayStart);
  for (let startMs = dayStartMs; startMs < dayEndMs; startMs += HOUR_MS) {
    if (startMs < opts.notBeforeMs) continue;
    let best = 0;
    for (const intervals of stitched) {
      const iv = intervals.find(i => i.from <= startMs && i.to > startMs);
      if (!iv) continue;
      const run = Math.floor((iv.to - startMs) / HOUR_MS);
      if (run > best) best = run;
    }
    best = capToHouse(startMs, best);
    if (best >= 1) {
      out.push({
        startAt: new Date(startMs).toISOString(),
        hour: Math.round((startMs - dayStartMs) / HOUR_MS) % 24,
        maxHours: Math.min(best, opts.maxHoursCap),
      });
    }
  }
  return out;
}

/**
 * Is [startMs, endMs) coverable by a single allowed capsule? Used by the
 * public count endpoint so "available" there always matches what booking
 * will accept (the old pool-only check ignored MEWS occupancy and could say
 * yes to windows booking would then reject).
 */
export function isWindowCoverable(
  dayA: DayAvailability,
  dayB: DayAvailability | null,
  startMs: number,
  endMs: number,
  rowAllowed: (row: DayAvailabilityRow) => boolean,
): boolean {
  return computePublicStartHours(dayA, dayB, {
    rowAllowed,
    notBeforeMs: startMs,
    maxHoursCap: Math.ceil((endMs - startMs) / 3_600_000),
  }).some(s => Date.parse(s.startAt) === startMs && s.maxHours >= Math.ceil((endMs - startMs) / 3_600_000));
}
