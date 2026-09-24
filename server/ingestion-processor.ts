import { ITenantStorage, Storage } from "./storage";
import { AutomationEngine } from "./automation";
import { PinLifecycleService } from "./pin-lifecycle-service";
import { hasActiveLateCheckout, buildValidityWindow } from "./pin-validity-window";
import { NotificationClient } from "./notification-client";
import { format } from "date-fns";
import {
  mapNormalizedStatusToInternal,
  type ReservationUpsertedEvent,
  type ReservationStatusChangedEvent,
  type RoomSyncEvent,
  type IngestionEvent,
} from "./ingestion";

/**
 * Returns the names of fields that differ between an existing reservation row
 * and the incoming reservation data. Only fields the writer would actually
 * persist are considered: `undefined` values are skipped (updateReservation
 * ignores them), dates are compared by timestamp, and everything else by
 * value (null-normalized). An empty result means an update would be a pure
 * no-op, so the caller can safely skip both the DB write and the log entry.
 *
 * Conservative by design: if any persisted field differs in representation,
 * it counts as changed (we write). This avoids ever skipping a real update.
 */
export function changedReservationFields(
  existing: Record<string, unknown>,
  data: Record<string, unknown>
): string[] {
  const changed: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue; // updateReservation never writes undefined
    const current = existing[key];
    if (value instanceof Date) {
      const currentMs = current == null ? null : new Date(current as string | number | Date).getTime();
      if (currentMs !== value.getTime()) changed.push(key);
    } else {
      const cur = current ?? null;
      const val = (value as unknown) ?? null;
      if (cur !== val) changed.push(key);
    }
  }
  return changed;
}

export interface IIngestionProcessor {
  processEvent(event: IngestionEvent): Promise<void>;
  processReservationUpserted(event: ReservationUpsertedEvent): Promise<void>;
  processReservationStatusChanged(event: ReservationStatusChangedEvent): Promise<void>;
  processRoomSync(event: RoomSyncEvent): Promise<void>;
}

export class IngestionProcessor implements IIngestionProcessor {
  private notificationClient: NotificationClient;
  private pinLifecycle: PinLifecycleService;

  constructor(
    private getStorage: (tenantId: string) => ITenantStorage,
    private automationEngine: AutomationEngine
  ) {
    this.notificationClient = new NotificationClient({});
    this.pinLifecycle = automationEngine.getPinLifecycle();
  }

