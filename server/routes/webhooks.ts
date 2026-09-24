import type { Express } from "express";
import type { RouteContext } from "./index";
import { getTenantStorage, webhookLimiter, resolveTenantId } from "./middleware";
import { MewsClient } from "../mews-client";
import { Storage, getLockDevicesByTTLockIdUnscoped } from "../storage";
import type { WebhookUnlockRecord } from "../reservation-state-machine";

// TTLock pushes form-encoded fields; `records` is a JSON string. The push
// format is undocumented, so every field is parsed defensively — a malformed
// payload must never throw past the ACK. Exported for tests.
export function normalizeTtlockRecords(raw: unknown): WebhookUnlockRecord[] {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const arr = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
  return arr
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map(r => ({
      recordType: toFiniteNumber(r.recordType),
      success: toFiniteNumber(r.success),
      keyboardPwd: typeof r.keyboardPwd === "string" && r.keyboardPwd ? r.keyboardPwd : undefined,
      lockDate: toFiniteNumber(r.lockDate),
    }));
}

function toFiniteNumber(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Processes a TTLock callback after the response has been ACKed.
 * Resolves the owning tenant(s) from the pushed lockId, gates per tenant on
 * lock_arrival_webhook_enabled, and hands matching records to the tenant's
 * state machine (same pipeline as the hourly poller, which keeps running
 * unchanged as the safety net).
 */
async function processTtlockCallback(body: Record<string, unknown>, ctx: RouteContext): Promise<void> {
  const lockId = body.lockId != null ? String(body.lockId) : "";
  if (!lockId) return;

  const records = normalizeTtlockRecords(body.records);

  const devices = await getLockDevicesByTTLockIdUnscoped(lockId);
  if (devices.length === 0) {
    // Foreign lock on the shared TTLock OAuth app — nothing to do.
    console.log(`[TTLockWebhook] Ignoring unknown lockId ${lockId} (notifyType=${body.notifyType ?? "?"})`);
    return;
  }

  for (const device of devices) {
    try {
      const storage = Storage.forTenant(device.tenantId);
      if ((await storage.getSetting("lock_arrival_webhook_enabled"))?.value !== "true") continue;

      // Learning phase: persist the raw payload until the format is confirmed.
      if ((await storage.getSetting("lock_arrival_webhook_log_raw"))?.value !== "false") {
        await storage.createLog({
          level: "info",
          message: `TTLock webhook raw payload for ${device.name}`,
          source: "state-machine",
          metadata: { via: "webhook", raw: JSON.stringify(body).slice(0, 4000) },
        });
      }

      const stateMachine = ctx.getStateMachine(device.tenantId);
      if (!stateMachine) {
        // Boot window — the hourly poller will pick the event up instead.
        console.log(`[TTLockWebhook] State machine not ready for tenant ${device.tenantId}; dropping event for ${device.name}`);
        continue;
      }
      if (records.length > 0) {
        await stateMachine.handleLockUnlockRecords(device, records);
      }
    } catch (err) {
      console.error(`[TTLockWebhook] Processing failed for tenant ${device.tenantId}:`, err);
    }
  }
}

export function registerWebhookRoutes(app: Express, ctx: RouteContext) {
  // TTLock realtime callback — the TTLock cloud POSTs unlock events here
  // (Callback URL configured on the shared OAuth application). TTLock never
  // retries and doesn't sign payloads, so: ACK 200 immediately, then process
  // fire-and-forget; validation is the lockId→lock_devices lookup plus the
  // strict PIN/validity/status matching in the state machine.
  app.post("/api/webhooks/ttlock", webhookLimiter, (req, res) => {
    res.status(200).send("ok");
    console.log(`[TTLockWebhook] Received: lockId=${req.body?.lockId ?? "?"} notifyType=${req.body?.notifyType ?? "?"}`);
    processTtlockCallback(req.body ?? {}, ctx).catch(err =>
      console.error("[TTLockWebhook] Unhandled processing error:", err)
    );
  });

  // Twilio delivery status callback
  app.post("/api/webhooks/twilio-status", async (req, res) => {
    try {
      const { MessageSid, MessageStatus, To, ErrorCode, ErrorMessage } = req.body;
      const storage = getTenantStorage(req);

      const level = ["failed", "undelivered"].includes(MessageStatus) ? "warn" : "info";
      await storage.createLog({
        level,
        source: "automation",
        message: `Twilio delivery status: ${MessageStatus} → ${To}${ErrorCode ? ` (${ErrorCode}: ${ErrorMessage})` : ""}`,
        metadata: { messageSid: MessageSid, status: MessageStatus, to: To, errorCode: ErrorCode },
      });

      res.sendStatus(204);
    } catch (error) {
      console.error("[Twilio] Status callback error:", error);
      res.sendStatus(204);
    }
  });

  // MEWS Webhook
  app.post("/api/webhooks/mews", webhookLimiter, async (req, res) => {
    try {
      const storage = getTenantStorage(req);
      const { Events, EnterpriseId, IntegrationId } = req.body;

      if (!Events || !Array.isArray(Events)) {
        return res.status(400).json({ error: "Invalid webhook payload" });
      }

      console.log(`Received MEWS webhook with ${Events.length} events`);

      const serviceOrderEvents = Events.filter(
        (event: any) => event.Discriminator === "ServiceOrderUpdated"
      );

      if (serviceOrderEvents.length === 0) {
        return res.status(200).json({ message: "No reservation events to process" });
      }

      const reservationIds = serviceOrderEvents.map((event: any) => event.Value.Id);
      const uniqueReservationIds = Array.from(new Set(reservationIds));

      console.log(`Processing ${uniqueReservationIds.length} unique reservation(s)`);

      const mewsEnvironment = await storage.getSetting("mews_environment");
      const mewsClientToken = await storage.getSetting("mews_client_token");
      const mewsAccessToken = await storage.getSetting("mews_access_token");

      if (!mewsClientToken || !mewsAccessToken) {
        console.error("MEWS credentials not configured");
        return res.status(500).json({ error: "MEWS credentials not configured" });
      }

      const mewsClient = new MewsClient(
        mewsClientToken.value,
        mewsAccessToken.value,
        (mewsEnvironment?.value as "demo" | "production") || "demo"
      );

      const mewsReservations = await mewsClient.getReservations(uniqueReservationIds);

      const allResourceIds = mewsReservations
        .map(r => r.AssignedResourceId)
        .filter((id): id is string => !!id);
      const uniqueResourceIds = Array.from(new Set(allResourceIds));

      const allCustomerIds = mewsReservations
        .map(r => r.CustomerId)
        .filter((id): id is string => !!id);
      const uniqueCustomerIds = Array.from(new Set(allCustomerIds));

      const resourcesMap = new Map();
      if (uniqueResourceIds.length > 0) {
        const resources = await mewsClient.getResources(uniqueResourceIds);
        resources.forEach(r => resourcesMap.set(r.Id, r));
      }

      const customersMap = new Map();
      if (uniqueCustomerIds.length > 0) {
        const customers = await mewsClient.getCustomers(uniqueCustomerIds);
        customers.forEach(c => customersMap.set(c.Id, c));
      }

      for (const mewsRes of mewsReservations) {
        // Ingestion guard (was missing here — mews-poller/ingestion have it):
        // MEWS reservations created by OUR hourly bookings are bookkeeping
        // rows and must never be imported as guest reservations (second PIN +
        // door-code messages for the same stay).
        try {
          if (await storage.getHourlyBookingByMewsReservationId(mewsRes.Id)) {
            await storage.createLog({
              level: "info",
              source: "mews_webhook",
              message: `Skipping hourly-booking MEWS reservation ${mewsRes.Id} (ingestion guard)`,
            });
            continue;
          }
        } catch { /* the guard must never break the webhook */ }
        const existingReservation = await storage.getReservationByPmsId(mewsRes.Id);

        let roomName = "";
        let mappedRoom = null;
        let hasLockAssignments = false;

        if (mewsRes.AssignedResourceId) {
          if (resourcesMap.has(mewsRes.AssignedResourceId)) {
            roomName = resourcesMap.get(mewsRes.AssignedResourceId).Name;
          }

          mappedRoom = await storage.getRoomByPmsId(mewsRes.AssignedResourceId);

          if (!mappedRoom) {
            console.warn(`MEWS resource ${mewsRes.AssignedResourceId} (${roomName}) not mapped to any room`);
          } else {
            hasLockAssignments = await storage.isRoomMapped(mappedRoom.id);
            if (!hasLockAssignments) {
              console.log(`Room ${mappedRoom.name} has no room-type lock, skipping PIN generation`);
            }
          }
        }

        const customer = customersMap.get(mewsRes.CustomerId);
        const firstName = customer?.FirstName || "Guest";
        const lastName = customer?.LastName || "(No surname)";
        const email = customer?.Email || "";
        const mobile = customer?.Phone || "";

        const statusMapping: Record<string, string> = {
          Canceled: "Canceled",
          Confirmed: "Confirmed",
          Started: "Checked-in",
          Processed: "Checked-out",
        };
        const status = statusMapping[mewsRes.State] || "Confirmed";

        const reservationData = {
          pmsId: mewsRes.Id,
          extId: mewsRes.AssignedResourceId || undefined,
          roomId: mappedRoom?.id || undefined,
          firstName,
          lastName,
          email: email || undefined,
          mobile: mobile || undefined,
          arrival: new Date(mewsRes.StartUtc),
          departure: new Date(mewsRes.EndUtc),
          adults: mewsRes.AdultCount || 1,
          children: mewsRes.ChildCount || 0,
          status,
          room: roomName || undefined,
          confirmationCode: mewsRes.Number || undefined,
        };

        const newRoomId = mappedRoom?.id ?? null;
        const pinLifecycle = ctx.getAutomationEngine(resolveTenantId(req)).getPinLifecycle();

        // Detect room change at PMS level
        const oldRoom = existingReservation?.roomId
          ? await storage.getRoom(existingReservation.roomId)
          : null;
        const oldRoomPmsId = oldRoom?.pmsId || null;
        const newRoomPmsId = mewsRes.AssignedResourceId || null;

        const roomChanged =
          !!(existingReservation &&
          oldRoomPmsId !== newRoomPmsId &&
          status !== "Canceled" &&
          status !== "Checked-out");

        // Unmapped → mapped: reservation existed with no local room, now has one
        const unmappedToMapped =
          !!(existingReservation &&
          !existingReservation.roomId &&
          newRoomId &&
          status !== "Canceled" &&
          status !== "Checked-out");

        const timesChanged =
          existingReservation &&
          existingReservation.generatedPin &&
          (new Date(existingReservation.arrival).getTime() !== reservationData.arrival.getTime() ||
            new Date(existingReservation.departure).getTime() !== reservationData.departure.getTime());

        let savedReservation;
        if (existingReservation) {
          savedReservation = await storage.updateReservation(existingReservation.id, reservationData);
        } else {
          savedReservation = await storage.createReservation(reservationData);
        }

        await storage.createLog({
          level: "info",
          source: "mews_webhook",
          message: `Reservation ${status} - ${firstName} ${lastName}`,
          metadata: {
            pmsId: mewsRes.Id,
            status,
            room: roomName,
            mappedRoomId: mappedRoom?.id,
            hasLockAssignments,
          },
        });

        if (!savedReservation) continue;

        // New reservation in mapped room → create pending PIN
        if (!existingReservation && newRoomId && status !== "Canceled") {
          await pinLifecycle.onReservationCreated(savedReservation);
        }

        // Room changed → migrate PIN to new room
        if (roomChanged && existingReservation!.roomId) {
          await storage.createLog({
            level: "info",
            source: "mews_webhook",
            message: `Room change: pmsRoomId ${oldRoomPmsId} → ${newRoomPmsId}`,
            metadata: { reservationId: savedReservation.id },
          });
          await pinLifecycle.onRoomChanged(
            savedReservation,
            existingReservation!.roomId!,
            newRoomId
          );
        }

        // Unmapped → mapped: treat like fresh creation
        if (unmappedToMapped) {
          await pinLifecycle.onReservationCreated(savedReservation);
        }

        // Dates changed (skip if room also changed — room change creates fresh PIN)
        if (timesChanged && !roomChanged && !unmappedToMapped) {
          const arrivalChanged =
            new Date(existingReservation!.arrival).getTime() !== reservationData.arrival.getTime();
          if (arrivalChanged) {
            await pinLifecycle.onArrivalDateChanged(savedReservation, new Date(existingReservation!.arrival));
          } else {
            await pinLifecycle.onDepartureDateChanged(savedReservation);
          }
        }

        // Status-based actions
        if (status === "Checked-in") {
          const checkInMethodSetting = await storage.getSetting("check_in_method");
          const checkInMethod = checkInMethodSetting?.value || "door_unlock";
          if (checkInMethod === "physical_required" && savedReservation.generatedPin) {
            await pinLifecycle.activatePendingForReservation(savedReservation.id);
          }
        } else if (status === "Canceled" || status === "Checked-out") {
          await pinLifecycle.onCancelled(savedReservation);
        }
      }

      res.status(200).json({ message: `Processed ${mewsReservations.length} reservations` });
    } catch (error) {
      console.error("Error processing MEWS webhook:", error);
      res.status(500).json({ error: "Failed to process webhook" });
    }
  });
}
