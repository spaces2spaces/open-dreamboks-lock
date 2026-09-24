/**
 * Tests for the hourly-booking ↔ MEWS integration (21/7):
 *  - ensureMewsReservation: gating, night-window creation, soft failure
 *  - capsule assignment AT CREATION (28/7): category ladder + cache, legacy
 *    create-then-pin fallback, ops alert on assignment mismatch
 *  - sweep checkout signal: state transitions + idempotency marker
 *  - ingestion guard: our own MEWS reservations are never ingested
 */

import { describe, it, expect, vi } from "vitest";
import { HourlyRentalService } from "../../hourly-rental-service";
import { IngestionProcessor } from "../../ingestion-processor";

const TZ_SETTINGS: Record<string, string> = {
  hourly_rentals_enabled: "true",
  hourly_mews_reservation_enabled: "true",
  hourly_mews_service_id: "svc-1",
  hourly_mews_rate_id: "rate-1",
  hourly_mews_category_id: "cat-1",
  property_timezone: "Europe/Copenhagen",
  check_in_time: "15:00",
  reservation_checkout_time: "10:00",
};

function makeWorld(overrides: {
  booking?: Partial<Record<string, any>>;
  settings?: Record<string, string>;
  mews?: Partial<Record<string, any>>;
  ttlock?: any;
  reservations?: any[];
} = {}) {
  const settings = { ...TZ_SETTINGS, ...(overrides.settings || {}) };
  const booking: any = {
    id: "hb-1",
    roomId: "r1",
    guestName: "Test Guest",
    guestEmail: "guest@example.com",
    guestPhone: null,
    // 17–23 local on 2026-08-01 (CEST = UTC+2) → 15:00–17:00Z start, night window
    startAt: new Date("2026-08-01T15:00:00Z"), // 17:00 local
    endAt: new Date("2026-08-01T21:00:00Z"),   // 23:00 local
    status: "confirmed",
    pinCode: "1234",
    lockKeyIds: [],
    mewsReservationId: null,
    mewsCustomerId: null,
    mewsCheckedOutAt: null,
    mewsCheckedInAt: null,
    createdAt: new Date("2026-08-01T10:00:00Z"),
    ...(overrides.booking || {}),
  };
  const updates: any[] = [];
  const logs: any[] = [];
  const settingsWrites: Record<string, string> = {};
  const storage: any = {
    getSetting: async (key: string) => (settings[key] ? { value: settings[key] } : undefined),
    setSetting: async (key: string, value: string) => {
      settingsWrites[key] = value;
      settings[key] = value;
      return { key, value };
    },
    getHourlyBooking: async (id: string) => (id === booking.id ? { ...booking } : undefined),
    getHourlyBookings: async () => [{ ...booking }],
    getRoom: async () => ({ id: "r1", name: "401", label: null, pmsId: "res-401" }),
    getAllRooms: async () => [{ id: "r1", name: "401", label: null, pmsId: "res-401" }],
    updateHourlyBooking: async (id: string, patch: any) => {
      updates.push(patch);
      Object.assign(booking, patch);
      return { ...booking };
    },
    createLog: async (l: any) => logs.push(l),
    getRoomLockAssignments: async () => [],
    getAllReservations: async () => overrides.reservations ?? [],
  };
  const mews: any = {
    addCustomer: vi.fn(async () => ({ Id: "cust-1" })),
    createReservation: vi.fn(async () => ({ reservationId: "mews-res-1" })),
    updateReservationAssignedResource: vi.fn(async () => ({ success: true })),
    getReservations: vi.fn(async () => [{ Id: "mews-res-1", State: "Started" }]),
    getServiceResourceCategories: vi.fn(async () => []),
    startReservation: vi.fn(async () => ({ success: true })),
    processReservation: vi.fn(async () => ({ success: true })),
    getPaymentRequestsByIds: vi.fn(async () => []),
    addReservationProduct: vi.fn(async () => undefined),
    addReservationNote: vi.fn(async () => ({})),
    ...(overrides.mews || {}),
  };
  const engine: any = { getMewsClient: () => mews, getTTLockClient: () => overrides.ttlock ?? null };
  const svc = new HourlyRentalService(storage, engine);
  return { svc, storage, mews, booking, updates, logs, settingsWrites };
}

