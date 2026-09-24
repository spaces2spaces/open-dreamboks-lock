import type { Express, Request, Response } from "express";
import type { RouteContext } from "./index";
import { getTenantStorage, publicLimiter, findReservationLimiter, kioskLookupLimiter, earlyCheckinStatusLimiter, pinLookupLimiter, validate } from "./middleware";
import {
  quoteEarlyCheckin,
  startEarlyCheckinPayment,
  checkEarlyCheckinStatus,
  joinEarlyCheckinWaitlist,
  quoteLateCheckout,
  startLateCheckoutPayment,
  sendPurchaseReceipt,
} from "../early-checkin-service";
import { boardingPassLookupSchema, lookupByPinSchema, savePersonalEmailSchema } from "@shared/validation";
import { Storage, DEFAULT_TENANT_ID, type ITenantStorage, db } from "../storage";
import { tenants as tenantsTable, reservations as reservationsTable, roomLockAssignments, lockDevices } from "@shared/schema";
import { eq, and, gte, lt, lte, inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import crypto from "crypto";
import { generateBoardingPassPDF } from "../pdf-generator";
import { googleWalletService } from "../google-wallet";
import { NotificationClient, createNotificationClient } from "../notification-client";
import { MewsClient } from "../mews-client";
import { MewsAdapter } from "../mews-adapter";
import { createIngestionProcessor } from "../ingestion-processor";
import { createOwnerClient } from "../ttlock-client";
import { getSpaceDisplayName } from "@shared/display-name";
import { appendHotelSlug, buildBoardingPassUrl } from "@shared/boarding-pass-url";
import { isLinkGradeIdentifier } from "@shared/guest-identifier";
import { guestAccessGuard } from "../guest-access-guard";
import { buildGuestFlowTheme } from "../boarding-theme";
import { buildGuestInfoResponse, buildDoorCodeResult, isSameGuest } from "../guest-info";
import { rankKioskMatches, matchesBookingNumber } from "../kiosk-lookup-match";

export function registerPublicApiRoutes(app: Express, ctx: RouteContext) {
  // Resolve tenant storage for an unauthenticated public request.
  // The guest-facing /boarding-pass page is NOT slug-scoped in the URL, so it has no
  // session and sends no x-tenant-id — without help it would always resolve to the
  // default tenant. When the page knows its hotel (via ?hotel=<slug>), it forwards
  // `hotelSlug` in the request body; we match that against each tenant's `hotel_slug`
  // setting so non-default tenants' guests reach the right tenant. Falls back to the
  // header/default behaviour when no (or unknown) slug is supplied.
  function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
  }

  async function getPublicTenantStorage(req: { body?: any; headers: any }): Promise<ITenantStorage> {
    const rawSlug = typeof req.body?.hotelSlug === "string" ? req.body.hotelSlug.trim() : "";
    if (rawSlug) {
      const wanted = rawSlug.toLowerCase();
      const activeTenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
      for (const tenant of activeTenants) {
        const ts = Storage.forTenant(tenant.id);
        const slugSetting = await ts.getSetting("hotel_slug");
        // Tolerant match (trim + case-fold) so minor slug skew still resolves.
        if (slugSetting?.value?.trim().toLowerCase() === wanted) return ts;
      }
      // Non-empty slug that matched nothing: log so misconfiguration is diagnosable
      // instead of silently degrading to the default tenant.
      console.warn(`[public] hotelSlug "${rawSlug}" matched no tenant's hotel_slug — falling back to default tenant`);
    }
    return getTenantStorage(req as any);
  }

  // Public API - Look up Digital Key / Boarding Pass
  // ── Guest lookup guard ────────────────────────────────────────────────────
  // Every number+name lookup goes through one of these: refused while the
  // identifier is locked, failures recorded (per-reservation lockout + tenant
  // brute-force alert), successes clear the streak.
  // See server/guest-access-guard.ts and shared/guest-identifier.ts.
  const LOCKED_MESSAGE = "Too many failed attempts for this reservation. Please try again later or contact reception.";
  function respondLocked(res: Response) {
    return res.status(429).json({ error: LOCKED_MESSAGE });
  }
  async function guardedByNumber(req: Request, storage: ITenantStorage, reservationNumber: string, lastName: string) {
    const n = String(reservationNumber).trim();
    const l = String(lastName).trim();
    if (guestAccessGuard.lockedFor(storage.tenantId, n) > 0) return { locked: true as const, result: null };
    const result = await storage.getReservationByNumberAndName(n, l);
    if (!result) {
      await guestAccessGuard.recordFailure(storage.tenantId, n, req.ip, storage);
      return { locked: false as const, result: null };
    }
    guestAccessGuard.recordSuccess(storage.tenantId, n);
    return { locked: false as const, result };
  }
  async function guardedWithLocks(req: Request, storage: ITenantStorage, reservationNumber: string, lastName: string) {
    const n = String(reservationNumber).trim();
    const l = String(lastName).trim();
    if (guestAccessGuard.lockedFor(storage.tenantId, n) > 0) return { locked: true as const, result: null };
    const result = await storage.getReservationWithLocks(n, l);
    if (!result) {
      await guestAccessGuard.recordFailure(storage.tenantId, n, req.ip, storage);
      return { locked: false as const, result: null };
    }
    guestAccessGuard.recordSuccess(storage.tenantId, n);
    return { locked: false as const, result };
  }

  app.post("/api/public/boarding-pass", publicLimiter, validate(boardingPassLookupSchema), async (req, res) => {
    try {
      const storage = await getPublicTenantStorage(req);
      const { reservationNumber, lastName } = req.body;

      if (!reservationNumber || !lastName) {
        return res.status(400).json({ error: "Reservation number and last name are required" });
      }

      const { locked, result } = await guardedByNumber(req, storage, reservationNumber, lastName);
      if (locked) return respondLocked(res);

      if (!result) {
        return res.status(404).json({ error: "Reservation not found. Please check your reservation number and last name." });
      }

      // Look up lock doorName for display
      let roomLabel: string | null = null;
      if (result.reservation.roomId) {
        const lockAssignments = await storage.getRoomLockAssignments(result.reservation.roomId);
        const roomLock = lockAssignments.find(a => a.lockDevice.lockType === "room");
        roomLabel = roomLock?.lockDevice.doorName || null;
      }

      res.json({
        reservation: {
          id: result.reservation.id,
          firstName: result.reservation.firstName,
          lastName: result.reservation.lastName,
          reservationNumber: result.reservation.confirmationCode || result.reservation.extId,
          room: result.reservation.room,
          bed: result.reservation.bed,
          assignedSpace: result.reservation.assignedSpace,
          roomLabel,
          arrival: result.reservation.arrival,
          departure: result.reservation.departure,
          status: result.reservation.status,
        },
        pin: result.pin ? {
          code: result.pin.code,
          validFrom: result.pin.validFrom,
          validTo: result.pin.validTo,
          status: result.pin.status,
        } : null
      });
    } catch (error) {
      console.error("Error looking up digital key:", error);
      res.status(500).json({ error: "Failed to retrieve digital key" });
    }
  });

  // Public API - Download Digital Key as PDF
  app.post("/api/public/boarding-pass/pdf", publicLimiter, async (req, res) => {
    try {
      const storage = await getPublicTenantStorage(req);
      const { reservationNumber, lastName } = req.body;

      if (!reservationNumber || !lastName) {
        return res.status(400).json({ error: "Reservation number and last name are required" });
      }

      const { locked, result } = await guardedByNumber(req, storage, reservationNumber, lastName);
      if (locked) return respondLocked(res);

      if (!result) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      if (!result.pin) {
        return res.status(400).json({ error: "Access code not yet available for this reservation" });
      }

      // Compose assigned space name for PDF: "roomNumber doorName" or just "roomNumber"
      const baseSpace = result.reservation.assignedSpace || result.reservation.room;
      let pdfAssignedSpace = baseSpace || 'Not assigned';
      if (result.reservation.roomId) {
        const lockAssignments = await storage.getRoomLockAssignments(result.reservation.roomId);
        const roomLock = lockAssignments.find(a => a.lockDevice.lockType === "room");
        if (roomLock?.lockDevice.doorName && baseSpace) {
          pdfAssignedSpace = `${baseSpace} ${roomLock.lockDevice.doorName}`;
        }
      }

      const pdfBuffer = await generateBoardingPassPDF({
        firstName: result.reservation.firstName,
        lastName: result.reservation.lastName,
        reservationNumber: result.reservation.confirmationCode || result.reservation.extId || 'N/A',
        assignedSpace: pdfAssignedSpace,
        arrival: result.reservation.arrival.toISOString(),
        departure: result.reservation.departure.toISOString(),
        accessCode: result.pin.code,
        validFrom: result.pin.validFrom.toISOString(),
        validTo: result.pin.validTo.toISOString(),
      });

      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename=boarding-pass-${reservationNumber}.pdf`,
        'Content-Length': pdfBuffer.length,
      });
      res.send(pdfBuffer);
    } catch (error) {
      console.error("Error generating PDF:", error);
      res.status(500).json({ error: "Failed to generate PDF" });
    }
  });

  // Public API - Get Google Wallet Link
  app.post("/api/public/boarding-pass/google-wallet", publicLimiter, async (req, res) => {
    try {
      const storage = await getPublicTenantStorage(req);
      const { reservationNumber, lastName } = req.body;

      if (!reservationNumber || !lastName) {
        return res.status(400).json({ error: "Reservation number and last name are required" });
      }

      const { locked, result } = await guardedByNumber(req, storage, reservationNumber, lastName);
      if (locked) return respondLocked(res);

      if (!result) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      if (!result.pin) {
        return res.status(400).json({ error: "Access code not yet available for this reservation" });
      }

      if (!googleWalletService.isConfigured()) {
        return res.status(503).json({
          error: "Google Wallet is not configured on this server",
          available: false
        });
      }

      // Compose assigned space name for Google Wallet: "roomNumber doorName" or just "roomNumber"
      const walletBaseSpace = result.reservation.assignedSpace || result.reservation.room;
      let walletAssignedSpace = walletBaseSpace || 'Not assigned';
      if (result.reservation.roomId) {
        const walletLockAssignments = await storage.getRoomLockAssignments(result.reservation.roomId);
        const walletRoomLock = walletLockAssignments.find(a => a.lockDevice.lockType === "room");
        if (walletRoomLock?.lockDevice.doorName && walletBaseSpace) {
          walletAssignedSpace = `${walletBaseSpace} ${walletRoomLock.lockDevice.doorName}`;
        }
      }

      const walletLink = googleWalletService.generateAddToWalletLink({
        firstName: result.reservation.firstName,
        lastName: result.reservation.lastName,
        reservationNumber: result.reservation.confirmationCode || result.reservation.extId || 'N/A',
        assignedSpace: walletAssignedSpace,
        arrival: result.reservation.arrival.toISOString(),
        departure: result.reservation.departure.toISOString(),
        accessCode: result.pin.code,
      });

      res.json({
        walletLink,
        available: true
      });
    } catch (error) {
      console.error("Error generating Google Wallet link:", error);
      res.status(500).json({ error: "Failed to generate Google Wallet link" });
    }
  });

  // Public API - Digital Key with eKey/Remote Unlock support
  app.post("/api/public/boarding-pass-ekey", publicLimiter, async (req, res) => {
    try {
      const storage = await getPublicTenantStorage(req);
      const { reservationNumber, lastName } = req.body;

      if (!reservationNumber || !lastName) {
        return res.status(400).json({ error: "Reservation number and last name are required" });
      }

      // Run the reservation lookup and settings fetch in parallel (independent) —
      // one query for all settings instead of ~9 sequential getSetting round-trips.
      const [lookup, allSettings] = await Promise.all([
        guardedWithLocks(req, storage, reservationNumber, lastName),
        storage.getAllSettings(),
      ]);
      if (lookup.locked) return respondLocked(res);
      const result = lookup.result;

      if (!result) {
        return res.status(404).json({ error: "Reservation not found. Please check your reservation number and last name." });
      }

      const setting = (key: string) => allSettings.find(s => s.key === key)?.value;

      const checkInMethod = setting("check_in_method") || "door_unlock";
      const unlockMethod = setting("unlock_method") || "ekey";
      const checkInTime = setting("check_in_time") || "15:00";
      const checkoutTime = setting("reservation_checkout_time") || "11:00";
      // Per-tenant: hide PIN until the guest is Checked-in in MEWS (default off).
      const pinRequiresCheckin = setting("boarding_pin_requires_checkin") === "true";

      // Parse QR code data from pin if available
      interface QrCodeDataEntry {
        lockDeviceId: string;
        ttlockId: string;
        qrCodeId: number;
        qrCodeData: string;
        lockName: string;
      }

      let qrCodeData: QrCodeDataEntry[] = [];
      if (result.pin && result.pin.qrCodeData) {
        const rawQrData = result.pin.qrCodeData as unknown;
        if (Array.isArray(rawQrData)) {
          qrCodeData = rawQrData as QrCodeDataEntry[];
        }
      }

      // Room door label — derive from the locks we already fetched (no extra query).
      const ekeyRoomLabel = result.locks.find(l => l.lockType === "room")?.doorName ?? null;

      const owingAmount = result.reservation.owing !== null && result.reservation.owing !== undefined
        ? parseFloat(result.reservation.owing)
        : 0;
      const paymentRequired = owingAmount > 0;

      // Immediate PIN activation for early check-in:
      // If reception has checked the guest in (status = Checked-in) but PIN is still pending,
      // activate it right now so the boarding card works immediately — no wait for next poll.
      const isCheckedIn = ["checked-in", "started"].includes((result.reservation.status || "").toLowerCase());
      if (!paymentRequired && isCheckedIn && result.pin?.status === "pending") {
        try {
          const automationEngine = ctx.getAutomationEngine(result.reservation.tenantId || DEFAULT_TENANT_ID);
          const activationResult = await automationEngine.getPinLifecycle().activatePendingForReservation(result.reservation.id);
          if (activationResult.success || activationResult.alreadyActive) {
            // Re-fetch updated pin + locks
            const refreshed = await storage.getReservationWithLocks(result.reservation.id, result.reservation.lastName);
            if (refreshed) {
              result.pin = refreshed.pin;
              result.locks = refreshed.locks;
            }
          }
          await storage.createLog({
            level: activationResult.success ? "info" : "warn",
            message: activationResult.success
              ? `Boarding pass: PIN activated immediately for checked-in guest ${result.reservation.firstName} ${result.reservation.lastName}`
              : `Boarding pass: PIN activation failed for ${result.reservation.firstName} ${result.reservation.lastName}: ${activationResult.error}`,
            source: "boarding-pass",
            reservationId: result.reservation.id,
          });
        } catch {
          // Activation failed — return pending PIN, guest must wait for poll
        }
      }

      // Per-tenant boarding card theme (read from the single settings fetch above)
      const theme = {
        mode: setting("boarding_theme_mode") || "light",
        brand: setting("boarding_brand_color") || "#cc352a",
        name: setting("boarding_brand_name") || null,
        tagline: setting("boarding_tagline") || "Tap a button to unlock your doors",
        logoUrl: setting("boarding_logo_url") || null,
        // Optional per-tenant web font (Google Fonts family name, e.g. "Nunito Sans").
        // When unset the card keeps its default typeface — so other tenants are unaffected.
        font: setting("boarding_font") || null,
        // Show the brand name next to the logo (for icon-style logos like Capsule's
        // acorn). Off by default so wordmark logos (e.g. Downtown) aren't duplicated.
        showName: setting("boarding_logo_show_name") === "true",
        // Background colour of an unlock button once the door has opened (the "done"
        // state). Unset → keeps the default success-green tint, so other tenants are
        // unaffected.
        openedBg: setting("boarding_opened_bg") || null,
      };

      res.json({
        reservation: {
          id: result.reservation.id,
          firstName: result.reservation.firstName,
          lastName: result.reservation.lastName,
          reservationNumber: result.reservation.confirmationCode || result.reservation.extId,
          room: result.reservation.room,
          bed: result.reservation.bed,
          assignedSpace: result.reservation.assignedSpace,
          roomLabel: ekeyRoomLabel,
          arrival: result.reservation.arrival,
          departure: result.reservation.departure,
          status: result.reservation.status,
        },
        // Hide the PIN when payment is due, or (per-tenant) until the guest is
        // Checked-in in MEWS — they must use a remote-unlock button first.
        pin: (paymentRequired || (pinRequiresCheckin && !isCheckedIn)) ? null : result.pin ? {
          code: result.pin.code,
          validFrom: result.pin.validFrom,
          validTo: result.pin.validTo,
          status: result.pin.status,
        } : null,
        pinRequiresCheckin,
        locks: paymentRequired ? [] : result.locks,
        qrCodeData: paymentRequired ? [] : qrCodeData,
        checkInMethod,
        unlockMethod,
        checkInTime,
        checkoutTime,
        paymentRequired,
        owing: paymentRequired ? owingAmount.toFixed(2) : null,
        currency: result.reservation.currency || "DKK",
        theme,
      });
    } catch (error) {
      console.error("Error looking up eKey digital key:", error);
      res.status(500).json({ error: "Failed to retrieve digital key" });
    }
  });

  // Public API - Background MEWS sync for boarding card (stale-while-revalidate)
  // Called by client after rendering cached data to pick up any MEWS changes
  app.post("/api/public/boarding-pass-sync", publicLimiter, async (req, res) => {
    try {
      const storage = await getPublicTenantStorage(req);
      const { reservationNumber, lastName } = req.body;

      if (!reservationNumber || !lastName) {
        return res.status(400).json({ error: "Reservation number and last name are required" });
      }

      const { locked, result } = await guardedWithLocks(req, storage, reservationNumber, lastName);
      if (locked) return respondLocked(res);

      if (!result) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      // Full MEWS re-ingestion: status, room, dates, balance
      if (result.reservation.pmsId) {
        try {
          const tenantId = result.reservation.tenantId || DEFAULT_TENANT_ID;
          const automationEngine = ctx.getAutomationEngine(tenantId);
          const mewsClient = automationEngine.getMewsClient();
          if (mewsClient) {
            const adapter = new MewsAdapter(tenantId, mewsClient);
            const event = await adapter.fetchAndConvertSingleReservation(result.reservation.pmsId);
            if (event) {
              const processor = createIngestionProcessor(automationEngine);
              await processor.processReservationUpserted(event);
            }
          }
        } catch {
          // MEWS sync failed — continue with cached data
        }
      }

      // Re-fetch from DB (post-ingestion) and settings in parallel (independent).
      const [refreshed, allSettings] = await Promise.all([
        storage.getReservationWithLocks(result.reservation.id, result.reservation.lastName),
        storage.getAllSettings(),
      ]);
      if (!refreshed) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      const setting = (key: string) => allSettings.find(s => s.key === key)?.value;
      const checkInMethod = setting("check_in_method") || "door_unlock";
      const unlockMethod = setting("unlock_method") || "ekey";
      const checkInTime = setting("check_in_time") || "15:00";
      const checkoutTime = setting("reservation_checkout_time") || "11:00";
      const pinRequiresCheckin = setting("boarding_pin_requires_checkin") === "true";

      // QR code data
      interface QrCodeDataEntry {
        lockDeviceId: string;
        ttlockId: string;
        qrCodeId: number;
        qrCodeData: string;
        lockName: string;
      }
      let qrCodeData: QrCodeDataEntry[] = [];
      if (refreshed.pin && refreshed.pin.qrCodeData) {
        const rawQrData = refreshed.pin.qrCodeData as unknown;
        if (Array.isArray(rawQrData)) {
          qrCodeData = rawQrData as QrCodeDataEntry[];
        }
      }

      // Room label — derive from the locks we already fetched (no extra query).
      const ekeyRoomLabel = refreshed.locks.find(l => l.lockType === "room")?.doorName ?? null;

      const owingAmount = refreshed.reservation.owing !== null && refreshed.reservation.owing !== undefined
        ? parseFloat(refreshed.reservation.owing)
        : 0;
      const paymentRequired = owingAmount > 0;

      // Early check-in PIN activation (same as ekey endpoint)
      const isCheckedIn = ["checked-in", "started"].includes((refreshed.reservation.status || "").toLowerCase());
      if (!paymentRequired && isCheckedIn && refreshed.pin?.status === "pending") {
        try {
          const automationEngine = ctx.getAutomationEngine(refreshed.reservation.tenantId || DEFAULT_TENANT_ID);
          const activationResult = await automationEngine.getPinLifecycle().activatePendingForReservation(refreshed.reservation.id);
          if (activationResult.success || activationResult.alreadyActive) {
            const reActivated = await storage.getReservationWithLocks(refreshed.reservation.id, refreshed.reservation.lastName);
            if (reActivated) {
              refreshed.pin = reActivated.pin;
              refreshed.locks = reActivated.locks;
            }
          }
          await storage.createLog({
            level: activationResult.success ? "info" : "warn",
            message: activationResult.success
              ? `Boarding pass sync: PIN activated for checked-in guest ${refreshed.reservation.firstName} ${refreshed.reservation.lastName}`
              : `Boarding pass sync: PIN activation failed for ${refreshed.reservation.firstName} ${refreshed.reservation.lastName}: ${activationResult.error}`,
            source: "boarding-pass",
            reservationId: refreshed.reservation.id,
          });
        } catch {
          // Activation failed
        }
      }

      // Per-tenant boarding card theme (read from the single settings fetch above)
      const theme = {
        mode: setting("boarding_theme_mode") || "light",
        brand: setting("boarding_brand_color") || "#cc352a",
        name: setting("boarding_brand_name") || null,
        tagline: setting("boarding_tagline") || "Tap a button to unlock your doors",
        logoUrl: setting("boarding_logo_url") || null,
        // Optional per-tenant web font (Google Fonts family name, e.g. "Nunito Sans").
        // When unset the card keeps its default typeface — so other tenants are unaffected.
        font: setting("boarding_font") || null,
        // Show the brand name next to the logo (for icon-style logos like Capsule's
        // acorn). Off by default so wordmark logos (e.g. Downtown) aren't duplicated.
        showName: setting("boarding_logo_show_name") === "true",
        // Background colour of an unlock button once the door has opened (the "done"
        // state). Unset → keeps the default success-green tint, so other tenants are
        // unaffected.
        openedBg: setting("boarding_opened_bg") || null,
      };

      res.json({
        reservation: {
          id: refreshed.reservation.id,
          firstName: refreshed.reservation.firstName,
          lastName: refreshed.reservation.lastName,
          reservationNumber: refreshed.reservation.confirmationCode || refreshed.reservation.extId,
          room: refreshed.reservation.room,
          bed: refreshed.reservation.bed,
          assignedSpace: refreshed.reservation.assignedSpace,
          roomLabel: ekeyRoomLabel,
          arrival: refreshed.reservation.arrival,
          departure: refreshed.reservation.departure,
          status: refreshed.reservation.status,
        },
        pin: (paymentRequired || (pinRequiresCheckin && !isCheckedIn)) ? null : refreshed.pin ? {
          code: refreshed.pin.code,
          validFrom: refreshed.pin.validFrom,
          validTo: refreshed.pin.validTo,
          status: refreshed.pin.status,
        } : null,
        pinRequiresCheckin,
        locks: paymentRequired ? [] : refreshed.locks,
        qrCodeData: paymentRequired ? [] : qrCodeData,
        checkInMethod,
        unlockMethod,
        checkInTime,
        checkoutTime,
        paymentRequired,
        owing: paymentRequired ? owingAmount.toFixed(2) : null,
        currency: refreshed.reservation.currency || "DKK",
        theme,
      });
    } catch (error) {
      console.error("Error in boarding pass sync:", error);
      res.status(500).json({ error: "Sync failed" });
    }
  });

  // Public API - Send MEWS payment request from boarding pass
  app.post("/api/public/boarding-pass/request-payment", publicLimiter, async (req, res) => {
    try {
      const storage = await getPublicTenantStorage(req);
      const { reservationNumber, lastName } = req.body;

      if (!reservationNumber || !lastName) {
        return res.status(400).json({ error: "Reservation number and last name are required" });
      }

      const { locked, result } = await guardedWithLocks(req, storage, reservationNumber, lastName);
      if (locked) return respondLocked(res);
      if (!result) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      const reservation = result.reservation;
      const owingAmount = parseFloat(reservation.owing || "0");
      if (owingAmount <= 0) {
        return res.status(400).json({ error: "No outstanding balance" });
      }
      if (!reservation.mewsCustomerId) {
        return res.status(400).json({ error: "No MEWS customer linked to reservation" });
      }

      const mewsClientToken = await storage.getSetting("mews_client_token");
      const mewsAccessToken = await storage.getSetting("mews_access_token");
      const mewsEnvironment = await storage.getSetting("mews_environment");

      if (!mewsClientToken?.value || !mewsAccessToken?.value) {
        return res.status(503).json({ error: "Payment system not configured" });
      }

      const environment = (mewsEnvironment?.value === "production" ? "production" : "demo") as "demo" | "production";
      const mewsClient = new MewsClient(mewsClientToken.value, mewsAccessToken.value, environment);

      const expirationUtc = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const paymentReq = await mewsClient.createPaymentRequest(
        reservation.mewsCustomerId,
        owingAmount,
        reservation.currency || "DKK",
        reservation.pmsId || undefined,
        `Payment for reservation ${reservation.confirmationCode || reservation.pmsId}`,
        expirationUtc,
        false // don't send MEWS email — we redirect the guest directly
      );

      const paymentUrl = mewsClient.getPaymentRequestUrl(paymentReq.Id);

      await storage.createLog({
        level: "info",
        message: `Payment request created from boarding pass: ${owingAmount} ${reservation.currency || "DKK"} — ${paymentUrl}`,
        source: "boarding-pass",
        reservationId: reservation.id,
      });

      res.json({ success: true, paymentUrl });
    } catch (error) {
      console.error("Boarding pass payment request error:", error);
      res.status(500).json({ error: "Failed to send payment link" });
    }
  });

  // Public API - Get fresh dynamic QR code data for TTLock
  // The QR code data changes periodically for security - this endpoint fetches the latest
  app.post("/api/public/qr-code-data", publicLimiter, async (req, res) => {
    try {
      const storage = await getPublicTenantStorage(req);
      const { reservationNumber, lastName, lockId } = req.body;

      if (!reservationNumber || !lastName || !lockId) {
        return res.status(400).json({ error: "Reservation number, last name, and lock ID are required" });
      }

      const { locked, result } = await guardedWithLocks(req, storage, reservationNumber, lastName);
      if (locked) return respondLocked(res);

      if (!result) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      // Check that guest has access to this lock
      const lock = result.locks.find(l => l.id === lockId);
      if (!lock) {
        return res.status(403).json({ error: "You do not have access to this lock" });
      }

      // Check validity period
      const now = new Date();
      const arrival = new Date(result.reservation.arrival);
      const departure = new Date(result.reservation.departure);

      if (now < arrival) {
        return res.status(403).json({ error: "Your access is not yet active" });
      }

      if (now > departure) {
        return res.status(403).json({ error: "Your access has expired" });
      }

      // Get QR code from pin's qrCodeData array
      if (!result.pin) {
        return res.status(404).json({ error: "No active PIN found" });
      }

      // qrCodeData is stored as array of objects with lockDeviceId, qrCodeData, etc.
      type QrCodeEntry = { lockDeviceId: string; qrCodeData: string; ttlockId: string; lockName: string; qrCodeId: number };
      const qrCodeDataArray = result.pin.qrCodeData as QrCodeEntry[] | null;

      if (!qrCodeDataArray || !Array.isArray(qrCodeDataArray)) {
        return res.status(404).json({ error: "No QR code available for this lock" });
      }

      // Find QR code entry for this lock (match by lockDeviceId which is the internal UUID)
      const qrEntry = qrCodeDataArray.find(entry => entry.lockDeviceId === lockId);
      if (!qrEntry) {
        return res.status(404).json({ error: "No QR code available for this lock" });
      }

      // Fetch FRESH QR code data from TTLock API (QR codes refresh every ~10 seconds)
      try {
        const regionSetting = await storage.getSetting("ttlock_region");
        const region = (regionSetting?.value as "eu" | "cn") || "eu";

        const ownerClient = await createOwnerClient(region);
        const freshQrData = await ownerClient.getQrCodeData(qrEntry.ttlockId, qrEntry.qrCodeId);

        res.json({
          qrCodeData: freshQrData.qrCodeData,
          lockId: lock.id,
          lockName: lock.name,
          qrCodeId: qrEntry.qrCodeId,
        });
      } catch (apiError) {
        // Fall back to stored QR code if API call fails
        console.error("Failed to fetch fresh QR code, using stored data:", apiError);
        res.json({
          qrCodeData: qrEntry.qrCodeData,
          lockId: lock.id,
          lockName: lock.name,
          qrCodeId: qrEntry.qrCodeId,
        });
      }
    } catch (error) {
      console.error("Error fetching QR code data:", error);
      res.status(500).json({ error: "Failed to fetch QR code data" });
    }
  });

  // Public API - Remote Unlock
  app.post("/api/public/unlock", publicLimiter, async (req, res) => {
    console.log("[Unlock API] Request received:", { body: req.body });
    try {
      const storage = await getPublicTenantStorage(req);
      const { reservationNumber, lastName, lockId, pin } = req.body;

      console.log("[Unlock API] Params:", { reservationNumber, lastName, lockId });

      if (!reservationNumber || !lastName || !lockId) {
        console.log("[Unlock API] Missing params");
        return res.status(400).json({ error: "Reservation number, last name, and lock ID are required" });
      }

      const { locked, result } = await guardedWithLocks(req, storage, reservationNumber, lastName);
      if (locked) return respondLocked(res);

      if (!result) {
        console.log("[Unlock API] Reservation not found for:", { reservationNumber, lastName });
        return res.status(404).json({ error: "Reservation not found" });
      }

      // Form-grade identifier (a typed booking number): remote unlock also
      // demands the guest's door code — the same secret that opens the door at
      // the keypad. A link-grade identifier (UUID from a link we sent) needs
      // nothing more; it cannot be guessed.
      if (!isLinkGradeIdentifier(String(reservationNumber))) {
        const expected = result.pin?.code;
        const supplied = typeof pin === "string" ? pin.trim() : "";
        if (!expected || !supplied || !safeEqual(supplied, expected)) {
          await guestAccessGuard.recordFailure(storage.tenantId, String(reservationNumber).trim(), req.ip, storage);
          return res.status(403).json({ error: "Enter the door code from your confirmation to unlock remotely." });
        }
      }
      console.log("[Unlock API] Found reservation:", result.reservation.id, "with locks:", result.locks.map(l => ({ id: l.id, name: l.name })));

      const lock = result.locks.find(l => l.id === lockId);
      if (!lock) {
        console.log("[Unlock API] Lock not in guest's accessible locks:", { requestedLockId: lockId, availableLocks: result.locks.map(l => l.id) });
        return res.status(403).json({ error: "You do not have access to this lock" });
      }

      const now = new Date();
      const arrival = new Date(result.reservation.arrival);
      const departure = new Date(result.reservation.departure);

      if (now > departure) {
        return res.status(403).json({ error: "Your access has expired." });
      }

      // Block access before check-in time on arrival day (regardless of how MEWS stores arrival time)
      const checkInTimeSetting = await storage.getSetting("check_in_time");
      const checkInTime = checkInTimeSetting?.value || "15:00";
      const timezoneSetting2 = await storage.getSetting("property_timezone");
      const timezone2 = timezoneSetting2?.value || "Europe/Copenhagen";
      const [checkInHour, checkInMinute] = checkInTime.split(":").map(Number);
      const { DateTime: DT } = await import("luxon");
      const nowInZone = DT.now().setZone(timezone2);
      const arrivalDateStr = DT.fromJSDate(arrival).setZone(timezone2).toFormat("yyyy-MM-dd");
      const checkInDateTime = DT.fromISO(arrivalDateStr, { zone: timezone2 }).set({ hour: checkInHour, minute: checkInMinute, second: 0, millisecond: 0 });
      if (nowInZone < checkInDateTime && result.reservation.status !== "Checked-in") {
        const arrivalFormatted = DT.fromJSDate(arrival).setZone(timezone2).toFormat("d MMM");
        return res.status(403).json({ error: `Check-in is not available until ${arrivalFormatted} at ${checkInTime}. Contact reception for early check-in.` });
      }

      // Use the existing TTLockClient from AutomationEngine (already has access token)
      // Select engine by the reservation's tenant (consistent with boarding-pass-ekey/sync),
      // not req.tenantId — which is only set by HMAC ingestion and is always undefined here.
      const tenantId = result.reservation.tenantId || DEFAULT_TENANT_ID;
      // getAutomationEngine THROWS (503) when a tenant's engine isn't registered yet —
      // which happens during the post-deploy window while engines initialize sequentially
      // (a non-default tenant like Capsule is initialized after the default one). Guard it
      // so unlock falls back to a fresh owner client instead of failing the whole request.
      let ttlockClient = null;
      try {
        ttlockClient = ctx.getAutomationEngine(tenantId).getTTLockClient();
      } catch {
        ttlockClient = null;
      }

      // Fallback: create a fresh client if engine has none (or wasn't ready)
      if (!ttlockClient) {
        const regionSetting = await storage.getSetting("ttlock_region");
        const region = (regionSetting?.value as "eu" | "cn") || "eu";
        ttlockClient = await createOwnerClient(region);
        if (!ttlockClient) {
          return res.status(500).json({ error: "TTLock not configured" });
        }
      }

      console.log("[Unlock API] Attempting TTLock remote unlock for lock:", { lockId: lock.id, lockName: lock.name, ttlockId: lock.ttlockId });
      try {
        await ttlockClient.remoteUnlock(lock.ttlockId);
      } catch (unlockErr) {
        // Persist the raw TTLock error so failures are diagnosable from the logs
        // (the gateway/BLE error code is otherwise only in console output).
        const m = unlockErr instanceof Error ? unlockErr.message : String(unlockErr);
        await storage.createLog({
          level: "error",
          message: `Remote unlock failed for lock "${lock.name}": ${m}`,
          source: "boarding-pass",
          reservationId: result.reservation.id,
          metadata: { lockId: lock.id, ttlockId: lock.ttlockId, error: m },
        }).catch(() => {});
        throw unlockErr;
      }
      console.log("[Unlock API] TTLock remote unlock successful");

      // Respond to client immediately — don't make them wait for logging/check-in
      res.json({ success: true, message: "Door unlocked successfully", lockName: lock.name });

      // Fire-and-forget: logging, PIN marking, auto check-in
      (async () => {
        try {
          await storage.createLog({
            level: "info",
            message: `Remote unlock triggered by guest`,
            source: "boarding-pass",
            reservationId: result.reservation.id,
            metadata: { lockName: lock.name, lockId: lock.id },
          });

          // Mark active PIN as used (remote unlock = guest has arrived)
          const pins = await storage.getPinsByReservationId(result.reservation.id);
          const activePin = pins.find(p => p.status === "active" && !p.firstUsedAt);
          if (activePin) {
            await storage.updatePinFirstUsedAt(activePin.id, now);
            await storage.updatePin(activePin.id, { status: "used" });
          }

          const checkInMethodSetting = await storage.getSetting("check_in_method");
          const checkInMethod = checkInMethodSetting?.value || "door_unlock";
          // ANY door button checks the guest in — a remote unlock means the
          // guest has arrived, whether it was a common door or their own room.
          const shouldCheckIn = checkInMethod === "door_unlock"
            && result.reservation.status !== "Checked-in";

          if (shouldCheckIn) {
            const mewsClientToken = await storage.getSetting("mews_client_token");
            const mewsAccessToken = await storage.getSetting("mews_access_token");
            const mewsEnvironment = await storage.getSetting("mews_environment");

            if (mewsClientToken?.value && mewsAccessToken?.value && result.reservation.pmsId) {
              const environment = (mewsEnvironment?.value === "production" ? "production" : "demo") as "demo" | "production";
              const mewsClient = new MewsClient(
                mewsClientToken.value as string,
                mewsAccessToken.value as string,
                environment
              );

              const checkInResult = await mewsClient.startReservation(result.reservation.pmsId);

              if (checkInResult.success) {
                await storage.updateReservation(result.reservation.id, { status: "Checked-in" });
                await storage.createLog({
                  level: "info",
                  message: `Auto check-in via remote unlock successful`,
                  source: "boarding-pass",
                  reservationId: result.reservation.id,
                  metadata: { pmsId: result.reservation.pmsId },
                });
              } else {
                await storage.createLog({
                  level: "warn",
                  message: `Auto check-in via remote unlock failed: ${checkInResult.error}`,
                  source: "boarding-pass",
                  reservationId: result.reservation.id,
                  metadata: { pmsId: result.reservation.pmsId, error: checkInResult.error },
                });
              }
            }
          }
        } catch (bgError) {
          console.error("[Unlock API] Background task error:", bgError);
        }
      })();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[Unlock API] Error unlocking door:", msg);

      // Give the guest a useful message based on the error
      let userMessage = "Failed to unlock door. Please try again or use your PIN code.";
      if (msg.includes("-2") || msg.toLowerCase().includes("offline") || msg.toLowerCase().includes("not connected")) {
        userMessage = "Lock is not reachable right now. Please use your PIN code.";
      } else if (msg.includes("-2011") || msg.toLowerCase().includes("gateway busy")) {
        userMessage = "Gateway is busy. Please try again in a moment.";
      }

      res.status(500).json({ error: userMessage });
    }
  });

  // Public API - Get Hotel Info by Slug
  app.get("/api/public/hotel-info/:hotelSlug", async (req, res) => {
    try {
      const { hotelSlug } = req.params;

      // Find tenant by hotel_slug setting
      const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));

      for (const tenant of tenants) {
        const tenantStorage = Storage.forTenant(tenant.id);
        const slugSetting = await tenantStorage.getSetting("hotel_slug");

        if (slugSetting?.value === hotelSlug) {
          const allSettings = await tenantStorage.getAllSettings();
          const get = (k: string) => allSettings.find(s => s.key === k)?.value;
          res.json({
            name: tenant.name,
            slug: hotelSlug,
            theme: buildGuestFlowTheme(get),
            // A staffed reception runs /<slug>/checkin on an iPad: after the
            // door code, show a QR the guest scans, never the boarding card
            // itself on the shared screen. An unmanned hotel (Capsule) has
            // the guest on their own phone and jumps straight to the card.
            kioskQr: get("pin_checkin_kiosk_qr") === "true",
          });
          return;
        }
      }

      // Slug not matched — fall back to default tenant
      const defaultTenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
      const defaultTenant = defaultTenants.find(t => t.id === DEFAULT_TENANT_ID) || defaultTenants[0];
      if (defaultTenant) {
        res.json({ name: defaultTenant.name, slug: hotelSlug, theme: null });
        return;
      }
      res.status(404).json({ error: "Hotel not found" });
    } catch (error) {
      console.error("Error fetching hotel info:", error);
      res.status(500).json({ error: "Failed to fetch hotel info" });
    }
  });

  // Public API - Guest info screen (kiosk) content by slug.
  // Unlike hotel-info there is NO default-tenant fallback: a kiosk URL is
  // configured once by staff, so an unmatched slug must 404 loudly instead of
  // silently showing another hotel's WiFi password.
  app.get("/api/public/guest-info/:hotelSlug", async (req, res) => {
    try {
      const { hotelSlug } = req.params;
      const wanted = (hotelSlug || "").trim().toLowerCase();

      const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
      for (const tenant of tenants) {
        const tenantStorage = Storage.forTenant(tenant.id);
        const slugSetting = await tenantStorage.getSetting("hotel_slug");
        if (slugSetting?.value?.trim().toLowerCase() !== wanted) continue;

        const allSettings = await tenantStorage.getAllSettings();
        const get = (k: string) => allSettings.find(s => s.key === k)?.value;
        const info = buildGuestInfoResponse(get);
        if (!info) {
          return res.status(404).json({ error: "Info screen not enabled" });
        }
        return res.json({
          name: tenant.name,
          slug: hotelSlug,
          theme: buildGuestFlowTheme(get),
          ...info,
        });
      }
      return res.status(404).json({ error: "Hotel not found" });
    } catch (error) {
      console.error("Error fetching guest info:", error);
      res.status(500).json({ error: "Failed to fetch guest info" });
    }
  });

  // Public API - Kiosk airport flight board. Proxies the tenant's configured
  // flight feed (guest_info_flights_url, e.g. the hotel website's /api/flights)
  // with a short in-memory cache so the kiosk never hammers the upstream and
  // the feed URL never reaches the client. Trimmed to the rows around "now".
  const flightsCache = new Map<string, { data: unknown; expires: number }>();
  app.get("/api/public/airport-flights/:hotelSlug", async (req, res) => {
    try {
      const wanted = (req.params.hotelSlug || "").trim().toLowerCase();
      const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
      for (const tenant of tenants) {
        const tenantStorage = Storage.forTenant(tenant.id);
        const slugSetting = await tenantStorage.getSetting("hotel_slug");
        if (slugSetting?.value?.trim().toLowerCase() !== wanted) continue;

        const url = (await tenantStorage.getSetting("guest_info_flights_url"))?.value?.trim();
        if (!url) return res.status(404).json({ error: "Flight feed not configured" });

        const cached = flightsCache.get(url);
        if (cached && cached.expires > Date.now()) {
          return res.json(cached.data);
        }

        const upstream = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!upstream.ok) throw new Error(`Upstream ${upstream.status}`);
        const raw = await upstream.json() as {
          departures?: any[];
          arrivals?: any[];
          firstActiveDeparture?: number;
          firstActiveArrival?: number;
          lastUpdated?: string;
        };

        const trim = (rows: any[] | undefined, firstActive: number | undefined) => {
          const start = Math.max(0, firstActive ?? 0);
          return (rows || []).slice(start, start + 30).map((f) => ({
            flightNumber: f.flightNumber,
            airline: f.airline,
            city: f.city,
            scheduledTime: f.scheduledTime,
            expectedTime: f.expectedTime,
            gate: f.gate,
            status: f.status,
            delayed: !!f.delayed,
          }));
        };

        const data = {
          departures: trim(raw.departures, raw.firstActiveDeparture),
          arrivals: trim(raw.arrivals, raw.firstActiveArrival),
          lastUpdated: raw.lastUpdated || null,
        };
        flightsCache.set(url, { data, expires: Date.now() + 60_000 });
        return res.json(data);
      }
      return res.status(404).json({ error: "Hotel not found" });
    } catch (error) {
      console.error("Error fetching airport flights:", error);
      res.status(502).json({ error: "Flight data unavailable" });
    }
  });

  // Public API - Kiosk door-code lookup: name OR booking number → capsule +
  // code, restricted to TODAY's arrivals (same scope as the hourly arrival
  // report). For guests who never received (or lost) the SMS/email. Gating via
  // buildDoorCodeResult — already-checked-in guests get no code. No locks/QR:
  // the kiosk is a shared screen, so it only ever shows capsule number + code.
  //
  // Matching (owner 8/9-2026, Capsule Inn): names in MEWS are often swapped
  // (first↔last), misspelled or without diacritics, so the query is ranked by
  // kiosk-lookup-match.ts — booking number (MEWS / Booking.com / channel
  // manager) > exact name (either field, either order) > typo-tolerant. `query`
  // is the new single field; `lastName` is the pre-8/9 kiosk bundle's field
  // and is honoured until its nightly reload.
  app.post("/api/public/kiosk-door-code", kioskLookupLimiter, async (req, res) => {
    try {
      const { hotelSlug, query, lastName, reservationNumber } = req.body as {
        hotelSlug?: string;
        query?: string;
        lastName?: string;
        reservationNumber?: string;
      };

      const slug = (hotelSlug || "").trim();
      const queryTrim = ((typeof query === "string" ? query : "") || lastName || "").trim();
      const resNumTrim = (reservationNumber || "").trim();

      if (!slug || queryTrim.length < 2) {
        return res.status(400).json({ error: "Hotel and last name or booking number (min 2 chars) are required." });
      }

      const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
      let matchedTenantId: string | null = null;
      for (const tenant of tenants) {
        const tenantStorage = Storage.forTenant(tenant.id);
        const slugSetting = await tenantStorage.getSetting("hotel_slug");
        if (slugSetting?.value?.trim().toLowerCase() === slug.toLowerCase()) {
          matchedTenantId = tenant.id;
          break;
        }
      }
      if (!matchedTenantId) {
        return res.status(404).json({ error: "Hotel not found." });
      }

      // KIOSK-ONLY (owner decision 29/7): the name+date lookup hands out door
      // codes and must only work from the PHYSICAL info screen. The kiosk
      // calls this API same-origin on the tenant's guest_info_domain, so the
      // Host header is the gate — a phone on any other domain is refused.
      // Tenants without a kiosk domain are unaffected; localhost stays open
      // for development.
      // Kiosk gate. Preferred: a per-tenant kiosk token (setting
      // guest_info_token) that only the wall tablet carries — it arrives once
      // as ?k= on the tablet's URL and is remembered in the tablet's
      // localStorage. A request header is not a secret; a token is.
      // Fallback when no token is configured: the Host-header check below.
      const kioskSettings = Storage.forTenant(matchedTenantId);
      const kioskToken = (await kioskSettings.getSetting("guest_info_token"))?.value?.trim();
      const kioskDenied = { error: "The door-code lookup is only available on the hotel's info screen." };
      if (kioskToken) {
        const supplied = typeof req.body?.kioskToken === "string" ? req.body.kioskToken.trim() : "";
        if (!supplied || !safeEqual(supplied, kioskToken)) {
          await guestAccessGuard.recordProbe(matchedTenantId, req.ip, kioskSettings);
          return res.status(403).json(kioskDenied);
        }
      } else {
        const kioskDomain = (await kioskSettings.getSetting("guest_info_domain"))?.value?.trim().toLowerCase();
        const reqHost = (req.hostname || "").toLowerCase();
        if (kioskDomain && reqHost !== kioskDomain && reqHost !== "localhost" && !reqHost.startsWith("127.")) {
          return res.status(403).json(kioskDenied);
        }
      }

      const tenantStorage = Storage.forTenant(matchedTenantId);

      // "Arriving today" is evaluated in the property's timezone, same as the
      // PIN validity window (pin-validity-window.ts) and the arrival report.
      const tzSetting = await tenantStorage.getSetting("property_timezone");
      const zone = tzSetting?.value || "Europe/Copenhagen";
      const dayStart = DateTime.now().setZone(zone).startOf("day");
      const dayEnd = dayStart.plus({ days: 1 });

      const matchRows = await db
        .selectDistinct({ reservation: reservationsTable })
        .from(reservationsTable)
        .innerJoin(
          roomLockAssignments,
          and(
            eq(reservationsTable.roomId, roomLockAssignments.roomId),
            eq(roomLockAssignments.tenantId, reservationsTable.tenantId)
          )
        )
        .innerJoin(lockDevices, eq(roomLockAssignments.lockDeviceId, lockDevices.id))
        .where(
          and(
            eq(reservationsTable.tenantId, matchedTenantId),
            eq(lockDevices.lockType, "room"),
            gte(reservationsTable.arrival, dayStart.toJSDate()),
            lt(reservationsTable.arrival, dayEnd.toJSDate()),
            inArray(reservationsTable.status, ["Confirmed", "Started", "Checked-in"])
          )
        );
      const candidates = matchRows.map((r) => r.reservation);
      const { matches } = rankKioskMatches(candidates, queryTrim);

      // Disambiguation round: the guest was asked for their booking number
      // after several different guests matched the name.
      let filtered = matches;
      if (resNumTrim.length > 0) {
        filtered = matches.filter((r) => matchesBookingNumber(r, resNumTrim));
        // The name may be the misspelled part — a correct booking number on
        // its own is enough to identify today's guest.
        if (filtered.length === 0) {
          filtered = candidates.filter((r) => matchesBookingNumber(r, resNumTrim));
        }
      }

      if (filtered.length === 0) {
        await guestAccessGuard.recordProbe(matchedTenantId, req.ip, tenantStorage);
        return res.status(404).json({
          found: false,
          error: resNumTrim.length > 0
            ? "That booking number doesn't match a reservation arriving today. Please check it, or contact reception."
            : "No reservation arriving today matches that name or booking number. Please check the spelling, or contact reception.",
        });
      }
      // Several hits that are NOT the same person → disambiguate by reservation
      // number. Same full name = one guest with several capsules: show them all.
      if (filtered.length > 1 && !isSameGuest(filtered)) {
        return res.json({ found: true, multiple: true, count: filtered.length });
      }

      const allSettings = await tenantStorage.getAllSettings();
      const get = (k: string) => allSettings.find(s => s.key === k)?.value;

      const results = [];
      for (const match of filtered) {
        const result = await tenantStorage.getReservationWithLocks(match.id, match.lastName);
        if (!result) continue;

        results.push(buildDoorCodeResult(result.reservation, result.pin, get));
      }

      if (results.length === 0) {
        return res.status(404).json({
          found: false,
          error: "No matching reservation found. Please contact reception.",
        });
      }

      return res.json({
        found: true,
        multiple: false,
        firstName: results[0].firstName,
        results: results.map(({ capsule, pin, reason }) => ({ capsule, pin, reason })),
        // Legacy top-level fields (first capsule) so a kiosk still running the
        // pre-results[] bundle keeps working until its nightly 04:30 reload.
        capsule: results[0].capsule,
        pin: results[0].pin,
        reason: results[0].reason,
      });
    } catch (error) {
      console.error("Error in kiosk-door-code:", error);
      res.status(500).json({ error: "Lookup failed. Please try again." });
    }
  });

  // ── Short SMS link (owner 4/8: campaign SMS must fit ONE segment) ────────
  // GET /e/<doorCode> → 302 to /<hotel_slug>/extras?code=… (29 chars shorter
  // in the SMS). The tenant is resolved from the REQUEST HOSTNAME against
  // each tenant's app_base_url, so the short form only exists on a hotel's
  // OWN domain (e.g. my.hotelcapsuleinn.com) — the shared default domain
  // cannot identify a tenant by host and keeps the long link (see
  // renderSmsText in marketing-service).
  app.get("/e/:code", async (req, res) => {
    try {
      const code = String(req.params.code || "").trim();
      if (!/^\d{4,8}$/.test(code)) return res.status(404).send("Not found");
      const host = String(req.headers.host || "").toLowerCase().split(":")[0];
      if (!host) return res.status(404).send("Not found");
      const activeTenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
      for (const tenant of activeTenants) {
        const storage = Storage.forTenant(tenant.id);
        const base = (await storage.getSetting("app_base_url"))?.value?.trim();
        if (!base) continue;
        let baseHost = "";
        try { baseHost = new URL(base).hostname.toLowerCase(); } catch { continue; }
        if (baseHost !== host) continue;
        const slug = (await storage.getSetting("hotel_slug"))?.value?.trim();
        if (!slug) continue;
        // ?o=ec|lc (owner 5/8): the campaign's offer — the extras page then
        // shows ONLY that product. Anything else falls back to both offers.
        const o = String(req.query.o || "");
        const offer = o === "ec" || o === "lc" ? `&offer=${o}` : "";
        return res.redirect(302, `/${slug}/extras?code=${encodeURIComponent(code)}${offer}`);
      }
      return res.status(404).send("Not found");
    } catch {
      return res.status(404).send("Not found");
    }
  });

  // ── Early check-in at the kiosk ──────────────────────────────────────────
  // The guest types their EXISTING door code; on payment the code's validity
  // window is moved earlier (digits never change). Tenant resolved by slug.
  const resolveTenantIdBySlug = async (hotelSlug: unknown): Promise<string | null> => {
    const slug = typeof hotelSlug === "string" ? hotelSlug.trim().toLowerCase() : "";
    if (!slug) return null;
    const activeTenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
    for (const tenant of activeTenants) {
      const slugSetting = await Storage.forTenant(tenant.id).getSetting("hotel_slug");
      if (slugSetting?.value?.trim().toLowerCase() === slug) return tenant.id;
    }
    return null;
  };

  // Funnel visibility (owner question 3/8: "why did so few buy early check-in
  // this morning?"): a lookup IS an open/attempt — the marketing-SMS link
  // carries ?code= and /extras auto-looks-up on open — so logging each quote
  // outcome gives click-through and rejection reasons per morning, read
  // straight from the logs table. Never log the door code itself, and never
  // let logging block or break the reply.
  const logExtrasFunnel = (
    tenantId: string,
    kind: "early_checkin" | "late_checkout",
    body: unknown,
    outcome: string,
    reservationId?: string,
  ): void => {
    const raw = typeof (body as { source?: unknown })?.source === "string" ? (body as { source: string }).source : "";
    const source = raw === "extras" || raw === "kiosk" ? raw : "unknown";
    Storage.forTenant(tenantId).createLog({
      level: "info",
      message: `Extras funnel: ${kind} lookup (${source}) → ${outcome}`,
      source: "extras-funnel",
      ...(reservationId ? { reservationId } : {}),
    }).catch(() => {});
  };

  app.post("/api/public/early-checkin/lookup", kioskLookupLimiter, async (req, res) => {
    try {
      const tenantId = await resolveTenantIdBySlug(req.body?.hotelSlug);
      if (!tenantId) return res.status(404).json({ error: "Hotel not found." });
      const quote = await quoteEarlyCheckin(tenantId, String(req.body?.doorCode || ""), ctx.getAutomationEngine(tenantId));
      if (!quote.ok) {
        logExtrasFunnel(tenantId, "early_checkin", req.body, `rejected: ${quote.reason}`);
        return res.json({ ok: false, reason: quote.reason });
      }
      logExtrasFunnel(
        tenantId,
        "early_checkin",
        req.body,
        `quoted ${quote.options.map((o) => `${o.label}=${o.dkk}`).join("/")} — ${quote.reservation.firstName} ${quote.reservation.lastName} (${quote.roomLabel})`,
        quote.reservation.id,
      );
      return res.json({
        ok: true,
        inspected: quote.inspected,
        firstName: quote.reservation.firstName,
        capsule: quote.roomLabel,
        options: quote.options,
        hours: quote.hours,
        dkk: quote.dkk,
        eur: quote.eur,
        validFrom: quote.validFrom.toISOString(),
      });
    } catch (error) {
      console.error("Error in early-checkin lookup:", error);
      res.status(500).json({ error: "Lookup failed. Please try again." });
    }
  });

  app.post("/api/public/early-checkin/pay", kioskLookupLimiter, async (req, res) => {
    try {
      const tenantId = await resolveTenantIdBySlug(req.body?.hotelSlug);
      if (!tenantId) return res.status(404).json({ error: "Hotel not found." });
      const result = await startEarlyCheckinPayment(
        tenantId,
        String(req.body?.doorCode || ""),
        ctx.getAutomationEngine(tenantId),
        req.body?.email ? String(req.body.email) : undefined,
        req.body?.from ? String(req.body.from) : undefined
      );
      if (!result.ok) return res.json(result);
      return res.json({ ok: true, id: result.id, paymentUrl: result.paymentUrl, dkk: result.dkk, eur: result.eur, hours: result.hours });
    } catch (error) {
      console.error("Error in early-checkin pay:", error);
      res.status(500).json({ error: "Could not start payment. Please try again." });
    }
  });

  app.get("/api/public/early-checkin/:id", earlyCheckinStatusLimiter, async (req, res) => {
    try {
      const tenantId = await resolveTenantIdBySlug(req.query?.hotel);
      if (!tenantId) return res.status(404).json({ error: "Hotel not found." });
      const status = await checkEarlyCheckinStatus(tenantId, req.params.id, ctx.getAutomationEngine(tenantId));
      if (!status) return res.status(404).json({ error: "Not found." });
      return res.json(status);
    } catch (error) {
      console.error("Error in early-checkin status:", error);
      res.status(500).json({ error: "Status check failed." });
    }
  });

  // Email the purchase receipt (early check-in AND late checkout rows) to a
  // guest-supplied address from the kiosk confirmation page.
  app.post("/api/public/early-checkin/:id/receipt", kioskLookupLimiter, async (req, res) => {
    try {
      const tenantId = await resolveTenantIdBySlug(req.body?.hotelSlug);
      if (!tenantId) return res.status(404).json({ error: "Hotel not found." });
      const email = String(req.body?.email || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: "A valid email is required." });
      }
      const result = await sendPurchaseReceipt(tenantId, req.params.id, email);
      return res.json(result);
    } catch (error) {
      console.error("Error in early-checkin receipt:", error);
      res.status(500).json({ error: "Could not send the receipt. Please try again." });
    }
  });

  app.post("/api/public/early-checkin/waitlist", kioskLookupLimiter, async (req, res) => {
    try {
      const tenantId = await resolveTenantIdBySlug(req.body?.hotelSlug);
      if (!tenantId) return res.status(404).json({ error: "Hotel not found." });
      const email = String(req.body?.email || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: "A valid email is required." });
      }
      const result = await joinEarlyCheckinWaitlist(tenantId, String(req.body?.doorCode || ""), email, ctx.getAutomationEngine(tenantId));
      return res.json(result);
    } catch (error) {
      console.error("Error in early-checkin waitlist:", error);
      res.status(500).json({ error: "Could not join the waitlist. Please try again." });
    }
  });

  // ── Late checkout at the kiosk ───────────────────────────────────────────
  // Mirror of early check-in at the other end of the stay; the status poll
  // reuses GET /api/public/early-checkin/:id (rows carry kind).
  app.post("/api/public/late-checkout/lookup", kioskLookupLimiter, async (req, res) => {
    try {
      const tenantId = await resolveTenantIdBySlug(req.body?.hotelSlug);
      if (!tenantId) return res.status(404).json({ error: "Hotel not found." });
      const quote = await quoteLateCheckout(tenantId, String(req.body?.doorCode || ""), ctx.getAutomationEngine(tenantId));
      if (!quote.ok) {
        logExtrasFunnel(tenantId, "late_checkout", req.body, `rejected: ${quote.reason}`);
        return res.json({ ok: false, reason: quote.reason });
      }
      logExtrasFunnel(
        tenantId,
        "late_checkout",
        req.body,
        `quoted ${quote.options.length} option(s) — ${quote.reservation.firstName} ${quote.reservation.lastName} (${quote.roomLabel})`,
        quote.reservation.id,
      );
      return res.json({
        ok: true,
        firstName: quote.firstName,
        capsule: quote.roomLabel,
        currentEnd: quote.currentEnd.toISOString(),
        options: quote.options,
      });
    } catch (error) {
      console.error("Error in late-checkout lookup:", error);
      res.status(500).json({ error: "Lookup failed. Please try again." });
    }
  });

  app.post("/api/public/late-checkout/pay", kioskLookupLimiter, async (req, res) => {
    try {
      const tenantId = await resolveTenantIdBySlug(req.body?.hotelSlug);
      if (!tenantId) return res.status(404).json({ error: "Hotel not found." });
      const result = await startLateCheckoutPayment(
        tenantId,
        String(req.body?.doorCode || ""),
        String(req.body?.until || ""),
        ctx.getAutomationEngine(tenantId),
        req.body?.email ? String(req.body.email) : undefined
      );
      return res.json(result);
    } catch (error) {
      console.error("Error in late-checkout pay:", error);
      res.status(500).json({ error: "Could not start payment. Please try again." });
    }
  });

  // Public API - Lookup Reservation by PIN
  app.post("/api/public/lookup-by-pin", pinLookupLimiter, async (req, res) => {
    try {
      const { pin, hotelSlug } = req.body;

      if (!pin || pin.length !== 4) {
        return res.status(400).json({ error: "Invalid PIN code" });
      }

      // Find tenant by hotel_slug or use default
      let tenantId: string | null = null;

      if (hotelSlug) {
        const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
        for (const tenant of tenants) {
          const tenantStorage = Storage.forTenant(tenant.id);
          const slugSetting = await tenantStorage.getSetting("hotel_slug");

          if (slugSetting?.value === hotelSlug) {
            tenantId = tenant.id;
            break;
          }
        }

        if (!tenantId) {
          // Slug not matched — fall back to default tenant
          tenantId = DEFAULT_TENANT_ID;
        }
      } else {
        // No slug provided - use default tenant
        tenantId = DEFAULT_TENANT_ID;
      }

      const storage = Storage.forTenant(tenantId);

      // Find reservation by generated PIN — prefer the most relevant match.
      // PINs are 4-digit (only ~9000 possible), so collisions happen.
      // Priority: active today > arriving soon > any confirmed.
      const allReservations = await storage.getAllReservations();
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const tomorrowEnd = new Date(todayStart.getTime() + 2 * 24 * 60 * 60 * 1000);

      const candidates = allReservations.filter((r) =>
        r.generatedPin === pin &&
        r.status !== "Cancelled" &&
        r.status !== "Checked-out"
      );

      if (candidates.length === 0) {
        await guestAccessGuard.recordProbe(storage.tenantId, req.ip, storage);
        return res.status(404).json({ error: "No reservation found with this code" });
      }

      // Score candidates: checked-in > arriving today/tomorrow > future > past
      const scored = candidates.map((r) => {
        const arrival = new Date(r.arrival);
        const departure = new Date(r.departure);
        let score = 0;
        // Currently checked in (arrival <= now <= departure)
        if (arrival <= now && departure >= now) score += 100;
        // Checked-in status
        if (r.status === "Checked-in") score += 50;
        // Arriving today or tomorrow
        if (arrival >= todayStart && arrival < tomorrowEnd) score += 30;
        // Future arrival
        if (arrival > now) score += 10;
        // Has active room assignment
        if (r.roomId) score += 5;
        return { reservation: r, score };
      });

      scored.sort((a, b) => b.score - a.score);
      const reservation = scored[0].reservation;

      const requireIdSetting = await storage.getSetting("require_id_for_checkin");
      const requireGuestProfile = requireIdSetting?.value === "true";

      const isPaid = reservation.preCheckinStatus === "paid"
        || !!reservation.paymentVerifiedAt
        || (reservation.owing !== null && reservation.owing !== undefined && parseFloat(reservation.owing) <= 0);

      // Only what the PIN check-in page renders. No contact details, no PMS
      // identifiers: a 4-digit code must never be a key to personal data.
      res.json({
        id: reservation.id,
        firstName: reservation.firstName,
        lastName: reservation.lastName,
        arrival: reservation.arrival,
        departure: reservation.departure,
        room: reservation.room,
        preCheckinToken: reservation.preCheckinToken,
        isPaid,
        owing: reservation.owing,
        requireGuestProfile,
      });
    } catch (error) {
      console.error("Error looking up by PIN:", error);
      res.status(500).json({ error: "Failed to lookup reservation" });
    }
  });

  // Public API - Save Personal Email and Send Digital Key
  app.post("/api/public/save-personal-email", publicLimiter, async (req, res) => {
    try {
      const { reservationId, personalEmail, pin, guestProfile } = req.body;

      if (!reservationId || !personalEmail || !pin) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      // Find the reservation and verify PIN
      const allTenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
      let foundReservation = null;
      let tenantStorage: ITenantStorage | null = null;
      let tenantName = "";

      for (const tenant of allTenants) {
        const storage = Storage.forTenant(tenant.id);
        const reservation = await storage.getReservation(reservationId);

        if (reservation && reservation.generatedPin === pin) {
          foundReservation = reservation;
          tenantStorage = storage;
          tenantName = tenant.name;
          break;
        }
      }

      if (!foundReservation || !tenantStorage) {
        return res.status(404).json({ error: "Reservation not found or invalid PIN" });
      }

      if (!foundReservation.roomId || !await tenantStorage.isRoomMapped(foundReservation.roomId)) {
        return res.status(400).json({ error: "Your room does not have digital locks configured yet. Please contact the front desk." });
      }

      // Update reservation with personal email
      await tenantStorage.updateReservation(reservationId, {
        personalEmail,
        preCheckinStatus: "code_sent",
      });

      // Server-side validation: if require_id_for_checkin is enabled, guestProfile must include nationality + ID document
      const requireIdSetting = await tenantStorage.getSetting("require_id_for_checkin");
      if (requireIdSetting?.value === "true") {
        if (!guestProfile?.nationality || !guestProfile?.identityDocument?.number || !guestProfile?.identityDocument?.type) {
          return res.status(400).json({
            error: "Guest profile with nationality and ID document is required for check-in. Please complete all required fields.",
          });
        }
      }

      // Sync email + guest profile to MEWS in a single call to avoid overwrites
      if (foundReservation.mewsCustomerId) {
        try {
          const mewsClientToken = await tenantStorage.getSetting("mews_client_token");
          const mewsAccessToken = await tenantStorage.getSetting("mews_access_token");
          const mewsEnvironment = await tenantStorage.getSetting("mews_environment");
          if (mewsClientToken?.value && mewsAccessToken?.value) {
            const mewsClient = new MewsClient(
              mewsClientToken.value,
              mewsAccessToken.value,
              (mewsEnvironment?.value as "demo" | "production") || "demo"
            );
            const profileWithEmail = {
              email: personalEmail,
              ...(guestProfile || {}),
            };
            const syncResult = await mewsClient.syncGuestProfile(foundReservation.mewsCustomerId, profileWithEmail);
            if (!syncResult.success) {
              console.warn(`[PreCheckin-PIN] MEWS profile sync had errors for ${foundReservation.id}: ${syncResult.errors.join(", ")}`);
            } else {
              console.log(`[PreCheckin-PIN] MEWS profile synced (email + profile) for ${foundReservation.firstName} ${foundReservation.lastName}`);
            }
            if (guestProfile?.identityDocument?.number) {
              await tenantStorage.updateReservation(reservationId, {
                guestSubmittedId: true,
              });
            }
          }
        } catch (profileError) {
          console.error(`[PreCheckin-PIN] MEWS profile sync error:`, profileError);
        }
      }

      const notificationClient = await createNotificationClient(tenantStorage);
      const appUrlSetting = await tenantStorage.getSetting("app_base_url");
      const baseUrl = appUrlSetting?.value || `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}` || "https://dreamboks.com";
      const hotelNameSetting = await tenantStorage.getSetting("hotel_name");
      const hotelName = hotelNameSetting?.value || "Copenhagen Downtown Hostel";
      const hotelSlug = (await tenantStorage.getSetting("hotel_slug"))?.value;
      const boardingPassUrl = buildBoardingPassUrl(baseUrl, foundReservation, hotelSlug);

      const testEmailSetting = await tenantStorage.getSetting("boarding_test_email");
      const recipientEmail = testEmailSetting?.value || personalEmail;

      const emailResult = await notificationClient.sendBoardingPassEmail({
        email: recipientEmail,
        guestName: `${foundReservation.firstName} ${foundReservation.lastName}`,
        reservationNumber: foundReservation.extId || foundReservation.confirmationCode || String(foundReservation.id),
        reservationId: foundReservation.id,
        lastName: foundReservation.lastName,
        arrivalDate: new Date(foundReservation.arrival).toLocaleDateString("en-GB", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        }),
        departureDate: new Date(foundReservation.departure).toLocaleDateString("en-GB", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        }),
        baseUrl,
        hotelSlug,
        accessCode: foundReservation.generatedPin,
      });

      const testPhoneSetting = await tenantStorage.getSetting("boarding_test_phone");
      const recipientMobile = testPhoneSetting?.value || foundReservation.mobile || null;
      let smsResult: { success: boolean; error?: string } = { success: false, error: "Not attempted" };
      let whatsappResult: { success: boolean; error?: string } = { success: false, error: "Not attempted" };

      if (recipientMobile) {
        const twilioSid = await tenantStorage.getSetting("twilio_account_sid");
        const twilioToken = await tenantStorage.getSetting("twilio_auth_token");
        const twilioFrom = await tenantStorage.getSetting("twilio_from_number");
        const twilioMessagingServiceSid = await tenantStorage.getSetting("twilio_messaging_service_sid");
        const whatsappEnabled = await tenantStorage.getSetting("whatsapp_enabled");

        if (twilioSid?.value && twilioToken?.value && twilioFrom?.value) {
          const smsClient = new NotificationClient({
            twilioAccountSid: twilioSid.value,
            twilioAuthToken: twilioToken.value,
            twilioFromNumber: twilioFrom.value,
            twilioMessagingServiceSid: twilioMessagingServiceSid?.value,
            whatsappEnabled: whatsappEnabled?.value === "true",
          });
          const guestName = `${foundReservation.firstName} ${foundReservation.lastName}`;

          smsResult = await smsClient.sendBoardingPassSMS({
            mobile: recipientMobile,
            guestName,
            boardingPassUrl,
            hotelName,
          });
          whatsappResult = await smsClient.sendBoardingPassWhatsApp({
            mobile: recipientMobile,
            guestName,
            boardingPassUrl,
            hotelName,
          });
        }
      }

      const anyDelivered = emailResult.success || smsResult.success || whatsappResult.success;
      if (anyDelivered) {
        await tenantStorage.updateReservation(reservationId, {
          notificationSent: true,
          codeDeliveredAt: new Date(),
        });

        const channels = [
          emailResult.success ? "Email" : null,
          smsResult.success ? "SMS" : null,
          whatsappResult.success ? "WhatsApp" : null,
        ].filter(Boolean).join(" + ");
        await tenantStorage.createLog({
          level: "info",
          message: testEmailSetting?.value
            ? `Digital key sent via ${channels} to TEST (${recipientEmail}) for guest (real: ${personalEmail})${recipientMobile ? ` / ${recipientMobile}` : ''}`
            : `Digital key sent via ${channels} to ${personalEmail}${recipientMobile ? ` / ${recipientMobile}` : ''}`,
          source: "checkin",
          reservationId,
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error saving personal email:", error);
      res.status(500).json({ error: "Failed to save email" });
    }
  });

  // Public API - Send Digital Key to Any Email (without saving)
  app.post("/api/public/send-boarding-pass-email", publicLimiter, async (req, res) => {
    try {
      const { reservationNumber, lastName, email } = req.body;

      if (!reservationNumber || !lastName || !email) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      if (!email.includes("@")) {
        return res.status(400).json({ error: "Invalid email address" });
      }

      // Find the reservation: guarded lookup on the tenant the page named
      // (hotelSlug; default tenant otherwise). A cross-tenant scan is only
      // done for a link-grade identifier — it cannot be enumerated.
      const primary = await getPublicTenantStorage(req);
      const first = await guardedByNumber(req, primary, reservationNumber, lastName);
      if (first.locked) return respondLocked(res);
      let foundReservation = first.result?.reservation ?? null;
      let tenantStorage: ITenantStorage | null = first.result ? primary : null;
      if (!foundReservation && isLinkGradeIdentifier(String(reservationNumber))) {
        const allTenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
        for (const tenant of allTenants) {
          if (tenant.id === primary.tenantId) continue;
          const storage = Storage.forTenant(tenant.id);
          const result = await storage.getReservationByNumberAndName(String(reservationNumber).trim(), String(lastName).trim());
          if (result) {
            foundReservation = result.reservation;
            tenantStorage = storage;
            break;
          }
        }
      }

      if (!foundReservation || !tenantStorage) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      if (!foundReservation.roomId || !await tenantStorage.isRoomMapped(foundReservation.roomId)) {
        return res.status(400).json({ error: "Your room does not have digital locks configured yet. Please contact the front desk." });
      }

      const notificationClient = await createNotificationClient(tenantStorage);
      const appUrlSetting = await tenantStorage.getSetting("app_base_url");
      const baseUrl = appUrlSetting?.value || `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}` || "https://dreamboks.com";
      const hotelNameSetting = await tenantStorage.getSetting("hotel_name");
      const hotelName = hotelNameSetting?.value || "Copenhagen Downtown Hostel";
      const hotelSlug = (await tenantStorage.getSetting("hotel_slug"))?.value;
      const boardingPassUrl = buildBoardingPassUrl(baseUrl, foundReservation, hotelSlug);

      const emailResult = await notificationClient.sendBoardingPassEmail({
        email,
        accessCode: foundReservation.generatedPin,
        guestName: `${foundReservation.firstName} ${foundReservation.lastName}`,
        reservationNumber: foundReservation.extId || foundReservation.confirmationCode || String(foundReservation.id),
        reservationId: foundReservation.id,
        lastName: foundReservation.lastName,
        arrivalDate: new Date(foundReservation.arrival).toLocaleDateString("en-GB", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        }),
        departureDate: new Date(foundReservation.departure).toLocaleDateString("en-GB", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        }),
        baseUrl,
        hotelSlug,
      });

      const testPhoneSetting = await tenantStorage.getSetting("boarding_test_phone");
      const recipientMobile = testPhoneSetting?.value || foundReservation.mobile || null;
      let smsResult: { success: boolean; error?: string } = { success: false, error: "Not attempted" };
      let whatsappResult: { success: boolean; error?: string } = { success: false, error: "Not attempted" };

      if (recipientMobile) {
        const twilioSid = await tenantStorage.getSetting("twilio_account_sid");
        const twilioToken = await tenantStorage.getSetting("twilio_auth_token");
        const twilioFrom = await tenantStorage.getSetting("twilio_from_number");
        const twilioMessagingServiceSid = await tenantStorage.getSetting("twilio_messaging_service_sid");
        const whatsappEnabled = await tenantStorage.getSetting("whatsapp_enabled");

        if (twilioSid?.value && twilioToken?.value && twilioFrom?.value) {
          const smsClient = new NotificationClient({
            twilioAccountSid: twilioSid.value,
            twilioAuthToken: twilioToken.value,
            twilioFromNumber: twilioFrom.value,
            twilioMessagingServiceSid: twilioMessagingServiceSid?.value,
            whatsappEnabled: whatsappEnabled?.value === "true",
          });
          const guestName = `${foundReservation.firstName} ${foundReservation.lastName}`;

          smsResult = await smsClient.sendBoardingPassSMS({
            mobile: recipientMobile,
            guestName,
            boardingPassUrl,
            hotelName,
          });
          whatsappResult = await smsClient.sendBoardingPassWhatsApp({
            mobile: recipientMobile,
            guestName,
            boardingPassUrl,
            hotelName,
          });
        }
      }

      const anyDelivered = emailResult.success || smsResult.success || whatsappResult.success;
      if (anyDelivered) {
        const channels = [
          emailResult.success ? "Email" : null,
          smsResult.success ? "SMS" : null,
          whatsappResult.success ? "WhatsApp" : null,
        ].filter(Boolean).join(" + ");
        await tenantStorage.createLog({
          level: "info",
          message: `Digital key sent via ${channels} to ${email}${recipientMobile ? ` / ${recipientMobile}` : ''}`,
          source: "checkin",
          reservationId: foundReservation.id,
        });
        res.json({ success: true });
      } else {
        res.status(500).json({ error: emailResult.error || "Failed to send digital key" });
      }
    } catch (error) {
      console.error("Error sending digital key email:", error);
      res.status(500).json({ error: "Failed to send digital key email" });
    }
  });

  // Public API - Resend Digital Key Email
  app.post("/api/public/resend-boarding-pass", publicLimiter, async (req, res) => {
    try {
      const { reservationId, pin } = req.body;

      if (!reservationId || !pin) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      // Find the reservation and verify PIN
      const allTenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
      let foundReservation = null;
      let tenantStorage: ITenantStorage | null = null;

      for (const tenant of allTenants) {
        const storage = Storage.forTenant(tenant.id);
        const reservation = await storage.getReservation(reservationId);

        if (reservation && reservation.generatedPin === pin) {
          foundReservation = reservation;
          tenantStorage = storage;
          break;
        }
      }

      if (!foundReservation || !tenantStorage) {
        return res.status(404).json({ error: "Reservation not found or invalid PIN" });
      }

      if (!foundReservation.personalEmail) {
        return res.status(400).json({ error: "No personal email on file. Please complete check-in first." });
      }

      if (!foundReservation.roomId || !await tenantStorage.isRoomMapped(foundReservation.roomId)) {
        return res.status(400).json({ error: "Your room does not have digital locks configured yet. Please contact the front desk." });
      }

      const notificationClient = await createNotificationClient(tenantStorage);
      const appUrlSetting = await tenantStorage.getSetting("app_base_url");
      const baseUrl = appUrlSetting?.value || `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}` || "https://dreamboks.com";
      const hotelNameSetting = await tenantStorage.getSetting("hotel_name");
      const hotelName = hotelNameSetting?.value || "Copenhagen Downtown Hostel";
      const hotelSlug = (await tenantStorage.getSetting("hotel_slug"))?.value;
      const boardingPassUrl = buildBoardingPassUrl(baseUrl, foundReservation, hotelSlug);

      const emailResult = await notificationClient.sendBoardingPassEmail({
        email: foundReservation.personalEmail,
        accessCode: foundReservation.generatedPin,
        guestName: `${foundReservation.firstName} ${foundReservation.lastName}`,
        reservationNumber: foundReservation.extId || foundReservation.confirmationCode || String(foundReservation.id),
        reservationId: foundReservation.id,
        lastName: foundReservation.lastName,
        arrivalDate: new Date(foundReservation.arrival).toLocaleDateString("en-GB", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        }),
        departureDate: new Date(foundReservation.departure).toLocaleDateString("en-GB", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        }),
        baseUrl,
        hotelSlug,
      });

      const testPhoneSetting = await tenantStorage.getSetting("boarding_test_phone");
      const recipientMobile = testPhoneSetting?.value || foundReservation.mobile || null;
      let smsResult: { success: boolean; error?: string } = { success: false, error: "Not attempted" };
      let whatsappResult: { success: boolean; error?: string } = { success: false, error: "Not attempted" };

      if (recipientMobile) {
        const twilioSid = await tenantStorage.getSetting("twilio_account_sid");
        const twilioToken = await tenantStorage.getSetting("twilio_auth_token");
        const twilioFrom = await tenantStorage.getSetting("twilio_from_number");
        const twilioMessagingServiceSid = await tenantStorage.getSetting("twilio_messaging_service_sid");
        const whatsappEnabled = await tenantStorage.getSetting("whatsapp_enabled");

        if (twilioSid?.value && twilioToken?.value && twilioFrom?.value) {
          const smsClient = new NotificationClient({
            twilioAccountSid: twilioSid.value,
            twilioAuthToken: twilioToken.value,
            twilioFromNumber: twilioFrom.value,
            twilioMessagingServiceSid: twilioMessagingServiceSid?.value,
            whatsappEnabled: whatsappEnabled?.value === "true",
          });
          const guestName = `${foundReservation.firstName} ${foundReservation.lastName}`;

          smsResult = await smsClient.sendBoardingPassSMS({
            mobile: recipientMobile,
            guestName,
            boardingPassUrl,
            hotelName,
          });
          whatsappResult = await smsClient.sendBoardingPassWhatsApp({
            mobile: recipientMobile,
            guestName,
            boardingPassUrl,
            hotelName,
          });
        }
      }

      const anyDelivered = emailResult.success || smsResult.success || whatsappResult.success;
      if (anyDelivered) {
        const channels = [
          emailResult.success ? "Email" : null,
          smsResult.success ? "SMS" : null,
          whatsappResult.success ? "WhatsApp" : null,
        ].filter(Boolean).join(" + ");
        await tenantStorage.createLog({
          level: "info",
          message: `Digital key resent via ${channels} to ${foundReservation.personalEmail}${recipientMobile ? ` / ${recipientMobile}` : ''}`,
          source: "checkin",
          reservationId,
        });
        res.json({ success: true });
      } else {
        res.status(500).json({ error: emailResult.error || "Failed to send digital key" });
      }
    } catch (error) {
      console.error("Error resending digital key:", error);
      res.status(500).json({ error: "Failed to resend digital key" });
    }
  });

  // Public API - Get Rating Settings
  app.get("/api/public/rating-settings", async (req, res) => {
    try {
      // Support tenant from query: ?t=<tenantId> (existing) or ?hotel=<slug> (guest flow).
      const tenantFromQuery = req.query.t as string | undefined;
      const slug = req.query.hotel as string | undefined;
      let storage = tenantFromQuery ? Storage.forTenant(tenantFromQuery) : null;
      if (!storage && slug) {
        const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
        for (const tenant of tenants) {
          const ts = Storage.forTenant(tenant.id);
          if ((await ts.getSetting("hotel_slug"))?.value?.trim().toLowerCase() === slug.trim().toLowerCase()) {
            storage = ts;
            break;
          }
        }
      }
      if (!storage) storage = getTenantStorage(req);

      const allSettings = await storage.getAllSettings();
      const get = (k: string) => allSettings.find(s => s.key === k)?.value;

      res.json({
        goodUrl: get("rating_good_url") || "",
        badUrl: get("rating_bad_url") || "",
        threshold: get("rating_threshold") || "4",
        theme: buildGuestFlowTheme(get),
      });
    } catch (error) {
      console.error("Error fetching rating settings:", error);
      res.status(500).json({ error: "Failed to load rating settings" });
    }
  });

  app.post("/api/public/find-reservation", findReservationLimiter, async (req, res) => {
    try {
      const { hotelSlug, lastName, reservationNumber } = req.body as {
        hotelSlug?: string;
        lastName?: string;
        reservationNumber?: string;
      };

      const slug = (hotelSlug || "").trim();
      const lastNameTrim = (lastName || "").trim();
      const resNumTrim = (reservationNumber || "").trim();

      if (!slug || lastNameTrim.length < 2) {
        return res.status(400).json({ error: "Hotel and last name (min 2 chars) are required." });
      }

      const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
      let matchedTenantId: string | null = null;
      for (const tenant of tenants) {
        const tenantStorage = Storage.forTenant(tenant.id);
        const slugSetting = await tenantStorage.getSetting("hotel_slug");
        if (slugSetting?.value === slug) {
          matchedTenantId = tenant.id;
          break;
        }
      }
      if (!matchedTenantId) {
        return res.status(404).json({ error: "Hotel not found." });
      }

      const now = new Date();
      const arrivalCutoff = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      const matchRows = await db
        .selectDistinct({ reservation: reservationsTable })
        .from(reservationsTable)
        .innerJoin(
          roomLockAssignments,
          and(
            eq(reservationsTable.roomId, roomLockAssignments.roomId),
            eq(roomLockAssignments.tenantId, reservationsTable.tenantId)
          )
        )
        .innerJoin(lockDevices, eq(roomLockAssignments.lockDeviceId, lockDevices.id))
        .where(
          and(
            eq(reservationsTable.tenantId, matchedTenantId),
            eq(lockDevices.lockType, "room"),
            sql`LOWER(${reservationsTable.lastName}) = LOWER(${lastNameTrim})`,
            lte(reservationsTable.arrival, arrivalCutoff),
            gte(reservationsTable.departure, now),
            inArray(reservationsTable.status, ["Confirmed", "Started", "Checked-in"])
          )
        );
      const matches = matchRows.map((r) => r.reservation);

      let filtered = matches;
      if (resNumTrim.length > 0) {
        filtered = matches.filter(
          (r) => r.confirmationCode === resNumTrim || r.extId === resNumTrim
        );
      }

      if (filtered.length === 0) {
        return res
          .status(404)
          .json({ found: false, error: "No matching reservation found. Please contact reception." });
      }

      if (filtered.length > 1) {
        return res.json({ found: true, multiple: true, count: filtered.length });
      }

      let reservation = filtered[0];
      if (!reservation.preCheckinToken) {
        const token = crypto.randomBytes(32).toString("hex");
        const storage = Storage.forTenant(matchedTenantId);
        await storage.updateReservation(reservation.id, { preCheckinToken: token });
        reservation = { ...reservation, preCheckinToken: token };
      }

      return res.json({
        found: true,
        multiple: false,
        token: reservation.preCheckinToken,
      });
    } catch (error) {
      console.error("Error in find-reservation:", error);
      res.status(500).json({ error: "Lookup failed. Please try again." });
    }
  });
}
