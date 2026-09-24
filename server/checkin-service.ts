import { IStorage } from "./storage";
import { appendHotelSlug, buildBoardingPassUrl } from "@shared/boarding-pass-url";
import { MewsClient } from "./mews-client";
import { AutomationEngine } from "./automation";
import { NotificationClient, createNotificationClient } from "./notification-client";
import { sendOpsAlert } from "./ops-alert";
import { Reservation } from "@shared/schema";
import { getSpaceDisplayName } from "@shared/display-name";
import { type PmsAdapterInterface } from "./pms-adapter-interface";
import crypto from "crypto";

export interface CheckInResult {
  success: boolean;
  status: "paid" | "awaiting_payment" | "error" | "too_early" | "already_sent" | "mews_sync_failed" | "notification_failed";
  message: string;
  reservation?: {
    id: string;
    guestName: string;
    arrival: Date;
    departure: Date;
    room: string | null;
    email: string | null;
  };
  passcode?: string;
  paymentRequestSent?: boolean;
  mewsSyncFailed?: boolean;
  notificationFailed?: boolean;
}

export class CheckInService {
  private pmsAdapter: PmsAdapterInterface | null = null;

  constructor(
    private storage: IStorage,
    private mewsClient: MewsClient | null = null,
    private automationEngine: AutomationEngine | null = null
  ) {}

  setPmsAdapter(adapter: PmsAdapterInterface | null): void {
    this.pmsAdapter = adapter;
  }

