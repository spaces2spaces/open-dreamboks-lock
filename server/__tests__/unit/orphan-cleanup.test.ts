/**
 * Orphan-cleanup redesign tests (post-21/7 incident).
 *
 * The old cleanupOrphanedPasscodes marked active pins status:"deleted" the
 * moment a keyId was missing from a lock's passcode list — including when a
 * gateway flap made TTLock answer "errcode 0 + empty list". "deleted" is
 * outside the official status set, so no repair mechanism ever touched the
 * pin again: guests were permanently locked out.
 *
 * These tests pin down the new fail-safe behavior:
 *  - soft-empty list  → treated as transient, nothing archived
 *  - live reservation → re-push, NEVER archive
 *  - terminal pins    → archived (to "cancelled") only after 3 observations
 *                       spanning >= 2 hours
 *  - circuit breaker  → mass archival aborts the whole run
 *  - recovery         → wrongly-"deleted" pins are reactivated + re-pushed
 *  - repair startDate → effective start is min(validFrom, now-60s)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AutomationEngine } from "../../automation";
import { createMockStorage } from "../mocks/storage";
import { createMockTTLockClient } from "../mocks/ttlock-client";

const TZ_SETTINGS = {
  check_in_time: "15:00",
  reservation_checkout_time: "11:00",
  property_timezone: "Europe/Copenhagen",
};

const HOUR = 60 * 60 * 1000;

function makeSetup() {
  const storage = createMockStorage({ ...TZ_SETTINGS });
  const ttlock = createMockTTLockClient();
  const engine = new AutomationEngine(storage as any, ttlock as any);

  const room: any = { id: "room-1", name: "101", pmsId: "pms-101", tenantId: "test-tenant" };
  storage._rooms.push(room);

  const roomLock: any = { id: "ld-room", ttlockId: "tt-room", name: "Room 101", lockType: "room" };
  const commonLock: any = { id: "ld-main", ttlockId: "tt-main", name: "Main Entrance", lockType: "common" };
  storage._lockAssignments.push(
    { roomId: room.id, lockDevice: roomLock, assignmentType: "room" },
    { roomId: room.id, lockDevice: commonLock, assignmentType: "common" },
  );

  const reservation: any = {
    id: "res-1",
    pmsId: "MEWS-1",
    roomId: room.id,
    status: "Checked-in",
    firstName: "Anna",
    lastName: "Guest",
    arrival: new Date(Date.now() - 6 * HOUR),
    departure: new Date(Date.now() + 18 * HOUR),
  };
  storage._reservations.push(reservation);

  function makeActivePin(overrides: Partial<any> = {}) {
    const pin: any = {
      id: `pin-${storage._pins.length + 1}`,
      roomId: room.id,
      reservationId: reservation.id,
      type: "Passcode",
      code: "4711",
      name: "Anna Guest",
      status: "active",
      validFrom: new Date(Date.now() - 6 * HOUR),
      validTo: new Date(Date.now() + 18 * HOUR),
      roomLockKeyIds: [{ lockDeviceId: roomLock.id, ttlockId: roomLock.ttlockId, keyId: "1001", lockName: roomLock.name }],
      commonAreaKeyIds: [{ lockDeviceId: commonLock.id, ttlockId: commonLock.ttlockId, keyId: "1002", lockName: commonLock.name }],
      orphanObservations: null,
      ...overrides,
    };
    storage._pins.push(pin);
    return pin;
  }

  /** Plant the pin's codes on the physical (mock) locks so lists are non-empty and healthy. */
  function plantOnLocks(pin: any) {
    ttlock.getPasscodesForLock(roomLock.ttlockId).push({
      id: 1001, lockId: roomLock.ttlockId, code: pin.code, name: pin.name,
      startDate: new Date(Date.now() - 6 * HOUR), endDate: new Date(Date.now() + 18 * HOUR),
    } as any);
    ttlock.getPasscodesForLock(commonLock.ttlockId).push({
      id: 1002, lockId: commonLock.ttlockId, code: pin.code, name: pin.name,
      startDate: new Date(Date.now() - 6 * HOUR), endDate: new Date(Date.now() + 18 * HOUR),
    } as any);
  }

  return { storage, ttlock, engine, room, roomLock, commonLock, reservation, makeActivePin, plantOnLocks };
}

