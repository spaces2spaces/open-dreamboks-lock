/**
 * Public hourly slots (owner request 23/7): aggregated, identity-free start
 * hours from the day-availability picture.
 *  - per start hour: the longest contiguous run some allowed capsule is free
 *  - cross-midnight stitching via the next day's picture
 *  - rowAllowed filters (pool-only vs dynamic inventory)
 *  - notBeforeMs drops past hours; maxHoursCap bounds the run
 * Plus the shared priority formula both the admin view and allocation use.
 */
import { describe, it, expect } from "vitest";
import { computePublicStartHours, applyStartNow } from "../../hourly-public-availability";
import { priorityScore, readinessRank } from "@shared/hourly-priority";
import type { DayAvailability } from "../../hourly-availability";

const DAY = "2026-07-24";
const dayStart = Date.parse(`${DAY}T00:00:00.000Z`); // UTC day for test simplicity
const HOUR = 3_600_000;
const iso = (h: number, base = dayStart) => new Date(base + h * HOUR).toISOString();

// Rows are specified by OCCUPANCY (the slot computation derives sellable free
// time from `occupied` itself — row.free subtracts MEWS blocks, which on pool
// capsules are the carve-out, not unavailability).
type OccSpec = [number, number] | [number, number, "guest" | "hourly" | "hourly-pending" | "block"];
function mkDay(
  rows: Array<{ roomIds: string[]; hourlyPool?: boolean; occupied?: OccSpec[] }>,
  base = dayStart,
  unassigned: Array<[number, number]> = [],
): DayAvailability {
  return {
    date: DAY,
    dayStart: new Date(base).toISOString(),
    dayEnd: new Date(base + 24 * HOUR).toISOString(),
    rows: rows.map((r, i) => ({
      roomId: r.roomIds[0],
      roomIds: r.roomIds,
      label: `10${i}`,
      hourlyPool: r.hourlyPool ?? true,
      free: [],
      occupied: (r.occupied ?? []).map(([from, to, cause]) => ({ from: iso(from, base), to: iso(to, base), cause: cause ?? "guest" })),
      state: null,
      floor: null,
    })),
    unassignedCount: unassigned.length,
    unassignedIntervals: unassigned.map(([from, to]) => ({ from: iso(from, base), to: iso(to, base) })),
    blocksUnknown: false,
    statesUnknown: false,
  };
}

