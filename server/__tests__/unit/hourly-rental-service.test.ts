/**
 * Tests for HourlyRentalService — availability/allocation for standalone
 * hourly capsule rentals (outside MEWS).
 *
 * Contract: a pool room is free for [startAt, endAt) unless a confirmed or
 * pending_payment booking (extended by the cleaning buffer) overlaps it.
 * Cancelled/expired bookings never block. Explicit room requests must be
 * refused when that room is taken.
 */

import { describe, it, expect } from "vitest";
import { HourlyRentalService, windowsOverlap } from "../../hourly-rental-service";

const H = 3600_000;
const T0 = Date.parse("2026-08-01T10:00:00Z");

function makeStorage(overrides: Partial<Record<string, any>> = {}) {
  const rooms = overrides.rooms ?? [
    { id: "r1", name: "101", label: null, hourlyPool: true },
    { id: "r2", name: "102", label: null, hourlyPool: true },
    { id: "r3", name: "201", label: null, hourlyPool: false }, // not in pool
  ];
  const bookings = overrides.bookings ?? [];
  return {
    getAllRooms: async () => rooms,
    getSetting: async (key: string) => overrides.settings?.[key] ? { value: overrides.settings[key] } : undefined,
    getHourlyBookingsOverlapping: async (startAt: Date, endAt: Date, statuses: string[]) =>
      bookings.filter((b: any) =>
        statuses.includes(b.status) &&
        new Date(b.startAt).getTime() < endAt.getTime() &&
        new Date(b.endAt).getTime() > startAt.getTime()),
  } as any;
}

const engine = {} as any; // findFreeRooms never touches the engine

describe("windowsOverlap", () => {
  it("detects overlap and respects half-open boundaries", () => {
    expect(windowsOverlap(0, 10, 5, 15)).toBe(true);
    expect(windowsOverlap(0, 10, 10, 20)).toBe(false); // back-to-back is OK
    expect(windowsOverlap(10, 20, 0, 10)).toBe(false);
    expect(windowsOverlap(0, 30, 10, 20)).toBe(true);  // containment
  });
});

describe("HourlyRentalService.findFreeRooms", () => {
  it("returns only pool rooms when nothing is booked", async () => {
    const svc = new HourlyRentalService(makeStorage(), engine);
    const free = await svc.findFreeRooms(new Date(T0), new Date(T0 + 2 * H));
    expect(free.map(r => r.id)).toEqual(["r1", "r2"]); // r3 not in pool
  });

  it("blocks a room with an overlapping confirmed booking", async () => {
    const storage = makeStorage({
      bookings: [{ roomId: "r1", status: "confirmed", startAt: new Date(T0 + H), endAt: new Date(T0 + 3 * H) }],
    });
    const svc = new HourlyRentalService(storage, engine);
    const free = await svc.findFreeRooms(new Date(T0), new Date(T0 + 2 * H));
    expect(free.map(r => r.id)).toEqual(["r2"]);
  });

  it("blocks on pending_payment holds but NOT on cancelled/expired", async () => {
    const storage = makeStorage({
      bookings: [
        { roomId: "r1", status: "pending_payment", startAt: new Date(T0), endAt: new Date(T0 + 2 * H) },
        { roomId: "r2", status: "cancelled", startAt: new Date(T0), endAt: new Date(T0 + 2 * H) },
        { roomId: "r2", status: "expired", startAt: new Date(T0), endAt: new Date(T0 + 2 * H) },
      ],
    });
    const svc = new HourlyRentalService(storage, engine);
    const free = await svc.findFreeRooms(new Date(T0), new Date(T0 + 2 * H));
    expect(free.map(r => r.id)).toEqual(["r2"]);
  });

  it("allows back-to-back bookings with no buffer", async () => {
    const storage = makeStorage({
      bookings: [{ roomId: "r1", status: "confirmed", startAt: new Date(T0 - 2 * H), endAt: new Date(T0) }],
    });
    const svc = new HourlyRentalService(storage, engine);
    const free = await svc.findFreeRooms(new Date(T0), new Date(T0 + 2 * H));
    expect(free.map(r => r.id)).toEqual(["r1", "r2"]);
  });

  it("respects the cleaning buffer AFTER a booking (hourly_buffer_minutes)", async () => {
    const storage = makeStorage({
      settings: { hourly_buffer_minutes: "30" },
      bookings: [{ roomId: "r1", status: "confirmed", startAt: new Date(T0 - 2 * H), endAt: new Date(T0) }],
    });
    const svc = new HourlyRentalService(storage, engine);
    // Starts exactly at previous end → blocked by the 30 min buffer
    const free = await svc.findFreeRooms(new Date(T0), new Date(T0 + 2 * H));
    expect(free.map(r => r.id)).toEqual(["r2"]);
    // Starts after the buffer → free again
    const freeLater = await svc.findFreeRooms(new Date(T0 + 31 * 60_000), new Date(T0 + 2 * H));
    expect(freeLater.map(r => r.id)).toEqual(["r1", "r2"]);
  });

  it("applies the buffer symmetrically — cleaning after OUR checkout must not collide with the next arrival", async () => {
    const storage = makeStorage({
      settings: { hourly_buffer_minutes: "30" },
      // Existing booking starts at T0+2h; we request ending exactly at T0+2h.
      bookings: [{ roomId: "r1", status: "confirmed", startAt: new Date(T0 + 2 * H), endAt: new Date(T0 + 4 * H) }],
    });
    const svc = new HourlyRentalService(storage, engine);
    const free = await svc.findFreeRooms(new Date(T0), new Date(T0 + 2 * H));
    expect(free.map(r => r.id)).toEqual(["r2"]); // r1 blocked: our buffer runs into their start
    // Ending 31+ min before their start → fine
    const freeEarlier = await svc.findFreeRooms(new Date(T0), new Date(T0 + 2 * H - 31 * 60_000));
    expect(freeEarlier.map(r => r.id)).toEqual(["r1", "r2"]);
  });

  it("returns empty when the pool is empty", async () => {
    const svc = new HourlyRentalService(makeStorage({ rooms: [{ id: "x", name: "1", hourlyPool: false }] }), engine);
    const free = await svc.findFreeRooms(new Date(T0), new Date(T0 + H));
    expect(free).toEqual([]);
  });
});

