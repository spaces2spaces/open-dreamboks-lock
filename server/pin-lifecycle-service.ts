/**
 * PinLifecycleService
 *
 * Single source of truth for all PIN lifecycle events.
 * Troubleshooting: look here first.
 *
 * Public methods (business events):
 *   onReservationCreated  — new reservation in mapped room → create pending PIN + sync to MEWS
 *   onArrivalDateChanged  — arrival date changed → update validity or delete+recreate pending
 *   onDepartureDateChanged — departure changed → update valid_to in DB and TTLock
 *   onRoomChanged         — room assignment changed → migrate PIN to new room
 *   onCancelled           — reservation cancelled/checked-out → remove PIN from TTLock
 *   activateForToday      — scheduled: push today's pending PINs to TTLock
 *
 * MEWS sync only happens in onReservationCreated — never again.
 */

import { ITenantStorage } from "./storage";
import { TTLockClient, isLockOfflineError } from "./ttlock-client";
import { MewsClient } from "./mews-client";
import { DateTime } from "luxon";
import { randomInt } from "crypto";
import { buildValidityWindow } from "./pin-validity-window";
import { sendOpsAlert } from "./ops-alert";
import type { Reservation, Pin, LockDevice } from "@shared/schema";

interface LockKeyEntry {
  lockDeviceId: string;
  ttlockId: string;
  keyId: string;
  lockName: string;
  /** Repair verify attempts for an unresolved "existing" sentinel (see automation.ts). */
  verifyAttempts?: number;
  /** TTLock's cloud list never showed the code, but the lock insists it exists (-3007 on every push).
   *  Trusted as on-lock; repair/drift passes must not re-verify these. */
  confirmedUnlisted?: boolean;
}

export class PinLifecycleService {
  // Per-reservation mutex to prevent concurrent PIN operations on the same reservation.
  // Key: reservationId, Value: Promise chain for that reservation.
  private reservationLocks = new Map<string, Promise<void>>();

  // Single-flight flag for the activateForToday sweep — overlapping sweeps
  // re-push the same pending pins and stampede the TTLock API (3/8 incident).
  private activateSweepInFlight = false;

  // In-memory retry counters for delete_failed PINs.
  // Resets on server restart (intentional — gives transient failures another chance).
  private deleteRetryCounters = new Map<string, number>();
  static readonly MAX_DELETE_RETRIES = 5;
  // After MAX_DELETE_RETRIES failed attempts a pin is NOT abandoned — a code
  // left on a lock after a room move/cancellation is live access for the wrong
  // person (Julius/103, 22/7: guest moved 23:12, gateway flaky, all 5 retries
  // burned in ~25 min at the 5-min repair cadence, code opened the old capsule
  // at 00:53). Instead: escalate once via ops-alert and keep retrying on a
  // slower cadence until the lock comes back.
  static readonly DELETE_RETRY_BACKOFF_MS = 30 * 60 * 1000;
  private deleteRetryBackoffUntil = new Map<string, number>();

  constructor(
    private storage: ITenantStorage,
    private ttlockClient: TTLockClient | null,
    private mewsClient: MewsClient | null
  ) {}

