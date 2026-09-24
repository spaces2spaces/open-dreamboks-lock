/**
 * Chronic-failure backoff for the 5-minute repair job.
 *
 * A code that hard-fails repair run after run (e.g. a conflicting entry on the
 * main entrance) must not keep the lock busy every 5 minutes — that delays
 * every OTHER guest's push to the same lock (Martin's "codes update slower"
 * complaint). Rules under test:
 *  - fails 1-2: retried on every run (fast recovery preserved)
 *  - fail 3+: pin backs off (10 → 20 → ... max 60 min)
 *  - offline locks never back off (fast retry heals gateway outages)
 *  - success clears the backoff state
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AutomationEngine } from "../../automation";
import { createMockStorage } from "../mocks/storage";
import { createMockTTLockClient } from "../mocks/ttlock-client";

const HOUR = 3600 * 1000;

function makeSetup() {
  const storage = createMockStorage({
    check_in_time: "15:00",
    reservation_checkout_time: "11:00",
    property_timezone: "Europe/Copenhagen",
  });
  const ttlock = createMockTTLockClient();
  const engine = new AutomationEngine(storage as any, ttlock as any);

  storage._rooms.push({ id: "room-1", name: "101" } as any);
  const mainDoor: any = { id: "ld-main", ttlockId: "tt-main", name: "Main Entrance", lockType: "common" };
  storage._lockAssignments.push({ roomId: "room-1", lockDevice: mainDoor, assignmentType: "common" });
  storage._reservations.push({
    id: "res-1", pmsId: "M-1", roomId: "room-1", status: "Checked-in",
    firstName: "Emma", lastName: "Stöckhardt",
    arrival: new Date(Date.now() - 6 * HOUR), departure: new Date(Date.now() + 18 * HOUR),
  } as any);
  storage._pins.push({
    id: "pin-1", roomId: "room-1", reservationId: "res-1", code: "6311", name: "Emma Stöckhardt",
    status: "active",
    validFrom: new Date(Date.now() - 6 * HOUR), validTo: new Date(Date.now() + 18 * HOUR),
    roomLockKeyIds: [], commonAreaKeyIds: [], // main entrance missing → repair target
  } as any);

  return { storage, ttlock, engine };
}

describe("repair chronic-failure backoff", () => {
  let s: ReturnType<typeof makeSetup>;

  beforeEach(() => {
    s = makeSetup();
  });

  it("retries the first runs, then backs off from the 3rd consecutive hard failure", async () => {
    // Persistent NON-offline failure (generic error → hard fail).
    s.ttlock.failWithCode("addPasscode", 99999);

    const r1 = await s.engine.repairActivePinsWithMissingLocks();
    const r2 = await s.engine.repairActivePinsWithMissingLocks();
    const r3 = await s.engine.repairActivePinsWithMissingLocks();
    expect(r1.failed + r2.failed + r3.failed).toBe(3); // all three attempted

    // 4th run immediately after: pin is in backoff → skipped, lock left alone.
    const callsBefore = s.ttlock.getCallsFor("addPasscode").length;
    const r4 = await s.engine.repairActivePinsWithMissingLocks();
    expect(r4.backedOff).toBe(1);
    expect(r4.failed).toBe(0);
    expect(s.ttlock.getCallsFor("addPasscode").length).toBe(callsBefore);
  });

  it("offline locks are never backed off (gateway recovery must stay fast)", async () => {
    s.ttlock.failWithCode("addPasscode", -3034); // "device not connected to network"

    for (let i = 0; i < 4; i++) {
      const r = await s.engine.repairActivePinsWithMissingLocks();
      expect(r.deferred).toBe(1); // offline = deferred, not failed
      expect(r.backedOff).toBe(0);
    }
  });

  it("backoff expires and success clears the state", async () => {
    s.ttlock.failWithCode("addPasscode", 99999);
    for (let i = 0; i < 3; i++) await s.engine.repairActivePinsWithMissingLocks();

    // Fast-forward past the backoff window, and let the push succeed now.
    (s.engine as any).repairBackoff.get("pin-1")!.nextAttemptAt = Date.now() - 1;
    s.ttlock.clearFailWithCode();

    const r = await s.engine.repairActivePinsWithMissingLocks();
    expect(r.repaired).toBe(1);
    expect((s.engine as any).repairBackoff.has("pin-1")).toBe(false);
    // Code physically landed on the door.
    expect(s.ttlock.getPasscodesForLock("tt-main").some((p: any) => p.code === "6311")).toBe(true);
  });
});
