/**
 * ReservationStateMachine
 *
 * Central orchestration layer replacing:
 *   - ingestion-processor.ts
 *   - auto-checkin-scheduler.ts
 *   - checkin-service.ts (scheduled parts)
 *   - pin-activation-scheduler.ts
 *   - noshow-scheduler.ts
 *
 * Rule: If MEWS status = Checked-in → access is activated immediately, always.
 * No physical_required mode.
 */

import { ITenantStorage, TenantlessReservationInput } from "./storage";
import { config } from "./config";
import { renderDoorCodeTemplate } from "@shared/door-code-template";
import { appendHotelSlug, buildBoardingPassUrl } from "@shared/boarding-pass-url";
import { AutomationEngine } from "./automation";
import { MewsClient } from "./mews-client";
import { createNotificationClient } from "./notification-client";
import { buildPreCheckinUrl } from "./pre-checkin-url";
import { buildValidityWindow } from "./pin-validity-window";
import { sendOpsAlert } from "./ops-alert";
import { getSpaceDisplayName } from "@shared/display-name";
import { mapNormalizedStatusToInternal } from "./ingestion";
import { DateTime } from "luxon";
import type { Reservation, Pin, LockDevice } from "@shared/schema";

// Normalized unlock record pushed by the TTLock callback (fields optional —
// the push payload format is undocumented, so everything is parsed defensively).
export interface WebhookUnlockRecord {
  recordType?: number;
  success?: number | boolean;
  keyboardPwd?: string;
  lockDate?: number;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface ReservationUpsertedEvent {
  tenantId: string;
  pmsReservationId: string;
  status: "Confirmed" | "CheckedIn" | "CheckedOut" | "Cancelled";
  firstName: string;
  lastName: string;
  email?: string;
  mobile?: string;
  arrival: string;
  departure: string;
  roomPmsId?: string;
  adults?: number;
  children?: number;
  groupName?: string;
  requestedCategory?: string;
  spaceCategory?: string;
  assignedSpace?: string;
  rateName?: string;
  avgRate?: number;
  totalAmount?: number;
  origin?: string;
  reservationSource?: string;
  mewsCustomerId?: string;
  confirmationCode?: string;
  owing?: string;
}

export interface StatusChangedEvent {
  tenantId: string;
  pmsReservationId: string;
  newStatus: "Confirmed" | "CheckedIn" | "CheckedOut" | "Cancelled";
  previousStatus?: string;
}

export interface RoomChangedEvent {
  tenantId: string;
  pmsReservationId: string;
  newRoomPmsId: string;
}

export interface StayDatesChangedEvent {
  tenantId: string;
  pmsReservationId: string;
  newArrival: string;
  newDeparture: string;
  arrivalChanged?: boolean;
  departureChanged?: boolean;
}

export interface RemoteUnlockEvent {
  tenantId: string;
  reservationId: string;
  lockTtlockId: string;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export class ReservationStateMachine {
  // Throttle repeated "boarding card blocked" logs — reset hourly
  private boardingCardBlockedLoggedAt = new Map<string, number>();
  // Cooldown after notification delivery failure — retry after 30 min, not every minute
  private notificationFailedAt = new Map<string, number>();
  private static NOTIFICATION_RETRY_COOLDOWN = 30 * 60 * 1000; // 30 minutes
  // Max pre-check-in send attempts before giving up (guest unreachable on every channel).
  // At the 60s job cadence this stops the retry after ~5 minutes instead of forever.
  private static MAX_PRECHECKIN_ATTEMPTS = 5;
  // Capsule door-code mode: single send, 23h before check-in.
  private static DOOR_CODE_ADVANCE_MS = 23 * 60 * 60 * 1000;
  private static MAX_DOOR_CODE_ATTEMPTS = 5;

  constructor(
    private storage: ITenantStorage,
    private automationEngine: AutomationEngine,
    private mewsClient: MewsClient | null,
    private tenantId: string
  ) {}

  // -------------------------------------------------------------------------
  // Guard helpers
  // -------------------------------------------------------------------------

  private async isRoomMapped(roomId: string): Promise<boolean> {
    return this.storage.isRoomMapped(roomId);
  }

  private async isPinCreated(reservationId: string, roomId: string): Promise<boolean> {
    const pins = await this.storage.getPinsByRoomId(roomId);
    return pins.some(p => p.reservationId === reservationId && ["pending", "active", "used"].includes(p.status));
  }

  private async isPinActive(reservationId: string, roomId: string): Promise<boolean> {
    const pins = await this.storage.getPinsByRoomId(roomId);
    return pins.some(p => p.reservationId === reservationId && p.status === "active");
  }

  private async isLateArrival(reservation: Reservation): Promise<boolean> {
    return this.automationEngine.isLateSameDayArrival(reservation.id);
  }

  private async isPaymentOk(reservation: Reservation): Promise<boolean> {
    try {
      const checkinService = await this.getCheckinService();
      const { owing } = await checkinService.ensureOutstandingBalance(reservation, true);
      return parseFloat(owing) <= 0;
    } catch {
      return false;
    }
  }

  private async isIdVerified(reservation: Reservation): Promise<boolean> {
    const requireIdSetting = await this.storage.getSetting("require_id_for_checkin");
    if (requireIdSetting?.value !== "true") return true;
    if (!this.mewsClient || !reservation.mewsCustomerId) return false;
    try {
      const docs = await this.mewsClient.getIdentityDocuments([reservation.mewsCustomerId]);
      return docs.length > 0;
    } catch {
      // API error ≠ no ID — don't block
      return true;
    }
  }

  // -------------------------------------------------------------------------
  // Lazy imports to avoid circular deps
  // -------------------------------------------------------------------------

  private async getCheckinService() {
    const { CheckInService } = await import("./checkin-service");
    return new CheckInService(this.storage, this.mewsClient, this.automationEngine);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async createPin(reservation: Reservation): Promise<boolean> {
    try {
      // Use pin-lifecycle so MEWS note is always sent on first creation
      await this.automationEngine.getPinLifecycle().onReservationCreated(reservation);
      // Check if a new actionable pin was actually created — do NOT use generatedPin,
      // which may be stale from a previous room assignment.
      const pins = await this.storage.getPinsByReservationId(reservation.id);
      return pins.some(p => ["pending", "active", "used"].includes(p.status));
    } catch {
      return false;
    }
  }

  /** Push pending PIN to TTLock and add note to MEWS. Core rule: MEWS checked-in → always activate. */
  private async activatePin(reservation: Reservation): Promise<boolean> {
    const result = await this.automationEngine.immediatelyActivatePendingPin(reservation.id);
    return result.success || result.alreadyActive === true;
  }

  /** Returns "blocked" when the in-house guard refused the revocation. */
  private async deletePin(reservation: Reservation): Promise<boolean | "blocked"> {
    return await this.automationEngine.deletePasscodeForReservation(reservation.id);
  }

  private async sendPrecheckinMail(reservation: Reservation): Promise<boolean> {
    try {
      // Defensive re-check: bail out if another concurrent run already sent this.
      // Prevents the duplicate-send pattern seen when two runScheduledJobs executions
      // operate on the same snapshot before preCheckinEmailSent is flipped.
      const latest = await this.storage.getReservation(reservation.id);
      if (latest?.preCheckinEmailSent) return false;
      reservation = latest ?? reservation;

      const notifClient = await createNotificationClient(this.storage);
      const testEmailSetting = await this.storage.getSetting("boarding_test_email");
      const testPhoneSetting = await this.storage.getSetting("boarding_test_phone");
      const hotelNameSetting = await this.storage.getSetting("hotel_name");
      const hotelSlugSetting = await this.storage.getSetting("hotel_slug");
      const appUrlSetting = await this.storage.getSetting("app_base_url");
      const timezoneSetting = await this.storage.getSetting("property_timezone");
      const timezone = timezoneSetting?.value || "Europe/Copenhagen";

      const hotelName = hotelNameSetting?.value || config.defaultHotelName;
      const baseUrl = appUrlSetting?.value || config.appBaseUrl;
      const checkInUrl = buildPreCheckinUrl({
        baseUrl,
        hotelSlug: hotelSlugSetting?.value,
        preCheckinToken: reservation.preCheckinToken,
      });

      const guestEmail = testEmailSetting?.value || reservation.personalEmail || reservation.email || undefined;
      const guestMobile = testPhoneSetting?.value || reservation.mobile || undefined;

      if (!guestEmail && !guestMobile) return false;

      // Generate pre-checkin token if missing
      if (!reservation.preCheckinToken) {
        const checkinService = await this.getCheckinService();
        const token = checkinService.generatePreCheckinToken();
        await this.storage.updateReservation(reservation.id, { preCheckinToken: token });
        reservation = (await this.storage.getReservation(reservation.id)) || reservation;
      }

      if (!reservation.generatedPin) {
        await this.storage.createLog({
          level: "warn",
          message: `Pre-checkin email skipped — no PIN generated yet`,
          source: "state-machine",
          reservationId: reservation.id,
        });
        return false;
      }
      const pin = reservation.generatedPin;
      const guestName = `${reservation.firstName} ${reservation.lastName}`;

      const arrivalDate = DateTime.fromJSDate(new Date(reservation.arrival), { zone: "utc" })
        .setZone(timezone)
        .toJSDate()
        .toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

      const departureDate = DateTime.fromJSDate(new Date(reservation.departure), { zone: "utc" })
        .setZone(timezone)
        .toJSDate()
        .toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

      const result = await notifClient.sendMultiChannel({
        channels: [...(guestEmail ? ["email" as const] : []), ...(guestMobile ? ["sms" as const, "whatsapp" as const] : [])],
        email: guestEmail,
        mobile: guestMobile,
        emailSender: guestEmail
          ? () => notifClient.sendPreCheckInPlainTextEmail({ email: guestEmail, guestName, hotelName, checkInUrl, arrivalDate, departureDate })
          : () => Promise.resolve({ success: false }),
        smsSender: guestMobile
          ? () => notifClient.sendPreCheckInSMS({ mobile: guestMobile, pin, checkInUrl, hotelName })
          : () => Promise.resolve({ success: false }),
        whatsappSender: guestMobile
          ? () => notifClient.sendPreCheckInWhatsApp({ mobile: guestMobile, pin, checkInUrl, hotelName })
          : () => Promise.resolve({ success: false }),
      });

      const delivered = result.emailDelivered || result.smsDelivered || result.whatsappDelivered;

      if (delivered) {
        await this.storage.updateReservation(reservation.id, { preCheckinEmailSent: true });
        await this.storage.createLog({
          level: "info",
          message: `Pre-checkin sent to ${guestName}`,
          source: "state-machine",
          reservationId: reservation.id,
        });
        // Note: MEWS sync is NOT done here — PIN was already synced to MEWS at reservation creation
      } else {
        // Nothing delivered on any channel — count the attempt so we stop retrying every
        // minute. After MAX_PRECHECKIN_ATTEMPTS we give up (the guest is unreachable) and
        // log it once so staff can reach out manually.
        const attempts = (reservation.preCheckinAttempts ?? 0) + 1;
        await this.storage.updateReservation(reservation.id, { preCheckinAttempts: attempts });
        if (attempts >= ReservationStateMachine.MAX_PRECHECKIN_ATTEMPTS) {
          await this.storage.createLog({
            level: "warn",
            message: `Pre-checkin gave up for ${guestName} after ${attempts} failed attempts (all channels unreachable) — handle at reception. Errors: ${result.errors.join("; ")}`,
            source: "state-machine",
            reservationId: reservation.id,
            metadata: { attempts, errors: result.errors },
          });
        }
      }

      return delivered;
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Pre-checkin send failed: ${error instanceof Error ? error.message : String(error)}`,
        source: "state-machine",
        reservationId: reservation.id,
      });
      return false;
    }
  }

  private async sendBoardingCard(reservation: Reservation): Promise<boolean> {
    try {
      const checkinService = await this.getCheckinService();
      const result = await checkinService.sendAccessCode(reservation);
      if (result.notificationFailed) {
        // Track failure time — scheduler will skip this reservation for 30 min
        this.notificationFailedAt.set(reservation.id, Date.now());
        return true; // Don't block the flow, PIN is still generated
      }
      if (result.success) {
        // Clear any previous failure cooldown
        this.notificationFailedAt.delete(reservation.id);
      }
      return result.success;
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Boarding card send failed: ${error instanceof Error ? error.message : String(error)}`,
        source: "state-machine",
        reservationId: reservation.id,
      });
      return false;
    }
  }

