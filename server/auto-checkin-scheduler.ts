import { ITenantStorage } from "./storage";
import { AutomationEngine } from "./automation";
import { CheckInService } from "./checkin-service";
import { NotificationClient, NotificationChannel, createNotificationClient } from "./notification-client";
import { MewsClient } from "./mews-client";
import { DateTime } from "luxon";
import { buildPreCheckinUrl } from "./pre-checkin-url";

export class AutoCheckinScheduler {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isProcessing = false;
  private processedPreCheckin = new Set<string>();
  private processedBoardingPass = new Set<string>();
  private lastPaymentCheck = new Map<string, number>();

  constructor(
    private storage: ITenantStorage,
    private automationEngine: AutomationEngine,
    private mewsClient: MewsClient | null,
    private tenantId: string
  ) {}

  async start() {
    if (this.isRunning) {
      console.log("[AutoCheckin] Scheduler already running");
      return;
    }

    this.isRunning = true;
    console.log("[AutoCheckin] Scheduler started - pre-check-in emails + digital key for paid guests");

    try {
      await this.storage.createLog({
        level: "info",
        message: "Auto check-in scheduler started",
        source: "automation",
      });
    } catch (e) {
      console.error("[AutoCheckin] Failed to write start log:", e);
    }

    this.intervalId = setInterval(async () => {
      await this.checkAndRun();
    }, 300000);

    await this.checkAndRun();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log("[AutoCheckin] Scheduler stopped");
  }