describe("computePublicStartHours", () => {
  it("emits per-hour max contiguous runs across capsules", () => {
    const day = mkDay([
      { roomIds: ["a"], occupied: [[0, 10], [15, 24]] }, // free 10-15 = 5h
      { roomIds: ["b"], occupied: [[0, 12], [14, 24]] }, // free 12-14
    ]);
    const slots = computePublicStartHours(day, null, { rowAllowed: () => true, notBeforeMs: 0, maxHoursCap: 24 });

    const byHour = new Map(slots.map(s => [s.hour, s.maxHours]));
    expect(byHour.get(10)).toBe(5);
    expect(byHour.get(12)).toBe(3); // capsule a: 12→15
    expect(byHour.get(14)).toBe(1);
    expect(byHour.has(9)).toBe(false);
    expect(byHour.has(15)).toBe(false);
  });

  it("stitches a midnight-touching interval into the next day for the same capsule", () => {
    const dayA = mkDay([{ roomIds: ["a"], occupied: [[0, 20]] }]); // free 20-24
    const dayB = mkDay([{ roomIds: ["a"], occupied: [[6, 24]] }], dayStart + 24 * HOUR); // free 0-6
    const slots = computePublicStartHours(dayA, dayB, { rowAllowed: () => true, notBeforeMs: 0, maxHoursCap: 24 });

    expect(slots.find(s => s.hour === 22)?.maxHours).toBe(8); // 22→06 next day
  });

  it("does not stitch across DIFFERENT capsules", () => {
    const dayA = mkDay([{ roomIds: ["a"], occupied: [[0, 20]] }]);
    const dayB = mkDay([{ roomIds: ["b"], occupied: [[6, 24]] }], dayStart + 24 * HOUR);
    const slots = computePublicStartHours(dayA, dayB, { rowAllowed: () => true, notBeforeMs: 0, maxHoursCap: 24 });

    expect(slots.find(s => s.hour === 22)?.maxHours).toBe(2);
  });

  it("respects rowAllowed, notBeforeMs and maxHoursCap", () => {
    const day = mkDay([
      { roomIds: ["pool"], hourlyPool: true, occupied: [[0, 8], [20, 24]] }, // free 8-20
      { roomIds: ["dyn"], hourlyPool: false, occupied: [] },                 // free all day
    ]);
    const poolOnly = computePublicStartHours(day, null, {
      rowAllowed: r => r.hourlyPool,
      notBeforeMs: dayStart + 10 * HOUR, // "now" is 10:00
      maxHoursCap: 4,
    });

    expect(poolOnly.find(s => s.hour === 9)).toBeUndefined(); // past
    expect(poolOnly.find(s => s.hour === 10)?.maxHours).toBe(4); // capped (real run 10h)
    expect(poolOnly.find(s => s.hour === 21)).toBeUndefined(); // only the non-allowed dynamic room is free
  });

  it("twin id sets match rows across days regardless of order", () => {
    const dayA = mkDay([{ roomIds: ["401", "401s"], occupied: [[0, 22]] }]);
    const dayB = mkDay([{ roomIds: ["401s", "401"], occupied: [[2, 24]] }], dayStart + 24 * HOUR);
    const slots = computePublicStartHours(dayA, dayB, { rowAllowed: () => true, notBeforeMs: 0, maxHoursCap: 24 });

    expect(slots.find(s => s.hour === 22)?.maxHours).toBe(4);
  });

  it("MEWS blocks on POOL capsules are sellable (the carve-out), on dynamic rooms they are not", () => {
    const day = mkDay([
      { roomIds: ["pool"], hourlyPool: true, occupied: [[0, 24, "block"]] },   // carved out of MEWS → hourly product
      { roomIds: ["dyn"], hourlyPool: false, occupied: [[0, 24, "block"]] },   // genuinely out of order
    ]);

    const poolSlots = computePublicStartHours(day, null, { rowAllowed: r => r.hourlyPool, notBeforeMs: 0, maxHoursCap: 24 });
    expect(poolSlots.length).toBe(24); // every hour sellable despite the block

    const dynSlots = computePublicStartHours(day, null, { rowAllowed: r => !r.hourlyPool, notBeforeMs: 0, maxHoursCap: 24 });
    expect(dynSlots.length).toBe(0);

    // Guest/hourly occupancy on a pool capsule still blocks, of course.
    const busyPool = mkDay([{ roomIds: ["pool"], hourlyPool: true, occupied: [[0, 24, "guest"]] }]);
    expect(computePublicStartHours(busyPool, null, { rowAllowed: () => true, notBeforeMs: 0, maxHoursCap: 24 }).length).toBe(0);
  });

  /**
   * House reserve (19/8-2026 oversell): a reservation MEWS hasn't assigned yet
   * occupies SOME capsule. The grid must stop offering hours the sale path now
   * refuses — otherwise guests pay for a capsule the house doesn't have.
   */
  it("holds one free capsule back per unassigned arrival", () => {
    const rows = [{ roomIds: ["a"] }, { roomIds: ["b"], occupied: [[0, 24] as OccSpec] }];
    // One capsule free all day, one unassigned arrival covering 10–14 → those
    // hours belong to the arrival, not to hourly guests.
    const day = mkDay(rows, dayStart, [[10, 14]]);
    const slots = computePublicStartHours(day, null, { rowAllowed: () => true, notBeforeMs: 0, maxHoursCap: 24 });
    const byHour = new Map(slots.map(s => [s.hour, s.maxHours]));
    expect(byHour.has(10)).toBe(false);
    expect(byHour.has(13)).toBe(false);
    expect(byHour.get(14)).toBe(10); // 14→24 again
    // …and a run STARTING before the reserved hours is cut at 10:00.
    expect(byHour.get(8)).toBe(2);
  });

  it("keeps selling when free capsules outnumber the unassigned arrivals", () => {
    const day = mkDay([{ roomIds: ["a"] }, { roomIds: ["b"] }], dayStart, [[10, 14]]);
    const byHour = new Map(
      computePublicStartHours(day, null, { rowAllowed: () => true, notBeforeMs: 0, maxHoursCap: 24 })
        .map(s => [s.hour, s.maxHours]),
    );
    expect(byHour.get(10)).toBe(14); // one capsule reserved, the other sellable
  });

  it("applies the reserve to the stitched next day too", () => {
    const dayA = mkDay([{ roomIds: ["a"], occupied: [[0, 20]] }]);
    const dayB = mkDay([{ roomIds: ["a"], occupied: [[6, 24]] }], dayStart + 24 * HOUR, [[2, 6]]);
    const slots = computePublicStartHours(dayA, dayB, { rowAllowed: () => true, notBeforeMs: 0, maxHoursCap: 24 });
    // Without the reserve this is 22:00 → 06:00 = 8h; the unassigned arrival on
    // day B owns 02–06, so the run stops at 02:00.
    expect(slots.find(s => s.hour === 22)?.maxHours).toBe(4);
  });
});