  /**
   * Acquire a per-reservation lock. Concurrent callers for the same reservationId
   * wait in FIFO order. Different reservationIds run in parallel.
   * Public: AutomationEngine.repairPasscodeForReservation shares this mutex —
   * the report's force-repair and the 5-min sweep can hit the SAME reservation
   * in the same scheduler tick, and both do read-modify-write on the pin's
   * keyId arrays (last writer used to wipe the other's verifyAttempts).
   */
  async withReservationLock<T>(reservationId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.reservationLocks.get(reservationId) ?? Promise.resolve();
    let resolve: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    this.reservationLocks.set(reservationId, next);

    await prev; // wait for prior operation on this reservation to finish
    try {
      return await fn();
    } finally {
      resolve!();
      // Clean up to prevent memory leak (only if we're still the tail of the chain)
      if (this.reservationLocks.get(reservationId) === next) {
        this.reservationLocks.delete(reservationId);
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Generate a 4-digit PIN that TTLock won't reject as "too simple" (errcode -2032).
   * Avoids: consecutive sequences (1234, 8765), repeated digits (1111, 2222),
   * and common patterns (1234, 0000, etc.)
   */
  generateSafePasscode(): string {
    return this.generateRandomPasscode();
  }

  private generateRandomPasscode(): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = randomInt(1000, 10000).toString();
      if (this.isTTLockSafeCode(code)) return code;
    }
    // Extremely unlikely fallback — 50 attempts failed
    return randomInt(1000, 10000).toString();
  }

  private async generateUniquePasscode(excludeReservationId: string): Promise<string> {
    const all = await this.storage.getAllReservations();
    const used = new Set(
      all
        .filter(r => r.id !== excludeReservationId &&
                     r.status !== "Cancelled" &&
                     r.status !== "No-show" &&
                     r.generatedPin)
        .map(r => r.generatedPin!)
    );
    // Also exclude live HOURLY rental codes: they share the common front-door
    // locks, and a duplicate there makes TTLock return -3007 so the two flows
    // would resolve to (and later delete) each other's keyIds.
    try {
      const hourly = await this.storage.getHourlyBookingsOverlapping(
        new Date(Date.now() - 24 * 3_600_000),
        new Date(Date.now() + 365 * 24 * 3_600_000),
        ["confirmed", "pending_payment"],
      );
      for (const b of hourly) if (b.pinCode) used.add(b.pinCode);
    } catch {
      /* hourly table unavailable — proceed with reservation codes only */
    }
    for (let attempt = 0; attempt < 200; attempt++) {
      const code = this.generateRandomPasscode();
      if (!used.has(code)) return code;
    }
    // Fallback — should never happen (~9000 valid codes, rarely >600 in use)
    return this.generateRandomPasscode();
  }

  private isTTLockSafeCode(code: string): boolean {
    const digits = code.split("").map(Number);
    // Reject all same digit (1111, 2222, etc.)
    if (new Set(digits).size === 1) return false;
    // Reject ascending sequences (1234, 2345, etc.)
    const isAscending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
    if (isAscending) return false;
    // Reject descending sequences (9876, 8765, etc.)
    const isDescending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
    if (isDescending) return false;
    // Reject repeated pairs (1212, 3434, etc.)
    if (digits[0] === digits[2] && digits[1] === digits[3]) return false;
    return true;
  }

  private async buildValidityWindow(
    reservation: Reservation
  ): Promise<{ validFrom: Date; validTo: Date }> {
    return buildValidityWindow(this.storage, reservation);
  }

  private async isRoomMapped(roomId: string): Promise<boolean> {
    return this.storage.isRoomMapped(roomId);
  }

  /**
   * Central guest-access invariant.
   *
   * A reservation should have a PIN (in DB and on TTLock) iff ALL of:
   *   1. Room assigned
   *   2. Room mapped (TTLock configured)
   *   3. Status is not cancelled / checked-out / no-show
   *   4. Outstanding balance is zero
   *   5. Validity window has not fully expired (now < validTo)
   *
   * Used by every code path that creates or pushes a PIN. Handlers that
   * only *delete* never need this guard.
   */
  private async _shouldHavePin(reservation: Reservation): Promise<boolean> {
    if (!reservation.roomId) return false;
    if (!(await this.isRoomMapped(reservation.roomId))) return false;

    const status = (reservation.status || "").toLowerCase();
    if (
      status === "cancelled" ||
      status === "canceled" ||
      status === "checked-out" ||
      status === "no-show"
    ) {
      return false;
    }

    const owing = parseFloat(reservation.owing ?? "0") || 0;
    if (owing > 0) return false;

    // Use the real validity window (honours check_in_time / reservation_checkout_time
    // in the property timezone) — comparing the raw departure date incorrectly blocks
    // the morning of checkout day before the configured checkout time.
    try {
      const window = await this.buildValidityWindow(reservation);
      if (window.validTo.getTime() < Date.now()) return false;
    } catch {
      // If we can't compute the window, fall back to raw departure +1 day to avoid
      // a hard block that would strand valid guests.
      const fallbackCutoff = new Date(reservation.departure).getTime() + 24 * 60 * 60 * 1000;
      if (fallbackCutoff < Date.now()) return false;
    }

    return true;
  }

  private async getCachedKeyboardPwdVersion(
    ttlockId: string,
    lockDeviceId?: string
  ): Promise<number | null> {
    const device = lockDeviceId
      ? await this.storage.getLockDevice(lockDeviceId)
      : await this.storage.getLockDeviceByTTLockId(ttlockId);

    if (device?.keyboardPwdVersion != null) {
      return device.keyboardPwdVersion;
    }

    if (!this.ttlockClient) return null;
    try {
      const details = await this.ttlockClient.getLockStatus(ttlockId);
      if (!details?.keyboardPwdVersion) return null;
      if (device) {
        await this.storage.updateLockDevice(device.id, {
          keyboardPwdVersion: details.keyboardPwdVersion,
        });
      }
      return details.keyboardPwdVersion;
    } catch {
      return null;
    }
  }

  /**
   * Create a pending PIN record in the DB.
   * CRITICAL: Always reuses reservation.generatedPin — the PIN code assigned at booking
   * time is permanent and MUST NEVER change. It was already synced to MEWS and shown to
   * the guest. Only generates a new code if generatedPin has never been set.
   * Uses reservation.roomId — caller must ensure it's set to the target room.
   */
  private async createPendingPin(reservation: Reservation): Promise<void> {
    if (!reservation.roomId) return;

    // Always re-read from DB to get the authoritative generatedPin
    // (the in-memory reservation object may be stale after room changes or PIN operations)
    const freshReservation = await this.storage.getReservation(reservation.id);
    const existingCode = freshReservation?.generatedPin || reservation.generatedPin;

    const code = existingCode || await this.generateUniquePasscode(reservation.id);
    const window = await this.buildValidityWindow(reservation);
    const guestName = `${reservation.firstName} ${reservation.lastName}`;

    // Loop-breaker (22/7 incident): NEVER create a pin whose window is inverted
    // or already fully in the past. Such a pin can never work on a lock, gets
    // cancelled by cleanup, and the checked-in recreate loop then mints codes
    // and MEWS notes forever. Alert instead so a data problem surfaces once.
    if (window.validTo.getTime() <= window.validFrom.getTime() || window.validTo.getTime() <= Date.now()) {
      await this.storage.createLog({
        level: "error",
        message: `PIN creation refused for ${guestName}: invalid validity window (${window.validFrom.toISOString()} → ${window.validTo.toISOString()}) — check reservation dates`,
        source: "pin-lifecycle",
        reservationId: reservation.id,
        roomId: reservation.roomId,
      });
      await sendOpsAlert(
        this.storage as any,
        // Keyed on the STABLE pms id (26/7 mail storm): a churn loop that
        // re-creates the local row every poll mints a fresh reservation.id
        // each minute — an id-based key defeats the 1h dedupe entirely.
        `invalid-pin-window:${reservation.pmsId || reservation.id}`,
        "warning",
        `PIN-oprettelse afvist for ${guestName} — ugyldigt gyldighedsvindue`,
        `Vindue: ${window.validFrom.toISOString()} → ${window.validTo.toISOString()}. Tjek reservationens ankomst/afrejse i MEWS.`
      );
      return;
    }

    if (!existingCode) {
      await this.storage.updateReservation(reservation.id, { generatedPin: code });
    }

    await this.storage.createPin({
      roomId: reservation.roomId,
      reservationId: reservation.id,
      type: "Passcode",
      code,
      name: guestName,
      email: reservation.email || undefined,
      validFrom: window.validFrom,
      validTo: window.validTo,
      status: "pending",
      doors: [],
      assigner: "Automation",
      ttlockKeyId: undefined,
      roomLockKeyIds: [],
      commonAreaKeyIds: [],
    });

    await this.storage.createReservationLog({
      reservationId: reservation.id,
      message: "PIN generated (pending activation)",
      type: "pin_generated",
      detail: `PIN ${code} created, will be activated on arrival day`,
    });

    await this.storage.createLog({
      level: "info",
      message: `PIN generated for reservation (pending)`,
      source: "pin-lifecycle",
      reservationId: reservation.id,
      roomId: reservation.roomId,
      metadata: { pin: code },
    });
  }

  /**
   * Push a pending PIN to all locks for the reservation's room.
   * Updates pin status to "active" on success.
   * Returns true if at least one lock was programmed.
   */
  private async pushToTTLock(pin: Pin, reservation: Reservation): Promise<boolean> {
    if (!this.ttlockClient || !reservation.roomId) return false;

    // Final security gate — re-read the reservation and verify ALL invariants
    // (mapped room / not cancelled / owing == 0 / not past) before programming
    // any physical lock. Any prior caller may have operated on a stale object.
    const fresh = (await this.storage.getReservation(reservation.id)) || reservation;
    if (!(await this._shouldHavePin(fresh))) {
      await this.storage.createLog({
        level: "info",
        message: "PIN push blocked — access invariants not satisfied",
        source: "pin-lifecycle",
        reservationId: fresh.id,
        roomId: fresh.roomId ?? undefined,
        metadata: {
          status: fresh.status,
          owing: fresh.owing,
          departure: fresh.departure,
          roomId: fresh.roomId,
        },
      });
      return false;
    }

    // Activation window gate — never program a lock before `check_in_time - 1h`.
    // Pending PINs are created ahead of time in DB, but the physical lock is only
    // touched once the activation window has opened. This rule overrides the
    // MEWS "checked-in" status: even if reception marks the guest early, we wait.
    if (!(await this._isWithinActivationWindow(fresh))) {
      await this.storage.createLog({
        level: "info",
        message: "PIN push blocked — activation window not yet open (scheduler will push later)",
        source: "pin-lifecycle",
        reservationId: fresh.id,
        roomId: fresh.roomId ?? undefined,
        metadata: {
          status: fresh.status,
          arrival: fresh.arrival,
        },
      });
      return false;
    }

    const room = await this.storage.getRoom(reservation.roomId);
    if (!room) return false;

    const roomLockAssignments = await this.storage.getRoomLockAssignments(room.id);
    const assignedLocks = roomLockAssignments
      .map((a) => a.lockDevice)
      .filter(
        (ld): ld is LockDevice & { ttlockId: string } => !!ld?.ttlockId
      );

    // Require at least one lock assigned via room_lock_assignments
    if (assignedLocks.length === 0) {
      await this.storage.createLog({
        level: "info",
        message: `PIN activation skipped — room has no locks configured`,
        source: "pin-lifecycle",
        reservationId: reservation.id,
        roomId: room.id,
      });
      return false;
    }

    const locksToProgram: Array<{
      ttlockId: string;
      lockName: string;
      lockDeviceId?: string;
    }> = [];

    for (const lock of assignedLocks) {
      locksToProgram.push({
        ttlockId: lock.ttlockId,
        lockName: lock.name,
        lockDeviceId: lock.id,
      });
    }

    const guestName = `${reservation.firstName} ${reservation.lastName}`;
    const shortName = guestName.length > 20 ? guestName.substring(0, 20) : guestName;
    const roomLockKeyIds: LockKeyEntry[] = [];
    const commonAreaKeyIds: LockKeyEntry[] = [];
    let primaryTtlockKeyId: string | null = null;
    let successCount = 0;

    // Effective startDate on TTLock: min(scheduled validFrom, now - 1 min).
    // The activation window already gates early pushes (see pushToTTLock guard),
    // so by the time we reach this code it is safe to let the PIN work from "now"
    // — which is exactly what the guest expects after reception checks them in.
    // Using the raw scheduled validFrom (e.g. 15:00) would make the lock refuse
    // the PIN until 15:00 even though the boarding card and remote unlock work.
    const scheduledValidFrom = new Date(pin.validFrom);
    const effectiveStartDate = new Date(
      Math.min(scheduledValidFrom.getTime(), Date.now() - 60 * 1000)
    );
    const effectiveEndDate = new Date(pin.validTo);

    await this.storage.createLog({
      level: "info",
      message: `pushToTTLock: Programming ${locksToProgram.length} lock(s) for ${guestName}: ${locksToProgram.map(l => `${l.lockName} (${l.ttlockId})`).join(", ")} (validFrom ${effectiveStartDate.toISOString()} → validTo ${effectiveEndDate.toISOString()})`,
      source: "pin-lifecycle",
      reservationId: reservation.id,
      roomId: room.id,
    });

    // Retry helper for transient TTLock failures (gateway offline, timeout, error code 1).
    // Non-transient errors (-3007 "already exists", auth, bad params) are NOT retried —
    // they bubble up immediately so the outer catch can classify them.
    const isTransient = (msg: string): boolean => {
      // A lock offline (gateway down) won't recover within a 6s inline backoff —
      // fail fast and let the periodic drift reconciler retry when it reconnects,
      // instead of burning 3 attempts + latency + log noise per offline lock.
      if (isLockOfflineError(msg)) return false;
      if (msg.includes("-3007")) return false;
      if (msg.includes("access_token") || msg.includes("-2012")) return false;
      return (
        msg.includes("error: 1 -") ||
        msg.includes("failed or means no") ||
        msg.includes("timeout") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ENOTFOUND") ||
        msg.includes("fetch failed") ||
        msg.includes("network")
      );
    };

    const ttlockClient = this.ttlockClient;
    const addPasscodeWithRetry = async (
      lock: { ttlockId: string; lockName: string; lockDeviceId?: string },
      keyboardPwdVersion: number
    ) => {
      const maxAttempts = 3;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await ttlockClient.addPasscode(lock.ttlockId, pin.code, shortName, {
            startDate: effectiveStartDate,
            endDate: effectiveEndDate,
            keyboardPwdVersion,
          });
        } catch (err) {
          lastError = err;
          const msg = err instanceof Error ? err.message : String(err);
          if (!isTransient(msg) || attempt === maxAttempts) throw err;
          await this.storage.createLog({
            level: "info",
            message: `PIN push transient failure on ${lock.lockName} (attempt ${attempt}/${maxAttempts}): ${msg} — retrying`,
            source: "pin-lifecycle",
            reservationId: reservation.id,
            roomId: room.id,
          });
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
      throw lastError;
    };

    for (const lock of locksToProgram) {
      try {
        const keyboardPwdVersion = await this.getCachedKeyboardPwdVersion(
          lock.ttlockId,
          lock.lockDeviceId
        );
        if (!keyboardPwdVersion) continue;

        const result = await addPasscodeWithRetry(lock, keyboardPwdVersion);

        const keyId = result.id.toString();
        if (lock.lockDeviceId) {
          const lockDevice = assignedLocks.find((l) => l.id === lock.lockDeviceId);
          const entry: LockKeyEntry = {
            lockDeviceId: lock.lockDeviceId,
            ttlockId: lock.ttlockId,
            keyId,
            lockName: lock.lockName,
          };
          if (lockDevice?.lockType === "room") {
            roomLockKeyIds.push(entry);
          } else {
            commonAreaKeyIds.push(entry);
          }
        }
        if (!primaryTtlockKeyId) primaryTtlockKeyId = keyId;
        successCount++;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg.includes("-3007")) {
          // PIN already exists on this lock — treat as success, resolve keyId
          let resolvedKeyId = "existing";
          try {
            const existing = await this.ttlockClient.listPasscodes(lock.ttlockId);
            const match = existing.find((p: any) => p.code === pin.code);
            if (match) resolvedKeyId = match.id.toString();
          } catch {
            /* fall through — use sentinel */
          }
          if (lock.lockDeviceId) {
            const lockDevice = assignedLocks.find((l) => l.id === lock.lockDeviceId);
            const entry: LockKeyEntry = {
              lockDeviceId: lock.lockDeviceId,
              ttlockId: lock.ttlockId,
              keyId: resolvedKeyId,
              lockName: lock.lockName,
            };
            if (lockDevice?.lockType === "room") {
              roomLockKeyIds.push(entry);
            } else {
              commonAreaKeyIds.push(entry);
            }
          }
          if (!primaryTtlockKeyId) primaryTtlockKeyId = resolvedKeyId;
          successCount++;
          await this.storage.createLog({
            level: "info",
            message: `PIN already on ${lock.lockName} — recorded keyId ${resolvedKeyId}`,
            source: "pin-lifecycle",
            reservationId: reservation.id,
            roomId: room.id,
          });
        } else if (isLockOfflineError(errMsg)) {
          // Lock's gateway is offline — NOT a guest failure. The PIN still lands
          // on every reachable lock; this one is deferred and the drift reconciler
          // re-pushes it automatically once the lock reconnects.
          //
          // Offline-episode tracking (same keys as AutomationEngine's): lets the
          // arrival report escalate a common door that stays down > 30 min.
          try {
            const nowMs = Date.now();
            const lastRaw = (await this.storage.getSetting(`lock_offline_last:${lock.ttlockId}`))?.value;
            const firstRaw = (await this.storage.getSetting(`lock_offline_first:${lock.ttlockId}`))?.value;
            const last = lastRaw ? Date.parse(lastRaw) : NaN;
            if (!Number.isFinite(last) || nowMs - last > 15 * 60 * 1000 || !firstRaw) {
              await this.storage.setSetting(`lock_offline_first:${lock.ttlockId}`, new Date(nowMs).toISOString());
            }
            await this.storage.setSetting(`lock_offline_last:${lock.ttlockId}`, new Date(nowMs).toISOString());
          } catch { /* tracking must never break the push */ }
          await this.storage.createLog({
            level: "warn",
            message: `PIN push deferred on ${lock.lockName} — lock offline (${errMsg}); will retry when it reconnects`,
            source: "pin-lifecycle",
            reservationId: reservation.id,
            roomId: room.id,
          });
        } else {
          await this.storage.createLog({
            level: "error",
            message: `PIN push failed on ${lock.lockName}: ${errMsg}`,
            source: "pin-lifecycle",
            reservationId: reservation.id,
            roomId: room.id,
          });
        }
      }
    }

    if (successCount === 0) return false;

    // Post-push verification: for any lock with keyId="existing", verify the PIN
    // is actually on the lock and resolve the real keyId. If the PIN is NOT on the
    // lock (listPasscodes returns empty), re-push it — the -3007 was stale/spurious.
    const allEntries = [...roomLockKeyIds, ...commonAreaKeyIds];
    const unresolvedEntries = allEntries.filter((e) => e.keyId === "existing");
    if (unresolvedEntries.length > 0) {
      for (const entry of unresolvedEntries) {
        try {
          const passcodes = await this.ttlockClient.listPasscodes(entry.ttlockId);
          const match = passcodes.find((p: any) => p.code === pin.code);
          if (match) {
            // PIN is on lock — resolve keyId
            entry.keyId = match.id.toString();
          } else {
            // PIN NOT on lock despite -3007! Re-push.
            const lock = locksToProgram.find((l) => l.ttlockId === entry.ttlockId);
            if (lock) {
              try {
                const kbVer = await this.getCachedKeyboardPwdVersion(lock.ttlockId, lock.lockDeviceId);
                if (kbVer) {
                  const result = await addPasscodeWithRetry(lock, kbVer);
                  entry.keyId = result.id.toString();
                  await this.storage.createLog({
                    level: "info",
                    message: `Post-push verification: PIN was NOT on ${entry.lockName} despite -3007 — re-pushed successfully (keyId=${entry.keyId})`,
                    source: "pin-lifecycle",
                    reservationId: reservation.id,
                    roomId: room.id,
                  });
                }
              } catch (repushErr) {
                const errMsg = repushErr instanceof Error ? repushErr.message : String(repushErr);
                // -3007 = "same passcode already exists" — PIN IS on the lock, just not visible in listPasscodes
                const isAlreadyExists = errMsg.includes("-3007");
                // Double -3007 (original push + re-push) with an empty list = TTLock cloud
                // inconsistency. Mark confirmed so repair/drift don't retry forever.
                if (isAlreadyExists) entry.confirmedUnlisted = true;
                await this.storage.createLog({
                  level: isAlreadyExists ? "info" : "error",
                  message: isAlreadyExists
                    ? `Post-push verification: PIN confirmed on ${entry.lockName} (already exists per TTLock API — listPasscodes inconsistency)`
                    : `Post-push verification: PIN missing from ${entry.lockName} and re-push failed: ${errMsg}`,
                  source: "pin-lifecycle",
                  reservationId: reservation.id,
                  roomId: room.id,
                });
              }
            }
          }
        } catch {
          /* listPasscodes failed — sentinel stays, will retry on deletion */
        }
      }
      // Update primaryTtlockKeyId if it was also "existing"
      if (primaryTtlockKeyId === "existing") {
        const firstResolved = allEntries.find((e) => e.keyId !== "existing");
        if (firstResolved) primaryTtlockKeyId = firstResolved.keyId;
      }
      // Log outcome
      const stillUnresolved = allEntries.filter((e) => e.keyId === "existing");
      if (stillUnresolved.length > 0) {
        await this.storage.createLog({
          level: "warn",
          message: `Post-push verification: ${stillUnresolved.length} lock(s) still have keyId="existing" unresolved — deletion will require keyId lookup`,
          source: "pin-lifecycle",
          reservationId: reservation.id,
          roomId: room.id,
          metadata: { locks: stillUnresolved.map((e) => e.lockName) },
        });
      } else if (unresolvedEntries.length > 0) {
        await this.storage.createLog({
          level: "info",
          message: `Post-push verification resolved ${unresolvedEntries.length} keyId(s) — all PINs confirmed on locks`,
          source: "pin-lifecycle",
          reservationId: reservation.id,
          roomId: room.id,
        });
      }
    }

    // Merge, don't overwrite (post-21/7): keep prior entries for locks that
    // were NOT successfully recorded in THIS run — e.g. a common door whose
    // gateway is offline right now but which already carries the code from an
    // earlier push. Overwriting dropped those entries from the DB, so checkout
    // skipped deleting the code there → stale codes accumulated on doors.
    // Entries recorded this run always win; legacy entries without a ttlockId
    // are kept untouched (they can't collide and checkout still needs them).
    const parsePriorEntries = (v: unknown): LockKeyEntry[] => {
      let value = v as any;
      if (typeof value === "string") {
        try { value = JSON.parse(value); } catch { return []; }
      }
      return Array.isArray(value) ? value : [];
    };
    const recordedThisRun = new Set(
      [...roomLockKeyIds, ...commonAreaKeyIds].map((e) => e.ttlockId)
    );
    for (const prev of parsePriorEntries(pin.roomLockKeyIds)) {
      const tid = (prev as any)?.ttlockId;
      if (!tid || !recordedThisRun.has(tid)) {
        roomLockKeyIds.push(prev);
        if (tid) recordedThisRun.add(tid);
      }
    }
    for (const prev of parsePriorEntries(pin.commonAreaKeyIds)) {
      const tid = (prev as any)?.ttlockId;
      if (!tid || !recordedThisRun.has(tid)) {
        commonAreaKeyIds.push(prev);
        if (tid) recordedThisRun.add(tid);
      }
    }

    await this.storage.updatePin(pin.id, {
      status: "active",
      activatedAt: new Date(),
      ttlockKeyId: primaryTtlockKeyId || undefined,
      roomLockKeyIds,
      commonAreaKeyIds,
      qrCodeData: [],
      ttlockQrCodeIds: {},
    });

    await this.storage.createReservationLog({
      reservationId: reservation.id,
      message: `PIN activated on ${successCount} lock(s)`,
      type: "pin_activated",
      detail: `PIN ${pin.code} pushed to TTLock`,
    });

    // Partial failure → elevate to warn so it shows up in monitoring.
    // Drift reconciler will retry the missed locks on its next pass.
    const partial = successCount < locksToProgram.length;
    await this.storage.createLog({
      level: partial ? "warn" : "info",
      message: partial
        ? `PIN partially activated for ${guestName} on ${successCount}/${locksToProgram.length} lock(s) — drift reconciler will retry`
        : `PIN activated for ${guestName} on ${successCount}/${locksToProgram.length} lock(s)`,
      source: "pin-lifecycle",
      reservationId: reservation.id,
      roomId: room.id,
    });

    return true;
  }

