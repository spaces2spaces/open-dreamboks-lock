import { IStorage } from "./storage";
import { TTLockClient, createOwnerClient, isLockOfflineError } from "./ttlock-client";
import { NotificationClient, createNotificationClient } from "./notification-client";
import { MewsClient } from "./mews-client";
import { PinLifecycleService } from "./pin-lifecycle-service";
import { buildValidityWindow } from "./pin-validity-window";
import { sendOpsAlert } from "./ops-alert";
import type { Reservation, Room, CommonArea, LockDevice, Pin } from "@shared/schema";
import { getSpaceDisplayName } from "@shared/display-name";
import { DateTime } from "luxon";

interface RoomLockKeyId {
  lockDeviceId: string;
  ttlockId: string;
  keyId: string;
  lockName: string;
  /** Repair verify attempts for an unresolved "existing" sentinel (TTLock said -3007 but the cloud list can't show the code). */
  verifyAttempts?: number;
  /** TTLock's cloud list never showed the code, but the lock insists it exists (-3007 on every push).
   *  Hardware unlock records prove such codes work — trust the lock, stop re-verifying. */
  confirmedUnlisted?: boolean;
}

// After this many repair rounds where addPasscode says -3007 ("already exists") but
// listKeyboardPwd can't show the entry, accept the lock's word instead of retrying forever.
const MAX_UNLISTED_VERIFY_ATTEMPTS = 3;

interface PasscodeGenerationResult {
  success: boolean;
  passcode?: string;
  ttlockKeyId?: number;
  error?: string;
  details?: {
    reservationId: string;
    roomId: string;
    lockId: string;
  };
}

export class AutomationEngine {
  private pinLifecycle: PinLifecycleService;

  constructor(
    private storage: IStorage,
    private ttlockClient: TTLockClient | null = null,
    private notificationClient: NotificationClient | null = null,
    private mewsClient: MewsClient | null = null
  ) {
    this.pinLifecycle = new PinLifecycleService(storage, ttlockClient, mewsClient);
  }

  getTTLockClient(): TTLockClient | null {
    return this.ttlockClient;
  }

  getMewsClient(): MewsClient | null {
    return this.mewsClient;
  }

  getPinLifecycle(): PinLifecycleService {
    return this.pinLifecycle;
  }

  /** Delegate to PinLifecycleService's safer generator */
  private generateRandomPasscode(): string {
    return this.pinLifecycle.generateSafePasscode();
  }

  /**
   * Returns the keyboardPwdVersion for a lock, using the cached value in the DB.
   * Only calls TTLock API (getLockStatus) if the version is not yet cached.
   * Saves the fetched version back to DB for future use.
   */
  private async getCachedKeyboardPwdVersion(ttlockId: string, lockDeviceId?: string): Promise<number | null> {
    let device = lockDeviceId
      ? await this.storage.getLockDevice(lockDeviceId)
      : await this.storage.getLockDeviceByTTLockId(ttlockId);

    if (device?.keyboardPwdVersion != null) {
      return device.keyboardPwdVersion;
    }

    // Not cached — fetch from TTLock API once
    if (!this.ttlockClient) return null;
    try {
      const details = await this.ttlockClient.getLockStatus(ttlockId);
      if (!details?.keyboardPwdVersion) return null;
      // Save to cache
      if (device) {
        await this.storage.updateLockDevice(device.id, { keyboardPwdVersion: details.keyboardPwdVersion });
      }
      return details.keyboardPwdVersion;
    } catch {
      return null;
    }
  }

  async buildPasscodeWindow(reservation: Reservation): Promise<{ validFrom: Date; validTo: Date }> {
    return buildValidityWindow(this.storage, reservation);
  }