describe("ensureMewsReservation", () => {
  it("does nothing (with warning) when the feature setting is off", async () => {
    const { svc, mews } = makeWorld({ settings: { hourly_mews_reservation_enabled: "false" } });
    const res = await svc.ensureMewsReservation("hb-1");
    expect(res.warnings.some((w) => w.includes("slået fra"))).toBe(true);
    expect(mews.createReservation).not.toHaveBeenCalled();
  });

  it("creates with the booking's EXACT window (24/7) and the capsule assigned+locked AT CREATION (28/7)", async () => {
    const { svc, mews, booking } = makeWorld();
    const res = await svc.ensureMewsReservation("hb-1");
    expect(res.warnings).toEqual([]);
    expect(mews.createReservation).toHaveBeenCalledTimes(1);
    const arg = mews.createReservation.mock.calls[0][0];
    // The TRUE window 17–23 local, not the night shape.
    expect(arg.startUtc.toISOString()).toBe("2026-08-01T15:00:00.000Z");
    expect(arg.endUtc.toISOString()).toBe("2026-08-01T21:00:00.000Z");
    expect(arg.identifier).toBe("hb-1");
    expect(arg.assignedResourceId).toBe("res-401");
    expect(arg.assignedResourceLocked).toBe(true);
    expect(arg.requestedCategoryId).toBe("cat-1");
    // Assigned at creation — the post-create pin must never run.
    expect(mews.updateReservationAssignedResource).not.toHaveBeenCalled();
    expect(booking.mewsReservationId).toBe("mews-res-1");
    expect(booking.mewsCustomerId).toBe("cust-1");
  });

  it("carries the PAID amount as price override (24/7: the reservation must show 399, not the night rate)", async () => {
    const { svc, mews } = makeWorld({ booking: { amount: "399", currency: "DKK" } });
    await svc.ensureMewsReservation("hb-1");
    const arg = mews.createReservation.mock.calls[0][0];
    expect(arg.priceOverride).toEqual({ grossValue: 399, currency: "DKK", taxCode: "DK-S" });
  });

  it("product mode (1/8): reservation at price 0 + paid amount as 'Hour Bookings' product line", async () => {
    const { svc, mews } = makeWorld({
      booking: { amount: "399", currency: "DKK" },
      settings: { hourly_mews_product_id: "prod-hour" },
    });
    const res = await svc.ensureMewsReservation("hb-1");
    expect(res.warnings).toEqual([]);
    const arg = mews.createReservation.mock.calls[0][0];
    expect(arg.priceOverride).toEqual({ grossValue: 0, currency: "DKK", taxCode: "DK-S" });
    expect(mews.addReservationProduct).toHaveBeenCalledWith("mews-res-1", "prod-hour", 1, {
      grossValue: 399,
      currency: "DKK",
      taxCode: "DK-S",
    });
  });

  it("product mode: zero-price rejected by MEWS → paid price on the reservation, NO product line (never double-booked)", async () => {
    const createReservation = vi.fn(async (arg: any) => {
      if (arg.priceOverride?.grossValue === 0) throw new Error("Invalid amount");
      return { reservationId: "mews-res-1" };
    });
    const { svc, mews, booking } = makeWorld({
      booking: { amount: "399", currency: "DKK" },
      settings: { hourly_mews_product_id: "prod-hour" },
      mews: { createReservation },
    });
    const res = await svc.ensureMewsReservation("hb-1");
    expect(res.warnings).toEqual([]);
    expect(booking.mewsReservationId).toBe("mews-res-1");
    const winning = createReservation.mock.calls[createReservation.mock.calls.length - 1][0];
    expect(winning.priceOverride).toEqual({ grossValue: 399, currency: "DKK", taxCode: "DK-S" });
    expect(mews.addReservationProduct).not.toHaveBeenCalled();
  });

  it("product mode: product posting fails → warning + loud log + manual-booking note (revenue missing at price 0)", async () => {
    const { svc, mews, logs } = makeWorld({
      booking: { amount: "399", currency: "DKK" },
      settings: { hourly_mews_product_id: "prod-hour" },
      mews: { addReservationProduct: vi.fn(async () => { throw new Error("403 out of scope"); }) },
    });
    const res = await svc.ensureMewsReservation("hb-1");
    expect(res.warnings.some((w) => w.includes("produktlinjen"))).toBe(true);
    expect(logs.some((l) => l.level === "error" && l.message.includes("revenue is MISSING"))).toBe(true);
    expect(mews.addReservationNote).toHaveBeenCalledWith("mews-res-1", expect.stringContaining("399"));
  });

  it("falls back down the ladder to the NIGHT shape when MEWS rejects the exact window", async () => {
    const createReservation = vi.fn(async (arg: any) => {
      // Reject everything except the night shape (15:00→10:00 local).
      if (arg.startUtc.toISOString() !== "2026-08-01T13:00:00.000Z") throw new Error("Invalid interval");
      return { reservationId: "mews-res-1" };
    });
    const { svc, mews, booking } = makeWorld({ booking: { amount: "399" }, mews: { createReservation } });
    const res = await svc.ensureMewsReservation("hb-1");
    expect(res.warnings).toEqual([]);
    expect(booking.mewsReservationId).toBe("mews-res-1");
    // Ladder: exact+price, exact, night+price (succeeds — night shape reached)
    const nightCall = createReservation.mock.calls.find(c => c[0].startUtc.toISOString() === "2026-08-01T13:00:00.000Z");
    expect(nightCall).toBeDefined();
    expect(nightCall![0].endUtc.toISOString()).toBe("2026-08-02T08:00:00.000Z");
    // Shape rejections keep the assignment — the ladder never falls back to unassigned creation.
    expect(nightCall![0].assignedResourceId).toBe("res-401");
    expect(mews.createReservation).toHaveBeenCalledTimes(3);
  });

  it("soft-fails with a warning + loud log when reservations/add throws", async () => {
    const { svc, booking, logs } = makeWorld({
      mews: { createReservation: vi.fn(async () => { throw new Error("Invalid interval"); }) },
    });
    const res = await svc.ensureMewsReservation("hb-1");
    expect(res.warnings.some((w) => w.includes("kunne ikke oprettes"))).toBe(true);
    expect(booking.mewsReservationId).toBeNull();
    expect(logs.some((l) => l.level === "error" && l.message.includes("MEWS RESERVATION MISSING"))).toBe(true);
  });

  it("is idempotent — an existing mewsReservationId short-circuits", async () => {
    const { svc, mews } = makeWorld({ booking: { mewsReservationId: "already" } });
    await svc.ensureMewsReservation("hb-1");
    expect(mews.createReservation).not.toHaveBeenCalled();
  });
});