  /**
   * Public wrapper around pushToTTLock for drift reconciliation.
   * Acquires the per-reservation lock and re-pushes the pin to all assigned
   * locks. Idempotent: TTLock duplicate-passcode errors (-3007) are treated
   * as success. Returns true if at least one lock was programmed.
   */
  async reconcilePinOnTTLock(pinId: string): Promise<{ success: boolean; error?: string }> {
    const pin = await this.storage.getPin(pinId);
    if (!pin) return { success: false, error: "Pin not found" };
    if (!pin.reservationId) return { success: false, error: "Pin has no reservationId" };
    const reservation = await this.storage.getReservation(pin.reservationId);
    if (!reservation) return { success: false, error: "Reservation not found" };

    return this.withReservationLock(reservation.id, async () => {
      const pushed = await this.pushToTTLock(pin, reservation);
      return pushed ? { success: true } : { success: false, error: "TTLock push returned false" };
    });
  }

  /**
   * Public wrapper around deleteFromTTLock for drift reconciliation / admin resync.
   * Safe to call on a pin that's already cancelled or delete_failed.
   */
  async reconcileDeletePin(pinId: string): Promise<{ success: boolean; error?: string }> {
    const pin = await this.storage.getPin(pinId);
    if (!pin) return { success: false, error: "Pin not found" };
    const reservationId = pin.reservationId || `orphan-${pin.id}`;
    return this.withReservationLock(reservationId, async () => {
      const ok = await this.deleteFromTTLock(pin);
      return ok ? { success: true } : { success: false, error: "deleteFromTTLock returned false" };
    });
  }