describe("cleanupOrphanedPasscodes (redesigned)", () => {
  let s: ReturnType<typeof makeSetup>;

  beforeEach(() => {
    s = makeSetup();
  });

  it("healthy pin: nothing happens", async () => {
    const pin = s.makeActivePin();
    s.plantOnLocks(pin);

    const result = await s.engine.cleanupOrphanedPasscodes();

    expect(result.deleted).toBe(0);
    expect(result.repaired).toBe(0);
    expect(result.aborted).toBe(false);
    expect(pin.status).toBe("active");
  });

  it("soft-empty list (gateway flap): treated as transient — no archive, no repair", async () => {
    const pin = s.makeActivePin();
    // Codes exist in DB but the lock answers successfully with an EMPTY list.
    s.ttlock.setSoftEmptyListForLock(s.roomLock.ttlockId);
    s.ttlock.setSoftEmptyListForLock(s.commonLock.ttlockId);

    const result = await s.engine.cleanupOrphanedPasscodes();

    expect(result.deleted).toBe(0);
    expect(result.repaired).toBe(0);
    expect(pin.status).toBe("active");
    // No re-push attempted — the locks were unverifiable, not proven empty.
    expect(s.ttlock.getCallsFor("addPasscode").length).toBe(0);
    // The guard should have logged the transient treatment.
    expect(s.storage._logs.some((l: any) => String(l.message).includes("empty passcode list"))).toBe(true);
  });

  it("thrown listPasscodes error: lock skipped entirely (existing failedLockIds behavior)", async () => {
    const pin = s.makeActivePin();
    s.plantOnLocks(pin);
    s.ttlock.failListPasscodesForLock(s.roomLock.ttlockId);

    const result = await s.engine.cleanupOrphanedPasscodes();

    expect(result.deleted).toBe(0);
    expect(pin.status).toBe("active");
  });

  it("live reservation with genuinely missing key: re-push, NEVER archive", async () => {
    const pin = s.makeActivePin();
    s.plantOnLocks(pin);
    // Remove the code from the common door only — non-empty list stays non-empty
    // for the room lock; make common list non-empty with an unrelated code so
    // the soft-empty guard does not trigger.
    const commonCodes = s.ttlock.getPasscodesForLock(s.commonLock.ttlockId);
    commonCodes.length = 0;
    commonCodes.push({
      id: 9999, lockId: s.commonLock.ttlockId, code: "0000", name: "other",
      startDate: new Date(Date.now() - HOUR), endDate: new Date(Date.now() + HOUR),
    } as any);

    const result = await s.engine.cleanupOrphanedPasscodes();

    expect(result.deleted).toBe(0);
    expect(result.repaired).toBe(1);
    expect(pin.status).toBe("active");
    // Re-push happened towards the common door.
    const pushedLocks = s.ttlock.getCallsFor("addPasscode").map((c: any) => c.args[0]);
    expect(pushedLocks).toContain(s.commonLock.ttlockId);
    // And the code is physically back on the door.
    expect(s.ttlock.getPasscodesForLock(s.commonLock.ttlockId).some((p: any) => p.code === pin.code)).toBe(true);
  });

  it("terminal reservation: archived as 'cancelled' only after 3 observations spanning >= 2h", async () => {
    s.reservation.status = "Checked-out";
    const pin = s.makeActivePin();
    // Lock lists are non-empty but do NOT contain the pin's keys.
    s.ttlock.getPasscodesForLock(s.roomLock.ttlockId).push({
      id: 8888, lockId: s.roomLock.ttlockId, code: "1234", name: "other",
      startDate: new Date(Date.now() - HOUR), endDate: new Date(Date.now() + HOUR),
    } as any);
    s.ttlock.getPasscodesForLock(s.commonLock.ttlockId).push({
      id: 8889, lockId: s.commonLock.ttlockId, code: "1234", name: "other",
      startDate: new Date(Date.now() - HOUR), endDate: new Date(Date.now() + HOUR),
    } as any);

    // Run 1: observation recorded, nothing archived.
    let result = await s.engine.cleanupOrphanedPasscodes();
    expect(result.deleted).toBe(0);
    expect(pin.status).toBe("active");
    expect((pin as any).orphanObservations?.count).toBe(1);

    // Run 2: still nothing (count 2, window too short anyway).
    result = await s.engine.cleanupOrphanedPasscodes();
    expect(result.deleted).toBe(0);
    expect((pin as any).orphanObservations?.count).toBe(2);

    // Run 3 but window < 2h: still nothing.
    result = await s.engine.cleanupOrphanedPasscodes();
    expect(result.deleted).toBe(0);

    // Backdate firstSeenAt beyond the 2h window, then run again → archived.
    (pin as any).orphanObservations = {
      count: 3,
      firstSeenAt: new Date(Date.now() - 3 * HOUR).toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    result = await s.engine.cleanupOrphanedPasscodes();
    expect(result.deleted).toBe(1);
    expect(pin.status).toBe("cancelled"); // official soft status — NEVER "deleted"
  });

  it("healthy again after observations: observation state resets", async () => {
    s.reservation.status = "Checked-out";
    const pin = s.makeActivePin({
      orphanObservations: { count: 2, firstSeenAt: new Date(Date.now() - 3 * HOUR).toISOString(), lastSeenAt: new Date().toISOString() },
    });
    s.plantOnLocks(pin); // keys are back

    await s.engine.cleanupOrphanedPasscodes();

    expect((pin as any).orphanObservations).toBeNull();
    expect(pin.status).toBe("active");
  });

  it("circuit breaker: mass archival aborts the run and touches nothing", async () => {
    s.reservation.status = "Checked-out";
    // 10 terminal pins, all ripe for archival (observations pre-loaded).
    const pins = Array.from({ length: 10 }, (_, i) =>
      s.makeActivePin({
        id: `pin-cb-${i}`,
        code: `47${10 + i}`,
        roomLockKeyIds: [{ lockDeviceId: s.roomLock.id, ttlockId: s.roomLock.ttlockId, keyId: `20${i}`, lockName: s.roomLock.name }],
        commonAreaKeyIds: [],
        orphanObservations: { count: 5, firstSeenAt: new Date(Date.now() - 5 * HOUR).toISOString(), lastSeenAt: new Date().toISOString() },
      })
    );
    // Non-empty room-lock list without any of their keys.
    s.ttlock.getPasscodesForLock(s.roomLock.ttlockId).push({
      id: 7777, lockId: s.roomLock.ttlockId, code: "1234", name: "other",
      startDate: new Date(Date.now() - HOUR), endDate: new Date(Date.now() + HOUR),
    } as any);

    const result = await s.engine.cleanupOrphanedPasscodes();

    // 10 candidates > max(3, ceil(10*0.10)=1) = 3 → abort, nothing archived.
    expect(result.aborted).toBe(true);
    expect(result.deleted).toBe(0);
    for (const pin of pins) expect(pin.status).toBe("active");
    expect(s.storage._logs.some((l: any) => String(l.message).includes("ABORTED"))).toBe(true);
  });

  it("legacy {commonAreaId} entries are resolved and checked (no longer dead code)", async () => {
    s.storage._commonAreas.push({ id: "ca-1", name: "Main Entrance", ttlockId: s.commonLock.ttlockId });
    const pin = s.makeActivePin({
      roomLockKeyIds: [],
      commonAreaKeyIds: [{ commonAreaId: "ca-1", keyId: "1002" }], // legacy shape
    });
    // Non-empty common list WITHOUT key 1002 → genuine missing signal.
    s.ttlock.getPasscodesForLock(s.commonLock.ttlockId).push({
      id: 6666, lockId: s.commonLock.ttlockId, code: "0000", name: "other",
      startDate: new Date(Date.now() - HOUR), endDate: new Date(Date.now() + HOUR),
    } as any);

    const result = await s.engine.cleanupOrphanedPasscodes();

    // Live reservation → repair path, not archive.
    expect(result.repaired).toBe(1);
    expect(pin.status).toBe("active");
  });
});

describe("recoverWronglyDeletedPins", () => {
  let s: ReturnType<typeof makeSetup>;

  beforeEach(() => {
    s = makeSetup();
  });

  it("recovers a deleted pin with live reservation: reactivates and re-pushes", async () => {
    const pin = s.makeActivePin({ status: "deleted", roomLockKeyIds: [], commonAreaKeyIds: [] });

    const result = await s.engine.recoverWronglyDeletedPins(false);

    expect(result.recovered).toBe(1);
    expect(pin.status).toBe("active");
    // Force repair pushed the code to the assigned locks.
    expect(s.ttlock.getPasscodesForLock(s.roomLock.ttlockId).some((p: any) => p.code === pin.code)).toBe(true);
  });

  it("dry-run counts but changes nothing", async () => {
    const pin = s.makeActivePin({ status: "deleted", roomLockKeyIds: [], commonAreaKeyIds: [] });

    const result = await s.engine.recoverWronglyDeletedPins(true);

    expect(result.dryRun).toBe(true);
    expect(result.recovered).toBe(1);
    expect(pin.status).toBe("deleted"); // untouched
    expect(s.ttlock.getCallsFor("addPasscode").length).toBe(0);
  });

  it("skips: cancelled reservation, expired window, and duplicate live pin", async () => {
    // Cancelled reservation
    const resCancelled: any = { ...s.reservation, id: "res-c", status: "Cancelled" };
    s.storage._reservations.push(resCancelled);
    const pinCancelled = s.makeActivePin({ id: "pin-c", status: "deleted", reservationId: "res-c" });

    // Expired window (not even returned by the query)
    const pinExpired = s.makeActivePin({ id: "pin-e", status: "deleted", validTo: new Date(Date.now() - HOUR) });

    // Reservation already has another live pin
    s.makeActivePin({ id: "pin-live", status: "active" });
    const pinDuplicate = s.makeActivePin({ id: "pin-d", status: "deleted" });

    const result = await s.engine.recoverWronglyDeletedPins(false);

    expect(result.recovered).toBe(0);
    expect(pinCancelled.status).toBe("deleted");
    expect(pinExpired.status).toBe("deleted");
    expect(pinDuplicate.status).toBe("deleted");
  });
});

describe("repairPasscodeForReservation start date (C3)", () => {
  it("pushes with startDate <= now even when validFrom is in the future", async () => {
    const s = makeSetup();
    // Guest arrived early: reservation arrival later today, validFrom 15:00 (future).
    const future = new Date(Date.now() + 4 * HOUR);
    s.reservation.arrival = future;
    s.reservation.departure = new Date(Date.now() + 28 * HOUR);
    const pin = s.makeActivePin({
      validFrom: future,
      validTo: new Date(Date.now() + 28 * HOUR),
      roomLockKeyIds: [], // room lock missing → repair will push it
      commonAreaKeyIds: [],
    });

    const result = await s.engine.repairPasscodeForReservation(s.reservation.id, false);

    expect(result.success).toBe(true);
    const pushes = s.ttlock.getCallsFor("addPasscode");
    expect(pushes.length).toBeGreaterThan(0);
    for (const call of pushes) {
      const options = call.args[3];
      // The repaired code must be usable NOW, not first at check-in time.
      expect(options.startDate.getTime()).toBeLessThanOrEqual(Date.now());
    }
    expect(pin.status).toBe("active");
  });
});