/**
 * HOUSE RESERVE (19/8-2026 oversell, capsule 604): a MEWS
 * reservation that has not been assigned to a capsule yet still occupies one —
 * it just doesn't say which. Selling the last free capsule out from under such
 * an arrival is exactly how one physical bed ended up holding an overnight
 * guest and an hourly guest at the same time.
 */
function makeHouseStorage(overrides: {
  rooms?: any[];
  reservations?: any[];
  bookings?: any[];
  settings?: Record<string, string>;
} = {}) {
  const rooms = overrides.rooms ?? [
    { id: "r1", name: "604", label: null, hourlyPool: true, pmsId: "pms-604" },
    { id: "r1s", name: "604s", label: null, hourlyPool: false, pmsId: "pms-604s" },
    { id: "r2", name: "605", label: null, hourlyPool: true, pmsId: "pms-605" },
  ];
  const bookings = overrides.bookings ?? [];
  const settings: Record<string, string> = { ...(overrides.settings || {}) };
  return {
    tenantId: "t1",
    getAllRooms: async () => rooms,
    getAllReservations: async () => overrides.reservations ?? [],
    getAllRoomLockAssignments: async () => [],
    getSetting: async (key: string) => (settings[key] ? { value: settings[key] } : undefined),
    getHourlyBookingsOverlapping: async (startAt: Date, endAt: Date, statuses: string[]) =>
      bookings.filter((b: any) =>
        statuses.includes(b.status) &&
        new Date(b.startAt).getTime() < endAt.getTime() &&
        new Date(b.endAt).getTime() > startAt.getTime()),
    createLog: async () => undefined,
  } as any;
}

const unassignedArrival = (over: Record<string, any> = {}) => ({
  roomId: null,
  status: "Confirmed",
  arrival: new Date(T0 - 4 * H),
  departure: new Date(T0 + 20 * H),
  ...over,
});

