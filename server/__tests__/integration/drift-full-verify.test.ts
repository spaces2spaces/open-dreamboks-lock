/**
 * Drift-reconciler periodic FULL physical verification (C8, post-21/7).
 *
 * Coverage hole being closed: the quick path trusts any recorded real keyId
 * forever, so a code that vanished from the physical lock while its DB entry
 * stayed intact was NEVER re-checked. Now every FULL_VERIFY_TTL (6h) per
 * reservation the reconciler ignores the quick path and verifies every
 * assigned lock against the lock's actual passcode list.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestHarness, type TestHarness } from "./harness";

const HOUR = 3600 * 1000;
const PAST_ARRIVAL = new Date(Date.now() - 6 * HOUR).toISOString();
const PAST_DEPARTURE = new Date(Date.now() + 18 * HOUR).toISOString();

describe("drift reconciler — periodic full physical verification", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  async function setupActivePinOnLock() {
    const { room } = h.setupMappedRoom("101", "pms-101", "tt-room-101");

    await h.fireUpsertPending({
      pmsId: "RES-C8",
      status: "Confirmed",
      roomPmsId: "pms-101",
      arrival: PAST_ARRIVAL,
      departure: PAST_DEPARTURE,
    });
    const res = h.storage._reservations.find((r) => r.pmsId === "RES-C8")!;
    res.status = "Checked-in";
    h.mews.setMewsReservation("RES-C8", {
      State: "Started",
      AssignedResourceId: "pms-101",
      ScheduledStartUtc: PAST_ARRIVAL,
      ScheduledEndUtc: PAST_DEPARTURE,
    });

    await h.pinLifecycle.activatePendingForReservation(res.id);
    const pin = h.storage._pins[0];
    expect(pin.status).toBe("active");
    // Real push happened → real keyId recorded and code physically on the lock.
    expect(h.ttlock.getPasscodesForLock("tt-room-101").some((p: any) => p.code === pin.code)).toBe(true);

    return { res, pin };
  }

  it("cold start: full verify detects a code that vanished despite an intact DB keyId", async () => {
    const { pin } = await setupActivePinOnLock();

    // The 21/7-class failure: code disappears from the lock, DB entry intact.
    h.ttlock.getPasscodesForLock("tt-room-101").length = 0;

    const stats = await h.runDriftPass(); // lastFullVerify empty → full verify due

    expect(stats.ttlockDrift).toBeGreaterThanOrEqual(1);
    // Re-pushed — physically back on the door.
    expect(h.ttlock.getPasscodesForLock("tt-room-101").some((p: any) => p.code === pin.code)).toBe(true);
  });

  it("quick path still skips freshly verified reservations; TTL expiry re-verifies", async () => {
    const { res, pin } = await setupActivePinOnLock();

    // Pass 1 (cold): full verify, everything healthy → stamps lastFullVerify.
    await h.runDriftPass();
    const dr = h.driftReconciler as any;
    expect(dr.lastFullVerify.get(res.id)).toBeGreaterThan(0);

    // Remove the code; neutralize scan cooldowns but keep lastFullVerify fresh.
    h.ttlock.getPasscodesForLock("tt-room-101").length = 0;
    dr.lastVerified.clear();
    dr.consecutiveDriftFixes.clear();

    const statsQuick = await h.runDriftPass();
    // Quick path trusts the recorded keyId → NOT detected (by design, cheap).
    expect(statsQuick.ttlockDrift).toBe(0);
    expect(h.ttlock.getPasscodesForLock("tt-room-101").length).toBe(0);

    // Expire the full-verify TTL → next pass must catch it.
    dr.lastVerified.clear();
    dr.consecutiveDriftFixes.clear();
    dr.lastFullVerify.set(res.id, Date.now() - 7 * HOUR);

    const statsFull = await h.runDriftPass();
    expect(statsFull.ttlockDrift).toBeGreaterThanOrEqual(1);
    expect(h.ttlock.getPasscodesForLock("tt-room-101").some((p: any) => p.code === pin.code)).toBe(true);
  });

  it("failed list during full verify does NOT stamp lastFullVerify (retries next pass)", async () => {
    const { res } = await setupActivePinOnLock();

    h.ttlock.failListPasscodesForLock("tt-room-101");
    await h.runDriftPass();

    const dr = h.driftReconciler as any;
    expect(dr.lastFullVerify.get(res.id) ?? 0).toBe(0);
  });
});