  async checkAndRun() {
    if (this.isProcessing) {
      console.log("[AutoCheckin] Previous run still in progress, skipping");
      return;
    }
    this.isProcessing = true;
    try {
      const timezoneSetting = await this.storage.getSetting("property_timezone");
      const timezone = timezoneSetting?.value || "Europe/Copenhagen";

      const now = DateTime.now().setZone(timezone);
      const startOfToday = now.startOf("day");
      const in24Hours = now.plus({ hours: 24 });

      // Fetch from start of today (not "now") so same-day reservations with past arrival times are included
      const reservations = await this.storage.getMappedReservationsByArrivalRange(
        startOfToday.toJSDate(),
        in24Hours.toJSDate()
      );

      const eligibleStatuses = ["confirmed", "checked-in", "started"];
      const eligibleReservations = reservations.filter(r =>
        eligibleStatuses.includes(r.status?.toLowerCase() || "")
      );

      if (eligibleReservations.length === 0) {
        return;
      }

      const checkinService = new CheckInService(this.storage, this.mewsClient, this.automationEngine);

      const notificationClient = await createNotificationClient(this.storage);

      const appUrlSetting = await this.storage.getSetting("app_base_url");
      const baseUrl = appUrlSetting?.value
        ? appUrlSetting.value
        : process.env.REPLIT_DEPLOYMENT_DOMAIN
        ? `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}`
        : "https://dreamboks.com";

      const testEmailSetting = await this.storage.getSetting("boarding_test_email");
      const testPhoneSetting = await this.storage.getSetting("boarding_test_phone");
      const hotelSlugSetting = await this.storage.getSetting("hotel_slug");
      const hotelNameSetting = await this.storage.getSetting("hotel_name");
      const hotelName = hotelNameSetting?.value || "Copenhagen Downtown Hostel";
      const requireIdSetting = await this.storage.getSetting("require_id_for_checkin");
      const requireIdForCheckin = requireIdSetting?.value === "true";

      // --- PART 1: Send pre-check-in messages to guests who haven't received one yet ---
      const needPreCheckin = eligibleReservations.filter(r =>
        !r.preCheckinEmailSent &&
        !this.processedPreCheckin.has(r.id)
      );

      if (needPreCheckin.length > 0) {
        console.log(`[AutoCheckin] ${needPreCheckin.length} reservation(s) need pre-check-in email`);
      }

      for (const reservation of needPreCheckin) {
        try {
          this.processedPreCheckin.add(reservation.id);

          if (!reservation.roomId) {
            this.processedPreCheckin.delete(reservation.id);
            continue;
          }

          const lockAssignments = await this.storage.getRoomLockAssignments(reservation.roomId);
          const roomLocks = lockAssignments.filter(a => a.lockDevice.lockType === "room");
          if (!roomLocks.length) {
            // No room-specific lock assigned — skip boarding pass (common area locks alone don't qualify)
            this.processedPreCheckin.delete(reservation.id);
            continue;
          }

          if (!reservation.preCheckinToken) {
            const token = checkinService.generatePreCheckinToken();
            await this.storage.updateReservation(reservation.id, {
              preCheckinToken: token,
            });
          }

          const freshReservation = await this.storage.getReservation(reservation.id);
          if (!freshReservation || !freshReservation.preCheckinToken) continue;

          // Guard against race condition: re-check DB flag in case it was set
          // by a concurrent process or a previous run whose in-memory Set was cleared
          if (freshReservation.preCheckinEmailSent) continue;

          const guestEmail = freshReservation.personalEmail || freshReservation.email;
          const guestMobile = freshReservation.mobile;
          if (!guestEmail && !guestMobile && !testEmailSetting?.value) {
            this.processedPreCheckin.delete(reservation.id);
            continue;
          }

          const recipientEmail = testEmailSetting?.value || guestEmail || undefined;
          const checkInUrl = buildPreCheckinUrl({
            baseUrl,
            hotelSlug: hotelSlugSetting?.value,
            preCheckinToken: freshReservation.preCheckinToken,
          });
          const guestName = `${reservation.firstName} ${reservation.lastName}`;

          if (!freshReservation.generatedPin) {
            // No PIN yet — skip pre-checkin email until PIN is created
            this.processedPreCheckin.delete(reservation.id);
            continue;
          }
          const pin = freshReservation.generatedPin;
          const recipientMobile = testPhoneSetting?.value || freshReservation.mobile || undefined;
          const channels = this.getChannelsForReservation(freshReservation.preferredChannel, recipientEmail, recipientMobile);

          console.log(`[AutoCheckin] Sending pre-check-in via ${channels.join("+")} for ${guestName}`);

          const result = await notificationClient.sendMultiChannel({
            channels,
            email: recipientEmail,
            mobile: recipientMobile,
            emailSender: () => notificationClient.sendPreCheckInPlainTextEmail({
              email: recipientEmail!,
              guestName,
              hotelName: hotelName,
              checkInUrl,
              arrivalDate: new Date(reservation.arrival).toLocaleDateString("en-GB", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
              }),
              departureDate: new Date(reservation.departure).toLocaleDateString("en-GB", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
              }),
            }),
            smsSender: () => notificationClient.sendPreCheckInSMS({
              mobile: recipientMobile!,
              pin,
              checkInUrl,
              hotelName: hotelName,
            }),
            whatsappSender: () => notificationClient.sendPreCheckInWhatsApp({
              mobile: recipientMobile!,
              pin,
              checkInUrl,
              hotelName: hotelName,
            }),
          });

          const anyDelivered = result.emailDelivered || result.smsDelivered || result.whatsappDelivered;

          if (result.errors.length > 0) {
            await this.storage.createLog({
              level: "warn",
              message: `Pre-check-in channel errors for ${guestName}: ${result.errors.join("; ")}`,
              source: "automation",
              reservationId: reservation.id,
              metadata: { errors: result.errors },
            });
          }

          if (anyDelivered) {
            await this.storage.updateReservation(reservation.id, {
              preCheckinEmailSent: true,
            });

            const isTestMode = !!testEmailSetting?.value;
            const deliveredChannels = [
              result.emailDelivered ? "email" : null,
              result.smsDelivered ? "sms" : null,
              result.whatsappDelivered ? "whatsapp" : null,
            ].filter(Boolean).join("+");

            await this.storage.createLog({
              level: "info",
              message: isTestMode
                ? `Pre-check-in sent via ${deliveredChannels} to TEST (${recipientEmail}) for ${guestName}`
                : `Pre-check-in sent via ${deliveredChannels} to ${guestName}`,
              source: "automation",
              reservationId: reservation.id,
              metadata: {
                channels: deliveredChannels,
                email: recipientEmail,
                guestEmail: guestEmail,
                testMode: isTestMode,
                arrival: reservation.arrival.toString(),
              },
            });
            console.log(`[AutoCheckin] Pre-check-in sent via ${deliveredChannels} for ${guestName}${isTestMode ? ` (to ${recipientEmail})` : ""}`);
          } else {
            await this.storage.createLog({
              level: "warn",
              message: `Pre-check-in failed for ${guestName}: ${result.errors.join("; ")}`,
              source: "automation",
              reservationId: reservation.id,
            });
            console.log(`[AutoCheckin] Pre-check-in failed for ${guestName}: ${result.errors.join("; ")}`);
            this.processedPreCheckin.delete(reservation.id);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[AutoCheckin] Pre-check-in error for ${reservation.id}: ${errorMessage}`);
          await this.storage.createLog({
            level: "error",
            message: `Pre-check-in email error: ${errorMessage}`,
            source: "automation",
            reservationId: reservation.id,
          });
          this.processedPreCheckin.delete(reservation.id);
        }
      }

      // --- PART 2: Send digital key to guests who have paid (owing=0) but haven't received digital key yet ---
      const PAYMENT_CHECK_INTERVAL_MS = 15 * 60 * 1000; // Only re-check payment every 15 minutes per reservation
      const nowMs = Date.now();

      const needBoardingPass = eligibleReservations.filter(r => {
        if (r.notificationSent || r.preCheckinStatus === "code_sent") return false;
        if (this.processedBoardingPass.has(r.id)) return false;
        if (!r.roomId) return false;
        const isCheckedIn = ["checked-in", "started"].includes(r.status?.toLowerCase() || "");
        if (isCheckedIn) return true;
        const lastCheck = this.lastPaymentCheck.get(r.id);
        if (lastCheck && (nowMs - lastCheck) < PAYMENT_CHECK_INTERVAL_MS) return false;
        return true;
      });

      if (needBoardingPass.length === 0) {
        return;
      }

      console.log(`[AutoCheckin] Checking ${needBoardingPass.length} reservation(s) for digital key eligibility`);

      for (const reservation of needBoardingPass) {
        try {
          const guestEmail = reservation.personalEmail || reservation.email;
          const guestMobile = reservation.mobile;
          if (!guestEmail && !guestMobile && !testEmailSetting?.value) {
            continue;
          }

          const guestName = `${reservation.firstName} ${reservation.lastName}`;
          const isCheckedIn = ["checked-in", "started"].includes(reservation.status?.toLowerCase() || "");

          let shouldSend = false;
          if (isCheckedIn) {
            shouldSend = true;
            console.log(`[AutoCheckin] Guest ${guestName} is checked-in (Kiosk/reception) - sending digital key immediately`);
          } else {
            this.lastPaymentCheck.set(reservation.id, nowMs);
            const { owing } = await checkinService.ensureOutstandingBalance(reservation, true);
            const owingAmount = parseFloat(owing);
            if (owingAmount <= 0) {
              shouldSend = true;
              console.log(`[AutoCheckin] Guest ${guestName} has paid (owing=0) - sending digital key`);
            }
          }

          if (!shouldSend) continue;

          if (requireIdForCheckin) {
            if (!this.mewsClient || !reservation.mewsCustomerId) {
              console.log(`[AutoCheckin] Guest ${guestName} - cannot verify ID (MEWS client or customerId missing) - digital key blocked`);
              await this.storage.createLog({
                level: "warn",
                message: `Digital key blocked for ${guestName}: Cannot verify ID - MEWS client or customerId missing`,
                source: "automation",
                reservationId: reservation.id,
              });
              continue;
            }
            try {
              const idDocs = await this.mewsClient.getIdentityDocuments([reservation.mewsCustomerId]);
              if (!idDocs || idDocs.length === 0) {
                console.log(`[AutoCheckin] Guest ${guestName} has no ID document in MEWS - digital key blocked`);
                await this.storage.createLog({
                  level: "info",
                  message: `Digital key blocked for ${guestName}: No ID document registered in MEWS`,
                  source: "automation",
                  reservationId: reservation.id,
                });
                continue;
              }
              console.log(`[AutoCheckin] Guest ${guestName} has ${idDocs.length} ID document(s) in MEWS - proceeding with digital key`);
            } catch (idError) {
              const idErrorMsg = idError instanceof Error ? idError.message : String(idError);
              console.error(`[AutoCheckin] Failed to check ID documents for ${guestName}: ${idErrorMsg}`);
              await this.storage.createLog({
                level: "warn",
                message: `ID document check failed for ${guestName}: ${idErrorMsg} - proceeding anyway (API error is not "no ID")`,
                source: "automation",
                reservationId: reservation.id,
              });
              // API error ≠ "no ID" — do not block the digital key
            }
          }

          this.processedBoardingPass.add(reservation.id);

          await this.storage.updateReservation(reservation.id, {
            preCheckinStatus: "paid",
            paymentVerifiedAt: new Date(),
          });

          const freshReservation = await this.storage.getReservation(reservation.id);
          if (!freshReservation) continue;

          const sendResult = await checkinService.sendAccessCode(freshReservation);

          if (sendResult.success || sendResult.notificationFailed) {
            const isTestMode = !!testEmailSetting?.value;
            const trigger = isCheckedIn ? "checked_in_kiosk_reception" : "auto_payment_detected";
            await this.storage.createLog({
              level: "info",
              message: isTestMode
                ? `Digital key auto-sent to TEST address for ${guestName} (${trigger})`
                : `Digital key auto-sent to ${guestName} (${trigger})`,
              source: "automation",
              reservationId: reservation.id,
              metadata: {
                testMode: isTestMode,
                arrival: reservation.arrival.toString(),
                trigger,
              },
            });
            console.log(`[AutoCheckin] Digital key sent for ${guestName} (${trigger})`);
          } else {
            await this.storage.createLog({
              level: "warn",
              message: `Digital key failed for ${guestName}: ${sendResult.error}`,
              source: "automation",
              reservationId: reservation.id,
            });
            console.log(`[AutoCheckin] Digital key failed for ${guestName}: ${sendResult.error}`);
            this.processedBoardingPass.delete(reservation.id);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[AutoCheckin] Digital key error for ${reservation.id}: ${errorMessage}`);
          await this.storage.createLog({
            level: "error",
            message: `Digital key error: ${errorMessage}`,
            source: "automation",
            reservationId: reservation.id,
          });
          this.processedBoardingPass.delete(reservation.id);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[AutoCheckin] Scheduler error: ${errorMessage}`);
    } finally {
      this.isProcessing = false;
    }
  }

  async runNow(): Promise<{ processed: number; failed: number }> {
    console.log("[AutoCheckin] Manual run triggered");
    this.processedPreCheckin.clear();
    this.processedBoardingPass.clear();
    let processed = 0;
    let failed = 0;

    try {
      const timezoneSetting = await this.storage.getSetting("property_timezone");
      const timezone = timezoneSetting?.value || "Europe/Copenhagen";
      const now = DateTime.now().setZone(timezone);
      const startOfToday = now.startOf("day");
      const in24Hours = now.plus({ hours: 24 });

      const reservations = await this.storage.getReservationsByArrivalRange(
        startOfToday.toJSDate(),
        in24Hours.toJSDate()
      );

      const runEligibleStatuses = ["confirmed", "checked-in", "started"];
      const eligibleRunReservations = reservations.filter(r =>
        runEligibleStatuses.includes(r.status?.toLowerCase() || "")
      );

      const checkinService = new CheckInService(this.storage, this.mewsClient, this.automationEngine);
      const notificationClient = await createNotificationClient(this.storage);

      const appUrlSetting = await this.storage.getSetting("app_base_url");
      const baseUrl = appUrlSetting?.value
        ? appUrlSetting.value
        : process.env.REPLIT_DEPLOYMENT_DOMAIN
        ? `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}`
        : "https://dreamboks.com";

      const testEmailSetting = await this.storage.getSetting("boarding_test_email");
      const hotelSlugSetting = await this.storage.getSetting("hotel_slug");
      const runRequireIdSetting = await this.storage.getSetting("require_id_for_checkin");
      const runRequireIdForCheckin = runRequireIdSetting?.value === "true";

      for (const reservation of eligibleRunReservations) {
        if (!reservation.roomId) continue;

        const lockAssignments = await this.storage.getRoomLockAssignments(reservation.roomId);
        const roomLocks = lockAssignments.filter(a => a.lockDevice.lockType === "room");
        if (!roomLocks.length) continue; // No room-specific lock — skip

        const guestEmail = reservation.personalEmail || reservation.email;
        if (!guestEmail && !testEmailSetting?.value) continue;

        const guestName = `${reservation.firstName} ${reservation.lastName}`;
        const isCheckedIn = ["checked-in", "started"].includes(reservation.status?.toLowerCase() || "");

        // Part 1: Send pre-check-in email if not sent yet (only for confirmed, not already checked-in)
        if (!isCheckedIn && !reservation.preCheckinEmailSent) {
          if (!reservation.preCheckinToken) {
            const token = checkinService.generatePreCheckinToken();
            await this.storage.updateReservation(reservation.id, {
              preCheckinToken: token,
            });
          }

          const freshRes = await this.storage.getReservation(reservation.id);
          if (!freshRes || !freshRes.preCheckinToken) continue;

          const recipientEmail = testEmailSetting?.value || guestEmail!;
          const checkInUrl = buildPreCheckinUrl({
            baseUrl,
            hotelSlug: hotelSlugSetting?.value,
            preCheckinToken: freshRes.preCheckinToken,
          });

          const emailResult = await notificationClient.sendPreCheckInPlainTextEmail({
            email: recipientEmail,
            guestName,
            hotelName: "Copenhagen Downtown Hostel",
            checkInUrl,
            arrivalDate: new Date(reservation.arrival).toLocaleDateString("en-GB", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            }),
            departureDate: new Date(reservation.departure).toLocaleDateString("en-GB", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            }),
          });

          if (emailResult.success) {
            await this.storage.updateReservation(reservation.id, {
              preCheckinEmailSent: true,
            });
            processed++;
          } else {
            failed++;
          }
        }

        // Part 2: Send digital key if not yet sent
        // For checked-in guests (Kiosk/reception): skip payment check, send immediately
        // For confirmed guests: check payment (owing=0) first
        if (!reservation.notificationSent && reservation.preCheckinStatus !== "code_sent") {
          let shouldSend = false;

          if (isCheckedIn) {
            shouldSend = true;
          } else {
            const { owing } = await checkinService.ensureOutstandingBalance(reservation, true);
            const owingAmount = parseFloat(owing);
            shouldSend = owingAmount <= 0;
          }

          if (shouldSend) {
            if (runRequireIdForCheckin) {
              if (!this.mewsClient || !reservation.mewsCustomerId) {
                console.log(`[AutoCheckin] Manual run: Guest ${guestName} - cannot verify ID (MEWS client or customerId missing) - digital key blocked`);
                await this.storage.createLog({
                  level: "warn",
                  message: `Digital key blocked for ${guestName}: Cannot verify ID - MEWS client or customerId missing`,
                  source: "automation",
                  reservationId: reservation.id,
                });
                continue;
              }
              try {
                const idDocs = await this.mewsClient.getIdentityDocuments([reservation.mewsCustomerId]);
                if (!idDocs || idDocs.length === 0) {
                  console.log(`[AutoCheckin] Manual run: Guest ${guestName} has no ID document in MEWS - digital key blocked`);
                  await this.storage.createLog({
                    level: "info",
                    message: `Digital key blocked for ${guestName}: No ID document registered in MEWS`,
                    source: "automation",
                    reservationId: reservation.id,
                  });
                  continue;
                }
              } catch (idError) {
                const idErrorMsg = idError instanceof Error ? idError.message : String(idError);
                console.error(`[AutoCheckin] Manual run: ID document check failed for ${guestName}: ${idErrorMsg}`);
                await this.storage.createLog({
                  level: "warn",
                  message: `ID document check failed for ${guestName}: ${idErrorMsg} - proceeding anyway (API error is not "no ID")`,
                  source: "automation",
                  reservationId: reservation.id,
                });
                // API error ≠ "no ID" — do not block the digital key
              }
            }

            await this.storage.updateReservation(reservation.id, {
              preCheckinStatus: "paid",
              paymentVerifiedAt: new Date(),
            });

            const freshRes = await this.storage.getReservation(reservation.id);
            if (!freshRes) continue;

            const sendResult = await checkinService.sendAccessCode(freshRes);
            if (sendResult.success) {
              processed++;
            } else {
              failed++;
            }
          }
        }
      }
    } catch (error) {
      console.error(`[AutoCheckin] Manual run error: ${error}`);
    }

    return { processed, failed };
  }

  private getChannelsForReservation(
    preferredChannel: string | null | undefined,
    email: string | null | undefined,
    mobile: string | null | undefined
  ): NotificationChannel[] {
    const channels: NotificationChannel[] = [];
    if (email) channels.push("email");
    if (mobile) {
      channels.push("sms");
      channels.push("whatsapp");
    }
    return channels;
  }
}
