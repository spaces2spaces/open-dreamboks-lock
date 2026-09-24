import { ITenantStorage, Storage, DEFAULT_TENANT_ID } from "./storage";
import { AutomationEngine } from "./automation";
import { MewsClient } from "./mews-client";
import { MewsAdapter } from "./mews-adapter";
import { IIngestionProcessor, createIngestionProcessor } from "./ingestion-processor";
import { hasActiveLateCheckout } from "./pin-validity-window";
import { getReservationIdsWithPendingLateCheckout, recoverInterruptedEarlyCheckins } from "./early-checkin-service";
import { DateTime } from "luxon";

export class MewsPoller {
  private fastIntervalId: NodeJS.Timeout | null = null;
  private fullSyncIntervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private mewsAdapter: MewsAdapter | null = null;
  private lastFullSyncPmsIds: Set<string> = new Set();

  private fastPollIntervalMs: number = 60 * 1000;
  private fullSyncIntervalMs: number = 30 * 60 * 1000;
  private fastPollDaysAhead: number = 2;
  private fullSyncDaysAhead: number = 30;

  constructor(
    private storage: ITenantStorage,
    private eventProcessor: IIngestionProcessor,
    private automationEngine: AutomationEngine,
    private mewsClient: MewsClient | null,
    private tenantId: string
  ) {
    if (mewsClient) {
      this.mewsAdapter = new MewsAdapter(tenantId, mewsClient);
    }
  }

  async start() {
    if (this.isRunning) {
      console.log("MEWS poller already running");
      return;
    }

    if (!this.mewsAdapter) {
      await this.storage.createLog({
        level: "warn",
        message: "MEWS poller not started - MEWS client not configured",
        source: "automation",
      });
      console.log("MEWS poller not started - MEWS client not configured");
      return;
    }

    await this.loadSettings();

    this.isRunning = true;
    await this.storage.createLog({
      level: "info",
      message: `MEWS poller started - fast poll every ${this.fastPollIntervalMs / 1000}s (${this.fastPollDaysAhead} days), full sync every ${this.fullSyncIntervalMs / 1000}s (${this.fullSyncDaysAhead} days)`,
      source: "automation",
    });

    console.log(`MEWS poller started:`);
    console.log(`  - Fast poll: every ${this.fastPollIntervalMs / 1000}s for arrivals ${this.fastPollDaysAhead} days ahead`);
    console.log(`  - Full sync: every ${this.fullSyncIntervalMs / 1000}s for arrivals ${this.fullSyncDaysAhead} days ahead`);

    await this.fastPoll();

    this.fastIntervalId = setInterval(async () => {
      await this.fastPoll();
    }, this.fastPollIntervalMs);

    this.fullSyncIntervalId = setInterval(async () => {
      await this.fullSync();
    }, this.fullSyncIntervalMs);

    // Boot full sync runs AFTER the recurring ticks are armed: 30 days of
    // MEWS chunks take 10+ minutes, and awaiting it here left a post-deploy
    // blackout where PIN activation/cleanup never ran (20/7: two 23:37
    // same-night bookings had codes SENT but not programmed until the boot
    // sync finished 23:54). Steady state already overlaps fastPoll with
    // fullSync every 30 min; concurrent-ingestion safety comes from the
    // reservation lock inside onReservationCreated, the pms-id unique
    // constraint, and the recency guard in detectCancelledReservations.
    this.fullSync().catch(async (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Boot full sync error:", errorMessage);
      try {
        await this.storage.createLog({
          level: "error",
          message: `Boot full sync error: ${errorMessage}`,
          source: "automation",
        });
      } catch {
        // fullSync only rejects when DB logging is already down — don't turn
        // that into an unhandled rejection (process-fatal on Node >= 15).
      }
    });
  }

  stop() {
    if (this.fastIntervalId) {
      clearInterval(this.fastIntervalId);
      this.fastIntervalId = null;
    }
    if (this.fullSyncIntervalId) {
      clearInterval(this.fullSyncIntervalId);
      this.fullSyncIntervalId = null;
    }
    this.isRunning = false;
    console.log("MEWS poller stopped");
  }

