/**
 * Tests for front-door arrival detection (_jobLockArrivals) in
 * ReservationStateMachine.
 *
 * Scenario: a guest completes online check-in, gets a numeric PIN on the
 * boarding card, and enters using the CODE on the keypad of a common/front
 * door — without pressing the remote-unlock button. The job must detect this
 * keypad usage and trigger the same MEWS check-in the button does, so the
 * guest is never falsely marked no-show.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ReservationStateMachine } from "../../reservation-state-machine";
import { makeReservation, makePin, makeLockDevice } from "../fixtures/reservations";
import type { Reservation, Pin, LockDevice } from "@shared/schema";

interface UnlockRecord {
  lockId: number;
  recordType: number;
  success: boolean;
  username: string;
  keyboardPwd?: string;
  lockDate: Date;
  serverDate: Date;
}

function createStorage(settings: Record<string, string>) {
  const pins: Pin[] = [];
  const reservations: Reservation[] = [];
  const lockDevices: LockDevice[] = [];
  const logs: any[] = [];

  return {
    _pins: pins,
    _reservations: reservations,
    _lockDevices: lockDevices,
    _logs: logs,

    async getSetting(key: string) {
      const v = settings[key];
      return v !== undefined ? { value: v } : null;
    },
    async getAllLockDevices() {
      return [...lockDevices];
    },
    async getAllPins() {
      return [...pins];
    },
    async getReservation(id: string) {
      return reservations.find((r) => r.id === id);
    },
    async updatePinFirstUsedAt(id: string, date: Date) {
      const p = pins.find((p) => p.id === id);
      if (p) p.firstUsedAt = date;
    },
    async updatePin(id: string, data: Partial<Pin>) {
      const p = pins.find((p) => p.id === id);
      if (p) Object.assign(p, data);
      return p;
    },
    async updateReservation(id: string, data: Partial<Reservation>) {
      const r = reservations.find((r) => r.id === id);
      if (r) Object.assign(r, data);
      return r;
    },
    async createLog(log: any) {
      logs.push(log);
    },

    // Needed by _jobNoshow:
    async getPinsByRoomId(roomId: string) {
      return pins.filter((p) => p.roomId === roomId);
    },
    async getMappedReservationsByArrivalRange(_start: Date, _end: Date) {
      return [...reservations];
    },
  };
}

function createTTLock() {
  const recordsByLock = new Map<string, UnlockRecord[]>();
  return {
    _setRecords(ttlockId: string, recs: UnlockRecord[]) {
      recordsByLock.set(ttlockId, recs);
    },
    async getAllUnlockRecordsSince(lockId: string, since: Date) {
      const recs = recordsByLock.get(lockId) || [];
      return recs.filter((r) => r.lockDate.getTime() >= since.getTime());
    },
  };
}

function createMews() {
  const started: string[] = [];
  return {
    _started: started,
    async startReservation(pmsId: string) {
      started.push(pmsId);
      return { success: true };
    },
  };
}

function createEngine(ttlock: ReturnType<typeof createTTLock> | null) {
  return {
    getTTLockClient: () => ttlock,
  };
}

function makeKeypadRecord(code: string, lockDate: Date): UnlockRecord {
  return {
    lockId: 1,
    recordType: 4, // TTLock: 4 = passcode (keypad) unlock — carries the code in keyboardPwd
    success: true,
    username: "guest",
    keyboardPwd: code,
    lockDate,
    serverDate: lockDate,
  };
}

// An app/Bluetooth unlock (recordType 1) carries NO passcode — must be ignored.
function makeAppUnlockRecord(lockDate: Date): UnlockRecord {
  return {
    lockId: 1,
    recordType: 1,
    success: true,
    username: "guest",
    keyboardPwd: undefined,
    lockDate,
    serverDate: lockDate,
  };
}

const TENANT = "test-tenant";

describe("ReservationStateMachine._jobLockArrivals (front-door arrival detection)", () => {
  let now: Date;
  let validFrom: Date;
  let validTo: Date;

  beforeEach(() => {
    now = new Date();
    validFrom = new Date(now.getTime() - 60 * 60 * 1000); // 1h ago
    validTo = new Date(now.getTime() + 24 * 60 * 60 * 1000); // tomorrow
  });

  function setupCommonLock(storage: ReturnType<typeof createStorage>, ttlockId = "common-1") {
    const lock = makeLockDevice({ ttlockId, lockType: "common", name: "Street Entrance" });
    storage._lockDevices.push(lock);
    return lock;
  }

  function setupGuest(
    storage: ReturnType<typeof createStorage>,
    code: string,
    overrides: { status?: string } = {}
  ) {
    const reservation = makeReservation({
      id: "res-1",
      roomId: "room-1",
      pmsId: "PMS-RES-1",
      status: overrides.status ?? "Confirmed",
    });
    const pin = makePin({
      id: "pin-1",
      reservationId: reservation.id,
      roomId: "room-1",
      code,
      status: "active",
      firstUsedAt: null,
      validFrom,
      validTo,
    });
    storage._reservations.push(reservation);
    storage._pins.push(pin);
    return { reservation, pin };
  }

  it("checks in a guest who entered with their code on a common door", async () => {
    const storage = createStorage({ lock_arrival_checkin_enabled: "true" });
    const ttlock = createTTLock();
    const mews = createMews();
    const lock = setupCommonLock(storage);
    const { reservation, pin } = setupGuest(storage, "4829");

    ttlock._setRecords(lock.ttlockId, [makeKeypadRecord("4829", now)]);

    const sm = new ReservationStateMachine(
      storage as any,
      createEngine(ttlock) as any,
      mews as any,
      TENANT
    );

    await sm._jobLockArrivals();

    // MEWS check-in triggered (same call as the boarding-card button)
    expect(mews._started).toContain("PMS-RES-1");
    // PIN marked used with the actual lock timestamp
    expect(pin.firstUsedAt).toEqual(now);
    expect(pin.status).toBe("used");
    // Reservation flagged checked-in via lock
    expect(reservation.status).toBe("checked-in");
    expect(reservation.pmsCheckinSource).toBe("lock");
  });

  it("does NOT mark the guest as no-show after a lock arrival check-in", async () => {
    const storage = createStorage({
      lock_arrival_checkin_enabled: "true",
      noshow_enabled: "true",
      latest_arrival_time: "00:00", // ensure no-show time gate is past
    });
    const ttlock = createTTLock();
    const mews = createMews();
    const lock = setupCommonLock(storage);
    const { reservation } = setupGuest(storage, "4829");

    ttlock._setRecords(lock.ttlockId, [makeKeypadRecord("4829", now)]);

    const sm = new ReservationStateMachine(
      storage as any,
      createEngine(ttlock) as any,
      mews as any,
      TENANT
    );

    await sm._jobLockArrivals();
    // No-show runs afterwards in the same cycle — must skip the checked-in guest
    await (sm as any)._jobNoshow();

    expect(reservation.status).toBe("checked-in");
    expect(reservation.status).not.toBe("no-show");
  });

  it("does nothing for an unknown code (no matching PIN)", async () => {
    const storage = createStorage({ lock_arrival_checkin_enabled: "true" });
    const ttlock = createTTLock();
    const mews = createMews();
    const lock = setupCommonLock(storage);
    const { reservation, pin } = setupGuest(storage, "4829");

    // Someone keys a code that matches no active PIN
    ttlock._setRecords(lock.ttlockId, [makeKeypadRecord("9999", now)]);

    const sm = new ReservationStateMachine(
      storage as any,
      createEngine(ttlock) as any,
      mews as any,
      TENANT
    );

    await sm._jobLockArrivals();

    expect(mews._started).toHaveLength(0);
    expect(pin.firstUsedAt).toBeNull();
    expect(pin.status).toBe("active");
    expect(reservation.status).toBe("Confirmed");
  });

  it("ignores app/Bluetooth unlocks that carry no passcode (recordType != passcode)", async () => {
    // Regression: the original filter required recordType === 1 (app unlock) AND
    // a keyboardPwd — a contradiction that matched nothing, so real keypad
    // unlocks (recordType 4) were never detected. A passcode record must match;
    // an app unlock (no keyboardPwd) must not.
    const storage = createStorage({ lock_arrival_checkin_enabled: "true" });
    const ttlock = createTTLock();
    const mews = createMews();
    const lock = setupCommonLock(storage);
    const { reservation, pin } = setupGuest(storage, "4829");

    // Only an app unlock (no passcode) on the door → must NOT check in
    ttlock._setRecords(lock.ttlockId, [makeAppUnlockRecord(now)]);

    const sm = new ReservationStateMachine(
      storage as any,
      createEngine(ttlock) as any,
      mews as any,
      TENANT
    );

    await sm._jobLockArrivals();

    expect(mews._started).toHaveLength(0);
    expect(pin.firstUsedAt).toBeNull();
    expect(reservation.status).toBe("Confirmed");

    // Now the guest taps the actual passcode (recordType 4) → must check in
    ttlock._setRecords(lock.ttlockId, [makeKeypadRecord("4829", now)]);
    await sm._jobLockArrivals(true); // force=true to bypass the hourly time-gate

    expect(mews._started).toContain("PMS-RES-1");
    expect(pin.firstUsedAt).toEqual(now);
    expect(reservation.status).toBe("checked-in");
    expect(reservation.pmsCheckinSource).toBe("lock");
  });

  it("is disabled when lock_arrival_checkin_enabled is not 'true'", async () => {
    const storage = createStorage({}); // flag absent → off
    const ttlock = createTTLock();
    const mews = createMews();
    const lock = setupCommonLock(storage);
    const { reservation, pin } = setupGuest(storage, "4829");

    ttlock._setRecords(lock.ttlockId, [makeKeypadRecord("4829", now)]);

    const sm = new ReservationStateMachine(
      storage as any,
      createEngine(ttlock) as any,
      mews as any,
      TENANT
    );

    await sm._jobLockArrivals();

    expect(mews._started).toHaveLength(0);
    expect(pin.firstUsedAt).toBeNull();
    expect(reservation.status).toBe("Confirmed");
  });

  it("log-only mode logs the intended check-in without writing to MEWS or DB", async () => {
    const storage = createStorage({
      lock_arrival_checkin_enabled: "true",
      lock_arrival_log_only: "true",
    });
    const ttlock = createTTLock();
    const mews = createMews();
    const lock = setupCommonLock(storage);
    const { reservation, pin } = setupGuest(storage, "4829");

    ttlock._setRecords(lock.ttlockId, [makeKeypadRecord("4829", now)]);

    const sm = new ReservationStateMachine(
      storage as any,
      createEngine(ttlock) as any,
      mews as any,
      TENANT
    );

    await sm._jobLockArrivals();

    // No side effects beyond a log line
    expect(mews._started).toHaveLength(0);
    expect(pin.firstUsedAt).toBeNull();
    expect(pin.status).toBe("active");
    expect(reservation.status).toBe("Confirmed");
    expect(storage._logs.some((l) => String(l.message).includes("log-only"))).toBe(true);
  });

  it("ignores keypad records outside the PIN validity window", async () => {
    const storage = createStorage({ lock_arrival_checkin_enabled: "true" });
    const ttlock = createTTLock();
    const mews = createMews();
    const lock = setupCommonLock(storage);
    const { reservation, pin } = setupGuest(storage, "4829");

    // Record stamped before the PIN became valid (e.g. an old/stale record)
    const beforeWindow = new Date(validFrom.getTime() - 2 * 60 * 60 * 1000);
    ttlock._setRecords(lock.ttlockId, [makeKeypadRecord("4829", beforeWindow)]);

    const sm = new ReservationStateMachine(
      storage as any,
      createEngine(ttlock) as any,
      mews as any,
      TENANT
    );

    await sm._jobLockArrivals();

    expect(mews._started).toHaveLength(0);
    expect(pin.firstUsedAt).toBeNull();
    expect(reservation.status).toBe("Confirmed");
  });

  it("does not poll when no common locks exist (room locks ignored)", async () => {
    const storage = createStorage({ lock_arrival_checkin_enabled: "true" });
    const ttlock = createTTLock();
    const mews = createMews();
    // Only a room lock — must be ignored
    const roomLock = makeLockDevice({ ttlockId: "room-99", lockType: "room", name: "Room Lock 101" });
    storage._lockDevices.push(roomLock);
    const { reservation, pin } = setupGuest(storage, "4829");

    ttlock._setRecords("room-99", [makeKeypadRecord("4829", now)]);

    const sm = new ReservationStateMachine(
      storage as any,
      createEngine(ttlock) as any,
      mews as any,
      TENANT
    );

    await sm._jobLockArrivals();

    expect(mews._started).toHaveLength(0);
    expect(pin.firstUsedAt).toBeNull();
    expect(reservation.status).toBe("Confirmed");
  });

  it("overnight safety net rescues a no-show'd guest who used their code on the capsule", async () => {
    // The tailgating case: guest only tapped their CAPSULE lock (not a common
    // door), so the hourly front-door poll missed them and the 23:00 job flagged
    // them no-show. The 05:00 safety net (before MEWS' 06:00 audit) must catch it.
    const storage = createStorage({
      lock_arrival_checkin_enabled: "true",
      lock_arrival_safety_net_time: "00:00", // keep the time-gate open during tests
    });
    const ttlock = createTTLock();
    const mews = createMews();

    const reservation = makeReservation({
      id: "res-1", roomId: "room-1", pmsId: "PMS-RES-1", status: "no-show",
    });
    const pin = makePin({
      id: "pin-1", reservationId: "res-1", roomId: "room-1", code: "4829",
      status: "active", firstUsedAt: null, validFrom, validTo,
      roomLockKeyIds: [{ ttlockId: "capsule-1", keyId: "k1" }],
      commonAreaKeyIds: [{ ttlockId: "street-1", keyId: "k2" }],
    });
    storage._reservations.push(reservation);
    storage._pins.push(pin);

    // Code only seen on the CAPSULE lock — common doors have nothing.
    ttlock._setRecords("capsule-1", [makeKeypadRecord("4829", now)]);

    const sm = new ReservationStateMachine(
      storage as any,
      createEngine(ttlock) as any,
      mews as any,
      TENANT
    );

    await sm._jobCapsuleSafetyNet();

    // Rescued: checked in to MEWS, PIN marked used, no-show reversed.
    expect(mews._started).toContain("PMS-RES-1");
    expect(pin.firstUsedAt).toEqual(now);
    expect(pin.status).toBe("used");
    expect(reservation.status).toBe("checked-in");
    expect(reservation.pmsCheckinSource).toBe("lock");
  });
});

/**
 * MEWS REJECTION handling (the Martinsen incident, 16-17 July):
 * startReservation never throws — it returns {success:false, error}. If that
 * flag is ignored, a rejected check-in is reported as success: the guest shows
 * as checked in locally while MEWS stays Confirmed, and MEWS' 06:00 no-show
 * audit cancels them → door codes removed while they're in the building.
 */
