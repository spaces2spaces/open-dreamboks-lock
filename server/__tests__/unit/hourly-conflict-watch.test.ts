/**
 * Conflict watch (sweep step 4d) — 19/8-2026 incident, capsule 604.
 *
 * An hourly booking was sold while a walk-in reservation still sat UNASSIGNED
 * in MEWS. 25 minutes later MEWS pinned that reservation to 604s — the twin of
 * the sold capsule, same physical bed, same lock — and our own database held
 * the proof that one bed was promised to two guests. Nothing looked at it.
 *
 * Contract: every confirmed booking with an open window is re-tested against
 * MEWS occupancy. On a collision the booking moves to a genuinely free capsule
 * with the SAME code (hard rule), and when the house has nothing free a
 * critical ops alert goes out immediately.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HourlyRentalService } from "../../hourly-rental-service";

const sentSms: any[] = [];
const sentEmails: any[] = [];
const opsAlerts: Array<{ key: string; severity: string; message: string; detail?: string }> = [];

vi.mock("../../notification-client", () => ({
  createNotificationClient: async () => ({
    sendPlainSMS: async (m: any) => { sentSms.push(m); return { success: true }; },
    sendPlainTextEmail: async (m: any) => { sentEmails.push(m); return { success: true }; },
  }),
}));

vi.mock("../../ops-alert", () => ({
  sendOpsAlert: async (_s: any, key: string, severity: string, message: string, detail?: string) => {
    opsAlerts.push({ key, severity, message, detail });
    return true;
  },
}));

const NOW = Date.now();
const START = new Date(NOW + 2 * 3600_000); // window opens in 2h → guest cannot have arrived
const END = new Date(NOW + 5 * 3600_000);

const SETTINGS: Record<string, string> = {
  hourly_rentals_enabled: "true",
  property_timezone: "Europe/Copenhagen",
  hotel_name: "Capsule inn",
  early_checkin_cleaning_sms_phone: "+4520000000",
};

const LOCK_604 = { id: "ld-604", ttlockId: "tt-604", lockType: "room", name: "604", keyboardPwdVersion: 4 };
const LOCK_605 = { id: "ld-605", ttlockId: "tt-605", lockType: "room", name: "605", keyboardPwdVersion: 4 };
const FRONT_DOOR = { id: "ld-front", ttlockId: "tt-front", lockType: "common", name: "Main entrance", keyboardPwdVersion: 4 };

/** The overnight guest MEWS put on the TWIN space of the capsule we sold. */
const twinGuest = (over: Record<string, any> = {}) => ({
  id: "res-1",
  roomId: "r604s",
  room: "604s",
  firstName: "Ehrling",
  lastName: "Valter",
  status: "Checked-in",
  arrival: new Date(NOW - 4 * 3600_000),
  departure: new Date(NOW + 5 * 24 * 3600_000),
  ...over,
});

function makeWorld(overrides: {
  booking?: Record<string, any>;
  reservations?: any[];
  rooms?: any[];
  settings?: Record<string, string>;
} = {}) {
  const settings = { ...SETTINGS, ...(overrides.settings || {}) };
  const booking: any = {
    id: "hb-1",
    tenantId: "t1",
    roomId: "r604",
    guestName: "Nina Oversell",
    guestEmail: "guest@example.com",
    guestPhone: "+37067046656",
    startAt: START,
    endAt: END,
    status: "confirmed",
    pinCode: "5449",
    amount: "599",
    currency: "DKK",
    lockKeyIds: [
      { lockDeviceId: "ld-604", ttlockId: "tt-604", keyId: "11", lockName: "604" },
      { lockDeviceId: "ld-front", ttlockId: "tt-front", keyId: "12", lockName: "Main entrance" },
    ],
    mewsReservationId: null,
    mewsCheckedInAt: null,
    mewsCheckedOutAt: null,
    createdAt: new Date(NOW - 3600_000),
    ...(overrides.booking || {}),
  };
  const rooms = overrides.rooms ?? [
    { id: "r604", name: "604", label: null, pmsId: "pms-604", hourlyPool: true },
    { id: "r604s", name: "604s", label: null, pmsId: "pms-604s", hourlyPool: false },
    { id: "r605", name: "605", label: null, pmsId: "pms-605", hourlyPool: true },
  ];
  const updates: any[] = [];
  const logs: any[] = [];
  const storage: any = {
    tenantId: "t1",
    getSetting: async (key: string) => (settings[key] ? { value: settings[key] } : undefined),
    getHourlyBooking: async (id: string) => (id === booking.id ? { ...booking } : undefined),
    getHourlyBookings: async () => [{ ...booking }],
    getHourlyBookingsOverlapping: async () => [],
    getAllReservations: async () => overrides.reservations ?? [twinGuest()],
    getRoom: async (id: string) => rooms.find(r => r.id === id),
    getAllRooms: async () => rooms,
    getAllRoomLockAssignments: async () => [],
    getRoomLockAssignments: async (roomId: string) => {
      if (roomId === "r604") return [{ lockDevice: LOCK_604 }, { lockDevice: FRONT_DOOR }];
      if (roomId === "r605") return [{ lockDevice: LOCK_605 }, { lockDevice: FRONT_DOOR }];
      return [];
    },
    updateHourlyBooking: async (id: string, patch: any) => {
      updates.push(patch);
      Object.assign(booking, patch);
      return { ...booking };
    },
    createLog: async (l: any) => logs.push(l),
  };
  const mews: any = {
    getResources: vi.fn(async () => [{ Id: "pms-605", State: "Inspected" }]),
    getReservations: vi.fn(async () => []),
  };
  const ttlock: any = {
    deletePasscode: vi.fn(async () => ({})),
    addPasscode: vi.fn(async () => ({ id: 999 })),
    getUnlockRecords: vi.fn(async () => []),
  };
  const engine: any = { getMewsClient: () => mews, getTTLockClient: () => ttlock };
  const svc = new HourlyRentalService(storage, engine);
  const watch = () => (svc as any).watchMewsConflicts([{ ...booking }], Date.now());
  return { svc, watch, storage, mews, ttlock, booking, updates, logs };
}

