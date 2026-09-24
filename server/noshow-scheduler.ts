import { ITenantStorage } from "./storage";
import { MewsClient } from "./mews-client";
import { DateTime } from "luxon";

export class NoShowScheduler {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastRunDate: string | null = null;

  constructor(
    private storage: ITenantStorage,
    private mewsClient: MewsClient | null,
    private tenantId: string
  ) {}

  async start() {
    if (this.isRunning) {
      console.log("[NoShow] Scheduler already running");
      return;
    }

    this.isRunning = true;
    console.log("[NoShow] Scheduler started - checking every minute for latest arrival time");

    await this.storage.createLog({
      level: "info",
      message: "No-show scheduler started",
      source: "automation",
    });

    this.intervalId = setInterval(async () => {
      await this.checkAndRun();
    }, 60000);

    await this.checkAndRun();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log("[NoShow] Scheduler stopped");
  }

  private async checkAndRun() {
    try {
      const noshowEnabledSetting = await this.storage.getSetting("noshow_enabled");
      const noshowEnabled = noshowEnabledSetting?.value !== "false";
      
      if (!noshowEnabled) {
        return;
      }

      const latestArrivalTimeSetting = await this.storage.getSetting("latest_arrival_time");
      const timezoneSetting = await this.storage.getSetting("property_timezone");
      const noshowNextDaySetting = await this.storage.getSetting("noshow_next_day");

      const latestArrivalTime = latestArrivalTimeSetting?.value || "23:00";
      const timezone = timezoneSetting?.value || "Europe/Copenhagen";
      const isNextDay = noshowNextDaySetting?.value === "true";

      const now = DateTime.now().setZone(timezone);
      
      const [latestHour, latestMinute] = latestArrivalTime.split(":").map(Number);
      let latestDateTime = now.set({ hour: latestHour, minute: latestMinute, second: 0, millisecond: 0 });
      
      let arrivalDate: string;
      if (isNextDay) {
        arrivalDate = now.minus({ days: 1 }).toFormat("yyyy-MM-dd");
      } else {
        arrivalDate = now.toFormat("yyyy-MM-dd");
        if (now < latestDateTime) {
          return;
        }
      }
      
      const runKey = `${arrivalDate}-${latestArrivalTime}`;
      
      if (this.lastRunDate === runKey) {
        return;
      }

      if (now >= latestDateTime) {
        console.log(`[NoShow] Latest arrival time reached (${latestArrivalTime}${isNextDay ? " next day" : ""}), running no-show detection for arrivals on ${arrivalDate}...`);

        await this.storage.createLog({
          level: "info",
          message: `No-show detection triggered at ${now.toFormat("HH:mm")} (scheduled: ${latestArrivalTime}${isNextDay ? " next day" : ""})`,
          source: "automation",
        });

        try {
          const results = await this.processNoShows(timezone, isNextDay);
          this.lastRunDate = runKey;

          console.log(`[NoShow] Job complete: ${results.noShows} marked as no-show, ${results.errors} errors`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[NoShow] Job failed: ${errorMessage}`);
          await this.storage.createLog({
            level: "error",
            message: `No-show job failed: ${errorMessage}`,
            source: "automation",
            metadata: { error: errorMessage },
          });
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[NoShow] Scheduler error: ${errorMessage}`);
    }
  }

  private async processNoShows(timezone: string, isNextDay: boolean = false): Promise<{ noShows: number; errors: number }> {
    let noShows = 0;
    let errors = 0;

    const now = DateTime.now().setZone(timezone);
    const targetDate = isNextDay ? now.minus({ days: 1 }) : now;
    const targetStart = targetDate.startOf("day").toJSDate();
    const targetEnd = targetDate.endOf("day").toJSDate();

    const todayArrivals = await this.storage.getReservationsByArrivalRange(targetStart, targetEnd);

    const confirmedArrivals = todayArrivals.filter(r => r.status === "confirmed");

    if (confirmedArrivals.length === 0) {
      console.log("[NoShow] No confirmed arrivals to check");
      return { noShows: 0, errors: 0 };
    }

    console.log(`[NoShow] Checking ${confirmedArrivals.length} confirmed arrivals for no-show`);

    const allPins = await this.storage.getAllPins();
    const pinsByReservation = new Map<string, typeof allPins>();
    for (const pin of allPins) {
      if (pin.reservationId) {
        const existing = pinsByReservation.get(pin.reservationId) || [];
        existing.push(pin);
        pinsByReservation.set(pin.reservationId, existing);
      }
    }

    for (const reservation of confirmedArrivals) {
      try {
        const reservationPins = pinsByReservation.get(reservation.id) || [];
        const activePins = reservationPins.filter(p => p.status === "active");
        
        if (activePins.length === 0) {
          continue;
        }

        const hasUnusedPin = activePins.some(p => !p.firstUsedAt);
        
        if (!hasUnusedPin) {
          continue;
        }

        console.log(`[NoShow] Reservation ${reservation.pmsId || reservation.id} has unused PIN - marking as no-show locally`);

        // No-show is marked locally only — staff handles MEWS manually
        await this.storage.updateReservation(reservation.id, {
          status: "no-show",
        });

        await this.storage.createLog({
          level: "info",
          message: `Reservation marked as no-show - guest did not arrive`,
          source: "automation",
          reservationId: reservation.id,
          metadata: {
            pmsId: reservation.pmsId,
            guestName: `${reservation.firstName} ${reservation.lastName}`,
          },
        });

        noShows++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[NoShow] Error processing reservation ${reservation.id}: ${errorMessage}`);
        errors++;
      }
    }

    return { noShows, errors };
  }

  async runNow(): Promise<{ noShows: number; errors: number }> {
    console.log("[NoShow] Manual no-show detection triggered");
    const timezoneSetting = await this.storage.getSetting("property_timezone");
    const timezone = timezoneSetting?.value || "Europe/Copenhagen";
    const results = await this.processNoShows(timezone);
    const now = DateTime.now();
    this.lastRunDate = now.toFormat("yyyy-MM-dd");
    return results;
  }
}
