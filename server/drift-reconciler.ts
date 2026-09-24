/**
 * DriftReconciler
 *
 * Continuously verifies that the three sources of truth agree:
 *   1. MEWS (the PMS) — reservation room + dates + state
 *   2. Our DB        — reservation row + pin row
 *   3. TTLock        — the actual passcodes on the physical locks
 *
 * This is the safety net for every silent failure in the system:
 *  - MEWS polling missed an update → drift detected here, re-ingested
 *  - TTLock push failed on a subset of locks → drift detected, re-pushed
 *  - Manual MEWS change during a service restart → caught on next pass
 *  - Network blip during a room change → caught on next pass
 *
 * Runs every 60 seconds, scoped to *active* reservations
 * (arrival in the near future OR currently checked-in) with mapped rooms.
 * All drift is logged at `warn` level so it surfaces in monitoring.
 */

import type { ITenantStorage } from "./storage";
import type { AutomationEngine } from "./automation";
import type { MewsClient } from "./mews-client";
import type { IIngestionProcessor } from "./ingestion-processor";
import { MewsAdapter } from "./mews-adapter";
import type { Reservation, Pin, LockDevice } from "@shared/schema";

const RECONCILE_INTERVAL_MS = 60_000;
const MAX_RESERVATIONS_PER_PASS = 100;
// Skip reservations we successfully verified recently to keep MEWS API load sane.
// A full pass still touches every reservation at least once every ~5 minutes.
const VERIFIED_TTL_MS = 5 * 60_000;

interface LockKeyEntry {
  lockDeviceId: string;
  ttlockId: string;
  keyId: string;
  lockName: string;
  /** Repair verify attempts for an unresolved "existing" sentinel (see automation.ts). */
  verifyAttempts?: number;
  /** Code confirmed on the lock via repeated -3007 while invisible in the cloud list — trust it, don't re-verify. */
  confirmedUnlisted?: boolean;
}

// Cooldown after a "drift + fixed" push attempt. We wait before re-checking
// to give TTLock time to propagate. Escalates after consecutive failures.
const DRIFT_FIXED_COOLDOWN_MS = 3 * 60_000; // 3 min initial cooldown
const PHANTOM_BACKOFF_MS = 30 * 60_000; // 30 min after persistent phantom detection
const PHANTOM_THRESHOLD = 3; // consecutive "drift+fixed but drift recurs" → phantom

// Safety: if a pass has been running for longer than this, force-reset the running flag.
// A stuck API call (TTLock timeout, DB hang) must not permanently disable the reconciler.
const MAX_PASS_DURATION_MS = 5 * 60_000;

export class DriftReconciler {
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;
  private runStartedAt = 0;
  private lastVerified = new Map<string, number>();
  /** Tracks consecutive ttlock drift fix attempts per reservation that don't stick */
  private consecutiveDriftFixes = new Map<string, number>();
  private readonly mewsAdapter: MewsAdapter | null;

  // Periodic FULL physical verification (post-21/7): the quick path below
  // trusts any recorded real keyId forever, so a code that vanished from the
  // lock while its DB entry stayed intact was NEVER re-checked. Every
  // FULL_VERIFY_TTL_MS per reservation we ignore the quick path and verify
  // every assigned lock against the physical list. Capped per pass so a cold
  // start (empty map after deploy) doesn't hammer TTLock, and lock lists are
  // cached per pass so shared common doors are listed once, not per guest.
  private static readonly FULL_VERIFY_TTL_MS = 6 * 60 * 60 * 1000;
  private static readonly MAX_FULL_VERIFIES_PER_PASS = 10;
  private lastFullVerify = new Map<string, number>();
  private fullVerifiesThisPass = 0;
  private passListCache = new Map<string, Array<{ id: number; code: string; startDate: number; endDate: number }> | null>();

