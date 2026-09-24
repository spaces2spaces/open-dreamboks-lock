/**
 * Tests for sweep step 4c "follow MEWS resource moves" (6/8 incident,
 * Amer/302): staff moving an hourly day-use reservation on the MEWS timeline
 * must move the booking + code (same digits) in DreamBoks — guarded so a
 * guest is never locked out and an occupied/unknown capsule is never taken.
 * An ARRIVED guest's move is GRACE-followed (owner decision 6/8, "capsule
 * not cleaned" workflow): code live on BOTH capsules, completion only when
 * the guest demonstrably unlocks the new door, rollback when MEWS moves back.
 * Plus the two bundled incident fixes: loud MEWS check-in rejections (4b)
 * and 00-prefix SMS number normalization.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HourlyRentalService, normalizeSmsRecipient } from "../../hourly-rental-service";

const { sentSms, sentEmails, opsAlerts } = vi.hoisted(() => ({
  sentSms: [] as any[],
  sentEmails: [] as any[],
  opsAlerts: [] as any[],
}));

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

const ROOM_LOCK_106 = { id: "ld-106", ttlockId: "tt-106", lockType: "room", name: "Capsule 106", keyboardPwdVersion: 4 };
const ROOM_LOCK_302 = { id: "ld-302", ttlockId: "tt-302", lockType: "room", name: "Capsule 302", keyboardPwdVersion: 4 };
const FRONT_DOOR = { id: "ld-front", ttlockId: "tt-front", lockType: "common", name: "Main entrance", keyboardPwdVersion: 4 };

function makeWorld(overrides: {
  booking?: Record<string, any>;
  settings?: Record<string, string>;
  mews?: Record<string, any>;
  ttlock?: Record<string, any>;
  overlapping?: any[];
  assignments302?: any[];
  updateThrows?: any;
} = {}) {
  const settings = { ...SETTINGS, ...(overrides.settings || {}) };
  const booking: any = {
    id: "hb-1",
    tenantId: "t1",
    roomId: "r106",
    guestName: "Viktoría Blöndal",
    guestEmail: "guest@example.com",
    guestPhone: "0046762500147",
    startAt: START,
    endAt: END,
    status: "confirmed",
    pinCode: "4163",
    lockKeyIds: [
      { lockDeviceId: "ld-106", ttlockId: "tt-106", keyId: "11", lockName: "Capsule 106" },
      { lockDeviceId: "ld-front", ttlockId: "tt-front", keyId: "12", lockName: "Main entrance" },
    ],
    mewsReservationId: "mews-1",
    mewsCheckedInAt: null,
    mewsCheckedOutAt: null,
    createdAt: new Date(NOW - 3600_000),
    ...(overrides.booking || {}),
  };
  const rooms = [
    { id: "r106", name: "106", label: null, pmsId: "pms-106" },
    { id: "r106s", name: "106s", label: null, pmsId: "pms-106s" },
    { id: "r302", name: "302", label: null, pmsId: "pms-302" },
  ];
  const updates: any[] = [];
  const logs: any[] = [];
  const storage: any = {
    getSetting: async (key: string) => (settings[key] ? { value: settings[key] } : undefined),
    getHourlyBooking: async (id: string) => (id === booking.id ? { ...booking } : undefined),
    getHourlyBookings: async () => [{ ...booking }],
    getHourlyBookingsOverlapping: async () => overrides.overlapping || [],
    getAllReservations: async () => [],
    getRoom: async (id: string) => rooms.find(r => r.id === id),
    getAllRooms: async () => rooms,
    getRoomLockAssignments: async (roomId: string) => {
      if (roomId === "r106") return [{ lockDevice: ROOM_LOCK_106 }, { lockDevice: FRONT_DOOR }];
      if (roomId === "r302") return overrides.assignments302 ?? [{ lockDevice: ROOM_LOCK_302 }, { lockDevice: FRONT_DOOR }];
      return [];
    },
    updateHourlyBooking: async (id: string, patch: any) => {
      if (overrides.updateThrows && patch.roomId) throw overrides.updateThrows;
      updates.push(patch);
      Object.assign(booking, patch);
      return { ...booking };
    },
    createLog: async (l: any) => logs.push(l),
  };
  const mews: any = {
    getReservations: vi.fn(async () => [{ Id: "mews-1", State: "Confirmed", AssignedResourceId: "pms-302" }]),
    getResources: vi.fn(async () => [{ State: "Inspected" }]),
    startReservation: vi.fn(async () => ({ success: true })),
    getPaymentRequestsByIds: vi.fn(async () => []),
    ...(overrides.mews || {}),
  };
  const ttlock: any = {
    deletePasscode: vi.fn(async () => ({})),
    addPasscode: vi.fn(async () => ({ id: 999 })),
    getUnlockRecords: vi.fn(async () => []),
    ...(overrides.ttlock || {}),
  };
  const engine: any = { getMewsClient: () => mews, getTTLockClient: () => ttlock };
  const svc = new HourlyRentalService(storage, engine);
  const follow = () => (svc as any).followMewsResourceMoves([{ ...booking }], Date.now());
  return { svc, follow, storage, mews, ttlock, booking, updates, logs };
}

beforeEach(() => {
  sentSms.length = 0;
  sentEmails.length = 0;
  opsAlerts.length = 0;
});

describe("follow MEWS resource moves (sweep 4c)", () => {
  it("moves booking + code to the capsule MEWS shows: room updated, old room-lock code revoked, front door untouched, new lock programmed, guest + cleaning notified", async () => {
    const { follow, ttlock, booking, updates, logs } = makeWorld();
    await follow();

    expect(booking.roomId).toBe("r302");
    // Old capsule lock revoked — the shared front door is NEVER touched.
    expect(ttlock.deletePasscode).toHaveBeenCalledTimes(1);
    expect(ttlock.deletePasscode).toHaveBeenCalledWith("tt-106", 11);
    // Same digits pushed to the NEW capsule lock only (front door already has it).
    expect(ttlock.addPasscode).toHaveBeenCalledTimes(1);
    expect(ttlock.addPasscode.mock.calls[0][0]).toBe("tt-302");
    expect(ttlock.addPasscode.mock.calls[0][1]).toBe("4163");
    // lockKeyIds ends with front door + new lock, old entry gone.
    const finalKeys = booking.lockKeyIds.map((e: any) => e.lockDeviceId).sort();
    expect(finalKeys).toEqual(["ld-302", "ld-front"]);
    // Guest re-notified with the new capsule and the SAME code (and the
    // 0046… number normalized for Twilio).
    const guestSms = sentSms.find(m => m.body.includes("has changed"));
    expect(guestSms?.to).toBe("+46762500147");
    expect(guestSms?.body).toContain("Capsule 302");
    expect(guestSms?.body).toContain("4163#");
    // Cleaning SMS for the NEW capsule.
    expect(sentSms.some(m => m.to === "+4520000000" && m.body.includes("Capsule 302"))).toBe(true);
    expect(logs.some(l => l.level === "info" && l.message.includes("followed MEWS move"))).toBe(true);
    expect(opsAlerts).toEqual([]);
    expect(updates.some(u => u.roomId === "r302")).toBe(true);
  });

  it("treats a move to the TWIN space as a no-op (same physical bed)", async () => {
    const { follow, ttlock, booking, updates } = makeWorld({
      mews: { getReservations: vi.fn(async () => [{ Id: "mews-1", State: "Confirmed", AssignedResourceId: "pms-106s" }]) },
    });
    await follow();
    expect(booking.roomId).toBe("r106");
    expect(updates).toEqual([]);
    expect(ttlock.deletePasscode).not.toHaveBeenCalled();
    expect(opsAlerts).toEqual([]);
  });

  it("GRACE after arrival: code pushed to the NEW capsule, old code untouched, roomId unchanged, guest + cleaning + ops notified", async () => {
    const { follow, booking, ttlock, logs } = makeWorld({ booking: { mewsCheckedInAt: new Date() } });
    await follow();

    // Guest stays in 106 (never locked out) — but the code now also opens 302.
    expect(booking.roomId).toBe("r106");
    expect(ttlock.deletePasscode).not.toHaveBeenCalled();
    expect(ttlock.addPasscode).toHaveBeenCalledTimes(1);
    expect(ttlock.addPasscode.mock.calls[0][0]).toBe("tt-302");
    expect(ttlock.addPasscode.mock.calls[0][1]).toBe("4163");
    const grace = booking.lockKeyIds.find((e: any) => e.lockDeviceId === "ld-302");
    expect(grace?.graceRoomId).toBe("r302");
    expect(grace?.graceSince).toBeTruthy();
    expect(grace?.graceNotifiedAt).toBeTruthy();
    expect(booking.lockKeyIds.some((e: any) => e.lockDeviceId === "ld-106")).toBe(true);
    // Guest told about the new capsule, same code.
    const guestSms = sentSms.find(m => m.body.includes("has changed"));
    expect(guestSms?.body).toContain("Capsule 302");
    expect(guestSms?.body).toContain("4163#");
    // Housekeeping told about the new capsule.
    expect(sentSms.some(m => m.to === "+4520000000" && m.body.includes("Capsule 302"))).toBe(true);
    expect(opsAlerts[0]?.key).toBe("hourly-mews-move:hb-1");
    expect(opsAlerts[0]?.message).toContain("koden virker nu på både");
    expect(logs.some(l => l.message.includes("Hourly grace move:"))).toBe(true);
  });

  it("GRACE after arrival: MEWS state Started counts as arrived (grace push, no roomId change)", async () => {
    const { follow, updates, ttlock } = makeWorld({
      mews: { getReservations: vi.fn(async () => [{ Id: "mews-1", State: "Started", AssignedResourceId: "pms-302" }]) },
    });
    await follow();
    expect(updates.some(u => u.roomId)).toBe(false);
    expect(ttlock.addPasscode).toHaveBeenCalledTimes(1);
    expect(opsAlerts[0]?.message).toContain("efter ankomst");
  });

  it("GRACE after arrival: unlock-record hit inside an open window counts as arrived (grace push, no roomId change)", async () => {
    const { follow, updates, ttlock } = makeWorld({
      booking: { startAt: new Date(NOW - 3600_000) }, // window already open
      ttlock: {
        getUnlockRecords: vi.fn(async () => [{ success: true, keyboardPwd: "4163", lockDate: new Date() }]),
      },
    });
    await follow();
    expect(updates.some(u => u.roomId)).toBe(false);
    expect(ttlock.addPasscode).toHaveBeenCalledTimes(1);
    expect(opsAlerts[0]?.message).toContain("efter ankomst");
  });

  const GRACE_SINCE = new Date(NOW - 3600_000).toISOString(); // grace pushed 1h ago
  const GRACE_KEYS = [
    { lockDeviceId: "ld-106", ttlockId: "tt-106", keyId: "11", lockName: "Capsule 106" },
    { lockDeviceId: "ld-front", ttlockId: "tt-front", keyId: "12", lockName: "Main entrance" },
    { lockDeviceId: "ld-302", ttlockId: "tt-302", keyId: "99", lockName: "Capsule 302", graceRoomId: "r302", graceSince: GRACE_SINCE, graceNotifiedAt: GRACE_SINCE },
  ];

  it("GRACE limbo: grace already pushed, guest has not used the new door → no re-push, no re-SMS, reminder alert only", async () => {
    const { follow, booking, ttlock } = makeWorld({
      booking: { mewsCheckedInAt: new Date(), lockKeyIds: [...GRACE_KEYS] },
    });
    await follow();
    expect(booking.roomId).toBe("r106");
    expect(ttlock.addPasscode).not.toHaveBeenCalled();
    expect(ttlock.deletePasscode).not.toHaveBeenCalled();
    expect(sentSms).toEqual([]);
    expect(opsAlerts[0]?.detail).toContain("Venter på");
  });

  it("GRACE completion: guest unlocks the new capsule → roomId flips, old room-lock code revoked, grace tag dropped, no re-notify", async () => {
    const { follow, booking, ttlock, logs } = makeWorld({
      booking: { mewsCheckedInAt: new Date(), lockKeyIds: [...GRACE_KEYS] },
      ttlock: {
        getUnlockRecords: vi.fn(async (id: string) =>
          id === "tt-302" ? [{ success: true, keyboardPwd: "4163", lockDate: new Date() }] : []),
      },
    });
    await follow();
    expect(booking.roomId).toBe("r302");
    expect(ttlock.addPasscode).not.toHaveBeenCalled();
    expect(ttlock.deletePasscode).toHaveBeenCalledTimes(1);
    expect(ttlock.deletePasscode).toHaveBeenCalledWith("tt-106", 11);
    const finalKeys = booking.lockKeyIds.map((e: any) => e.lockDeviceId).sort();
    expect(finalKeys).toEqual(["ld-302", "ld-front"]);
    expect(booking.lockKeyIds.find((e: any) => e.lockDeviceId === "ld-302")?.graceRoomId).toBeUndefined();
    expect(sentSms).toEqual([]);
    expect(logs.some(l => l.message.includes("grace move COMPLETED"))).toBe(true);
  });

  it("GRACE rollback: MEWS moved back to the booked capsule → extra code revoked, guest told they are back on the original capsule", async () => {
    const { follow, booking, ttlock } = makeWorld({
      booking: { mewsCheckedInAt: new Date(), lockKeyIds: [...GRACE_KEYS] },
      mews: { getReservations: vi.fn(async () => [{ Id: "mews-1", State: "Started", AssignedResourceId: "pms-106" }]) },
    });
    await follow();
    expect(booking.roomId).toBe("r106");
    expect(ttlock.deletePasscode).toHaveBeenCalledTimes(1);
    expect(ttlock.deletePasscode).toHaveBeenCalledWith("tt-302", 99);
    expect(booking.lockKeyIds.map((e: any) => e.lockDeviceId).sort()).toEqual(["ld-106", "ld-front"]);
    // The guest was told "capsule changed to 302" — the rollback must undo that message.
    const sms = sentSms.find(m => m.body.includes("again"));
    expect(sms?.body).toContain("Capsule 106");
    expect(opsAlerts).toEqual([]);
  });

  it("GRACE rollback REFUSED when the guest already unlocked the new capsule: nothing revoked, ops alert", async () => {
    const { follow, booking, ttlock } = makeWorld({
      booking: { mewsCheckedInAt: new Date(), lockKeyIds: [...GRACE_KEYS] },
      mews: { getReservations: vi.fn(async () => [{ Id: "mews-1", State: "Started", AssignedResourceId: "pms-106" }]) },
      ttlock: {
        getUnlockRecords: vi.fn(async (id: string) =>
          id === "tt-302" ? [{ success: true, keyboardPwd: "4163", lockDate: new Date() }] : []),
      },
    });
    await follow();
    expect(ttlock.deletePasscode).not.toHaveBeenCalled();
    expect(booking.lockKeyIds.map((e: any) => e.lockDeviceId).sort()).toEqual(["ld-106", "ld-302", "ld-front"]);
    expect(opsAlerts[0]?.message).toContain("kan IKKE rulles tilbage");
  });

  it("GRACE completion ignores unlock records OLDER than the grace push (stale-record re-grace protection)", async () => {
    const { follow, booking, ttlock } = makeWorld({
      booking: { mewsCheckedInAt: new Date(), lockKeyIds: [...GRACE_KEYS] },
      ttlock: {
        // Record BEFORE graceSince — e.g. the guest's ORIGINAL arrival on a
        // capsule they are being re-graced back to. Must NOT complete.
        getUnlockRecords: vi.fn(async (id: string) =>
          id === "tt-302" ? [{ success: true, keyboardPwd: "4163", lockDate: new Date(NOW - 2 * 3600_000) }] : []),
      },
    });
    await follow();
    expect(booking.roomId).toBe("r106");
    expect(ttlock.deletePasscode).not.toHaveBeenCalled();
    expect(opsAlerts[0]?.detail).toContain("Venter på");
  });

  it("GRACE rollback DEFERRED when unlock records are unreadable: nothing revoked, retry alert", async () => {
    const { follow, booking, ttlock } = makeWorld({
      booking: { mewsCheckedInAt: new Date(), lockKeyIds: [...GRACE_KEYS] },
      mews: { getReservations: vi.fn(async () => [{ Id: "mews-1", State: "Started", AssignedResourceId: "pms-106" }]) },
      ttlock: {
        getUnlockRecords: vi.fn(async (id: string) => {
          if (id === "tt-302") throw new Error("lock offline");
          return [];
        }),
      },
    });
    await follow();
    expect(ttlock.deletePasscode).not.toHaveBeenCalled();
    expect(booking.lockKeyIds.map((e: any) => e.lockDeviceId).sort()).toEqual(["ld-106", "ld-302", "ld-front"]);
    expect(opsAlerts[0]?.message).toContain("oprydning udskudt");
  });

  it("revokePending (failed revoke after completion) is retried unconditionally on later sweeps", async () => {
    const { follow, booking, ttlock } = makeWorld({
      booking: {
        roomId: "r302", // move already completed onto 302
        mewsCheckedInAt: new Date(),
        lockKeyIds: [
          { lockDeviceId: "ld-302", ttlockId: "tt-302", keyId: "55", lockName: "Capsule 302" },
          { lockDeviceId: "ld-front", ttlockId: "tt-front", keyId: "12", lockName: "Main entrance" },
          // Old capsule's revoke failed at completion — re-tagged for retry.
          { lockDeviceId: "ld-106", ttlockId: "tt-106", keyId: "11", lockName: "Capsule 106", graceRoomId: "r106", revokePending: true },
        ],
      },
      mews: { getReservations: vi.fn(async () => [{ Id: "mews-1", State: "Started", AssignedResourceId: "pms-302" }]) },
    });
    await follow();
    // No usage guard for revokePending — the move is already decided.
    expect(ttlock.deletePasscode).toHaveBeenCalledTimes(1);
    expect(ttlock.deletePasscode).toHaveBeenCalledWith("tt-106", 11);
    expect(booking.lockKeyIds.map((e: any) => e.lockDeviceId).sort()).toEqual(["ld-302", "ld-front"]);
    expect(sentSms).toEqual([]); // pure cleanup — no guest messaging
  });

  it("GRACE partial push (room lock fails): guest NOT told, alert says the code did not follow, retried", async () => {
    const { follow, booking, ttlock } = makeWorld({
      booking: { mewsCheckedInAt: new Date() },
      ttlock: { addPasscode: vi.fn(async () => { throw new Error("gateway busy"); }) },
    });
    await follow();
    expect(booking.roomId).toBe("r106");
    expect(sentSms).toEqual([]);
    expect(ttlock.deletePasscode).not.toHaveBeenCalled();
    expect(opsAlerts[0]?.message).toContain("koden fulgte IKKE med");
    expect(opsAlerts[0]?.detail).toContain("rumlås");
  });

  it("GRACE refused onto an occupied capsule: alert, nothing pushed", async () => {
    const { follow, ttlock } = makeWorld({
      booking: { mewsCheckedInAt: new Date() },
      overlapping: [{ id: "hb-2", roomId: "r302", startAt: START, endAt: END, status: "confirmed" }],
    });
    await follow();
    expect(ttlock.addPasscode).not.toHaveBeenCalled();
    expect(opsAlerts[0]?.message).toContain("koden fulgte IKKE med");
    expect(opsAlerts[0]?.detail).toContain("optaget");
  });

  it("a grace TARGET blocks the capsule for other bookings (availability sees graceRoomId)", async () => {
    const { follow, ttlock } = makeWorld({
      booking: { mewsCheckedInAt: new Date() },
      overlapping: [{
        id: "hb-3", roomId: "r999", startAt: START, endAt: END, status: "confirmed",
        lockKeyIds: [{ lockDeviceId: "ld-302", ttlockId: "tt-302", keyId: "77", lockName: "Capsule 302", graceRoomId: "r302" }],
      }],
    });
    await follow();
    expect(ttlock.addPasscode).not.toHaveBeenCalled();
    expect(opsAlerts[0]?.detail).toContain("optaget");
  });

  it("alerts and skips when MEWS shows an unknown resource", async () => {
    const { follow, updates } = makeWorld({
      mews: { getReservations: vi.fn(async () => [{ Id: "mews-1", State: "Confirmed", AssignedResourceId: "pms-999" }]) },
    });
    await follow();
    expect(updates).toEqual([]);
    expect(opsAlerts[0]?.detail).toContain("ikke findes i DreamBoks");
  });

  it("alerts and skips when the target capsule has no room lock", async () => {
    const { follow, updates } = makeWorld({ assignments302: [{ lockDevice: FRONT_DOOR }] });
    await follow();
    expect(updates).toEqual([]);
    expect(opsAlerts[0]?.detail).toContain("ingen rumlås");
  });

  it("alerts and skips when the target capsule is occupied by another hourly booking", async () => {
    const { follow, updates } = makeWorld({
      overlapping: [{ id: "hb-2", roomId: "r302", startAt: START, endAt: END, status: "confirmed" }],
    });
    await follow();
    expect(updates).toEqual([]);
    expect(opsAlerts[0]?.detail).toContain("optaget");
  });

  it("treats a 23P01 exclusion violation on the room update as a lost race (alert, no crash)", async () => {
    const { follow, booking } = makeWorld({ updateThrows: { code: "23P01" } });
    await follow();
    expect(booking.roomId).toBe("r106");
    expect(opsAlerts[0]?.detail).toContain("optaget af en anden booking");
  });

  it("does nothing when the kill switch hourly_follow_mews_moves=false is set", async () => {
    const { follow, mews, updates } = makeWorld({ settings: { hourly_follow_mews_moves: "false" } });
    await follow();
    expect(mews.getReservations).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});

describe("check-in rejections are loud (fix A, 6/8: Amer retried silently for 2h)", () => {
  function checkinWorld() {
    return makeWorld({
      booking: {
        startAt: new Date(NOW - 3600_000), // active window → 4b runs
        endAt: new Date(NOW + 3600_000),
        // lockKeyIds already cover every assignment on r106 → step 3 skips
      },
      mews: {
        // 4c sees no divergence; 4b sees Confirmed and a rejected start.
        getReservations: vi.fn(async () => [{ Id: "mews-1", State: "Confirmed", AssignedResourceId: "pms-106" }]),
        startReservation: vi.fn(async () => ({ success: false, error: "space is occupied" })),
      },
      ttlock: {
        getUnlockRecords: vi.fn(async () => [{ success: true, keyboardPwd: "4163", lockDate: new Date() }]),
      },
    });
  }

  it("warn-logs every rejection and ops-alerts after the 3rd consecutive one", async () => {
    const { svc, booking, logs } = checkinWorld();
    await svc.sweep();
    expect(booking.mewsCheckedInAt).toBeNull();
    const rejects = logs.filter(l => l.level === "warn" && l.message.includes("MEWS REJECTED"));
    expect(rejects.length).toBe(1);
    expect(rejects[0].message).toContain("space is occupied");
    expect(opsAlerts).toEqual([]); // not yet — threshold is 3

    await svc.sweep();
    await svc.sweep();
    expect(opsAlerts.some(a => a.key === "hourly-mews-checkin:hb-1" && a.detail.includes("afvist 3 gange"))).toBe(true);
  });

  it("a successful start resets the rejection counter and stamps mewsCheckedInAt", async () => {
    const world = checkinWorld();
    await world.svc.sweep(); // one rejection
    world.mews.startReservation = vi.fn(async () => ({ success: true }));
    await world.svc.sweep();
    expect(world.booking.mewsCheckedInAt).not.toBeNull();
    expect(opsAlerts).toEqual([]);
  });
});

describe("normalizeSmsRecipient (fix B)", () => {
  it("rewrites 00-prefixed international numbers to +", () => {
    expect(normalizeSmsRecipient("0046762500147")).toBe("+46762500147");
  });
  it("strips separators but keeps valid + numbers", () => {
    expect(normalizeSmsRecipient("+45 20 00-00 00")).toBe("+4520000000");
  });
  it("leaves local numbers and short strings untouched", () => {
    expect(normalizeSmsRecipient("29668682")).toBe("29668682");
    expect(normalizeSmsRecipient("0045")).toBe("0045"); // too short to be 00+CC+number
  });
  it("maps empty input to undefined", () => {
    expect(normalizeSmsRecipient(null)).toBeUndefined();
    expect(normalizeSmsRecipient("  ")).toBeUndefined();
  });
});