  private async loadSettings() {
    const parsePositiveInt = (value: string | undefined, defaultVal: number, min: number, max: number): number => {
      if (!value) return defaultVal;
      const parsed = parseInt(value, 10);
      if (isNaN(parsed) || parsed < min) return min;
      if (parsed > max) return max;
      return parsed;
    };

    const fastPollIntervalSetting = await this.storage.getSetting("mews_fast_poll_interval_seconds");
    const fastPollSeconds = parsePositiveInt(fastPollIntervalSetting?.value, 60, 30, 600);
    this.fastPollIntervalMs = fastPollSeconds * 1000;

    const fullSyncIntervalSetting = await this.storage.getSetting("mews_full_sync_interval_seconds");
    const fullSyncSeconds = parsePositiveInt(fullSyncIntervalSetting?.value, 1800, 300, 7200);
    this.fullSyncIntervalMs = fullSyncSeconds * 1000;

    const fastPollDaysSetting = await this.storage.getSetting("mews_fast_poll_days_ahead");
    this.fastPollDaysAhead = parsePositiveInt(fastPollDaysSetting?.value, 2, 0, 30);

    const fullSyncDaysSetting = await this.storage.getSetting("mews_full_sync_days_ahead");
    this.fullSyncDaysAhead = parsePositiveInt(fullSyncDaysSetting?.value, 30, 1, 365);
  }

  private fastPollInFlight = false;

