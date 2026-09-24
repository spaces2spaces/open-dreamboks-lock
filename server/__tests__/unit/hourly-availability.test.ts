import { describe, it, expect } from "vitest";
import { computeDayAvailability } from "../../hourly-availability";

// CPH summer: UTC+2. Checkout 10:00 = 08:00Z, check-in 15:00 = 13:00Z.
const D = "2026-07-25";
const Z = (hhmm: string, date = D) => `${date}T${hhmm}:00.000Z`;

function mockStorage(overrides: {
  rooms?: any[];
  reservations?: any[];
  hourly?: any[];
  settings?: Record<string, string>;
} = {}) {
  const settings: Record<string, string> = {
    property_timezone: "Europe/Copenhagen",
    check_in_time: "15:00",
    reservation_checkout_time: "10:00",
    hourly_buffer_minutes: "0",
    ...overrides.settings,
  };
  return {
    async getSetting(key: string) {
      return settings[key] ? { value: settings[key] } : null;
    },
    async getAllRooms() {
      return overrides.rooms ?? [{ id: "r1", name: "701", label: null, pmsId: "pms-1", hourlyPool: true }];
    },
    async getAllReservations() {
      return overrides.reservations ?? [];
    },
    async getHourlyBookingsOverlapping() {
      return overrides.hourly ?? [];
    },
  } as any;
}

const res = (over: any) => ({
  id: over.id ?? "res-x",
  status: "Confirmed",
  roomId: "r1",
  arrival: Z("12:00"),
  departure: Z("12:00", "2026-07-26"),
  earlyCheckinFrom: null,
  lateCheckoutUntil: null,
  ...over,
});