  /**
   * Delete PIN from TTLock and mark as cancelled in DB.
   * Pending PINs (never in TTLock) are cancelled directly — no API call.
   */
  private async deleteFromTTLock(pin: Pin): Promise<boolean> {
    // Pending = never pushed to TTLock
    if (pin.status === "pending") {
      await this.storage.updatePin(pin.id, { status: "cancelled" });
      return true;
    }

    if (!this.ttlockClient) {
      // No client — mark cancelled anyway
      await this.storage.updatePin(pin.id, { status: "cancelled" });
      return true;
    }

    const rawRoomLockKeyIds = pin.roomLockKeyIds as LockKeyEntry[] | null;
    const rawCommonAreaKeyIds = pin.commonAreaKeyIds as LockKeyEntry[] | null;
    const hasRoomLockKeyIds =
      Array.isArray(rawRoomLockKeyIds) && rawRoomLockKeyIds.length > 0;
    const hasCommonAreaKeyIds =
      Array.isArray(rawCommonAreaKeyIds) && rawCommonAreaKeyIds.length > 0;

    const failedRoomKeys: LockKeyEntry[] = [];
    const failedCommonKeys: LockKeyEntry[] = [];

    if (hasRoomLockKeyIds) {
      for (const entry of rawRoomLockKeyIds!) {
        if (!entry.ttlockId || !entry.keyId) continue;
        let keyId = entry.keyId;
        if (keyId === "existing") {
          try {
            const passcodes = await this.ttlockClient.listPasscodes(entry.ttlockId);
            const match = passcodes.find((p: any) => p.code === pin.code);
            if (match) {
              keyId = match.id.toString();
            } else if ((entry as any).confirmedUnlisted) {
              // -3007 phantom: the code IS on the hardware but the cloud list
              // can never show it, and TTLock has no delete-by-code API — the
              // code cannot be removed remotely and dies with its programmed
              // validity window at the stay's end. Surface that instead of the
              // misleading "nothing to delete".
              await this.storage.createLog({
                level: "warn",
                message: `Delete skipped on ${entry.lockName}: passcode ${pin.code} is a confirmed-unlisted (-3007) entry — not remotely deletable; it expires with its programmed validity window`,
                source: "pin-lifecycle",
                reservationId: pin.reservationId || undefined,
              });
              continue;
            } else {
              // Code is not on the lock at all — nothing to delete. Treating this
              // as unresolved used to block room changes forever ("keyId
              // unresolved — will retry" every hour with nothing to resolve).
              await this.storage.createLog({
                level: "info",
                message: `Delete skipped on ${entry.lockName}: passcode ${pin.code} not on lock — nothing to delete`,
                source: "pin-lifecycle",
                reservationId: pin.reservationId || undefined,
              });
              continue;
            }
          } catch {
            /* listing failed — fall through to retry */
          }
        }
        if (keyId === "existing") {
          // keyId still unresolved (listing failed) — cannot delete, schedule retry
          failedRoomKeys.push(entry);
          await this.storage.createLog({
            level: "warn",
            message: `Cannot delete from ${entry.lockName}: keyId unresolved — will retry`,
            source: "pin-lifecycle",
            reservationId: pin.reservationId || undefined,
          });
          continue;
        }
        try {
          await this.ttlockClient.deletePasscode(entry.ttlockId, parseInt(keyId));
        } catch (error) {
          failedRoomKeys.push(entry);
          await this.storage.createLog({
            level: "error",
            message: `Delete from TTLock failed on ${entry.lockName}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            source: "pin-lifecycle",
            reservationId: pin.reservationId || undefined,
          });
        }
      }
    }

    if (hasCommonAreaKeyIds) {
      for (const entry of rawCommonAreaKeyIds!) {
        if (!entry.ttlockId || !entry.keyId) continue;
        let keyId = entry.keyId;
        if (keyId === "existing") {
          try {
            const passcodes = await this.ttlockClient.listPasscodes(entry.ttlockId);
            const match = passcodes.find((p: any) => p.code === pin.code);
            if (match) {
              keyId = match.id.toString();
            } else if ((entry as any).confirmedUnlisted) {
              // -3007 phantom — not remotely deletable (see room-lock loop).
              await this.storage.createLog({
                level: "warn",
                message: `Delete skipped on ${entry.lockName}: passcode ${pin.code} is a confirmed-unlisted (-3007) entry — not remotely deletable; it expires with its programmed validity window`,
                source: "pin-lifecycle",
                reservationId: pin.reservationId || undefined,
              });
              continue;
            } else {
              // Code is not on the lock at all — nothing to delete (see room-lock loop).
              await this.storage.createLog({
                level: "info",
                message: `Delete skipped on ${entry.lockName}: passcode ${pin.code} not on lock — nothing to delete`,
                source: "pin-lifecycle",
                reservationId: pin.reservationId || undefined,
              });
              continue;
            }
          } catch {
            /* listing failed — fall through to retry */
          }
        }
        if (keyId === "existing") {
          // keyId still unresolved (listing failed) — cannot delete, schedule retry
          failedCommonKeys.push(entry);
          await this.storage.createLog({
            level: "warn",
            message: `Cannot delete from ${entry.lockName}: keyId unresolved — will retry`,
            source: "pin-lifecycle",
            reservationId: pin.reservationId || undefined,
          });
          continue;
        }
        try {
          await this.ttlockClient.deletePasscode(entry.ttlockId, parseInt(keyId));
        } catch (error) {
          failedCommonKeys.push(entry);
          await this.storage.createLog({
            level: "error",
            message: `Delete from common area lock failed on ${entry.lockName}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            source: "pin-lifecycle",
            reservationId: pin.reservationId || undefined,
          });
        }
      }
    }

    const anyFailed = failedRoomKeys.length > 0 || failedCommonKeys.length > 0;

    if (anyFailed) {
      // Partial failure: mark as delete_failed with only the remaining (failed) key IDs.
      // Retry scheduler will pick this up hourly. Security note: PIN still active on lock(s).
      await this.storage.updatePin(pin.id, {
        status: "delete_failed",
        roomLockKeyIds: failedRoomKeys,
        commonAreaKeyIds: failedCommonKeys,
      });
      return false;
    }

    await this.storage.updatePin(pin.id, { status: "cancelled" });

    if (pin.reservationId) {
      await this.storage.createReservationLog({
        reservationId: pin.reservationId,
        message: "PIN deleted from TTLock",
        type: "passcode_deleted",
        detail: `PIN ${pin.code} removed from locks`,
      });
    }

    return true;
  }