describe("capsule assignment at creation (28/7: MEWS online check-in freezes a wrong auto-assignment)", () => {
  // The exact MEWS wording the category ladder keys on (probe-verified 28/7).
  const mismatchError = () =>
    new Error('MEWS API error: 400 - {"Message":"Invalid AssignedResourceId: resource does not belong to the requested category."}');

  it("category mismatch → ladders over the service's categories and caches the hit", async () => {
    const createReservation = vi.fn(async (arg: any) => {
      if (arg.requestedCategoryId !== "cat-2") throw mismatchError();
      return { reservationId: "mews-res-1" };
    });
    const getServiceResourceCategories = vi.fn(async () => [{ Id: "cat-1" }, { Id: "cat-2" }]);
    const { svc, mews, booking, settingsWrites } = makeWorld({ mews: { createReservation, getServiceResourceCategories } });
    const res = await svc.ensureMewsReservation("hb-1");
    expect(res.warnings).toEqual([]);
    expect(createReservation).toHaveBeenCalledTimes(2);
    expect(createReservation.mock.calls[1][0].requestedCategoryId).toBe("cat-2");
    expect(createReservation.mock.calls[1][0].assignedResourceId).toBe("res-401");
    expect(mews.updateReservationAssignedResource).not.toHaveBeenCalled();
    expect(booking.mewsReservationId).toBe("mews-res-1");
    expect(JSON.parse(settingsWrites["hourly_mews_resource_category_map"])).toEqual({ "res-401": "cat-2" });
  });

  it("a cached category is used on the FIRST attempt (no ladder, no extra calls)", async () => {
    const { svc, mews } = makeWorld({
      settings: { hourly_mews_resource_category_map: JSON.stringify({ "res-401": "cat-9" }) },
    });
    await svc.ensureMewsReservation("hb-1");
    expect(mews.createReservation).toHaveBeenCalledTimes(1);
    expect(mews.createReservation.mock.calls[0][0].requestedCategoryId).toBe("cat-9");
    expect(mews.getServiceResourceCategories).not.toHaveBeenCalled();
  });

  it("all categories rejected → legacy unassigned create + post-create pin still lands the capsule", async () => {
    const createReservation = vi.fn(async (arg: any) => {
      if (arg.assignedResourceId) throw mismatchError();
      return { reservationId: "mews-res-1" };
    });
    const getServiceResourceCategories = vi.fn(async () => [{ Id: "cat-1" }, { Id: "cat-2" }]);
    const { svc, mews, booking } = makeWorld({
      mews: {
        createReservation,
        getServiceResourceCategories,
        getReservations: vi.fn(async () => [{ Id: "mews-res-1", State: "Confirmed", AssignedResourceId: "res-OTHER" }]),
      },
    });
    const res = await svc.ensureMewsReservation("hb-1");
    expect(res.warnings).toEqual([]);
    // cat-1 (setting) + cat-2 (service list) assigned attempts, then one legacy create.
    expect(createReservation).toHaveBeenCalledTimes(3);
    expect(createReservation.mock.calls[2][0].assignedResourceId).toBeUndefined();
    expect(mews.updateReservationAssignedResource).toHaveBeenCalledWith("mews-res-1", "res-401");
    expect(booking.mewsReservationId).toBe("mews-res-1");
  });

  it("legacy fallback: auto-assignment already on the booked capsule skips the pin", async () => {
    const createReservation = vi.fn(async (arg: any) => {
      if (arg.assignedResourceId) throw mismatchError();
      return { reservationId: "mews-res-1" };
    });
    const { svc, mews } = makeWorld({
      mews: {
        createReservation,
        getReservations: vi.fn(async () => [{ Id: "mews-res-1", State: "Confirmed", AssignedResourceId: "res-401" }]),
      },
    });
    await svc.ensureMewsReservation("hb-1");
    expect(mews.updateReservationAssignedResource).not.toHaveBeenCalled();
  });

  it("pin failure in the fallback → warning + ops alert so housekeeping compensation can run", async () => {
    const createReservation = vi.fn(async (arg: any) => {
      if (arg.assignedResourceId) throw mismatchError();
      return { reservationId: "mews-res-1" };
    });
    const { svc, logs } = makeWorld({
      mews: {
        createReservation,
        getReservations: vi.fn(async () => [{ Id: "mews-res-1", State: "Confirmed", AssignedResourceId: "res-OTHER" }]),
        updateReservationAssignedResource: vi.fn(async () => ({
          success: false,
          error: "403 - Cannot move reservation. Please unlock and try again.",
        })),
      },
    });
    const res = await svc.ensureMewsReservation("hb-1");
    expect(res.warnings.some((w) => w.includes("capsule-tildeling fejlede"))).toBe(true);
    expect(logs.some((l) => l.level === "error" && l.message.includes("resource assignment failed"))).toBe(true);
    // No lock_arrival_report_email configured in the mock world → sendOpsAlert
    // logs the alert loudly instead of mailing; the alert content must name the
    // mismatch so the operator knows which capsule the guest's code opens.
    expect(logs.some((l) => l.message.includes("OPS ALERT") && l.message.includes("forkert kapsel"))).toBe(true);
  });
});

