import { ITenantStorage } from "./storage";
import { TTLockClient } from "./ttlock-client";
import { DateTime } from "luxon";

export class UnlockRecordsPoller {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastRunDate: string | null = null;

  constructor(
    private storage: ITenantStorage,
    private ttlockClient: TTLockClient | null,
    private tenantId: string
  ) {}

  async start() {
    if (this.isRunning) {
      console.log("[UnlockRecords] Poller already running");
      return;
    }

    this.isRunning = true;
    console.log("[UnlockRecords] Poller started - running daily at 01:00 to check PIN usage");

    await this.storage.createLog({
      level: "info",
      message: "Unlock records poller started (daily at 01:00)",
      source: "automation",
    });

    // Check every minute if it's time to run
    this.intervalId = setInterval(async () => {
      await this.checkAndRun();
    }, 60000);

    // Run immediately on startup in case we missed today's window
    await this.checkAndRun();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log("[UnlockRecords] Poller stopped");
  }

  private async checkAndRun() {
    try {
      const timezoneSetting = await this.storage.getSetting("property_timezone");
      const timezone = timezoneSetting?.value || "Europe/Copenhagen";
      const now = DateTime.now().setZone(timezone);

      // Run once per day at 01:00
      const currentDate = now.toFormat("yyyy-MM-dd");
      if (this.lastRunDate === currentDate) return;
      if (now.hour !== 1) return;

      this.lastRunDate = currentDate;
      console.log(`[UnlockRecords] Daily run triggered at ${now.toFormat("HH:mm")}`);
      await this.pollUnlockRecords();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[UnlockRecords] Scheduler error: ${errorMessage}`);
    }
  }

  async pollUnlockRecords(): Promise<{ matched: number; errors: number }> {
    if (!this.ttlockClient) {
      console.log("[UnlockRecords] No TTLock client configured, skipping poll");
      return { matched: 0, errors: 0 };
    }

    let matched = 0;
    let errors = 0;

    try {
      const allPins = await this.storage.getAllPins();
      const activePinsWithoutUsage = allPins.filter(
        pin => pin.status === "active" && !pin.firstUsedAt
      );

      if (activePinsWithoutUsage.length === 0) {
        return { matched: 0, errors: 0 };
      }

      console.log(`[UnlockRecords] Checking ${activePinsWithoutUsage.length} active pins for first usage`);

      const timezoneSetting = await this.storage.getSetting("property_timezone");
      const timezone = timezoneSetting?.value || "Europe/Copenhagen";
      const checkInTimeSetting = await this.storage.getSetting("check_in_time");
      const checkInTime = checkInTimeSetting?.value || "15:00";
      const [checkInHour, checkInMinute] = checkInTime.split(":").map(Number);

      // Group pins by room lock ttlockId
      const lockIdsToPins = new Map<string, typeof activePinsWithoutUsage>();

      for (const pin of activePinsWithoutUsage) {
        if (pin.roomLockKeyIds && Array.isArray(pin.roomLockKeyIds)) {
          for (const entry of pin.roomLockKeyIds as Array<{ lockDeviceId?: string; ttlockId: string; keyId: string }>) {
            if (entry.ttlockId) {
              if (entry.lockDeviceId) {
                const lockDevice = await this.storage.getLockDevice(entry.lockDeviceId);
                if (lockDevice && lockDevice.lockType === "room") {
                  const existing = lockIdsToPins.get(entry.ttlockId) || [];
                  existing.push(pin);
                  lockIdsToPins.set(entry.ttlockId, existing);
                }
              } else {
                const lockDevice = await this.storage.getLockDeviceByTTLockId(entry.ttlockId);
                if (!lockDevice || lockDevice.lockType === "room") {
                  const existing = lockIdsToPins.get(entry.ttlockId) || [];
                  existing.push(pin);
                  lockIdsToPins.set(entry.ttlockId, existing);
                }
              }
            }
          }
        }

        // Legacy room.ttlockId mapping removed — all tenants use room_lock_assignments
      }

      for (const [lockId, pinsForLock] of lockIdsToPins.entries()) {
        // Find earliest check-in window start across all pins for this lock
        let earliestStart: Date | null = null;

        for (const pin of pinsForLock) {
          if (!pin.reservationId) continue;
          const reservation = await this.storage.getReservation(pin.reservationId);
          if (!reservation?.arrival) continue;

          const arrivalDate = DateTime.fromJSDate(reservation.arrival).setZone(timezone).toFormat("yyyy-MM-dd");
          const windowStart = DateTime.fromISO(arrivalDate, { zone: timezone }).set({
            hour: checkInHour,
            minute: checkInMinute,
            second: 0,
            millisecond: 0,
          }).toJSDate();

          if (!earliestStart || windowStart < earliestStart) {
            earliestStart = windowStart;
          }
        }

        if (!earliestStart) continue;

        try {
          const records = await this.ttlockClient.getAllUnlockRecordsSince(lockId, earliestStart);
          const passcodeUnlocks = records.filter(r => r.recordType === 1 && r.success && r.keyboardPwd);

          for (const pin of pinsForLock) {
            if (pin.firstUsedAt) continue;
            if (!pin.reservationId) continue;

            const reservation = await this.storage.getReservation(pin.reservationId);
            if (!reservation?.arrival) continue;

            const arrivalDate = DateTime.fromJSDate(reservation.arrival).setZone(timezone).toFormat("yyyy-MM-dd");
            const windowStart = DateTime.fromISO(arrivalDate, { zone: timezone }).set({
              hour: checkInHour,
              minute: checkInMinute,
              second: 0,
              millisecond: 0,
            });
            const windowEnd = DateTime.fromISO(arrivalDate, { zone: timezone }).set({
              hour: 23,
              minute: 59,
              second: 59,
              millisecond: 999,
            });

            const matchingRecord = passcodeUnlocks.find(r => {
              const recordTime = DateTime.fromJSDate(r.lockDate).setZone(timezone);
              return r.keyboardPwd === pin.code &&
                recordTime >= windowStart &&
                recordTime <= windowEnd;
            });

            if (matchingRecord) {
              console.log(`[UnlockRecords] PIN ${pin.code} first used at ${matchingRecord.lockDate.toISOString()}`);

              await this.storage.updatePinFirstUsedAt(pin.id, matchingRecord.lockDate);
              await this.storage.updatePin(pin.id, { status: "used" });

              // Guest assumed already checked in MEWS — just update local status
              await this.storage.updateReservation(pin.reservationId, {
                status: "checked-in",
                pmsCheckinSource: "lock",
              });

              await this.storage.createLog({
                level: "info",
                message: `PIN ${pin.code.substring(0, 2)}** first used via lock (detected at daily poll)`,
                source: "ttlock",
                reservationId: pin.reservationId,
                roomId: pin.roomId,
                metadata: {
                  pinId: pin.id,
                  lockId,
                  usedAt: matchingRecord.lockDate.toISOString(),
                },
              });

              pin.firstUsedAt = matchingRecord.lockDate;
              matched++;
            }
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[UnlockRecords] Error fetching records for lock ${lockId}: ${errorMessage}`);
          errors++;
        }
      }

      if (matched > 0) {
        console.log(`[UnlockRecords] Updated ${matched} pins with first usage time`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[UnlockRecords] Poller error: ${errorMessage}`);
      await this.storage.createLog({
        level: "error",
        message: `Unlock records poll failed: ${errorMessage}`,
        source: "automation",
        metadata: { error: errorMessage },
      });
      errors++;
    }

    return { matched, errors };
  }
}
