/**
 * Door-code audit tests (C6/C7): detection→action.
 *
 * The audit compares the lock's ACTUAL passcode list with every code that
 * should be usable now. New in this round:
 *  - gaps carry reservationId so the report layer can force-repair them
 *    (audit → repair → re-audit = self-healing report)
 *  - offlineDoorsDetailed exposes ttlockId for gateway-down escalation
 *  - unlock-history false-positive guard is now testable via the shared mock
 */
import { describe, it, expect, beforeEach } from "vitest";
import { auditCommonDoorCodes } from "../../door-code-audit";
import { AutomationEngine } from "../../automation";
import { createMockStorage } from "../mocks/storage";
import { createMockTTLockClient } from "../mocks/ttlock-client";

const HOUR = 60 * 60 * 1000;

function makeSetup() {
  const storage = createMockStorage({
    check_in_time: "15:00",
    reservation_checkout_time: "11:00",
    property_timezone: "Europe/Copenhagen",
  });
  const ttlock = createMockTTLockClient();
  const engine = new AutomationEngine(storage as any, ttlock as any);

  const room: any = { id: "room-1", name: "101", pmsId: "pms-101", tenantId: "test-tenant" };
  storage._rooms.push(room);

  const roomLock: any = { id: "ld-room", ttlockId: "tt-room", name: "Room 101", lockType: "room" };
  const mainDoor: any = { id: "ld-main", ttlockId: "tt-main", name: "Main Entrance", lockType: "common" };
  storage._lockAssignments.push(
    { roomId: room.id, lockDevice: roomLock, assignmentType: "room" },
    { roomId: room.id, lockDevice: mainDoor, assignmentType: "common" },
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

  const pin: any = {
    id: "pin-1",
    roomId: room.id,
    reservationId: reservation.id,
    code: "4711",
    name: "Anna Guest",
    status: "active",
    validFrom: new Date(Date.now() - 6 * HOUR),
    validTo: new Date(Date.now() + 18 * HOUR),
    roomLockKeyIds: [{ lockDeviceId: roomLock.id, ttlockId: roomLock.ttlockId, keyId: "1001", lockName: roomLock.name }],
    commonAreaKeyIds: [],
  };
  storage._pins.push(pin);

  // Room locks are audited too now — keep the common-door tests focused by
  // planting the code on the room lock so only the main door can gap.
  ttlock.getPasscodesForLock(roomLock.ttlockId).push({
    id: 1001, lockId: roomLock.ttlockId, code: pin.code, name: pin.name,
    startDate: new Date(Date.now() - 6 * HOUR), endDate: new Date(Date.now() + 18 * HOUR),
  } as any);

  return { storage, ttlock, engine, room, roomLock, mainDoor, reservation, pin };
}

describe("auditCommonDoorCodes", () => {
  let s: ReturnType<typeof makeSetup>;

  beforeEach(() => {
    s = makeSetup();
  });

  it("reports a gap (with reservationId) when the code is absent from a common door", async () => {
    const { gaps, offlineLocks } = await auditCommonDoorCodes(s.storage as any, s.ttlock as any);

    expect(offlineLocks).toEqual([]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      code: "4711",
      lockName: "Main Entrance",
      ttlockId: "tt-main",
      reservationId: "res-1",
      reason: "missing",
    });
  });

  it("detection→action: force repair heals the gap, re-audit is clean (the report-layer loop)", async () => {
    // Mimic exactly what buildLockArrivalReport does with an engine.
    const first = await auditCommonDoorCodes(s.storage as any, s.ttlock as any);
    expect(first.gaps).toHaveLength(1);

    for (const reservationId of new Set(first.gaps.map(g => g.reservationId!))) {
      await s.engine.repairPasscodeForReservation(reservationId, true);
    }

    const second = await auditCommonDoorCodes(s.storage as any, s.ttlock as any);
    expect(second.gaps).toHaveLength(0);
    // Physically on the door now:
    expect(s.ttlock.getPasscodesForLock("tt-main").some((p: any) => p.code === "4711")).toBe(true);
  });

  it("unlock-history guard: a code recently used successfully on the door is not alarmed", async () => {
    s.ttlock._setUnlockRecords("tt-main", [{ keyboardPwd: "4711", success: true, lockDate: Date.now() - HOUR }]);

    const { gaps } = await auditCommonDoorCodes(s.storage as any, s.ttlock as any);

    expect(gaps).toHaveLength(0); // BLE/app-created code — on the lock, cloud list just can't see it
  });

  it("offline door: reported as offline (with ttlockId) instead of per-guest alarms", async () => {
    // The repair/push jobs log "<lockName> offline" — the audit reads those.
    await s.storage.createLog({
      level: "warn",
      message: `Repair: Main Entrance offline — deferred (-3034); will retry when it reconnects`,
      source: "automation",
    });

    const { gaps, offlineLocks, offlineDoorsDetailed } = await auditCommonDoorCodes(s.storage as any, s.ttlock as any);

    expect(gaps).toHaveLength(0);
    expect(offlineLocks).toEqual(["Main Entrance"]);
    expect(offlineDoorsDetailed).toEqual([{ lockName: "Main Entrance", ttlockId: "tt-main" }]);
  });

  it("room locks are audited too: missing capsule code is a gap with lockKind 'room'", async () => {
    // Remove the code from the ROOM lock (was planted in setup) but leave an
    // unrelated code so the soft signals stay realistic; plant on main door.
    const roomCodes = s.ttlock.getPasscodesForLock(s.roomLock.ttlockId);
    roomCodes.length = 0;
    roomCodes.push({
      id: 7777, lockId: s.roomLock.ttlockId, code: "0000", name: "other",
      startDate: new Date(Date.now() - HOUR), endDate: new Date(Date.now() + HOUR),
    } as any);
    s.ttlock.getPasscodesForLock(s.mainDoor.ttlockId).push({
      id: 1002, lockId: s.mainDoor.ttlockId, code: "4711", name: "Anna Guest",
      startDate: new Date(Date.now() - HOUR), endDate: new Date(Date.now() + HOUR),
    } as any);

    const { gaps } = await auditCommonDoorCodes(s.storage as any, s.ttlock as any);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ lockName: "Room 101", lockKind: "room", reason: "missing" });
  });

  it("confirmedUnlisted entries are trusted — no gap even when the cloud list is blind", async () => {
    // Cloud-blind lock: code invisible in the list, but the entry is marked
    // confirmedUnlisted (the lock asserted -3007 repeatedly).
    s.pin.roomLockKeyIds = [{ lockDeviceId: s.roomLock.id, ttlockId: s.roomLock.ttlockId, keyId: "existing", lockName: s.roomLock.name, confirmedUnlisted: true }];
    s.ttlock.getPasscodesForLock(s.roomLock.ttlockId).length = 0; // list shows nothing
    s.ttlock.getPasscodesForLock(s.mainDoor.ttlockId).push({
      id: 1002, lockId: s.mainDoor.ttlockId, code: "4711", name: "Anna Guest",
      startDate: new Date(Date.now() - HOUR), endDate: new Date(Date.now() + HOUR),
    } as any);

    const { gaps } = await auditCommonDoorCodes(s.storage as any, s.ttlock as any);

    expect(gaps).toHaveLength(0);
  });

  it("audit_room_locks=false restores common-doors-only auditing", async () => {
    await s.storage.setSetting("audit_room_locks", "false");
    s.ttlock.getPasscodesForLock(s.roomLock.ttlockId).length = 0; // room code gone
    s.ttlock.getPasscodesForLock(s.mainDoor.ttlockId).push({
      id: 1002, lockId: s.mainDoor.ttlockId, code: "4711", name: "Anna Guest",
      startDate: new Date(Date.now() - HOUR), endDate: new Date(Date.now() + HOUR),
    } as any);

    const { gaps } = await auditCommonDoorCodes(s.storage as any, s.ttlock as any);

    expect(gaps).toHaveLength(0); // room gap ignored by setting
  });

  it("stale entry (window not covering now) is flagged as stale-entry", async () => {
    // Code IS on the door but expired an hour ago.
    s.ttlock.getPasscodesForLock("tt-main").push({
      id: 5555, lockId: "tt-main", code: "4711", name: "Anna Guest",
      startDate: new Date(Date.now() - 10 * HOUR), endDate: new Date(Date.now() - HOUR),
    } as any);

    const { gaps } = await auditCommonDoorCodes(s.storage as any, s.ttlock as any);

    expect(gaps).toHaveLength(1);
    expect(gaps[0].reason).toBe("stale-entry");
  });
});

describe("offline-episode tracking (C7)", () => {
  it("records first/last seen and starts a new episode after a >15 min gap", async () => {
    const s = makeSetup();

    await s.engine.trackLockOfflineEpisode("tt-main");
    const first1 = (await s.storage.getSetting("lock_offline_first:tt-main"))?.value;
    expect(first1).toBeTruthy();

    // Second observation shortly after: same episode, first unchanged.
    await s.engine.trackLockOfflineEpisode("tt-main");
    const first2 = (await s.storage.getSetting("lock_offline_first:tt-main"))?.value;
    expect(first2).toBe(first1);

    // Simulate recovery + a NEW outage 20 min later: last is stale → new episode
    // (backdate both markers so the refresh is measurable).
    const oldIso = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await s.storage.setSetting("lock_offline_last:tt-main", oldIso);
    await s.storage.setSetting("lock_offline_first:tt-main", oldIso);
    await s.engine.trackLockOfflineEpisode("tt-main");
    const first3 = (await s.storage.getSetting("lock_offline_first:tt-main"))?.value;
    // first must have been RESET to now (new episode), not kept at the old value.
    expect(Date.now() - Date.parse(first3!)).toBeLessThan(5000);
  });
});