  /**
   * Update PIN validity period when reservation check-in/check-out times change.
   * This updates both the database and TTLock passcode period.
   */
  async updatePinValidity(reservationId: string, options: { force?: boolean } = {}): Promise<{ success: boolean; error?: string }> {
    try {
      const reservation = await this.storage.getReservation(reservationId);
      if (!reservation) {
        return { success: false, error: "Reservation not found" };
      }

      if (!reservation.roomId) {
        return { success: false, error: "No room assigned to reservation" };
      }

      // Find active, pending, or used PIN for this reservation.
      // "used" PINs are still live in TTLock — their validity must be updated when dates change.
      const pins = await this.storage.getPinsByRoomId(reservation.roomId);
      const pin = pins.find(
        p => p.reservationId === reservationId &&
             (p.status === "pending" || p.status === "active" || p.status === "used")
      );

      if (!pin) {
        await this.storage.createLog({
          level: "info",
          message: `No active/pending/used PIN to update for reservation`,
          source: "automation",
          reservationId,
        });
        return { success: true }; // No PIN to update, that's OK
      }

      // Calculate new validity window
      const newWindow = await this.buildPasscodeWindow(reservation);

      // Safety: never set validFrom to the future for a physically present (checked-in) guest —
      // that would immediately revoke their access.
      // Only applies to Checked-in/Started status, NOT Confirmed guests.
      const isCheckedInGuest = ["checked-in", "started"].includes((reservation.status || "").toLowerCase());
      const isLivePin = pin.status === "active" || pin.status === "used";
      const now = new Date();
      if (isLivePin && isCheckedInGuest && newWindow.validFrom > now) {
        // Arrival moved to the future but guest is physically present — keep current validFrom
        newWindow.validFrom = new Date(pin.validFrom) < now
          ? new Date(pin.validFrom)   // keep existing (already in past, correct)
          : now;                       // fallback: start from now
      }

      // Check if validity has actually changed
      const oldValidFrom = new Date(pin.validFrom).getTime();
      const oldValidTo = new Date(pin.validTo).getTime();
      const newValidFrom = newWindow.validFrom.getTime();
      const newValidTo = newWindow.validTo.getTime();

      if (!options.force && oldValidFrom === newValidFrom && oldValidTo === newValidTo) {
        return { success: true }; // No change needed
      }

      await this.storage.createLog({
        level: "info",
        message: `Updating PIN validity for reservation time change`,
        source: "automation",
        reservationId,
        metadata: {
          oldValidFrom: new Date(oldValidFrom).toISOString(),
          oldValidTo: new Date(oldValidTo).toISOString(),
          newValidFrom: newWindow.validFrom.toISOString(),
          newValidTo: newWindow.validTo.toISOString(),
        },
      });

      // Track whether DB dates should be updated at the end
      let ttlockUpdateSucceeded: boolean;

      // Update TTLock passcode validity for active and used PINs — both are live in TTLock
      if ((pin.status === "active" || pin.status === "used") && this.ttlockClient) {
        // Track which TTLock device IDs we successfully update
        const updatedTtlockIds = new Set<string>();

        // ── Phase 1: update via stored keyIds (fast path) ──────────────────
        const roomLockKeyIds = (pin.roomLockKeyIds as any[]) || [];
        const commonAreaKeyIds = (pin.commonAreaKeyIds as any[]) || [];
        const allKeyIds = [...roomLockKeyIds, ...commonAreaKeyIds];

        for (const lockEntry of allKeyIds) {
          if (!lockEntry.keyId || !lockEntry.ttlockId) continue;

          let keyId = lockEntry.keyId;

          // Resolve "existing" sentinel — look up real keyId from TTLock
          if (keyId === "existing") {
            try {
              const passcodes = await this.ttlockClient.listPasscodes(lockEntry.ttlockId);
              const match = passcodes.find((p: any) => p.code === pin.code);
              if (match) keyId = match.id.toString();
              else {
                await this.storage.createLog({ level: "warn", message: `Could not resolve "existing" keyId for ${lockEntry.lockName || 'lock'} — will retry via fallback`, source: "automation", reservationId });
                continue;
              }
            } catch {
              continue;
            }
          }

          const numericKeyId = parseInt(keyId, 10);
          if (isNaN(numericKeyId)) continue;

          try {
            await this.ttlockClient.updatePasscode(lockEntry.ttlockId, numericKeyId, pin.code, newWindow.validFrom, newWindow.validTo);
            updatedTtlockIds.add(lockEntry.ttlockId);
            await this.storage.createLog({
              level: "info",
              message: `Updated TTLock passcode validity for ${lockEntry.lockName || 'lock'}`,
              source: "automation",
              reservationId,
            });
          } catch (error) {
            await this.storage.createLog({
              level: "warn",
              message: `Failed to update TTLock passcode for ${lockEntry.lockName || 'lock'} via stored keyId — will retry via fallback: ${error}`,
              source: "automation",
              reservationId,
            });
          }
        }

        // ── Phase 2: fallback — cover ALL current lock assignments ──────────
        // Catches: locks added after PIN creation, locks whose stored keyId was
        // wrong/missing, locks where Phase 1 failed. Queries TTLock directly.
        try {
          const lockAssignments = await this.storage.getRoomLockAssignments(reservation.roomId);
          for (const assignment of lockAssignments) {
            const lock = (assignment as any).lockDevice ?? assignment;
            const ttlockId: string = lock.ttlockId ?? lock.ttlock_id;
            if (!ttlockId || updatedTtlockIds.has(ttlockId)) continue;

            try {
              const passcodes = await this.ttlockClient.listPasscodes(ttlockId);
              const match = passcodes.find((p: any) => p.code === pin.code);
              if (!match) {
                // PIN not on this lock — not an error, it may never have been pushed
                continue;
              }
              await this.ttlockClient.updatePasscode(ttlockId, match.id, pin.code, newWindow.validFrom, newWindow.validTo);
              updatedTtlockIds.add(ttlockId);
              await this.storage.createLog({
                level: "info",
                message: `Updated TTLock passcode validity for ${lock.name || lock.doorName || ttlockId} (via fallback lookup)`,
                source: "automation",
                reservationId,
              });
            } catch (err) {
              await this.storage.createLog({
                level: "warn",
                message: `Fallback update failed for lock ${lock.name || ttlockId}: ${err}`,
                source: "automation",
                reservationId,
              });
            }
          }
        } catch (err) {
          await this.storage.createLog({ level: "warn", message: `Could not fetch lock assignments for fallback update: ${err}`, source: "automation", reservationId });
        }

        await this.storage.createLog({
          level: "info",
          message: `PIN validity updated on ${updatedTtlockIds.size} lock(s): ${Array.from(updatedTtlockIds).join(", ")}`,
          source: "automation",
          reservationId,
        });

        ttlockUpdateSucceeded = updatedTtlockIds.size > 0;
      } else {
        // PIN is pending (not yet in TTLock) or no TTLock client — update DB regardless
        ttlockUpdateSucceeded = true;
      }

      if (ttlockUpdateSucceeded) {
        // Update PIN dates in database — only after confirming TTLock was updated
        // (prevents false "no change needed" on retry if TTLock silently failed)
        await this.storage.updatePin(pin.id, {
          validFrom: newWindow.validFrom,
          validTo: newWindow.validTo,
        });

        await this.storage.createReservationLog({
          reservationId,
          message: `PIN validity updated due to reservation time change`,
          type: "pin_updated",
          detail: `New validity: ${newWindow.validFrom.toISOString()} to ${newWindow.validTo.toISOString()}`,
        });

        return { success: true };
      } else {
        await this.storage.createLog({
          level: "warn",
          message: `PIN DB dates NOT updated — TTLock update failed on all locks. Will retry next poll.`,
          source: "automation",
          reservationId,
        });
        return { success: false, error: "TTLock update failed on all locks" };
      }
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Failed to update PIN validity: ${error}`,
        source: "automation",
        reservationId,
      });
      return { success: false, error: String(error) };
    }
  }

  /**
   * Check if a reservation is a late same-day arrival (arrival time has already passed)
   * If so, immediately activate the pending PIN instead of waiting for the scheduler
   */
  async isLateSameDayArrival(reservationId: string): Promise<boolean> {
    const reservation = await this.storage.getReservation(reservationId);
    if (!reservation) return false;

    const timezoneSetting = await this.storage.getSetting('property_timezone');
    const pinActivationTimeSetting = await this.storage.getSetting('pin_activation_time');
    
    const timezone = timezoneSetting?.value || 'Europe/Copenhagen';
    const arrivalTime = pinActivationTimeSetting?.value || '14:00';
    const [arrivalHour, arrivalMinute] = arrivalTime.split(':').map(Number);
    
    const now = DateTime.now().setZone(timezone);
    const arrivalDate = DateTime.fromJSDate(new Date(reservation.arrival), { zone: 'utc' }).setZone(timezone);
    
    // Check if arrival is today
    if (now.toFormat('yyyy-MM-dd') !== arrivalDate.toFormat('yyyy-MM-dd')) {
      return false;
    }
    
    // Check if current time is past the arrival time
    const arrivalDateTime = arrivalDate.set({ hour: arrivalHour, minute: arrivalMinute, second: 0 });
    return now >= arrivalDateTime;
  }

  /**
   * Immediately activate a pending PIN for a reservation
   * Used for late same-day arrivals where the scheduler has already run
   */
  async immediatelyActivatePendingPin(reservationId: string): Promise<{ success: boolean; error?: string; alreadyActive?: boolean }> {
    // Delegate to PinLifecycleService which pushes to ALL assigned locks (room + common area)
    return this.pinLifecycle.activatePendingForReservation(reservationId);
  }

  /** @deprecated — delegates to PinLifecycleService.activateForToday() */
  async activatePendingPinsForToday(): Promise<{ activated: number; failed: number; skipped: number }> {
    return this.pinLifecycle.activateForToday();
  }

  async createPasscodeForReservation(
    reservationId: string,
    skipNotification: boolean = false
  ): Promise<PasscodeGenerationResult> {
    const processStartTime = Date.now();
    let lockDetailsTime: number | null = null;
    let roomPasscodeTime: number | null = null;
    let commonAreasTime: number | null = null;
    let notificationTime: number | null = null;
    
    try {
      const reservation = await this.storage.getReservation(reservationId);
      if (!reservation) {
        await this.storage.createLog({
          level: "error",
          message: "Reservation not found",
          source: "automation",
          reservationId,
        });
        return {
          success: false,
          error: "Reservation not found",
        };
      }

      if (reservation.generatedPin && reservation.roomId) {
        const room = await this.storage.getRoom(reservation.roomId);
        if (room) {
          const existingPins = await this.storage.getPinsByRoomId(room.id);
          const activePin = existingPins.find(
            p => p.reservationId === reservationId && p.status === "active" && p.code === reservation.generatedPin
          );

          if (activePin) {
            await this.storage.createLog({
              level: "info",
              message: `Passcode already exists for reservation, skipping duplicate creation`,
              source: "automation",
              reservationId,
              metadata: { existingPin: reservation.generatedPin },
            });
            return {
              success: true,
              passcode: reservation.generatedPin,
            };
          } else {
            await this.storage.createLog({
              level: "warn",
              message: `Reservation has generatedPin but no active pin record - will regenerate`,
              source: "automation",
              reservationId,
              metadata: { stalePin: reservation.generatedPin },
            });
          }
        }
      }

      if (!reservation.roomId) {
        await this.storage.createLog({
          level: "error",
          message: "Reservation has no room assignment",
          source: "automation",
          reservationId,
          metadata: { reservation },
        });
        await this.storage.createReservationLog({
          reservationId,
          message: "Cannot create passcode - no room assigned",
          type: "passcode_error",
          detail: "Reservation has no room assignment. Assign a room in the PMS to enable passcode generation.",
        });
        return {
          success: false,
          error: "No room assigned to reservation",
        };
      }

      const room = await this.storage.getRoom(reservation.roomId);
      if (!room) {
        await this.storage.createLog({
          level: "error",
          message: "Room not found",
          source: "automation",
          reservationId,
          roomId: reservation.roomId,
        });
        return {
          success: false,
          error: "Room not found",
        };
      }

      const roomLockAssignments = await this.storage.getRoomLockAssignments(room.id);
      const assignedLocks = roomLockAssignments
        .map(a => a.lockDevice)
        .filter((ld): ld is LockDevice & { ttlockId: string } => !!ld.ttlockId);
      
      if (assignedLocks.length === 0) {
        await this.storage.createLog({
          level: "warn",
          message: "Room has no locks configured - cannot create passcode",
          source: "automation",
          reservationId,
          roomId: room.id,
          metadata: { roomName: getSpaceDisplayName(room.name, room.label) },
        });
        await this.storage.createReservationLog({
          reservationId,
          message: "Cannot create passcode - room has no lock",
          type: "passcode_error",
          detail: `Room "${getSpaceDisplayName(room.name, room.label)}" has no lock assigned. Configure lock assignment in Settings > Spaces.`,
        });
        return {
          success: false,
          error: "Room has no lock configured",
        };
      }

      if (!this.ttlockClient) {
        await this.storage.createLog({
          level: "error",
          message: "TTLock client not initialized - check API credentials",
          source: "automation",
          reservationId,
          roomId: room.id,
        });
        return {
          success: false,
          error: "TTLock integration not configured",
        };
      }

      const existingPins = await this.storage.getPinsByRoomId(room.id);
      const activePinsForReservation = existingPins.filter(
        p => p.reservationId === reservationId && p.status === "active"
      );

      if (activePinsForReservation.length > 0 && this.ttlockClient) {
        for (const oldPin of activePinsForReservation) {
          let roomLocksDeleteSuccess = true;
          
          const rawRoomLockKeyIds = (oldPin.roomLockKeyIds as any);
          const hasRoomLockKeyIds = rawRoomLockKeyIds && Array.isArray(rawRoomLockKeyIds) && rawRoomLockKeyIds.length > 0;
          
          if (hasRoomLockKeyIds) {
            const deletePromises = rawRoomLockKeyIds.map(async (entry: RoomLockKeyId) => {
              if (!entry.ttlockId || !entry.keyId) return { success: false, error: "Missing data" };
              let keyId = entry.keyId;
              // Resolve "existing" sentinel to real keyId
              if (keyId === "existing" && this.ttlockClient) {
                try {
                  const passcodes = await this.ttlockClient.listPasscodes(entry.ttlockId);
                  const match = passcodes.find(p => p.code === oldPin.code);
                  if (match) keyId = match.id.toString();
                } catch {
                  // Fall through - delete will fail, handled below
                }
              }
              try {
                await this.ttlockClient!.deletePasscode(entry.ttlockId, parseInt(keyId));
                return { success: true, lockName: entry.lockName };
              } catch (error) {
                return { success: false, lockName: entry.lockName, error: error instanceof Error ? error.message : String(error) };
              }
            });

            const results = await Promise.all(deletePromises);
            const failures = results.filter(r => !r.success);

            if (failures.length > 0) {
              roomLocksDeleteSuccess = false;
              for (const f of failures) {
                await this.storage.createLog({
                  level: "error",
                  message: `Failed to revoke old passcode from ${f.lockName}: ${f.error}`,
                  source: "automation",
                  reservationId,
                  roomId: room.id,
                });
              }
            } else {
              await this.storage.createLog({
                level: "info",
                message: `Revoked old passcodes from ${rawRoomLockKeyIds.length} assigned lock(s)`,
                source: "automation",
                reservationId,
                roomId: room.id,
              });
            }
          } else if (oldPin.ttlockKeyId || oldPin.roomLockKeyIds) {
            roomLocksDeleteSuccess = false;
            await this.storage.createLog({
              level: "error",
              message: `Old pin has lock key IDs but cannot resolve lock(s) to revoke - blocking new passcode creation`,
              source: "automation",
              reservationId,
              roomId: room.id,
              metadata: { 
                pinId: oldPin.id,
                hasRoomLockKeyIds: !!oldPin.roomLockKeyIds,
                hasTtlockKeyId: !!oldPin.ttlockKeyId
              },
            });
          }
          
          if (roomLocksDeleteSuccess) {
            await this.storage.updatePin(oldPin.id, { status: "replaced" });
          } else {
            await this.storage.createLog({
              level: "error",
              message: `Failed to revoke all old passcodes - cannot create new one to prevent duplicates`,
              source: "automation",
              reservationId,
              roomId: room.id,
              metadata: { pinId: oldPin.id },
            });
            return {
              success: false,
              error: `Failed to fully revoke existing passcode`,
            };
          }
        }
      }

      const passcodeWindow = await this.buildPasscodeWindow(reservation);
      // CRITICAL: re-read generatedPin from DB — permanent, never overwrite
      const freshResForPin = await this.storage.getReservation(reservationId);
      const existingPin = freshResForPin?.generatedPin || reservation.generatedPin;
      const passcode = existingPin || this.generateRandomPasscode();
      const guestName = `${reservation.firstName} ${reservation.lastName}`;
      const shortName = guestName.length > 20 ? guestName.substring(0, 20) : guestName;

      const roomLockKeyIds: RoomLockKeyId[] = [];
      let primaryTtlockKeyId: string | null = null;

      const locksToProgram: Array<{ ttlockId: string; lockName: string; lockDeviceId?: string }> = [];
      
      for (const lock of assignedLocks) {
        locksToProgram.push({ ttlockId: lock.ttlockId, lockName: lock.name, lockDeviceId: lock.id });
      }

      const validLocks: Array<{ ttlockId: string; lockName: string; lockDeviceId?: string; keyboardPwdVersion: number }> = [];
      await Promise.all(
        locksToProgram.map(async (lock) => {
          const keyboardPwdVersion = await this.getCachedKeyboardPwdVersion(lock.ttlockId, lock.lockDeviceId);
          if (!keyboardPwdVersion) {
            await this.storage.createLog({
              level: "warn",
              message: `Skipping lock ${lock.lockName}: keyboardPwdVersion not available`,
              source: "automation",
              reservationId,
              roomId: room.id,
              metadata: { lockId: lock.ttlockId },
            });
            return;
          }
          validLocks.push({ ...lock, keyboardPwdVersion });
        })
      );
      lockDetailsTime = Date.now();

      if (validLocks.length === 0) {
        await this.storage.createLog({
          level: "error",
          message: "No valid locks available for passcode creation",
          source: "automation",
          reservationId,
          roomId: room.id,
        });
        return { success: false, error: "No valid locks available" };
      }

      const passcodePromises = validLocks.map(async (lock) => {
        try {
          const result = await this.ttlockClient!.addPasscode(lock.ttlockId, passcode, shortName, {
            startDate: passcodeWindow.validFrom,
            endDate: passcodeWindow.validTo,
            keyboardPwdVersion: lock.keyboardPwdVersion,
          });
          return { lock, result, error: null };
        } catch (error) {
          return { lock, result: null, error: error instanceof Error ? error.message : String(error) };
        }
      });

      const passcodeResults = await Promise.all(passcodePromises);
      roomPasscodeTime = Date.now();

      let successCount = 0;
      const commonAreaKeyIds: RoomLockKeyId[] = [];
      // Map ttlockId -> keyboardPwdId for QR code creation
      const keyboardPwdIdMap: Record<string, number> = {};
      for (const result of passcodeResults) {
        if (result.error || !result.result) {
          const offline = isLockOfflineError(result.error);
          await this.storage.createLog({
            level: offline ? "warn" : "error",
            message: offline
              ? `Create passcode deferred on ${result.lock.lockName} — lock offline (${result.error}); will retry when it reconnects`
              : `Failed to create passcode on ${result.lock.lockName}: ${result.error}`,
            source: "automation",
            reservationId,
            roomId: room.id,
          });
          continue;
        }
        successCount++;
        const keyId = result.result.id.toString();
        // Store the keyboardPwdId for QR code creation
        keyboardPwdIdMap[result.lock.ttlockId] = result.result.id;
        if (result.lock.lockDeviceId) {
          const lockDevice = assignedLocks.find(l => l.id === result.lock.lockDeviceId);
          const lockEntry = {
            lockDeviceId: result.lock.lockDeviceId,
            ttlockId: result.lock.ttlockId,
            keyId,
            lockName: result.lock.lockName,
          };
          if (lockDevice && lockDevice.lockType === "room") {
            roomLockKeyIds.push(lockEntry);
          } else {
            commonAreaKeyIds.push(lockEntry);
          }
        }
        if (!primaryTtlockKeyId) primaryTtlockKeyId = keyId;
      }

      if (successCount === 0) {
        const failedLockNames = passcodeResults.map(r => r.lock.lockName).join(', ');
        const failedErrors = passcodeResults.filter(r => r.error).map(r => `${r.lock.lockName}: ${r.error}`).join('; ');
        // If every lock failed purely because it's offline, this is a deferred
        // (retryable) condition, not a hard error — the drift reconciler / repair
        // job will program the locks once their gateways reconnect.
        const allOffline = passcodeResults.every(r => isLockOfflineError(r.error));

        await this.storage.createLog({
          level: allOffline ? "warn" : "error",
          message: allOffline
            ? `Create passcode deferred — all ${validLocks.length} lock(s) offline; will retry when they reconnect`
            : `Failed to create passcode on any lock - all ${validLocks.length} lock(s) failed`,
          source: "automation",
          reservationId,
          roomId: room.id,
          metadata: {
            failedLocks: failedLockNames,
            errors: failedErrors,
            guestName,
          },
        });
        
        await this.storage.createReservationLog({
          reservationId,
          message: allOffline ? "Passcode creation deferred — locks offline" : "Passcode creation failed",
          type: allOffline ? "passcode_deferred" : "passcode_error",
          detail: allOffline
            ? `All lock(s) offline: ${failedLockNames}. Will retry when they reconnect.`
            : `Failed to program lock(s): ${failedLockNames}. Error: ${failedErrors}`,
        });

        return { success: false, error: `Failed to create passcode on any lock: ${failedErrors}` };
      }

      await this.storage.createLog({
        level: "info",
        message: `All assigned locks programmed: ${successCount}/${validLocks.length} (parallel)`,
        source: "automation",
        reservationId,
        roomId: room.id,
        metadata: { successCount, totalLocks: validLocks.length },
      });

      // QR code creation disabled - using eKey (remote unlock) only
      interface QrCodeDataEntry {
        lockDeviceId: string;
        ttlockId: string;
        qrCodeId: number;
        qrCodeData: string;
        lockName: string;
      }
      
      const qrCodeDataList: QrCodeDataEntry[] = [];
      const ttlockQrCodeIds: Record<string, number> = {};

      // Only set generatedPin if not already set (permanent — never overwrite)
      if (!existingPin) {
        await this.storage.updateReservation(reservationId, {
          generatedPin: passcode,
        });
      }

      await this.storage.createPin({
        roomId: room.id,
        reservationId,
        type: "Passcode",
        code: passcode,
        name: guestName,
        email: reservation.email || undefined,
        validFrom: passcodeWindow.validFrom,
        validTo: passcodeWindow.validTo,
        status: "active",
        doors: [],
        assigner: "Automation",
        ttlockKeyId: primaryTtlockKeyId || undefined,
        roomLockKeyIds: roomLockKeyIds,
        commonAreaKeyIds: commonAreaKeyIds,
        qrCodeData: qrCodeDataList,
        ttlockQrCodeIds: ttlockQrCodeIds,
      });

      await this.storage.createReservationLog({
        reservationId,
        message: `Passcode created successfully`,
        type: "passcode_created",
        detail: `Passcode ${passcode} created for ${getSpaceDisplayName(room.name, room.label)} (${successCount} lock(s))`,
      });

      await this.storage.createLog({
        level: "info",
        message: `Passcode created for reservation ${reservation.pmsId}`,
        source: "automation",
        reservationId,
        roomId: room.id,
        metadata: {
          guestName,
          roomName: getSpaceDisplayName(room.name, room.label),
          arrival: reservation.arrival,
          departure: reservation.departure,
          roomLockCount: successCount,
          roomLockKeyIds,
        },
      });

      if (this.notificationClient && !skipNotification) {
        try {
          const notificationResult = await this.notificationClient.sendNotification({
            guestName,
            email: reservation.email || undefined,
            mobile: reservation.mobile || undefined,
            passcode,
            roomName: getSpaceDisplayName(room.name, room.label),
            arrival: passcodeWindow.validFrom,
            departure: passcodeWindow.validTo,
            confirmationCode: reservation.confirmationCode || undefined,
          });
          notificationTime = Date.now();

          if (notificationResult.success) {
            await this.storage.updateReservation(reservationId, { notificationSent: true });
            
            await this.storage.createLog({
              level: "info",
              message: `Passcode notification sent to guest`,
              source: "automation",
              reservationId,
              roomId: room.id,
              metadata: {
                smsDelivered: notificationResult.smsDelivered,
                emailDelivered: notificationResult.emailDelivered,
              },
            });

            await this.storage.createReservationLog({
              reservationId,
              message: "Guest notification sent",
              type: "notification_sent",
              detail: `Passcode sent via ${notificationResult.smsDelivered ? 'SMS' : ''}${notificationResult.smsDelivered && notificationResult.emailDelivered ? ' and ' : ''}${notificationResult.emailDelivered ? 'Email' : ''}`,
            });
          } else {
            await this.storage.createLog({
              level: "warn",
              message: `Failed to send passcode notification: ${notificationResult.error}`,
              source: "automation",
              reservationId,
              roomId: room.id,
            });
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          await this.storage.createLog({
            level: "error",
            message: `Notification error: ${errorMessage}`,
            source: "automation",
            reservationId,
            roomId: room.id,
            metadata: { error: errorMessage },
          });
        }
      }

      // MEWS sync is ONLY done in PinLifecycleService.onReservationCreated() — once, at initial
      // PIN creation. Never push to MEWS again (the note is permanent).

      const processTotalTime = Date.now() - processStartTime;
      
      await this.storage.createLog({
        level: "info",
        message: `Passcode generation performance metrics for ${guestName}`,
        source: "automation",
        reservationId,
        roomId: room.id,
        metadata: {
          totalTimeMs: processTotalTime,
          lockDetailsTimeMs: lockDetailsTime ? lockDetailsTime - processStartTime : null,
          roomPasscodeTimeMs: roomPasscodeTime && lockDetailsTime ? roomPasscodeTime - lockDetailsTime : null,
          commonAreasTimeMs: commonAreasTime && roomPasscodeTime ? commonAreasTime - roomPasscodeTime : null,
          notificationTimeMs: notificationTime && commonAreasTime ? notificationTime - commonAreasTime : null,
          breakdown: {
            lockDetails: lockDetailsTime ? `${lockDetailsTime - processStartTime}ms` : 'N/A',
            roomPasscode: roomPasscodeTime && lockDetailsTime ? `${roomPasscodeTime - lockDetailsTime}ms` : 'N/A',
            commonAreas: commonAreasTime && roomPasscodeTime ? `${commonAreasTime - roomPasscodeTime}ms` : 'N/A',
            notification: notificationTime && commonAreasTime ? `${notificationTime - commonAreasTime}ms` : 'N/A',
            total: `${processTotalTime}ms`,
          },
        },
      });

      return {
        success: true,
        passcode,
        ttlockKeyId: primaryTtlockKeyId ? parseInt(primaryTtlockKeyId) : undefined,
        details: {
          reservationId,
          roomId: room.id,
          lockId: validLocks[0]?.ttlockId || "",
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.storage.createLog({
        level: "error",
        message: `Unexpected error in automation: ${errorMessage}`,
        source: "automation",
        reservationId,
        metadata: { error: errorMessage },
      });
      return {
        success: false,
        error: `Unexpected error: ${errorMessage}`,
      };
    }
  }

  async sendNotificationForReservation(reservationId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const reservation = await this.storage.getReservation(reservationId);
      if (!reservation) {
        return { success: false, error: "Reservation not found" };
      }

      if (!reservation.generatedPin) {
        return { success: false, error: "No passcode exists for this reservation" };
      }

      if (!reservation.roomId) {
        return { success: false, error: "Reservation has no room assigned" };
      }

      const room = await this.storage.getRoom(reservation.roomId);
      if (!room) {
        return { success: false, error: "Room not found" };
      }

      if (!this.notificationClient) {
        await this.storage.createLog({
          level: "warn",
          message: "Notification client not configured - cannot send notification",
          source: "automation",
          reservationId,
        });
        return { success: false, error: "Notification client not configured" };
      }

      const guestName = `${reservation.firstName} ${reservation.lastName}`;
      const passcodeWindow = await this.buildPasscodeWindow(reservation);

      const notificationResult = await this.notificationClient.sendNotification({
        guestName,
        email: reservation.email || undefined,
        mobile: reservation.mobile || undefined,
        passcode: reservation.generatedPin,
        roomName: getSpaceDisplayName(room.name, room.label),
        arrival: passcodeWindow.validFrom,
        departure: passcodeWindow.validTo,
        confirmationCode: reservation.confirmationCode || undefined,
      });

      if (notificationResult.success) {
        await this.storage.updateReservation(reservationId, { notificationSent: true });

        await this.storage.createLog({
          level: "info",
          message: `Check-in notification sent to guest`,
          source: "automation",
          reservationId,
          roomId: room.id,
          metadata: {
            smsDelivered: notificationResult.smsDelivered,
            emailDelivered: notificationResult.emailDelivered,
          },
        });

        await this.storage.createReservationLog({
          reservationId,
          message: "Check-in notification sent",
          type: "notification_sent",
          detail: `Passcode sent via ${notificationResult.smsDelivered ? 'SMS' : ''}${notificationResult.smsDelivered && notificationResult.emailDelivered ? ' and ' : ''}${notificationResult.emailDelivered ? 'Email' : ''}`,
        });

        return { success: true };
      } else {
        await this.storage.createLog({
          level: "warn",
          message: `Failed to send check-in notification: ${notificationResult.error}`,
          source: "automation",
          reservationId,
          roomId: room.id,
        });
        return { success: false, error: notificationResult.error };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.storage.createLog({
        level: "error",
        message: `Notification error: ${errorMessage}`,
        source: "automation",
        reservationId,
        metadata: { error: errorMessage },
      });
      return { success: false, error: errorMessage };
    }
  }

  // --- Dead code (roomsShareSameLocks, oldRoomLocksAreSubsetOfNew, handleRoomChange,
  // _handleRoomChange_DEAD, movePinToNewRoom) was removed in cleanup.
  // All room-change PIN logic now goes through PinLifecycleService.onRoomChanged().

  async repairPasscodeForReservation(
    reservationId: string,
    force: boolean = false,
    opts: { includeConfirmedUnlisted?: boolean } = {},
  ): Promise<{ success: boolean; error?: string; synced?: string[]; offline?: string[]; failed?: string[] }> {
    // Serialized per reservation (shared mutex with PinLifecycleService): the
    // report's force-repair and the 5-min sweep run in the same scheduler tick
    // and both rewrite the pin's keyId arrays — unserialized, the last writer
    // wiped the other's recorded keyIds/verifyAttempts.
    return this.getPinLifecycle().withReservationLock(reservationId, () =>
      this._repairPasscodeForReservation(reservationId, force, opts));
  }

  private async _repairPasscodeForReservation(
    reservationId: string,
    force: boolean,
    opts: { includeConfirmedUnlisted?: boolean },
  ): Promise<{ success: boolean; error?: string; synced?: string[]; offline?: string[]; failed?: string[] }> {
    try {
      const reservation = await this.storage.getReservation(reservationId);
      if (!reservation) {
        return { success: false, error: "Reservation not found" };
      }

      if (!reservation.roomId) {
        return { success: false, error: "No room assigned to reservation" };
      }

      const room = await this.storage.getRoom(reservation.roomId);
      if (!room) {
        return { success: false, error: "Room not found" };
      }

      const pins = await this.storage.getPinsByRoomId(reservation.roomId);
      // "used" pins (guest already unlocked once) are still repairable for the
      // rest of the stay — a missing common-area lock must not stay missing just
      // because the guest got through another door first.
      const activePin = pins.find(p => p.reservationId === reservationId && (p.status === "active" || p.status === "used"));

      if (!activePin) {
        return { success: false, error: "No active pin found for reservation" };
      }

      if (!this.ttlockClient) {
        return { success: false, error: "TTLock client not initialized" };
      }

      const roomLockAssignments = await this.storage.getRoomLockAssignments(room.id);
      const assignedLocks = roomLockAssignments
        .map(a => a.lockDevice)
        .filter((ld): ld is LockDevice & { ttlockId: string } => !!ld.ttlockId);

      if (assignedLocks.length === 0) {
        return { success: false, error: "No locks assigned to room" };
      }

      const roomLockKeyIds = (Array.isArray(activePin.roomLockKeyIds) ? activePin.roomLockKeyIds : []) as RoomLockKeyId[];
      const priorCommonAreaKeyIds = (Array.isArray(activePin.commonAreaKeyIds) ? activePin.commonAreaKeyIds : []) as RoomLockKeyId[];
      // keyId "existing" is an unverified sentinel (a -3007 whose entry we never
      // confirmed on the lock) — treat those locks as missing so they get re-verified.
      // Exception: confirmedUnlisted entries are done — the lock repeatedly asserted
      // the code exists while the cloud list can't show it; re-verifying can never
      // succeed. The manual escape hatch (includeConfirmedUnlisted) reopens them.
      const settled = (k: RoomLockKeyId) =>
        k.keyId !== "existing" || (!opts.includeConfirmedUnlisted && k.confirmedUnlisted);
      const existingKeyIds = new Set(
        roomLockKeyIds
          .filter(settled)
          .map((k: RoomLockKeyId) => k.lockDeviceId)
      );
      // Common-door entries live in commonAreaKeyIds (written by the push path).
      // They must count as existing too — historically they were ignored here, so
      // every repair re-pushed every common door (-3007 churn) and misfiled the
      // resulting entries into roomLockKeyIds (the duplicate-entry source).
      for (const k of priorCommonAreaKeyIds) {
        if (k?.lockDeviceId && settled(k)) {
          existingKeyIds.add(k.lockDeviceId);
        }
      }

      // confirmedUnlisted locks are terminal — the lock keeps asserting the
      // code exists while the cloud list can't show it, so a re-push can only
      // -3007 again, and restarting would wipe the converged state. Excluded
      // even under force (the report's force-repair used to re-push these
      // every build → the 22/7-23/7 every-minute sync churn).
      // Escape hatch: the manual admin repair endpoint passes
      // includeConfirmedUnlisted so a false-positive convergence can still be
      // re-attempted deliberately; a still-phantom lock just re-confirms
      // (see the -3007 handler) instead of re-entering the retry loop.
      const confirmedUnlistedIds = new Set(
        [...roomLockKeyIds, ...priorCommonAreaKeyIds]
          .filter((k: RoomLockKeyId) => k.keyId === "existing" && k.confirmedUnlisted)
          .map((k: RoomLockKeyId) => k.lockDeviceId)
      );
      // If force=true, resync ALL locks. Otherwise only sync missing ones.
      const locksToSync = (force ? assignedLocks : assignedLocks.filter(l => !existingKeyIds.has(l.id)))
        .filter(l => opts.includeConfirmedUnlisted || !confirmedUnlistedIds.has(l.id));

      if (locksToSync.length === 0) {
        return { success: true, synced: [], error: "All locks already have the passcode" };
      }

      const passcodeWindow = await this.buildPasscodeWindow(reservation);
      // Mirror the push path (pin-lifecycle pushToTTLock): a repair runs for a
      // guest who should ALREADY have access, so the code must be usable the
      // moment it lands on the lock. Using the raw validFrom (check-in time,
      // typically 15:00) left codes repaired earlier in the day inert until
      // 15:00 — this directly contributed to the 21/7 lockouts.
      // Guard (review finding): only guests who are live NOW get the early
      // start. Orphan-repush/recovery can run repair for a Confirmed guest
      // arriving in the future — their code must not open doors early.
      const reservationStatusNow = (reservation.status || "").toLowerCase();
      const guestIsLiveNow =
        ["checked-in", "started"].includes(reservationStatusNow) ||
        passcodeWindow.validFrom.getTime() <= Date.now();
      const effectiveStart = guestIsLiveNow
        ? new Date(Math.min(passcodeWindow.validFrom.getTime(), Date.now() - 60_000))
        : passcodeWindow.validFrom;
      const guestName = `${reservation.firstName} ${reservation.lastName}`;
      const shortName = guestName.length > 20 ? guestName.substring(0, 20) : guestName;

      const syncedLocks: string[] = [];
      const offlineLocks: string[] = [];
      const failedLocks: string[] = [];
      // Prior verify attempts per lock, so the -3007 acceptance cap survives
      // across repair runs. Must read BOTH arrays: recordEntry files
      // common-door sentinels into commonAreaKeyIds, so reading only
      // roomLockKeyIds left common-door counters stuck at attempt 1/3 forever
      // and confirmedUnlisted unreachable (the 22/7-23/7 repair loop).
      const priorVerifyAttempts = new Map(
        [...roomLockKeyIds, ...priorCommonAreaKeyIds]
          .filter((k: RoomLockKeyId) => k.keyId === "existing")
          .map((k: RoomLockKeyId) => [k.lockDeviceId, k.verifyAttempts ?? 0])
      );
      // Drop entries for locks we are about to re-sync (unverified "existing"
      // sentinels) so a successful re-push doesn't leave a duplicate entry.
      const updatedRoomLockKeyIds: RoomLockKeyId[] = force
        ? []
        : roomLockKeyIds.filter((k: RoomLockKeyId) => !locksToSync.some(l => l.id === k.lockDeviceId));
      const updatedCommonAreaKeyIds: RoomLockKeyId[] = force
        ? []
        : priorCommonAreaKeyIds.filter((k: RoomLockKeyId) => !locksToSync.some(l => l.id === k.lockDeviceId));
      // Route every new entry by the lock's ACTUAL type — common doors go to
      // commonAreaKeyIds. Repair used to file everything under roomLockKeyIds,
      // which both duplicated entries and defeated missing-lock detection.
      const recordEntry = (lock: LockDevice & { ttlockId: string }, entry: RoomLockKeyId) => {
        const target = lock.lockType === "room" ? updatedRoomLockKeyIds : updatedCommonAreaKeyIds;
        const keep = target.filter(e => e.ttlockId !== entry.ttlockId);
        target.length = 0;
        target.push(...keep, entry);
      };
      let attemptsRecorded = false;

      for (const lock of locksToSync) {
        try {
          const keyboardPwdVersion = await this.getCachedKeyboardPwdVersion(lock.ttlockId, lock.id);
          if (!keyboardPwdVersion) {
            await this.storage.createLog({
              level: "warn",
              message: `Cannot sync to ${lock.name}: keyboardPwdVersion not available`,
              source: "automation",
              reservationId,
            });
            continue;
          }

          const result = await this.ttlockClient.addPasscode(lock.ttlockId, activePin.code, shortName, {
            startDate: effectiveStart,
            endDate: passcodeWindow.validTo,
            keyboardPwdVersion,
          });

          recordEntry(lock, {
            lockDeviceId: lock.id,
            ttlockId: lock.ttlockId,
            keyId: result.id.toString(),
            lockName: lock.name,
          });
          syncedLocks.push(lock.name);

          await this.storage.createLog({
            level: "info",
            message: `Repair: Synced passcode ${activePin.code} to ${lock.name}`,
            source: "automation",
            reservationId,
            roomId: room.id,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (errorMsg.includes("-3007")) {
            // Passcode already exists on lock. Only trust that if we can SEE the
            // entry on the lock with a validity window covering this stay — a
            // stale entry (earlier guest, shorter window) both blocks the add and
            // won't open the door, and marking it synced makes repair stop trying.
            let handled = false;
            try {
              const existingPasscodes = await this.ttlockClient!.listPasscodes(lock.ttlockId);
              const match = existingPasscodes.find(p => p.code === activePin.code);
              if (match) {
                const coversStay =
                  match.startDate <= Date.now() &&
                  (match.endDate === 0 || match.endDate >= passcodeWindow.validTo.getTime());
                if (coversStay) {
                  recordEntry(lock, {
                    lockDeviceId: lock.id,
                    ttlockId: lock.ttlockId,
                    keyId: match.id.toString(),
                    lockName: lock.name,
                  });
                  syncedLocks.push(lock.name);
                  await this.storage.createLog({
                    level: "info",
                    message: `Repair: Passcode ${activePin.code} already on ${lock.name} with covering validity - marked synced (keyId: ${match.id})`,
                    source: "automation",
                    reservationId,
                    roomId: room.id,
                  });
                } else {
                  // Stale entry — replace it with one covering the stay.
                  await this.ttlockClient!.deletePasscode(lock.ttlockId, match.id);
                  const replaced = await this.ttlockClient!.addPasscode(lock.ttlockId, activePin.code, shortName, {
                    startDate: effectiveStart,
                    endDate: passcodeWindow.validTo,
                    keyboardPwdVersion: await this.getCachedKeyboardPwdVersion(lock.ttlockId, lock.id) || 4,
                  });
                  recordEntry(lock, {
                    lockDeviceId: lock.id,
                    ttlockId: lock.ttlockId,
                    keyId: replaced.id.toString(),
                    lockName: lock.name,
                  });
                  syncedLocks.push(lock.name);
                  await this.storage.createLog({
                    level: "info",
                    message: `Repair: Replaced stale passcode entry ${activePin.code} on ${lock.name} (old window ended ${new Date(match.endDate).toISOString()}) - new keyId ${replaced.id}`,
                    source: "automation",
                    reservationId,
                    roomId: room.id,
                  });
                }
                handled = true;
              }
            } catch {
              // list/delete/re-add failed — fall through to failure so we retry
            }
            if (!handled) {
              // A previously converged phantom that -3007s again just
              // re-confirms — restarting its counter would re-enter the retry
              // loop the convergence exists to end (reachable only via the
              // includeConfirmedUnlisted escape hatch).
              if (confirmedUnlistedIds.has(lock.id)) {
                recordEntry(lock, {
                  lockDeviceId: lock.id,
                  ttlockId: lock.ttlockId,
                  keyId: "existing",
                  lockName: lock.name,
                  confirmedUnlisted: true,
                });
                syncedLocks.push(lock.name);
                await this.storage.createLog({
                  level: "info",
                  message: `Repair: ${lock.name} still reports passcode ${activePin.code} exists (-3007) while unlisted — confirmedUnlisted re-affirmed`,
                  source: "automation",
                  reservationId,
                  roomId: room.id,
                });
                continue;
              }
              const attempts = (priorVerifyAttempts.get(lock.id) ?? 0) + 1;
              if (attempts >= MAX_UNLISTED_VERIFY_ATTEMPTS) {
                // The lock has asserted "-3007 already exists" on every push while the
                // cloud list never shows the entry — a known TTLock cloud inconsistency
                // (hardware unlock records prove such codes work). Accept and stop.
                recordEntry(lock, {
                  lockDeviceId: lock.id,
                  ttlockId: lock.ttlockId,
                  keyId: "existing",
                  lockName: lock.name,
                  confirmedUnlisted: true,
                });
                syncedLocks.push(lock.name);
                await this.storage.createLog({
                  level: "info",
                  message: `Repair: ${lock.name} confirmed passcode ${activePin.code} exists (-3007) on ${attempts} attempts while the cloud list never showed it — accepting as on-lock (TTLock list inconsistency)`,
                  source: "automation",
                  reservationId,
                  roomId: room.id,
                });
              } else {
                recordEntry(lock, {
                  lockDeviceId: lock.id,
                  ttlockId: lock.ttlockId,
                  keyId: "existing",
                  lockName: lock.name,
                  verifyAttempts: attempts,
                });
                attemptsRecorded = true;
                failedLocks.push(lock.name);
                await this.storage.createLog({
                  level: "warn",
                  message: `Repair: ${lock.name} reports passcode ${activePin.code} exists (-3007) but it could not be verified on the lock - will retry (attempt ${attempts}/${MAX_UNLISTED_VERIFY_ATTEMPTS})`,
                  source: "automation",
                  reservationId,
                  roomId: room.id,
                });
              }
            }
          } else if (isLockOfflineError(errorMsg)) {
            // Lock offline — deferred, not a failure. Retried automatically when it reconnects.
            offlineLocks.push(lock.name);
            await this.trackLockOfflineEpisode(lock.ttlockId);
            await this.storage.createLog({
              level: "warn",
              message: `Repair: ${lock.name} offline — deferred (${errorMsg}); will retry when it reconnects`,
              source: "automation",
              reservationId,
              roomId: room.id,
            });
          } else {
            failedLocks.push(lock.name);
            await this.storage.createLog({
              level: "error",
              message: `Repair: Failed to sync passcode to ${lock.name}: ${errorMsg}`,
              source: "automation",
              reservationId,
              roomId: room.id,
            });
          }
        }
      }

      // Merge-invariant (review finding; same rule as pushToTTLock): with
      // force=true the arrays were rebuilt from [], so prior entries for locks
      // NOT (re)recorded in this run — offline locks, keyboardPwdVersion-null
      // locks — would be dropped even though their codes still sit on the
      // doors, and checkout would then skip deleting them. Re-add those.
      // (Non-force seeds already retain prior entries, so merging there would
      // only duplicate legacy no-ttlockId entries.)
      if (force) {
        const recordedTtlockIds = new Set(
          [...updatedRoomLockKeyIds, ...updatedCommonAreaKeyIds].map(e => e.ttlockId)
        );
        for (const prev of roomLockKeyIds) {
          const tid = (prev as any)?.ttlockId;
          if (!tid || !recordedTtlockIds.has(tid)) {
            updatedRoomLockKeyIds.push(prev);
            if (tid) recordedTtlockIds.add(tid);
          }
        }
        for (const prev of priorCommonAreaKeyIds) {
          const tid = (prev as any)?.ttlockId;
          if (!tid || !recordedTtlockIds.has(tid)) {
            updatedCommonAreaKeyIds.push(prev);
            if (tid) recordedTtlockIds.add(tid);
          }
        }
      }

      if (syncedLocks.length > 0) {
        // Update PIN with new lock key IDs and set activated_at if it was null
        await this.storage.updatePin(activePin.id, {
          roomLockKeyIds: updatedRoomLockKeyIds,
          commonAreaKeyIds: updatedCommonAreaKeyIds,
          activatedAt: activePin.activatedAt || new Date(),
        });
      } else if (attemptsRecorded) {
        // Nothing synced, but persist the verify-attempt counters so the
        // -3007 acceptance cap makes progress across repair runs.
        await this.storage.updatePin(activePin.id, { roomLockKeyIds: updatedRoomLockKeyIds, commonAreaKeyIds: updatedCommonAreaKeyIds });
      }

      if (syncedLocks.length > 0) {
        
        await this.storage.createReservationLog({
          reservationId,
          message: "Passcode repaired",
          type: "passcode_synced",
          detail: `Synced to: ${syncedLocks.join(", ")}`,
        });
      }

      return { success: true, synced: syncedLocks, offline: offlineLocks, failed: failedLocks };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  // Chronic-failure backoff for the 5-minute repair job. A code that HARD-fails
  // repair run after run (e.g. a conflicting entry on the main entrance that
  // won't delete) must not be hammered onto the lock every 5 minutes: TTLock
  // gateways are slow serial devices (-3037 lock busy / -2011 gateway busy),
  // and repeated add/list/delete churn on the busiest lock delays every OTHER
  // guest's code push to that same lock. Fresh failures keep the fast cadence
  // (fails 1-2 retry on every run — the 21/7 fast-recovery guarantee); from the
  // 3rd consecutive hard failure the pin backs off 10 → 20 → 40 → max 60 min.
  // Offline locks are NOT backed off (waiting for a gateway is cheap and the
  // quick retry is exactly what heals an outage). Success clears the state.
  // In-memory: a deploy restart simply retries fresh, which is safe.
  private repairBackoff = new Map<string, { fails: number; nextAttemptAt: number }>();
  private static readonly REPAIR_BACKOFF_FREE_RETRIES = 2;
  private static readonly REPAIR_BACKOFF_MAX_MS = 60 * 60 * 1000;

  private recordRepairHardFailure(pinId: string): void {
    const fails = (this.repairBackoff.get(pinId)?.fails ?? 0) + 1;
    let nextAttemptAt = Date.now();
    if (fails > AutomationEngine.REPAIR_BACKOFF_FREE_RETRIES) {
      const delayMs = Math.min(
        AutomationEngine.REPAIR_BACKOFF_MAX_MS,
        10 * 60 * 1000 * 2 ** (fails - AutomationEngine.REPAIR_BACKOFF_FREE_RETRIES - 1)
      );
      nextAttemptAt = Date.now() + delayMs;
    }
    this.repairBackoff.set(pinId, { fails, nextAttemptAt });
  }

  async repairActivePinsWithMissingLocks(): Promise<{ repaired: number; failed: number; deferred: number; checked: number; backedOff: number }> {
    const results = { repaired: 0, failed: 0, deferred: 0, checked: 0, backedOff: 0 };

    try {
      // active + still-valid "used" pins — see getRepairablePins()
      const repairablePins = await this.storage.getRepairablePins();

      if (!this.ttlockClient) {
        return results;
      }

      // Per-run cache of common-door passcode lists for stale-coverage checks.
      const commonListCache = new Map<string, Array<{ code: string; startDate: number; endDate: number }> | null>();

      for (const pin of repairablePins) {
        if (!pin.reservationId || !pin.roomId) continue;

        const roomLockAssignments = await this.storage.getRoomLockAssignments(pin.roomId);
        const assignedLocks = roomLockAssignments
          .map(a => a.lockDevice)
          .filter((ld): ld is LockDevice & { ttlockId: string } => !!ld.ttlockId);

        if (assignedLocks.length === 0) continue;

        const roomLockKeyIds = (Array.isArray(pin.roomLockKeyIds) ? pin.roomLockKeyIds : []) as RoomLockKeyId[];
        const commonAreaKeyIds = (Array.isArray(pin.commonAreaKeyIds) ? pin.commonAreaKeyIds : []) as RoomLockKeyId[];
        // Unverified "existing" sentinels don't count as synced — those locks
        // must be re-verified/re-pushed by the repair pass. confirmedUnlisted
        // entries DO count: the lock asserted the code exists on every attempt
        // while the cloud list can't show it, so re-verifying can never succeed.
        const isSynced = (k: RoomLockKeyId) => k.keyId !== "existing" || k.confirmedUnlisted;
        const allSyncedLockIds = new Set([
          ...roomLockKeyIds.filter(isSynced).map((k: RoomLockKeyId) => k.lockDeviceId),
          ...commonAreaKeyIds.filter(isSynced).map((k: RoomLockKeyId) => k.lockDeviceId),
        ]);
        // Locks whose code is confirmed-on-lock but invisible in listKeyboardPwd —
        // the stale-coverage list check below cannot apply to these.
        const unlistedConfirmedIds = new Set(
          [...roomLockKeyIds, ...commonAreaKeyIds]
            .filter((k: RoomLockKeyId) => k.confirmedUnlisted)
            .map((k: RoomLockKeyId) => k.lockDeviceId)
        );

        const missingLocks = assignedLocks.filter(l => !allSyncedLockIds.has(l.id));

        // Stale-coverage check on common doors: a DB entry can hold a real keyId
        // yet point at a lock entry that doesn't cover the rest of the stay
        // (e.g. a short-lived manual app code with the same digits recorded as
        // ours). Verify against the lock's actual list; force a resync when it
        // falls short — the -3007 handler then replaces the stale entry.
        let staleCoverage = false;
        for (const l of assignedLocks) {
          if (l.lockType === "room" || !allSyncedLockIds.has(l.id)) continue;
          if (unlistedConfirmedIds.has(l.id)) continue;
          let list = commonListCache.get(l.ttlockId);
          if (list === undefined) {
            try {
              list = await this.ttlockClient.listPasscodes(l.ttlockId);
            } catch {
              list = null;
            }
            commonListCache.set(l.ttlockId, list);
          }
          if (!list) continue;
          const covers = list.some(p =>
            p.code === pin.code &&
            p.startDate <= Date.now() &&
            (p.endDate === 0 || p.endDate >= new Date(pin.validTo).getTime())
          );
          if (!covers) {
            staleCoverage = true;
            await this.storage.createLog({
              level: "warn",
              message: `PIN ${pin.code} on ${l.name}: lock entry missing or not covering the stay despite DB keyId — forcing resync`,
              source: "automation",
              reservationId: pin.reservationId,
              roomId: pin.roomId,
            });
          }
        }

        if (missingLocks.length === 0 && !staleCoverage) continue;

        // Chronic-failure backoff: skip pins that keep hard-failing so the lock
        // isn't kept busy — they re-enter the queue when their window expires.
        const backoff = this.repairBackoff.get(pin.id);
        if (backoff && Date.now() < backoff.nextAttemptAt) {
          results.backedOff++;
          continue;
        }

        results.checked++;

        const reservation = await this.storage.getReservation(pin.reservationId);
        if (!reservation) continue;

        const guestName = `${reservation.firstName} ${reservation.lastName}`;
        console.log(`[PinRepair] PIN ${pin.code} for ${guestName}: ${missingLocks.length} missing lock(s)${staleCoverage ? " + stale coverage" : ""}: ${missingLocks.map(l => l.name).join(", ")}`);

        try {
          const repairResult = await this.repairPasscodeForReservation(pin.reservationId, staleCoverage);
          if (repairResult.success && repairResult.synced && repairResult.synced.length > 0) {
            results.repaired++;
            this.repairBackoff.delete(pin.id);
            await this.storage.createLog({
              level: "info",
              message: `PIN auto-repair: Synced ${pin.code} to ${repairResult.synced.join(", ")} for ${guestName}`,
              source: "automation",
              reservationId: pin.reservationId,
              roomId: pin.roomId,
            });
            console.log(`[PinRepair] Success: Synced ${pin.code} to ${repairResult.synced.join(", ")}`);
          } else if ((repairResult.offline?.length ?? 0) > 0 && (repairResult.failed?.length ?? 0) === 0) {
            // Missing only because the lock(s) are offline — NOT a failure. The
            // guest already has access on every reachable lock; these are retried
            // automatically once the lock's gateway reconnects. Do not alarm,
            // do not back off (fast retry is what heals a gateway outage).
            results.deferred++;
            this.repairBackoff.delete(pin.id);
            await this.storage.createLog({
              level: "info",
              message: `PIN auto-repair deferred for ${guestName}: ${repairResult.offline!.join(", ")} offline — will retry when reconnected`,
              source: "automation",
              reservationId: pin.reservationId,
              roomId: pin.roomId,
            });
          } else {
            results.failed++;
            this.recordRepairHardFailure(pin.id);
            await this.storage.createLog({
              level: "warn",
              message: `PIN auto-repair failed for ${guestName}: ${repairResult.error || "No locks synced"}`,
              source: "automation",
              reservationId: pin.reservationId,
              roomId: pin.roomId,
            });
            console.log(`[PinRepair] Failed for ${guestName}: ${repairResult.error || "No locks synced"}`);
          }
        } catch (error) {
          results.failed++;
          this.recordRepairHardFailure(pin.id);
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[PinRepair] Error for ${guestName}: ${errorMessage}`);
        }
      }

      if (results.checked > 0) {
        console.log(`[PinRepair] Done: ${results.checked} checked, ${results.repaired} repaired, ${results.deferred} deferred (offline), ${results.failed} failed`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[PinRepair] Error: ${errorMessage}`);
    }

    return results;
  }

  /**
   * Reconcile stale PIN dates: finds all active/used PINs where the stored
   * validFrom/validTo does not match what the current reservation dates dictate,
   * and force-pushes the correct window to TTLock.
   *
   * Called from full sync to recover from silent TTLock failures.
   */
  async reconcileStalePinDates(): Promise<void> {
    try {
      const allPins = await this.storage.getAllPins();
      const stalePins = allPins.filter(p => p.status === "active" || p.status === "used");
      const now = new Date();

      for (const pin of stalePins) {
        if (!pin.reservationId) continue;
        try {
          const reservation = await this.storage.getReservation(pin.reservationId);
          if (!reservation || !reservation.roomId) continue;
          if (!reservation.generatedPin) continue;

          const expected = await this.buildPasscodeWindow(reservation);
          const pinFrom = new Date(pin.validFrom).getTime();
          const pinTo = new Date(pin.validTo).getTime();

          if (pinFrom === expected.validFrom.getTime() && pinTo === expected.validTo.getTime()) continue;

          const isCheckedIn = ["checked-in", "started"].includes((reservation.status || "").toLowerCase());
          const arrivalInFuture = expected.validFrom > now;

          if (!isCheckedIn && arrivalInFuture) {
            // Confirmed guest whose arrival moved to future — delete PIN, let scheduler re-push
            await this.storage.createLog({
              level: "info",
              message: `Reconciliation: arrival in future, deleting stale PIN for ${reservation.firstName} ${reservation.lastName}`,
              source: "automation",
              reservationId: pin.reservationId,
            });
            await this.deletePasscodeForReservation(pin.reservationId);
          } else {
            // Checked-in guest or departure-only change — update validity
            await this.storage.createLog({
              level: "info",
              message: `Reconciliation: forcing TTLock validity update for ${reservation.firstName} ${reservation.lastName}`,
              source: "automation",
              reservationId: pin.reservationId,
            });
            await this.updatePinValidity(pin.reservationId, { force: true });
          }
        } catch (err) {
          await this.storage.createLog({
            level: "warn",
            message: `Reconciliation error for pin ${pin.id}: ${err}`,
            source: "automation",
          });
        }
      }
    } catch (err) {
      await this.storage.createLog({
        level: "warn",
        message: `reconcileStalePinDates failed: ${err}`,
        source: "automation",
      });
    }
  }

  async deletePasscodeForReservation(reservationId: string, overrideRoomId?: string, opts?: { force?: boolean }): Promise<boolean | "blocked"> {
    try {
      const reservation = await this.storage.getReservation(reservationId);
      if (!reservation) {
        return false;
      }

      const targetRoomId = overrideRoomId || reservation.roomId;
      if (!targetRoomId) {
        return false;
      }

      const room = await this.storage.getRoom(targetRoomId);
      if (!room) {
        return false;
      }

      const pins = await this.storage.getPinsByRoomId(room.id);
      // Include "used" PINs — they are still live in TTLock and must be revoked on checkout/cancel
      const activePins = pins.filter(p => p.reservationId === reservationId && (p.status === "active" || p.status === "used"));

      if (activePins.length === 0 && !this.ttlockClient) {
        return false;
      }

      // IN-HOUSE GUARD (Martinsen 16-17/7, natten 22/7): a cancellation must
      // never silently pull the codes of a guest who is demonstrably INSIDE
      // their stay — MEWS' ~06:00 no-show audit cancels un-checked-in
      // reservations while the guest sleeps (their check-in was e.g. rejected
      // over an occupied space). Used code + open window + not checked out in
      // MEWS → keep the codes, alert the operator, let a human decide. Normal
      // checkouts (Checked-out/Processed) pass through untouched.
      const resStatus = (reservation.status || "").toLowerCase();
      const isCheckedOut = resStatus === "checked-out" || resStatus === "processed";
      const guestInside = activePins.some(
        p => p.firstUsedAt && p.validTo && new Date(p.validTo).getTime() > Date.now()
      );
      if (!opts?.force && !isCheckedOut && guestInside) {
        await this.storage.createLog({
          level: "error",
          message: `Cancellation revoke BLOCKED for ${reservation.firstName} ${reservation.lastName}: code used and stay window still open — codes kept on the locks. Re-confirm in MEWS if the cancellation was wrong, or remove the code manually.`,
          source: "automation",
          reservationId: reservation.id,
        });
        await sendOpsAlert(
          this.storage,
          `cancel-inhouse:${reservation.id}`,
          "critical",
          `Annullering af gæst der er INDE — koder IKKE fjernet (${reservation.firstName ?? ""} ${reservation.lastName ?? ""})`.trim(),
          `Reservationen blev annulleret (fx MEWS' natlige no-show-kørsel), men gæstens kode er brugt og opholdsvinduet er stadig åbent. Koderne er bevidst IKKE fjernet, så gæsten ikke låses ude. Gør ét af to i MEWS: genbekræft/tjek gæsten ind, eller fjern koden manuelt hvis gæsten reelt skal ud.`
        );
        return "blocked";
      }

      let deletedAny = false;
      let anyFailed = false;

      for (const pin of activePins) {
        if (!this.ttlockClient) continue;
        
        let roomLocksDeleteSuccess = true;
        let commonDoorDeletesSuccess = true;
        
        const rawRoomLockKeyIds = (pin.roomLockKeyIds as any);
        const hasRoomLockKeyIds = rawRoomLockKeyIds && Array.isArray(rawRoomLockKeyIds) && rawRoomLockKeyIds.length > 0;
        
        if (hasRoomLockKeyIds) {
          const deletePromises = rawRoomLockKeyIds.map(async (entry: RoomLockKeyId) => {
            if (!entry.ttlockId || !entry.keyId) return { success: false, error: "Missing data" };
            let keyId = entry.keyId;
            // Resolve "existing" sentinel to the real keyId before deleting
            if (keyId === "existing" && this.ttlockClient) {
              try {
                const passcodes = await this.ttlockClient.listPasscodes(entry.ttlockId);
                const match = passcodes.find(p => p.code === pin.code);
                if (match) keyId = match.id.toString();
              } catch {
                // Can't look up - will fail on delete, log below
              }
            }
            try {
              await this.ttlockClient!.deletePasscode(entry.ttlockId, parseInt(keyId));
              return { success: true, lockName: entry.lockName };
            } catch (error) {
              return { success: false, lockName: entry.lockName, error: error instanceof Error ? error.message : String(error) };
            }
          });

          const results = await Promise.all(deletePromises);
          const failures = results.filter(r => !r.success);
          const successes = results.filter(r => r.success);
          
          if (failures.length > 0) {
            roomLocksDeleteSuccess = false;
            anyFailed = true;
            for (const f of failures) {
              await this.storage.createLog({
                level: "error",
                message: `Failed to delete passcode from ${f.lockName}: ${f.error}`,
                source: "automation",
                reservationId,
                roomId: room.id,
              });
            }
          }
          
          if (successes.length > 0) {
            await this.storage.createReservationLog({
              reservationId,
              message: `Passcode deleted from ${successes.length} room lock(s)`,
              type: "passcode_deleted",
              detail: `Passcode ${pin.code} deleted from ${successes.map(s => s.lockName).join(", ")}`,
            });
            
            await this.storage.createLog({
              level: "info",
              message: `Passcode deleted from ${successes.length} room lock(s) for reservation ${reservation.pmsId}`,
              source: "automation",
              reservationId,
              roomId: room.id,
            });
          }
        }

        // Also delete from common area locks (assigned to room but not room-type)
        const rawCommonAreaKeyIds = (pin.commonAreaKeyIds as any);
        const hasCommonAreaKeyIds = rawCommonAreaKeyIds && Array.isArray(rawCommonAreaKeyIds) && rawCommonAreaKeyIds.length > 0;
        
        if (hasCommonAreaKeyIds) {
          const commonDeletePromises = rawCommonAreaKeyIds.map(async (entry: RoomLockKeyId) => {
            if (!entry.ttlockId || !entry.keyId) return { success: false, error: "Missing data" };
            try {
              await this.ttlockClient!.deletePasscode(entry.ttlockId, parseInt(entry.keyId));
              return { success: true, lockName: entry.lockName };
            } catch (error) {
              return { success: false, lockName: entry.lockName, error: error instanceof Error ? error.message : String(error) };
            }
          });
          
          const commonResults = await Promise.all(commonDeletePromises);
          const commonFailures = commonResults.filter(r => !r.success);
          const commonSuccesses = commonResults.filter(r => r.success);
          
          if (commonFailures.length > 0) {
            commonDoorDeletesSuccess = false;
            anyFailed = true;
            for (const f of commonFailures) {
              await this.storage.createLog({
                level: "error",
                message: `Failed to delete passcode from common lock ${f.lockName}: ${f.error}`,
                source: "automation",
                reservationId,
                roomId: room.id,
              });
            }
          }
          
          if (commonSuccesses.length > 0) {
            await this.storage.createLog({
              level: "info",
              message: `Passcode deleted from ${commonSuccesses.length} common lock(s) for reservation ${reservation.pmsId}`,
              source: "automation",
              reservationId,
              roomId: room.id,
            });
          }
        }

        if (!hasRoomLockKeyIds && (pin.ttlockKeyId || pin.roomLockKeyIds)) {
          // Only mark as failed if we have key IDs but couldn't process them
          // (hasRoomLockKeyIds being true means we already attempted deletion above)
          roomLocksDeleteSuccess = false;
          anyFailed = true;
          await this.storage.createLog({
            level: "error",
            message: `Pin has lock key IDs but cannot resolve lock(s) to delete - marking deletion as failed`,
            source: "automation",
            reservationId,
            roomId: room.id,
            metadata: { 
              pinId: pin.id,
              hasRoomLockKeyIds: !!pin.roomLockKeyIds,
              hasTtlockKeyId: !!pin.ttlockKeyId
            },
          });
        }

        // Delete QR codes if any exist
        const rawQrCodeData = (pin.qrCodeData as any);
        const hasQrCodeData = rawQrCodeData && Array.isArray(rawQrCodeData) && rawQrCodeData.length > 0;
        
        if (hasQrCodeData && this.ttlockClient) {
          interface QrCodeEntry {
            lockDeviceId: string;
            ttlockId: string;
            qrCodeId: number;
            qrCodeData: string;
            lockName: string;
          }
          
          const qrDeletePromises = rawQrCodeData.map(async (entry: QrCodeEntry) => {
            if (!entry.ttlockId || !entry.qrCodeId) return { success: false, error: "Missing data" };
            try {
              await this.ttlockClient!.deleteQrCode(entry.ttlockId, entry.qrCodeId);
              return { success: true, lockName: entry.lockName };
            } catch (error) {
              return { success: false, lockName: entry.lockName, error: error instanceof Error ? error.message : String(error) };
            }
          });
          
          const qrResults = await Promise.all(qrDeletePromises);
          const qrSuccesses = qrResults.filter(r => r.success);
          const qrFailures = qrResults.filter(r => !r.success);
          
          if (qrSuccesses.length > 0) {
            await this.storage.createLog({
              level: "info",
              message: `QR codes deleted from ${qrSuccesses.length} lock(s)`,
              source: "automation",
              reservationId,
              roomId: room.id,
            });
          }
          
          if (qrFailures.length > 0) {
            for (const f of qrFailures) {
              await this.storage.createLog({
                level: "warn",
                message: `Failed to delete QR code from ${f.lockName}: ${f.error}`,
                source: "automation",
                reservationId,
                roomId: room.id,
              });
            }
          }
        }
        
        if (roomLocksDeleteSuccess && commonDoorDeletesSuccess) {
          // Official terminal status (matches pin-lifecycle deleteFromTTLock).
          // The ad-hoc "deleted" status is forbidden — see pins schema note.
          await this.storage.updatePin(pin.id, { status: "cancelled" });
          deletedAny = true;
        } else {
          anyFailed = true;
          await this.storage.createLog({
            level: "warn",
            message: `Not marking pin as deleted - some deletions failed`,
            source: "automation",
            reservationId,
            roomId: room.id,
            metadata: { pinId: pin.id, roomLocksOk: roomLocksDeleteSuccess, commonLocksOk: commonDoorDeletesSuccess },
          });
        }
      }

      if (anyFailed) {
        await this.storage.createLog({
          level: "warn",
          message: `Some TTLock deletions failed - PIN code retained on reservation for retry`,
          source: "automation",
          reservationId,
          roomId: room.id,
        });
      }
      // generatedPin is intentionally NOT cleared: it serves as memory of which code
      // belongs to this reservation so the same PIN is reused if a new one is needed.

      return deletedAny && !anyFailed;
    } catch (error) {
      return false;
    }
  }

  // NOTE: syncPasscodesFromTTLock was deleted in the post-21/7 hardening.
  // It was dormant (no runtime callers), yet contained the same
  // missing-key -> mark-deleted pattern as the old orphan cleanup WITHOUT the
  // failedLockIds guard - a latent mass-deletion one accidental call away.
  // Import of unknown TTLock passcodes is not a safety feature; recreate it
  // deliberately if ever needed, honoring the verify-before-destroy rules below.

  // Orphan handling was redesigned after the 21/7 incident where a gateway flap
  // made TTLock answer "errcode 0, empty passcode list" for online locks and the
  // old implementation mass-marked every active pin on those locks as "deleted" —
  // a status invisible to every repair/drift/audit mechanism, so guests were
  // permanently locked out until manual intervention.
  //
  // Fail-safe rules now enforced (verify-before-destroy):
  //  1. Soft-empty guard: an empty list from a lock where we EXPECT >= 1 key is
  //     treated as an unverifiable read (like a thrown error), never as proof of
  //     deletion.
  //  2. A pin whose reservation is still live (anything but Cancelled/Checked-out)
  //     and whose validity window is open is NEVER archived — a missing key
  //     triggers a re-push via repairPasscodeForReservation instead. This also
  //     removes the race where this job and the 5-min repair job saw the same
  //     state ("key missing") and took opposite actions.
  //  3. Terminal/expired pins are archived to the official soft status
  //     "cancelled" (never the ad-hoc "deleted") and only after
  //     ORPHAN_MIN_OBSERVATIONS consecutive hourly sightings spanning
  //     ORPHAN_MIN_OBSERVATION_WINDOW_MS on verified-online locks.
  //  4. Circuit breaker: if the run would archive more than max(3, 10% of
  //     active pins), abort the whole run and log an error — a systemic signal
  //     (API regression, cloud outage) must never translate into mass archival.
  private static readonly ORPHAN_MIN_OBSERVATIONS = 3;
  private static readonly ORPHAN_MIN_OBSERVATION_WINDOW_MS = 2 * 60 * 60 * 1000;

  // Offline-episode tracking (per lock, in settings): `lock_offline_first:{id}`
  // marks when the CURRENT outage episode began, `lock_offline_last:{id}` when
  // it was last observed. A gap of > 15 min between observations starts a new
  // episode. Consumers (the arrival report's gateway-down escalation) require
  // the last observation to be FRESH, so stale state self-invalidates after
  // recovery — no explicit clearing needed.
  static readonly OFFLINE_EPISODE_GAP_MS = 15 * 60 * 1000;

  async trackLockOfflineEpisode(ttlockId: string): Promise<void> {
    try {
      const now = Date.now();
      const lastRaw = (await this.storage.getSetting(`lock_offline_last:${ttlockId}`))?.value;
      const firstRaw = (await this.storage.getSetting(`lock_offline_first:${ttlockId}`))?.value;
      const last = lastRaw ? Date.parse(lastRaw) : NaN;
      // Episode gap must exceed the observation cadence (the repair interval),
      // otherwise a slow-configured repair makes every sighting a "new
      // episode" and the >30 min URGENT escalation can never trigger.
      const intervalRaw = (await this.storage.getSetting("pin_repair_interval_minutes"))?.value;
      const intervalMs = Math.max(1, parseInt(intervalRaw || "", 10) || 5) * 60 * 1000;
      const gapMs = Math.max(AutomationEngine.OFFLINE_EPISODE_GAP_MS, 3 * intervalMs);
      const isNewEpisode = !Number.isFinite(last) || now - last > gapMs;
      if (isNewEpisode || !firstRaw) {
        await this.storage.setSetting(`lock_offline_first:${ttlockId}`, new Date(now).toISOString());
      }
      await this.storage.setSetting(`lock_offline_last:${ttlockId}`, new Date(now).toISOString());
    } catch {
      // Tracking must never break the repair job.
    }
  }

  async cleanupOrphanedPasscodes(): Promise<{ deleted: number; checked: number; repaired: number; aborted: boolean }> {
    if (!this.ttlockClient) {
      return { deleted: 0, checked: 0, repaired: 0, aborted: false };
    }

    try {
      const allPins = await this.storage.getAllPins();
      const activePins = allPins.filter(p => p.status === "active");
      const allRooms = await this.storage.getAllRooms();
      const allCommonAreas = await this.storage.getAllCommonAreas();
      const allLockDevices = await this.storage.getAllLockDevices();

      const ttlockIdToPasscodes = new Map<string, Set<string>>();
      const failedLockIds = new Set<string>();

      for (const lock of allLockDevices) {
        if (!lock.ttlockId) continue;
        try {
          const passcodes = await this.ttlockClient.listPasscodes(lock.ttlockId);
          ttlockIdToPasscodes.set(lock.ttlockId, new Set(passcodes.map(p => p.id.toString())));
        } catch (error) {
          failedLockIds.add(lock.ttlockId);
          await this.storage.createLog({
            level: "warn",
            message: `Failed to fetch passcodes from lock ${lock.name} for orphan cleanup - skipping this lock`,
            source: "automation",
            metadata: { lockId: lock.ttlockId, error: String(error) },
          });
        }
      }

      // Normalize a pin's key entries to {ttlockId, keyId, label}. Room entries
      // are always the modern {lockDeviceId, ttlockId, keyId, lockName} shape;
      // common entries may also be the legacy {commonAreaId, keyId} shape from
      // before common doors moved to room_lock_assignments — resolve those via
      // the common_areas table so they are checked instead of silently skipped.
      const parseEntries = (raw: unknown): any[] => {
        let value = raw as any;
        if (typeof value === "string") {
          try { value = JSON.parse(value); } catch { value = []; }
        }
        return Array.isArray(value) ? value : [];
      };
      const normalizeEntries = (pin: { roomLockKeyIds: unknown; commonAreaKeyIds: unknown }) => {
        const entries: Array<{ ttlockId: string; keyId: string; label: string }> = [];
        for (const entry of parseEntries(pin.roomLockKeyIds)) {
          if (!entry?.ttlockId || !entry?.keyId) continue;
          entries.push({ ttlockId: entry.ttlockId, keyId: entry.keyId, label: `room:${entry.lockName || "unknown"}` });
        }
        for (const entry of parseEntries(pin.commonAreaKeyIds)) {
          if (!entry?.keyId) continue;
          let ttlockId: string | undefined = entry.ttlockId;
          let label = `common:${entry.lockName || "unknown"}`;
          if (!ttlockId && entry.commonAreaId) {
            const commonArea = allCommonAreas.find(ca => ca.id === entry.commonAreaId);
            ttlockId = commonArea?.ttlockId || undefined;
            label = `common:${commonArea?.name || "unknown"}`;
          }
          if (!ttlockId) continue;
          entries.push({ ttlockId, keyId: entry.keyId, label });
        }
        return entries;
      };

      // Soft-empty guard: a lock that answered successfully with an EMPTY list
      // while at least one active pin expects a real key on it is indistinguishable
      // from a gateway flap / stale cloud read. Treat it exactly like a failed
      // fetch — never as evidence that codes were removed.
      const expectedKeyCounts = new Map<string, number>();
      for (const pin of activePins) {
        for (const entry of normalizeEntries(pin)) {
          if (entry.keyId === "existing") continue;
          expectedKeyCounts.set(entry.ttlockId, (expectedKeyCounts.get(entry.ttlockId) || 0) + 1);
        }
      }
      for (const [ttlockId, passcodes] of Array.from(ttlockIdToPasscodes.entries())) {
        if (passcodes.size === 0 && (expectedKeyCounts.get(ttlockId) || 0) > 0) {
          failedLockIds.add(ttlockId);
          const lock = allLockDevices.find(l => l.ttlockId === ttlockId);
          await this.storage.createLog({
            level: "warn",
            message: `Orphan cleanup: lock ${lock?.name || ttlockId} returned an empty passcode list but ${expectedKeyCounts.get(ttlockId)} key(s) are expected — treating as transient (gateway flap?), skipping this lock`,
            source: "automation",
            metadata: { lockId: ttlockId, expectedKeys: expectedKeyCounts.get(ttlockId) },
          });
        }
      }

      let archivedCount = 0;
      let checkedCount = 0;
      let repairedCount = 0;
      const now = Date.now();
      const archiveCandidates: Array<{ pin: typeof activePins[number]; roomId: string; missingKeys: string[]; observations: { count: number; firstSeenAt: string; lastSeenAt: string } }> = [];

      for (const pin of activePins) {
        const room = allRooms.find(r => r.id === pin.roomId);
        if (!room) continue;

        const entries = normalizeEntries(pin).filter(e =>
          // "existing" is a sentinel meaning the passcode was confirmed on the
          // lock but we lack the keyId — it must never trigger orphan handling.
          e.keyId !== "existing" && !failedLockIds.has(e.ttlockId)
        );

        const checkable = entries.filter(e => ttlockIdToPasscodes.has(e.ttlockId));
        if (checkable.length === 0) continue;

        checkedCount++;

        const missingKeys = checkable
          .filter(e => !ttlockIdToPasscodes.get(e.ttlockId)!.has(e.keyId))
          .map(e => `${e.label}:${e.keyId}`);

        if (missingKeys.length === 0) {
          // Healthy again — clear any accumulated orphan observations so a later
          // genuine signal starts counting from scratch.
          if ((pin as any).orphanObservations) {
            await this.storage.updatePin(pin.id, { orphanObservations: null } as any);
          }
          continue;
        }

        const reservation = pin.reservationId ? await this.storage.getReservation(pin.reservationId) : null;
        const reservationStatus = (reservation?.status || "").toLowerCase();
        const isTerminalReservation = reservationStatus === "cancelled" || reservationStatus === "checked-out";
        const windowExpired = new Date(pin.validTo).getTime() <= now;

        if (reservation && !isTerminalReservation && !windowExpired) {
          // Live guest (Confirmed/Checked-in/no-show/...) inside their validity
          // window: NEVER archive. Re-push the code instead — same action the
          // 5-minute repair job would take, just without waiting for its tick.
          //
          // The missing entries are provably stale (the key is absent from a
          // verified-online lock), so strip them from the pin first — otherwise
          // a non-force repair would see the entry and skip the lock forever.
          repairedCount++;
          await this.storage.createLog({
            level: "warn",
            message: `Orphan signal on active pin ${pin.code} (${missingKeys.join(", ")}) — re-pushing instead of deleting`,
            source: "automation",
            reservationId: pin.reservationId || undefined,
            roomId: room.id,
            metadata: { pinId: pin.id, missingKeys: missingKeys.join(", ") },
          });
          try {
            const missingSet = new Set(
              checkable
                .filter(e => !ttlockIdToPasscodes.get(e.ttlockId)!.has(e.keyId))
                .map(e => `${e.ttlockId}:${e.keyId}`)
            );
            const resolveTtlockId = (entry: any): string | undefined =>
              entry?.ttlockId || allCommonAreas.find(ca => ca.id === entry?.commonAreaId)?.ttlockId || undefined;
            const keepEntry = (entry: any) => {
              const ttlockId = resolveTtlockId(entry);
              return !(ttlockId && entry?.keyId && missingSet.has(`${ttlockId}:${entry.keyId}`));
            };
            await this.storage.updatePin(pin.id, {
              roomLockKeyIds: parseEntries(pin.roomLockKeyIds).filter(keepEntry),
              commonAreaKeyIds: parseEntries(pin.commonAreaKeyIds).filter(keepEntry),
            } as any);
            await this.repairPasscodeForReservation(pin.reservationId!);
          } catch (error) {
            await this.storage.createLog({
              level: "error",
              message: `Orphan re-push failed for pin ${pin.code}: ${error instanceof Error ? error.message : String(error)}`,
              source: "automation",
              reservationId: pin.reservationId || undefined,
              roomId: room.id,
            });
          }
          continue;
        }

        if (!pin.reservationId) {
          // Manual/imported pins have no reservation to repair against. Leave
          // them untouched — the nightly expired-passcode cleanup owns their
          // physical removal once they expire.
          continue;
        }

        // Terminal or expired: archive only after repeated, time-separated
        // observations on verified-online locks.
        const prev = (pin as any).orphanObservations as { count?: number; firstSeenAt?: string; lastSeenAt?: string } | null;
        const observations = {
          count: (prev?.count || 0) + 1,
          firstSeenAt: prev?.firstSeenAt || new Date(now).toISOString(),
          lastSeenAt: new Date(now).toISOString(),
        };
        const windowMs = now - new Date(observations.firstSeenAt).getTime();
        if (
          observations.count >= AutomationEngine.ORPHAN_MIN_OBSERVATIONS &&
          windowMs >= AutomationEngine.ORPHAN_MIN_OBSERVATION_WINDOW_MS
        ) {
          archiveCandidates.push({ pin, roomId: room.id, missingKeys, observations });
        } else {
          await this.storage.updatePin(pin.id, { orphanObservations: observations } as any);
        }
      }

      // Circuit breaker: mass archival is always a systemic signal, never a
      // legitimate outcome of one hourly run.
      const archiveLimit = Math.max(3, Math.ceil(activePins.length * 0.10));
      if (archiveCandidates.length > archiveLimit) {
        await this.storage.createLog({
          level: "error",
          message: `Orphan cleanup ABORTED: ${archiveCandidates.length} archive candidates exceeds safety limit ${archiveLimit} (${activePins.length} active pins). Suspected systemic issue (gateway/API) — no pins were touched.`,
          source: "automation",
          metadata: { candidates: archiveCandidates.length, limit: archiveLimit, activePins: activePins.length },
        });
        await sendOpsAlert(
          this.storage as any,
          "orphan-cleanup-breaker",
          "critical",
          `Orphan-oprydning AFBRUDT: ${archiveCandidates.length} koder ville være blevet arkiveret (grænse: ${archiveLimit})`,
          `Systemisk problem mistænkt (gateway/API-udfald). Ingen koder blev rørt. Tjek TTLock-gateways og lås-forbindelse.`
        );
        return { deleted: 0, checked: checkedCount, repaired: repairedCount, aborted: true };
      }

      for (const candidate of archiveCandidates) {
        await this.storage.updatePin(candidate.pin.id, { status: "cancelled", orphanObservations: null } as any);
        // generatedPin is PERMANENT — never cleared
        archivedCount++;
        await this.storage.createLog({
          level: "info",
          message: `Orphaned passcode ${candidate.pin.code} archived as cancelled (terminal/expired reservation; missing from TTLock across ${candidate.observations.count} runs since ${candidate.observations.firstSeenAt})`,
          source: "automation",
          reservationId: candidate.pin.reservationId || undefined,
          roomId: candidate.roomId,
          metadata: { pinId: candidate.pin.id, missingKeys: candidate.missingKeys.join(", ") },
        });
      }

      if (archivedCount > 0 || repairedCount > 0) {
        await this.storage.createLog({
          level: "info",
          message: `Orphan cleanup completed: ${checkedCount} pins checked, ${repairedCount} re-pushed, ${archivedCount} terminal orphans archived`,
          source: "automation",
        });
      }

      return { deleted: archivedCount, checked: checkedCount, repaired: repairedCount, aborted: false };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.storage.createLog({
        level: "error",
        message: `Orphan cleanup failed: ${errorMessage}`,
        source: "automation",
        metadata: { error: errorMessage },
      });
      return { deleted: 0, checked: 0, repaired: 0, aborted: false };
    }
  }

  /**
   * One-shot recovery of pins the old orphan cleanup wrongly marked "deleted"
   * (a status outside the official set, invisible to repair/drift/audit).
   * Deliberately NOT scheduled: after the orphan redesign no new "deleted"
   * markings can occur, so a recurring sweeper would only mask regressions.
   *
   * A pin is recovered only when ALL of:
   *  - status === "deleted" and validTo > now (still worth having on the doors)
   *  - its reservation exists and is neither Cancelled nor Checked-out
   *  - the reservation has no OTHER active/used pin (avoid duplicate codes)
   * Capped per run to bound the blast radius; run again for the remainder.
   */
  async recoverWronglyDeletedPins(dryRun: boolean): Promise<{
    recovered: number; skipped: number; remaining: number; dryRun: boolean;
    candidates: Array<{ pinId: string; code: string; reservationId: string | null; reason: string }>;
  }> {
    const RECOVERY_CAP = 50;
    const candidates: Array<{ pinId: string; code: string; reservationId: string | null; reason: string }> = [];
    let recovered = 0;
    let skipped = 0;

    const deletedPins = await this.storage.getDeletedPinsWithinValidity();

    for (const pin of deletedPins) {
      if (!pin.reservationId) {
        skipped++;
        candidates.push({ pinId: pin.id, code: pin.code, reservationId: null, reason: "skip: no reservation" });
        continue;
      }
      const reservation = await this.storage.getReservation(pin.reservationId);
      const status = (reservation?.status || "").toLowerCase();
      if (!reservation || status === "cancelled" || status === "checked-out") {
        skipped++;
        candidates.push({ pinId: pin.id, code: pin.code, reservationId: pin.reservationId, reason: `skip: reservation ${status || "missing"}` });
        continue;
      }
      const siblingPins = await this.storage.getPinsByReservationId(pin.reservationId);
      if (siblingPins.some(p => p.id !== pin.id && (p.status === "active" || p.status === "used"))) {
        skipped++;
        candidates.push({ pinId: pin.id, code: pin.code, reservationId: pin.reservationId, reason: "skip: reservation already has a live pin" });
        continue;
      }
      if (recovered >= RECOVERY_CAP) {
        candidates.push({ pinId: pin.id, code: pin.code, reservationId: pin.reservationId, reason: "deferred: per-run cap reached" });
        continue;
      }

      candidates.push({ pinId: pin.id, code: pin.code, reservationId: pin.reservationId, reason: "recover" });
      if (dryRun) {
        recovered++;
        continue;
      }

      // Reactivate first (keyIds are kept — the code may still sit on some
      // locks), then force-resync so every assigned lock gets verified/pushed.
      await this.storage.updatePin(pin.id, { status: "active" });
      recovered++;
      await this.storage.createLog({
        level: "info",
        message: `Recovered wrongly-deleted pin ${pin.code} — reactivated and queued for force repair`,
        source: "automation",
        reservationId: pin.reservationId,
        roomId: pin.roomId,
        metadata: { pinId: pin.id },
      });
      try {
        await this.repairPasscodeForReservation(pin.reservationId, true);
      } catch (error) {
        await this.storage.createLog({
          level: "error",
          message: `Recovery repair failed for pin ${pin.code}: ${error instanceof Error ? error.message : String(error)} — 5-min repair job will retry`,
          source: "automation",
          reservationId: pin.reservationId,
          roomId: pin.roomId,
        });
      }
    }

    const remaining = deletedPins.length - recovered - skipped;
    await this.storage.createLog({
      level: "info",
      message: `Deleted-pin recovery ${dryRun ? "(dry-run) " : ""}completed: ${recovered} recovered, ${skipped} skipped, ${Math.max(0, remaining)} deferred`,
      source: "automation",
    });

    return { recovered, skipped, remaining: Math.max(0, remaining), dryRun, candidates };
  }

  async cleanupExpiredPasscodes(): Promise<{ deleted: number; skipped: number }> {
    if (!this.ttlockClient) {
      await this.storage.createLog({
        level: "warn",
        message: "Expired passcode cleanup skipped - TTLock client not initialized",
        source: "automation",
      });
      return { deleted: 0, skipped: 0 };
    }

    try {
      const now = new Date();
      const allPins = await this.storage.getAllPins();
      const activePins = allPins.filter(p => p.status === "active");

      let deletedCount = 0;
      let skippedCount = 0;

      for (const pin of activePins) {
        const validTo = new Date(pin.validTo);
        
        if (validTo > now) {
          continue;
        }

        if (pin.reservationId) {
          const reservation = await this.storage.getReservation(pin.reservationId);

          // Paid late checkout / any window extension: the DB pin.validTo can be
          // stale (e.g. the extension push failed and reconcile hasn't converged
          // yet). Recompute the EFFECTIVE window before deleting — wiping a
          // paying guest's code at 11:00 is the single worst failure mode here.
          if (reservation) {
            const effective = await this.buildPasscodeWindow(reservation);
            if (effective.validTo > now) {
              skippedCount++;
              continue;
            }
          }

          if (reservation && reservation.status === "Confirmed") {
            const arrival = new Date(reservation.arrival);

            if (arrival > now) {
              skippedCount++;
              await this.storage.createLog({
                level: "info",
                message: `Skipping expired passcode cleanup for future Confirmed reservation ${reservation.pmsId}`,
                source: "automation",
                reservationId: reservation.id,
                metadata: {
                  passcode: pin.code,
                  arrival: arrival.toISOString(),
                  validFrom: new Date(pin.validFrom).toISOString(),
                  validTo: validTo.toISOString(),
                  reason: "Future confirmed reservation - passcode will activate at validFrom",
                },
              });
              continue;
            }
          }
        }

        const room = await this.storage.getRoom(pin.roomId);
        if (!room) {
          continue;
        }

        let primaryDeleteSuccess = false;
        let commonDoorDeletesSuccess = true;

        // Delete via stored roomLockKeyIds (new model)
        const rawRoomLockKeyIds = pin.roomLockKeyIds as any[];
        if (Array.isArray(rawRoomLockKeyIds) && rawRoomLockKeyIds.length > 0) {
          let allSucceeded = true;
          for (const entry of rawRoomLockKeyIds) {
            if (!entry.ttlockId || !entry.keyId || entry.keyId === "existing") continue;
            try {
              await this.ttlockClient.deletePasscode(entry.ttlockId, parseInt(entry.keyId));
            } catch (error) {
              allSucceeded = false;
              await this.storage.createLog({
                level: "error",
                message: `Failed to delete expired passcode from ${entry.lockName}: ${error instanceof Error ? error.message : String(error)}`,
                source: "automation",
                reservationId: pin.reservationId || undefined,
                roomId: room.id,
              });
            }
          }
          primaryDeleteSuccess = allSucceeded;
        }

        const rawCommonAreaKeyIds = (pin.commonAreaKeyIds as any);
        const hasCommonAreaKeys = rawCommonAreaKeyIds && Array.isArray(rawCommonAreaKeyIds) && rawCommonAreaKeyIds.length > 0;

        if (hasCommonAreaKeys) {
          for (const areaKey of rawCommonAreaKeyIds as Array<{commonAreaId: string, keyId: string}>) {
            const commonArea = await this.storage.getCommonArea(areaKey.commonAreaId);
            if (commonArea?.ttlockId) {
              try {
                await this.ttlockClient.deletePasscode(commonArea.ttlockId, parseInt(areaKey.keyId));
                await this.storage.createLog({
                  level: "info",
                  message: `Expired passcode deleted from common area ${commonArea.name}`,
                  source: "automation",
                  reservationId: pin.reservationId || undefined,
                  metadata: {
                    passcode: pin.code,
                    validTo: validTo.toISOString(),
                    triggeredBy: "cleanup-expired",
                  },
                });
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                commonDoorDeletesSuccess = false;
                await this.storage.createLog({
                  level: "error",
                  message: `Failed to delete expired passcode from common area ${commonArea.name}: ${errorMessage}`,
                  source: "automation",
                  reservationId: pin.reservationId || undefined,
                  metadata: { error: errorMessage, commonAreaId: commonArea.id },
                });
              }
            }
          }
        }

        if (primaryDeleteSuccess || commonDoorDeletesSuccess) {
          // Official terminal status — the ad-hoc "deleted" is forbidden
          // (invisible to every repair scope; see pins schema note).
          await this.storage.updatePin(pin.id, { status: "cancelled" });
          // generatedPin is PERMANENT — never cleared
          deletedCount++;
        }
      }

      if (deletedCount > 0 || skippedCount > 0) {
        await this.storage.createLog({
          level: "info",
          message: `Expired passcode cleanup completed: ${deletedCount} deleted, ${skippedCount} skipped (future confirmed)`,
          source: "automation",
        });
      }

      return { deleted: deletedCount, skipped: skippedCount };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.storage.createLog({
        level: "error",
        message: `Expired passcode cleanup failed: ${errorMessage}`,
        source: "automation",
        metadata: { error: errorMessage },
      });
      return { deleted: 0, skipped: 0 };
    }
  }

  /**
   * TTLock-native nightly cleanup.
   * Lists all passcodes directly from every configured lock (room + common area)
   * and deletes any that have an endDate in the past — regardless of DB state.
   *
   * Robustness:
   *  - Global in-progress guard prevents overlapping runs (scheduled + ad-hoc)
   *  - Retry with exponential backoff (2s → 5s → 10s) on -3037 "gateway busy"
   *  - 2 s inter-lock pause + 500 ms intra-lock pause
   */
  private _cleanupInProgress = false;

  private async _deletePasscodeWithRetry(ttlockId: string, passcodeId: number, passcodeCode: string): Promise<void> {
    const retryDelays = [2000, 5000, 10000];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        await this.ttlockClient!.deletePasscode(ttlockId, passcodeId);
        return;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const isGatewayBusy = msg.includes("-3037") || msg.toLowerCase().includes("busy");
        if (isGatewayBusy && attempt < retryDelays.length) {
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  async cleanupExpiredPasscodesFromTTLock(): Promise<{ deleted: number; errors: number; locks: number }> {
    if (!this.ttlockClient) {
      await this.storage.createLog({
        level: "warn",
        message: "TTLock-native cleanup skipped — TTLock client not initialized",
        source: "automation",
      });
      return { deleted: 0, errors: 0, locks: 0 };
    }

    if (this._cleanupInProgress) {
      await this.storage.createLog({
        level: "warn",
        message: "TTLock-native cleanup skipped — previous run still in progress",
        source: "automation",
      });
      return { deleted: 0, errors: 0, locks: 0 };
    }

    this._cleanupInProgress = true;
    const now = Date.now();
    let deletedTotal = 0;
    let errorTotal = 0;
    let locksScanned = 0;

    try {
      // Collect all TTLock IDs: room locks + common area locks
      const [allDevices, allCommonAreas] = await Promise.all([
        this.storage.getAllLockDevices(),
        this.storage.getAllCommonAreas(),
      ]);

      const ttlockIds = new Set<string>();
      for (const d of allDevices) {
        if (d.ttlockId) ttlockIds.add(d.ttlockId);
      }
      for (const ca of allCommonAreas) {
        if (ca.ttlockId) ttlockIds.add(ca.ttlockId);
      }

      for (const ttlockId of Array.from(ttlockIds)) {
        locksScanned++;
        try {
          const passcodes = await this.ttlockClient.listPasscodes(ttlockId);
          const expired = passcodes.filter(p => p.endDate > 0 && p.endDate < now);

          for (const p of expired) {
            try {
              await this._deletePasscodeWithRetry(ttlockId, p.id, p.code);
              deletedTotal++;
              // 500 ms between passcodes within same lock
              await new Promise(resolve => setTimeout(resolve, 500));
            } catch (err) {
              errorTotal++;
              await this.storage.createLog({
                level: "warn",
                message: `TTLock cleanup: failed to delete passcode ${p.id} (${p.code}) from lock ${ttlockId}: ${err instanceof Error ? err.message : String(err)}`,
                source: "automation",
              });
            }
          }
        } catch (err) {
          errorTotal++;
          await this.storage.createLog({
            level: "warn",
            message: `TTLock cleanup: failed to list passcodes for lock ${ttlockId}: ${err instanceof Error ? err.message : String(err)}`,
            source: "automation",
          });
        }

        // 2 s between locks — gives gateway time to recover
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      await this.storage.createLog({
        level: "info",
        message: `TTLock-native cleanup: ${deletedTotal} expired passcodes deleted across ${locksScanned} locks${errorTotal > 0 ? `, ${errorTotal} errors` : ""}`,
        source: "automation",
      });

      return { deleted: deletedTotal, errors: errorTotal, locks: locksScanned };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.storage.createLog({
        level: "error",
        message: `TTLock-native cleanup failed: ${msg}`,
        source: "automation",
      });
      return { deleted: deletedTotal, errors: errorTotal + 1, locks: locksScanned };
    } finally {
      this._cleanupInProgress = false;
    }
  }

  static async initialize(storage: IStorage): Promise<AutomationEngine> {
    let ttlockClient: TTLockClient | null = null;
    let notificationClient: NotificationClient | null = null;
    let mewsClient: MewsClient | null = null;

    try {
      const clientId = process.env.TTLOCK_CLIENT_ID;
      const regionSetting = await storage.getSetting("ttlock_region");
      const region = regionSetting?.value === "cn" ? "cn" : "eu";

      if (!clientId) {
        await storage.createLog({
          level: "warn",
          message: "TTLOCK_CLIENT_ID environment variable not configured - passcode automation disabled",
          source: "automation",
        });
      } else if (process.env.TTLOCK_OWNER_USERNAME && process.env.TTLOCK_OWNER_PASSWORD) {
        // Prefer owner credentials — auto-refreshes token, never expires
        ttlockClient = await createOwnerClient(region);
        await storage.createLog({
          level: "info",
          message: "TTLock client initialized using owner credentials (auto-refresh enabled)",
          source: "automation",
        });
      } else {
        // Fall back to stored per-tenant access token
        const accessTokenSetting = await storage.getSetting("ttlock_access_token");
        if (accessTokenSetting) {
          ttlockClient = new TTLockClient(clientId, accessTokenSetting.value, region);
          await storage.createLog({
            level: "info",
            message: "TTLock client initialized using stored access token",
            source: "automation",
          });
        } else {
          await storage.createLog({
            level: "warn",
            message: "TTLock access token not configured - please connect your TTLock account in Settings",
            source: "automation",
          });
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await storage.createLog({
        level: "error",
        message: `Failed to initialize TTLock client: ${errorMessage}`,
        source: "automation",
        metadata: { error: errorMessage },
      });
    }

    try {
      notificationClient = await createNotificationClient(storage);

      await storage.createLog({
        level: "info",
        message: "Notification client initialized (credentials from tenant settings)",
        source: "automation",
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await storage.createLog({
        level: "error",
        message: `Failed to initialize notification client: ${errorMessage}`,
        source: "automation",
        metadata: { error: errorMessage },
      });
    }

    try {
      const clientTokenSetting = await storage.getSetting("mews_client_token");
      const accessTokenSetting = await storage.getSetting("mews_access_token");
      const environmentSetting = await storage.getSetting("mews_environment");

      if (clientTokenSetting && accessTokenSetting) {
        const envValue = environmentSetting?.value || "demo";
        const environment: "production" | "demo" = envValue === "production" ? "production" : "demo";
        mewsClient = new MewsClient(
          clientTokenSetting.value,
          accessTokenSetting.value,
          environment
        );

        await storage.createLog({
          level: "info",
          message: "MEWS client initialized for automation",
          source: "automation",
        });
      } else {
        await storage.createLog({
          level: "warn",
          message: "MEWS credentials not configured - passcode sync to MEWS disabled",
          source: "automation",
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await storage.createLog({
        level: "error",
        message: `Failed to initialize MEWS client for automation: ${errorMessage}`,
        source: "automation",
        metadata: { error: errorMessage },
      });
    }

    return new AutomationEngine(storage, ttlockClient, notificationClient, mewsClient);
  }
}