  /**
   * Add access code note to MEWS reservation.
   * Called from onReservationCreated and onRoomChanged (unmapped→mapped only).
   */
  private async syncToMews(reservation: Reservation, code: string): Promise<void> {
    if (!this.mewsClient || !reservation.pmsId) return;
    // Defense in depth against note spam (22/7: dozens of "Access code:" notes
    // on one reservation): the code is permanent, so once a note has been
    // synced there is NEVER a reason to post another. Re-read the flag fresh —
    // callers may hold a stale object.
    const freshForNote = await this.storage.getReservation(reservation.id);
    if (freshForNote?.mewsPinSyncedAt) return;
    try {
      await this.mewsClient.addReservationNote(reservation.pmsId, `Access code: ${code}`);
      await this.storage.updateReservation(reservation.id, { mewsPinSyncedAt: new Date() });
      await this.storage.createLog({
        level: "info",
        message: `PIN synced to MEWS`,
        source: "pin-lifecycle",
        reservationId: reservation.id,
      });
    } catch (error) {
      await this.storage.createLog({
        level: "warn",
        message: `Failed to sync PIN to MEWS: ${
          error instanceof Error ? error.message : String(error)
        }`,
        source: "pin-lifecycle",
        reservationId: reservation.id,
      });
    }
  }

  // ── Public event handlers ──────────────────────────────────────────────────

  /**
   * Retroactive MEWS sync: if the reservation already has a generatedPin but
   * was never successfully synced to MEWS (legacy rows, partial failure, stale
   * writer), post the access-code note once and stamp mewsPinSyncedAt.
   * Does NOT touch TTLock or create new pin rows — safe to call on every poll.
   */
  async ensureMewsSynced(reservation: Reservation): Promise<void> {
    if (!reservation.generatedPin) return;
    if (reservation.mewsPinSyncedAt) return;
    if (!reservation.pmsId) return;
    await this.syncToMews(reservation, reservation.generatedPin);
  }

  /**
   * New reservation arrived in a mapped room.
   * Creates a pending PIN in DB and syncs access code to MEWS (once only).
   */
  async onReservationCreated(
    reservation: Reservation,
    opts?: { deferActivation?: boolean }
  ): Promise<void> {
    // Serialized per reservation: creation is a check-then-act (hasLivePin →
    // createPendingPin → immediate push) that concurrent callers (fastPoll vs
    // fullSync vs webhook) would otherwise interleave — worst case generating
    // TWO different codes on the "gained lock mapping" path.
    return this.withReservationLock(reservation.id, () =>
      this._onReservationCreated(reservation, opts)
    );
  }

  private async _onReservationCreated(
    reservation: Reservation,
    opts?: { deferActivation?: boolean }
  ): Promise<void> {
    // Re-read from DB to avoid creating PINs for reservations that were
    // cancelled/checked-out between the caller's read and this call.
    const current = await this.storage.getReservation(reservation.id);
    if (!current) return;
    const status = (current.status || "").toLowerCase();
    if (status === "cancelled" || status === "checked-out") return;
    if (!current.roomId) return;

    if (!(await this.isRoomMapped(current.roomId))) {
      await this.storage.createLog({
        level: "info",
        message: "New reservation in unmapped room — skipping PIN creation",
        source: "pin-lifecycle",
        reservationId: current.id,
      });
      return;
    }

    // Idempotency: skip PIN creation if PIN already exists for this reservation,
    // but still attempt MEWS sync if it was never successfully synced before.
    // Note: delete_failed PINs only block creation on the SAME room — a delete_failed
    // from an old room (e.g. after room change) must NOT prevent new PIN creation
    // on the current room.
    const existing = await this.storage.getPinsByReservationId(current.id);
    const hasLivePin = existing.some((p) =>
      ["pending", "active", "used"].includes(p.status) ||
      (p.status === "delete_failed" && p.roomId === current.roomId)
    );

    if (hasLivePin) {
      // PIN exists but MEWS may have never been synced (e.g. sync failed, legacy
      // pre-milestone code, manual recovery). Retroactively sync once.
      const fresh = (await this.storage.getReservation(current.id)) ?? current;
      if (fresh.generatedPin && !fresh.mewsPinSyncedAt) {
        await this.syncToMews(fresh, fresh.generatedPin);
      }
      return;
    }

    await this.createPendingPin(current);

    // Reload to get generatedPin written by createPendingPin
    const fresh = (await this.storage.getReservation(current.id)) ?? current;
    if (fresh.generatedPin) {
      await this.syncToMews(fresh, fresh.generatedPin);
    }

    // Same-day/overdue booking: the guest's activation window is already open,
    // so the code must reach the locks NOW — waiting for the next poller tick
    // is not safe (20/7: a 23:37 booking got its SMS within seconds while the
    // boot full sync held the poller, so the locks were only programmed 10
    // minutes later with the guests standing at the door). physical_required
    // mode keeps its own MEWS-check-in trigger (ingestion); pushToTTLock
    // re-verifies all access invariants including the activation window.
    // deferActivation lets bulk callers (admin backfill loop) leave the pushes
    // to the scheduler instead of serializing lock writes inside one HTTP request.
    if (!opts?.deferActivation && this.ttlockClient && (await this._isGuestCurrentlyActive(fresh))) {
      const checkInMethod = (await this.storage.getSetting("check_in_method"))?.value;
      if (checkInMethod !== "physical_required" && fresh.roomId) {
        const lockAssignments = await this.storage.getRoomLockAssignments(fresh.roomId);
        const hasRoomLock = lockAssignments.some((a) => a.lockDevice.lockType === "room");
        if (hasRoomLock) {
          // Impl directly — this method already holds the reservation lock;
          // the public wrapper would deadlock on the same key.
          await this._activatePendingForReservationImpl(fresh.id);
        }
      }
    }
  }

  /**
   * Arrival date changed on an existing reservation.
   *
   * If PIN is already in TTLock (active/used): delete → recreate as pending with new window
   * → push to TTLock immediately if guest is currently active (checked-in / arrival today/past).
   * If PIN is still pending: update validity window in DB only — no TTLock calls.
   */
  async onArrivalDateChanged(reservation: Reservation, previousArrival?: Date): Promise<void> {
    return this.withReservationLock(reservation.id, () => this._onArrivalDateChanged(reservation, previousArrival));
  }

