import type { Express, Request, Response } from "express";
import type { RouteContext } from "./index";
import { getTenantStorage, getTenantStorageAsync, verifyHotelToken, publicLimiter, resolveTenantId } from "./middleware";
import { CheckInService } from "../checkin-service";
import { appendHotelSlug } from "@shared/boarding-pass-url";
import { NotificationClient, buildEmailBrand } from "../notification-client";
import { MewsClient } from "../mews-client";
import { AutomationEngine } from "../automation";
import { Storage, globalTenantStorage, type ITenantStorage } from "../storage";
import { buildGuestFlowTheme } from "../boarding-theme";
import { buildPreCheckinUrl } from "../pre-checkin-url";
import type { Reservation } from "@shared/schema";

export function registerCheckinRoutes(app: Express, ctx: RouteContext) {
  const { defaultStorage } = ctx;

  // Resolve the tenant-scoped storage for a public check-in token. The pre-check-in
  // token is globally unique, so it identifies the owning tenant — these public
  // routes have no session/slug and must NOT assume the default (Downtown) tenant.
  async function resolveCheckinToken(
    token: string,
  ): Promise<{ reservation: Reservation; storage: ITenantStorage } | null> {
    const reservation = await globalTenantStorage.findReservationByPreCheckinToken(token);
    if (!reservation) return null;
    return { reservation, storage: Storage.forTenant(reservation.tenantId) };
  }

  // ==================== PUBLIC CHECK-IN API ====================
  // These endpoints are public (no auth required) for guest self-service

  // Get reservation info by check-in token (for displaying on check-in page)
  app.get("/api/public/check-in/:token", publicLimiter, async (req: Request, res: Response) => {
    try {
      const { token } = req.params;

      if (!token || token.length < 32) {
        return res.status(400).json({ error: "Invalid check-in token" });
      }

      // Resolve the owning tenant from the globally-unique token (public route: no
      // session). `defaultStorage` below shadows ctx.defaultStorage with that tenant.
      const resolved = await resolveCheckinToken(token);
      const defaultStorage = resolved?.storage ?? ctx.defaultStorage;
      // Display path doesn't use the automation engine — pass null so the check-in
      // page still loads during startup/deploys before a tenant's engine registers
      // (engines initialize sequentially; a non-default tenant's may not be ready yet).
      const checkInService = new CheckInService(defaultStorage, null, null);
      const reservation = await checkInService.getReservationByToken(token);

      if (!reservation) {
        return res.status(404).json({ error: "Reservation not found or invalid check-in link" });
      }

      const isWithin24Hours = checkInService.isWithin24HoursOfArrival(reservation);

      // Check if room has a mapped room-type lock
      if (!reservation.roomId || !await defaultStorage.isRoomMapped(reservation.roomId)) {
        return res.status(400).json({ error: "Your room does not have digital locks configured yet. Please contact the front desk for assistance." });
      }

      const requireIdSetting = await defaultStorage.getSetting("require_id_for_checkin");
      const requireIdForCheckin = requireIdSetting?.value === "true";

      // Refresh owing from MEWS at page load so OTA-paid bookings (Booking.com, Expedia etc.)
      // don't show stale cached balances. Silently falls back to stored value on failure.
      let currentOwing = reservation.owing;
      try {
        const mewsClientToken = await defaultStorage.getSetting("mews_client_token");
        const mewsAccessToken = await defaultStorage.getSetting("mews_access_token");
        const mewsEnvironment = await defaultStorage.getSetting("mews_environment");
        if (mewsClientToken?.value && mewsAccessToken?.value && reservation.mewsCustomerId) {
          const env = (mewsEnvironment?.value === "production" ? "production" : "demo") as "demo" | "production";
          const mewsClient = new MewsClient(mewsClientToken.value, mewsAccessToken.value, env);
          const billBalance = await mewsClient.getCustomerBillBalance(reservation.mewsCustomerId);
          if (billBalance !== null) {
            const freshOwing = billBalance.value.toFixed(2);
            if (freshOwing !== reservation.owing) {
              await defaultStorage.updateReservation(reservation.id, { owing: freshOwing });
              await defaultStorage.createLog({
                level: "info",
                message: `Balance refreshed at check-in load: ${freshOwing} (previous: ${reservation.owing || "0"})`,
                source: "checkin",
                reservationId: reservation.id,
              });
            }
            currentOwing = freshOwing;
          }
        }
      } catch (err) {
        console.error("Failed to refresh balance at check-in load:", err);
      }

      const themeSettings = await defaultStorage.getAllSettings();
      const themeGet = (k: string) => themeSettings.find(s => s.key === k)?.value;

      res.json({
        reservation: {
          id: reservation.id,
          guestName: `${reservation.firstName} ${reservation.lastName}`,
          arrival: reservation.arrival,
          departure: reservation.departure,
          room: reservation.room || reservation.assignedSpace,
          email: reservation.email,
          confirmationCode: reservation.confirmationCode,
          preCheckinStatus: reservation.preCheckinStatus,
          codeDeliveredAt: reservation.codeDeliveredAt,
          owing: currentOwing,
          currency: reservation.currency,
          paymentVerifiedAt: reservation.paymentVerifiedAt,
        },
        canCheckIn: isWithin24Hours,
        checkInAvailableFrom: new Date(new Date(reservation.arrival).getTime() - 24 * 60 * 60 * 1000),
        requireGuestProfile: requireIdForCheckin,
        theme: buildGuestFlowTheme(themeGet),
      });
    } catch (error) {
      console.error("Check-in info error:", error);
      res.status(500).json({ error: "Failed to retrieve check-in information" });
    }
  });

  // Initiate check-in (validates token, checks payment, sends code if paid)
  app.post("/api/public/check-in/:token/initiate", publicLimiter, async (req: Request, res: Response) => {
    try {
      const { token } = req.params;
      const { personalEmail, preferredChannel, guestProfile } = req.body || {};

      if (!token || token.length < 32) {
        return res.status(400).json({ success: false, error: "Invalid check-in token" });
      }

      // Resolve the owning tenant from the globally-unique token (public route: no
      // session). `defaultStorage` below shadows ctx.defaultStorage with that tenant.
      const resolved = await resolveCheckinToken(token);
      const defaultStorage = resolved?.storage ?? ctx.defaultStorage;

      // Save personalEmail and preferredChannel if provided
      if (personalEmail || preferredChannel) {
        const reservation = await defaultStorage.getReservationByPreCheckinToken(token);
        if (reservation) {
          const updates: Record<string, any> = {};
          if (personalEmail) updates.personalEmail = personalEmail;
          if (preferredChannel) updates.preferredChannel = preferredChannel;
          await defaultStorage.updateReservation(reservation.id, updates);
        }
      }

      // Get MEWS client if configured
      let mewsClient: MewsClient | null = null;
      const mewsClientToken = await defaultStorage.getSetting("mews_client_token");
      const mewsAccessToken = await defaultStorage.getSetting("mews_access_token");
      const mewsEnvironment = await defaultStorage.getSetting("mews_environment");

      if (mewsClientToken?.value && mewsAccessToken?.value) {
        const environment = (mewsEnvironment?.value === "production" ? "production" : "demo") as "demo" | "production";
        mewsClient = new MewsClient(mewsClientToken.value, mewsAccessToken.value, environment);
      }

      // Server-side validation: if require_id_for_checkin is enabled, guestProfile must include nationality + ID document
      const requireIdSetting = await defaultStorage.getSetting("require_id_for_checkin");
      if (requireIdSetting?.value === "true") {
        if (!guestProfile?.nationality || !guestProfile?.identityDocument?.number || !guestProfile?.identityDocument?.type) {
          return res.status(400).json({
            success: false,
            status: "error",
            message: "Please provide your nationality and ID document information to complete check-in",
          });
        }
      }

      // Sync email + guest profile to MEWS in a single call to avoid overwrites
      let guestSubmittedId = false;
      if (mewsClient) {
        const reservation = await defaultStorage.getReservationByPreCheckinToken(token);
        if (reservation?.mewsCustomerId) {
          const profileWithEmail = {
            email: personalEmail || undefined,
            ...(guestProfile || {}),
          };
          const syncResult = await mewsClient.syncGuestProfile(reservation.mewsCustomerId, profileWithEmail);
          if (!syncResult.success) {
            console.warn(`[PreCheckin] MEWS profile sync had errors for ${reservation.id}: ${syncResult.errors.join(", ")}`);
            await defaultStorage.createLog({
              level: "warning",
              message: `Guest profile sync to MEWS had errors: ${syncResult.errors.join(", ")}`,
              source: "checkin",
              reservationId: reservation.id,
            });
          } else {
            console.log(`[PreCheckin] Guest profile synced to MEWS for reservation ${reservation.id}`);
            await defaultStorage.createLog({
              level: "info",
              message: `Guest profile synced to MEWS (nationality, address, ID document)`,
              source: "checkin",
              reservationId: reservation.id,
            });
          }
          if (guestProfile.identityDocument?.number) {
            guestSubmittedId = true;
          }
        }
      }

      const automationEngine = ctx.getAutomationEngine(resolved?.reservation.tenantId ?? resolveTenantId(req));
      const checkInService = new CheckInService(defaultStorage, mewsClient, automationEngine);
      const result = await checkInService.initiateCheckIn(token, { guestSubmittedId });

      if (result.success) {
        res.json(result);
      } else {
        res.status(result.status === "error" ? 400 : 200).json(result);
      }
    } catch (error) {
      console.error("Check-in initiate error:", error);
      res.status(500).json({ success: false, status: "error", message: "Failed to process check-in" });
    }
  });

  // Request payment (creates MEWS payment request if not paid)
  app.post("/api/public/check-in/:token/request-payment", publicLimiter, async (req: Request, res: Response) => {
    try {
      const { token } = req.params;

      if (!token || token.length < 32) {
        return res.status(400).json({ success: false, error: "Invalid check-in token" });
      }

      // Resolve the owning tenant from the globally-unique token (public route: no
      // session). `defaultStorage` below shadows ctx.defaultStorage with that tenant.
      const resolved = await resolveCheckinToken(token);
      const defaultStorage = resolved?.storage ?? ctx.defaultStorage;

      // Get MEWS client
      const mewsClientToken = await defaultStorage.getSetting("mews_client_token");
      const mewsAccessToken = await defaultStorage.getSetting("mews_access_token");
      const mewsEnvironment = await defaultStorage.getSetting("mews_environment");

      if (!mewsClientToken?.value || !mewsAccessToken?.value) {
        return res.status(503).json({ success: false, error: "Payment system not configured" });
      }

      const environment = (mewsEnvironment?.value === "production" ? "production" : "demo") as "demo" | "production";
      const mewsClient = new MewsClient(mewsClientToken.value, mewsAccessToken.value, environment);

      const checkInService = new CheckInService(defaultStorage, mewsClient, null);
      const reservation = await checkInService.getReservationByToken(token);

      if (!reservation) {
        return res.status(404).json({ success: false, error: "Reservation not found" });
      }

      if (!reservation.mewsCustomerId) {
        return res.status(400).json({ success: false, error: "No MEWS customer ID for this reservation" });
      }

      const owingAmount = reservation.owing ? parseFloat(reservation.owing) : 0;
      if (owingAmount <= 0) {
        return res.status(400).json({ success: false, error: "No outstanding balance" });
      }

      const expirationDate = new Date();
      expirationDate.setDate(expirationDate.getDate() + 7);

      const paymentReq = await mewsClient.createPaymentRequest(
        reservation.mewsCustomerId,
        owingAmount,
        reservation.currency || "EUR",
        reservation.pmsId,
        `Payment for reservation ${reservation.confirmationCode || reservation.pmsId}`,
        expirationDate.toISOString(),
        false // sendEmail=false — we redirect directly
      );

      const paymentUrl = mewsClient.getPaymentRequestUrl(paymentReq.Id);
      res.json({ success: true, paymentUrl });
    } catch (error) {
      console.error("Request payment error:", error);
      res.status(500).json({ success: false, error: "Failed to request payment" });
    }
  });

  // ==================== ADMIN CHECK-IN ENDPOINTS ====================
  // These endpoints require hotel authentication

  // Generate check-in token for a reservation (admin endpoint)
  app.post("/api/reservations/:id/generate-checkin-token", async (req: Request, res: Response) => {
    try {
      const session = await verifyHotelToken(req);
      if (!session) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const storage = await getTenantStorageAsync(req);
      const { id } = req.params;

      const reservation = await storage.getReservation(id);
      if (!reservation) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      if (reservation.preCheckinToken) {
        return res.json({
          token: reservation.preCheckinToken,
          preCheckinUrl: `/check-in/${reservation.preCheckinToken}`,
        });
      }

      const checkInService = new CheckInService(storage, null, null);
      const token = checkInService.generatePreCheckinToken();

      await storage.updateReservation(id, { preCheckinToken: token });

      res.json({
        token,
        checkInUrl: `/check-in/${token}`,
      });
    } catch (error) {
      console.error("Generate check-in token error:", error);
      res.status(500).json({ error: "Failed to generate check-in token" });
    }
  });

  // Retry MEWS check-in for reservations with sync failures
  app.post("/api/reservations/:id/retry-mews-checkin", async (req: Request, res: Response) => {
    try {
      const session = await verifyHotelToken(req);
      if (!session) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const storage = await getTenantStorageAsync(req);
      const { id } = req.params;

      const reservation = await storage.getReservation(id);
      if (!reservation) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      if (!reservation.pmsId) {
        return res.status(400).json({ error: "Reservation has no MEWS ID" });
      }

      // Get MEWS credentials for this tenant
      const mewsClientToken = await storage.getSetting("mews_client_token");
      const mewsAccessToken = await storage.getSetting("mews_access_token");
      const mewsEnvironment = await storage.getSetting("mews_environment");

      if (!mewsClientToken?.value || !mewsAccessToken?.value) {
        return res.status(503).json({ error: "MEWS not configured for this hotel" });
      }

      const environment = (mewsEnvironment?.value === "production" ? "production" : "demo") as "demo" | "production";
      const mewsClient = new MewsClient(mewsClientToken.value, mewsAccessToken.value, environment);

      // Attempt to start reservation in MEWS.
      // NOTE: startReservation never throws — it returns {success:false, error}
      // on rejection, so the flag MUST be checked (ignoring it silently
      // reported rejected check-ins as successful — the Martinsen incident).
      try {
        const startResult = await mewsClient.startReservation(reservation.pmsId);
        if (!startResult.success) {
          throw new Error(startResult.error || "MEWS rejected the check-in");
        }

        // Update status to code_sent (successful sync)
        await storage.updateReservation(id, {
          preCheckinStatus: "code_sent",
        });

        await storage.createLog({
          level: "info",
          source: "checkin",
          message: `MEWS check-in retry successful for reservation ${reservation.pmsId}`,
          reservationId: id,
        });

        res.json({ success: true, message: "MEWS check-in successful" });
      } catch (mewsError) {
        await storage.createLog({
          level: "error",
          source: "checkin",
          message: `MEWS check-in retry failed: ${mewsError}`,
          reservationId: id,
          metadata: { error: String(mewsError) },
        });

        res.status(400).json({
          error: `MEWS check-in failed: ${mewsError instanceof Error ? mewsError.message : String(mewsError)}`,
        });
      }
    } catch (error) {
      console.error("Retry MEWS check-in error:", error);
      res.status(500).json({ error: "Failed to retry MEWS check-in" });
    }
  });

  // Resend notification (access code) for reservations where notification failed
  app.post("/api/reservations/:id/resend-notification", async (req: Request, res: Response) => {
    try {
      const session = await verifyHotelToken(req);
      if (!session) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const storage = await getTenantStorageAsync(req);
      const { id } = req.params;

      const reservation = await storage.getReservation(id);
      if (!reservation) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      if (!reservation.generatedPin) {
        return res.status(400).json({ error: "No access code exists for this reservation" });
      }

      if (!reservation.roomId || !await storage.isRoomMapped(reservation.roomId)) {
        return res.status(400).json({ error: "Room does not have digital locks configured. Cannot send notification." });
      }

      const automationEngine = await AutomationEngine.initialize(storage);
      const checkinService = new CheckInService(storage, null, automationEngine);
      const result = await checkinService.sendAccessCode(reservation);

      if (result.success) {
        await storage.createLog({
          level: "info",
          source: "checkin",
          message: `Digital key resent via all channels for reservation ${reservation.pmsId}`,
          reservationId: id,
        });

        res.json({ success: true, message: "Digital key sent successfully" });
      } else {
        await storage.createLog({
          level: "error",
          source: "checkin",
          message: `Digital key resend failed: ${result.error}`,
          reservationId: id,
          metadata: { error: result.error },
        });

        res.status(400).json({
          error: result.error || "Failed to send digital key",
        });
      }
    } catch (error) {
      console.error("Resend notification error:", error);
      res.status(500).json({ error: "Failed to resend notification" });
    }
  });

  // Send pre-check-in email for a specific reservation
  app.post("/api/reservations/:id/send-precheckin-email", async (req: Request, res: Response) => {
    try {
      const session = await verifyHotelToken(req);
      if (!session) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const storage = await getTenantStorageAsync(req);
      const { id } = req.params;

      const reservation = await storage.getReservation(id);
      if (!reservation) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      if (!reservation.generatedPin) {
        return res.status(400).json({ error: "No PIN exists for this reservation. Generate a PIN first." });
      }

      if (!reservation.email) {
        return res.status(400).json({ error: "No email address for this reservation" });
      }

      if (!reservation.roomId || !await storage.isRoomMapped(reservation.roomId)) {
        return res.status(400).json({ error: "Room does not have digital locks configured. Cannot send pre-check-in email." });
      }

      const room = reservation.roomId ? await storage.getRoom(reservation.roomId) : null;

      // Get settings
      const hotelSlugSetting = await storage.getSetting("hotel_slug");
      const hotelNameSetting = await storage.getSetting("hotel_name");
      const appBaseUrlSetting = await storage.getSetting("app_base_url");

      const hotelSlug = hotelSlugSetting?.value || "default";
      const hotelName = hotelNameSetting?.value || "DreamBoks";
      const appBaseUrl = appBaseUrlSetting?.value || "https://lock.dreamboks.net";

      // Ensure a unique pre-checkin token exists for this reservation
      let preCheckinToken = reservation.preCheckinToken;
      if (!preCheckinToken) {
        const checkInService = new CheckInService(storage, null, null);
        preCheckinToken = checkInService.generatePreCheckinToken();
        await storage.updateReservation(id, { preCheckinToken });
      }

      const checkInUrl = buildPreCheckinUrl({
        baseUrl: appBaseUrl,
        hotelSlug: hotelSlugSetting?.value,
        preCheckinToken,
      });
      const { format } = await import("date-fns");
      const arrivalDate = format(new Date(reservation.arrival), "EEEE, MMMM d, yyyy");
      const departureDate = format(new Date(reservation.departure), "EEEE, MMMM d, yyyy");

      // Initialize notification client
      const twilioAccountSid = await storage.getSetting("twilio_account_sid");
      const twilioAuthToken = await storage.getSetting("twilio_auth_token");
      const twilioFromNumber = await storage.getSetting("twilio_from_number");
      const sendgridApiKey = await storage.getSetting("sendgrid_api_key");
      const sendgridFromEmail = await storage.getSetting("sendgrid_from_email");

      const notificationClient = new NotificationClient({
        twilioAccountSid: twilioAccountSid?.value,
        twilioAuthToken: twilioAuthToken?.value,
        twilioFromNumber: twilioFromNumber?.value,
        sendgridApiKey: sendgridApiKey?.value,
        sendgridFromEmail: sendgridFromEmail?.value,
      });

      const testEmailSetting = await storage.getSetting("boarding_test_email");
      const recipientEmail = testEmailSetting?.value || reservation.email;
      const isTestMode = !!testEmailSetting?.value;

      const emailResult = await notificationClient.sendPreCheckInPlainTextEmail({
        email: recipientEmail,
        guestName: reservation.firstName,
        hotelName,
        checkInUrl,
        arrivalDate,
        departureDate,
      });

      if (emailResult.success) {
        await storage.updateReservation(id, { preCheckinEmailSent: true });
        await storage.createLog({
          level: "info",
          source: "checkin",
          message: isTestMode
            ? `Pre-check-in email sent to TEST (${recipientEmail}) for ${reservation.firstName} ${reservation.lastName} (real: ${reservation.email})`
            : `Pre-check-in email sent to ${reservation.email}`,
          reservationId: id,
          metadata: { testMode: isTestMode, recipientEmail, guestEmail: reservation.email },
        });
        res.json({
          success: true,
          message: isTestMode
            ? `Pre-check-in email sent to TEST address (${recipientEmail})`
            : `Pre-check-in email sent to ${reservation.email}`,
        });
      } else {
        await storage.createLog({
          level: "error",
          source: "checkin",
          message: `Failed to send pre-check-in email: ${emailResult.error}`,
          reservationId: id,
        });
        res.status(400).json({ error: emailResult.error || "Failed to send email" });
      }
    } catch (error) {
      console.error("Send pre-check-in email error:", error);
      res.status(500).json({ error: "Failed to send pre-check-in email" });
    }
  });

  // Send pre-check-in SMS/WhatsApp for a specific reservation
  app.post("/api/reservations/:id/send-precheckin-sms", async (req: Request, res: Response) => {
    try {
      const session = await verifyHotelToken(req);
      if (!session) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const storage = await getTenantStorageAsync(req);
      const { id } = req.params;

      const reservation = await storage.getReservation(id);
      if (!reservation) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      if (!reservation.generatedPin) {
        return res.status(400).json({ error: "No PIN exists for this reservation. Generate a PIN first." });
      }

      const testPhoneSetting = await storage.getSetting("boarding_test_phone");
      const recipientMobile = testPhoneSetting?.value || reservation.mobile;

      if (!recipientMobile) {
        return res.status(400).json({ error: "No mobile number for this reservation" });
      }

      if (!reservation.roomId || !await storage.isRoomMapped(reservation.roomId)) {
        return res.status(400).json({ error: "Room does not have digital locks configured." });
      }

      const hotelSlugSetting = await storage.getSetting("hotel_slug");
      const hotelNameSetting = await storage.getSetting("hotel_name");
      const appBaseUrlSetting = await storage.getSetting("app_base_url");

      const hotelName = hotelNameSetting?.value || "DreamBoks";
      const appBaseUrl = appBaseUrlSetting?.value || "https://lock.dreamboks.net";

      // Ensure a pre-checkin token exists (find-by-name link ignores it, but the
      // no-slug fallback to /check-in/<token> needs it) — mirrors the email endpoint.
      let preCheckinToken = reservation.preCheckinToken;
      if (!preCheckinToken) {
        const checkInService = new CheckInService(storage, null, null);
        preCheckinToken = checkInService.generatePreCheckinToken();
        await storage.updateReservation(id, { preCheckinToken });
      }

      // Same link as the pre-check-in EMAIL (buildPreCheckinUrl): /<slug>/find when slug set.
      const checkInUrl = buildPreCheckinUrl({
        baseUrl: appBaseUrl,
        hotelSlug: hotelSlugSetting?.value,
        preCheckinToken,
      });

      const twilioAccountSid = await storage.getSetting("twilio_account_sid");
      const twilioAuthToken = await storage.getSetting("twilio_auth_token");
      const twilioFromNumber = await storage.getSetting("twilio_from_number");
      const twilioMessagingServiceSid = await storage.getSetting("twilio_messaging_service_sid");
      const whatsappEnabled = await storage.getSetting("whatsapp_enabled");

      if (!twilioAccountSid?.value || !twilioAuthToken?.value || !twilioFromNumber?.value) {
        return res.status(400).json({ error: "Twilio is not configured. Add Twilio credentials in Settings." });
      }

      const notificationClient = new NotificationClient({
        twilioAccountSid: twilioAccountSid.value,
        twilioAuthToken: twilioAuthToken.value,
        twilioFromNumber: twilioFromNumber.value,
        twilioMessagingServiceSid: twilioMessagingServiceSid?.value,
        whatsappEnabled: whatsappEnabled?.value === "true",
      });

      const isTestMode = !!testPhoneSetting?.value;

      const smsResult = await notificationClient.sendPreCheckInSMS({
        mobile: recipientMobile,
        pin: reservation.generatedPin,
        checkInUrl,
        hotelName,
      });

      const whatsappResult = await notificationClient.sendPreCheckInWhatsApp({
        mobile: recipientMobile,
        pin: reservation.generatedPin,
        checkInUrl,
        hotelName,
      });

      const anySuccess = smsResult.success || whatsappResult.success;
      const channels = [
        smsResult.success ? "SMS" : null,
        whatsappResult.success ? "WhatsApp" : null,
      ].filter(Boolean).join(" + ");

      if (anySuccess) {
        await storage.updateReservation(id, { preCheckinEmailSent: true });
        const targetInfo = isTestMode ? `test number (${recipientMobile})` : recipientMobile;
        await storage.createLog({
          level: "info",
          source: "checkin",
          message: `Pre-check-in sent via ${channels} to ${targetInfo}`,
          reservationId: id,
          metadata: { testMode: isTestMode, channels },
        });
        res.json({ success: true, message: `Pre-check-in sent via ${channels}${isTestMode ? " (test mode)" : ""}` });
      } else {
        const errors = [smsResult.error, whatsappResult.error].filter(Boolean).join("; ");
        await storage.createLog({
          level: "error",
          source: "checkin",
          message: `Failed to send pre-check-in SMS/WhatsApp: ${errors}`,
          reservationId: id,
        });
        res.status(400).json({ error: errors || "Failed to send SMS/WhatsApp" });
      }
    } catch (error) {
      console.error("Send pre-check-in SMS error:", error);
      res.status(500).json({ error: "Failed to send SMS/WhatsApp" });
    }
  });

  // Bulk send pre-check-in emails for reservations with PINs but no email sent
  app.post("/api/reservations/bulk-send-precheckin-emails", async (req: Request, res: Response) => {
    try {
      const session = await verifyHotelToken(req);
      if (!session) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const storage = await getTenantStorageAsync(req);

      // Get all confirmed reservations with PINs but no pre-check-in email sent
      const allReservations = await storage.getAllReservations();
      const eligibleReservations = allReservations.filter(r =>
        r.status === "Confirmed" &&
        r.generatedPin &&
        !r.preCheckinEmailSent &&
        r.email &&
        new Date(r.arrival) > new Date()
      );

      // Get settings
      const hotelSlugSetting = await storage.getSetting("hotel_slug");
      const hotelNameSetting = await storage.getSetting("hotel_name");
      const appBaseUrlSetting = await storage.getSetting("app_base_url");

      const hotelSlug = hotelSlugSetting?.value || "default";
      const hotelName = hotelNameSetting?.value || "DreamBoks";
      const appBaseUrl = appBaseUrlSetting?.value || "https://lock.dreamboks.net";

      // Initialize notification client
      const twilioAccountSid = await storage.getSetting("twilio_account_sid");
      const twilioAuthToken = await storage.getSetting("twilio_auth_token");
      const twilioFromNumber = await storage.getSetting("twilio_from_number");
      const sendgridApiKey = await storage.getSetting("sendgrid_api_key");
      const sendgridFromEmail = await storage.getSetting("sendgrid_from_email");

      const notificationClient = new NotificationClient({
        twilioAccountSid: twilioAccountSid?.value,
        twilioAuthToken: twilioAuthToken?.value,
        twilioFromNumber: twilioFromNumber?.value,
        sendgridApiKey: sendgridApiKey?.value,
        sendgridFromEmail: sendgridFromEmail?.value,
      });

      const { format } = await import("date-fns");
      const results = { sent: 0, failed: 0, skipped: 0, errors: [] as string[] };

      for (const reservation of eligibleReservations) {
        try {
          if (!reservation.roomId || !await storage.isRoomMapped(reservation.roomId)) {
            results.skipped++;
            continue;
          }

          // Ensure a unique pre-checkin token exists
          let preCheckinToken = reservation.preCheckinToken;
          if (!preCheckinToken) {
            const checkInService = new CheckInService(storage, null, null);
            preCheckinToken = checkInService.generatePreCheckinToken();
            await storage.updateReservation(reservation.id, { preCheckinToken });
          }

          const checkInUrl = buildPreCheckinUrl({
            baseUrl: appBaseUrl,
            hotelSlug: hotelSlugSetting?.value,
            preCheckinToken,
          });
          const arrivalDate = format(new Date(reservation.arrival), "EEEE, MMMM d, yyyy");
          const departureDate = format(new Date(reservation.departure), "EEEE, MMMM d, yyyy");

          const emailResult = await notificationClient.sendPreCheckInPlainTextEmail({
            email: reservation.email!,
            guestName: reservation.firstName,
            hotelName,
            checkInUrl,
            arrivalDate,
            departureDate,
          });

          if (emailResult.success) {
            await storage.updateReservation(reservation.id, { preCheckinEmailSent: true });
            results.sent++;
          } else {
            results.failed++;
            results.errors.push(`${reservation.firstName} ${reservation.lastName}: ${emailResult.error}`);
          }
        } catch (err) {
          results.failed++;
          results.errors.push(`${reservation.firstName} ${reservation.lastName}: ${err}`);
        }
      }

      await storage.createLog({
        level: "info",
        source: "checkin",
        message: `Bulk pre-check-in email: ${results.sent} sent, ${results.failed} failed`,
        metadata: { eligible: eligibleReservations.length, sent: results.sent, failed: results.failed },
      });

      res.json({
        success: true,
        eligible: eligibleReservations.length,
        sent: results.sent,
        failed: results.failed,
        errors: results.errors.slice(0, 10), // Limit errors shown
      });
    } catch (error) {
      console.error("Bulk send pre-check-in emails error:", error);
      res.status(500).json({ error: "Failed to send bulk pre-check-in emails" });
    }
  });

  // Kiosk/Reception check-in: Activate PIN + MEWS check-in
  // Used when check_in_method is "physical_required" or "physical_mews_only"
  app.post("/api/reservations/:id/kiosk-checkin", async (req: Request, res: Response) => {
    try {
      const session = await verifyHotelToken(req);
      if (!session) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const storage = await getTenantStorageAsync(req);
      const { id } = req.params;

      const reservation = await storage.getReservation(id);
      if (!reservation) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      if (reservation.status === "checked-in") {
        return res.status(400).json({ error: "Guest is already checked in" });
      }

      const checkInMethodSetting = await storage.getSetting("check_in_method");
      const checkInMethod = checkInMethodSetting?.value || "door_unlock";

      // Get MEWS client
      const mewsClientToken = await storage.getSetting("mews_client_token");
      const mewsAccessToken = await storage.getSetting("mews_access_token");
      const mewsEnvironment = await storage.getSetting("mews_environment");

      let mewsClient: MewsClient | null = null;
      if (mewsClientToken?.value && mewsAccessToken?.value) {
        const environment = (mewsEnvironment?.value === "production" ? "production" : "demo") as "demo" | "production";
        mewsClient = new MewsClient(mewsClientToken.value, mewsAccessToken.value, environment);
      }

      // Create automation engine for PIN activation
      const automationEngine = await AutomationEngine.initialize(storage);

      const results: { pinActivated: boolean; mewsCheckedIn: boolean; errors: string[] } = {
        pinActivated: false,
        mewsCheckedIn: false,
        errors: [],
      };

      // For "physical_required" mode: Activate pending PIN first
      if (checkInMethod === "physical_required" && reservation.generatedPin) {
        const existingPins = await storage.getAllPins();
        const pendingPin = existingPins.find(
          p => p.reservationId === id && p.status === "pending"
        );

        if (pendingPin) {
          const activationResult = await automationEngine.getPinLifecycle().activatePendingForReservation(id);
          if (activationResult.success) {
            results.pinActivated = true;
            await storage.createLog({
              level: "info",
              source: "checkin",
              message: "PIN activated via kiosk check-in",
              reservationId: id,
            });
          } else {
            results.errors.push(`PIN activation failed: ${activationResult.error}`);
          }
        } else {
          // PIN might already be active
          const activePin = existingPins.find(
            p => p.reservationId === id && p.status === "active"
          );
          if (activePin) {
            results.pinActivated = true;
          }
        }
      } else {
        // For other modes, PIN should already be active
        results.pinActivated = true;
      }

      // Trigger MEWS check-in
      if (mewsClient && reservation.pmsId) {
        try {
          const mewsResult = await mewsClient.startReservation(reservation.pmsId);
          if (mewsResult.success) {
            results.mewsCheckedIn = true;
          } else {
            results.errors.push(`MEWS check-in failed: ${mewsResult.error}`);
          }
        } catch (mewsError) {
          results.errors.push(`MEWS error: ${mewsError instanceof Error ? mewsError.message : String(mewsError)}`);
        }
      } else if (!mewsClient) {
        // MEWS not configured - still allow local check-in but warn
        results.errors.push("MEWS not configured - guest marked as checked in locally only");
        await storage.createLog({
          level: "warn",
          source: "checkin",
          message: "Kiosk check-in: MEWS not configured, local check-in only",
          reservationId: id,
        });
      }

      // Update reservation status if PIN was activated or MEWS succeeded (or MEWS not configured)
      if (results.mewsCheckedIn || (!mewsClient && results.pinActivated)) {
        await storage.updateReservation(id, {
          status: "checked-in",
          pmsCheckinSource: "kiosk",
        });

        await storage.createLog({
          level: "info",
          source: "checkin",
          message: `Guest checked in via kiosk/reception (method: ${checkInMethod})`,
          reservationId: id,
          metadata: {
            pinActivated: results.pinActivated,
            mewsCheckedIn: results.mewsCheckedIn,
            checkInMethod,
          },
        });
      }

      // Return error only if we couldn't complete check-in at all
      if (!results.mewsCheckedIn && mewsClient && results.errors.length > 0) {
        return res.status(400).json({
          success: false,
          errors: results.errors,
          pinActivated: results.pinActivated,
          mewsCheckedIn: results.mewsCheckedIn,
        });
      }

      res.json({
        success: true,
        message: "Guest checked in successfully",
        pinActivated: results.pinActivated,
        mewsCheckedIn: results.mewsCheckedIn,
        errors: results.errors.length > 0 ? results.errors : undefined,
      });
    } catch (error) {
      console.error("Kiosk check-in error:", error);
      res.status(500).json({ error: "Failed to process kiosk check-in" });
    }
  });

  // Admin: send boarding pass to all available channels (email + SMS + WhatsApp)
  // Bypasses ID verification since this is a staff action
  app.post("/api/reservations/:id/send-boarding-pass", async (req: Request, res: Response) => {
    try {
      const session = await verifyHotelToken(req);
      if (!session) return res.status(401).json({ error: "Authentication required" });

      const storage = await getTenantStorageAsync(req);
      const reservation = await storage.getReservation(req.params.id);
      if (!reservation) return res.status(404).json({ error: "Reservation not found" });
      if (!reservation.generatedPin) return res.status(400).json({ error: "No access code for this reservation" });

      // Staff can always send boarding pass — no payment gate

      const hotelSlugSetting = await storage.getSetting("hotel_slug");
      const hotelNameSetting = await storage.getSetting("hotel_name");
      const appBaseUrlSetting = await storage.getSetting("app_base_url");
      const hotelSlug = hotelSlugSetting?.value || "default";
      const hotelName = hotelNameSetting?.value || "DreamBoks";
      const appBaseUrl = appBaseUrlSetting?.value || "https://lock.dreamboks.net";

      const resIdentifier = reservation.extId || reservation.confirmationCode;
      const boardingPassUrl = appendHotelSlug(`${appBaseUrl}/boarding-pass?res=${encodeURIComponent(resIdentifier!)}&name=${encodeURIComponent(reservation.lastName)}`, hotelSlugSetting?.value);

      const twilioAccountSid = await storage.getSetting("twilio_account_sid");
      const twilioAuthToken = await storage.getSetting("twilio_auth_token");
      const twilioFromNumber = await storage.getSetting("twilio_from_number");
      const twilioMessagingServiceSid = await storage.getSetting("twilio_messaging_service_sid");
      const whatsappEnabled = await storage.getSetting("whatsapp_enabled");
      const sendgridApiKey = await storage.getSetting("sendgrid_api_key");
      const sendgridFromEmail = await storage.getSetting("sendgrid_from_email");
      const emailBrand = await buildEmailBrand(storage);

      const notifClient = new NotificationClient({
        twilioAccountSid: twilioAccountSid?.value,
        twilioAuthToken: twilioAuthToken?.value,
        twilioFromNumber: twilioFromNumber?.value,
        twilioMessagingServiceSid: twilioMessagingServiceSid?.value,
        whatsappEnabled: whatsappEnabled?.value === "true",
        sendgridApiKey: sendgridApiKey?.value,
        sendgridFromEmail: sendgridFromEmail?.value,
        brand: emailBrand,
      });

      const testEmailSetting = await storage.getSetting("boarding_test_email");
      const testPhoneSetting = await storage.getSetting("boarding_test_phone");
      const recipientEmail = testEmailSetting?.value || reservation.personalEmail || reservation.email;
      const recipientMobile = testPhoneSetting?.value || reservation.mobile;

      const { format } = await import("date-fns");
      const arrivalDate = format(new Date(reservation.arrival), "EEEE, MMMM d, yyyy");
      const departureDate = format(new Date(reservation.departure), "EEEE, MMMM d, yyyy");

      const results: Record<string, boolean> = {};

      if (recipientEmail) {
        const r = await notifClient.sendBoardingPassEmail({
          email: recipientEmail,
          guestName: `${reservation.firstName} ${reservation.lastName}`,
          reservationNumber: resIdentifier!,
          lastName: reservation.lastName,
          arrivalDate,
          departureDate,
          baseUrl: appBaseUrl,
          hotelSlug: hotelSlugSetting?.value,
          accessCode: reservation.generatedPin,
        });
        results.email = r.success;
      }

      if (recipientMobile) {
        const sms = await notifClient.sendBoardingPassSMS({
          mobile: recipientMobile,
          guestName: `${reservation.firstName} ${reservation.lastName}`,
          boardingPassUrl,
          hotelName,
        });
        results.sms = sms.success;

        const wa = await notifClient.sendBoardingPassWhatsApp({
          mobile: recipientMobile,
          guestName: `${reservation.firstName} ${reservation.lastName}`,
          boardingPassUrl,
          hotelName,
        });
        results.whatsapp = wa.success;
      }

      const anySent = Object.values(results).some(Boolean);
      const channels = Object.entries(results).filter(([, ok]) => ok).map(([ch]) => ch.toUpperCase()).join(" + ");

      await storage.createLog({
        level: "info",
        source: "checkin",
        message: `Boarding pass sent via ${channels || "no channels"} by staff for ${reservation.firstName} ${reservation.lastName}`,
        reservationId: reservation.id,
      });

      res.json({ success: anySent, channels, results });
    } catch (error) {
      console.error("Send boarding pass error:", error);
      res.status(500).json({ error: "Failed to send boarding pass" });
    }
  });

  // Send check-in link email to guest
  app.post("/api/send-checkin-email", async (req: Request, res: Response) => {
    try {
      const session = await verifyHotelToken(req);
      if (!session) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { email, guestName, checkInUrl, reservationId } = req.body;

      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }
      if (!checkInUrl) {
        return res.status(400).json({ error: "Check-in URL is required" });
      }

      const client = new NotificationClient({});

      // Get reservation details for arrival date (tenant-scoped)
      const storage = await getTenantStorageAsync(req);
      let arrivalDate: string | undefined;

      if (reservationId) {
        const reservation = await storage.getReservation(reservationId);
        if (reservation) {
          arrivalDate = reservation.arrival ? new Date(reservation.arrival).toLocaleDateString('en-GB', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          }) : undefined;
        }
      }

      const result = await client.sendCheckInLinkEmail({
        email,
        guestName: guestName || "Guest",
        checkInUrl,
        arrivalDate,
      });

      if (result.success) {
        console.log(`Check-in link email sent to ${email} for reservation ${reservationId}`);
        res.json({ success: true, message: `Check-in link sent to ${email}` });
      } else {
        console.error(`Failed to send check-in email: ${result.error}`);
        res.status(500).json({ success: false, error: result.error });
      }
    } catch (error) {
      console.error("Send check-in email error:", error);
      res.status(500).json({ error: "Failed to send check-in email" });
    }
  });

  // Refresh balance from MEWS for a reservation (admin endpoint)
  app.post("/api/reservations/:id/refresh-balance", async (req: Request, res: Response) => {
    try {
      const session = await verifyHotelToken(req);
      if (!session) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const storage = await getTenantStorageAsync(req);
      const reservation = await storage.getReservation(req.params.id);
      if (!reservation) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      const mewsClientTokenSetting = await storage.getSetting("mews_client_token");
      const mewsAccessTokenSetting = await storage.getSetting("mews_access_token");
      const mewsEnvironmentSetting = await storage.getSetting("mews_environment");

      if (!mewsClientTokenSetting?.value || !mewsAccessTokenSetting?.value) {
        return res.status(400).json({ error: "MEWS not configured" });
      }

      const mewsEnvironment = (mewsEnvironmentSetting?.value === "production" ? "production" : "demo") as "demo" | "production";
      const mewsClient = new MewsClient(mewsClientTokenSetting.value, mewsAccessTokenSetting.value, mewsEnvironment);

      let owing: string;
      let source: string;

      // Try customer bill balance first (correctly handles OTA billing automation)
      if (reservation.mewsCustomerId) {
        const billBalance = await mewsClient.getCustomerBillBalance(reservation.mewsCustomerId);
        if (billBalance !== null) {
          owing = billBalance.value.toFixed(2);
          source = "customer-bill";
        } else {
          // Fallback: order items minus reservation payments
          const orderItems = await mewsClient.getOrderItems([reservation.pmsId]);
          const total = orderItems.reduce((sum, item) => sum + item.Amount.GrossValue, 0);
          const payments = await mewsClient.getPayments([reservation.pmsId]);
          const paid = payments.filter(p => p.State === "Charged").reduce((sum, p) => sum + (p.Amount?.GrossValue || 0), 0);
          owing = Math.max(0, total - paid).toFixed(2);
          source = "order-items-fallback";
        }
      } else {
        const orderItems = await mewsClient.getOrderItems([reservation.pmsId]);
        const total = orderItems.reduce((sum, item) => sum + item.Amount.GrossValue, 0);
        const payments = await mewsClient.getPayments([reservation.pmsId]);
        const paid = payments.filter(p => p.State === "Charged").reduce((sum, p) => sum + (p.Amount?.GrossValue || 0), 0);
        owing = Math.max(0, total - paid).toFixed(2);
        source = "order-items";
      }

      if (owing !== reservation.owing) {
        await storage.updateReservation(reservation.id, { owing });
        await storage.createLog({
          level: "info",
          message: `Balance refreshed via admin: ${owing} (source: ${source}, previous: ${reservation.owing || "0"})`,
          source: "checkin",
          reservationId: reservation.id,
        });
      }

      res.json({ owing, updated: owing !== reservation.owing, source });
    } catch (error) {
      console.error("Refresh balance error:", error);
      res.status(500).json({ error: "Failed to refresh balance" });
    }
  });

  // Force update PIN validity in TTLock from current DB dates (admin endpoint)
  app.post("/api/reservations/:id/refresh-pin", async (req: Request, res: Response) => {
    try {
      const session = await verifyHotelToken(req);
      if (!session) return res.status(401).json({ error: "Authentication required" });

      const storage = await getTenantStorageAsync(req);
      const reservation = await storage.getReservation(req.params.id);
      if (!reservation) return res.status(404).json({ error: "Reservation not found" });

      const automationEngine = ctx.getAutomationEngine(resolveTenantId(req));
      // Force mode: always push to TTLock even if DB dates appear unchanged
      // (needed when a prior TTLock update failed but DB was already updated)
      // updatePinValidity stays in AutomationEngine (complex TTLock fallback logic)
      const result = await automationEngine.updatePinValidity(reservation.id, { force: true });

      res.json({ success: result.success, error: result.error });
    } catch (error) {
      console.error("Refresh PIN error:", error);
      res.status(500).json({ error: "Failed to refresh PIN" });
    }
  });
}
