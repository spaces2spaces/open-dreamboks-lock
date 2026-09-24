/**
 * KeyId-array integrity (C9, post-21/7).
 *
 *  1. pushToTTLock must MERGE key entries, not overwrite: a common door that
 *     is offline during a reconcile keeps its prior entry, so checkout still
 *     deletes the code there (no stale codes left on doors).
 *  2. repairPasscodeForReservation must route common-door entries into
 *     commonAreaKeyIds (they used to be misfiled into roomLockKeyIds,
 *     duplicating entries and defeating missing-lock detection).
 *  3. repair must treat commonAreaKeyIds entries as existing coverage —
 *     no pointless re-push of every common door on every repair.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestHarness, type TestHarness } from "../integration/harness";
import { AutomationEngine } from "../../automation";
import { createMockStorage } from "../mocks/storage";
import { createMockTTLockClient } from "../mocks/ttlock-client";

const HOUR = 3600 * 1000;
const PAST_ARRIVAL = new Date(Date.now() - 6 * HOUR).toISOString();
const PAST_DEPARTURE = new Date(Date.now() + 18 * HOUR).toISOString();

describe("pushToTTLock merges key entries (offline lock keeps its entry)", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  it("re-push with the common door offline preserves its previously recorded entry", async () => {
    const { room } = h.setupMappedRoom("101", "pms-101", "tt-room");
    h.setupCommonAreaLock(room.id, "Main Entrance", "tt-main");

    await h.fireUpsertPending({
      pmsId: "RES-C9",
      status: "Confirmed",
      roomPmsId: "pms-101",
      arrival: PAST_ARRIVAL,
      departure: PAST_DEPARTURE,
    });
    const res = h.storage._reservations.find((r) => r.pmsId === "RES-C9")!;
    res.status = "Checked-in";

    // First activation: both locks online → both entries recorded.
    await h.pinLifecycle.activatePendingForReservation(res.id);
    const pin = h.storage._pins[0];
    expect((pin.commonAreaKeyIds as any[]).some((e) => e.ttlockId === "tt-main")).toBe(true);
    const commonKeyIdBefore = (pin.commonAreaKeyIds as any[]).find((e) => e.ttlockId === "tt-main").keyId;

    // Common door goes OFFLINE; a reconcile re-push runs (drift path).
    h.ttlock.failWithCode("addPasscode", -3034); // "device not connected to network"
    await h.pinLifecycle.reconcilePinOnTTLock(pin.id);

    // The offline door's entry must SURVIVE — the code physically sits on the
    // lock from the first push; dropping the entry would orphan it at checkout.
    const commonEntries = (pin.commonAreaKeyIds as any[]).filter((e) => e.ttlockId === "tt-main");
    expect(commonEntries).toHaveLength(1);
    expect(commonEntries[0].keyId).toBe(commonKeyIdBefore);
  });
});

describe("repair routes and respects common-door entries", () => {
  function makeSetup() {
    const storage = createMockStorage({
      check_in_time: "15:00",
      reservation_checkout_time: "11:00",
      property_timezone: "Europe/Copenhagen",
    });
    const ttlock = createMockTTLockClient();
    const engine = new AutomationEngine(storage as any, ttlock as any);

    const room: any = { id: "room-1", name: "101", pmsId: "pms-101" };
    storage._rooms.push(room);
    const roomLock: any = { id: "ld-room", ttlockId: "tt-room", name: "Room 101", lockType: "room" };
    const mainDoor: any = { id: "ld-main", ttlockId: "tt-main", name: "Main Entrance", lockType: "common" };
    storage._lockAssignments.push(
      { roomId: room.id, lockDevice: roomLock, assignmentType: "room" },
      { roomId: room.id, lockDevice: mainDoor, assignmentType: "common" },
    );
    const reservation: any = {
      id: "res-1", pmsId: "M-1", roomId: room.id, status: "Checked-in",
      firstName: "Anna", lastName: "Guest",
      arrival: new Date(Date.now() - 6 * HOUR), departure: new Date(Date.now() + 18 * HOUR),
    };
    storage._reservations.push(reservation);
    return { storage, ttlock, engine, reservation, roomLock, mainDoor };
  }

  it("a repaired common door lands in commonAreaKeyIds, not roomLockKeyIds", async () => {
    const s = makeSetup();
    s.storage._pins.push({
      id: "pin-1", roomId: "room-1", reservationId: "res-1", code: "4711", name: "Anna",
      status: "active",
      validFrom: new Date(Date.now() - 6 * HOUR), validTo: new Date(Date.now() + 18 * HOUR),
      roomLockKeyIds: [{ lockDeviceId: "ld-room", ttlockId: "tt-room", keyId: "1001", lockName: "Room 101" }],
      commonAreaKeyIds: [], // main entrance missing → repair should push it
    } as any);

    const result = await s.engine.repairPasscodeForReservation("res-1", false);

    expect(result.success).toBe(true);
    const pin = s.storage._pins[0] as any;
    expect(pin.commonAreaKeyIds.some((e: any) => e.ttlockId === "tt-main")).toBe(true);
    expect(pin.roomLockKeyIds.some((e: any) => e.ttlockId === "tt-main")).toBe(false);
    // Room entry untouched:
    expect(pin.roomLockKeyIds.some((e: any) => e.ttlockId === "tt-room" && e.keyId === "1001")).toBe(true);
  });

  it("no churn: full coverage in both arrays → repair pushes nothing", async () => {
    const s = makeSetup();
    s.storage._pins.push({
      id: "pin-1", roomId: "room-1", reservationId: "res-1", code: "4711", name: "Anna",
      status: "active",
      validFrom: new Date(Date.now() - 6 * HOUR), validTo: new Date(Date.now() + 18 * HOUR),
      roomLockKeyIds: [{ lockDeviceId: "ld-room", ttlockId: "tt-room", keyId: "1001", lockName: "Room 101" }],
      commonAreaKeyIds: [{ lockDeviceId: "ld-main", ttlockId: "tt-main", keyId: "1002", lockName: "Main Entrance" }],
    } as any);

    const result = await s.engine.repairPasscodeForReservation("res-1", false);

    expect(result.success).toBe(true);
    expect(result.error).toBe("All locks already have the passcode");
    expect(s.ttlock.getCallsFor("addPasscode")).toHaveLength(0);
  });
});

describe("-3007 phantom convergence on common doors (22/7-23/7 repair loop)", () => {
  function makeSetup() {
    const storage = createMockStorage({
      check_in_time: "15:00",
      reservation_checkout_time: "11:00",
      property_timezone: "Europe/Copenhagen",
    });
    const ttlock = createMockTTLockClient();
    const engine = new AutomationEngine(storage as any, ttlock as any);

    const room: any = { id: "room-1", name: "101", pmsId: "pms-101" };
    storage._rooms.push(room);
    const roomLock: any = { id: "ld-room", ttlockId: "tt-room", name: "Room 101", lockType: "room" };
    const mainDoor: any = { id: "ld-main", ttlockId: "tt-main", name: "Main Entrance", lockType: "common" };
    storage._lockAssignments.push(
      { roomId: room.id, lockDevice: roomLock, assignmentType: "room" },
      { roomId: room.id, lockDevice: mainDoor, assignmentType: "common" },
    );
    const reservation: any = {
      id: "res-1", pmsId: "M-1", roomId: room.id, status: "Checked-in",
      firstName: "Anna", lastName: "Guest",
      arrival: new Date(Date.now() - 6 * HOUR), departure: new Date(Date.now() + 18 * HOUR),
    };
    storage._reservations.push(reservation);
    return { storage, ttlock, engine, reservation, roomLock, mainDoor };
  }

  it("verify-attempt counter progresses across runs for a common door and converges to confirmedUnlisted", async () => {
    const s = makeSetup();
    s.storage._pins.push({
      id: "pin-1", roomId: "room-1", reservationId: "res-1", code: "4711", name: "Anna",
      status: "active",
      validFrom: new Date(Date.now() - 6 * HOUR), validTo: new Date(Date.now() + 18 * HOUR),
      roomLockKeyIds: [{ lockDeviceId: "ld-room", ttlockId: "tt-room", keyId: "1001", lockName: "Room 101" }],
      commonAreaKeyIds: [], // main entrance missing → repair pushes it
    } as any);
    // Phantom: the lock answers -3007 "already exists" on every add, while the
    // cloud list never shows the code (nothing was ever stored in the mock).
    s.ttlock.failWithCode("addPasscode", -3007);

    const pin = s.storage._pins[0] as any;

    await s.engine.repairPasscodeForReservation("res-1", false);
    let sentinel = pin.commonAreaKeyIds.find((e: any) => e.ttlockId === "tt-main");
    expect(sentinel).toBeDefined();
    expect(sentinel.keyId).toBe("existing");
    expect(sentinel.verifyAttempts).toBe(1);
    expect(sentinel.confirmedUnlisted).toBeUndefined();

    await s.engine.repairPasscodeForReservation("res-1", false);
    sentinel = pin.commonAreaKeyIds.find((e: any) => e.ttlockId === "tt-main");
    expect(sentinel.verifyAttempts).toBe(2);
    expect(sentinel.confirmedUnlisted).toBeUndefined();

    // Third round reaches MAX_UNLISTED_VERIFY_ATTEMPTS → accepted as on-lock.
    await s.engine.repairPasscodeForReservation("res-1", false);
    sentinel = pin.commonAreaKeyIds.find((e: any) => e.ttlockId === "tt-main");
    expect(sentinel.confirmedUnlisted).toBe(true);

    // Converged: further repairs (even force) must not touch the phantom door.
    const before = s.ttlock.getCallsFor("addPasscode").length;
    const result = await s.engine.repairPasscodeForReservation("res-1", false);
    expect(result.error).toBe("All locks already have the passcode");
    expect(s.ttlock.getCallsFor("addPasscode")).toHaveLength(before);
  });

  it("force repair does not re-push or wipe a confirmedUnlisted common door", async () => {
    const s = makeSetup();
    s.storage._pins.push({
      id: "pin-1", roomId: "room-1", reservationId: "res-1", code: "4711", name: "Anna",
      status: "active",
      validFrom: new Date(Date.now() - 6 * HOUR), validTo: new Date(Date.now() + 18 * HOUR),
      roomLockKeyIds: [{ lockDeviceId: "ld-room", ttlockId: "tt-room", keyId: "1001", lockName: "Room 101" }],
      commonAreaKeyIds: [{ lockDeviceId: "ld-main", ttlockId: "tt-main", keyId: "existing", lockName: "Main Entrance", confirmedUnlisted: true }],
    } as any);

    const result = await s.engine.repairPasscodeForReservation("res-1", true);

    expect(result.success).toBe(true);
    // Force re-pushed the room lock but NOT the phantom common door.
    const pushedLocks = s.ttlock.getCallsFor("addPasscode").map((c: any) => c.args[0]);
    expect(pushedLocks).toContain("tt-room");
    expect(pushedLocks).not.toContain("tt-main");
    // The converged sentinel survives the force rebuild (merge-invariant).
    const pin = s.storage._pins[0] as any;
    const sentinel = pin.commonAreaKeyIds.find((e: any) => e.ttlockId === "tt-main");
    expect(sentinel).toBeDefined();
    expect(sentinel.confirmedUnlisted).toBe(true);
  });

  it("admin escape hatch (includeConfirmedUnlisted) heals a false-positive convergence", async () => {
    const s = makeSetup();
    s.storage._pins.push({
      id: "pin-1", roomId: "room-1", reservationId: "res-1", code: "4711", name: "Anna",
      status: "active",
      validFrom: new Date(Date.now() - 6 * HOUR), validTo: new Date(Date.now() + 18 * HOUR),
      roomLockKeyIds: [{ lockDeviceId: "ld-room", ttlockId: "tt-room", keyId: "1001", lockName: "Room 101" }],
      commonAreaKeyIds: [{ lockDeviceId: "ld-main", ttlockId: "tt-main", keyId: "existing", lockName: "Main Entrance", confirmedUnlisted: true }],
    } as any);
    // The lock accepts the add now (the phantom was a false positive).

    const result = await s.engine.repairPasscodeForReservation("res-1", true, { includeConfirmedUnlisted: true });

    expect(result.success).toBe(true);
    const pushed = s.ttlock.getCallsFor("addPasscode").map((c: any) => c.args[0]);
    expect(pushed).toContain("tt-main");
    const pin = s.storage._pins[0] as any;
    const entry = pin.commonAreaKeyIds.find((e: any) => e.ttlockId === "tt-main");
    expect(entry.keyId).not.toBe("existing"); // real keyId recorded — healed
  });

  it("admin escape hatch on a still-phantom lock re-affirms confirmedUnlisted instead of restarting the counter", async () => {
    const s = makeSetup();
    s.storage._pins.push({
      id: "pin-1", roomId: "room-1", reservationId: "res-1", code: "4711", name: "Anna",
      status: "active",
      validFrom: new Date(Date.now() - 6 * HOUR), validTo: new Date(Date.now() + 18 * HOUR),
      roomLockKeyIds: [{ lockDeviceId: "ld-room", ttlockId: "tt-room", keyId: "1001", lockName: "Room 101" }],
      commonAreaKeyIds: [{ lockDeviceId: "ld-main", ttlockId: "tt-main", keyId: "existing", lockName: "Main Entrance", confirmedUnlisted: true }],
    } as any);
    s.ttlock.failWithCode("addPasscode", -3007); // still a phantom

    await s.engine.repairPasscodeForReservation("res-1", false, { includeConfirmedUnlisted: true });

    const pin = s.storage._pins[0] as any;
    const entry = pin.commonAreaKeyIds.find((e: any) => e.ttlockId === "tt-main");
    expect(entry.confirmedUnlisted).toBe(true); // re-affirmed, not demoted to attempt 1/3
    expect(entry.verifyAttempts).toBeUndefined();
  });
});