  private async fastPoll() {
    if (!this.mewsAdapter) return;
    // A fast poll can outlive its 60s interval when the trailing PIN-activation
    // sweep is slowed by TTLock trouble (offline gateway, error-1 retries).
    // Without this guard the ticks stack up into dozens of concurrent sweeps
    // that all re-push the same pending pins — a self-amplifying stampede that
    // hammers the TTLock API into MORE error-1s (seen 3/8: no sweep completed
    // for 2h while ~40 pins churned). Skip instead, like fullSync does.
    if (this.fastPollInFlight) {
      console.log("MEWS fast poll skipped — previous run still in flight");
      return;
    }
    this.fastPollInFlight = true;

    try {
      // Fetch by arrival window AND recently modified (to catch date changes beyond the window)
      const sinceUtc = new Date(Date.now() - this.fastPollIntervalMs - 30_000); // interval + 30s buffer
      const [arrivalEvents, updatedEvents] = await Promise.all([
        this.mewsAdapter.fetchAndConvertReservations(this.fastPollDaysAhead),
        this.mewsAdapter.fetchAndConvertUpdatedReservations(sinceUtc),
      ]);

      // Merge, de-duplicate by pmsReservationId.
      // Updated events with terminal status (Canceled, CheckedOut) override arrival
      // events — the updated API reflects the latest MEWS state, and stale in-house
      // data can otherwise keep a cancelled reservation stuck as "Started".
      const TERMINAL_MEWS_STATUSES = new Set(["Canceled", "CheckedOut"]);
      const eventMap = new Map(arrivalEvents.map(e => [e.data.pmsReservationId, e]));
      for (const e of updatedEvents) {
        const existing = eventMap.get(e.data.pmsReservationId);
        if (!existing || TERMINAL_MEWS_STATUSES.has(e.data.status)) {
          eventMap.set(e.data.pmsReservationId, e);
        }
      }
      const events = Array.from(eventMap.values());

      const updatedExtra = events.length - arrivalEvents.length;
      console.log(`MEWS fast poll: Fetched ${arrivalEvents.length} by arrival + ${updatedExtra} recently updated = ${events.length} total`);

      let processedCount = 0;
      let errorCount = 0;

      for (const event of events) {
        try {
          await this.eventProcessor.processEvent(event);
          processedCount++;
        } catch (error) {
          errorCount++;
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`Failed to process event ${event.eventId}:`, errorMessage);
          await this.storage.createLog({
            level: "error",
            message: `Failed to process event: ${errorMessage}`,
            source: "mews",
            metadata: { eventId: event.eventId, eventType: event.eventType },
          });
        }
      }

      if (events.length > 0) {
        console.log(`MEWS fast poll complete: ${events.length} found, ${processedCount} processed, ${errorCount} errors`);
      }

      // PINs are only created via online pre-check-in, then pushed to TTLock on arrival day
      // After each poll, check if there are pending PINs that need immediate activation
      await this.activatePendingPinsIfPastActivationTime();
      await this.cleanupExpiredReservations();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      await this.storage.createLog({
        level: "error",
        message: `MEWS fast poll error: ${errorMessage}`,
        source: "automation",
        metadata: { error: errorMessage, stack: errorStack },
      });
      console.error("MEWS fast poll error:", errorMessage);
    } finally {
      this.fastPollInFlight = false;
    }
  }

  private fullSyncInFlight = false;

  private async fullSync() {
    if (!this.mewsAdapter) return;
    // A full sync can outlive the interval (boot sync ~11-13 min; MEWS
    // degradation can push it past 30). Two concurrent runs would double-ingest
    // and race their cancellation snapshots — skip instead.
    if (this.fullSyncInFlight) {
      console.log("MEWS full sync skipped — previous run still in flight");
      return;
    }
    this.fullSyncInFlight = true;

    try {
      // Captured BEFORE the fetch: everything ingested locally after this
      // moment (by concurrent fast polls) is newer than the snapshot below and
      // must be exempt from cancellation detection.
      const syncStartedAt = new Date();
      const events = await this.mewsAdapter.fetchAndConvertReservations(this.fullSyncDaysAhead);
      
      console.log(`MEWS full sync: Fetched ${events.length} reservations (arrivals ${this.fullSyncDaysAhead} days ahead)`);

      const mewsPmsIds = new Set(events.map(e => e.data.pmsReservationId));

      let processedCount = 0;
      let errorCount = 0;

      for (const event of events) {
        try {
          await this.eventProcessor.processEvent(event);
          processedCount++;
        } catch (error) {
          errorCount++;
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`Failed to process event ${event.eventId}:`, errorMessage);
        }
      }

      console.log(`MEWS full sync: ${events.length} found, ${processedCount} processed, ${errorCount} errors`);

      // Safety guard: if MEWS returned 0 reservations, skip cancellation detection.
      // An empty response almost certainly indicates an API failure or transient error,
      // not that all guests actually cancelled — running detection on an empty set
      // would incorrectly mark every local reservation as cancelled.
      if (events.length === 0) {
        // Only worth an alarm if WE have active reservations MEWS should have
        // returned. A tenant with an empty enterprise (demo/pre-go-live, e.g.
        // Nyhavn63) hits this every full sync — that's expected, log as info
        // instead of warning every 30 minutes.
        let localActive = 0;
        try {
          const localReservations = await this.storage.getAllReservations();
          const now = new Date();
          const windowEnd = new Date();
          windowEnd.setDate(windowEnd.getDate() + this.fullSyncDaysAhead);
          localActive = localReservations.filter(res => {
            const arrival = new Date(res.arrival);
            const arrivalInWindow = arrival >= now && arrival <= windowEnd;
            // In-house guests count too: the fetch includes
            // getInHouseReservations, so MEWS returning 0 while we have
            // checked-in guests is anomalous even with no future arrivals.
            const inHouse = res.status === "Checked-in" &&
              !!res.departure && new Date(res.departure) >= now;
            return (
              ((res.status === "Confirmed" || res.status === "Checked-in") && arrivalInWindow) ||
              inHouse
            );
          }).length;
        } catch {
          localActive = -1; // unknown — keep the warning
        }
        await this.storage.createLog({
          level: localActive === 0 ? "info" : "warn",
          message: localActive === 0
            ? `MEWS full sync returned 0 reservations (local DB also has 0 active in window — empty/pre-go-live tenant); skipping cancellation detection`
            : `MEWS full sync returned 0 reservations while local DB has ${localActive < 0 ? "an unknown number of" : localActive} active in window — possible MEWS misconfiguration; skipping cancellation detection to avoid false cancellations`,
          source: "automation",
        });
        return;
      }

      await this.detectCancelledReservations(mewsPmsIds, syncStartedAt);

      this.lastFullSyncPmsIds = mewsPmsIds;

      // Reconcile any PINs where TTLock validity doesn't match current reservation dates
      // (catches cases where a prior TTLock update failed but the DB had already been updated)
      await this.automationEngine.reconcileStalePinDates();

      await this.storage.createLog({
        level: "info",
        message: `MEWS full sync complete: ${events.length} reservations synced (${this.fullSyncDaysAhead} days ahead)`,
        source: "automation",
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      await this.storage.createLog({
        level: "error",
        message: `MEWS full sync error: ${errorMessage}`,
        source: "automation",
        metadata: { error: errorMessage, stack: errorStack },
      });
      console.error("MEWS full sync error:", errorMessage);
    } finally {
      this.fullSyncInFlight = false;
    }
  }

  private async detectCancelledReservations(mewsPmsIds: Set<string>, syncStartedAt: Date) {
    try {
      const localReservations = await this.storage.getAllReservations();
      const now = new Date();
      const fullSyncEndDate = new Date();
      fullSyncEndDate.setDate(fullSyncEndDate.getDate() + this.fullSyncDaysAhead);

      const activeLocalReservations = localReservations.filter(res => {
        const arrival = new Date(res.arrival);
        // Recency guard: rows created/updated locally AFTER the MEWS fetch
        // started (concurrent fast polls / webhooks) are newer than the
        // snapshot — their absence from it says nothing about cancellation.
        // Without this, a booking made mid-sync gets falsely cancelled and its
        // freshly programmed door code deleted from the locks.
        const createdAt = res.createdAt ? new Date(res.createdAt) : null;
        const updatedAt = res.updatedAt ? new Date(res.updatedAt) : null;
        if ((createdAt && createdAt > syncStartedAt) || (updatedAt && updatedAt > syncStartedAt)) {
          return false;
        }
        return (
          (res.status === "Confirmed" || res.status === "Checked-in") &&
          arrival >= now &&
          arrival <= fullSyncEndDate
        );
      });

      // Safety guard: if MEWS returned significantly fewer PMS IDs than we have active
      // reservations locally, something is wrong (API error, partial response, empty set).
      // Proceeding would falsely cancel real bookings — skip instead.
      const localCount = activeLocalReservations.length;
      const mewsCount = mewsPmsIds.size;
      if (localCount > 5 && mewsCount < localCount * 0.5) {
        console.warn(`Cancellation detection skipped: MEWS returned ${mewsCount} IDs but DB has ${localCount} active reservations in window — likely API error`);
        await this.storage.createLog({
          level: "warn",
          message: `Cancellation detection skipped: MEWS returned ${mewsCount} reservation IDs but DB has ${localCount} active — skipping to avoid false cancellations`,
          source: "automation",
        });
        return;
      }

      let cancelledCount = 0;

      for (const reservation of activeLocalReservations) {
        if (!mewsPmsIds.has(reservation.pmsId)) {
          console.log(`Cancellation detected: Reservation ${reservation.id} (${reservation.firstName} ${reservation.lastName}) not in MEWS response`);

          // Delete passcode BEFORE marking as cancelled — if deletion fails,
          // keep the old status so the next sync retries.
          if (reservation.generatedPin) {
            try {
              await this.automationEngine.getPinLifecycle().onCancelled(reservation);
              console.log(`Deleted passcode for cancelled reservation ${reservation.id}`);
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.error(`Failed to delete passcode for ${reservation.id}: ${errorMessage} — will retry next sync`);
              await this.storage.createLog({
                level: "warn",
                message: `Cancellation PIN deletion failed — reservation NOT marked cancelled, will retry: ${errorMessage}`,
                source: "automation",
                metadata: { reservationId: reservation.id, pmsId: reservation.pmsId },
              });
              continue; // Skip marking as cancelled — retry on next full sync
            }
          }

          await this.storage.updateReservation(reservation.id, { status: "Cancelled" });

          await this.storage.createLog({
            level: "info",
            message: `Reservation cancelled (not in MEWS): ${reservation.firstName} ${reservation.lastName}`,
            source: "automation",
            metadata: { reservationId: reservation.id, pmsId: reservation.pmsId },
          });

          cancelledCount++;
        }
      }

      if (cancelledCount > 0) {
        console.log(`Cancellation detection: Marked ${cancelledCount} reservations as Cancelled`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Cancellation detection error:", errorMessage);
      await this.storage.createLog({
        level: "error",
        message: `Cancellation detection error: ${errorMessage}`,
        source: "automation",
      });
    }
  }

  private async syncPasscodesForVisibleReservations(): Promise<void> {
    try {
      const visibleReservations = await this.storage.getVisibleReservationsForTTLock();
      let createdCount = 0;
      let failedCount = 0;

      for (const reservation of visibleReservations) {
        // Guard on "no live pin-row" instead of "no generated_pin" so we catch
        // older reservations that have a stale generated_pin in DB but never
        // had a pin row created (and therefore never got synced to MEWS).
        // Also call if the PIN exists but was never synced to MEWS — the
        // idempotent onReservationCreated path will retroactively post it.
        const existingPins = await this.storage.getPinsByReservationId(reservation.id);
        const hasLivePin = existingPins.some(
          (p) => ["pending", "active", "used", "delete_failed"].includes(p.status)
        );
        const needsMewsSync = !!reservation.generatedPin && !reservation.mewsPinSyncedAt;
        if (!hasLivePin || needsMewsSync) {
          try {
            await this.automationEngine.getPinLifecycle().onReservationCreated(reservation);
            const result = { success: true } as any;
            if (result.success) {
              createdCount++;
              console.log(`Passcode sync: Created passcode for reservation ${reservation.id} (${reservation.firstName} ${reservation.lastName})`);
            } else {
              failedCount++;
              const errorMsg = result.error || 'Unknown error';
              console.error(`Passcode sync: Failed to create passcode for ${reservation.id}: ${errorMsg}`);
              await this.storage.createLog({
                level: "warn",
                message: `Failed to create passcode for reservation ${reservation.id}: ${errorMsg}`,
                source: "automation",
                metadata: { reservationId: reservation.id, guestName: `${reservation.firstName} ${reservation.lastName}` },
              });
            }
          } catch (error) {
            failedCount++;
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Passcode sync: Failed to create passcode for ${reservation.id}: ${errorMessage}`);
            await this.storage.createLog({
              level: "error",
              message: `Exception creating passcode for reservation ${reservation.id}: ${errorMessage}`,
              source: "automation",
              metadata: { reservationId: reservation.id, guestName: `${reservation.firstName} ${reservation.lastName}` },
            });
          }
        }
      }
      
      if (createdCount > 0 || failedCount > 0) {
        console.log(`Passcode sync: Created ${createdCount}, failed ${failedCount} passcodes for visible reservations`);
        if (createdCount > 0) {
          await this.storage.createLog({
            level: "info",
            message: `Created ${createdCount} passcodes for visible reservations${failedCount > 0 ? ` (${failedCount} failed)` : ''}`,
            source: "automation",
          });
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Passcode sync error:", errorMessage);
      await this.storage.createLog({
        level: "error",
        message: `Passcode sync error: ${errorMessage}`,
        source: "automation",
      });
    }
  }

  private async activatePendingPinsIfPastActivationTime(): Promise<void> {
    // Paid early check-ins whose activation push was interrupted (deploy
    // restart between payment and lock programming) must not wait for the
    // pre-check-in pass below — the guest has already paid for access NOW.
    try {
      await recoverInterruptedEarlyCheckins(this.tenantId, this.automationEngine);
    } catch (error) {
      console.error(`[PinActivation] Early check-in recovery error: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      // Activate 1 hour before check-in time
      const checkInTimeSetting = await this.storage.getSetting("check_in_time");
      const timezoneSetting = await this.storage.getSetting("property_timezone");

      const checkInTime = checkInTimeSetting?.value || "15:00";
      const timezone = timezoneSetting?.value || "Europe/Copenhagen";

      const [h, m] = checkInTime.split(":").map(Number);

      const now = DateTime.now().setZone(timezone);
      // Use Luxon .minus() so midnight rollover (e.g. check-in 00:30) is handled correctly
      const activationDateTime = now
        .set({ hour: h, minute: m, second: 0, millisecond: 0 })
        .minus({ hours: 1 });

      const pendingPins = await this.storage.getPendingPinsForTodayArrivals();

      if (pendingPins.length > 0) {
        const todayStart = now.startOf("day").toJSDate();
        // Overdue: arrival was before today — activate immediately regardless of time
        const hasOverdue = pendingPins.some(
          (p) => new Date(p.reservation.arrival) < todayStart
        );
        const pastActivationWindow = now >= activationDateTime;

        if (hasOverdue || pastActivationWindow) {
          console.log(
            `[PinActivation] Found ${pendingPins.length} pending PIN(s) to activate (overdue=${hasOverdue}, pastWindow=${pastActivationWindow})`
          );

          const results = await this.automationEngine.getPinLifecycle().activateForToday();

          if (results.activated > 0 || results.failed > 0) {
            console.log(
              `[PinActivation] ${results.activated} activated, ${results.failed} failed, ${results.skipped} skipped`
            );
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[PinActivation] Error in activation check: ${errorMessage}`);
    }
  }

  private async cleanupExpiredReservations(): Promise<void> {
    try {
      const allReservations = await this.storage.getAllReservations();
      const now = new Date();
      
      const checkoutTimeSetting = await this.storage.getSetting("reservation_checkout_time");
      const timezoneSetting = await this.storage.getSetting("property_timezone");
      const checkoutTime = checkoutTimeSetting?.value || "11:00";
      const timezone = timezoneSetting?.value || "Europe/Copenhagen";
      const [checkoutHour, checkoutMinute] = checkoutTime.split(":").map(Number);
      
      const nowLuxon = DateTime.now().setZone(timezone);
      // Live pending late-checkout payments also protect their reservations —
      // the guest may be mid-payment exactly when MEWS's bulk checkout lands.
      let pendingLateIds = new Set<string>();
      try {
        pendingLateIds = await getReservationIdsWithPendingLateCheckout(this.tenantId);
      } catch { /* protection unavailable — proceed with the band guard only */ }
      const expiredReservations = allReservations.filter(res => {
        // PAID LATE CHECKOUT: the guest bought extra hours past the normal
        // checkout — the reservation (and its code) must survive until the paid
        // end, even after MEWS's ~11:00 bulk auto-checkout flips it to
        // Checked-out. Same 12h sanity band as the validity-window fold.
        if (hasActiveLateCheckout(res) || pendingLateIds.has(res.id)) {
          return false;
        }
        // Checked-out: delete immediately (guest has left)
        if (res.status === "Checked-out") {
          return true;
        }
        // Cancelled: keep in DB until checkout time passes so the next good MEWS
        // sync can find the record by pmsId and reinstate it (preserving
        // pre_checkin_email_sent=true), breaking the cancel→delete→recreate→email cycle.
        // Use Luxon for timezone-correct comparison (not setUTCHours which ignores local TZ)
        // DAY-USE GUARD (28/7, Tziolas/713 lock-spam): for a day-use stay the
        // checkout-normalized instant (10:00) lies BEFORE the raw departure
        // (e.g. 12:00). Deleting at 10:00 while ingestion correctly keeps the
        // reservation alive until 12:00 produced a delete→recreate→push loop
        // every minute that hammered the room lock. Never delete before the
        // RAW departure has ALSO passed.
        if (new Date(res.departure).getTime() > Date.now()) return false;
        const departureInZone = DateTime.fromJSDate(new Date(res.departure), { zone: "utc" })
          .setZone(timezone)
          .set({ hour: checkoutHour, minute: checkoutMinute, second: 0, millisecond: 0 });
        return departureInZone < nowLuxon;
      });
      
      if (expiredReservations.length === 0) {
        return;
      }
      
      let deletedPasscodes = 0;
      let failedPasscodes = 0;
      
      // Step 1: Delete passcodes from TTLock for all expired reservations
      for (const reservation of expiredReservations) {
        if (reservation.generatedPin) {
          try {
            await this.automationEngine.getPinLifecycle().onCancelled(reservation);
            deletedPasscodes++;
            console.log(`Cleanup: Deleted passcode for expired reservation ${reservation.id}`);
          } catch (error) {
            failedPasscodes++;
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Cleanup: Failed to delete passcode for ${reservation.id}: ${errorMessage}`);
            await this.storage.createLog({
              level: "error",
              message: `Failed to delete passcode for expired reservation ${reservation.id}: ${errorMessage}`,
              source: "automation",
              metadata: { reservationId: reservation.id },
            });
          }
        }
      }
      
      const deletedCount = await this.storage.deleteExpiredReservations();
      
      const orphanedCount = await this.storage.deleteOrphanedPins();
      
      if (deletedCount > 0 || deletedPasscodes > 0 || orphanedCount > 0) {
        console.log(`Cleanup: Deleted ${deletedPasscodes} passcodes, ${deletedCount} reservations, ${orphanedCount} orphaned pins`);
        await this.storage.createLog({
          level: "info",
          message: `Cleaned up ${deletedPasscodes} passcodes, ${deletedCount} expired reservations, ${orphanedCount} orphaned pins${failedPasscodes > 0 ? ` (${failedPasscodes} passcode deletions failed)` : ''}`,
          source: "automation",
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Cleanup error:", errorMessage);
      await this.storage.createLog({
        level: "error",
        message: `Cleanup error: ${errorMessage}`,
        source: "automation",
      });
    }
  }

  static async initialize(
    storage: ITenantStorage,
    automationEngine: AutomationEngine,
    tenantId: string = DEFAULT_TENANT_ID,
    externalEventProcessor?: IIngestionProcessor
  ): Promise<MewsPoller> {
    let mewsClient: MewsClient | null = null;

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
          message: "MEWS client initialized for polling",
          source: "automation",
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await storage.createLog({
        level: "error",
        message: `Failed to initialize MEWS client for polling: ${errorMessage}`,
        source: "automation",
        metadata: { error: errorMessage },
      });
    }

    const eventProcessor = externalEventProcessor ?? createIngestionProcessor(automationEngine);

    return new MewsPoller(storage, eventProcessor, automationEngine, mewsClient, tenantId);
  }
}