describe("computeDayAvailability", () => {
  it("turnover gap: departing 10:00 + arriving 15:00 → free 10-15 only", async () => {
    const storage = mockStorage({
      reservations: [
        res({ id: "dep", arrival: Z("12:00", "2026-07-24"), departure: Z("12:00", D), status: "checked-in" }),
        res({ id: "arr", arrival: Z("12:00", D), departure: Z("12:00", "2026-07-26") }),
      ],
    });
    const result = await computeDayAvailability(storage, null, D);
    expect(result.rows[0].free).toEqual([{ from: Z("08:00"), to: Z("13:00") }]);
  });

  it("late checkout 12:00 shrinks the gap to 12-15", async () => {
    const storage = mockStorage({
      reservations: [
        res({ id: "dep", arrival: Z("12:00", "2026-07-24"), departure: Z("12:00", D), status: "checked-in", lateCheckoutUntil: Z("10:00") }), // 12:00 CPH
        res({ id: "arr", arrival: Z("12:00", D) }),
      ],
    });
    const result = await computeDayAvailability(storage, null, D);
    expect(result.rows[0].free).toEqual([{ from: Z("10:00"), to: Z("13:00") }]);
  });

  it("purchased early check-in 11:00 shrinks the gap to 10-11; sub-hour gaps are dropped", async () => {
    const storage = mockStorage({
      reservations: [
        res({ id: "dep", arrival: Z("12:00", "2026-07-24"), departure: Z("12:00", D), status: "checked-in" }),
        res({ id: "arr", arrival: Z("12:00", D), earlyCheckinFrom: Z("09:00") }), // 11:00 CPH
      ],
    });
    const result = await computeDayAvailability(storage, null, D);
    expect(result.rows[0].free).toEqual([{ from: Z("08:00"), to: Z("09:00") }]);

    // late until 12:00 + early from 12:30 → 30 min gap → dropped entirely
    const storage2 = mockStorage({
      reservations: [
        res({ id: "dep", arrival: Z("12:00", "2026-07-24"), departure: Z("12:00", D), status: "checked-in", lateCheckoutUntil: Z("10:00") }),
        res({ id: "arr", arrival: Z("12:00", D), earlyCheckinFrom: Z("10:30") }),
      ],
    });
    const result2 = await computeDayAvailability(storage2, null, D);
    expect(result2.rows[0].free).toEqual([]);
  });

  it("multi-day spanning stay occupies the whole day", async () => {
    const storage = mockStorage({
      reservations: [res({ arrival: Z("12:00", "2026-07-23"), departure: Z("12:00", "2026-07-27"), status: "checked-in" })],
    });
    const result = await computeDayAvailability(storage, null, D);
    expect(result.rows[0].free).toEqual([]);
  });

  it("checked-out with in-band late checkout still occupies its morning (day-truthful, not now-relative)", async () => {
    const storage = mockStorage({
      reservations: [
        res({ arrival: Z("12:00", "2026-07-24"), departure: Z("12:00", D), status: "Checked-out", lateCheckoutUntil: Z("12:00") }), // 14:00 CPH
      ],
    });
    const result = await computeDayAvailability(storage, null, D);
    // occupied 00:00→14:00 CPH, free 14:00→24:00
    expect(result.rows[0].free).toEqual([{ from: Z("12:00"), to: Z("22:00") }]);
  });

  it("hourly bookings get ± buffer; reservations do not", async () => {
    const storage = mockStorage({
      settings: { hourly_buffer_minutes: "30" },
      hourly: [{ roomId: "r1", startAt: Z("09:00"), endAt: Z("11:00"), status: "confirmed" }], // 11-13 CPH
    });
    const result = await computeDayAvailability(storage, null, D);
    // occupied 10:30-13:30 CPH → free 00:00-10:30 + 13:30-24:00
    expect(result.rows[0].free).toEqual([
      { from: Z("22:00", "2026-07-24"), to: Z("08:30") },
      { from: Z("11:30"), to: Z("22:00") },
    ]);
    expect(result.rows[0].occupied[0].cause).toBe("hourly");
  });

  it("DST day (2026-03-29, 23h) uses correct day bounds", async () => {
    const storage = mockStorage({ reservations: [] });
    const result = await computeDayAvailability(storage, null, "2026-03-29");
    const [free] = result.rows[0].free;
    expect(free.from).toBe(result.dayStart);
    expect(free.to).toBe(result.dayEnd);
    const hours = (new Date(result.dayEnd).getTime() - new Date(result.dayStart).getTime()) / 3600e3;
    expect(hours).toBe(23);
  });

  it("counts unassigned reservations overlapping the day; blocksUnknown without a MEWS client", async () => {
    const storage = mockStorage({
      reservations: [res({ roomId: null })],
    });
    const result = await computeDayAvailability(storage, null, D);
    expect(result.unassignedCount).toBe(1);
    expect(result.blocksUnknown).toBe(true);
  });

  it("MEWS resource blocks occupy via pmsId mapping", async () => {
    const storage = mockStorage({});
    const mews = {
      async getResourceBlocks() {
        return [{ Id: "b1", AssignedResourceId: "pms-1", Type: "OutOfOrder", StartUtc: Z("06:00"), EndUtc: Z("10:00") }];
      },
    } as any;
    const result = await computeDayAvailability(storage, mews, D);
    expect(result.blocksUnknown).toBe(false);
    expect(result.rows[0].occupied[0]).toMatchObject({ cause: "block", label: "Out of order" });
    expect(result.rows[0].free).toEqual([
      { from: Z("22:00", "2026-07-24"), to: Z("06:00") },
      { from: Z("10:00"), to: Z("22:00") },
    ]);
  });
});

describe("twin spaces (401/401s = same physical capsule)", () => {
  it("merges twins into one row; occupancy on either twin blocks the bed", async () => {
    const storage = mockStorage({
      rooms: [
        { id: "r-401", name: "401", label: null, pmsId: "pms-401", hourlyPool: false },
        { id: "r-401s", name: "401s", label: null, pmsId: "pms-401s", hourlyPool: true },
      ],
      reservations: [res({ roomId: "r-401s", status: "checked-in", arrival: Z("12:00", "2026-07-24"), departure: Z("12:00", D) })],
    });
    const result = await computeDayAvailability(storage, null, D);
    expect(result.rows).toHaveLength(1); // ONE physical capsule
    expect(result.rows[0].label).toBe("401");
    expect(result.rows[0].hourlyPool).toBe(true); // twin in pool → unit in pool
    // guest in 401s occupies the bed until 10:00 → free 10:00-24:00
    expect(result.rows[0].free).toEqual([{ from: Z("08:00"), to: Z("22:00") }]);
  });
});