  async processEvent(event: IngestionEvent): Promise<void> {
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

  async processReservationUpserted(event: ReservationUpsertedEvent): Promise<void> {
    const storage = this.getStorage(event.tenantId);
    const { data } = event;

    // HOURLY-BOOKING GUARD: MEWS reservations CREATED BY our own hourly-booking
    // flow must never be ingested as regular guest reservations — that would
    // mint a second pin, send 15:00→10:00 door-code messages on top of the
    // hourly code, and self-block the capsule's remaining hourly slots.
    if (await storage.getHourlyBookingByMewsReservationId(data.pmsReservationId)) {
      return;
    }

    const departureDate = new Date(data.departure);
    const now = new Date();
    if (departureDate < now) {
      return;
    }

    // Skip Checked-out reservations — completed stays should not be imported.
    // Importing them causes a create→cleanup→re-import cycle every 30 minutes.
    if (data.status === "CheckedOut") {
      return;
    }
    
    const existingReservation = await storage.getReservationByPmsId(data.pmsReservationId);

    // Churn-breaker (26/7, Gogoua mail storm): never CREATE a reservation whose
    // pin validity window is already over — the raw-departure guard above can
    // pass (MEWS EndUtc later today) while the checkout-normalized window is
    // past, which loops create → pin refused → cleanup delete → re-create every
    // poll with a fresh id (and a fresh ops alert). Existing rows are exempt
    // (paid late checkout lives in OUR lateCheckoutUntil column — invisible to
    // this probe — and those updates must keep flowing).
    if (!existingReservation) {
      const probe = await buildValidityWindow(storage, {
        arrival: new Date(data.arrival),
        departure: new Date(data.departure),
        earlyCheckinFrom: null,
        lateCheckoutUntil: null,
      } as any);
      if (probe.validTo.getTime() <= Date.now()) {
        return;
      }
    }

    let mappedRoom = null;
    if (data.roomPmsId) {
      mappedRoom = await storage.getRoomByPmsId(data.roomPmsId);
    }
    
    const internalStatus = mapNormalizedStatusToInternal(data.status);
    const newRoomId = mappedRoom?.id ?? null;

    // Note: status downgrade guard (Cancelled/Checked-out → active) is enforced
    // in ReservationStateMachine.handleStatusChanged(), not here. The upserted
    // events in this pipeline carry full authoritative MEWS state (from MEWS
    // poller or DriftReconciler) and must be allowed through — including genuine
    // re-confirmations after a cancellation. The cancel loop bug was caused by
    // handleStatusChanged() lacking this guard, which is now fixed.

    // Detect room change at PMS level — compare old room's pmsId with new room's pmsId.
    // newRoomId is null if the new PMS room is not in our local DB (unmapped).
    // We still need to delete the old PIN in that case.
    const oldRoom = existingReservation?.roomId
      ? await storage.getRoom(existingReservation.roomId)
      : null;
    const oldRoomPmsId = oldRoom?.pmsId || null;
    const newRoomPmsId = data.roomPmsId || null;

    // Room change: detect when PMS room ID changes OR when room goes from unmapped to mapped.
    // oldRoomId may be null if the previous room was unmapped (not in local DB).
    const roomChanged =
      !!(existingReservation &&
      oldRoomPmsId !== newRoomPmsId &&
      internalStatus !== "Cancelled" &&
      internalStatus !== "CheckedOut");

    // Special case: reservation existed with null roomId (unmapped) and now has a mapped room.
    // This is NOT a room change (no old room to migrate from) — treat it like a new creation.
    const unmappedToMapped =
      !!(existingReservation &&
      !existingReservation.roomId &&
      newRoomId &&
      internalStatus !== "Cancelled" &&
      internalStatus !== "CheckedOut");

    const timesChanged =
      existingReservation &&
      existingReservation.generatedPin &&
      (new Date(existingReservation.arrival).getTime() !== new Date(data.arrival).getTime() ||
        new Date(existingReservation.departure).getTime() !== new Date(data.departure).getTime());

    const reservationData = {
      pmsId: data.pmsReservationId,
      extId: data.confirmationNumber || undefined,
      confirmationCode: data.confirmationNumber || undefined,
      channelNumber: data.channelNumber || undefined,
      channelManagerNumber: data.channelManagerNumber || undefined,
      firstName: data.guest.firstName,
      lastName: data.guest.lastName,
      email: data.guest.email || undefined,
      mobile: data.guest.mobile || undefined,
      arrival: new Date(data.arrival),
      departure: new Date(data.departure),
      status: internalStatus,
      roomId: newRoomId,
      room: data.roomName || mappedRoom?.name || undefined,
      assignedSpace: data.roomName || mappedRoom?.name || undefined,
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
      mewsCustomerId: data.pmsCustomerId || undefined,
    };

    let savedReservation;
    if (existingReservation) {
      // Diff before write: the MEWS poller re-upserts every reservation on each
      // sync cycle (~every 18s). Only write + log when a persisted field actually
      // changed — otherwise we needlessly rewrite unchanged rows and spam the log
      // (this was producing ~2M log rows/day for one tenant).
      const changedFields = changedReservationFields(
        existingReservation as unknown as Record<string, unknown>,
        reservationData as Record<string, unknown>
      );
      if (changedFields.length === 0) {
        // Nothing changed — skip the redundant update and log entirely.
        savedReservation = existingReservation;
      } else {
        savedReservation = await storage.updateReservation(existingReservation.id, reservationData);
        await storage.createLog({
          level: "info",
          source: "ingestion",
          message: `Updated reservation ${data.pmsReservationId} via processor`,
          metadata: {
            eventId: event.eventId,
            pmsType: event.pmsType,
            reservationId: savedReservation?.id,
            status: data.status,
            changedFields,
          },
        });
      }
    } else {
      savedReservation = await storage.createReservation(reservationData);
      await storage.createLog({
        level: "info",
        source: "ingestion",
        message: `Created reservation ${data.pmsReservationId} via processor`,
        metadata: {
          eventId: event.eventId,
          pmsType: event.pmsType,
          reservationId: savedReservation?.id,
          status: data.status,
        },
      });
    }

    if (savedReservation) {
      // New reservation in mapped room → create pending PIN + sync to MEWS (once)
      if (!existingReservation && newRoomId && internalStatus !== "Cancelled") {
        await this.pinLifecycle.onReservationCreated(savedReservation);
      }

      // Re-confirmation: reservation was Cancelled/Checked-out but MEWS now shows
      // an active status. This is a genuine un-cancel — create a new pending PIN.
      // The status downgrade guard on processReservationStatusChanged prevents
      // stale webhooks from triggering this; only authoritative upserted events
      // (from MEWS poller or DriftReconciler) reach here.
      if (
        existingReservation &&
        (existingReservation.status === "Cancelled" || existingReservation.status === "Checked-out") &&
        internalStatus !== "Cancelled" && internalStatus !== "Checked-out" &&
        newRoomId
      ) {
        await storage.createLog({
          level: "info",
          source: "ingestion",
          message: `Re-confirmation detected for ${data.pmsReservationId}: ${existingReservation.status} → ${internalStatus}. Creating new PIN.`,
          metadata: { reservationId: savedReservation.id },
        });
        await this.pinLifecycle.onReservationCreated(savedReservation);
      }

      // Retroactive MEWS sync: reservation already existed and has a generatedPin
      // but was never synced to MEWS (legacy rows, failed sync, stale writer).
      // Cheap no-op when mewsPinSyncedAt is already set.
      if (
        existingReservation &&
        savedReservation.generatedPin &&
        !savedReservation.mewsPinSyncedAt &&
        internalStatus !== "Cancelled"
      ) {
        await this.pinLifecycle.ensureMewsSynced(savedReservation);
      }

      // Room changed → migrate PIN to new room (newRoomId may be null if new room not in DB)
      if (roomChanged && existingReservation!.roomId) {
        await storage.createLog({
          level: "info",
          source: "ingestion",
          message: `Room change for ${data.pmsReservationId}: pmsRoomId ${oldRoomPmsId} → ${newRoomPmsId} (local roomId: ${existingReservation!.roomId} → ${newRoomId ?? "null"})`,
          metadata: { reservationId: savedReservation.id },
        });
        await this.pinLifecycle.onRoomChanged(
          savedReservation,
          existingReservation!.roomId!,
          newRoomId
        );
      }

      // Unmapped → mapped: reservation existed with no local room, now has one.
      // Treat like a fresh creation: create PIN + sync to MEWS + push to TTLock if active.
      if (unmappedToMapped) {
        await storage.createLog({
          level: "info",
          source: "ingestion",
          message: `Room now mapped for ${data.pmsReservationId}: unmapped → ${newRoomId} (pmsRoomId: ${newRoomPmsId})`,
          metadata: { reservationId: savedReservation.id },
        });
        await this.pinLifecycle.onReservationCreated(savedReservation);
      }

      // Dates changed → update PIN validity.
      // Room change takes priority: if room also changed, onRoomChanged already
      // creates a fresh pending PIN with correct validity — skip date handlers.
      if (timesChanged && (roomChanged || unmappedToMapped)) {
        await storage.createLog({
          level: "info",
          source: "ingestion",
          message: `Both room and dates changed for ${data.pmsReservationId} — date change skipped, room change takes priority`,
          metadata: { reservationId: savedReservation.id },
        });
      }
      if (timesChanged && !roomChanged && !unmappedToMapped &&
          internalStatus !== "Cancelled" && internalStatus !== "Checked-out") {
        const arrivalChanged =
          new Date(existingReservation!.arrival).getTime() !== new Date(data.arrival).getTime();
        if (arrivalChanged) {
          await this.pinLifecycle.onArrivalDateChanged(savedReservation, new Date(existingReservation!.arrival));
        } else {
          await this.pinLifecycle.onDepartureDateChanged(savedReservation);
        }
      }

      // Room lost its lock mapping: room exists but admin removed the lock.
      // MEWS still reports the same AssignedResourceId → roomChanged=false.
      // Only fire when there are actually live PINs to cancel — otherwise this
      // triggers on every poller cycle for all reservations on unmapped rooms
      // (226 in production → server crash from DB/TTLock API flooding).
      if (
        newRoomId &&
        !roomChanged &&
        !unmappedToMapped &&
        internalStatus !== "Cancelled" &&
        internalStatus !== "Checked-out" &&
        savedReservation.generatedPin
      ) {
        const roomStillMapped = await storage.isRoomMapped(newRoomId);
        if (!roomStillMapped) {
          const pinsForRes = await storage.getPinsByReservationId(savedReservation.id);
          const hasLivePin = pinsForRes.some((p: any) =>
            ["pending", "active", "used"].includes(p.status)
          );
          if (hasLivePin) {
            await storage.createLog({
              level: "info",
              source: "ingestion",
              message: `Room ${newRoomId} lost lock mapping — cancelling PIN for ${data.pmsReservationId}`,
              metadata: { reservationId: savedReservation.id },
            });
            await this.pinLifecycle.onCancelled(savedReservation);
          }
        }
      }

      // Room gained lock mapping: room exists, reservation assigned to it,
      // but no PIN was created because the room was unmapped at the time.
      // Admin added a lock → next poller upsert should create the PIN.
      if (
        existingReservation &&
        newRoomId &&
        !roomChanged &&
        !unmappedToMapped &&
        internalStatus !== "Cancelled" &&
        internalStatus !== "Checked-out" &&
        !savedReservation.generatedPin
      ) {
        const roomNowMapped = await storage.isRoomMapped(newRoomId);
        if (roomNowMapped) {
          await storage.createLog({
            level: "info",
            source: "ingestion",
            message: `Room ${newRoomId} gained lock mapping — creating PIN for ${data.pmsReservationId}`,
            metadata: { reservationId: savedReservation.id },
          });
          await this.pinLifecycle.onReservationCreated(savedReservation);
        }
      }

      // Room gained lock mapping after previous PIN was cancelled (lock removed then re-added).
      // generatedPin exists but all PINs are cancelled → re-create with same code.
      if (
        existingReservation &&
        newRoomId &&
        !roomChanged &&
        !unmappedToMapped &&
        internalStatus !== "Cancelled" &&
        internalStatus !== "Checked-out" &&
        savedReservation.generatedPin
      ) {
        const roomNowMapped = await storage.isRoomMapped(newRoomId);
        if (roomNowMapped) {
          const livePins = await storage.getPinsByReservationId(savedReservation.id);
          const hasLivePin = livePins.some((p: any) =>
            ["pending", "active", "used"].includes(p.status)
          );
          if (!hasLivePin) {
            await storage.createLog({
              level: "info",
              source: "ingestion",
              message: `Room ${newRoomId} re-gained lock mapping — recreating PIN for ${data.pmsReservationId}`,
              metadata: { reservationId: savedReservation.id },
            });
            await this.pinLifecycle.onReservationCreated(savedReservation);
          }
        }
      }

      // Checked-in: activate immediately for physical_required mode
      if (internalStatus === "Checked-in") {
        const checkInMethodSetting = await storage.getSetting("check_in_method");
        const checkInMethod = checkInMethodSetting?.value || "door_unlock";

        if (checkInMethod === "physical_required" && savedReservation.generatedPin) {
          const activationResult = await this.automationEngine.getPinLifecycle().activatePendingForReservation(
            savedReservation.id
          );

          if (activationResult.success || activationResult.alreadyActive) {
            if (!savedReservation.pmsCheckinSource) {
              await storage.updateReservation(savedReservation.id, { pmsCheckinSource: "mews" });
            }
            await storage.createLog({
              level: "info",
              source: "ingestion",
              message: `MEWS check-in detected - PIN activated for physical_required mode`,
              metadata: { reservationId: savedReservation.id },
            });
          } else {
            await storage.createLog({
              level: "error",
              source: "ingestion",
              message: `MEWS check-in detected but PIN activation failed: ${activationResult.error}`,
              metadata: { reservationId: savedReservation.id, error: activationResult.error },
            });
          }
        }
        // Note: Boarding pass email is sent during pre-check-in flow only
      } else if (internalStatus === "Cancelled" || internalStatus === "Checked-out") {
        if (internalStatus === "Checked-out" && hasActiveLateCheckout(savedReservation)) {
          // Paid late checkout: MEWS's ~11:00 bulk auto-checkout must not kill
          // the code the guest paid to keep. The poller's expiry cleanup
          // revokes it once lateCheckoutUntil has passed.
          await storage.createLog({
            level: "info",
            source: "ingestion",
            message: `Checked-out in MEWS but paid late checkout is active — PIN revocation deferred until ${new Date(savedReservation.lateCheckoutUntil!).toISOString()}`,
            metadata: { reservationId: savedReservation.id },
          });
        } else {
          await this.pinLifecycle.onCancelled(savedReservation);
        }
      }
    }
  }

  async processReservationStatusChanged(event: ReservationStatusChangedEvent): Promise<void> {
    const storage = this.getStorage(event.tenantId);
    const { data } = event;

    // HOURLY-BOOKING GUARD — see processReservationUpserted.
    if (await storage.getHourlyBookingByMewsReservationId(data.pmsReservationId)) {
      return;
    }

    const reservation = await storage.getReservationByPmsId(data.pmsReservationId);
    if (!reservation) {
      throw new Error(`Reservation not found: ${data.pmsReservationId}`);
    }

    const newInternalStatus = mapNormalizedStatusToInternal(data.newStatus);

    // Guard: never downgrade a terminal status via status_changed events.
    // These events come from webhooks and can be stale. The cancel loop bug
    // was caused by stale "Started" events overwriting Cancelled status.
    // Authoritative re-confirmations come through upserted events (MEWS poller),
    // which are not guarded.
    const existingStatus = reservation.status;
    if (
      (existingStatus === "Cancelled" || existingStatus === "Checked-out") &&
      newInternalStatus !== "Cancelled" && newInternalStatus !== "Checked-out"
    ) {
      await storage.createLog({
        level: "warn",
        source: "ingestion",
        message: `Blocked status downgrade for ${data.pmsReservationId}: DB=${existingStatus} → incoming=${data.newStatus}. Skipping.`,
        metadata: { reservationId: reservation.id },
      });
      return;
    }

    await storage.updateReservation(reservation.id, { status: newInternalStatus });
    
    await storage.createLog({
      level: "info",
      source: "ingestion",
      message: `Status changed: ${data.previousStatus || 'unknown'} -> ${data.newStatus}`,
      metadata: {
        eventId: event.eventId,
        pmsType: event.pmsType,
        reservationId: reservation.id,
      },
    });
    
    // PINs are only created via online pre-check-in, not automatically on status change
    if (newInternalStatus === "Checked-in") {
      // Check if this is an external check-in (kiosk/reception via MEWS)
      // and we need to activate a pending PIN for "physical_required" mode
      const checkInMethodSetting = await storage.getSetting("check_in_method");
      const checkInMethod = checkInMethodSetting?.value || "door_unlock";
      
      if (checkInMethod === "physical_required" && reservation.generatedPin) {
        // Activate pending PIN when MEWS check-in is detected
        const activationResult = await this.automationEngine.getPinLifecycle().activatePendingForReservation(reservation.id);
        
        if (activationResult.success || activationResult.alreadyActive) {
          // Update pmsCheckinSource to indicate external check-in
          if (!reservation.pmsCheckinSource) {
            await storage.updateReservation(reservation.id, {
              pmsCheckinSource: "mews",
            });
          }
          
          await storage.createLog({
            level: "info",
            source: "ingestion",
            message: `MEWS check-in detected (status change) - PIN activated for physical_required mode`,
            metadata: { reservationId: reservation.id },
          });
        } else {
          await storage.createLog({
            level: "error",
            source: "ingestion",
            message: `MEWS check-in detected but PIN activation failed: ${activationResult.error}`,
            metadata: { reservationId: reservation.id, error: activationResult.error },
          });
        }
      }
      
      // Note: Boarding pass email is sent during pre-check-in flow only
      // No separate PIN notification is sent here - guests use the boarding pass link
    } else if (newInternalStatus === "Cancelled" || newInternalStatus === "Checked-out") {
      if (newInternalStatus === "Checked-out" && hasActiveLateCheckout(reservation)) {
        // See processReservationUpserted: paid late checkout defers revocation.
        await storage.createLog({
          level: "info",
          source: "ingestion",
          message: `Checked-out in MEWS but paid late checkout is active — PIN revocation deferred until ${new Date(reservation.lateCheckoutUntil!).toISOString()}`,
          metadata: { reservationId: reservation.id },
        });
      } else {
        await this.pinLifecycle.onCancelled(reservation);
      }
    }
  }

  async processRoomSync(event: RoomSyncEvent): Promise<void> {
    const storage = this.getStorage(event.tenantId);
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
      message: `Room sync: ${created} created, ${updated} updated`,
      metadata: {
        eventId: event.eventId,
        pmsType: event.pmsType,
        totalRooms: data.rooms.length,
      },
    });
  }
}

export function createIngestionProcessor(automationEngine: AutomationEngine): IIngestionProcessor {
  return new IngestionProcessor(
    (tenantId) => Storage.forTenant(tenantId),
    automationEngine
  );
}