beforeEach(() => {
  sentSms.length = 0;
  sentEmails.length = 0;
  opsAlerts.length = 0;
});

describe("conflict watch (sweep 4d)", () => {
  it("moves the booking off a capsule MEWS has since given to an overnight guest — same code", async () => {
    const { watch, booking, ttlock, logs } = makeWorld();
    await watch();

    expect(booking.roomId).toBe("r605");
    // Code moved: old capsule lock revoked, front door untouched, same digits.
    expect(ttlock.deletePasscode).toHaveBeenCalledTimes(1);
    expect(ttlock.deletePasscode).toHaveBeenCalledWith("tt-604", 11);
    expect(ttlock.addPasscode).toHaveBeenCalledTimes(1);
    expect(ttlock.addPasscode.mock.calls[0][0]).toBe("tt-605");
    expect(ttlock.addPasscode.mock.calls[0][1]).toBe("5449");
    // Guest and housekeeping told about the new capsule.
    expect(sentSms.some(m => m.body.includes("has changed") && m.body.includes("605"))).toBe(true);
    expect(sentSms.some(m => m.to === "+4520000000" && m.body.includes("Capsule 605"))).toBe(true);
    // Ops informed of the resolved conflict, naming the overnight guest.
    expect(opsAlerts.some(a => a.severity === "warning" && a.message.includes("flyttet automatisk"))).toBe(true);
    expect(opsAlerts.some(a => a.detail?.includes("Ehrling Valter"))).toBe(true);
    expect(logs.some(l => l.message.includes("conflict watch"))).toBe(true);
  });

  it("alerts CRITICAL and leaves the booking alone when the house has nothing free", async () => {
    const { watch, booking, ttlock } = makeWorld({
      rooms: [
        { id: "r604", name: "604", label: null, pmsId: "pms-604", hourlyPool: true },
        { id: "r604s", name: "604s", label: null, pmsId: "pms-604s", hourlyPool: false },
      ],
    });
    await watch();

    expect(booking.roomId).toBe("r604");
    expect(ttlock.deletePasscode).not.toHaveBeenCalled();
    const alert = opsAlerts.find(a => a.severity === "critical");
    expect(alert?.key).toBe("hourly-mews-conflict:hb-1");
    expect(alert?.message).toContain("DOBBELTBOOKET");
    expect(alert?.detail).toContain("INGEN fri kapsel");
    expect(alert?.detail).toContain("Ehrling Valter");
  });

  it("never moves an ARRIVED hourly guest — that is a human decision", async () => {
    const { watch, booking, ttlock } = makeWorld({ booking: { mewsCheckedInAt: new Date() } });
    await watch();

    expect(booking.roomId).toBe("r604");
    expect(ttlock.addPasscode).not.toHaveBeenCalled();
    expect(opsAlerts.some(a => a.severity === "critical" && a.detail?.includes("allerede ankommet"))).toBe(true);
  });

  it("does nothing when no MEWS reservation touches the capsule or its twin", async () => {
    const { watch, booking, ttlock } = makeWorld({
      reservations: [
        twinGuest({ roomId: "r605", room: "605" }),                                  // another capsule
        twinGuest({ status: "Canceled" }),                                           // not blocking
        twinGuest({ arrival: END, departure: new Date(NOW + 24 * 3600_000) }),        // after the window
      ],
    });
    await watch();

    expect(booking.roomId).toBe("r604");
    expect(ttlock.deletePasscode).not.toHaveBeenCalled();
    expect(opsAlerts).toEqual([]);
  });

  it("kill switch hourly_conflict_watch=false disables the step entirely", async () => {
    const { watch, booking } = makeWorld({ settings: { hourly_conflict_watch: "false" } });
    await watch();
    expect(booking.roomId).toBe("r604");
    expect(opsAlerts).toEqual([]);
  });
});