describe("house reserve for unassigned MEWS arrivals", () => {
  it("counts every free capsule when nothing is unassigned", async () => {
    const svc = new HourlyRentalService(makeHouseStorage(), engine);
    expect(await svc.countBookableRooms(new Date(T0), new Date(T0 + 2 * H))).toBe(2);
  });

  it("holds one capsule back per unassigned arrival overlapping the window", async () => {
    const svc = new HourlyRentalService(
      makeHouseStorage({ reservations: [unassignedArrival()] }),
      engine,
    );
    expect(await svc.countBookableRooms(new Date(T0), new Date(T0 + 2 * H))).toBe(1);
  });

  it("reports nothing bookable when the unassigned arrivals need every free capsule", async () => {
    const svc = new HourlyRentalService(
      makeHouseStorage({ reservations: [unassignedArrival(), unassignedArrival()] }),
      engine,
    );
    expect(await svc.countBookableRooms(new Date(T0), new Date(T0 + 2 * H))).toBe(0);
  });

  it("ignores unassigned reservations outside the window or in a non-blocking state", async () => {
    const svc = new HourlyRentalService(
      makeHouseStorage({
        reservations: [
          unassignedArrival({ arrival: new Date(T0 + 5 * H), departure: new Date(T0 + 20 * H) }), // later today
          unassignedArrival({ status: "Canceled" }),
        ],
      }),
      engine,
    );
    expect(await svc.countBookableRooms(new Date(T0), new Date(T0 + 2 * H))).toBe(2);
  });

  it("counts twins as ONE capsule — the reserve is about physical beds", async () => {
    // Only the 604/604s pair is sellable; one unassigned arrival claims it.
    const svc = new HourlyRentalService(
      makeHouseStorage({
        rooms: [
          { id: "r1", name: "604", label: null, hourlyPool: true, pmsId: "pms-604" },
          { id: "r1s", name: "604s", label: null, hourlyPool: true, pmsId: "pms-604s" },
        ],
        reservations: [unassignedArrival()],
      }),
      engine,
    );
    expect(await svc.countBookableRooms(new Date(T0), new Date(T0 + 2 * H))).toBe(0);
  });

  it("kill switch hourly_unassigned_reserve=false restores the old behaviour", async () => {
    const svc = new HourlyRentalService(
      makeHouseStorage({
        reservations: [unassignedArrival(), unassignedArrival()],
        settings: { hourly_unassigned_reserve: "false" },
      }),
      engine,
    );
    expect(await svc.countBookableRooms(new Date(T0), new Date(T0 + 2 * H))).toBe(2);
  });

  it("still blocks the ASSIGNED twin (the pre-existing guard is untouched)", async () => {
    const svc = new HourlyRentalService(
      makeHouseStorage({
        reservations: [
          { roomId: "r1s", status: "Checked-in", arrival: new Date(T0 - 4 * H), departure: new Date(T0 + 20 * H) },
        ],
      }),
      engine,
    );
    expect(await svc.countBookableRooms(new Date(T0), new Date(T0 + 2 * H))).toBe(1); // only 605 left
  });
});

describe("allocate under the house reserve", () => {
  const FUTURE = new Date(Date.now() + 3 * H);
  const FUTURE_END = new Date(Date.now() + 5 * H);

  function makeAllocWorld(reservations: any[]) {
    const created: any[] = [];
    const logs: any[] = [];
    const storage: any = {
      ...makeHouseStorage({ reservations }),
      createLog: async (l: any) => logs.push(l),
      getRoom: async (id: string) =>
        (await makeHouseStorage().getAllRooms()).find((r: any) => r.id === id),
      createHourlyBooking: async (row: any) => {
        const booking = { id: `hb-${created.length + 1}`, ...row };
        created.push(booking);
        return booking;
      },
    };
    const svc = new HourlyRentalService(storage, { getMewsClient: () => null } as any);
    return { svc, created, logs };
  }

  // Both capsules free, but two arrivals MEWS hasn't assigned yet need them.
  const nowArrival = () =>
    unassignedArrival({ arrival: new Date(Date.now() - H), departure: new Date(Date.now() + 20 * H) });
  const twoUnassigned = [nowArrival(), nowArrival()];

  it("refuses the self-service path — a guest must not buy the arrivals' capsule", async () => {
    const { svc, created, logs } = makeAllocWorld(twoUnassigned);
    await expect(
      (svc as any).allocate({ guestName: "Nina", startAt: FUTURE, endAt: FUTURE_END }, "pending_payment", null),
    ).rejects.toThrow("Ingen ledige capsules");
    expect(created).toEqual([]);
    expect(logs.some(l => l.level === "warn" && l.message.includes("house reserve"))).toBe(true);
  });

  it("lets an ADMIN who names the capsule through, but records the warning", async () => {
    const { svc, created, logs } = makeAllocWorld(twoUnassigned);
    const { booking } = await (svc as any).allocate(
      { guestName: "Nina", roomId: "r1", startAt: FUTURE, endAt: FUTURE_END },
      "pending_payment",
      null,
    );
    expect(booking.roomId).toBe("r1");
    expect(created).toHaveLength(1);
    expect(logs.some(l => l.level === "warn" && l.message.includes("house reserve"))).toBe(true);
  });

  it("sells normally when the house has a capsule to spare", async () => {
    const { svc, created } = makeAllocWorld([nowArrival()]);
    const { booking } = await (svc as any).allocate(
      { guestName: "Nina", startAt: FUTURE, endAt: FUTURE_END },
      "pending_payment",
      null,
    );
    expect(booking.roomId).toBeTruthy();
    expect(created).toHaveLength(1);
  });
});
