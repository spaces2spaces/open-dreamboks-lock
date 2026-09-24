import type { Express } from "express";
import type { RouteContext } from "./index";
import { resolveTenantIdAsync, resolveTenantId, webhookLimiter, verifyHotelToken } from "./middleware";
import { Storage, DEFAULT_TENANT_ID } from "../storage";
import type { ITenantStorage } from "../storage";
import type { AutomationEngine } from "../automation";
import { MewsClient } from "../mews-client";
import { getTenantStorage } from "./middleware";
import { createIngestionProcessor } from "../ingestion-processor";
import {
  IngestionBatchSchema,
  checkIdempotency,
  storeIdempotencyResult,
  mapNormalizedStatusToInternal,
  verifyHmacSignature,
  type IngestionEvent,
  type ReservationUpsertedEvent,
  type ReservationStatusChangedEvent,
  type RoomSyncEvent,
} from "../ingestion";

export function registerIngestionRoutes(app: Express, ctx: RouteContext) {

  // ===========================================
  // Test MEWS Reservations
  // ===========================================

  app.get("/api/test/mews-reservations", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
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

      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const tomorrowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);

      const mewsData = await mewsClient.getReservationsByTimeFilter(
        todayStart.toISOString(),
        tomorrowStart.toISOString()
      );

      const reservations = mewsData.Reservations || [];

      const customerIds = Array.from(new Set(reservations.map((r) => r.CustomerId)));
      const customers = customerIds.length > 0 ? await mewsClient.getCustomers(customerIds) : [];
      const customerMap = new Map(customers.map((c) => [c.Id, c]));

      const enrichedReservations = reservations.map((r) => {
        const customer = customerMap.get(r.CustomerId);
        const group = mewsData.ReservationGroups?.find(g => g.Id === r.GroupId);
        const category = mewsData.ResourceCategories?.find(rc => rc.Id === r.RequestedResourceCategoryId);
        const rate = mewsData.Rates?.find(rt => rt.Id === r.RateId);

        return {
          id: r.Id,
          state: r.State,
          startUtc: r.StartUtc,
          endUtc: r.EndUtc,
          scheduledStartUtc: r.ScheduledStartUtc,
          scheduledEndUtc: r.ScheduledEndUtc,
          assignedResourceId: r.AssignedResourceId,
          number: r.Number,
          adultCount: r.AdultCount,
          childCount: r.ChildCount,
          groupId: r.GroupId,
          groupName: group?.Name,
          requestedCategoryId: r.RequestedResourceCategoryId,
          requestedCategory: category?.Name,
          rateId: r.RateId,
          rateName: rate?.Name,
          origin: r.Origin,
          originDetails: r.OriginDetails,
          channelNumber: r.ChannelNumber,
          customer: customer ? {
            id: customer.Id,
            firstName: customer.FirstName,
            lastName: customer.LastName,
            email: customer.Email,
            phone: customer.Phone,
          } : null,
        };
      });

      res.json({
        timeRange: {
          start: todayStart.toISOString(),
          end: tomorrowStart.toISOString(),
        },
        count: enrichedReservations.length,
        reservations: enrichedReservations,
      });
    } catch (error) {
      console.error("Error testing MEWS:", error);
      res.status(500).json({
        error: "Failed to fetch MEWS reservations",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // ===========================================
  // PMS Adapter Ingestion Endpoints
  // ===========================================

  async function getIngestionSecret(tenantId: string): Promise<string | null> {
    const tenantStorage = Storage.forTenant(tenantId);
    const secret = await tenantStorage.getSetting("ingestion_webhook_secret");
    return secret?.value || null;
  }

  app.post("/api/ingest", webhookLimiter, async (req, res) => {
    try {
      const parseResult = IngestionBatchSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: "Invalid request body",
          details: parseResult.error.flatten()
        });
      }

      const batch = parseResult.data;

      if (batch.events.length === 0) {
        return res.status(400).json({ error: "No events in batch" });
      }

      const tenantId = batch.events[0].tenantId;
      const allSameTenant = batch.events.every(e => e.tenantId === tenantId);
      if (!allSameTenant) {
        return res.status(400).json({
          error: "All events in batch must belong to the same tenant",
          hint: "Split events by tenantId into separate batches"
        });
      }

      const ingestionSecret = await getIngestionSecret(tenantId);
      if (!ingestionSecret) {
        return res.status(401).json({
          error: "Ingestion not configured for this tenant",
          hint: "Set 'ingestion_webhook_secret' in tenant settings to enable ingestion"
        });
      }

      const signature = req.headers["x-dreamboks-signature"] as string | undefined;
      const timestamp = req.headers["x-dreamboks-timestamp"] as string | undefined;

      if (!signature || !timestamp) {
        return res.status(401).json({
          error: "Missing signature headers",
          required: ["x-dreamboks-signature", "x-dreamboks-timestamp"]
        });
      }

      const timestampMs = parseInt(timestamp, 10);
      if (isNaN(timestampMs)) {
        return res.status(401).json({ error: "Invalid timestamp format" });
      }

      const MAX_DRIFT_MS = 5 * 60 * 1000;
      if (Math.abs(Date.now() - timestampMs) > MAX_DRIFT_MS) {
        return res.status(401).json({
          error: "Timestamp too old or in future",
          maxDriftSeconds: MAX_DRIFT_MS / 1000
        });
      }

      const rawBody = (req as any).rawBody as Buffer;
      if (!rawBody) {
        return res.status(500).json({ error: "Raw body not captured - server misconfigured" });
      }
      const isValid = verifyHmacSignature(rawBody.toString('utf8'), signature, timestamp, ingestionSecret);

      if (!isValid) {
        return res.status(401).json({ error: "Invalid signature" });
      }

      const idempotencyCheck = checkIdempotency(batch.idempotencyKey);
      if (idempotencyCheck.isDuplicate) {
        return res.status(200).json({
          success: true,
          message: "Duplicate request - already processed",
          cached: true,
          result: idempotencyCheck.cachedResult
        });
      }

      const storage = Storage.forTenant(tenantId);
      const automation = ctx.getAutomationEngine(resolveTenantId(req));
      const processor = createIngestionProcessor(automation);

      const results: { eventId: string; eventType: string; success: boolean; error?: string }[] = [];

      for (const event of batch.events) {
        try {
          await processor.processEvent(event);
          results.push({ eventId: event.eventId, eventType: event.eventType, success: true });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          results.push({ eventId: event.eventId, eventType: event.eventType, success: false, error: errorMessage });
          console.error(`[Ingestion] Failed to process event ${event.eventId}:`, error);
        }
      }

      const response = {
        success: results.every(r => r.success),
        processed: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results
      };

      storeIdempotencyResult(batch.idempotencyKey, response);

      res.json(response);
    } catch (error) {
      console.error("[Ingestion] Error processing batch:", error);
      res.status(500).json({
        error: "Failed to process ingestion batch",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  async function processIngestionEvent(
    event: IngestionEvent,
    storage: ITenantStorage,
    automation: AutomationEngine
  ): Promise<void> {
    switch (event.eventType) {
      case "reservation.upserted":
        await processReservationUpserted(event, storage, automation);
        break;
      case "reservation.status_changed":
        await processReservationStatusChanged(event, storage, automation);
        break;
      case "room.sync":
        await processRoomSync(event, storage);
        break;
      default:
        throw new Error(`Unknown event type: ${(event as any).eventType}`);
    }
  }

  async function processReservationUpserted(
    event: ReservationUpsertedEvent,
    storage: ITenantStorage,
    automation: AutomationEngine
  ): Promise<void> {
    const { data } = event;

    // HOURLY-BOOKING GUARD: reservations created by our own hourly-booking
    // flow are managed there — never ingest them as guest reservations
    // (would mint a second pin + door-code messages). Mirrors the guard in
    // IngestionProcessor.processReservationUpserted.
    if (await storage.getHourlyBookingByMewsReservationId(data.pmsReservationId)) {
      return;
    }

    const existingReservation = await storage.getReservationByPmsId(data.pmsReservationId);

    let mappedRoom = null;
    if (data.roomPmsId) {
      mappedRoom = await storage.getRoomByPmsId(data.roomPmsId);
    }

    const reservationData = {
      pmsId: data.pmsReservationId,
      extId: data.confirmationNumber || undefined,
      firstName: data.guest.firstName,
      lastName: data.guest.lastName,
      email: data.guest.email || undefined,
      mobile: data.guest.mobile || undefined,
      arrival: new Date(data.arrival),
      departure: new Date(data.departure),
      status: mapNormalizedStatusToInternal(data.status),
      roomId: mappedRoom?.id || undefined,
      room: data.roomName || undefined,
      bed: data.bedName || undefined,
      adults: data.adults,
      children: data.children,
      groupName: data.groupName || undefined,
      requestedCategory: data.requestedCategory || undefined,
      spaceCategory: data.spaceCategory || undefined,
      rateName: data.rateName || undefined,
      avgRate: data.avgRate || undefined,
      totalAmount: data.totalAmount || undefined,
      currency: data.currency || undefined,
      owing: data.owing || undefined,
      origin: data.origin || undefined,
      reservationSource: data.reservationSource || undefined,
    };

    let savedReservation;
    if (existingReservation) {
      savedReservation = await storage.updateReservation(existingReservation.id, reservationData);
    } else {
      savedReservation = await storage.createReservation(reservationData);
    }

    await storage.createLog({
      level: "info",
      source: "ingestion",
      message: existingReservation
        ? `Updated reservation ${data.pmsReservationId} via ingestion`
        : `Created reservation ${data.pmsReservationId} via ingestion`,
      metadata: {
        eventId: event.eventId,
        pmsType: event.pmsType,
        reservationId: savedReservation?.id,
        status: data.status,
      },
    });

    if (savedReservation) {
      const internalStatus = mapNormalizedStatusToInternal(data.status);
      if (internalStatus === "Confirmed") {
        // Route through PinLifecycleService so PIN creation and MEWS sync are
        // handled in one place. onReservationCreated is idempotent and will
        // also retroactively sync to MEWS if the PIN exists but was never synced.
        try {
          await automation.getPinLifecycle().onReservationCreated(savedReservation);
        } catch (error) {
          await storage.createLog({
            level: "error",
            source: "ingestion",
            message: `Failed to create passcode for reservation ${data.pmsReservationId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            reservationId: savedReservation.id,
            metadata: {
              eventId: event.eventId,
              guestName: `${data.guest.firstName} ${data.guest.lastName}`,
              roomName: data.roomName,
            },
          });
        }
      } else if (internalStatus === "Checked-in" && savedReservation.generatedPin) {
        // Guest checked in — activate pending PIN
        const pinLifecycle = automation.getPinLifecycle();
        const activationResult = await pinLifecycle.activatePendingForReservation(savedReservation.id);
        if (!activationResult.success && !activationResult.alreadyActive) {
          await storage.createLog({
            level: "error",
            source: "ingestion",
            message: `Failed to activate PIN for checked-in reservation ${data.pmsReservationId}: ${activationResult.error}`,
            reservationId: savedReservation.id,
            metadata: {
              eventId: event.eventId,
              guestName: `${data.guest.firstName} ${data.guest.lastName}`,
              error: activationResult.error,
            },
          });
        }
      } else if (internalStatus === "Cancelled" || internalStatus === "Checked-out") {
        await automation.getPinLifecycle().onCancelled(savedReservation);
      }
    }
  }

  async function processReservationStatusChanged(
    event: ReservationStatusChangedEvent,
    storage: ITenantStorage,
    automation: AutomationEngine
  ): Promise<void> {
    const { data } = event;

    const reservation = await storage.getReservationByPmsId(data.pmsReservationId);
    if (!reservation) {
      throw new Error(`Reservation not found: ${data.pmsReservationId}`);
    }

    const newInternalStatus = mapNormalizedStatusToInternal(data.newStatus);
    await storage.updateReservation(reservation.id, { status: newInternalStatus });

    await storage.createLog({
      level: "info",
      source: "ingestion",
      message: `Status changed for reservation ${data.pmsReservationId}: ${data.previousStatus || 'unknown'} -> ${data.newStatus}`,
      metadata: {
        eventId: event.eventId,
        pmsType: event.pmsType,
        reservationId: reservation.id,
        previousStatus: data.previousStatus,
        newStatus: data.newStatus,
      },
    });

    const pinLifecycle = automation.getPinLifecycle();

    if (newInternalStatus === "Confirmed" && !reservation.generatedPin) {
      try {
        await pinLifecycle.onReservationCreated(reservation);
      } catch (error) {
        await storage.createLog({
          level: "error",
          source: "ingestion",
          message: `Failed to create PIN on status change: ${error instanceof Error ? error.message : String(error)}`,
          reservationId: reservation.id,
          metadata: {
            eventId: event.eventId,
            pmsReservationId: data.pmsReservationId,
            newStatus: data.newStatus,
          },
        });
      }
    } else if (newInternalStatus === "Checked-in" && reservation.generatedPin) {
      const activationResult = await pinLifecycle.activatePendingForReservation(reservation.id);
      if (!activationResult.success && !activationResult.alreadyActive) {
        await storage.createLog({
          level: "error",
          source: "ingestion",
          message: `Failed to activate PIN on check-in: ${activationResult.error}`,
          reservationId: reservation.id,
          metadata: {
            eventId: event.eventId,
            pmsReservationId: data.pmsReservationId,
          },
        });
      }
    } else if (newInternalStatus === "Cancelled" || newInternalStatus === "Checked-out") {
      await pinLifecycle.onCancelled(reservation);
    }
  }

  async function processRoomSync(
    event: RoomSyncEvent,
    storage: ITenantStorage
  ): Promise<void> {
    const { data } = event;

    let created = 0;
    let updated = 0;

    for (const room of data.rooms) {
      const existingRoom = await storage.getRoomByPmsId(room.pmsRoomId);

      if (existingRoom) {
        await storage.updateRoom(existingRoom.id, {
          name: room.name,
          spaceCategory: room.category || undefined,
        });
        updated++;
      } else {
        await storage.createRoom({
          pmsId: room.pmsRoomId,
          name: room.name,
          type: "standard",
          spaceCategory: room.category || undefined,
        });
        created++;
      }
    }

    await storage.createLog({
      level: "info",
      source: "ingestion",
      message: `Room sync completed: ${created} created, ${updated} updated`,
      metadata: {
        eventId: event.eventId,
        pmsType: event.pmsType,
        totalRooms: data.rooms.length,
        created,
        updated,
      },
    });
  }
}