  private async _onArrivalDateChanged(reservation: Reservation, previousArrival?: Date): Promise<void> {
    if (!reservation.roomId) return;

    // A purchased early check-in belongs to the ORIGINAL arrival day — after a
    // date move it must not survive (the widened 72h fold band can no longer
    // filter 1-2 day moves by itself). Clear it before recomputing windows.
    // SAME-DAY time adjustments must NOT clear (Hilger 24/7: the MEWS
    // check-in moved StartUtc to the actual arrival minute, and the purchase
    // she'd made two hours earlier was wiped — the guard is for date MOVES,
    // not for arriving).
    if (reservation.earlyCheckinFrom) {
      const tz = (await this.storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
      const dayOf = (d: Date) => DateTime.fromJSDate(d, { zone: "utc" }).setZone(tz).toISODate();
      const dateMoved = !previousArrival || dayOf(previousArrival) !== dayOf(new Date(reservation.arrival));
      if (dateMoved) {
        await this.storage.updateReservation(reservation.id, { earlyCheckinFrom: null });
        reservation = { ...reservation, earlyCheckinFrom: null };
        await this.storage.createLog({
          level: "info",
          message: `Arrival date changed — purchased early check-in cleared (was ${new Date(reservation.arrival).toISOString().slice(0, 10)}-bound)`,
          source: "pin-lifecycle",
          reservationId: reservation.id,
        });
      }
    }

    const pins = await this.storage.getPinsByReservationId(reservation.id);
    const livePin = pins.find((p) => p.status === "active" || p.status === "used");
    const deleteFailedPin = pins.find((p) => p.status === "delete_failed");

    if (deleteFailedPin) {
      await this.storage.createLog({
        level: "warn",
        message: `Arrival date change skipped — PIN has delete_failed status, retry deletion first`,
        source: "pin-lifecycle",
        reservationId: reservation.id,
      });
      return;
    }

    if (livePin) {
      const deleted = await this.deleteFromTTLock(livePin);
      if (!deleted) {
        await this.storage.createLog({
          level: "error",
          message: `Arrival date change: failed to delete active PIN from TTLock — not creating new pending PIN`,
          source: "pin-lifecycle",
          reservationId: reservation.id,
        });
        return;
      }

      // Only recreate if all access invariants still hold. If owing > 0 or the
      // reservation is cancelled we deliberately leave the guest without a PIN.
      if (!(await this._shouldHavePin(reservation))) {
        await this.storage.createLog({
          level: "info",
          message: "Arrival date changed — old PIN deleted, skipping recreate (access invariants not satisfied)",
          source: "pin-lifecycle",
          reservationId: reservation.id,
          metadata: { status: reservation.status, owing: reservation.owing },
        });
        return;
      }

      await this.createPendingPin(reservation);

      // The old PIN was active/used — the guest HAD access. Always re-push
      // the new pending PIN to restore access immediately. This avoids a race
      // condition where concurrent MEWS events (arrival date change + check-in)
      // leave the guest without working PIN codes.
      const freshRes = (await this.storage.getReservation(reservation.id)) ?? reservation;
      await this._activatePendingForReservation(freshRes);

      await this.storage.createLog({
        level: "info",
        message: `Arrival date changed — old PIN deleted, new PIN pushed to TTLock (guest had active access)`,
        source: "pin-lifecycle",
        reservationId: reservation.id,
      });
    } else {
      const pendingPin = pins.find((p) => p.status === "pending");
      if (pendingPin) {
        const window = await this.buildValidityWindow(reservation);
        await this.storage.updatePin(pendingPin.id, {
          validFrom: window.validFrom,
          validTo: window.validTo,
        });
        await this.storage.createLog({
          level: "info",
          message: `Arrival date changed — pending PIN validity updated in DB`,
          source: "pin-lifecycle",
          reservationId: reservation.id,
        });
      }
    }
  }

  /**
   * True iff the reservation's activation window has opened and the validity
   * window has not yet expired. The activation window opens 1 hour before the
   * configured check_in_time on the arrival day (or immediately for arrivals
   * in the past).
   *
   * Does NOT consider MEWS status — a reservation manually checked in early
   * still has to wait for the window to open before its PIN hits any lock.
   */
  private async _isWithinActivationWindow(reservation: Reservation): Promise<boolean> {
    // If the guest is already checked in (reception or self-service), bypass
    // the scheduled activation window entirely — they need the PIN *now*.
    if ((reservation.status || "").toLowerCase() === "checked-in") return true;

    try {
      const window = await this.buildValidityWindow(reservation);
      const now = Date.now();
      const activationOpens = window.validFrom.getTime() - 60 * 60 * 1000;
      if (now < activationOpens) return false;
      if (now >= window.validTo.getTime()) return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Shared helper: determine if a guest's PIN should be active right now.
   * True if: checked-in, arrival is past, or arrival is today and past activation window (1h before check-in).
   */
  private async _isGuestCurrentlyActive(reservation: Reservation): Promise<boolean> {
    // Derive from the shared validity window (single source of truth) so an
    // early check-in (earlyCheckinFrom) counts as active immediately — e.g. a
    // room move right after a paid early check-in must push the new room's PIN
    // now, not at the normal activation time.
    const { validFrom } = await this.buildValidityWindow(reservation);
    const isCheckedIn = (reservation.status || "").toLowerCase() === "checked-in";
    const activationOpens = validFrom.getTime() - 60 * 60 * 1000; // 1h before, matching _isWithinActivationWindow
    return isCheckedIn || Date.now() >= activationOpens;
  }

  /**
   * Departure date changed on an existing reservation.
   * Updates valid_to in DB and in TTLock for live PINs.
   */
  async onDepartureDateChanged(reservation: Reservation): Promise<void> {
    if (!reservation.roomId) return;

    const pins = await this.storage.getPinsByReservationId(reservation.id);
    const relevantPin = pins.find((p) =>
      ["active", "used", "pending"].includes(p.status)
    );
    if (!relevantPin) return;

    const window = await this.buildValidityWindow(reservation);

    // Update DB
    await this.storage.updatePin(relevantPin.id, { validTo: window.validTo });

    // Also update TTLock if PIN is live
    if (
      (relevantPin.status === "active" || relevantPin.status === "used") &&
      this.ttlockClient
    ) {
      const allKeyIds: LockKeyEntry[] = [
        ...((relevantPin.roomLockKeyIds as LockKeyEntry[]) || []),
        ...((relevantPin.commonAreaKeyIds as LockKeyEntry[]) || []),
      ];

      for (const entry of allKeyIds) {
        if (!entry.ttlockId || !entry.keyId) continue;
        let keyId = entry.keyId;
        if (keyId === "existing") {
          try {
            const passcodes = await this.ttlockClient.listPasscodes(entry.ttlockId);
            const match = passcodes.find((p: any) => p.code === relevantPin.code);
            if (match) keyId = match.id.toString();
          } catch {
            /* fall through */
          }
        }
        if (keyId === "existing") continue; // still unresolved — skip
        try {
          await this.ttlockClient.updatePasscode(
            entry.ttlockId,
            parseInt(keyId),
            relevantPin.code,
            new Date(relevantPin.validFrom),
            window.validTo
          );
        } catch (error) {
          await this.storage.createLog({
            level: "warn",
            message: `Failed to update TTLock validity on ${entry.lockName}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            source: "pin-lifecycle",
            reservationId: reservation.id,
          });
        }
      }
    }

    await this.storage.createLog({
      level: "info",
      message: `Departure date changed — PIN validity updated`,
      source: "pin-lifecycle",
      reservationId: reservation.id,
    });
  }

  /**
   * Room assignment changed in PMS.
   *
   * reservation.roomId must already be set to newRoomId (or null if new room is not in local DB).
   *
   * 1. Delete/cancel old PIN from TTLock
   * 2. If new room is null or unmapped → done (log info)
   * 3. Create pending PIN for new room
   * 4. If guest is checked-in or arrival is today/past → push to TTLock immediately
   */
  async onRoomChanged(
    reservation: Reservation,
    oldRoomId: string,
    newRoomId: string | null
  ): Promise<void> {
    return this.withReservationLock(reservation.id, () => this._onRoomChanged(reservation, oldRoomId, newRoomId));
  }

  private async _onRoomChanged(
    reservation: Reservation,
    oldRoomId: string,
    newRoomId: string | null
  ): Promise<void> {
    // A purchased early check-in is bound to the ORIGINAL capsule+day. Room
    // moves (incl. combined room+date changes, where ingestion skips the date
    // handlers entirely) must clear it — otherwise a stale value inside the
    // 72h fold band would activate the NEW capsule's code days early without
    // any occupancy check.
    if (reservation.earlyCheckinFrom) {
      await this.storage.updateReservation(reservation.id, { earlyCheckinFrom: null });
      reservation = { ...reservation, earlyCheckinFrom: null };
      await this.storage.createLog({
        level: "info",
        message: `Room change — purchased early check-in cleared (bound to the previous capsule)`,
        source: "pin-lifecycle",
        reservationId: reservation.id,
      });
    }

    // 1. Handle existing PIN (search by reservationId across all rooms)
    const pinsForReservation = await this.storage.getPinsByReservationId(reservation.id);
    const oldPin = pinsForReservation.find((p) =>
      ["active", "used", "pending"].includes(p.status)
    );

    await this.storage.createLog({
      level: "info",
      message: `onRoomChanged: found ${pinsForReservation.length} pin(s) total, oldPin status=${oldPin?.status ?? "none"} (oldRoomId=${oldRoomId} → newRoomId=${newRoomId ?? "null"})`,
      source: "pin-lifecycle",
      reservationId: reservation.id,
    });

    if (oldPin) {
      if (oldPin.status === "active" || oldPin.status === "used") {
        const deleted = await this.deleteFromTTLock(oldPin);
        if (!deleted) {
          // Old code couldn't be removed everywhere (lock busy/offline). Aborting
          // here used to leave the guest with NO code on the new room until a
          // manual re-move — the guest's access matters more than the cleanup.
          // The code value is unchanged, so we proceed: create+push the new PIN
          // and let the hourly delete-retry clean the old room lock separately.
          const canProceed = !!newRoomId && (await this.isRoomMapped(newRoomId));
          if (!canProceed) {
            await this.storage.createLog({
              level: "error",
              message: `Room change aborted: failed to delete old PIN from TTLock — will retry`,
              source: "pin-lifecycle",
              reservationId: reservation.id,
              metadata: { oldRoomId, newRoomId },
            });
            return;
          }

          // Locks SHARED with the new room (common doors) keep their physical key
          // (same code) — transfer ownership to the new PIN by dropping them from
          // the old PIN's retry list. Otherwise the hourly retry would later
          // delete a key the new PIN relies on (that exact trap hit 2026-07-19:
          // a guest's code vanished from Main entrance while the DB said synced).
          const newAssignments = await this.storage.getRoomLockAssignments(newRoomId!);
          const newLockTtlockIds = new Set(
            newAssignments.map((a) => a.lockDevice?.ttlockId).filter((id): id is string => !!id)
          );
          const failedPin = (await this.storage.getPinsByReservationId(reservation.id)).find(
            (p) => p.id === oldPin.id
          );
          if (failedPin) {
            const remainingRoom = ((failedPin.roomLockKeyIds as LockKeyEntry[] | null) ?? []).filter(
              (e) => !newLockTtlockIds.has(e.ttlockId)
            );
            const remainingCommon = ((failedPin.commonAreaKeyIds as LockKeyEntry[] | null) ?? []).filter(
              (e) => !newLockTtlockIds.has(e.ttlockId)
            );
            await this.storage.updatePin(failedPin.id, {
              roomLockKeyIds: remainingRoom,
              commonAreaKeyIds: remainingCommon,
              status: remainingRoom.length + remainingCommon.length > 0 ? "delete_failed" : "cancelled",
            });
          }
          await this.storage.createLog({
            level: "warn",
            message: `Room change continuing despite failed old-PIN delete — new PIN is created now; old lock cleanup retries hourly`,
            source: "pin-lifecycle",
            reservationId: reservation.id,
            metadata: { oldRoomId, newRoomId },
          });
        }
      } else {
        // Pending — never in TTLock, just cancel in DB
        await this.storage.updatePin(oldPin.id, { status: "cancelled" });
      }
    }

    // 2. If new room is not in DB or not mapped → done
    if (!newRoomId || !(await this.isRoomMapped(newRoomId))) {
      await this.storage.createLog({
        level: "info",
        message: newRoomId
          ? `Room change to unmapped room — no PIN created for new room`
          : `Room change to room not in local DB — PIN deleted, no new PIN created`,
        source: "pin-lifecycle",
        reservationId: reservation.id,
        metadata: { oldRoomId, newRoomId },
      });
      return;
    }

    // 3. Create pending PIN for new room.
    // Ensure reservation.roomId == newRoomId (caller may have passed stale object)
    const reservationForNewRoom = { ...reservation, roomId: newRoomId };

    // Guard: only create a new PIN if all access invariants hold on the new room.
    if (!(await this._shouldHavePin(reservationForNewRoom))) {
      await this.storage.createLog({
        level: "info",
        message: "Room change — old PIN deleted, skipping recreate (access invariants not satisfied)",
        source: "pin-lifecycle",
        reservationId: reservation.id,
        metadata: {
          oldRoomId,
          newRoomId,
          status: reservation.status,
          owing: reservation.owing,
        },
      });
      return;
    }

    await this.createPendingPin(reservationForNewRoom);

    // 3b. Sync PIN to MEWS if this is a new PIN (unmapped→mapped transition).
    // If oldPin existed, MEWS already has the code from onReservationCreated.
    if (!oldPin) {
      const fresh = (await this.storage.getReservation(reservation.id)) ?? reservationForNewRoom;
      if (fresh.generatedPin) {
        await this.syncToMews(fresh, fresh.generatedPin);
      }
    }

    // 4. Push immediately if guest is currently active.
    const isActive = await this._isGuestCurrentlyActive(reservation);

    if (isActive) {
      await this._activatePendingForReservation(reservation);
    }

    await this.storage.createLog({
      level: "info",
      message: `Room change — PIN ${isActive ? "activated" : "pending (scheduler will activate)"} for new room ${newRoomId}`,
      source: "pin-lifecycle",
      reservationId: reservation.id,
      metadata: { oldRoomId, newRoomId },
    });
  }

  /**
   * Reservation cancelled or checked out.
   * Removes PIN from TTLock. Does NOT clear generatedPin — the code stays on the
   * boarding card as the guest's permanent reference code.
   *
   * Returns true when revocation ran, false when the in-house guard refused it.
   *
   * IN-HOUSE GUARD (Martinsen 16-17/7, natten 22/7): a cancellation must never
   * silently pull the codes of a guest who is demonstrably INSIDE their stay —
   * MEWS' ~06:00 no-show audit cancels un-checked-in reservations, and a guest
   * whose MEWS check-in was rejected (occupied space) sleeps through that as
   * "Confirmed". Codes used + window still open + not checked out in MEWS →
   * keep the codes, alert the operator, let a human decide. Normal checkouts
   * (status Checked-out/Processed) and expired stays are untouched by the
   * guard. `force` (explicit admin actions) bypasses it.
   */
  async onCancelled(reservation: Reservation, opts?: { force?: boolean }): Promise<boolean> {
    return this.withReservationLock(reservation.id, () => this._onCancelled(reservation, opts));
  }

  private async _onCancelled(reservation: Reservation, opts?: { force?: boolean }): Promise<boolean> {
    const pins = await this.storage.getPinsByReservationId(reservation.id);

    const actionable = pins.filter(
      (p) =>
        p.status === "active" ||
        p.status === "used" ||
        p.status === "pending" ||
        p.status === "delete_failed"
    );

    if (actionable.length === 0) {
      return true;
    }

    const resStatus = (reservation.status || "").toLowerCase();
    const isCheckedOut = resStatus === "checked-out" || resStatus === "processed";
    const guestInside = actionable.some(
      (p) => p.firstUsedAt && p.validTo && new Date(p.validTo).getTime() > Date.now()
    );
    if (!opts?.force && !isCheckedOut && guestInside) {
      await this.storage.createLog({
        level: "error",
        message: `Cancellation revoke BLOCKED: guest has used their code and the stay window is still open — codes kept on the locks. Re-confirm the reservation in MEWS if the cancellation was wrong, or remove the code manually if the guest must be locked out.`,
        source: "pin-lifecycle",
        reservationId: reservation.id,
      });
      await sendOpsAlert(
        this.storage,
        `cancel-inhouse:${reservation.id}`,
        "critical",
        `Annullering af gæst der er INDE — koder IKKE fjernet (${reservation.firstName ?? ""} ${reservation.lastName ?? ""})`.trim(),
        `Reservationen blev annulleret (fx MEWS' natlige no-show-kørsel), men gæstens kode er brugt og opholdsvinduet er stadig åbent. Koderne er bevidst IKKE fjernet, så gæsten ikke låses ude. Gør ét af to i MEWS: genbekræft/tjek gæsten ind, eller fjern koden manuelt hvis gæsten reelt skal ud.`
      );
      return false;
    }

    let allDeleted = true;
    for (const pin of actionable) {
      if (pin.status === "active" || pin.status === "used" || pin.status === "delete_failed") {
        const ok = await this.deleteFromTTLock(pin);
        if (!ok) allDeleted = false;
      } else if (pin.status === "pending") {
        await this.storage.updatePin(pin.id, { status: "cancelled" });
      }
    }

    if (allDeleted) {
      await this.storage.createLog({
        level: "info",
        message: `Reservation cancelled/checked-out — PIN removed from TTLock`,
        source: "pin-lifecycle",
        reservationId: reservation.id,
      });
    }
    return true;
  }

  /**
   * Outstanding balance appeared on the reservation.
   * Deletes PIN from TTLock but keeps generatedPin on the reservation — guest will regain
   * access once payment is cleared. Mirrors onCancelled without the notification.
   */
  async onPaymentRequired(reservation: Reservation): Promise<void> {
    return this.withReservationLock(reservation.id, () => this._onPaymentRequired(reservation));
  }

  private async _onPaymentRequired(reservation: Reservation): Promise<void> {
    const pins = await this.storage.getPinsByReservationId(reservation.id);
    const actionable = pins.filter(
      (p) =>
        p.status === "active" ||
        p.status === "used" ||
        p.status === "pending" ||
        p.status === "delete_failed"
    );

    if (actionable.length === 0) return;

    let allDeleted = true;
    for (const pin of actionable) {
      if (pin.status === "active" || pin.status === "used" || pin.status === "delete_failed") {
        const ok = await this.deleteFromTTLock(pin);
        if (!ok) allDeleted = false;
      } else if (pin.status === "pending") {
        await this.storage.updatePin(pin.id, { status: "cancelled" });
      }
    }

    await this.storage.createLog({
      level: allDeleted ? "info" : "warn",
      message: allDeleted
        ? `Payment required — PIN removed from TTLock (generatedPin preserved)`
        : `Payment required — partial PIN deletion from TTLock`,
      source: "pin-lifecycle",
      reservationId: reservation.id,
    });
  }

  /**
   * Outstanding balance cleared — recreate pending PIN and push to TTLock if guest is
   * currently active. Does NOT sync to MEWS (access code was already shared at booking).
   */
  async onPaymentCleared(reservation: Reservation): Promise<void> {
    return this.withReservationLock(reservation.id, () => this._onPaymentCleared(reservation));
  }

  private async _onPaymentCleared(reservation: Reservation): Promise<void> {
    // Full invariant check — don't resurrect PINs on cancelled / past / unmapped
    // reservations just because a balance was cleared.
    if (!(await this._shouldHavePin(reservation))) {
      await this.storage.createLog({
        level: "info",
        message: "Payment cleared — PIN recreation skipped (access invariants not satisfied)",
        source: "pin-lifecycle",
        reservationId: reservation.id,
        metadata: { status: reservation.status, owing: reservation.owing },
      });
      return;
    }

    // Idempotency: skip if an actionable PIN already exists
    const existing = await this.storage.getPinsByReservationId(reservation.id);
    if (existing.some((p) => ["pending", "active", "used"].includes(p.status))) {
      return;
    }

    await this.createPendingPin(reservation);

    // Push immediately if guest is currently active
    const shouldPush = await this._isGuestCurrentlyActive(reservation);
    if (shouldPush) {
      await this._activatePendingForReservation(reservation);
    }

    await this.storage.createLog({
      level: "info",
      message: `Payment cleared — PIN ${shouldPush ? "pushed to TTLock" : "recreated (pending)"}`,
      source: "pin-lifecycle",
      reservationId: reservation.id,
    });
  }

  /**
   * Scheduler job: push all pending PINs for today's arrivals to TTLock.
   * Called ~1 hour before check-in time by mews-poller.
   * No MEWS sync here — already done at creation.
   */
  async activateForToday(): Promise<{
    activated: number;
    failed: number;
    skipped: number;
  }> {
    const results = { activated: 0, failed: 0, skipped: 0 };

    // Single-flight: the sweep is invoked from several places (mews-poller
    // fast poll, manual admin trigger) and a slow TTLock day makes one sweep
    // outlive the next tick. Concurrent sweeps re-push the same pending pins
    // against each other — skip instead.
    if (this.activateSweepInFlight) {
      await this.storage.createLog({
        level: "info",
        message: "PIN activation: Skipped — previous sweep still in flight",
        source: "pin-lifecycle",
      });
      return results;
    }
    this.activateSweepInFlight = true;
    try {
      return await this._activateForTodayImpl(results);
    } finally {
      this.activateSweepInFlight = false;
    }
  }

  private async _activateForTodayImpl(results: {
    activated: number;
    failed: number;
    skipped: number;
  }): Promise<{ activated: number; failed: number; skipped: number }> {
    // Respect check_in_method setting
    const checkInMethodSetting = await this.storage.getSetting("check_in_method");
    if (checkInMethodSetting?.value === "physical_required") {
      await this.storage.createLog({
        level: "info",
        message:
          "PIN activation: Skipped — check_in_method is physical_required",
        source: "pin-lifecycle",
      });
      return results;
    }

    const pendingPins = await this.storage.getPendingPinsForTodayArrivals();

    if (pendingPins.length === 0) {
      await this.storage.createLog({
        level: "info",
        message: "PIN activation: No pending PINs for today's arrivals",
        source: "pin-lifecycle",
      });
      return results;
    }

    if (!this.ttlockClient) {
      await this.storage.createLog({
        level: "error",
        message: "PIN activation: TTLock client not initialized",
        source: "pin-lifecycle",
      });
      results.failed = pendingPins.length;
      return results;
    }

    const timezoneSetting = await this.storage.getSetting("property_timezone");
    const timezone = timezoneSetting?.value || "Europe/Copenhagen";
    const checkInTimeSetting = await this.storage.getSetting("check_in_time");
    const checkInTime = checkInTimeSetting?.value || "15:00";
    const [chHour, chMin] = checkInTime.split(":").map(Number);

    const nowInZone = DateTime.now().setZone(timezone);
    const todayStart = nowInZone.startOf("day").toJSDate();
    const tomorrowStart = nowInZone.plus({ days: 1 }).startOf("day").toJSDate();
    // Activation window: 1 hour before check-in time (Luxon handles midnight rollover)
    const activationWindowTime = nowInZone
      .set({ hour: chHour, minute: chMin, second: 0, millisecond: 0 })
      .minus({ hours: 1 });
    const isPastActivationWindow = nowInZone >= activationWindowTime;

    await this.storage.createLog({
      level: "info",
      message: `PIN activation: Processing ${pendingPins.length} pending PIN(s) for today`,
      source: "pin-lifecycle",
    });

    for (const pinWithReservation of pendingPins) {
      const { reservation, ...pin } = pinWithReservation;

      try {
        const arrival = new Date(reservation.arrival);
        const isOverdue = arrival < todayStart; // arrived before today (always activate)

        // Guard: skip future arrivals
        if (arrival >= tomorrowStart) {
          results.skipped++;
          await this.storage.createLog({
            level: "info",
            message: `PIN activation: Skipping — arrival (${arrival.toISOString()}) is in the future`,
            source: "pin-lifecycle",
            reservationId: reservation.id,
          });
          continue;
        }

        // Guard: for today's arrivals, respect the activation window (1h before check-in)
        // Overdue arrivals (yesterday or earlier) are always activated immediately
        if (!isOverdue && !isPastActivationWindow) {
          results.skipped++;
          await this.storage.createLog({
            level: "info",
            message: `PIN activation: Skipping — activation window not yet reached (window opens ${activationWindowTime.toISO()})`,
            source: "pin-lifecycle",
            reservationId: reservation.id,
          });
          continue;
        }

        if (!reservation.roomId) {
          results.skipped++;
          continue;
        }

        // Require at least one room-type lock (common-area-only is not sufficient)
        const lockAssignments = await this.storage.getRoomLockAssignments(reservation.roomId);
        const hasRoomLock = lockAssignments.some(a => a.lockDevice.lockType === "room");
        if (!hasRoomLock) {
          results.skipped++;
          await this.storage.createLog({
            level: "info",
            message: `PIN activation: Skipping — room has no room-type lock configured`,
            source: "pin-lifecycle",
            reservationId: reservation.id,
            roomId: reservation.roomId,
          });
          continue;
        }

        // Push under the per-reservation mutex so the sweep can't collide with
        // the other activation paths (MEWS check-in, door-code send, room
        // change) that already hold it. Status re-check happens INSIDE the
        // lock: another path may have activated this pin while we waited.
        const success = await this.withReservationLock(reservation.id, async () => {
          const freshPin = await this.storage.getPin(pin.id);
          if (!freshPin || freshPin.status !== "pending") return null;
          return this.pushToTTLock(freshPin, reservation);
        });
        if (success === null) {
          results.skipped++;
        } else if (success) {
          results.activated++;
        } else {
          results.failed++;
        }
      } catch (error) {
        await this.storage.createLog({
          level: "error",
          message: `PIN activation error: ${
            error instanceof Error ? error.message : String(error)
          }`,
          source: "pin-lifecycle",
          reservationId: reservation.id,
        });
        results.failed++;
      }
    }

    await this.storage.createLog({
      level: "info",
      message: `PIN activation complete: ${results.activated} activated, ${results.failed} failed, ${results.skipped} skipped`,
      source: "pin-lifecycle",
    });

    return results;
  }

  /**
   * Retry scheduler: attempt to delete all pins that previously failed.
   * Called by the PIN repair job (every 5 min by default). Sets status to
   * "cancelled" on success. First MAX_DELETE_RETRIES attempts run at the job
   * cadence; after that the pin moves to a 30-min retry lane with a critical
   * ops-alert — it is never abandoned while the code sits on a lock.
   */
  async retryFailedDeletions(): Promise<{ retried: number; fixed: number; stillFailed: number; backedOff: number }> {
    const results = { retried: 0, fixed: 0, stillFailed: 0, backedOff: 0 };
    const failedPins = await this.storage.getPinsWithDeleteFailed();
    for (const pin of failedPins) {
      const retryCount = (this.deleteRetryCounters.get(pin.id) || 0) + 1;
      this.deleteRetryCounters.set(pin.id, retryCount);

      if (retryCount > PinLifecycleService.MAX_DELETE_RETRIES) {
        // Slow lane: the lock/gateway has resisted 5 quick attempts. Never
        // give up (the code physically grants access until deleted) — retry
        // every 30 min and alert the operator once.
        const until = this.deleteRetryBackoffUntil.get(pin.id) || 0;
        if (Date.now() < until) {
          results.backedOff++;
          continue;
        }
        this.deleteRetryBackoffUntil.set(pin.id, Date.now() + PinLifecycleService.DELETE_RETRY_BACKOFF_MS);
        if (retryCount === PinLifecycleService.MAX_DELETE_RETRIES + 1) {
          await this.storage.createLog({
            level: "error",
            message: `Delete retry for pin ${pin.id} still failing after ${PinLifecycleService.MAX_DELETE_RETRIES} attempts — code ${pin.code} is STILL on lock(s); switching to 30-min retries until it succeeds`,
            source: "pin-lifecycle",
            reservationId: pin.reservationId || undefined,
          });
          await sendOpsAlert(
            this.storage,
            `delete-retry-stuck:${pin.id}`,
            "critical",
            `Kode ${pin.code} kan ikke fjernes fra lås(e) — sidder der stadig`,
            `Koden skulle slettes (flytning/annullering/udløb), men låsen/gatewayen har afvist ${PinLifecycleService.MAX_DELETE_RETRIES} forsøg. Systemet bliver ved hvert 30. minut. Tjek gateway/lås — indtil da virker koden fysisk på den gamle dør.`
          );
        }
      }

      results.retried++;
      const ok = await this.deleteFromTTLock(pin);
      if (ok) {
        results.fixed++;
        this.deleteRetryCounters.delete(pin.id);
        this.deleteRetryBackoffUntil.delete(pin.id);
      } else {
        results.stillFailed++;
      }
    }
    if (results.retried > 0) {
      await this.storage.createLog({
        level: results.stillFailed > 0 ? "warn" : "info",
        message: `Delete retry: ${results.fixed} fixed, ${results.stillFailed} still failed, ${results.backedOff} backed off (30-min lane)`,
        source: "pin-lifecycle",
      });
    }
    return results;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Push the pending PIN for a specific reservation to TTLock immediately.
   * Used after room change when guest is already active, and by immediatelyActivatePendingPin.
   * Returns { success, alreadyActive, error }.
   */
  async activatePendingForReservation(
    reservationId: string
  ): Promise<{ success: boolean; alreadyActive?: boolean; error?: string }> {
    return this.withReservationLock(reservationId, () => this._activatePendingForReservationImpl(reservationId));
  }

  private async _activatePendingForReservationImpl(
    reservationId: string
  ): Promise<{ success: boolean; alreadyActive?: boolean; error?: string }> {
    const reservation = await this.storage.getReservation(reservationId);
    if (!reservation) return { success: false, error: "Reservation not found" };
    if (!reservation.roomId) return { success: false, error: "No room for reservation" };

    const pins = await this.storage.getPinsByReservationId(reservationId);
    const activePin = pins.find((p) => p.status === "active" || p.status === "used");
    if (activePin) return { success: true, alreadyActive: true };

    const pendingPin = pins.find((p) => p.status === "pending");
    if (!pendingPin) return { success: false, error: "No pending PIN found" };

    const pushed = await this.pushToTTLock(pendingPin, reservation);
    return pushed ? { success: true } : { success: false, error: "TTLock push failed" };
  }

  private async _activatePendingForReservation(
    reservation: Reservation
  ): Promise<void> {
    // Call impl directly — caller (_onRoomChanged) already holds the reservation lock
    await this._activatePendingForReservationImpl(reservation.id);
  }
}