describe("ReservationStateMachine — MEWS rejects the check-in (success:false)", () => {
  const now = new Date();
  const validFrom = new Date(now.getTime() - 60 * 60 * 1000);
  const validTo = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  function createRejectingMews(error = "MEWS API error: 403 - assigned space is blocked") {
    const attempts: string[] = [];
    return {
      _attempts: attempts,
      async startReservation(pmsId: string) {
        attempts.push(pmsId);
        return { success: false, error };
      },
    };
  }

  it("keeps the guest Confirmed locally, logs the REAL MEWS error, and never success-logs", async () => {
    const storage = createStorage({ lock_arrival_checkin_enabled: "true" });
    const ttlock = createTTLock();
    const mews = createRejectingMews();

    const lock = makeLockDevice({ ttlockId: "common-1", lockType: "common", name: "Street Entrance" });
    storage._lockDevices.push(lock);
    const reservation = makeReservation({
      id: "res-1", pmsId: "PMS-RES-1", status: "Confirmed", roomId: "room-1",
      arrival: new Date(now.getTime() - 2 * 60 * 60 * 1000), departure: validTo,
    });
    const pin = makePin({
      id: "pin-1", reservationId: "res-1", roomId: "room-1", code: "4829",
      status: "active", firstUsedAt: null, validFrom, validTo,
    });
    storage._reservations.push(reservation);
    storage._pins.push(pin);
    ttlock._setRecords("common-1", [makeKeypadRecord("4829", now)]);

    const sm = new ReservationStateMachine(
      storage as any,
      createEngine(ttlock) as any,
      mews as any,
      TENANT
    );

    await sm._jobLockArrivals();

    // MEWS was attempted (arrival detected)...
    expect(mews._attempts).toContain("PMS-RES-1");
    // ...but the guest must stay Confirmed — NOT be flipped to checked-in.
    expect(reservation.status).toBe("Confirmed");
    expect(reservation.pmsCheckinSource ?? null).toBeNull();
    // The REAL MEWS error is logged (surfaces as "MEWS afvist" in the report).
    expect(storage._logs.some((l: any) =>
      l.level === "warn" && l.message.includes("MEWS check-in write-back failed") &&
      l.message.includes("assigned space is blocked"))).toBe(true);
    // No false success logs.
    expect(storage._logs.some((l: any) => l.message.includes("Auto check-in in MEWS"))).toBe(false);
    expect(storage._logs.some((l: any) => l.message.includes("Guest checked in via code"))).toBe(false);
  });

  it("flips to checked-in when MEWS ACCEPTS (success:true)", async () => {
    const storage = createStorage({ lock_arrival_checkin_enabled: "true" });
    const ttlock = createTTLock();
    const mews = createMews(); // success:true

    const lock = makeLockDevice({ ttlockId: "common-1", lockType: "common", name: "Street Entrance" });
    storage._lockDevices.push(lock);
    const reservation = makeReservation({
      id: "res-1", pmsId: "PMS-RES-1", status: "Confirmed", roomId: "room-1",
      arrival: new Date(now.getTime() - 2 * 60 * 60 * 1000), departure: validTo,
    });
    const pin = makePin({
      id: "pin-1", reservationId: "res-1", roomId: "room-1", code: "4829",
      status: "active", firstUsedAt: null, validFrom, validTo,
    });
    storage._reservations.push(reservation);
    storage._pins.push(pin);
    ttlock._setRecords("common-1", [makeKeypadRecord("4829", now)]);

    const sm = new ReservationStateMachine(
      storage as any,
      createEngine(ttlock) as any,
      mews as any,
      TENANT
    );

    await sm._jobLockArrivals();

    expect(reservation.status).toBe("checked-in");
    expect(reservation.pmsCheckinSource).toBe("lock");
    expect(storage._logs.some((l: any) => l.message.includes("Guest checked in via code"))).toBe(true);
  });
});
