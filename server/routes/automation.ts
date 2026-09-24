import type { Express } from "express";
import type { RouteContext } from "./index";
import { getTenantStorage, resolveTenantId, verifyHotelToken, verifyHotelOrSetupToken } from "./middleware";
import { Storage, DEFAULT_TENANT_ID } from "../storage";
import { insertQrCodeSchema } from "@shared/schema";
import { MewsClient } from "../mews-client";

export function registerAutomationRoutes(app: Express, ctx: RouteContext) {
  // ==============================
  // TTLock Token & Sync
  // ==============================

  app.post("/api/ttlock/refresh-token", async (req, res) => {
    if (!await verifyHotelOrSetupToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);

      // Global DreamBoks credentials - MUST be in environment variables (not tenant settings)
      const clientId = process.env.TTLOCK_CLIENT_ID;
      const clientSecret = process.env.TTLOCK_API_KEY;

      // Per-tenant credentials - must be configured by the hotel
      const usernameSetting = await storage.getSetting("ttlock_username");
      const passwordSetting = await storage.getSetting("ttlock_password");
      const regionSetting = await storage.getSetting("ttlock_region");

      if (!clientId || !clientSecret) {
        console.error("[TTLock] Missing TTLOCK_CLIENT_ID or TTLOCK_API_KEY environment variables");
        return res.status(503).json({ error: "TTLock integration not configured. Please contact support." });
      }
      if (!usernameSetting?.value) {
        return res.status(400).json({ error: "Please enter your TTLock email address" });
      }
      if (!passwordSetting?.value) {
        return res.status(400).json({ error: "Please enter your TTLock password" });
      }

      const { TTLockClient } = await import("../ttlock-client");
      const region = (regionSetting?.value as "eu" | "cn") || "eu";

      console.log(`[TTLock] Refreshing access token for user: ${usernameSetting.value}`);

      const tokenResponse = await TTLockClient.getAccessToken(
        clientId,
        clientSecret,
        usernameSetting.value,
        passwordSetting.value,
        region
      );

      await storage.setSetting("ttlock_access_token", tokenResponse.access_token);

      await storage.createLog({
        level: "info",
        message: "TTLock access token refreshed successfully",
        source: "System",
      });

      res.json({
        success: true,
        message: "Access token refreshed successfully",
        expiresIn: tokenResponse.expires_in,
      });
    } catch (error) {
      console.error("Error refreshing TTLock token:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Failed to refresh token: ${errorMessage}` });
    }
  });

  app.post("/api/sync-ttlocks", async (req, res) => {
    if (!await verifyHotelOrSetupToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);

      // Step 1: Get hotel's TTLock credentials from settings
      const clientId = process.env.TTLOCK_CLIENT_ID;
      const hotelAccessToken = await storage.getSetting("ttlock_access_token");
      const regionSetting = await storage.getSetting("ttlock_region");

      if (!clientId) {
        return res.status(503).json({ error: "TTLock integration not configured. Please contact support." });
      }
      const region = (regionSetting?.value as "eu" | "cn") || "eu";

      // How this hotel's locks are identified inside the shared owner account.
      // GROUP MODE (ttlock_group_id set) trusts TTLock's per-hotel group membership
      // and needs no hotel token — REQUIRED for hotels whose stored TTLock account is
      // the shared owner account (e.g. Copenhagen Downtown), where a token probe sees
      // EVERY hotel's locks and would import them all. ACCOUNT-PROBE MODE (no group)
      // is the legacy path for hotels with their own scoped Authorized-Admin account.
      const groupIdSetting = await storage.getSetting("ttlock_group_id");
      const groupIdRaw = groupIdSetting?.value?.trim();
      const groupId = groupIdRaw ? Number(groupIdRaw) : null;
      const useGroupMode = groupId !== null && Number.isFinite(groupId);

      if (!useGroupMode && !hotelAccessToken?.value) {
        return res.status(400).json({ error: "TTLock not connected. Please connect your TTLock account in Settings first." });
      }

      // Step 2: Get ALL locks from owner account
      const { createOwnerClient, TTLockClient } = await import("../ttlock-client");

      let ownerClient;
      try {
        ownerClient = await createOwnerClient(region);
      } catch (error) {
        console.error("[TTLock] Failed to create owner client:", error);
        return res.status(503).json({
          error: "TTLock owner credentials not configured. Please contact support."
        });
      }

      const allLocks = await ownerClient.listAllLocks();
      console.log(`[TTLock Sync] Owner has ${allLocks.length} total locks`);

      let imported = 0;
      let updated = 0;
      let skipped = 0;
      const accessibleLocks: string[] = [];
      const accessibleTtlockIds = new Set<string>();
      // Locks whose access probe failed for a reason OTHER than a documented
      // "no access" answer (timeout, rate limit, API hiccup). Their true state
      // is UNKNOWN — they are excluded from import AND protected from deletion.
      const unknownTtlockIds = new Set<string>();

      if (useGroupMode) {
        // GROUP MODE: this hotel's locks are exactly the members of its TTLock group.
        // Group membership is authoritative and already scoped per hotel, so no other
        // hotel's locks can leak in — and no hotel token is needed.
        const groupLocks = allLocks.filter((lock: any) => lock.groupId === groupId);
        console.log(`[TTLock Sync] Group mode: TTLock group ${groupId} has ${groupLocks.length} locks`);
        for (const lock of groupLocks) {
          const existing = await storage.getLockDeviceByTTLockId(lock.lockId.toString());
          await storage.syncLockDeviceFromTTLock(lock.lockId.toString(), {
            name: lock.name,
            mac: lock.mac,
            battery: lock.battery,
          });
          accessibleLocks.push(lock.name);
          accessibleTtlockIds.add(lock.lockId.toString());
          if (existing) {
            updated++;
          } else {
            imported++;
          }
        }
      } else {
        // ACCOUNT-PROBE MODE: verify access with the hotel's OWN token.
        // useOwnerToken=false is CRITICAL: the probe must run as the hotel's own
        // TTLock account, not the shared owner account. With the owner token every
        // lock would appear accessible and the hotel would import every other hotel's
        // locks (cross-tenant data leak).
        const hotelClient = new TTLockClient(clientId, hotelAccessToken!.value, region, false);

        // PRE-FLIGHT: validate the hotel token before trusting any access result.
        // getLockStatus() swallows all errors and returns null (see ttlock-client.ts),
        // so an expired/invalid token looks identical to "no access to any lock" — and
        // Step 5 below would then delete every lock in the DB. That is exactly what
        // wiped Copenhagen Downtown on 2026-07-15 (cascading to room_lock_assignments).
        // listLocks() throws on an invalid token, so we can abort safely.
        try {
          await hotelClient.listLocks(1, 1);
        } catch (preflightError: any) {
          console.error("[TTLock Sync] Hotel token pre-flight failed — aborting, no changes made:", preflightError?.message || preflightError);
          return res.status(401).json({
            error: "TTLock access token is invalid or expired. Refresh your TTLock connection in Settings, then sync again. No locks were changed.",
          });
        }

        // For each lock, verify the hotel has admin access, and sync the ones it does.
        // strict=true: only a documented 10003/"not lock admin" maps to null;
        // transient errors throw and land the lock in unknownTtlockIds so it is
        // never deleted on the basis of an API hiccup.
        for (const lock of allLocks) {
          try {
            const lockStatus = await hotelClient.getLockStatus(lock.lockId.toString(), true);

            if (lockStatus) {
              const existing = await storage.getLockDeviceByTTLockId(lock.lockId.toString());
              console.log(`[TTLock Sync] ✓ Lock ${lock.lockId}: name="${lock.name}" - hotel has access`);
              accessibleLocks.push(lock.name);
              accessibleTtlockIds.add(lock.lockId.toString());
              await storage.syncLockDeviceFromTTLock(lock.lockId.toString(), {
                name: lock.name,
                mac: lock.mac,
                battery: lockStatus.battery,
              });
              if (existing) {
                updated++;
              } else {
                imported++;
              }
            } else {
              // Documented no-access answer — genuinely not this hotel's lock.
              console.log(`[TTLock Sync] ✗ Lock ${lock.lockId}: name="${lock.name}" - no hotel access, skipping`);
              skipped++;
            }
          } catch (error: any) {
            const errMsg = error?.message || '';
            if (errMsg.includes('not lock admin') || errMsg.includes('10003')) {
              console.log(`[TTLock Sync] ✗ Lock ${lock.lockId}: name="${lock.name}" - no hotel access, skipping`);
              skipped++;
            } else {
              // Transient/unknown — state undetermined, protect from deletion.
              unknownTtlockIds.add(lock.lockId.toString());
              console.error(`[TTLock Sync] ? Lock ${lock.lockId}: transient error checking access (protected from cleanup):`, errMsg);
              skipped++;
            }
          }
        }
      }

      // Get all locks currently in database for this tenant
      const existingLocks = await storage.getAllLockDevices();
      let deleted = 0;
      const deletedLocks: string[] = [];

      // SAFETY: only prune locks when the access check succeeded for at least one
      // lock. Zero accessible locks signals a systemic failure (bad token, API
      // outage) rather than the hotel genuinely losing every lock. Deleting under
      // that condition is what caused the 2026-07-15 mass wipe, so we refuse to.
      if (accessibleLocks.length === 0) {
        console.warn("[TTLock Sync] 0 accessible locks — skipping cleanup step entirely to avoid mass deletion.");
      } else {
        // Collect candidates first — deletion runs only if the batch passes the
        // circuit breaker. Locks with UNKNOWN probe results are never candidates.
        const deletionCandidates = existingLocks.filter(dbLock =>
          dbLock.ttlockId &&
          !accessibleTtlockIds.has(dbLock.ttlockId) &&
          !unknownTtlockIds.has(dbLock.ttlockId)
        );

        // Circuit breaker: a legitimate sync removes at most a lock or two
        // (renamed/retired hardware). A bigger batch means something systemic
        // (token trouble, API instability) — abort and alert instead.
        const MAX_DELETIONS_PER_SYNC = 3;
        if (deletionCandidates.length > MAX_DELETIONS_PER_SYNC) {
          console.error(`[TTLock Sync] Cleanup ABORTED: ${deletionCandidates.length} deletion candidates exceeds safety limit ${MAX_DELETIONS_PER_SYNC} — no locks deleted.`);
          await storage.createLog({
            level: "error",
            message: `TTLock sync cleanup ABORTED: ${deletionCandidates.length} locks would have been deleted (limit ${MAX_DELETIONS_PER_SYNC}): ${deletionCandidates.map(l => l.name).join(", ")}. Suspected systemic issue — verify the TTLock connection and lock assignments, then re-run sync.`,
            source: "System",
          });
          const { sendOpsAlert } = await import("../ops-alert");
          await sendOpsAlert(
            storage as any,
            "sync-cleanup-breaker",
            "critical",
            `Lås-sync AFBRUDT: ${deletionCandidates.length} låse ville være blevet slettet (grænse: ${MAX_DELETIONS_PER_SYNC})`,
            `Kandidater: ${deletionCandidates.map(l => l.name).join(", ")}. Ingen låse blev slettet. Tjek TTLock-forbindelsen og kør sync igen.`
          );
        } else {
          for (const dbLock of deletionCandidates) {
            console.log(`[TTLock Sync] 🗑️ Removing lock ${dbLock.ttlockId}: name="${dbLock.name}" - no hotel access`);
            await storage.createLog({
              level: "warn",
              message: `TTLock sync removed lock "${dbLock.name}" (${dbLock.ttlockId}) — hotel has no access to it`,
              source: "System",
            });
            await storage.deleteLockDevice(dbLock.id);
            deletedLocks.push(dbLock.name);
            deleted++;
          }
        }
      }

      // Log internally for debugging (not exposed to hotel)
      console.log(`[TTLock Sync] Complete: ${imported} imported, ${updated} updated, ${deleted} removed from local DB`);

      // Response only shows hotel's own locks - no information about other locks
      res.json({
        success: true,
        imported,
        updated,
        removed: deleted,
        totalLocks: accessibleLocks.length,
        locks: accessibleLocks,
      });
    } catch (error) {
      console.error("Error syncing TTLock devices:", error);
      res.status(500).json({ error: "Failed to sync TTLock devices" });
    }
  });

  app.post("/api/sync-spaces", async (req, res) => {
    if (!await verifyHotelOrSetupToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const mewsClientToken = await storage.getSetting("mews_client_token");
      const mewsAccessToken = await storage.getSetting("mews_access_token");
      const mewsEnvironment = await storage.getSetting("mews_environment");

      if (!mewsClientToken || !mewsAccessToken) {
        return res.status(400).json({ error: "MEWS credentials not configured" });
      }

      const mewsClient = new MewsClient(
        mewsClientToken.value,
        mewsAccessToken.value,
        (mewsEnvironment?.value as "demo" | "production") || "demo"
      );

      const resources = await mewsClient.getResources();

      let imported = 0;
      let updated = 0;

      for (const resource of resources) {
        const existing = await storage.getRoomByPmsId(resource.Id);

        console.log(`[MEWS Sync] Space ${resource.Id}: name="${resource.Name}", state="${resource.State}"`);

        if (existing) {
          await storage.updateRoom(existing.id, {
            name: resource.Name,
          });
          updated++;
        } else {
          await storage.createRoom({
            name: resource.Name,
            type: "room",
            beds: 1,
            pmsStatus: "mapped",
            pmsId: resource.Id,
            ttlockId: null,
            commonAreas: [],
            isDreamBoks: false,
          });
          imported++;
        }
      }

      res.json({
        success: true,
        imported,
        updated,
        total: resources.length,
      });
    } catch (error) {
      console.error("Error syncing MEWS spaces:", error);
      res.status(500).json({ error: "Failed to sync MEWS spaces" });
    }
  });

  // ==============================
  // QR Codes
  // ==============================

  app.get("/api/qr-codes/room/:roomId", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const codes = await storage.getQrCodesByRoom(req.params.roomId);
      res.json(codes);
    } catch (error) {
      console.error("Error fetching QR codes:", error);
      res.status(500).json({ error: "Failed to fetch QR codes" });
    }
  });

  app.post("/api/qr-codes", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const validated = insertQrCodeSchema.parse(req.body);
      const code = await storage.createQrCode(validated);
      res.status(201).json(code);
    } catch (error) {
      console.error("Error creating QR code:", error);
      res.status(400).json({ error: "Failed to create QR code" });
    }
  });

  // ==============================
  // Statistics
  // ==============================

  app.get("/api/statistics/overview", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const allReservations = await storage.getAllReservations();
      const allRooms = await storage.getAllRooms();

      // Get all DreamBoks room names
      const dreamBoksRoomNames = new Set(
        allRooms
          .filter(room => room.spaceCategory === 'DreamBoks')
          .map(room => room.name)
      );

      // Filter to active reservations in DreamBoks rooms only
      const activeReservations = allReservations.filter(r =>
        (r.status === 'Confirmed' || r.status === 'Checked-in') &&
        r.room && dreamBoksRoomNames.has(r.room)
      );

      let totalRevenue = 0;
      let totalNights = 0;
      let invalidData = 0;

      for (const reservation of activeReservations) {
        if (reservation.totalAmount) {
          const amount = parseFloat(reservation.totalAmount);
          if (!isNaN(amount) && amount > 0) {
            totalRevenue += amount;
          } else {
            invalidData++;
            await storage.createLog({
              level: 'warn',
              message: `Invalid totalAmount for reservation ${reservation.extId}: ${reservation.totalAmount}`,
              source: 'statistics',
              reservationId: reservation.id,
            });
          }
        }

        const arrivalDate = new Date(reservation.arrival);
        const departureDate = new Date(reservation.departure);

        if (isNaN(arrivalDate.getTime()) || isNaN(departureDate.getTime())) {
          invalidData++;
          await storage.createLog({
            level: 'error',
            message: `Invalid dates for reservation ${reservation.extId}: arrival=${reservation.arrival}, departure=${reservation.departure}`,
            source: 'statistics',
            reservationId: reservation.id,
          });
          continue;
        }

        if (departureDate <= arrivalDate) {
          invalidData++;
          await storage.createLog({
            level: 'warn',
            message: `Departure before/equal arrival for reservation ${reservation.extId}`,
            source: 'statistics',
            reservationId: reservation.id,
          });
          continue;
        }

        const nights = Math.ceil((departureDate.getTime() - arrivalDate.getTime()) / (1000 * 60 * 60 * 24));
        if (nights > 0) {
          totalNights += nights;
        }
      }

      const averagePrice = totalNights > 0 ? totalRevenue / totalNights : 0;

      if (invalidData > 0) {
        console.warn(`[Statistics] Found ${invalidData} reservations with invalid data`);
      }

      res.json({
        totalRevenue: Math.round(totalRevenue),
        totalNights,
        averagePrice: Math.round(averagePrice),
        currency: activeReservations.length > 0 ? activeReservations[0].currency || 'DKK' : 'DKK',
        totalReservations: activeReservations.length,
        invalidDataCount: invalidData,
      });
    } catch (error) {
      console.error("Error calculating statistics:", error);
      res.status(500).json({ error: "Failed to calculate statistics" });
    }
  });

  // ==============================
  // Automation - Manual Passcode Triggering
  // ==============================

  app.post("/api/automation/generate-passcode/:reservationId", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const result = await ctx.getAutomationEngine(resolveTenantId(req)).createPasscodeForReservation(req.params.reservationId);
      if (result.success) {
        res.json({
          success: true,
          passcode: result.passcode,
          ttlockKeyId: result.ttlockKeyId,
          details: result.details,
        });
      } else {
        res.status(400).json({
          success: false,
          error: result.error,
        });
      }
    } catch (error) {
      console.error("Error generating passcode:", error);
      res.status(500).json({ error: "Failed to generate passcode" });
    }
  });

  app.delete("/api/automation/delete-passcode/:reservationId", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      let success = false;
      let lastError = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const storage = getTenantStorage(req);
          const reservation = await storage.getReservation(req.params.reservationId);
          if (reservation) {
            await ctx.getAutomationEngine(resolveTenantId(req)).getPinLifecycle().onCancelled(reservation, { force: true });
            success = true;
          }
          if (success) break;

          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        } catch (err) {
          lastError = err;
          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }

      if (success) {
        res.json({ success: true });
      } else {
        const errorMsg = lastError instanceof Error ? lastError.message : "TTLock API fejlede - prøv igen om lidt (passwordet kan være for nyligt oprettet)";
        res.status(400).json({ success: false, error: errorMsg });
      }
    } catch (error) {
      console.error("Error deleting passcode:", error);
      const errorMsg = error instanceof Error ? error.message : "Kunne ikke slette passcode";
      res.status(500).json({ error: errorMsg });
    }
  });

  // Repair passcode - sync existing PIN to any missing locks
  app.post("/api/automation/repair-passcode/:reservationId", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const force = req.query.force === 'true' || req.body?.force === true;
      // Manual admin action = the deliberate escape hatch: also re-attempts
      // locks the automation has accepted as confirmedUnlisted (-3007 phantom),
      // so a false-positive convergence can be healed by hand.
      const result = await ctx.getAutomationEngine(resolveTenantId(req)).repairPasscodeForReservation(req.params.reservationId, force, { includeConfirmedUnlisted: true });
      if (result.success) {
        res.json({
          success: true,
          synced: result.synced || [],
          offline: result.offline || [],
          message: result.synced?.length
            ? `Synced to: ${result.synced.join(", ")}`
            : result.offline?.length
              ? `Deferred — lock(s) offline: ${result.offline.join(", ")} (will retry when reconnected)`
              : "All locks already have the passcode"
        });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error) {
      console.error("Error repairing passcode:", error);
      res.status(500).json({ error: "Failed to repair passcode" });
    }
  });

  // Generate QR codes for existing active PIN
  app.post("/api/automation/generate-qr-codes/:pinId", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const pin = await storage.getPin(req.params.pinId);

      if (!pin) {
        return res.status(404).json({ error: "PIN not found" });
      }

      if (pin.status !== "active") {
        return res.status(400).json({ error: "PIN must be active to generate QR codes" });
      }

      if (!pin.reservationId) {
        return res.status(400).json({ error: "PIN has no linked reservation" });
      }

      const reservation = await storage.getReservation(pin.reservationId);
      if (!reservation || !reservation.roomId) {
        return res.status(400).json({ error: "Reservation or room not found" });
      }

      // Get lock assignments for this room
      const lockAssignments = await storage.getRoomLockAssignments(reservation.roomId);
      if (lockAssignments.length === 0) {
        return res.status(400).json({ error: "No locks assigned to this room" });
      }

      // Initialize TTLock client
      const ttlockAccessToken = await storage.getSetting("ttlock_access_token");
      const ttlockRegion = await storage.getSetting("ttlock_region");
      if (!ttlockAccessToken?.value) {
        return res.status(400).json({ error: "TTLock not configured" });
      }

      const { TTLockClient } = await import("../ttlock-client");
      const ttlockClient = new TTLockClient(
        process.env.TTLOCK_CLIENT_ID!,
        ttlockAccessToken.value,
        (ttlockRegion?.value === "cn" ? "cn" : "eu") as "eu" | "cn"
      );

      interface QrCodeEntry {
        lockDeviceId: string;
        ttlockId: string;
        qrCodeId: number;
        qrCodeData: string;
        lockName: string;
      }

      const qrCodeDataList: QrCodeEntry[] = [];
      const errors: string[] = [];

      for (const assignment of lockAssignments) {
        const lockDevice = await storage.getLockDevice(assignment.lockDeviceId);
        if (!lockDevice?.ttlockId) continue;

        try {
          // Create time-limited QR code (type=3) via TTLock API
          const qrResult = await ttlockClient.createQrCode(
            lockDevice.ttlockId,
            `${reservation.firstName} ${reservation.lastName} - ${lockDevice.name}`,
            new Date(pin.validFrom),
            new Date(pin.validTo)
          );

          const qrData = await ttlockClient.getQrCodeData(lockDevice.ttlockId, qrResult.qrCodeId);

          qrCodeDataList.push({
            lockDeviceId: lockDevice.id,
            ttlockId: lockDevice.ttlockId,
            qrCodeId: qrResult.qrCodeId,
            qrCodeData: qrData.qrCodeData,
            lockName: lockDevice.name,
          });
        } catch (error) {
          errors.push(`${lockDevice.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (qrCodeDataList.length > 0) {
        // Update PIN with QR code data
        await storage.updatePin(pin.id, {
          qrCodeData: qrCodeDataList,
        });

        res.json({
          success: true,
          message: `Generated ${qrCodeDataList.length} QR code(s)`,
          qrCodes: qrCodeDataList.map(q => ({ lockName: q.lockName, qrCodeId: q.qrCodeId })),
          errors: errors.length > 0 ? errors : undefined
        });
      } else {
        res.status(400).json({
          success: false,
          error: "Failed to generate any QR codes",
          details: errors
        });
      }
    } catch (error) {
      console.error("Error generating QR codes:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to generate QR codes" });
    }
  });

  // Manual PIN Activation - Trigger pending PIN activation for today's arrivals
  app.post("/api/automation/activate-pending-pins", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      if (!ctx.isAutomationReady()) {
        return res.status(503).json({
          error: "Automation engine not initialized yet. Please wait and try again."
        });
      }

      console.log("[API] Manual PIN activation triggered");
      // PIN activation runs through the automation engine
      const engine = ctx.getAutomationEngine(resolveTenantId(req));
      const results = await (engine as any).activatePendingPins?.() || { activated: 0, failed: 0, skipped: 0 };

      res.json({
        success: true,
        message: `PIN activation complete: ${results.activated} activated, ${results.failed} failed, ${results.skipped} skipped`,
        ...results
      });
    } catch (error) {
      console.error("Error activating pending PINs:", error);
      const errorMsg = error instanceof Error ? error.message : "Failed to activate pending PINs";
      res.status(500).json({ error: errorMsg });
    }
  });

  // Reconcile stale PIN dates - detect and fix PINs where TTLock validity doesn't match reservation
  app.post("/api/automation/reconcile-pin-dates", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const engine = ctx.getAutomationEngine(resolveTenantId(req));
      await engine.reconcileStalePinDates();
      res.json({ success: true, message: "Reconciliation complete" });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // TEST: Simulate PIN usage - triggers auto check-in flow
  app.post("/api/automation/simulate-pin-usage/:pinCode", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const pinCode = req.params.pinCode;

      // Find the PIN by code
      const allPins = await storage.getAllPins();
      const pin = allPins.find(p => p.code === pinCode && p.status === 'active');

      if (!pin) {
        return res.status(404).json({ error: `Active PIN ${pinCode} not found` });
      }

      if (!pin.reservationId) {
        return res.status(400).json({ error: "PIN has no linked reservation" });
      }

      const reservation = await storage.getReservation(pin.reservationId);
      if (!reservation) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      console.log(`[TEST] Simulating PIN ${pinCode} usage for ${reservation.firstName} ${reservation.lastName}`);

      // Set first_used_at to simulate lock usage
      const usedAt = new Date();
      await storage.updatePinFirstUsedAt(pin.id, usedAt);

      await storage.createLog({
        level: "info",
        message: `[TEST] PIN ${pinCode.substring(0, 2)}** simulated usage`,
        source: "ttlock",
        reservationId: pin.reservationId,
        roomId: pin.roomId,
        metadata: { pinId: pin.id, usedAt: usedAt.toISOString(), simulated: true },
      });

      // Trigger auto check-in in MEWS if configured
      let mewsCheckIn = { triggered: false, success: false, error: null as string | null };

      if (reservation.pmsId && ctx.isAutomationReady()) {
        const engine = ctx.getAutomationEngine(resolveTenantId(req));
        const mewsClient = engine.getMewsClient?.();
        if (mewsClient) {
          console.log(`[TEST] Triggering MEWS check-in for ${reservation.pmsId}`);
          try {
            const result = await mewsClient.startReservation(reservation.pmsId);
            mewsCheckIn = { triggered: true, success: result.success, error: result.error || null };
          } catch (err) {
            mewsCheckIn = { triggered: true, success: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
      }

      // Update reservation status to checked-in
      await storage.updateReservation(reservation.id, {
        status: "checked-in",
        pmsCheckinSource: "lock",
      });

      await storage.createLog({
        level: "info",
        message: `[TEST] Guest auto checked-in via simulated lock usage`,
        source: "automation",
        reservationId: reservation.id,
        metadata: { pinId: pin.id, checkInMethod: "lock", simulated: true },
      });

      res.json({
        success: true,
        message: `PIN ${pinCode} usage simulated - guest ${reservation.firstName} ${reservation.lastName} checked in`,
        pin: {
          id: pin.id,
          code: pinCode,
          firstUsedAt: usedAt.toISOString(),
        },
        reservation: {
          id: reservation.id,
          name: `${reservation.firstName} ${reservation.lastName}`,
          status: "checked-in",
        },
        mewsCheckIn,
      });
    } catch (error) {
      console.error("Error simulating PIN usage:", error);
      const errorMsg = error instanceof Error ? error.message : "Failed to simulate PIN usage";
      res.status(500).json({ error: errorMsg });
    }
  });

  // ==============================
  // TTLock Passcode Management
  // ==============================

  app.get("/api/ttlock/passcodes/:lockId", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const clientId = process.env.TTLOCK_CLIENT_ID;
      const accessTokenSetting = await storage.getSetting("ttlock_access_token");
      const regionSetting = await storage.getSetting("ttlock_region");

      if (!clientId) {
        return res.status(503).json({ error: "TTLock integration not configured. Please contact support." });
      }
      if (!accessTokenSetting) {
        return res.status(400).json({ error: "TTLock not connected. Please connect in Settings." });
      }

      const { TTLockClient } = await import("../ttlock-client");
      const region = regionSetting?.value === "cn" ? "cn" : "eu";
      const ttlockClient = new TTLockClient(
        clientId,
        accessTokenSetting.value,
        region
      );

      const passcodes = await ttlockClient.listPasscodes(req.params.lockId);
      res.json({ passcodes, count: passcodes.length });
    } catch (error) {
      console.error("Error fetching TTLock passcodes:", error);
      res.status(500).json({ error: "Failed to fetch passcodes from TTLock" });
    }
  });

  app.delete("/api/ttlock/passcodes/:lockId", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      // Use the automation engine's TTLock client (owner account with auto-refresh).
      // PINs are created by the owner client, so deletion must also use the owner client.
      const ttlockClient = ctx.getAutomationEngine(resolveTenantId(req)).getTTLockClient();
      if (!ttlockClient) {
        return res.status(503).json({ error: "TTLock integration not configured." });
      }
      const storage = getTenantStorage(req);

      const passcodes = await ttlockClient.listPasscodes(req.params.lockId);

      const exclude = req.query.exclude as string | undefined;
      const excludeCodes = exclude ? exclude.split(',').map(c => c.trim()) : [];
      const onlyCode = req.query.code as string | undefined; // if set, only delete this specific code
      // deleteType: 2 = cloud + lock (default), 1 = cloud only (use if lock rejects type 2)
      const deleteType = req.query.deleteType === "1" ? 1 : 2;

      let deleted = 0;
      let failed = 0;
      let skipped = 0;

      for (const passcode of passcodes) {
        if (onlyCode && passcode.code !== onlyCode) {
          skipped++;
          continue;
        }
        if (excludeCodes.includes(passcode.code)) {
          skipped++;
          continue;
        }

        try {
          await ttlockClient.deletePasscode(req.params.lockId, passcode.id, deleteType);
          deleted++;

          await storage.createLog({
            level: "info",
            message: `Deleted passcode ${passcode.code} from TTLock`,
            source: "automation",
            metadata: {
              lockId: req.params.lockId,
              passcode: passcode.code,
              name: passcode.name,
              ttlockKeyId: passcode.id,
            },
          });
        } catch (error) {
          failed++;
          const errorMessage = error instanceof Error ? error.message : String(error);
          await storage.createLog({
            level: "error",
            message: `Failed to delete passcode ${passcode.code}: ${errorMessage}`,
            source: "automation",
            metadata: {
              lockId: req.params.lockId,
              passcode: passcode.code,
              error: errorMessage,
            },
          });
        }
      }

      res.json({
        success: true,
        total: passcodes.length,
        deleted,
        failed,
        skipped
      });
    } catch (error) {
      console.error("Error deleting TTLock passcodes:", error);
      res.status(500).json({ error: "Failed to delete passcodes from TTLock" });
    }
  });

  // ==============================
  // Automation - Cleanup
  // ==============================

  app.post("/api/automation/cleanup-expired", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      if (!ctx.isAutomationReady()) {
        return res.status(503).json({ error: "Automation engine not ready" });
      }
      const engine = ctx.getAutomationEngine(resolveTenantId(req));
      const result = await engine.cleanupExpiredPasscodes();
      res.json({ success: true, ...result });
    } catch (error) {
      console.error("Error cleaning up expired passcodes:", error);
      const errorMsg = error instanceof Error ? error.message : "Failed to cleanup expired passcodes";
      res.status(500).json({ error: errorMsg });
    }
  });

  app.post("/api/automation/cleanup-orphaned", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      if (!ctx.isAutomationReady()) {
        return res.status(503).json({ error: "Automation engine not ready" });
      }
      const engine = ctx.getAutomationEngine(resolveTenantId(req));
      const result = await engine.cleanupOrphanedPasscodes();
      res.json({ success: true, ...result });
    } catch (error) {
      console.error("Error cleaning up orphaned passcodes:", error);
      const errorMsg = error instanceof Error ? error.message : "Failed to cleanup orphaned passcodes";
      res.status(500).json({ error: errorMsg });
    }
  });

  // One-shot recovery of pins the old orphan cleanup wrongly marked "deleted".
  // Run with ?dryRun=1 first to see what WOULD be recovered, then without to
  // execute. Idempotent; capped per run — repeat until remaining is 0.
  app.post("/api/automation/recover-deleted-pins", async (req, res) => {
    const session = await verifyHotelToken(req);
    if (!session) return res.status(401).json({ error: "Unauthorized" });
    try {
      if (!ctx.isAutomationReady()) {
        return res.status(503).json({ error: "Automation engine not ready" });
      }
      // Strict dryRun parsing: an unrecognized value (typo like ?dryRun=ture)
      // must never silently fall through to a LIVE run.
      const rawDryRun = req.query.dryRun;
      let dryRun = false;
      if (rawDryRun !== undefined) {
        if (rawDryRun === "1" || rawDryRun === "true") dryRun = true;
        else if (rawDryRun === "0" || rawDryRun === "false") dryRun = false;
        else return res.status(400).json({ error: `Unrecognized dryRun value "${rawDryRun}" — use dryRun=1 or dryRun=0.` });
      }
      // Recovery reactivates codes — bind it to the SESSION's tenant, never a
      // client-supplied header.
      const engine = ctx.getAutomationEngine(session.tenantId);
      const result = await engine.recoverWronglyDeletedPins(dryRun);
      res.json({ success: true, ...result });
    } catch (error) {
      console.error("Error recovering deleted pins:", error);
      const errorMsg = error instanceof Error ? error.message : "Failed to recover deleted pins";
      res.status(500).json({ error: errorMsg });
    }
  });

  // ==============================
  // Statistics
  // ==============================

  app.get("/api/statistics/overview", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const allReservations = await storage.getAllReservations();
      const allRooms = await storage.getAllRooms();
      const allPins = await storage.getAllPins();
      const allLocks = await storage.getAllLockDevices();

      const activeReservations = allReservations.filter(r =>
        r.status === 'Confirmed' || r.status === 'Checked-in'
      );

      const activePins = allPins.filter(p => p.status === 'active');

      res.json({
        totalReservations: allReservations.length,
        activeReservations: activeReservations.length,
        totalRooms: allRooms.length,
        totalLocks: allLocks.length,
        totalPins: allPins.length,
        activePins: activePins.length,
      });
    } catch (error) {
      console.error("Error fetching statistics:", error);
      res.status(500).json({ error: "Failed to fetch statistics" });
    }
  });

}