/**
 * 19/8-2026 (capsule 604): MEWS answered every creation
 * attempt with 403 "no availability" — its verdict that the house is FULL, i.e.
 * we just sold a capsule that does not exist. The old code logged it as a soft
 * failure and retried 12 calls every 5 minutes in silence for hours.
 */
describe("MEWS says the house is full (oversell)", () => {
  const noAvailability = () =>
    vi.fn(async () => {
      throw new Error(
        'MEWS API error: 403 - {"Message":"We\'re very sorry, this property has no availability for the selected dates."}',
      );
    });

  it("alerts ops (critical) instead of degrading quietly", async () => {
    const { svc, logs } = makeWorld({
      booking: { amount: "599", currency: "DKK", guestName: "Nina Oversell" },
      mews: { createReservation: noAvailability() },
    });
    const res = await svc.ensureMewsReservation("hb-1");

    expect(res.warnings.some((w) => w.includes("UDSOLGT"))).toBe(true);
    expect(logs.some((l) => l.level === "error" && l.message.includes("MEWS RESERVATION MISSING"))).toBe(true);
    // No lock_arrival_report_email in the mock world → sendOpsAlert logs loudly.
    const alert = logs.find((l) => l.message.includes("OPS ALERT"));
    expect(alert?.message).toContain("critical");
    expect(alert?.message).toContain("OVERSOLGT");
    expect(alert?.message).toContain("Nina Oversell");
  });

  it("backs off instead of hammering MEWS on every 5-minute sweep", async () => {
    const createReservation = noAvailability();
    const { svc, mews } = makeWorld({
      booking: {
        startAt: new Date(Date.now() + 4 * 3600_000),
        endAt: new Date(Date.now() + 8 * 3600_000),
      },
      mews: { createReservation },
    });

    await svc.ensureMewsReservation("hb-1");
    const callsAfterFirst = mews.createReservation.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await svc.sweep();
    expect(mews.createReservation.mock.calls.length).toBe(callsAfterFirst); // no retry inside 30 min
  });

  it("keeps retrying normally for any OTHER MEWS rejection", async () => {
    const createReservation = vi.fn(async () => {
      throw new Error("MEWS API error: 500 - temporary");
    });
    const { svc, mews } = makeWorld({
      booking: {
        startAt: new Date(Date.now() + 4 * 3600_000),
        endAt: new Date(Date.now() + 8 * 3600_000),
      },
      mews: { createReservation },
    });

    await svc.ensureMewsReservation("hb-1");
    const callsAfterFirst = mews.createReservation.mock.calls.length;
    await svc.sweep();
    expect(mews.createReservation.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

describe("sweep checkout signal", () => {
  it("Started reservation → process + mewsCheckedOutAt set", async () => {
    const { svc, mews, booking } = makeWorld({
      booking: {
        mewsReservationId: "mews-res-1",
        startAt: new Date(Date.now() - 4 * 3600_000),
        endAt: new Date(Date.now() - 3600_000),
      },
    });
    await svc.sweep();
    expect(mews.processReservation).toHaveBeenCalledWith("mews-res-1");
    expect(booking.mewsCheckedOutAt).toBeInstanceOf(Date);
  });

  it("Confirmed reservation → start THEN process (mirror of check-in signal)", async () => {
    const { svc, mews, booking } = makeWorld({
      booking: {
        mewsReservationId: "mews-res-1",
        startAt: new Date(Date.now() - 4 * 3600_000),
        endAt: new Date(Date.now() - 3600_000),
      },
      mews: { getReservations: vi.fn(async () => [{ Id: "mews-res-1", State: "Confirmed" }]) },
    });
    await svc.sweep();
    expect(mews.startReservation).toHaveBeenCalledWith("mews-res-1");
    expect(mews.processReservation).toHaveBeenCalledWith("mews-res-1");
    expect(booking.mewsCheckedOutAt).toBeInstanceOf(Date);
  });

  it("already Processed → marked done without calling process", async () => {
    const { svc, mews, booking } = makeWorld({
      booking: {
        mewsReservationId: "mews-res-1",
        startAt: new Date(Date.now() - 4 * 3600_000),
        endAt: new Date(Date.now() - 3600_000),
      },
      mews: { getReservations: vi.fn(async () => [{ Id: "mews-res-1", State: "Processed" }]) },
    });
    await svc.sweep();
    expect(mews.processReservation).not.toHaveBeenCalled();
    expect(booking.mewsCheckedOutAt).toBeInstanceOf(Date);
  });

  it("EXPIRED bookings are included (sweep flips confirmed→expired 1h after endAt)", async () => {
    const { svc, mews, booking } = makeWorld({
      booking: {
        status: "expired",
        mewsReservationId: "mews-res-1",
        startAt: new Date(Date.now() - 5 * 3600_000),
        endAt: new Date(Date.now() - 2 * 3600_000),
      },
    });
    await svc.sweep();
    expect(mews.processReservation).toHaveBeenCalled();
    expect(booking.mewsCheckedOutAt).toBeInstanceOf(Date);
  });

  it("future endAt → no checkout yet", async () => {
    const { svc, mews } = makeWorld({
      booking: {
        mewsReservationId: "mews-res-1",
        startAt: new Date(Date.now() - 3600_000),
        endAt: new Date(Date.now() + 3600_000),
      },
    });
    await svc.sweep();
    expect(mews.processReservation).not.toHaveBeenCalled();
  });
});

describe("sweep check-in signal (28/7: same principle as overnight — code must be USED)", () => {
  const activeBooking = {
    mewsReservationId: "mews-res-1",
    startAt: new Date(Date.now() - 3600_000),
    endAt: new Date(Date.now() + 2 * 3600_000),
    lockKeyIds: [{ lockDeviceId: "ld1", ttlockId: "111", keyId: "k1", lockName: "207" }],
  };

  it("code used on a lock → reservations/start + mewsCheckedInAt", async () => {
    const { svc, mews, booking } = makeWorld({
      booking: activeBooking,
      mews: { getReservations: vi.fn(async () => [{ Id: "mews-res-1", State: "Confirmed" }]) },
      ttlock: { getUnlockRecords: vi.fn(async () => [{ success: true, keyboardPwd: "1234", lockDate: new Date() }]) },
    });
    await svc.sweep();
    expect(mews.startReservation).toHaveBeenCalledWith("mews-res-1");
    expect(booking.mewsCheckedInAt).toBeInstanceOf(Date);
  });

  it("code NOT used yet → no check-in", async () => {
    const { svc, mews, booking } = makeWorld({
      booking: activeBooking,
      mews: { getReservations: vi.fn(async () => [{ Id: "mews-res-1", State: "Confirmed" }]) },
      ttlock: { getUnlockRecords: vi.fn(async () => [{ success: true, keyboardPwd: "9999", lockDate: new Date() }]) },
    });
    await svc.sweep();
    expect(mews.startReservation).not.toHaveBeenCalled();
    expect(booking.mewsCheckedInAt).toBeNull();
  });

  it("already Started in MEWS (staff/online check-in) → flag only, no start call", async () => {
    const { svc, mews, booking } = makeWorld({
      booking: activeBooking,
      mews: { getReservations: vi.fn(async () => [{ Id: "mews-res-1", State: "Started" }]) },
    });
    await svc.sweep();
    expect(mews.startReservation).not.toHaveBeenCalled();
    expect(booking.mewsCheckedInAt).toBeInstanceOf(Date);
  });
});

describe("sweep hold release — status semantics (24/7)", () => {
  // "cancelled" = never a real booking (abandoned/refused hold);
  // "expired" = finished REAL booking. Mixing them put phantom rows with
  // cleaning tasks on the arrivals list.
  it("a stale unpaid hold is released as CANCELLED, not expired", async () => {
    const { svc, booking } = makeWorld({
      booking: {
        status: "pending_payment",
        pinCode: null,
        createdAt: new Date(Date.now() - 2 * 3600_000),
        startAt: new Date(Date.now() + 3600_000),
        endAt: new Date(Date.now() + 4 * 3600_000),
      },
    });
    await svc.sweep();
    expect(booking.status).toBe("cancelled");
  });

  it("a MEWS payment request in state Canceled releases the hold as CANCELLED", async () => {
    const { svc, booking } = makeWorld({
      booking: {
        status: "pending_payment",
        pinCode: null,
        paymentProvider: "mews",
        paymentRef: "pr-1",
        createdAt: new Date(Date.now() - 5 * 60_000),
        startAt: new Date(Date.now() + 3600_000),
        endAt: new Date(Date.now() + 4 * 3600_000),
      },
      mews: { getPaymentRequestsByIds: vi.fn(async () => [{ Id: "pr-1", State: "Canceled" }]) },
    });
    await svc.sweep();
    expect(booking.status).toBe("cancelled");
  });

  it("a FINISHED confirmed booking still becomes EXPIRED", async () => {
    const { svc, booking } = makeWorld({
      booking: {
        startAt: new Date(Date.now() - 5 * 3600_000),
        endAt: new Date(Date.now() - 2 * 3600_000),
      },
    });
    await svc.sweep();
    expect(booking.status).toBe("expired");
  });
});

describe("ingestion guard", () => {
  function makeProcessor(hasHourlyMatch: boolean) {
    const calls: string[] = [];
    const storage: any = {
      getHourlyBookingByMewsReservationId: async () => (hasHourlyMatch ? { id: "hb-1" } : undefined),
      getReservationByPmsId: async (id: string) => { calls.push(`getReservationByPmsId:${id}`); return undefined; },
      getRoomByPmsId: async () => { calls.push("getRoomByPmsId"); return undefined; },
      createReservation: async (r: any) => { calls.push("createReservation"); return { id: "res-local", ...r }; },
      createLog: async () => {},
      getSetting: async () => undefined,
    };
    const engine: any = { getPinLifecycle: () => ({}) };
    const processor = new IngestionProcessor(() => storage, engine);
    return { processor, calls };
  }

  const event: any = {
    eventType: "reservation.upserted",
    tenantId: "t1",
    data: {
      pmsReservationId: "mews-res-1",
      status: "Confirmed",
      arrival: new Date(Date.now() + 3600_000).toISOString(),
      departure: new Date(Date.now() + 24 * 3600_000).toISOString(),
      guest: { firstName: "A", lastName: "B" },
    },
  };

  it("skips reservations created by our own hourly flow (no local row, no pin)", async () => {
    const { processor, calls } = makeProcessor(true);
    await processor.processReservationUpserted(event);
    expect(calls).toEqual([]); // returned before ANY other storage access
  });

  it("processes normal reservations as before", async () => {
    const { processor, calls } = makeProcessor(false);
    await processor.processReservationUpserted(event).catch(() => {});
    expect(calls.length).toBeGreaterThan(0);
  });

  it("churn-breaker (26/7 Gogoua mail storm): a NEW reservation whose pin window is already over is never created", async () => {
    // Raw departure later today (passes the raw-departure guard) while the
    // checkout-normalized window (checkout 00:00 → departure-day midnight)
    // is already past → must return before createReservation.
    const calls: string[] = [];
    const storage: any = {
      getHourlyBookingByMewsReservationId: async () => undefined,
      getReservationByPmsId: async () => undefined,
      getRoomByPmsId: async () => { calls.push("getRoomByPmsId"); return undefined; },
      createReservation: async () => { calls.push("createReservation"); return { id: "x" }; },
      createLog: async () => {},
      getSetting: async (key: string) =>
        key === "reservation_checkout_time" ? { value: "00:00" } : undefined,
    };
    const processor = new IngestionProcessor(() => storage, { getPinLifecycle: () => ({}) } as any);
    const endOfToday = new Date(); endOfToday.setHours(23, 59, 0, 0);
    const yesterday = new Date(Date.now() - 24 * 3600_000);
    await processor.processReservationUpserted({
      eventType: "reservation.upserted",
      tenantId: "t1",
      data: {
        pmsReservationId: "mews-ghost-1",
        status: "Confirmed",
        arrival: yesterday.toISOString(),
        departure: endOfToday.toISOString(),
        guest: { firstName: "Gnoupale", lastName: "Gogoua" },
      },
    } as any);
    expect(calls).not.toContain("createReservation");
  });
});