describe("applyStartNow (29/7 walk-in fix: book from NOW, not the next whole hour)", () => {
  const slot = (h: number, maxHours: number) => ({ startAt: iso(h), hour: h, maxHours });

  it("rewrites the current hour's slot to the actual instant and recomputes maxHours", () => {
    const now = dayStart + 7 * HOUR + 42 * 60_000; // 07:42
    const out = applyStartNow([slot(7, 7), slot(8, 6)], now);
    expect(out[0].now).toBe(true);
    expect(out[0].startAt).toBe(new Date(now).toISOString());
    // Coverage 07:00–14:00; from 07:42 only 6 whole hours fit.
    expect(out[0].maxHours).toBe(6);
    // Future slots untouched.
    expect(out[1]).toEqual(slot(8, 6));
  });

  it("drops the now-slot when less than one whole hour remains of its coverage", () => {
    const now = dayStart + 7 * HOUR + 42 * 60_000;
    const out = applyStartNow([slot(7, 1), slot(8, 5)], now); // coverage ends 08:00 → 18 min left
    expect(out.map(s => s.hour)).toEqual([8]);
  });

  it("a 6h package stays offered from NOW when the run truly covers it", () => {
    const now = dayStart + 7 * HOUR + 30 * 60_000; // 07:30, coverage 07–14 (7h)
    const out = applyStartNow([slot(7, 7)], now);
    expect(out[0].maxHours).toBe(6); // 07:30+6h = 13:30 ≤ 14:00 ✓
  });
});

describe("shared hourly priority", () => {
  it("readiness gates the priority flag (24/7 owner decision): Inspected non-priority beats Dirty priority", () => {
    const prioInspectedFree = priorityScore({ priority: true, state: "Inspected", freeRestOfDay: true });
    const plainInspectedFree = priorityScore({ priority: false, state: "Inspected", freeRestOfDay: true });
    const prioInspectedBusy = priorityScore({ priority: true, state: "Inspected", freeRestOfDay: false });
    const prioDirty = priorityScore({ priority: true, state: "Dirty", freeRestOfDay: true });

    // Among equally ready capsules, the priority flag always wins…
    expect(prioInspectedFree).toBeLessThan(plainInspectedFree);
    // …and beats the free-rest-of-day tie-break.
    expect(prioInspectedFree).toBeLessThan(prioInspectedBusy);
    // But readiness comes FIRST: a Dirty priority capsule loses to an
    // Inspected non-priority one.
    expect(plainInspectedFree).toBeLessThan(prioDirty);
  });

  it("readiness ranks Inspected < Clean < everything else", () => {
    expect(readinessRank("Inspected")).toBe(0);
    expect(readinessRank("Clean")).toBe(1);
    expect(readinessRank("Dirty")).toBe(2);
    expect(readinessRank(null)).toBe(2);
  });
});