  private async sendUpdateNotification(reservation: Reservation, reason: string = "Room change"): Promise<void> {
    try {
      const notifClient = await createNotificationClient(this.storage);
      const testEmailSetting = await this.storage.getSetting("boarding_test_email");
      const testPhoneSetting = await this.storage.getSetting("boarding_test_phone");
      const hotelNameSetting = await this.storage.getSetting("hotel_name");
      const appUrlSetting = await this.storage.getSetting("app_base_url");

      const hotelName = hotelNameSetting?.value || config.defaultHotelName;
      const baseUrl = appUrlSetting?.value || config.appBaseUrl;
      const hotelSlug = (await this.storage.getSetting("hotel_slug"))?.value;

      const timezoneSetting = await this.storage.getSetting("timezone");
      const timezone = timezoneSetting?.value || "Europe/Copenhagen";

      const resIdentifier = reservation.extId || reservation.confirmationCode;
      const boardingPassUrl = buildBoardingPassUrl(baseUrl, reservation, hotelSlug);

      const arrivalDate = DateTime.fromJSDate(new Date(reservation.arrival), { zone: "utc" })
        .setZone(timezone)
        .toJSDate()
        .toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

      const departureDate = DateTime.fromJSDate(new Date(reservation.departure), { zone: "utc" })
        .setZone(timezone)
        .toJSDate()
        .toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

      const guestEmail = testEmailSetting?.value || reservation.personalEmail || reservation.email;
      const guestMobile = testPhoneSetting?.value || reservation.mobile;
      const guestName = `${reservation.firstName} ${reservation.lastName}`;

      if (guestEmail) {
        await notifClient.sendBoardingPassEmail({
          email: guestEmail,
          guestName,
          reservationNumber: resIdentifier!,
          reservationId: reservation.id,
          lastName: reservation.lastName,
          arrivalDate,
          departureDate,
          baseUrl,
          hotelSlug,
          accessCode: reservation.generatedPin,
        });
      }

      if (guestMobile) {
        await notifClient.sendBoardingPassSMS({ mobile: guestMobile, guestName, boardingPassUrl, hotelName });
        await notifClient.sendBoardingPassWhatsApp({ mobile: guestMobile, guestName, boardingPassUrl, hotelName });
      }

      await this.storage.createLog({
        level: "info",
        message: `${reason} boarding card sent to ${guestName}`,
        source: "state-machine",
        reservationId: reservation.id,
      });
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `${reason} notification failed: ${error instanceof Error ? error.message : String(error)}`,
        source: "state-machine",
        reservationId: reservation.id,
      });
    }
  }

  private async sendCancellationNotification(reservation: Reservation): Promise<void> {
    try {
      const notifClient = await createNotificationClient(this.storage);
      const testEmailSetting = await this.storage.getSetting("boarding_test_email");
      const testPhoneSetting = await this.storage.getSetting("boarding_test_phone");
      const hotelNameSetting = await this.storage.getSetting("hotel_name");

      const hotelName = hotelNameSetting?.value || config.defaultHotelName;
      const guestEmail = testEmailSetting?.value || reservation.personalEmail || reservation.email;
      const guestMobile = testPhoneSetting?.value || reservation.mobile;
      const guestName = `${reservation.firstName} ${reservation.lastName}`;
      const resIdentifier = reservation.confirmationCode || reservation.extId || "";

      if (guestEmail) {
        await notifClient.sendCancellationEmail({
          email: guestEmail,
          guestName,
          reservationNumber: resIdentifier,
          hotelName,
        });
      }

      if (guestMobile) {
        const smsMessage = `${hotelName}: Your reservation ${resIdentifier} has been cancelled. Access codes deactivated. Contact reception if this is an error.`;
        await notifClient.sendWhatsApp({ to: guestMobile, message: smsMessage });
      }

      await this.storage.createLog({
        level: "info",
        message: `Cancellation notification sent to ${guestName}`,
        source: "state-machine",
        reservationId: reservation.id,
      });
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Cancellation notification failed: ${error instanceof Error ? error.message : String(error)}`,
        source: "state-machine",
        reservationId: reservation.id,
      });
    }
  }

  /** Returns true when MEWS accepted the check-in (or no MEWS client to talk to). */
  private async checkinInMews(reservation: Reservation): Promise<boolean> {
    if (!this.mewsClient || !reservation.pmsId) return true; // nothing to write back
    try {
      // startReservation NEVER throws — it swallows errors into {success:false}.
      // Ignoring that flag caused the Martinsen incident (16-17 July): every
      // MEWS rejection was treated as success, the guest was shown as checked
      // in locally while MEWS stayed Confirmed, and MEWS' 06:00 no-show audit
      // cancelled her → door codes removed while she was in the building.
      const result = await this.mewsClient.startReservation(reservation.pmsId);
      if (!result.success) {
        await this.storage.createLog({
          level: "warn",
          message: `MEWS check-in write-back failed: ${result.error || "unknown error"}`,
          source: "state-machine",
          reservationId: reservation.id,
        });
        return false;
      }
      await this.storage.updateReservation(reservation.id, { status: "Checked-in" });
      await this.storage.createLog({
        level: "info",
        message: `Auto check-in in MEWS via remote unlock`,
        source: "state-machine",
        reservationId: reservation.id,
      });
      return true;
    } catch (error) {
      await this.storage.createLog({
        level: "warn",
        message: `MEWS check-in write-back failed: ${error instanceof Error ? error.message : String(error)}`,
        source: "state-machine",
        reservationId: reservation.id,
      });
      return false;
    }
  }

  private async markNoshow(reservation: Reservation): Promise<void> {
    await this.storage.updateReservation(reservation.id, { status: "no-show" });
    await this.storage.createLog({
      level: "info",
      message: `Marked as no-show (PIN never used)`,
      source: "state-machine",
      reservationId: reservation.id,
    });
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  /**
   * New or updated reservation from MEWS (via poller or webhook).
   */
  async handleReservationUpserted(event: ReservationUpsertedEvent): Promise<void> {
    const { tenantId, pmsReservationId } = event;

    // Skip completed stays
    if (new Date(event.departure) < new Date()) return;
    if (event.status === "CheckedOut") return;

    const internalStatus = mapNormalizedStatusToInternal(event.status);
    const mappedRoom = event.roomPmsId ? await this.storage.getRoomByPmsId(event.roomPmsId) : null;
    const newRoomId = mappedRoom?.id;

    const existing = await this.storage.getReservationByPmsId(pmsReservationId);

    // Churn-breaker (26/7, Gogoua mail storm): never CREATE a reservation whose
    // pin validity window is already over. The raw-departure guard above can
    // pass (MEWS EndUtc later today) while the checkout-normalized window is in
    // the past — createPendingPin then refuses it, expiry cleanup deletes the
    // row, and the next poll re-creates it under a fresh id, forever. EXISTING
    // rows are exempt: a paid late checkout lives in OUR lateCheckoutUntil
    // column (invisible to this probe), and their updates must keep flowing.
    if (!existing) {
      const probe = await buildValidityWindow(this.storage, {
        arrival: new Date(event.arrival),
        departure: new Date(event.departure),
        earlyCheckinFrom: null,
        lateCheckoutUntil: null,
      } as Reservation);
      if (probe.validTo.getTime() <= Date.now()) return;
    }

    // Upsert reservation in DB
    let reservation: Reservation;
    if (!existing) {
      reservation = await this.storage.createReservation({
        pmsId: pmsReservationId,
        extId: pmsReservationId,
        status: internalStatus,
        firstName: event.firstName,
        lastName: event.lastName,
        email: event.email,
        mobile: event.mobile,
        arrival: new Date(event.arrival),
        departure: new Date(event.departure),
        roomId: newRoomId,
        adults: event.adults,
        children: event.children,
        groupName: event.groupName,
        requestedCategory: event.requestedCategory,
        spaceCategory: event.spaceCategory,
        assignedSpace: event.assignedSpace,
        rateName: event.rateName,
        avgRate: event.avgRate ? String(event.avgRate) : undefined,
        totalAmount: event.totalAmount ? String(event.totalAmount) : undefined,
        origin: event.origin,
        reservationSource: event.reservationSource,
        mewsCustomerId: event.mewsCustomerId,
        confirmationCode: event.confirmationCode,
        ...(event.owing != null ? { owing: event.owing } : {}),
      });
    } else {
      // Detect changes before updating
      const roomChanged =
        existing.generatedPin &&
        existing.roomId &&
        newRoomId &&
        existing.roomId !== newRoomId;

      const arrivalChanged =
        new Date(existing.arrival).getTime() !== new Date(event.arrival).getTime();
      const departureChanged =
        new Date(existing.departure).getTime() !== new Date(event.departure).getTime();
      const timesChanged =
        !!existing.generatedPin && (arrivalChanged || departureChanged);

      // Detect owing transitions (requires an existing generated PIN to matter)
      const oldOwing = parseFloat(existing.owing ?? "0") || 0;
      const newOwing = event.owing != null ? (parseFloat(event.owing) || 0) : oldOwing;
      const owingBecamePositive =
        !!existing.generatedPin && oldOwing <= 0 && newOwing > 0;
      const owingBecameCleared =
        !!existing.generatedPin && oldOwing > 0 && newOwing <= 0;

      // Update reservation fields (not roomId yet if room change — handled below)
      await this.storage.updateReservation(existing.id, {
        status: internalStatus,
        firstName: event.firstName,
        lastName: event.lastName,
        email: event.email,
        mobile: event.mobile,
        arrival: new Date(event.arrival),
        departure: new Date(event.departure),
        ...(roomChanged ? {} : { roomId: newRoomId }),
        adults: event.adults,
        children: event.children,
        mewsCustomerId: event.mewsCustomerId,
        ...(event.confirmationCode ? { confirmationCode: event.confirmationCode } : {}),
        ...(event.assignedSpace ? { assignedSpace: event.assignedSpace } : {}),
        ...(event.avgRate !== undefined ? { avgRate: String(event.avgRate) } : {}),
        ...(event.totalAmount !== undefined ? { totalAmount: String(event.totalAmount) } : {}),
        ...(event.owing != null ? { owing: event.owing } : {}),
      });

      reservation = (await this.storage.getReservation(existing.id))!;

      if (roomChanged && newRoomId) {
        await this.handleRoomChanged({
          tenantId,
          pmsReservationId,
          newRoomPmsId: event.roomPmsId!,
        });
        reservation = (await this.storage.getReservation(existing.id))!;
      }

      if (timesChanged) {
        await this.handleStayDatesChanged({
          tenantId,
          pmsReservationId,
          newArrival: event.arrival,
          newDeparture: event.departure,
          arrivalChanged,
          departureChanged,
        });
        reservation = (await this.storage.getReservation(existing.id))!;
      }

      if (owingBecamePositive) {
        await this.handleOwingChanged(reservation, "required");
        reservation = (await this.storage.getReservation(existing.id))!;
      } else if (owingBecameCleared) {
        await this.handleOwingChanged(reservation, "cleared");
        reservation = (await this.storage.getReservation(existing.id))!;
      }
    }

    // Stop here if room not mapped
    if (!reservation.roomId || !(await this.isRoomMapped(reservation.roomId))) {
      return;
    }

    // Handle status-specific logic
    if (internalStatus === "Checked-in") {
      await this._handleCheckedIn(reservation);
    } else if (internalStatus === "Cancelled" || internalStatus === "Checked-out") {
      const revoke = await this.deletePin(reservation);
      // In-house guard blocked the revoke: the guest keeps access, so the
      // "codes deactivated" SMS would be false — the ops-alert covers staff.
      if (revoke !== "blocked" && internalStatus === "Cancelled" && reservation.generatedPin) {
        await this.sendCancellationNotification(reservation);
      }
    }
    // "Confirmed" reservations: PIN is created by ingestion-processor via pin-lifecycle.
    // State machine must not race with that path.
  }

  /**
   * MEWS status changed event (webhook).
   * Core rule: Checked-in → activate PIN immediately.
   */
  async handleStatusChanged(event: StatusChangedEvent): Promise<void> {
    const reservation = await this.storage.getReservationByPmsId(event.pmsReservationId);
    if (!reservation) return;

    const internalStatus = mapNormalizedStatusToInternal(event.newStatus);

    // Guard: never downgrade a terminal status (Cancelled/Checked-out) back to
    // an active status. This prevents stale MEWS webhooks or poller events from
    // overwriting a Cancelled status — the root cause of the cancel loop bug
    // where DriftReconciler sets Cancelled but a concurrent _handleCheckedIn
    // re-activates the reservation every 60 seconds.
    const existingStatus = reservation.status;
    if (
      (existingStatus === "Cancelled" || existingStatus === "Checked-out") &&
      internalStatus !== "Cancelled" && internalStatus !== "Checked-out"
    ) {
      await this.storage.createLog({
        level: "warn",
        message: `Blocked status downgrade: DB=${existingStatus} → incoming=${event.newStatus}. Skipping.`,
        source: "state-machine",
        reservationId: reservation.id,
      });
      return;
    }

    await this.storage.updateReservation(reservation.id, { status: internalStatus });

    await this.storage.createLog({
      level: "info",
      message: `Status changed: ${event.previousStatus ?? "unknown"} → ${event.newStatus}`,
      source: "state-machine",
      reservationId: reservation.id,
    });

    const fresh = (await this.storage.getReservation(reservation.id))!;

    if (!fresh.roomId || !(await this.isRoomMapped(fresh.roomId))) {
      await this.storage.createLog({
        level: "info",
        message: `Status change ignored: room not mapped`,
        source: "state-machine",
        reservationId: fresh.id,
      });
      return;
    }

    if (internalStatus === "Checked-in") {
      await this._handleCheckedIn(fresh);
    } else if (internalStatus === "Cancelled" || internalStatus === "Checked-out") {
      const revoke = await this.deletePin(fresh);
      if (revoke !== "blocked" && internalStatus === "Cancelled" && fresh.generatedPin) {
        await this.sendCancellationNotification(fresh);
      }
    }
  }

  /**
   * Room changed in MEWS.
   */
  async handleRoomChanged(event: RoomChangedEvent): Promise<void> {
    const reservation = await this.storage.getReservationByPmsId(event.pmsReservationId);
    if (!reservation) return;

    const newRoom = await this.storage.getRoomByPmsId(event.newRoomPmsId);
    if (!newRoom) {
      await this.storage.createLog({
        level: "warn",
        message: `Room change: new room PMS ID ${event.newRoomPmsId} not found locally`,
        source: "state-machine",
        reservationId: reservation.id,
      });
      return;
    }

    const oldRoomId = reservation.roomId;
    const newRoomId = newRoom.id;

    if (oldRoomId === newRoomId) return;

    await this.storage.createLog({
      level: "info",
      message: `Room change: ${reservation.firstName} ${reservation.lastName} moving from ${oldRoomId ?? "unassigned"} to ${newRoom.name}`,
      source: "state-machine",
      reservationId: reservation.id,
      metadata: { oldRoomId, newRoomId },
    });

    const hadActiveAccess = reservation.generatedPin && oldRoomId
      ? await this.isPinActive(reservation.id, oldRoomId)
      : false;

    // Update roomId FIRST so PinLifecycleService sees the new room assignment
    await this.storage.updateReservation(reservation.id, {
      roomId: newRoomId,
      room: newRoom.name,
      assignedSpace: newRoom.name,
    });

    // Delegate room-change PIN logic to PinLifecycleService (replaces deprecated handleRoomChange)
    const freshReservation = await this.storage.getReservation(reservation.id);
    if (freshReservation) {
      try {
        await this.automationEngine.getPinLifecycle().onRoomChanged(freshReservation, oldRoomId ?? "", newRoomId);
      } catch (error) {
        await this.storage.createLog({
          level: "error",
          message: `Room change PIN migration failed: ${error instanceof Error ? error.message : String(error)}`,
          source: "state-machine",
          reservationId: reservation.id,
        });
        return;
      }
    }

    // If guest already had active access → send updated boarding card
    if (hadActiveAccess) {
      const fresh = (await this.storage.getReservation(reservation.id))!;
      await this.sendUpdateNotification(fresh, "Room change");
    }
  }

  /**
   * Arrival/departure dates changed in MEWS.
   *
   * Routes through PinLifecycleService:
   * - Arrival changed → onArrivalDateChanged (delete + recreate + push if guest active)
   * - Only departure changed → onDepartureDateChanged (update valid_to in DB + TTLock)
   *
   * Both paths also send an updated boarding card if the guest was already notified.
   */
  async handleStayDatesChanged(event: StayDatesChangedEvent): Promise<void> {
    const reservation = await this.storage.getReservationByPmsId(event.pmsReservationId);
    if (!reservation) return;

    if (!reservation.roomId || !(await this.isRoomMapped(reservation.roomId))) return;

    const lifecycle = this.automationEngine.getPinLifecycle();

    // Default to "both changed" when flags are absent (backwards-compat safety)
    const arrivalChanged = event.arrivalChanged !== false;
    const departureChanged = event.departureChanged !== false;

    try {
      if (arrivalChanged) {
        await lifecycle.onArrivalDateChanged(reservation);
      } else if (departureChanged) {
        await lifecycle.onDepartureDateChanged(reservation);
      }

      await this.storage.createLog({
        level: "info",
        message: arrivalChanged
          ? `Date change handled — arrival moved, PIN re-issued via PinLifecycleService`
          : `Date change handled — departure moved, PIN validity updated`,
        source: "state-machine",
        reservationId: reservation.id,
      });
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Date change PIN update failed: ${error instanceof Error ? error.message : String(error)}`,
        source: "state-machine",
        reservationId: reservation.id,
      });
    }

    // Send updated boarding card if guest was already notified
    const fresh = (await this.storage.getReservation(reservation.id))!;
    if (fresh.notificationSent || fresh.preCheckinStatus === "code_sent") {
      await this.sendUpdateNotification(fresh, "Date change");
    }
  }

  /**
   * Owing (outstanding balance) transitioned on the reservation.
   * - "required" (became positive): delete PIN from TTLock, keep generatedPin
   * - "cleared"  (became zero): recreate pending PIN and push if guest active
   */
  async handleOwingChanged(reservation: Reservation, transition: "required" | "cleared"): Promise<void> {
    if (!reservation.roomId || !(await this.isRoomMapped(reservation.roomId))) return;

    const lifecycle = this.automationEngine.getPinLifecycle();

    try {
      if (transition === "required") {
        await lifecycle.onPaymentRequired(reservation);
        await this.storage.createLog({
          level: "info",
          message: `Outstanding balance detected — PIN deleted from TTLock until payment is cleared`,
          source: "state-machine",
          reservationId: reservation.id,
        });
      } else {
        await lifecycle.onPaymentCleared(reservation);
        await this.storage.createLog({
          level: "info",
          message: `Outstanding balance cleared — PIN re-issued`,
          source: "state-machine",
          reservationId: reservation.id,
        });
      }
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Owing transition handler failed (${transition}): ${error instanceof Error ? error.message : String(error)}`,
        source: "state-machine",
        reservationId: reservation.id,
      });
    }

    // If payment was cleared and guest was already notified, re-send boarding card
    if (transition === "cleared") {
      const fresh = (await this.storage.getReservation(reservation.id))!;
      if (fresh.notificationSent || fresh.preCheckinStatus === "code_sent") {
        await this.sendUpdateNotification(fresh, "Payment received");
      }
    }
  }

  /**
   * Guest pressed remote unlock on boarding card.
   * This is already handled in public-api.ts — this method handles the
   * MEWS write-back part so it can be called from the route.
   */
  async handleRemoteUnlock(event: RemoteUnlockEvent): Promise<void> {
    const reservation = await this.storage.getReservation(event.reservationId);
    if (!reservation) return;

    // Mark PIN as used
    if (reservation.roomId) {
      const pins = await this.storage.getPinsByRoomId(reservation.roomId);
      const activePin = pins.find(p => p.reservationId === reservation.id && p.status === "active" && !p.firstUsedAt);
      if (activePin) {
        await this.storage.updatePinFirstUsedAt(activePin.id, new Date());
        await this.storage.updatePin(activePin.id, { status: "used" });
      }
    }

    // MEWS write-back if not already checked in
    if (reservation.status !== "Checked-in") {
      await this.checkinInMews(reservation);
    }
  }

  // -------------------------------------------------------------------------
  // Core rule: MEWS Checked-in → ensure PIN created and activated immediately
  // -------------------------------------------------------------------------

  private async _handleCheckedIn(reservation: Reservation): Promise<void> {
    // Always re-read from DB to avoid acting on stale data.
    // _jobBoardingCards reads reservations in bulk and they may have been
    // cancelled or checked-out by the drift reconciler or ingestion processor
    // between the read and this call.
    const current = await this.storage.getReservation(reservation.id);
    if (!current) return;
    const status = (current.status || "").toLowerCase();
    if (status !== "checked-in" && status !== "started") return;

    if (!current.roomId) return;
    // Guard: unmapped rooms have no TTLock — nothing to do
    if (!(await this.isRoomMapped(current.roomId))) return;

    // Ensure PIN exists
    if (!(await this.isPinCreated(current.id, current.roomId))) {
      const created = await this.createPin(current);
      if (!created) {
        await this.storage.createLog({
          level: "error",
          message: `Checked-in: PIN creation failed for ${current.firstName} ${current.lastName}`,
          source: "state-machine",
          reservationId: current.id,
        });
        return;
      }
    }

    // Activate PIN immediately — core rule
    const fresh = (await this.storage.getReservation(current.id))!;
    const activated = await this.activatePin(fresh);

    await this.storage.createLog({
      level: activated ? "info" : "warn",
      message: activated
        ? `MEWS checked-in: PIN activated immediately for ${current.firstName} ${current.lastName}`
        : `MEWS checked-in: PIN activation failed for ${current.firstName} ${current.lastName}`,
      source: "state-machine",
      reservationId: current.id,
    });

    // Track source (kept BEFORE the send gate — a deferred send must not defer this)
    if (!fresh.pmsCheckinSource) {
      await this.storage.updateReservation(fresh.id, { pmsCheckinSource: "mews" });
    }

    // Send boarding card if not already sent.
    //
    // Verify-before-send (21/7 lesson): don't tell the guest "here is your
    // door code" while the code is confirmed on ZERO locks. If unverified,
    // defer — _jobBoardingCards re-invokes this method on the next minute
    // tick, which retries activation first. After MAX_UNVERIFIED_SEND_DEFERRALS
    // ticks we send anyway (the boarding card also carries remote-unlock, and
    // withholding it entirely would leave the guest with nothing) but escalate
    // loudly so staff know the code may not work on the doors yet.
    if (fresh.preCheckinStatus !== "code_sent") {
      const verified = activated && (await this.isPinConfirmedOnAnyLock(fresh.id));
      if (!verified) {
        const prev = this.unverifiedSendDeferrals.get(fresh.id);
        const state = { attempts: (prev?.attempts ?? 0) + 1, firstAt: prev?.firstAt ?? Date.now() };
        this.unverifiedSendDeferrals.set(fresh.id, state);
        const attempts = state.attempts;
        // Time cap alongside the attempt cap: re-invocation depends on the
        // scheduler AND MEWS being healthy, so age alone must also force the
        // send — the guest's card (with remote-unlock) must never be held back
        // indefinitely because ticks stopped arriving.
        const agedOut = Date.now() - state.firstAt > ReservationStateMachine.MAX_UNVERIFIED_SEND_DEFER_MS;
        if (attempts < ReservationStateMachine.MAX_UNVERIFIED_SEND_DEFERRALS && !agedOut) {
          await this.storage.createLog({
            level: "warn",
            message: `Boarding card deferred (${attempts}/${ReservationStateMachine.MAX_UNVERIFIED_SEND_DEFERRALS}) for ${current.firstName} ${current.lastName} — code not confirmed on any lock yet`,
            source: "state-machine",
            reservationId: current.id,
          });
          return;
        }
        await this.storage.createLog({
          level: "error",
          message: `Boarding card sent UNVERIFIED for ${current.firstName} ${current.lastName} — code confirmed on 0 locks after ${attempts} activation attempts`,
          source: "state-machine",
          reservationId: current.id,
        });
        // Shared alert key (not per-reservation): avoids unbounded settings
        // growth; different guests still alert immediately because critical +
        // changed content bypasses the dedupe window.
        await sendOpsAlert(
          this.storage as any,
          "unverified-send",
          "critical",
          `Dørkode sendt UVERIFICERET til ${current.firstName} ${current.lastName}`,
          `Koden er ikke bekræftet på nogen lås efter ${attempts} aktiveringsforsøg. Gæsten kan bruge remote-unlock på boarding-kortet, men tjek gateway/låse NU.`
        );
      }
      this.unverifiedSendDeferrals.delete(fresh.id);
      await this.sendBoardingCard(fresh);
    }
  }

  // Bounded verify-before-send: number of minute-ticks we hold a boarding card
  // back while the code is unconfirmed on every lock, before sending anyway.
  // The time cap covers stalled re-invocation (scheduler/MEWS trouble): once a
  // deferral is 3+ minutes old, the next opportunity sends regardless.
  private static readonly MAX_UNVERIFIED_SEND_DEFERRALS = 3;
  private static readonly MAX_UNVERIFIED_SEND_DEFER_MS = 3 * 60 * 1000;
  private unverifiedSendDeferrals = new Map<string, { attempts: number; firstAt: number }>();

  /** True when the reservation has a live pin whose code is recorded on >= 1 lock. */
  private async isPinConfirmedOnAnyLock(reservationId: string): Promise<boolean> {
    const pins = await this.storage.getPinsByReservationId(reservationId);
    const parse = (v: unknown): any[] => {
      let value = v as any;
      if (typeof value === "string") {
        try { value = JSON.parse(value); } catch { return []; }
      }
      return Array.isArray(value) ? value : [];
    };
    return pins.some(p =>
      (p.status === "active" || p.status === "used") &&
      parse(p.roomLockKeyIds).length + parse(p.commonAreaKeyIds).length > 0
    );
  }

  // -------------------------------------------------------------------------
  // Scheduled jobs (called by a single scheduler every minute)
  // -------------------------------------------------------------------------

  async runScheduledJobs(): Promise<void> {
    // Run front-door arrival detection FIRST (sequentially), so a guest who
    // entered with their numeric code is checked in before _jobNoshow runs in
    // the same tick. Time-gated internally (no-op on most ticks).
    await this._jobLockArrivals();

    await Promise.allSettled([
      this._jobPrecheckinMails(),
      this._jobBoardingCards(),
      this._jobCapsuleDoorCode(),
      this._jobNoshow(),
      this._jobPinRepair(),
      this._jobNightlyExpiredPinCleanup(),
      this._jobCapsuleSafetyNet(),
      this._jobLockArrivalReport(),
      this._jobArrivalsChecklistReminder(),
      this._jobUpsellReport(),
      this._jobMarketingCampaigns(),
      this._jobDayUseCheckout(),
    ]);
  }

  /**
   * Day-use checkout signal (natten 22/7, Louise/302; ejerbeslutning): an OTA
   * day-use reservation (arrival and departure on the SAME hotel day, e.g.
   * Booking.com dagsophold) that ended mid-afternoon blocks the capsule in
   * MEWS all evening — the arriving overnight guest's auto check-in is then
   * rejected ("space occupied") until reception notices. Our own hourly
   * bookings already auto-checkout (sweep step 5); this closes the gap for
   * day-use stays that came in via MEWS/OTA.
   *
   * Only reservations the guest actually USED (checked-in/started) are
   * processed — a no-show day-use is left for MEWS' own night audit, so we
   * never turn a no-show into a completed stay. Kill switch:
   * `dayuse_checkout_signal_enabled` = "false".
   */
  private _lastDayUseCheckoutRun = 0;
  private _dayUseCheckoutFails = new Map<string, number>();

  async _jobDayUseCheckout(): Promise<void> {
    try {
      if (Date.now() - this._lastDayUseCheckoutRun < 10 * 60 * 1000) return;
      this._lastDayUseCheckoutRun = Date.now();

      if ((await this.storage.getSetting("dayuse_checkout_signal_enabled"))?.value === "false") return;
      if (!this.mewsClient) return;

      const tz = (await this.storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
      const now = Date.now();
      const GRACE_MS = 15 * 60 * 1000;
      const MAX_AGE_MS = 24 * 60 * 60 * 1000;

      const recent = await this.storage.getMappedReservationsByArrivalRange(
        new Date(now - MAX_AGE_MS),
        new Date(now),
      );
      for (const r of recent) {
        if (!r.pmsId) continue;
        const status = (r.status || "").toLowerCase();
        if (status !== "checked-in" && status !== "started") continue;
        const arrival = new Date(r.arrival);
        const departure = new Date(r.departure);
        const sameHotelDay =
          DateTime.fromJSDate(arrival, { zone: "utc" }).setZone(tz).toISODate() ===
          DateTime.fromJSDate(departure, { zone: "utc" }).setZone(tz).toISODate();
        if (!sameHotelDay) continue; // overnight stays: MEWS' egen bulk-checkout ejer dem
        const departureMs = departure.getTime();
        if (departureMs > now - GRACE_MS) continue; // still inside window (+grace)
        if (now - departureMs > MAX_AGE_MS) continue; // too old — manual territory

        const result = await this.mewsClient.processReservation(r.pmsId);
        if (result.success) {
          this._dayUseCheckoutFails.delete(r.id);
          await this.storage.updateReservation(r.id, { status: "Checked-out" });
          await this.storage.createLog({
            level: "info",
            message: `Day-use checkout signal: ${r.firstName} ${r.lastName} checked out in MEWS (day-use ended ${departure.toISOString()}) — capsule freed for tonight's arrival`,
            source: "state-machine",
            reservationId: r.id,
          });
        } else {
          const fails = (this._dayUseCheckoutFails.get(r.id) || 0) + 1;
          this._dayUseCheckoutFails.set(r.id, fails);
          await this.storage.createLog({
            level: "warn",
            message: `Day-use checkout signal failed for ${r.firstName} ${r.lastName} (attempt ${fails}): ${result.error || "unknown"} — retried every 10 min`,
            source: "state-machine",
            reservationId: r.id,
          });
          if (fails === 3) {
            await sendOpsAlert(
              this.storage,
              `dayuse-checkout-stuck:${r.id}`,
              "critical",
              `Day-use blokerer kapslen i aften — MEWS-udtjek fejler (${r.firstName ?? ""} ${r.lastName ?? ""})`.trim(),
              `Dagsopholdet sluttede ${departure.toISOString()}, men MEWS afviser udtjek (${result.error || "ukendt fejl"} — typisk åben saldo). Tjek gæsten ud manuelt i MEWS, ellers afvises aftengæstens automatiske check-in på pladsen.`
            );
          }
        }
      }
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Day-use checkout job error: ${error instanceof Error ? error.message : String(error)}`,
        source: "state-machine",
      });
    }
  }

  /**
   * Daily upsell report (owner request 3/8) — results for early check-in,
   * late check-out and hourly bookings + the morning's EC funnel, mailed once
   * per day at `upsell_report_time` (default 12:00) to `upsell_report_email`.
   * Same anti-storm pattern as the checklist reminder: last-sent date stamped
   * BEFORE sending; a failed send re-opens the stamp and backs off 30 min.
   */
  private _upsellReportRetryAfter = 0;

  private async _jobUpsellReport(): Promise<void> {
    try {
      if (Date.now() < this._upsellReportRetryAfter) return;
      const recipientRaw = (await this.storage.getSetting("upsell_report_email"))?.value;
      if (!(recipientRaw || "").includes("@")) return;

      const tz = (await this.storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
      const now = DateTime.now().setZone(tz);
      const timeRaw = (await this.storage.getSetting("upsell_report_time"))?.value || "12:00";
      const match = /^(\d{1,2}):(\d{2})$/.exec(timeRaw.trim());
      const hour = match ? Math.min(23, parseInt(match[1], 10)) : 12;
      const minute = match ? Math.min(59, parseInt(match[2], 10)) : 0;
      if (now < now.set({ hour, minute, second: 0, millisecond: 0 })) return;

      const today = now.toFormat("yyyy-MM-dd");
      const lastSent = (await this.storage.getSetting("upsell_report_last_sent_date"))?.value;
      if (lastSent === today) return;
      await this.storage.setSetting("upsell_report_last_sent_date", today);

      const { sendDailyUpsellReport } = await import("./upsell-report");
      const sent = await sendDailyUpsellReport(this.storage);
      if (!sent) {
        await this.storage.setSetting("upsell_report_last_sent_date", lastSent || "");
        this._upsellReportRetryAfter = Date.now() + 30 * 60 * 1000;
      }
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Upsell report job error: ${error instanceof Error ? error.message : String(error)}`,
        source: "upsell-report",
      }).catch(() => {});
    }
  }

  /** Marketing/upsell SMS campaigns — time-gated internally per campaign. */
  private async _jobMarketingCampaigns(): Promise<void> {
    try {
      const { runDueMarketingCampaigns } = await import("./marketing-service");
      await runDueMarketingCampaigns(this.storage);
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Marketing campaign job failed: ${error instanceof Error ? error.message : String(error)}`,
        source: "marketing",
      }).catch(() => {});
    }
  }

  /**
   * Arrival audit run — the hourly housekeeping behind the /arrivals page:
   * full TTLock door audit, force-repair of every gap found, and persistence
   * of the audit snapshot the page overlays. NOTHING IS EMAILED — owner
   * decision 3/8: the 28/7 decision already retired the routine list mail,
   * and the remaining alarm mails are retired too. The live /arrivals page
   * (login + share link) IS the list; critical system events still go
   * through sendOpsAlert, and the daily checklist reminder below still mails
   * the link once a day.
   *
   * Trigger: right AFTER each completed lock-arrival scan (the hourly lock
   * procedure that MEWS-checks-in guests who used their code) — the scan sets
   * `_arrivalReportDue` and this job runs in the same tick, so the page
   * snapshot reflects the fresh check-ins. Safety net: if no scan has fired
   * for 75 min (e.g. lock-arrival disabled), the run happens anyway. The
   * last-run time is persisted in a setting so restarts/deploys never
   * double-run.
   */
  private _arrivalReportDue = false;
  private static REPORT_FALLBACK_MS = 75 * 60 * 1000;

  // Re-entrancy guard (23/7 incident: ~99 mails in one night, before the
  // mails were retired). A run takes minutes (full TTLock audit +
  // force-repairs) while the scheduler ticks every 60s. Stuck-reset after
  // 30 min mirrors DriftReconciler: a hung TTLock call must not silence the
  // audit forever.
  private _reportJobStartedAt = 0;
  private _reportJobToken = 0;
  private static readonly REPORT_JOB_STUCK_MS = 30 * 60 * 1000;
  // Absolute lower bound between two runs (22/7 lesson, kept after the mails
  // were retired: every run force-repairs, so minute-cadence runs churned
  // TTLock and kept locks busy for guests). AT MOST ONE RUN PER HOUR.
  // In-memory mirror of the persisted last-run setting so the floor holds
  // even when settings writes fail silently.
  private static readonly REPORT_HARD_FLOOR_MS = 60 * 60 * 1000;
  private _lastReportRunAtMem = 0;

  private async _jobLockArrivalReport(): Promise<void> {
    try {
      const stuckSinceMin = this._reportJobStartedAt
        ? Math.round((Date.now() - this._reportJobStartedAt) / 60000)
        : 0;
      if (this._reportJobStartedAt) {
        if (Date.now() - this._reportJobStartedAt < ReservationStateMachine.REPORT_JOB_STUCK_MS) return;
        // Fall through to force-reset — but claim the flag SYNCHRONOUSLY first
        // (an await between the staleness check and the re-stamp would let two
        // ticks both pass the gate).
      }
      this._reportJobStartedAt = Date.now();
      // Ownership token: after a stuck force-reset the ORIGINAL run may still
      // be alive; when it finally settles, its cleanup must not wipe the
      // REPLACEMENT run's stamp (that would re-admit concurrency on the next
      // tick — the exact leak this guard exists to close).
      const token = ++this._reportJobToken;
      if (stuckSinceMin > 0) {
        await this.storage.createLog({
          level: "warn",
          message: `Arrival report job stuck for ${stuckSinceMin} min — force-resetting in-flight flag`,
          source: "arrival-report",
        });
      }
      try {
        await this._runLockArrivalReport();
      } finally {
        if (this._reportJobToken === token) this._reportJobStartedAt = 0;
      }
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Arrival report job error: ${error instanceof Error ? error.message : String(error)}`,
        source: "arrival-report",
      });
    }
  }

  private async _runLockArrivalReport(): Promise<void> {
    // HARD RUN FLOOR: at most one run per hour, checked FIRST so we don't
    // even build (each build force-repairs, so minute-builds churned TTLock).
    // In-memory on purpose: it must hold even if persisting last-run-at to
    // settings fails silently.
    if (Date.now() - this._lastReportRunAtMem < ReservationStateMachine.REPORT_HARD_FLOOR_MS) return;

    // Trust whichever record of "last run" is newest — a failed settings
    // write must not reopen the floodgates. (Same setting key as when the job
    // still mailed, so the cadence clock survives the retirement deploy.)
    const lastRunRaw = (await this.storage.getSetting("lock_arrival_report_last_sent_at"))?.value;
    const lastRunPersisted = lastRunRaw ? Date.parse(lastRunRaw) : NaN;
    const lastRun = Math.max(
      Number.isFinite(lastRunPersisted) ? lastRunPersisted : 0,
      this._lastReportRunAtMem
    ) || NaN;
    const fallbackDue = !Number.isFinite(lastRun) ||
      Date.now() - lastRun > ReservationStateMachine.REPORT_FALLBACK_MS;
    if (!this._arrivalReportDue && !fallbackDue) return;

    // Owner decision 3/8: report MAILS are fully retired (28/7 removed the
    // routine list mail; now the alarm/URGENT mails are gone too — the owner
    // reads the live /arrivals page via the share link instead). The run's
    // entire job is the build itself: TTLock door audit, force-repair of
    // every gap (detection → action), and the persisted page snapshot.
    const { buildLockArrivalReportData } = await import("./lock-arrival-report");
    await buildLockArrivalReportData(this.storage, { engine: this.automationEngine, runAudit: true });

    this._arrivalReportDue = false;
    // Stamp the in-memory mirror FIRST — the floor must arm even if the
    // settings write below throws.
    this._lastReportRunAtMem = Date.now();
    await this.storage.setSetting("lock_arrival_report_last_sent_at", new Date().toISOString());
  }

  /**
   * Daily arrivals checklist reminder — a fixed to-do mail (payment links,
   * housekeeping must be Inspected, door codes) sent once per day at
   * `arrivals_reminder_time` (default 01:00 hotel time) to the
   * `lock_arrival_report_email` recipients, linking to the /arrivals page for
   * the NEW calendar day (the report's 07:00 rollover hasn't switched yet, so
   * the plain /arrivals page would still show yesterday at that hour).
   * Last-sent date is persisted so deploys/restarts never double-send.
   */
  private _reminderRetryAfter = 0;

  private async _jobArrivalsChecklistReminder(): Promise<void> {
    try {
      if (Date.now() < this._reminderRetryAfter) return;
      const recipientRaw = (await this.storage.getSetting("lock_arrival_report_email"))?.value;
      const recipients = (recipientRaw || "").split(/[,;\s]+/).map(s => s.trim()).filter(s => s.includes("@"));
      if (recipients.length === 0) return;

      const tz = (await this.storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
      const now = DateTime.now().setZone(tz);
      const timeRaw = (await this.storage.getSetting("arrivals_reminder_time"))?.value || "01:00";
      const match = /^(\d{1,2}):(\d{2})$/.exec(timeRaw.trim());
      const hour = match ? Math.min(23, parseInt(match[1], 10)) : 1;
      const minute = match ? Math.min(59, parseInt(match[2], 10)) : 0;
      const reminderAt = now.set({ hour, minute, second: 0, millisecond: 0 });
      if (now < reminderAt) return;

      const today = now.toFormat("yyyy-MM-dd");
      const lastSent = (await this.storage.getSetting("arrivals_reminder_last_sent_date"))?.value;
      if (lastSent === today) return;
      // Stamp BEFORE sending — a failing mail provider must not become a
      // send-per-tick storm (23/7 lesson). A failed send re-opens the stamp
      // and backs off 30 min instead.
      await this.storage.setSetting("arrivals_reminder_last_sent_date", today);

      const { resolveArrivalsUrl } = await import("./lock-arrival-report");
      const { createNotificationClient } = await import("./notification-client");
      const arrivalsUrl = await resolveArrivalsUrl(this.storage, today);
      const hotelName = (await this.storage.getSetting("hotel_name"))?.value || "Hotel";
      const dateLabel = now.setLocale("da").toFormat("cccc d. LLLL");

      const items = [
        `💰 Betaling: Send betalingslink til gæster, der ikke har betalt — eller opkræv beløbet. Arrivals-listen viser hvem der skylder ("Afventer betaling").`,
        `🧹 Rengøring: Ingen af dagens ankomster må stå som Beskidt — alle skal være Inspiceret inden check-in.`,
        `🔑 Dørkoder: Tjek at alle ankomster har kode, at beskeden er sendt, og at ingen døre mangler koder eller er offline.`,
      ];
      const subject = `🌙 Huskeliste — dagens ankomster ${now.toFormat("d/M")} (${hotelName})`;
      const body = [
        `Huskeliste for dagens ankomster — ${dateLabel}:`,
        "",
        ...items.map((t, i) => `${i + 1}) ${t}`),
        "",
        `Gennemgå listen her (opdateres live): ${arrivalsUrl}`,
        "",
        `— Automatisk daglig påmindelse. Tidspunktet styres af settingen arrivals_reminder_time. DreamBoksLock.`,
      ].join("\n");
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const html =
        `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:640px;margin:0 auto;">` +
        `<h2 style="font-size:20px;margin:0 0 2px;">🌙 Huskeliste — dagens ankomster</h2>` +
        `<p style="color:#6b7280;font-size:13px;margin:0 0 14px;">${esc(dateLabel)} · ${esc(hotelName)}</p>` +
        `<ol style="font-size:15px;line-height:1.6;padding-left:20px;margin:0 0 18px;">` +
        items.map(t => `<li style="margin-bottom:8px;">${esc(t)}</li>`).join("") +
        `</ol>` +
        `<p style="margin:0 0 18px;"><a href="${esc(arrivalsUrl)}" style="display:inline-block;padding:12px 22px;background:#2563eb;color:#ffffff;font-size:15px;font-weight:700;border-radius:8px;text-decoration:none;">Åbn Arrivals-listen →</a><br>` +
        `<span style="font-size:12px;color:#9ca3af;">Fuld liste med betalingsstatus, rengøring og koder — opdateres live.</span></p>` +
        `<p style="color:#9ca3af;font-size:12px;margin-top:16px;">— Automatisk daglig påmindelse. DreamBoksLock.</p>` +
        `</div>`;

      const client = await createNotificationClient(this.storage);
      const delivered: string[] = [];
      const failed: string[] = [];
      for (const to of recipients) {
        const result = await client.sendPlainTextEmail({ to, subject, text: body, html });
        if (result.success) delivered.push(to);
        else failed.push(`${to} (${result.error})`);
      }

      if (delivered.length === 0) {
        await this.storage.setSetting("arrivals_reminder_last_sent_date", lastSent || "");
        this._reminderRetryAfter = Date.now() + 30 * 60 * 1000;
      }
      await this.storage.createLog({
        level: delivered.length > 0 ? "info" : "error",
        message: `Arrivals checklist reminder ${delivered.length > 0 ? `sent to ${delivered.join(", ")}` : "FAILED"}${failed.length ? ` — failed: ${failed.join("; ")}` : ""}`,
        source: "arrival-report",
      });
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Arrivals reminder job error: ${error instanceof Error ? error.message : String(error)}`,
        source: "arrival-report",
      });
    }
  }

  // Capsule-only "door code" mode: one plain message (SMS + email) instead of the
  // pre-checkin + digital-key flow. Gated by the per-tenant `door_code_message_only` setting.
  private async doorCodeMessageOnly(): Promise<boolean> {
    return (await this.storage.getSetting("door_code_message_only"))?.value === "true";
  }

  // Signature of the door-code-relevant content. A change to any of these (dates, room,
  // pin, or the guest's contact) means the guest must be re-sent an updated message.
  private doorCodeSignature(r: Reservation): string {
    return [
      r.generatedPin,
      r.roomId,
      r.arrival ? new Date(r.arrival).toISOString() : "",
      r.departure ? new Date(r.departure).toISOString() : "",
      r.personalEmail || r.email || "",
      r.mobile || "",
      // Paid late checkout / early check-in: a purchase changes the effective
      // validity, so the guest gets a fresh message with the new times.
      // CONDITIONAL SPREAD, not fixed slots: reservations without a purchase
      // must keep their legacy 6-field signature byte-identical, or a deploy
      // would flip EVERY stored sig and mass re-send door codes to all guests.
      ...(r.lateCheckoutUntil ? [new Date(r.lateCheckoutUntil).toISOString()] : []),
      ...(r.earlyCheckinFrom ? [new Date(r.earlyCheckinFrom).toISOString()] : []),
    ].join("|");
  }

  /**
   * Capsule door-code mode: send ONE plain "door code" message (SMS + email) 23h before
   * check-in — or on the next tick for a booking made later / after check-in. Also re-sends
   * once whenever the reservation content changes (arrival/departure date, room/Capsule,
   * PIN, or contact), detected via a content signature.
   */
  private async _jobCapsuleDoorCode(): Promise<void> {
    try {
      if (!(await this.doorCodeMessageOnly())) return;
      const timezoneSetting = await this.storage.getSetting("property_timezone");
      const timezone = timezoneSetting?.value || "Europe/Copenhagen";
      const now = DateTime.now().setZone(timezone);
      // Window covers current guests (arrived up to ~4 days ago, stay not over) plus
      // arrivals ~30h ahead — so a change to a current or upcoming reservation re-sends.
      const reservations = await this.storage.getMappedReservationsByArrivalRange(
        now.minus({ days: 4 }).startOf("day").toJSDate(),
        now.plus({ hours: 30 }).toJSDate()
      );
      const nowMs = now.toMillis();
      const eligible = reservations.filter(r => {
        if (!["confirmed", "checked-in", "started"].includes(r.status?.toLowerCase() || "")) return false;
        if (!r.generatedPin) return false;
        if ((r.doorCodeAttempts ?? 0) >= ReservationStateMachine.MAX_DOOR_CODE_ATTEMPTS) return false;
        // Stay is over — but a paid late checkout extends the send window so
        // the guest still gets the updated "valid until HH:MM" message.
        const effectiveEnd = Math.max(
          new Date(r.departure).getTime(),
          r.lateCheckoutUntil ? new Date(r.lateCheckoutUntil).getTime() : 0,
        );
        if (effectiveEnd < nowMs - 60 * 60 * 1000) return false;
        const sig = this.doorCodeSignature(r);
        const changed = r.doorCodeSig != null && r.doorCodeSig !== sig;             // content changed → re-send
        const baselineNeeded = r.doorCodeSig == null && r.doorCodeSentAt != null;   // record already-delivered content
        const notYetSent = !r.doorCodeSentAt;                                       // scheduled send still due
        return changed || baselineNeeded || notYetSent;
      });
      for (const r of eligible) {
        await this._sendDoorCodeMessage(r);
      }
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Capsule door-code job error: ${error instanceof Error ? error.message : String(error)}`,
        source: "state-machine",
      });
    }
  }

  // Reservations whose door-code send is deferred on unpaid balance — logged
  // once (not every 60s tick). In-memory: a restart re-logs once, harmless.
  private _doorCodePaymentDeferLogged = new Set<string>();
  private _doorCodePushDeferLogged = new Set<string>();

  private async _sendDoorCodeMessage(reservation: Reservation): Promise<void> {
    const r = (await this.storage.getReservation(reservation.id)) || reservation;
    if (!r.generatedPin) return;
    const sig = this.doorCodeSignature(r);

    // Reservations already coded via the old flow (or the rollout backfill) have no
    // signature yet: record their current content so future CHANGES re-send — but don't
    // send now (they already have a working code).
    if (r.doorCodeSig == null && r.doorCodeSentAt != null) {
      await this.storage.updateReservation(r.id, { doorCodeSig: sig });
      return;
    }

    // Content changed (arrival/departure/room/pin/contact) since last delivery → clear the
    // send marker so the message re-sends with the new data on the next tick.
    if (r.doorCodeSig != null && r.doorCodeSig !== sig) {
      await this.storage.updateReservation(r.id, {
        doorCodeSentAt: null,
        doorCodeAttempts: 0,
        doorCodeSig: sig,
      });
      await this.storage.createLog({
        level: "info",
        message: `Door code re-scheduled after reservation change for ${r.firstName} ${r.lastName}`,
        source: "state-machine",
        reservationId: r.id,
      });
      return;
    }

    const { validFrom, validTo } = await buildValidityWindow(this.storage, r);
    const checkinAt = validFrom.getTime();
    const now = Date.now();

    // Single send: 23h before check-in (or the next tick for a later booking / after check-in).
    if (r.doorCodeSentAt || now < checkinAt - ReservationStateMachine.DOOR_CODE_ADVANCE_MS) return;

    // PAYMENT GATE: PIN activation refuses to program locks while owing > 0
    // (_shouldHavePin), so sending the code now would hand the guest a DEAD
    // code (the Elynn Herrou incident — guest at the door with 3 unusable
    // codes). Defer WITHOUT stamping markers or counting attempts: the job
    // re-evaluates every minute, and the existing paymentCleared trigger
    // pushes the PIN the moment MEWS shows the balance settled — this message
    // then goes out in the same minute.
    const owing = parseFloat(r.owing ?? "0") || 0;
    if (owing > 0) {
      if (!this._doorCodePaymentDeferLogged.has(r.id)) {
        this._doorCodePaymentDeferLogged.add(r.id);
        await this.storage.createLog({
          level: "warn",
          message: `Door code deferred for ${r.firstName} ${r.lastName} — awaiting payment (${owing.toFixed(2)} kr owing); sends automatically when settled`,
          source: "state-machine",
          reservationId: r.id,
        });
      }
      return;
    }
    this._doorCodePaymentDeferLogged.delete(r.id);

    // LOCK-PROGRAMMING GATE: once the activation window is open (1h before
    // check-in, same rule as PIN activation), the code must actually BE on the
    // guest's current room locks before we message it. The inline push at
    // creation covers the normal same-night path within seconds — this gate
    // covers push FAILURES (lock-busy storm, offline gateway): defer the SMS
    // instead of handing a guest at the door a dead code (the 20/7 incident).
    // For future arrivals pending is fine — the scheduler programs the locks
    // long before the guest can stand at the door. Defer stamps nothing and
    // counts no attempts: the job re-evaluates every minute and sends the
    // moment activation succeeds.
    const activationWindowOpen = now >= checkinAt - 60 * 60 * 1000;
    if (activationWindowOpen) {
      const pins = await this.storage.getPinsByReservationId(r.id);
      const onCurrentRoomLocks = pins.some(
        (p) => p.roomId === r.roomId && ["active", "used"].includes(p.status)
      );
      if (!onCurrentRoomLocks) {
        if (!this._doorCodePushDeferLogged.has(r.id)) {
          this._doorCodePushDeferLogged.add(r.id);
          await this.storage.createLog({
            level: "warn",
            message: `Door code message deferred for ${r.firstName} ${r.lastName} — code not on the locks yet (activation pending/failed); sends automatically once programmed`,
            source: "state-machine",
            reservationId: r.id,
          });
        }
        return;
      }
      this._doorCodePushDeferLogged.delete(r.id);
    }

    const message = await this._buildDoorCodeMessage(r, validFrom, validTo);
    const notifClient = await createNotificationClient(this.storage);
    const [testEmail, testPhone] = await Promise.all([
      this.storage.getSetting("boarding_test_email"),
      this.storage.getSetting("boarding_test_phone"),
    ]);
    const recipientEmail = testEmail?.value || r.personalEmail || r.email || undefined;
    const recipientMobile = testPhone?.value || r.mobile || undefined;

    // CHURN DAMPENER (28/7, Tziolas: 33 duplicate door-code SMS in a night):
    // the send-once state lives on the reservation ROW (doorCodeSentAt/sig)
    // and dies with it whenever a bug re-creates the row. This guard is a
    // tenant-level marker keyed by CONTENT (code+capsule+recipient) that
    // survives row churn: an identical message within 6h is a duplicate —
    // suppress it, but still stamp the row so the job stops retrying. A code,
    // capsule or recipient CHANGE produces a new key, so legitimate re-sends
    // (room moves, new codes) are unaffected.
    const guardKey = `door_code_sent_guard:${r.generatedPin}:${r.roomId ?? "-"}:${(recipientMobile ?? recipientEmail ?? "").replace(/\D+/g, "") || "none"}`;
    const guardRaw = (await this.storage.getSetting(guardKey))?.value;
    const guardMs = guardRaw ? Date.parse(guardRaw) : NaN;
    if (Number.isFinite(guardMs) && Date.now() - guardMs < 6 * 60 * 60 * 1000) {
      await this.storage.updateReservation(r.id, { doorCodeSig: sig, doorCodeSentAt: new Date() });
      await this.storage.createLog({
        level: "warn",
        message: `Door code send SUPPRESSED for ${r.firstName} ${r.lastName} — identical code/capsule/recipient already messaged within 6h (row-level send state missing, likely a re-created row). Dampener absorbed the duplicate.`,
        source: "state-machine",
        reservationId: r.id,
      });
      return;
    }

    const errors: string[] = [];
    let delivered = false;
    if (recipientEmail) {
      const er = await notifClient.sendPlainTextEmail({ to: recipientEmail, subject: message.subject, text: message.emailBody });
      if (er.success) delivered = true; else errors.push(`email: ${er.error}`);
    }
    if (recipientMobile) {
      const sr = await notifClient.sendPlainSMS({ to: recipientMobile, body: message.body });
      if (sr.success) delivered = true; else errors.push(`sms: ${sr.error}`);
    }

    if (delivered) {
      const patch: Partial<TenantlessReservationInput> = { doorCodeSig: sig, doorCodeSentAt: new Date() };
      if (!r.notificationSent) {
        patch.notificationSent = true;
        patch.preCheckinStatus = "code_sent";
        patch.codeDeliveredAt = new Date();
      }
      await this.storage.setSetting(guardKey, new Date().toISOString());
      await this.storage.updateReservation(r.id, patch);
      await this.storage.createLog({
        level: "info",
        message: `Door code sent to ${r.firstName} ${r.lastName}`,
        source: "state-machine",
        reservationId: r.id,
      });
    } else {
      const attempts = (r.doorCodeAttempts ?? 0) + 1;
      await this.storage.updateReservation(r.id, { doorCodeAttempts: attempts });
      if (attempts >= ReservationStateMachine.MAX_DOOR_CODE_ATTEMPTS) {
        await this.storage.createLog({
          level: "warn",
          message: `Door code send gave up for ${r.firstName} ${r.lastName} after ${attempts} attempts (unreachable). Errors: ${errors.join("; ")}`,
          source: "state-machine",
          reservationId: r.id,
          metadata: { attempts, errors },
        });
      }
    }
  }

  private async _buildDoorCodeMessage(
    reservation: Reservation,
    validFrom: Date,
    validTo: Date
  ): Promise<{ subject: string; body: string; emailBody: string }> {
    const timezoneSetting = await this.storage.getSetting("property_timezone");
    const addressSetting = await this.storage.getSetting("hotel_address");
    const timezone = timezoneSetting?.value || "Europe/Copenhagen";

    const room = reservation.roomId ? await this.storage.getRoom(reservation.roomId) : null;
    const spaceName = room ? getSpaceDisplayName(room.name, room.label) : (reservation.assignedSpace || reservation.room || "your room");
    // Capsule rooms are stored as bare numbers ("207s"); the guest-facing label is "Capsule <n>".
    const roomName = /^capsule\b/i.test(spaceName) ? spaceName : `Capsule ${spaceName}`;
    const code = `${reservation.generatedPin}#`;
    // Weekday + short month, no year (sent ≤23h before arrival — the year is
    // never ambiguous): "Mon 20 Jul, 19:03". One labeled line per time reads
    // far better than the old "Valid A - B" span.
    const fmtDay = (d: Date) => DateTime.fromJSDate(d).setZone(timezone).setLocale("en").toFormat("ccc d MMM");
    const fmtTime = (d: Date) => DateTime.fromJSDate(d).setZone(timezone).toFormat("HH:mm");

    const subject = "Important: Door Code to enter hotel Capsule inn";
    const timeLines = [
      `Check-in: ${fmtDay(validFrom)}, from ${fmtTime(validFrom)}`,
      `Check-out: ${fmtDay(validTo)}, by ${fmtTime(validTo)}`,
    ];

    // Per-tenant template (door_code_sms_text, owner text for Capsule 8/9-2026:
    // wayfinding through the mall instead of the times). Rendered with
    // {capsule} {room} {code} {checkin_*} {checkout_*} {address} {name}. The
    // template is the whole SMS; the email appends the check-in/out lines so
    // nothing is lost there. Not part of doorCodeSignature — editing the
    // template never re-sends to guests who already have their code.
    const template = (await this.storage.getSetting("door_code_sms_text"))?.value?.trim();
    let body: string;
    let emailBody: string;
    if (template) {
      body = renderDoorCodeTemplate(template, {
        capsule: roomName,
        room: spaceName,
        code,
        checkin_day: fmtDay(validFrom),
        checkin_time: fmtTime(validFrom),
        checkout_day: fmtDay(validTo),
        checkout_time: fmtTime(validTo),
        address: addressSetting?.value || "",
        name: reservation.firstName || "",
      });
      emailBody = `${body}\n\n${timeLines.join("\n")}`;
    } else {
      // Default compact body (kept under 160 chars so a guest SMS is a single
      // billed segment). The email carries the "Important: Door Code…" context
      // via its subject.
      const lines = [`Door code for ${roomName}: ${code}`, ...timeLines];
      if (addressSetting?.value) {
        lines.push(addressSetting.value);
      }
      body = lines.join("\n");
      emailBody = body;
    }

    // EMAIL-ONLY extra (the SMS must stay one billed segment): self-service
    // late-checkout purchase from the guest's own phone (owner decision 24/7 —
    // the guest in bed at 08:00 must not have to walk to the wall tablet).
    try {
      const slug = (await this.storage.getSetting("hotel_slug"))?.value;
      if (slug) {
        const base = ((await this.storage.getSetting("app_base_url"))?.value || config.appBaseUrl).replace(/\/+$/, "");
        emailBody = `${emailBody}\n\nSleeping in? Buy late check-out from your phone: ${base}/${slug}/extend`;
      }
    } catch { /* the link line is optional */ }

    return { subject, body, emailBody };
  }

  /**
   * Send pre-checkin mails to guests arriving within 24 hours.
   */
  private async _jobPrecheckinMails(): Promise<void> {
    try {
      // Capsule door-code mode replaces both pre-checkin and digital-key sends.
      if (await this.doorCodeMessageOnly()) return;
      const timezoneSetting = await this.storage.getSetting("property_timezone");
      const timezone = timezoneSetting?.value || "Europe/Copenhagen";
      const now = DateTime.now().setZone(timezone);

      const reservations = await this.storage.getMappedReservationsByArrivalRange(
        now.startOf("day").toJSDate(),
        now.plus({ hours: 24 }).toJSDate()
      );

      const eligible = reservations.filter(r =>
        ["confirmed", "checked-in", "started"].includes(r.status?.toLowerCase() || "") &&
        !r.preCheckinEmailSent &&
        (r.preCheckinAttempts ?? 0) < ReservationStateMachine.MAX_PRECHECKIN_ATTEMPTS
      );

      for (const r of eligible) {
        await this.sendPrecheckinMail(r);
      }
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Pre-checkin job error: ${error instanceof Error ? error.message : String(error)}`,
        source: "state-machine",
      });
    }
  }

  /**
   * Send boarding cards to guests who are checked-in or have paid.
   */
  private async _jobBoardingCards(): Promise<void> {
    try {
      // Capsule door-code mode replaces both pre-checkin and digital-key sends.
      if (await this.doorCodeMessageOnly()) return;
      const timezoneSetting = await this.storage.getSetting("property_timezone");
      const timezone = timezoneSetting?.value || "Europe/Copenhagen";
      const now = DateTime.now().setZone(timezone);

      // Window starts YESTERDAY so a checked-in guest whose boarding card was
      // deferred (verify-before-send) around midnight is still re-driven after
      // the day rolls over. Yesterday's arrivals only qualify when already
      // checked in — confirmed-but-unarrived guests from yesterday must not
      // suddenly enter the payment/pre-checkin flow here.
      const reservations = await this.storage.getMappedReservationsByArrivalRange(
        now.minus({ days: 1 }).startOf("day").toJSDate(),
        now.plus({ hours: 24 }).toJSDate()
      );
      const todayStart = now.startOf("day").toJSDate().getTime();

      const eligible = reservations.filter(r => {
        const status = r.status?.toLowerCase() || "";
        if (!["confirmed", "checked-in", "started"].includes(status)) return false;
        if (r.notificationSent || r.preCheckinStatus === "code_sent") return false;
        const arrivedYesterday = new Date(r.arrival).getTime() < todayStart;
        if (arrivedYesterday && !["checked-in", "started"].includes(status)) return false;
        return true;
      });

      for (const reservation of eligible) {
        // Skip if notification recently failed — retry after cooldown (30 min)
        const lastFailed = this.notificationFailedAt.get(reservation.id);
        if (lastFailed && Date.now() - lastFailed < ReservationStateMachine.NOTIFICATION_RETRY_COOLDOWN) {
          continue;
        }

        const isCheckedIn = ["checked-in", "started"].includes(reservation.status?.toLowerCase() || "");

        if (isCheckedIn) {
          // Core rule: checked-in → activate and send immediately
          await this._handleCheckedIn(reservation);
          continue;
        }

        // Not yet checked-in: check payment
        const paid = await this.isPaymentOk(reservation);
        if (!paid) continue;

        const idOk = await this.isIdVerified(reservation);
        if (!idOk) {
          // Log once per hour per reservation to avoid log spam on every scheduler tick
          const lastLogged = this.boardingCardBlockedLoggedAt.get(reservation.id) ?? 0;
          if (Date.now() - lastLogged > 60 * 60 * 1000) {
            this.boardingCardBlockedLoggedAt.set(reservation.id, Date.now());
            await this.storage.createLog({
              level: "info",
              message: `Boarding card blocked: no ID document for ${reservation.firstName} ${reservation.lastName}`,
              source: "state-machine",
              reservationId: reservation.id,
            });
          }
          continue;
        }

        await this.storage.updateReservation(reservation.id, {
          preCheckinStatus: "paid",
          paymentVerifiedAt: new Date(),
        });

        const fresh = (await this.storage.getReservation(reservation.id))!;

        // Ensure PIN exists and activate if late arrival
        if (!fresh.generatedPin) {
          await this.createPin(fresh);
        }

        const refreshed = (await this.storage.getReservation(reservation.id))!;
        if (await this.isLateArrival(refreshed)) {
          await this.activatePin(refreshed);
        }

        const final = (await this.storage.getReservation(reservation.id))!;
        await this.sendBoardingCard(final);
      }
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Boarding card job error: ${error instanceof Error ? error.message : String(error)}`,
        source: "state-machine",
      });
    }
  }

  /**
   * Daily no-show detection.
   */
  private _lastNoshowDate: string | null = null;

  private async _jobNoshow(): Promise<void> {
    try {
      const enabledSetting = await this.storage.getSetting("noshow_enabled");
      if (enabledSetting?.value !== "true") return;

      const latestArrivalSetting = await this.storage.getSetting("latest_arrival_time");
      const timezoneSetting = await this.storage.getSetting("property_timezone");
      const latestArrival = latestArrivalSetting?.value || "23:00";
      const timezone = timezoneSetting?.value || "Europe/Copenhagen";

      const now = DateTime.now().setZone(timezone);
      const today = now.toFormat("yyyy-MM-dd");

      if (this._lastNoshowDate === today) return;

      const [h, m] = latestArrival.split(":").map(Number);
      const noshowTime = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });

      if (now < noshowTime) return;

      this._lastNoshowDate = today;

      // Final front-door sweep right before marking no-shows: catch any guest
      // who entered with their numeric code in the last window but wasn't yet
      // detected. force=true bypasses the hourly time-gate. Internally
      // try/catch-guarded, so it never blocks no-show marking.
      await this._jobLockArrivals(true);

      const reservations = await this.storage.getMappedReservationsByArrivalRange(
        now.startOf("day").toJSDate(),
        now.endOf("day").toJSDate()
      );

      for (const r of reservations) {
        if (r.status?.toLowerCase() !== "confirmed") continue;
        if (!r.roomId) continue;

        const pins = await this.storage.getPinsByRoomId(r.roomId);
        const unusedPin = pins.find(p => p.reservationId === r.id && p.status === "active" && !p.firstUsedAt);
        if (unusedPin) {
          await this.markNoshow(r);
        }
      }
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `No-show job error: ${error instanceof Error ? error.message : String(error)}`,
        source: "state-machine",
      });
    }
  }

  /**
   * PIN repair — ensures active PINs are present on all assigned locks and
   * re-pushes any that are missing (e.g. common-door codes that failed to push
   * while a gateway was offline). Runs every `pin_repair_interval_minutes`
   * (default 5) so a guest is never locked out for long after a gateway drops
   * and recovers. repairActivePinsWithMissingLocks() is purely additive and
   * only calls TTLock for PINs that actually have missing locks, so a short
   * interval is cheap when everything is already in sync.
   */
  private _lastRepairRun: number = 0;
  private readonly DEFAULT_REPAIR_INTERVAL_MINUTES = 5;
  // A repair sweep can outlive the interval when TTLock is slow/offline-heavy;
  // overlapping sweeps double-push the same codes and compound the load.
  // Timestamped with a stuck force-reset (like the report guard and
  // DriftReconciler): a single hung await must not silently kill the
  // guest-lockout-critical repair safety net until the next deploy.
  private _pinRepairStartedAt = 0;
  private _pinRepairToken = 0;
  private static readonly PIN_REPAIR_STUCK_MS = 30 * 60 * 1000;

  private async _jobPinRepair(): Promise<void> {
    const repairStuckMin = this._pinRepairStartedAt
      ? Math.round((Date.now() - this._pinRepairStartedAt) / 60000)
      : 0;
    if (this._pinRepairStartedAt &&
        Date.now() - this._pinRepairStartedAt < ReservationStateMachine.PIN_REPAIR_STUCK_MS) {
      return;
    }
    // Claim synchronously before any await; token so a settling superseded
    // run can't wipe the replacement's stamp.
    this._pinRepairStartedAt = Date.now();
    const token = ++this._pinRepairToken;
    try {
      if (repairStuckMin > 0) {
        await this.storage.createLog({
          level: "warn",
          message: `PIN repair job stuck for ${repairStuckMin} min — force-resetting in-flight flag`,
          source: "state-machine",
        });
      }
      // Configurable live (no redeploy) via the pin_repair_interval_minutes
      // setting; falls back to the 5-minute default. Min 1 minute.
      const intervalSetting = await this.storage.getSetting("pin_repair_interval_minutes");
      const intervalMinutes = Math.max(
        1,
        parseInt(intervalSetting?.value || "", 10) || this.DEFAULT_REPAIR_INTERVAL_MINUTES,
      );
      if (Date.now() - this._lastRepairRun < intervalMinutes * 60 * 1000) return;
      this._lastRepairRun = Date.now();
      await this.automationEngine.repairActivePinsWithMissingLocks();
      await this.automationEngine.getPinLifecycle().retryFailedDeletions();
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `PIN repair job error: ${error instanceof Error ? error.message : String(error)}`,
        source: "state-machine",
      });
    } finally {
      if (this._pinRepairToken === token) this._pinRepairStartedAt = 0;
    }
  }

  /**
   * Front-door arrival detection (hourly).
   *
   * Polls ONLY common / front-door locks (lockType === "common") for keypad
   * unlock records and matches each used code against active, unused PINs.
   * When a guest enters with their numeric code — instead of pressing the
   * remote-unlock button on the boarding card — this triggers the SAME MEWS
   * check-in the button does (checkinInMews → startReservation), so the guest
   * is never falsely marked as a no-show and locked out.
   *
   * Why front-door only: every guest passes through a common door, and their
   * code lives on that door too (commonAreaKeyIds). One API call per common
   * lock therefore covers all guests — far fewer TTLock calls than polling
   * every capsule. Tailgating (entering without keying your own code on the
   * common door) is deliberately NOT covered, to keep API calls minimal.
   *
   * Safety: purely additive and isolated. Does not touch handleRemoteUnlock()
   * (the button path), the no-show core, the PIN lifecycle, or MEWS polling.
   * Gated by `lock_arrival_checkin_enabled` (instant off-switch, no redeploy).
   * Optional `lock_arrival_log_only` = observation mode (logs intended
   * check-ins without writing to MEWS). Cadence via `lock_arrival_poll_minutes`
   * (default 60). Wrapped in try/catch so a failure never affects other jobs.
   *
   * @param force When true, bypasses the hourly time-gate (used as a final
   *              sweep at the start of no-show marking).
   */
  private _lastLockArrivalRun: number = 0;

  async _jobLockArrivals(force = false): Promise<void> {
    try {
      // Feature flag — instant off-switch without redeploy.
      const enabledSetting = await this.storage.getSetting("lock_arrival_checkin_enabled");
      if (enabledSetting?.value !== "true") return;

      // Hourly time-gate (skip when forced). Configurable via setting.
      if (!force) {
        const pollMinutesSetting = await this.storage.getSetting("lock_arrival_poll_minutes");
        const pollMinutes = Math.max(1, parseInt(pollMinutesSetting?.value || "60", 10) || 60);
        if (Date.now() - this._lastLockArrivalRun < pollMinutes * 60 * 1000) return;
        this._lastLockArrivalRun = Date.now();
      }

      const ttlockClient = this.automationEngine.getTTLockClient();
      if (!ttlockClient) return;

      const logOnlySetting = await this.storage.getSetting("lock_arrival_log_only");
      const logOnly = logOnlySetting?.value === "true";

      // Front-door / common locks are always scanned; capsule/room locks too when the
      // tenant opts in (lock_arrival_include_room_locks) — but only the room locks a
      // pending guest is actually on, so the scan scales with arrivals, not the property.
      const includeRoomLocks = (await this.storage.getSetting("lock_arrival_include_room_locks"))?.value === "true";
      const allLocks = await this.storage.getAllLockDevices();
      const commonLocks = allLocks.filter(l => l.lockType === "common");

      // Candidate PINs: active, never used, linked to a reservation.
      const allPins = await this.storage.getAllPins();
      const candidatePins = allPins.filter(
        p => p.status === "active" && !p.firstUsedAt && p.reservationId
      );
      if (candidatePins.length === 0) return;

      // Index pins by code for O(1) record matching, find the earliest validity-window
      // start to bound the lookback, and collect the room-lock ttlockIds those pins sit on.
      const pinsByCode = new Map<string, Pin>();
      let earliestValidFrom: number | null = null;
      const candidateRoomTtlockIds = new Set<string>();
      for (const pin of candidatePins) {
        pinsByCode.set(pin.code, pin);
        const vf = pin.validFrom ? new Date(pin.validFrom).getTime() : null;
        if (vf !== null && (earliestValidFrom === null || vf < earliestValidFrom)) {
          earliestValidFrom = vf;
        }
        if (includeRoomLocks) {
          for (const k of ((pin.roomLockKeyIds as any[]) || [])) {
            if (k?.ttlockId) candidateRoomTtlockIds.add(String(k.ttlockId));
          }
        }
      }

      // Only the room locks a pending guest is actually on (bounded by arrivals).
      const roomLocks = includeRoomLocks
        ? allLocks.filter(l => l.lockType === "room" && !!l.ttlockId && candidateRoomTtlockIds.has(l.ttlockId))
        : [];
      const locksToScan = [...commonLocks, ...roomLocks];
      if (locksToScan.length === 0) return;

      // Look back to the earliest candidate window, capped at 7 days to bound
      // the number of TTLock record pages we fetch.
      const maxLookbackMs = 7 * 24 * 60 * 60 * 1000;
      const sinceMs = earliestValidFrom !== null
        ? Math.max(earliestValidFrom, Date.now() - maxLookbackMs)
        : Date.now() - 24 * 60 * 60 * 1000;
      const since = new Date(sinceMs);

      // A code lives on every common door (and its own room lock), so act on each PIN once per run.
      const handled = new Set<string>();
      let totalKeypadRecords = 0;
      let totalRawRecords = 0;

      for (const lock of locksToScan) {
        try {
          const records = await ttlockClient.getAllUnlockRecordsSince(lock.ttlockId, since);
          // A keypad/passcode unlock carries the used code in `keyboardPwd`.
          // (In TTLock, passcode unlocks are recordType 4 — NOT 1, which is app
          // unlock and carries no passcode.) Match any successful unlock that
          // carries a passcode — robust across lock models/firmware — and let the
          // exact code + validity-window match below guarantee precision.
          const keypadUnlocks = records.filter(r => r.success && !!r.keyboardPwd);
          totalRawRecords += records.length;
          totalKeypadRecords += keypadUnlocks.length;

          for (const record of keypadUnlocks) {
            const pin = pinsByCode.get(record.keyboardPwd!);
            if (!pin || handled.has(pin.id) || !pin.reservationId) continue;

            const reservation = await this.storage.getReservation(pin.reservationId);
            if (!reservation) continue;

            // Match window: record must fall within the PIN's validity window,
            // so old/expired records can never false-match. A paid early
            // check-in moves the window on the LOCKS but not on the pin row —
            // fold reservation.earlyCheckinFrom, or the guest who bought
            // early access can never be matched before the base 15:00 window
            // (Anneke Hilger 24/7: paid 14:01, entered 14:03, 0 matched).
            const recordMs = record.lockDate.getTime();
            let validFromMs = pin.validFrom ? new Date(pin.validFrom).getTime() : null;
            if (validFromMs !== null && reservation.earlyCheckinFrom) {
              validFromMs = Math.min(validFromMs, new Date(reservation.earlyCheckinFrom).getTime());
            }
            const validToMs = pin.validTo ? new Date(pin.validTo).getTime() : null;
            if (validFromMs !== null && recordMs < validFromMs) continue;
            if (validToMs !== null && recordMs > validToMs) continue;

            // Idempotent: only act on confirmed reservations (skip already
            // checked-in / started / no-show / cancelled).
            if ((reservation.status || "").toLowerCase() !== "confirmed") continue;

            handled.add(pin.id);
            await this._applyLockArrival(pin, reservation, record.lockDate, lock.name, logOnly);
          }
        } catch (error) {
          await this.storage.createLog({
            level: "warn",
            message: `Lock arrival poll failed for door ${lock.name}: ${error instanceof Error ? error.message : String(error)}`,
            source: "state-machine",
          });
        }
      }

      // Heartbeat: log every run (even with 0 matches) so we can confirm the
      // job is actually running and see what it observes on the common doors.
      // Cheap (~hourly) and essential for verifying detection works.
      await this.storage.createLog({
        level: "info",
        message: `Lock arrival poll: ${locksToScan.length} door(s) [${commonLocks.length} common + ${roomLocks.length} room], ${candidatePins.length} active unused PIN(s), ${totalRawRecords} record(s) / ${totalKeypadRecords} with passcode, ${handled.size} checked in (${logOnly ? "log-only" : "live"})`,
        source: "state-machine",
        metadata: {
          doorsScanned: locksToScan.length,
          commonDoors: commonLocks.length,
          roomDoors: roomLocks.length,
          candidatePins: candidatePins.length,
          rawRecords: totalRawRecords,
          keypadRecords: totalKeypadRecords,
          matched: handled.size,
          logOnly,
          since: since.toISOString(),
        },
      });

      // Retry sweep: guests whose code/button use was DETECTED (pin marked
      // used) but whose MEWS check-in was REJECTED (e.g. 403 "assigned space
      // is blocked") stay Confirmed and are invisible to the keypad scan above
      // (it only considers unused pins). Retry them every pass so they get
      // checked in automatically once the operator unblocks the space in MEWS.
      try {
        const recentArrivals = await this.storage.getMappedReservationsByArrivalRange(
          new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
          new Date(),
        );
        for (const r of recentArrivals) {
          if ((r.status || "").toLowerCase() !== "confirmed" || !r.roomId) continue;
          const rPins = await this.storage.getPinsByRoomId(r.roomId);
          const usedPin = rPins.find(p => p.reservationId === r.id && p.firstUsedAt &&
            (p.status === "used" || p.status === "active"));
          if (!usedPin) continue;
          await this._applyLockArrival(usedPin, r, new Date(usedPin.firstUsedAt!), "retry (code used, previous MEWS check-in rejected)", logOnly);
        }
      } catch (retryError) {
        await this.storage.createLog({
          level: "warn",
          message: `Lock arrival check-in retry sweep failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
          source: "state-machine",
        });
      }

      // Lock procedure completed (guests who used their code are now MEWS
      // checked-in) → the arrival report fires right after, in the same tick,
      // so it always contains the fresh check-ins.
      this._arrivalReportDue = true;
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Lock arrival job error: ${error instanceof Error ? error.message : String(error)}`,
        source: "state-machine",
      });
    }
  }

  /**
   * Performs the check-in actions for a guest detected entering with their
   * numeric code on a common door. Mirrors handleRemoteUnlock() (the button
   * path) plus the "lock" check-in source used by simulate-pin-usage —
   * without modifying those paths.
   */
  private async _applyLockArrival(
    pin: Pin,
    reservation: Reservation,
    usedAt: Date,
    doorName: string,
    logOnly: boolean
  ): Promise<void> {
    if (logOnly) {
      await this.storage.createLog({
        level: "info",
        message: `[lock-arrival log-only] Would check in ${reservation.firstName} ${reservation.lastName} via code on ${doorName}`,
        source: "state-machine",
        reservationId: reservation.id,
        roomId: pin.roomId,
        metadata: {
          pinId: pin.id,
          code: pin.code.substring(0, 2) + "**",
          usedAt: usedAt.toISOString(),
          door: doorName,
          logOnly: true,
        },
      });
      return;
    }

    // Mark PIN as used (mirror handleRemoteUnlock).
    await this.storage.updatePinFirstUsedAt(pin.id, usedAt);
    await this.storage.updatePin(pin.id, { status: "used" });

    // MEWS write-back — same call the button uses (startReservation).
    // If MEWS REJECTS (e.g. 403 "assigned space is blocked"), the guest must
    // stay Confirmed locally too: marking them checked-in here would hide the
    // divergence (MEWS' night audit would no-show a guest we show as arrived)
    // and stop the hourly retry sweep from re-attempting.
    const mewsAccepted = reservation.status !== "Checked-in"
      ? await this.checkinInMews(reservation)
      : true;
    if (!mewsAccepted) {
      await this.storage.createLog({
        level: "warn",
        message: `Arrival detected on ${doorName} for ${reservation.firstName} ${reservation.lastName} but MEWS rejected the check-in — guest stays Confirmed; retried hourly until MEWS accepts`,
        source: "state-machine",
        reservationId: reservation.id,
        roomId: pin.roomId,
      });
      return;
    }

    // Record that this check-in originated from the lock keypad.
    await this.storage.updateReservation(reservation.id, {
      status: "checked-in",
      pmsCheckinSource: "lock",
    });

    await this.storage.createLog({
      level: "info",
      message: `Guest checked in via code on ${doorName} (front-door arrival detection)`,
      source: "state-machine",
      reservationId: reservation.id,
      roomId: pin.roomId,
      metadata: {
        pinId: pin.id,
        code: pin.code.substring(0, 2) + "**",
        usedAt: usedAt.toISOString(),
        door: doorName,
      },
    });
  }

  /**
   * Real-time entry point for the TTLock webhook (POST /api/webhooks/ttlock).
   *
   * Applies the SAME matching pipeline as the hourly _jobLockArrivals scan —
   * success + passcode present, exact code match against active unused PINs,
   * validity window, reservation Confirmed — then the same _applyLockArrival.
   * The hourly poller keeps running unchanged as the safety net; idempotency
   * comes from the shared guards (pin.firstUsedAt + reservation status).
   *
   * Gates: lock_arrival_checkin_enabled (master, shared with the poller) and
   * lock_arrival_webhook_log_only (webhook-own shadow mode, DEFAULTS TO ON —
   * must be explicitly "false" to write). Never sets _arrivalReportDue: the
   * hourly arrival report stays driven exclusively by the poller.
   */
  async handleLockUnlockRecords(
    lock: LockDevice,
    records: WebhookUnlockRecord[],
    source: "webhook" = "webhook"
  ): Promise<{ candidates: number; matched: number }> {
    const result = { candidates: 0, matched: 0 };
    try {
      const enabled = (await this.storage.getSetting("lock_arrival_checkin_enabled"))?.value === "true";
      if (!enabled) return result;

      const logOnly =
        (await this.storage.getSetting("lock_arrival_log_only"))?.value === "true" ||
        (await this.storage.getSetting("lock_arrival_webhook_log_only"))?.value !== "false";

      // Same heuristic as the poller: any successful unlock carrying a passcode
      // (recordType deliberately not filtered — robust across lock firmwares).
      const keypadUnlocks = records.filter(r =>
        (r.success === 1 || r.success === true) &&
        typeof r.keyboardPwd === "string" && r.keyboardPwd.length > 0 &&
        typeof r.lockDate === "number" && Number.isFinite(r.lockDate) && r.lockDate > 0
      );
      if (keypadUnlocks.length === 0) return result;

      const allPins = await this.storage.getAllPins();
      const candidatePins = allPins.filter(
        p => p.status === "active" && !p.firstUsedAt && p.reservationId
      );
      result.candidates = candidatePins.length;
      if (candidatePins.length === 0) return result;

      const pinsByCode = new Map<string, Pin>();
      for (const pin of candidatePins) pinsByCode.set(pin.code, pin);

      // Per-call dedup — required in log-only mode where nothing is written.
      const handled = new Set<string>();

      for (const record of keypadUnlocks) {
        const pin = pinsByCode.get(record.keyboardPwd!);
        if (!pin || handled.has(pin.id) || !pin.reservationId) continue;

        const reservation = await this.storage.getReservation(pin.reservationId);
        if (!reservation) continue;
        if ((reservation.status || "").toLowerCase() !== "confirmed") continue;

        // Validity window: old/expired records can never false-match. Fold
        // reservation.earlyCheckinFrom — a paid early check-in moves the
        // window on the LOCKS but not on the pin row (same rule as the poller).
        const recordMs = record.lockDate!;
        let validFromMs = pin.validFrom ? new Date(pin.validFrom).getTime() : null;
        if (validFromMs !== null && reservation.earlyCheckinFrom) {
          validFromMs = Math.min(validFromMs, new Date(reservation.earlyCheckinFrom).getTime());
        }
        const validToMs = pin.validTo ? new Date(pin.validTo).getTime() : null;
        if (validFromMs !== null && recordMs < validFromMs) continue;
        if (validToMs !== null && recordMs > validToMs) continue;

        handled.add(pin.id);
        result.matched++;
        await this._applyLockArrival(pin, reservation, new Date(recordMs), `${lock.name} (${source})`, logOnly);
      }

      if (result.matched > 0 || keypadUnlocks.length > 0) {
        await this.storage.createLog({
          level: "info",
          message: `Lock webhook: ${lock.name} — ${keypadUnlocks.length} passcode unlock(s), ${result.candidates} candidate PIN(s), ${result.matched} matched (${logOnly ? "log-only" : "live"})`,
          source: "state-machine",
          metadata: {
            via: source,
            lockId: lock.ttlockId,
            keypadRecords: keypadUnlocks.length,
            candidatePins: result.candidates,
            matched: result.matched,
            logOnly,
          },
        });
      }
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Lock webhook processing error on ${lock.name}: ${error instanceof Error ? error.message : String(error)}`,
        source: "state-machine",
      });
    }
    return result;
  }

  /** Extract all TTLock lock IDs (capsule/room + common) a PIN is programmed on. */
  private _collectPinLockIds(pin: Pin): string[] {
    const ids = new Set<string>();
    const add = (arr: unknown) => {
      if (Array.isArray(arr)) {
        for (const e of arr as Array<{ ttlockId?: string }>) {
          if (e && typeof e.ttlockId === "string" && e.ttlockId) ids.add(e.ttlockId);
        }
      }
    };
    add(pin.roomLockKeyIds);
    add(pin.commonAreaKeyIds);
    return Array.from(ids);
  }

  /**
   * Overnight capsule safety net — runs once per night at 05:00 property time.
   *
   * MEWS' own night audit marks no-shows at 06:00. This job runs ~1h BEFORE
   * that: for YESTERDAY's arrivals that still have an active, unused PIN (status
   * still confirmed, or already flagged no-show by our own 23:00 job), it polls
   * ALL of the guest's locks — INCLUDING the capsule/room lock, not just common
   * doors — for keypad usage. If the guest actually used their code anywhere
   * (the tailgating case the hourly front-door poll can miss), it checks them in
   * to MEWS before the 06:00 audit, preventing the false no-show + lockout.
   *
   * Bounded cost: only yesterday's still-unused arrivals (a small set), once per
   * night. Reuses lock_arrival_checkin_enabled / lock_arrival_log_only.
   * Configurable time via lock_arrival_safety_net_time (default 05:00).
   */
  private _lastSafetyNetDate: string | null = null;

  async _jobCapsuleSafetyNet(): Promise<void> {
    try {
      const enabledSetting = await this.storage.getSetting("lock_arrival_checkin_enabled");
      if (enabledSetting?.value !== "true") return;

      const timezoneSetting = await this.storage.getSetting("property_timezone");
      const timezone = timezoneSetting?.value || "Europe/Copenhagen";
      const runTimeSetting = await this.storage.getSetting("lock_arrival_safety_net_time");
      const runTime = runTimeSetting?.value || "05:00";

      const now = DateTime.now().setZone(timezone);
      const today = now.toFormat("yyyy-MM-dd");
      if (this._lastSafetyNetDate === today) return;

      const [h, m] = runTime.split(":").map(Number);
      const runAt = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
      if (now < runAt) return;

      this._lastSafetyNetDate = today;

      const ttlockClient = this.automationEngine.getTTLockClient();
      if (!ttlockClient) return;
      const logOnlySetting = await this.storage.getSetting("lock_arrival_log_only");
      const logOnly = logOnlySetting?.value === "true";

      // Yesterday's arrivals
      const yStart = now.minus({ days: 1 }).startOf("day").toJSDate();
      const yEnd = now.minus({ days: 1 }).endOf("day").toJSDate();
      const reservations = await this.storage.getMappedReservationsByArrivalRange(yStart, yEnd);

      let scanned = 0;
      let rescued = 0;
      for (const r of reservations) {
        const status = (r.status || "").toLowerCase();
        // Confirmed (not yet checked in) OR already flagged no-show by our 23:00 job.
        if (status !== "confirmed" && status !== "no-show") continue;
        if (!r.roomId) continue;

        const pins = await this.storage.getPinsByRoomId(r.roomId);
        const pin = pins.find(p => p.reservationId === r.id && p.status === "active" && !p.firstUsedAt);
        if (!pin) continue;

        const lockIds = this._collectPinLockIds(pin);
        if (lockIds.length === 0) continue;
        scanned++;

        // Fold earlyCheckinFrom — same rule as the webhook/poller matchers: a
        // paid early check-in moves the window on the locks, not the pin row.
        let validFromMs = pin.validFrom ? new Date(pin.validFrom).getTime() : null;
        if (validFromMs !== null && r.earlyCheckinFrom) {
          validFromMs = Math.min(validFromMs, new Date(r.earlyCheckinFrom).getTime());
        }
        const validToMs = pin.validTo ? new Date(pin.validTo).getTime() : null;
        const since = validFromMs !== null ? new Date(validFromMs) : now.minus({ days: 2 }).toJSDate();

        let usedAt: Date | null = null;
        for (const ttId of lockIds) {
          try {
            const records = await ttlockClient.getAllUnlockRecordsSince(ttId, since);
            const match = records.find(rec =>
              rec.success && rec.keyboardPwd === pin.code &&
              (validFromMs === null || rec.lockDate.getTime() >= validFromMs) &&
              (validToMs === null || rec.lockDate.getTime() <= validToMs)
            );
            if (match) { usedAt = match.lockDate; break; }
          } catch (error) {
            await this.storage.createLog({
              level: "warn",
              message: `Safety net poll failed for lock ${ttId}: ${error instanceof Error ? error.message : String(error)}`,
              source: "state-machine",
            });
          }
        }

        if (usedAt) {
          // Re-read to act on current state, then check in (reverses a local
          // no-show and pushes check-in to MEWS before the 06:00 audit).
          const fresh = await this.storage.getReservation(r.id);
          if (!fresh) continue;
          await this._applyLockArrival(pin, fresh, usedAt, "overnight safety net (incl. capsule)", logOnly);
          if (!logOnly) rescued++;
        }
      }

      await this.storage.createLog({
        level: "info",
        message: `Overnight capsule safety net: scanned ${scanned} unused arrival(s) from yesterday, ${rescued} checked in via code (${logOnly ? "log-only" : "live"})`,
        source: "state-machine",
      });
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Capsule safety net job error: ${error instanceof Error ? error.message : String(error)}`,
        source: "state-machine",
      });
    }
  }

  /**
   * Nightly expired PIN cleanup — runs once per night at 03:00 property time.
   * Deletes all TTLock passcodes whose validTo has passed.
   */
  private _lastNightlyCleanupDate: string | null = null;

  private async _jobNightlyExpiredPinCleanup(): Promise<void> {
    try {
      const timezoneSetting = await this.storage.getSetting("property_timezone");
      const timezone = timezoneSetting?.value || "Europe/Copenhagen";
      const now = DateTime.now().setZone(timezone);
      const today = now.toFormat("yyyy-MM-dd");

      if (this._lastNightlyCleanupDate === today) return;

      const cleanupTime = now.set({ hour: 3, minute: 0, second: 0, millisecond: 0 });
      if (now < cleanupTime) return;

      this._lastNightlyCleanupDate = today;

      // TTLock-native cleanup: lists all passcodes directly from every lock
      // and deletes expired ones — independent of DB state.
      await this.automationEngine.cleanupExpiredPasscodesFromTTLock();
    } catch (error) {
      await this.storage.createLog({
        level: "error",
        message: `Nightly PIN cleanup error: ${error instanceof Error ? error.message : String(error)}`,
        source: "state-machine",
      });
    }
  }

  // -------------------------------------------------------------------------
  // IIngestionProcessor adapter — allows MewsPoller to use state machine directly
  // -------------------------------------------------------------------------

  async processEvent(event: import("./ingestion").IngestionEvent): Promise<void> {
    switch (event.eventType) {
      case "reservation.upserted":
        await this.processReservationUpserted(event);
        break;
      case "reservation.status_changed":
        await this.processReservationStatusChanged(event);
        break;
      case "room.sync":
        await this.processRoomSync(event);
        break;
    }
  }

  async processReservationUpserted(event: import("./ingestion").ReservationUpsertedEvent): Promise<void> {
    const d = event.data;
    await this.handleReservationUpserted({
      tenantId: event.tenantId,
      pmsReservationId: d.pmsReservationId,
      status: d.status,
      firstName: d.guest.firstName,
      lastName: d.guest.lastName,
      email: d.guest.email ?? undefined,
      mobile: d.guest.mobile ?? undefined,
      arrival: d.arrival,
      departure: d.departure,
      roomPmsId: d.roomPmsId ?? undefined,
      adults: d.adults,
      children: d.children,
      groupName: d.groupName ?? undefined,
      requestedCategory: d.requestedCategory ?? undefined,
      spaceCategory: d.spaceCategory ?? undefined,
      rateName: d.rateName ?? undefined,
      origin: d.origin ?? undefined,
      reservationSource: d.reservationSource ?? undefined,
      mewsCustomerId: d.pmsCustomerId ?? undefined,
      confirmationCode: d.confirmationNumber ?? undefined,
      assignedSpace: d.roomName ?? undefined,
      avgRate: d.avgRate ? parseFloat(d.avgRate) : undefined,
      totalAmount: d.totalAmount ? parseFloat(d.totalAmount) : undefined,
      owing: d.owing ?? undefined,
    });
  }

  async processReservationStatusChanged(event: import("./ingestion").ReservationStatusChangedEvent): Promise<void> {
    await this.handleStatusChanged({
      tenantId: event.tenantId,
      pmsReservationId: event.data.pmsReservationId,
      newStatus: event.data.newStatus,
      previousStatus: event.data.previousStatus,
    });
  }

  async processRoomSync(event: import("./ingestion").RoomSyncEvent): Promise<void> {
    // Room sync (create/update rooms) is unchanged — delegate to existing processor
    const { IngestionProcessor } = await import("./ingestion-processor");
    const processor = new IngestionProcessor(
      () => this.storage,
      this.automationEngine
    );
    await processor.processRoomSync(event);
  }
}