  private async listPasscodesForPass(
    ttlockClient: { listPasscodes(id: string): Promise<any> },
    ttlockId: string
  ): Promise<Array<{ id: number; code: string; startDate: number; endDate: number }>> {
    if (this.passListCache.has(ttlockId)) {
      const cached = this.passListCache.get(ttlockId);
      if (cached === null) throw new Error("listPasscodes failed earlier this pass (cached)");
      return cached!;
    }
    try {
      const list = await ttlockClient.listPasscodes(ttlockId);
      this.passListCache.set(ttlockId, list);
      return list;
    } catch (err) {
      this.passListCache.set(ttlockId, null);
      throw err;
    }
  }

  constructor(
    private readonly storage: ITenantStorage,
    private readonly engine: AutomationEngine,
    private readonly ingestion: IIngestionProcessor,
    private readonly tenantId: string,
    private readonly mewsClient: MewsClient | null
  ) {
    this.mewsAdapter = mewsClient ? new MewsAdapter(tenantId, mewsClient) : null;
  }

  start(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      this.runOnce().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.storage.createLog({
          level: "error",
          message: `DriftReconciler: pass crashed: ${msg}`,
          source: "drift-reconciler",
        }).catch(() => {});
        console.error(`[DriftReconciler] Pass failed for tenant ${this.tenantId}:`, err);
      });
    }, RECONCILE_INTERVAL_MS);
    // Kick off a first run immediately (after a short delay to let other workers boot)
    setTimeout(() => {
      this.storage.createLog({
        level: "info",
        message: "DriftReconciler: starting first pass",
        source: "drift-reconciler",
      }).catch(() => {});
      this.runOnce().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.storage.createLog({
          level: "error",
          message: `DriftReconciler: initial pass crashed: ${msg}`,
          source: "drift-reconciler",
        }).catch(() => {});
        console.error(`[DriftReconciler] Initial pass failed for tenant ${this.tenantId}:`, err);
      });
    }, 15_000);
    console.log(`[DriftReconciler] Started for tenant ${this.tenantId}`);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * One full pass over active reservations.
   * Safe to run manually (e.g. from admin endpoint).
   */
  async runOnce(): Promise<{ scanned: number; mewsDrift: number; ttlockDrift: number; fixed: number }> {
    if (this.running) {
      // Safety: force-reset if a previous pass has been stuck for too long
      if (this.runStartedAt > 0 && Date.now() - this.runStartedAt > MAX_PASS_DURATION_MS) {
        this.running = false;
        await this.storage.createLog({
          level: "error",
          message: `DriftReconciler: force-reset running flag — previous pass stuck for ${Math.round((Date.now() - this.runStartedAt) / 1000)}s`,
          source: "drift-reconciler",
        }).catch(() => {});
      } else {
        return { scanned: 0, mewsDrift: 0, ttlockDrift: 0, fixed: 0 };
      }
    }
    this.running = true;
    this.runStartedAt = Date.now();
    this.fullVerifiesThisPass = 0;
    this.passListCache.clear();
    const stats = { scanned: 0, mewsDrift: 0, ttlockDrift: 0, fixed: 0 };

    try {
      let active: Reservation[];
      let cancelled: Reservation[];
      try {
        active = await this.storage.getActiveReservationsWithPins();
        cancelled = await this.storage.getCancelledReservationsForDriftCheck();
      } catch (fetchErr) {
        await this.storage.createLog({
          level: "error",
          message: `DriftReconciler: failed to fetch reservations: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
          source: "drift-reconciler",
        });
        return stats;
      }
      // Also scan cancelled/checked-out reservations with future departures —
      // these may have been re-confirmed in MEWS (reverse drift).
      const seen = new Set(active.map((r) => r.id));
      const merged = [...active];
      for (const r of cancelled) {
        if (!seen.has(r.id)) {
          merged.push(r);
          seen.add(r.id);
        }
      }
      const toCheck = merged.slice(0, MAX_RESERVATIONS_PER_PASS);
      const now = Date.now();

      for (const reservation of toCheck) {
        const last = this.lastVerified.get(reservation.id) ?? 0;
        if (now - last < VERIFIED_TTL_MS) continue;

        stats.scanned++;
        try {
          const result = await this.reconcileReservation(reservation);
          if (result.mewsDrift) stats.mewsDrift++;
          if (result.ttlockDrift) stats.ttlockDrift++;
          if (result.fixed) stats.fixed++;
          if (!result.mewsDrift && !result.ttlockDrift) {
            // Clean: cache for VERIFIED_TTL_MS and reset consecutive counter
            this.lastVerified.set(reservation.id, now);
            this.consecutiveDriftFixes.delete(reservation.id);
          } else if (result.ttlockDrift && result.fixed) {
            // Drift was detected and "fixed" — but it may recur (phantom conflict).
            // Track consecutive occurrences and increase cooldown accordingly.
            const consecutive = (this.consecutiveDriftFixes.get(reservation.id) ?? 0) + 1;
            this.consecutiveDriftFixes.set(reservation.id, consecutive);
            if (consecutive >= PHANTOM_THRESHOLD) {
              // Likely phantom conflict on TTLock — back off significantly
              this.lastVerified.set(reservation.id, now - VERIFIED_TTL_MS + PHANTOM_BACKOFF_MS);
              if (consecutive === PHANTOM_THRESHOLD) {
                await this.storage.createLog({
                  level: "error",
                  message: `DriftReconciler: TTLock phantom conflict suspected for reservation ${reservation.pmsId} (${consecutive} consecutive drift+fix cycles) — backing off to 30 min`,
                  source: "drift-reconciler",
                  reservationId: reservation.id,
                });
              }
            } else {
              // Normal cooldown: wait 3 min before re-checking
              this.lastVerified.set(reservation.id, now - VERIFIED_TTL_MS + DRIFT_FIXED_COOLDOWN_MS);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.storage.createLog({
            level: "warn",
            message: `DriftReconciler: error on reservation ${reservation.id}: ${msg}`,
            source: "drift-reconciler",
            reservationId: reservation.id,
          });
        }
      }

      if (stats.mewsDrift > 0 || stats.ttlockDrift > 0) {
        await this.storage.createLog({
          level: "warn",
          message: `DriftReconciler pass: scanned=${stats.scanned} mewsDrift=${stats.mewsDrift} ttlockDrift=${stats.ttlockDrift} fixed=${stats.fixed}`,
          source: "drift-reconciler",
        });
      } else {
        // Heartbeat: log every pass so we can verify the reconciler is running
        await this.storage.createLog({
          level: "info",
          message: `DriftReconciler pass: scanned=${stats.scanned} — all clean (${active.length} active, ${cancelled.length} cancelled candidates)`,
          source: "drift-reconciler",
        });
      }
    } finally {
      this.running = false;
    }

    return stats;
  }

  /**
   * Reconcile a single reservation: used by the periodic pass AND by the
   * admin resync endpoint. Always fetches fresh MEWS state.
   */
  async reconcileReservation(
    reservation: Reservation
  ): Promise<{ mewsDrift: boolean; ttlockDrift: boolean; fixed: boolean }> {
    let mewsDrift = false;
    let ttlockDrift = false;
    let fixed = false;

    // ── 1. MEWS → DB drift ────────────────────────────────────────────────
    if (this.mewsClient && this.mewsAdapter && reservation.pmsId) {
      const mewsDriftResult = await this.checkAndFixMewsDrift(reservation);
      mewsDrift = mewsDriftResult.drift;
      if (mewsDriftResult.fixed) fixed = true;
    }

    // ── 2. DB → TTLock drift ──────────────────────────────────────────────
    // Re-fetch reservation in case step 1 updated it.
    const current = (await this.storage.getReservation(reservation.id)) || reservation;
    const ttlockDriftResult = await this.checkAndFixTTLockDrift(current);
    ttlockDrift = ttlockDriftResult.drift;
    if (ttlockDriftResult.fixed) fixed = true;

    return { mewsDrift, ttlockDrift, fixed };
  }

  /**
   * Compare reservation state with MEWS truth. If room assignment, arrival,
   * departure or state differ, re-ingest via the normal pipeline so that
   * PinLifecycleService.onRoomChanged / onDateChanged / onCancelled fires.
   */
  private async checkAndFixMewsDrift(
    reservation: Reservation
  ): Promise<{ drift: boolean; fixed: boolean }> {
    if (!this.mewsClient || !this.mewsAdapter || !reservation.pmsId) {
      return { drift: false, fixed: false };
    }

    let mewsRes;
    try {
      const list = await this.mewsClient.getReservations([reservation.pmsId]);
      mewsRes = list[0];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.storage.createLog({
        level: "warn",
        message: `DriftReconciler: MEWS fetch failed for ${reservation.pmsId}: ${msg}`,
        source: "drift-reconciler",
        reservationId: reservation.id,
      });
      return { drift: false, fixed: false };
    }

    if (!mewsRes) return { drift: false, fixed: false };

    // Compare room via pmsId (MEWS AssignedResourceId maps to our rooms.pmsId)
    const currentRoom = reservation.roomId ? await this.storage.getRoom(reservation.roomId) : null;
    const dbRoomPmsId = currentRoom?.pmsId ?? null;
    const mewsRoomPmsId = mewsRes.AssignedResourceId ?? null;

    // Compare arrival / departure (scheduled, fall back to actual)
    const mewsArrival = new Date(mewsRes.ScheduledStartUtc || mewsRes.StartUtc).getTime();
    const mewsDeparture = new Date(mewsRes.ScheduledEndUtc || mewsRes.EndUtc).getTime();
    const dbArrival = new Date(reservation.arrival).getTime();
    const dbDeparture = new Date(reservation.departure).getTime();
    const arrivalDrift = Math.abs(mewsArrival - dbArrival) > 60_000; // ±1 min tolerance
    const departureDrift = Math.abs(mewsDeparture - dbDeparture) > 60_000;

    // Compare state (terminal vs active, both directions)
    const mewsState = mewsRes.State;
    const dbStatus = reservation.status;
    const mewsIsActive = mewsState === "Confirmed" || mewsState === "Started";
    const dbIsTerminal = dbStatus === "Cancelled" || dbStatus === "Checked-out";
    const stateDrift =
      (mewsState === "Canceled" && dbStatus !== "Cancelled") ||
      (mewsState === "Processed" && dbStatus !== "Checked-out") ||
      // Reverse drift: MEWS re-confirmed/re-started but DB is still terminal.
      // This happens when a reservation is genuinely un-cancelled in MEWS.
      (mewsIsActive && dbIsTerminal);

    const roomDrift = dbRoomPmsId !== mewsRoomPmsId;

    if (!roomDrift && !arrivalDrift && !departureDrift && !stateDrift) {
      return { drift: false, fixed: false };
    }

    await this.storage.createLog({
      level: "warn",
      message:
        `DriftReconciler: MEWS drift detected for ${reservation.pmsId} — ` +
        `room: db=${dbRoomPmsId || "null"} mews=${mewsRoomPmsId || "null"}, ` +
        `arrivalDrift=${arrivalDrift}, departureDrift=${departureDrift}, ` +
        `state: db=${dbStatus} mews=${mewsState}. Re-ingesting...`,
      source: "drift-reconciler",
      reservationId: reservation.id,
      metadata: {
        dbRoomPmsId,
        mewsRoomPmsId,
        dbArrival: new Date(dbArrival).toISOString(),
        mewsArrival: new Date(mewsArrival).toISOString(),
        dbDeparture: new Date(dbDeparture).toISOString(),
        mewsDeparture: new Date(mewsDeparture).toISOString(),
        dbStatus,
        mewsState,
      },
    });

    // Re-ingest via the normal pipeline so room-change / date-change / cancel
    // hooks fire in PinLifecycleService.
    //
    // For reverse drift (MEWS re-confirmed a cancelled reservation), the upserted
    // event path in IngestionProcessor handles re-confirmation natively — it detects
    // existingReservation.status=Cancelled → new active status and creates a new PIN.
    // No status pre-reset is needed because processReservationUpserted has no
    // status downgrade guard (only processReservationStatusChanged does).

    try {
      const event = await this.mewsAdapter.fetchAndConvertSingleReservation(reservation.pmsId);
      if (event) {
        await this.ingestion.processEvent(event);
        await this.storage.createLog({
          level: "info",
          message: `DriftReconciler: MEWS drift fixed via re-ingestion for ${reservation.pmsId}`,
          source: "drift-reconciler",
          reservationId: reservation.id,
        });
        return { drift: true, fixed: true };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.storage.createLog({
        level: "warn",
        message: `DriftReconciler: re-ingestion failed for ${reservation.pmsId}: ${msg}`,
        source: "drift-reconciler",
        reservationId: reservation.id,
      });
    }

    return { drift: true, fixed: false };
  }

  /**
   * Verify that the reservation's active PIN is present on every assigned lock
   * with the correct code. If a lock is missing the PIN, re-push it via
   * PinLifecycleService.reconcilePinOnTTLock.
   */
  private async checkAndFixTTLockDrift(
    reservation: Reservation
  ): Promise<{ drift: boolean; fixed: boolean }> {
    const ttlockClient = this.engine.getTTLockClient();
    if (!ttlockClient) return { drift: false, fixed: false };
    if (!reservation.roomId) return { drift: false, fixed: false };

    // Only active / used PINs are relevant for TTLock verification.
    const pins = await this.storage.getPinsByReservationId(reservation.id);
    const activePin = pins.find((p) => p.status === "active" || p.status === "used");
    if (!activePin) return { drift: false, fixed: false };

    const assignments = await this.storage.getRoomLockAssignments(reservation.roomId);
    const assignedLocks = assignments
      .map((a) => a.lockDevice)
      .filter((ld): ld is LockDevice & { ttlockId: string } => !!ld?.ttlockId);

    if (assignedLocks.length === 0) return { drift: false, fixed: false };

    // Union of existing key entries recorded on the pin
    const existingKeyEntries: LockKeyEntry[] = [
      ...((activePin.roomLockKeyIds as LockKeyEntry[] | null) ?? []),
      ...((activePin.commonAreaKeyIds as LockKeyEntry[] | null) ?? []),
    ];
    const existingTTLockIds = new Set(existingKeyEntries.map((e) => e.ttlockId));

    // For every assigned lock, verify the PIN is actually on it.
    // Don't trust keyId="existing" — it's a sentinel meaning we never confirmed the PIN.
    // confirmedUnlisted entries ARE trusted: the lock repeatedly asserted the code
    // exists (-3007) while the cloud list can't show it, so list-verification is futile.
    const entriesWithSentinel = new Set(
      existingKeyEntries
        .filter((e) => e.keyId === "existing" && !e.confirmedUnlisted)
        .map((e) => e.ttlockId)
    );
    // Periodic full verification: ignore the quick path every FULL_VERIFY_TTL
    // so a code that disappeared from the lock while its DB keyId stayed intact
    // is discovered within hours instead of never (21/7 coverage hole #1).
    const fullVerifyDue =
      Date.now() - (this.lastFullVerify.get(reservation.id) ?? 0) > DriftReconciler.FULL_VERIFY_TTL_MS;
    const doFullVerify = fullVerifyDue && this.fullVerifiesThisPass < DriftReconciler.MAX_FULL_VERIFIES_PER_PASS;
    if (doFullVerify) this.fullVerifiesThisPass++;
    let fullVerifyClean = doFullVerify;

    const missingLocks: typeof assignedLocks = [];
    const resolvedSentinels: Array<{ ttlockId: string; oldKeyId: string; newKeyId: string; lockName: string }> = [];
    for (const lock of assignedLocks) {
      // Quick path: we recorded a REAL key for this lock → trust it
      // (skipped on the periodic full verification)
      if (!doFullVerify && existingTTLockIds.has(lock.ttlockId) && !entriesWithSentinel.has(lock.ttlockId)) continue;

      try {
        const passcodes = await this.listPasscodesForPass(ttlockClient, lock.ttlockId);
        const match = passcodes.find((p: any) => p.code === activePin.code);
        if (match) {
          // PIN IS on the lock — resolve sentinel keyId if applicable
          const entry = existingKeyEntries.find(
            (e) => e.ttlockId === lock.ttlockId && e.keyId === "existing"
          );
          if (entry) {
            entry.keyId = match.id.toString();
            resolvedSentinels.push({
              ttlockId: lock.ttlockId,
              oldKeyId: "existing",
              newKeyId: match.id.toString(),
              lockName: lock.name,
            });
          }
        } else if (existingKeyEntries.some((e) => e.ttlockId === lock.ttlockId && e.confirmedUnlisted)) {
          // confirmedUnlisted: the lock repeatedly asserted the code exists while
          // the cloud list cannot show it — a full verify must not "rediscover"
          // this as drift and start an endless re-push loop.
          continue;
        } else {
          missingLocks.push(lock);
        }
      } catch (err) {
        fullVerifyClean = false;
        const msg = err instanceof Error ? err.message : String(err);
        await this.storage.createLog({
          level: "warn",
          message: `DriftReconciler: listPasscodes failed on ${lock.name}: ${msg}`,
          source: "drift-reconciler",
          reservationId: reservation.id,
        });
      }
    }

    // Stamp only after a CLEAN full pass with NOTHING missing — a failed list
    // means we didn't verify, and detected drift means the fix must be
    // re-checked next pass rather than trusted blind for another 6 hours.
    if (doFullVerify && fullVerifyClean && missingLocks.length === 0) {
      this.lastFullVerify.set(reservation.id, Date.now());
    }
    // Invalidate the pass-scoped list cache for locks we are about to push to:
    // a later reservation in the SAME pass sharing these doors must not judge
    // its coverage from the pre-push snapshot.
    for (const lock of missingLocks) {
      this.passListCache.delete(lock.ttlockId);
    }

    // Persist resolved sentinels back to DB
    if (resolvedSentinels.length > 0) {
      const roomKeyIds = (activePin.roomLockKeyIds as LockKeyEntry[] | null) ?? [];
      const commonKeyIds = (activePin.commonAreaKeyIds as LockKeyEntry[] | null) ?? [];
      for (const resolved of resolvedSentinels) {
        const roomEntry = roomKeyIds.find((e) => e.ttlockId === resolved.ttlockId);
        if (roomEntry) roomEntry.keyId = resolved.newKeyId;
        const commonEntry = commonKeyIds.find((e) => e.ttlockId === resolved.ttlockId);
        if (commonEntry) commonEntry.keyId = resolved.newKeyId;
      }
      await this.storage.updatePin(activePin.id, {
        roomLockKeyIds: roomKeyIds,
        commonAreaKeyIds: commonKeyIds,
      });
      await this.storage.createLog({
        level: "info",
        message: `DriftReconciler: resolved ${resolvedSentinels.length} keyId sentinel(s) — ${resolvedSentinels.map((s) => `${s.lockName}: ${s.newKeyId}`).join(", ")}`,
        source: "drift-reconciler",
        reservationId: reservation.id,
      });
    }

    if (missingLocks.length === 0) return { drift: resolvedSentinels.length > 0, fixed: resolvedSentinels.length > 0 };

    await this.storage.createLog({
      level: "warn",
      message:
        `DriftReconciler: TTLock drift — PIN ${activePin.code} missing from ${missingLocks.length} lock(s): ` +
        missingLocks.map((l) => l.name).join(", ") +
        ". Re-pushing...",
      source: "drift-reconciler",
      reservationId: reservation.id,
      roomId: reservation.roomId,
    });

    // Re-push via PinLifecycleService (acquires per-reservation lock, retries, etc.)
    const pinLifecycle = this.engine.getPinLifecycle();
    const result = await pinLifecycle.reconcilePinOnTTLock(activePin.id);

    if (result.success) {
      await this.storage.createLog({
        level: "info",
        message: `DriftReconciler: TTLock drift fixed for ${reservation.pmsId}`,
        source: "drift-reconciler",
        reservationId: reservation.id,
      });
      return { drift: true, fixed: true };
    }

    await this.storage.createLog({
      level: "warn",
      message: `DriftReconciler: TTLock drift fix failed for ${reservation.pmsId}: ${result.error}`,
      source: "drift-reconciler",
      reservationId: reservation.id,
    });
    return { drift: true, fixed: false };
  }

  /**
   * Build a 3-way comparison for admin diagnostics.
   */
  async diagnose(reservation: Reservation): Promise<{
    reservationId: string;
    db: Record<string, unknown>;
    mews: Record<string, unknown> | null;
    ttlock: Array<Record<string, unknown>>;
    drift: { mews: boolean; ttlock: boolean };
  }> {
    const currentRoom = reservation.roomId ? await this.storage.getRoom(reservation.roomId) : null;
    const db: Record<string, unknown> = {
      id: reservation.id,
      pmsId: reservation.pmsId,
      status: reservation.status,
      arrival: reservation.arrival,
      departure: reservation.departure,
      roomId: reservation.roomId,
      roomPmsId: currentRoom?.pmsId ?? null,
      roomName: currentRoom?.name ?? null,
    };

    let mews: Record<string, unknown> | null = null;
    let mewsDrift = false;
    if (this.mewsClient && reservation.pmsId) {
      try {
        const list = await this.mewsClient.getReservations([reservation.pmsId]);
        const m = list[0];
        if (m) {
          mews = {
            id: m.Id,
            state: m.State,
            assignedResourceId: m.AssignedResourceId ?? null,
            scheduledStartUtc: m.ScheduledStartUtc,
            scheduledEndUtc: m.ScheduledEndUtc,
          };
          const dbRoomPmsId = currentRoom?.pmsId ?? null;
          mewsDrift = dbRoomPmsId !== (m.AssignedResourceId ?? null);
        }
      } catch (err) {
        mews = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    const ttlockSnapshot: Array<Record<string, unknown>> = [];
    let ttlockDrift = false;
    const ttlockClient = this.engine.getTTLockClient();
    const pins = await this.storage.getPinsByReservationId(reservation.id);
    const activePin = pins.find((p) => p.status === "active" || p.status === "used");

    if (ttlockClient && reservation.roomId) {
      const assignments = await this.storage.getRoomLockAssignments(reservation.roomId);
      const assignedLocks = assignments
        .map((a) => a.lockDevice)
        .filter((ld): ld is LockDevice & { ttlockId: string } => !!ld?.ttlockId);

      for (const lock of assignedLocks) {
        try {
          const passcodes = await ttlockClient.listPasscodes(lock.ttlockId);
          const match = activePin ? passcodes.find((p: any) => p.code === activePin.code) : null;
          const entry = {
            lockName: lock.name,
            ttlockId: lock.ttlockId,
            lockType: lock.lockType,
            expectedPinCode: activePin?.code ?? null,
            hasPinOnLock: !!match,
            keyId: match?.id ?? null,
          };
          ttlockSnapshot.push(entry);
          if (activePin && !match) ttlockDrift = true;
        } catch (err) {
          ttlockSnapshot.push({
            lockName: lock.name,
            ttlockId: lock.ttlockId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    db.pin = activePin
      ? {
          id: activePin.id,
          code: activePin.code,
          status: activePin.status,
          validFrom: activePin.validFrom,
          validTo: activePin.validTo,
        }
      : null;

    return {
      reservationId: reservation.id,
      db,
      mews,
      ttlock: ttlockSnapshot,
      drift: { mews: mewsDrift, ttlock: ttlockDrift },
    };
  }
}