  generatePreCheckinToken(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  async getReservationByToken(token: string): Promise<Reservation | null> {
    const reservation = await this.storage.getReservationByPreCheckinToken(token);
    return reservation || null;
  }

  isWithin24HoursOfArrival(reservation: Reservation): boolean {
    const now = new Date();
    const arrival = new Date(reservation.arrival);
    const hoursUntilArrival = (arrival.getTime() - now.getTime()) / (1000 * 60 * 60);
    return hoursUntilArrival <= 24 && hoursUntilArrival >= -24;
  }

  async ensureOutstandingBalance(reservation: Reservation, forceRefresh: boolean = false): Promise<{ owing: string; updated: boolean }> {
    // Always refresh from MEWS — cached owing can be stale (e.g. OTA bookings
    // where the OTA pays via virtual card after the initial ingestion snapshot).
    if (!forceRefresh && reservation.paymentVerifiedAt) {
      return { owing: reservation.owing || "0", updated: false };
    }

    if (!this.mewsClient) {
      return { owing: reservation.owing || "0", updated: false };
    }

    try {
      // PRIMARY SOURCE OF TRUTH: customer bill balance. This matches what the MEWS
      // dashboard shows as "Balanced / To be paid" and correctly handles billing
      // automation (e.g. OTA bookings where charges move to the partner's customer bill
      // and reservation-scoped queries return stale or inverted numbers).
      let owing: number | null = null;
      let logDetail = "";

      if (reservation.mewsCustomerId) {
        const billBalance = await this.mewsClient.getCustomerBillBalance(reservation.mewsCustomerId);
        if (billBalance !== null) {
          owing = Math.max(0, billBalance.value);
          logDetail = `customer bill balance ${billBalance.value.toFixed(2)}`;
        }
      }

      // FALLBACK: order items minus payments on the reservation account. Only used when
      // customer bill lookup is unavailable. Clamp paid amount at 0 so refunds (negative
      // "Charged" payments) don't double-count as additional gæld.
      if (owing === null) {
        const orderItems = await this.mewsClient.getOrderItems([reservation.pmsId]);
        const totalAmount = orderItems.reduce((sum, item) => sum + item.Amount.GrossValue, 0);

        const payments = await this.mewsClient.getPayments([reservation.pmsId]);
        const rawPaidAmount = payments
          .filter(p => p.State === "Charged")
          .reduce((sum, p) => sum + (p.Amount?.GrossValue || 0), 0);
        // Negative rawPaidAmount means refunds exceed payments — treat as "no net paid"
        // rather than adding to the balance.
        const paidAmount = Math.max(0, rawPaidAmount);

        owing = Math.max(0, totalAmount - paidAmount);
        logDetail = `order items ${totalAmount.toFixed(2)} - payments ${paidAmount.toFixed(2)} (raw ${rawPaidAmount.toFixed(2)})`;
      }

      const owingStr = owing.toFixed(2);

      // Always update the stored balance when refreshing
      const previousOwing = reservation.owing;
      const previousOwingNum = parseFloat(previousOwing || "0") || 0;
      const newOwingNum = owing;
      if (owingStr !== previousOwing) {
        await this.storage.updateReservation(reservation.id, { owing: owingStr });
        await this.storage.createLog({
          level: "info",
          message: `Updated outstanding balance: ${owingStr} (${logDetail}, previous: ${previousOwing || "0"})`,
          source: "checkin",
          reservationId: reservation.id,
        });

        // Dispatch PIN lifecycle events on owing transitions so TTLock stays in sync
        // with payment state — even when the change is detected outside the MEWS poller.
        if (this.automationEngine && reservation.generatedPin) {
          const pinLifecycle = this.automationEngine.getPinLifecycle();
          const freshReservation = (await this.storage.getReservation(reservation.id)) || reservation;
          try {
            if (previousOwingNum <= 0 && newOwingNum > 0) {
              await pinLifecycle.onPaymentRequired(freshReservation);
            } else if (previousOwingNum > 0 && newOwingNum <= 0) {
              await pinLifecycle.onPaymentCleared(freshReservation);
            }
          } catch (pinError) {
            await this.storage.createLog({
              level: "error",
              message: `Failed to dispatch PIN lifecycle event on owing transition: ${pinError}`,
              source: "checkin",
              reservationId: reservation.id,
            });
          }
        }
      }

      return { owing: owingStr, updated: owingStr !== previousOwing };
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Failed to calculate outstanding balance: ${error}`,
        source: "checkin",
        reservationId: reservation.id,
      });
      return { owing: reservation.owing || "0", updated: false };
    }
  }

  async checkPaymentStatus(reservation: Reservation): Promise<boolean> {
    if (!this.mewsClient) {
      await this.storage.createLog({
        level: "warn",
        message: "MEWS client not configured, assuming payment is complete",
        source: "checkin",
        reservationId: reservation.id,
      });
      return true;
    }

    try {
      const payments = await this.mewsClient.getPayments([reservation.pmsId]);
      const isPaid = this.mewsClient.isPaymentComplete(payments);
      
      await this.storage.createLog({
        level: "info",
        message: `Payment status check for reservation: ${isPaid ? "PAID" : "NOT PAID"}`,
        source: "checkin",
        reservationId: reservation.id,
        metadata: { paymentCount: payments.length, hasPaidPayment: isPaid },
      });

      return isPaid;
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Failed to check payment status: ${error}`,
        source: "checkin",
        reservationId: reservation.id,
      });
      return false;
    }
  }

  async requestPayment(reservation: Reservation): Promise<{ success: boolean; error?: string }> {
    if (!this.mewsClient) {
      return { success: false, error: "MEWS client not configured" };
    }

    if (!reservation.mewsCustomerId) {
      return { success: false, error: "No MEWS customer ID for reservation" };
    }

    const owingAmount = parseFloat(reservation.owing || "0");
    if (owingAmount <= 0) {
      return { success: false, error: "No outstanding amount to pay" };
    }

    try {
      const expirationDate = new Date();
      expirationDate.setDate(expirationDate.getDate() + 7);

      await this.mewsClient.createPaymentRequest(
        reservation.mewsCustomerId,
        owingAmount,
        reservation.currency || "EUR",
        reservation.pmsId,
        `Payment for reservation ${reservation.confirmationCode || reservation.pmsId}`,
        expirationDate.toISOString()
      );

      await this.storage.updateReservation(reservation.id, {
        preCheckinStatus: "awaiting_payment",
      });

      await this.storage.createLog({
        level: "info",
        message: `Payment request created for amount ${owingAmount} ${reservation.currency || "EUR"}`,
        source: "checkin",
        reservationId: reservation.id,
      });

      return { success: true };
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Failed to create payment request: ${error}`,
        source: "checkin",
        reservationId: reservation.id,
      });
      return { success: false, error: String(error) };
    }
  }

  async initiateCheckIn(token: string, options?: { guestSubmittedId?: boolean }): Promise<CheckInResult> {
    const reservation = await this.getReservationByToken(token);
    
    if (!reservation) {
      return {
        success: false,
        status: "error",
        message: "Reservation not found or invalid check-in link",
      };
    }

    // Check if room has lock assignments - no point in check-in without locks
    // Also fetch door name for display name composition
    let roomLabel: string | null = null;
    if (reservation.roomId) {
      const room = await this.storage.getRoom(reservation.roomId);
      const lockAssignments = await this.storage.getRoomLockAssignments(reservation.roomId);
      const hasRoomLock = lockAssignments.some(a => a.lockDevice.lockType === "room");
      if (!hasRoomLock) {
        return {
          success: false,
          status: "error",
          message: "Your room does not have digital locks configured yet. Please contact the front desk for assistance.",
        };
      }
      // Use lock's doorName only (no room.label fallback)
      const roomLock = lockAssignments.find(a => a.lockDevice.lockType === "room");
      roomLabel = roomLock?.lockDevice.doorName || null;
    }

    if (reservation.preCheckinStatus === "code_sent" && reservation.codeDeliveredAt) {
      return {
        success: true,
        status: "already_sent",
        message: "Access code has already been sent to your email/phone",
        reservation: this.formatReservation(reservation, roomLabel),
        passcode: reservation.generatedPin || undefined,
      };
    }

    if (!this.isWithin24HoursOfArrival(reservation)) {
      const arrival = new Date(reservation.arrival);
      return {
        success: false,
        status: "too_early",
        message: `Online check-in is available 24 hours before arrival. Your arrival is scheduled for ${arrival.toLocaleDateString()}`,
        reservation: this.formatReservation(reservation, roomLabel),
      };
    }

    // Always refresh outstanding balance from MEWS — this is the source of truth.
    // Previously we relied on checkPaymentStatus() which returned true if ANY payment
    // had been charged, but that ignored new charges added after the original payment
    // (e.g. extra night, tourist tax, consumption). The owing field reflects the
    // current net balance and correctly blocks check-in when a new charge appears.
    const balanceResult = await this.ensureOutstandingBalance(reservation, true);
    const freshReservation = await this.storage.getReservation(reservation.id) || reservation;
    const owingAmount = parseFloat(balanceResult.owing);
    const isPaid = owingAmount <= 0;

    if (isPaid) {
      await this.storage.createLog({
        level: "info",
        message: `Outstanding balance is ${balanceResult.owing} — treating as paid`,
        source: "checkin",
        reservationId: freshReservation.id,
      });

      await this.storage.updateReservation(freshReservation.id, {
        preCheckinStatus: "paid",
        paymentVerifiedAt: new Date(),
      });

      const sendResult = await this.sendAccessCode(freshReservation, { guestSubmittedId: options?.guestSubmittedId });
      const updatedReservation = await this.storage.getReservation(freshReservation.id);

      // Handle notification failure - show PIN to guest on screen
      if (sendResult.notificationFailed) {
        return {
          success: true,
          status: "notification_failed",
          message: "We couldn't send the code to your email/phone, but here is your access code:",
          reservation: this.formatReservation(updatedReservation || freshReservation, roomLabel),
          passcode: updatedReservation?.generatedPin || freshReservation.generatedPin || undefined,
          notificationFailed: true,
        };
      }

      if (sendResult.success) {
        return {
          success: true,
          status: "paid",
          message: "Your access code has been sent! You'll be able to use it from your check-in time.",
          reservation: this.formatReservation(updatedReservation || freshReservation, roomLabel),
          passcode: updatedReservation?.generatedPin || freshReservation.generatedPin || undefined,
        };
      }

      return {
        success: false,
        status: "error",
        message: sendResult.error || "Failed to send access code",
        reservation: this.formatReservation(freshReservation, roomLabel),
      };
    }

    // Unpaid path: clear any stale paid state, then create a MEWS payment request.
    if (freshReservation.preCheckinStatus === "paid" || freshReservation.paymentVerifiedAt) {
      await this.storage.updateReservation(freshReservation.id, {
        preCheckinStatus: "awaiting_payment",
        paymentVerifiedAt: null,
      });
      await this.storage.createLog({
        level: "info",
        message: `New outstanding balance ${balanceResult.owing} detected — resetting pre-checkin status to awaiting_payment`,
        source: "checkin",
        reservationId: freshReservation.id,
      });
    }

    // Automatically create payment request when there is an outstanding balance
    if (freshReservation.mewsCustomerId && owingAmount > 0) {
      const paymentResult = await this.requestPayment(freshReservation);
      if (paymentResult.success) {
        await this.storage.createLog({
          level: "info",
          message: "Payment request automatically created during check-in attempt",
          source: "checkin",
          reservationId: freshReservation.id,
        });
        const refreshed = await this.storage.getReservation(freshReservation.id) || freshReservation;
        return {
          success: false,
          status: "awaiting_payment",
          message: `Payment of ${balanceResult.owing} ${freshReservation.currency || "EUR"} is required before check-in. A payment link has been sent to your email.`,
          reservation: this.formatReservation(refreshed, roomLabel),
          paymentRequestSent: true,
        };
      }
    }

    return {
      success: false,
      status: "awaiting_payment",
      message: `Payment of ${balanceResult.owing} ${freshReservation.currency || "EUR"} is required before check-in. Please complete your payment.`,
      reservation: this.formatReservation(freshReservation, roomLabel),
    };
  }

  async hasLocksConfigured(reservation: Reservation): Promise<boolean> {
    if (!reservation.roomId) return false;
    const lockAssignments = await this.storage.getRoomLockAssignments(reservation.roomId);
    return lockAssignments.some(a => a.lockDevice.lockType === "room");
  }

  async sendAccessCode(reservation: Reservation, options?: { guestSubmittedId?: boolean }): Promise<{ success: boolean; error?: string; mewsSyncFailed?: boolean; notificationFailed?: boolean }> {
    if (!this.automationEngine) {
      return { success: false, error: "Automation engine not configured" };
    }

    if (!await this.hasLocksConfigured(reservation)) {
      return { success: false, error: "Room does not have digital locks configured" };
    }

    const requireIdSetting = await this.storage.getSetting("require_id_for_checkin");
    if (requireIdSetting?.value === "true") {
      const guestName = `${reservation.firstName} ${reservation.lastName}`;
      if (options?.guestSubmittedId) {
        console.log(`[CheckIn] Guest ${guestName} just submitted ID via pre-check-in form - skipping MEWS ID check`);
      } else {
        if (!this.mewsClient || !reservation.mewsCustomerId) {
          console.log(`[CheckIn] Guest ${guestName} - cannot verify ID (MEWS client or customerId missing) - digital key blocked`);
          await this.storage.createLog({
            level: "warn",
            message: `Digital key blocked for ${guestName}: Cannot verify ID - MEWS client or customerId missing`,
            source: "checkin",
            reservationId: reservation.id,
          });
          return { success: false, error: "Cannot verify guest ID - MEWS connection or customer ID missing" };
        }
        try {
          const idDocs = await this.mewsClient.getIdentityDocuments([reservation.mewsCustomerId]);
          if (!idDocs || idDocs.length === 0) {
            console.log(`[CheckIn] Guest ${guestName} has no ID document in MEWS - digital key blocked`);
            await this.storage.createLog({
              level: "info",
              message: `Digital key blocked for ${guestName}: No ID document registered in MEWS`,
              source: "checkin",
              reservationId: reservation.id,
            });
            return { success: false, error: "Guest has no ID document registered in MEWS. ID verification required before digital key can be sent." };
          }
        } catch (idError) {
          const idErrorMsg = idError instanceof Error ? idError.message : String(idError);
          console.error(`[CheckIn] ID document check failed: ${idErrorMsg}`);
          await this.storage.createLog({
            level: "warn",
            message: `ID document check failed: ${idErrorMsg} - digital key blocked`,
            source: "checkin",
            reservationId: reservation.id,
          });
          return { success: false, error: `ID document verification failed: ${idErrorMsg}` };
        }
      }
    }

    try {
      // Only proceed for rooms that are mapped to a lock.
      // Unmapped rooms are intentional — skip the entire check-in flow silently.
      if (reservation.roomId) {
        const [lockAssignments, room] = await Promise.all([
          this.storage.getRoomLockAssignments(reservation.roomId),
          this.storage.getRoom(reservation.roomId),
        ]);
        const hasLock = lockAssignments.some(a => a.lockDevice.lockType === "room");
        if (!hasLock) {
          await this.storage.createLog({
            level: "info",
            message: `Check-in skipped: room has no lock configured`,
            source: "checkin",
            reservationId: reservation.id,
            metadata: { roomId: reservation.roomId },
          });
          return { success: false, error: "Room is not mapped to a lock" };
        }
      } else {
        return { success: false, error: "Reservation has no room assigned" };
      }

      // Step 1: Generate PIN with status="pending" (NO TTLock push)
      // Uses PinLifecycleService which enforces room mapping + MEWS sync (once only)
      let freshReservation = reservation;
      if (!reservation.generatedPin) {
        try {
          await this.automationEngine.getPinLifecycle().onReservationCreated(reservation);
        } catch (error) {
          return { success: false, error: `Failed to generate PIN: ${error instanceof Error ? error.message : String(error)}` };
        }
        freshReservation = await this.storage.getReservation(reservation.id) || reservation;
        if (!freshReservation.generatedPin) {
          return { success: false, error: "Room is not mapped — cannot generate PIN" };
        }
      }

      // Step 1b: Check if this is a late same-day arrival (after arrival time has passed)
      // If so, immediately activate the PIN instead of waiting for the scheduler
      // BUT: If check_in_method is "physical_required", don't auto-activate - wait for kiosk check-in
      const checkInMethodSetting = await this.storage.getSetting("check_in_method");
      const checkInMethod = checkInMethodSetting?.value || "door_unlock";
      
      const isLateArrival = await this.automationEngine.isLateSameDayArrival(freshReservation.id);
      if (isLateArrival && checkInMethod !== "physical_required") {
        await this.storage.createLog({
          level: "info",
          message: "Late same-day arrival detected - immediately activating PIN",
          source: "checkin",
          reservationId: freshReservation.id,
        });
        
        const activationResult = await this.automationEngine.getPinLifecycle().activatePendingForReservation(freshReservation.id);
        if (!activationResult.success) {
          await this.storage.createLog({
            level: "warn",
            message: `Immediate PIN activation failed: ${activationResult.error}`,
            source: "checkin",
            reservationId: freshReservation.id,
          });
          // Continue anyway - PIN is generated, just not activated yet
        }

        // Verify-before-send (21/7 lesson): this branch is a SAME-DAY arrival —
        // the guest may be standing at the door when the message lands. We
        // still send (the boarding pass carries remote-unlock and the code
        // may propagate shortly), but if the code is confirmed on ZERO locks
        // right now, escalate so staff can act before the guest is stranded.
        const pinsForRes = await this.storage.getPinsByReservationId(freshReservation.id);
        const parseEntries = (v: unknown): any[] => {
          let value = v as any;
          if (typeof value === "string") {
            try { value = JSON.parse(value); } catch { return []; }
          }
          return Array.isArray(value) ? value : [];
        };
        const confirmedOnAnyLock = pinsForRes.some(p =>
          (p.status === "active" || p.status === "used") &&
          parseEntries(p.roomLockKeyIds).length + parseEntries(p.commonAreaKeyIds).length > 0
        );
        if (!confirmedOnAnyLock) {
          await this.storage.createLog({
            level: "error",
            message: `Access code sent UNVERIFIED to ${freshReservation.firstName} ${freshReservation.lastName} — same-day arrival, code confirmed on 0 locks`,
            source: "checkin",
            reservationId: freshReservation.id,
          });
          // Shared alert key (not per-reservation): avoids unbounded settings
          // growth; different guests still alert immediately (critical +
          // changed content bypasses the dedupe window).
          await sendOpsAlert(
            this.storage as any,
            "unverified-send",
            "critical",
            `Dørkode sendt UVERIFICERET til ${freshReservation.firstName} ${freshReservation.lastName} (samme-dags ankomst)`,
            `Koden er ikke bekræftet på nogen lås. Gæsten kan bruge remote-unlock, men tjek gateway/låse NU.`
          );
        }
      } else if (isLateArrival && checkInMethod === "physical_required") {
        await this.storage.createLog({
          level: "info",
          message: "Late same-day arrival detected but check_in_method is 'physical_required' - PIN will be activated at kiosk check-in",
          source: "checkin",
          reservationId: freshReservation.id,
        });
      }

      // Step 2: Send digital key via ALL available channels (email + SMS + WhatsApp)
      const testPhoneSetting = await this.storage.getSetting("boarding_test_phone");
      const recipientMobile = testPhoneSetting?.value || freshReservation.mobile || null;
      const hasEmail = !!(freshReservation.personalEmail || freshReservation.email);
      const hasMobile = !!recipientMobile;

      if (hasEmail || hasMobile) {
        const emailResult = hasEmail ? await this.sendBoardingPassEmail(freshReservation) : { success: false, error: "No email" };

        let smsResult: { success: boolean; error?: string } = { success: false, error: "Not attempted" };
        let whatsappResult: { success: boolean; error?: string } = { success: false, error: "Not attempted" };

        if (hasMobile) {
          const notifClient = await createNotificationClient(this.storage);

          if (notifClient.isTwilioConfigured()) {
            const appUrlSetting = await this.storage.getSetting("app_base_url");
            const baseUrl = appUrlSetting?.value
              || (process.env.REPLIT_DEPLOYMENT_DOMAIN ? `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}` : "https://dreamboks.com");
            const hotelNameSetting = await this.storage.getSetting("hotel_name");
            const hotelNameVal = hotelNameSetting?.value || "Copenhagen Downtown Hostel";
            const hotelSlug = (await this.storage.getSetting("hotel_slug"))?.value;
            const boardingPassUrl = buildBoardingPassUrl(baseUrl, freshReservation, hotelSlug);

            smsResult = await notifClient.sendBoardingPassSMS({
              mobile: recipientMobile!,
              guestName: `${freshReservation.firstName} ${freshReservation.lastName}`,
              boardingPassUrl,
              hotelName: hotelNameVal,
            });
            whatsappResult = await notifClient.sendBoardingPassWhatsApp({
              mobile: recipientMobile!,
              guestName: `${freshReservation.firstName} ${freshReservation.lastName}`,
              boardingPassUrl,
              hotelName: hotelNameVal,
            });
          }
        }

        const anyDelivered = emailResult.success || smsResult.success || whatsappResult.success;

        if (anyDelivered) {
          await this.storage.updateReservation(reservation.id, {
            preCheckinStatus: "code_sent",
            codeDeliveredAt: new Date(),
            notificationSent: true,
          });

          const deliveredChannels = [
            emailResult.success ? "email" : null,
            smsResult.success ? "sms" : null,
            whatsappResult.success ? "whatsapp" : null,
          ].filter(Boolean).join("+");

          await this.storage.createLog({
            level: "info",
            message: `Digital key sent via ${deliveredChannels} (PIN pending activation)`,
            source: "checkin",
            reservationId: reservation.id,
            metadata: { 
              channels: deliveredChannels,
              pinStatus: "pending",
            },
          });

          return { success: true };
        } else {
          await this.storage.updateReservation(reservation.id, {
            preCheckinStatus: "notification_failed",
          });

          const allErrors = [emailResult.error, smsResult.error, whatsappResult.error].filter(e => e && e !== "Not attempted").join("; ");
          await this.storage.createLog({
            level: "error",
            message: `Digital key delivery failed: ${allErrors}`,
            source: "checkin",
            reservationId: reservation.id,
          });

          return { 
            success: false,
            error: allErrors,
            notificationFailed: true,
          };
        }
      } else {
        await this.storage.updateReservation(reservation.id, {
          preCheckinStatus: "code_sent",
          codeDeliveredAt: new Date(),
          notificationSent: true,
        });
        
        await this.storage.createLog({
          level: "warn",
          message: "No email or phone for guest - PIN generated but no digital key sent",
          source: "checkin",
          reservationId: reservation.id,
        });

        return { success: true };
      }
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Failed to send access code: ${error}`,
        source: "checkin",
        reservationId: reservation.id,
      });
      return { success: false, error: String(error) };
    }
  }

  private formatReservation(reservation: Reservation, roomLabelOrDoorName?: string | null) {
    const baseRoom = reservation.room || reservation.assignedSpace;
    // If roomLabelOrDoorName looks like a full door name (set from lock.doorName),
    // it is used as the full display name directly (not concatenated with room number)
    // The caller sets this to lock.doorName ?? room.label
    const roomDisplay = roomLabelOrDoorName || (baseRoom ?? null);
    return {
      id: reservation.id,
      guestName: `${reservation.firstName} ${reservation.lastName}`,
      arrival: reservation.arrival,
      departure: reservation.departure,
      room: roomDisplay,
      email: reservation.email,
      owing: reservation.owing,
      currency: reservation.currency,
    };
  }

  private async sendBoardingPassEmail(reservation: Reservation): Promise<{ success: boolean; error?: string }> {
    try {
      const notificationClient = await createNotificationClient(this.storage);

      const appUrlSetting = await this.storage.getSetting("app_base_url");
      const baseUrl = appUrlSetting?.value
        ? appUrlSetting.value
        : process.env.REPLIT_DEPLOYMENT_DOMAIN
        ? `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}`
        : "https://dreamboks.com";

      const testEmailSetting = await this.storage.getSetting("boarding_test_email");
      const recipientEmail = testEmailSetting?.value || reservation.personalEmail || reservation.email!;
      const hotelSlug = (await this.storage.getSetting("hotel_slug"))?.value;

      const result = await notificationClient.sendBoardingPassEmail({
        email: recipientEmail,
        guestName: `${reservation.firstName} ${reservation.lastName}`,
        reservationNumber: reservation.extId || reservation.confirmationCode || String(reservation.id),
        reservationId: reservation.id,
        lastName: reservation.lastName,
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
        baseUrl,
        hotelSlug,
        accessCode: reservation.generatedPin,
      });

      if (result.success) {
        const isTestMode = !!testEmailSetting?.value;
        await this.storage.createLog({
          level: "info",
          message: isTestMode
            ? `Digital key email sent to TEST address (${recipientEmail}) for guest ${reservation.firstName} ${reservation.lastName}`
            : "Digital key email sent to guest",
          source: "checkin",
          reservationId: reservation.id,
          metadata: { email: recipientEmail, guestEmail: reservation.email, testMode: isTestMode, baseUrl },
        });
        return { success: true };
      } else {
        await this.storage.createLog({
          level: "warn",
          message: `Failed to send digital key email: ${result.error}`,
          source: "checkin",
          reservationId: reservation.id,
        });
        return { success: false, error: result.error };
      }
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Error sending digital key email: ${error}`,
        source: "checkin",
        reservationId: reservation.id,
      });
      return { success: false, error: String(error) };
    }
  }
}
