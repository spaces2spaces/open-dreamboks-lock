/**
 * Integration TestHarness — wires real PinLifecycleService + IngestionProcessor
 * with mock TTLock, mock MEWS, and in-memory storage.
 *
 * Usage:
 *   const h = createTestHarness();
 *   const room = h.setupMappedRoom("101", "pms-room-101");
 *   await h.fireUpsert({ pmsId: "RES-1", status: "Confirmed", roomPmsId: "pms-room-101", ... });
 *   expect(h.storage._pins).toHaveLength(1);
 */

import { createMockStorage, type MockSettings } from "../mocks/storage";
import { createMockTTLockClient, type MockTTLockClient } from "../mocks/ttlock-client";
import { createMockMewsClient, type MockMewsClient } from "../mocks/mews-client";
import { makeRoom, makeLockDevice, isoDaysFromNow } from "../fixtures/reservations";
import { PinLifecycleService } from "../../pin-lifecycle-service";
import { IngestionProcessor } from "../../ingestion-processor";
import { DriftReconciler } from "../../drift-reconciler";
import type { ReservationUpsertedEvent, ReservationStatusChangedEvent } from "../../ingestion";
import type { Room, LockDevice } from "@shared/schema";
import { randomUUID } from "crypto";

const TENANT_ID = "test-tenant";

/**
 * MockAutomationEngine — minimal stand-in for AutomationEngine
 * that wires PinLifecycleService with mock clients.
 */
function createMockAutomationEngine(
  pinLifecycle: PinLifecycleService,
  ttlockClient: MockTTLockClient,
  mewsClient: MockMewsClient
) {
  return {
    getPinLifecycle: () => pinLifecycle,
    getTTLockClient: () => ttlockClient as any,
    getMewsClient: () => mewsClient as any,
    // IngestionProcessor never calls these directly, but guard against future changes
    immediatelyActivatePendingPin: (resId: string) =>
      pinLifecycle.activatePendingForReservation(resId),
    repairActivePinsWithMissingLocks: async () => {},
  };
}

export interface TestHarness {
  storage: ReturnType<typeof createExtendedMockStorage>;
  ttlock: MockTTLockClient;
  mews: MockMewsClient;
  pinLifecycle: PinLifecycleService;
  ingestion: IngestionProcessor;
  driftReconciler: DriftReconciler;

  /** Fire a reservation.upserted event through IngestionProcessor */
  fireUpsert(data: UpsertInput): Promise<void>;
  /**
   * Like fireUpsert, but guarantees the created PIN stays PENDING even when the
   * activation window is already open. Since the 20/7 fix, creation immediately
   * pushes same-day/overdue arrivals to TTLock; scenarios that exercise the
   * scheduler/reconciler paths need the pre-push state, so this variant detaches
   * the TTLock client during creation (mirrors "push not possible at creation",
   * e.g. lock offline).
   */
  fireUpsertPending(data: UpsertInput): Promise<void>;
  /** Fire a reservation.status_changed event through IngestionProcessor */
  fireStatusChange(pmsId: string, newStatus: "Confirmed" | "CheckedIn" | "CheckedOut" | "Cancelled", previousStatus?: string): Promise<void>;
  /** Create a mapped room with a room lock + assignment in storage */
  setupMappedRoom(name: string, pmsId: string, ttlockId?: string): { room: Room; lock: LockDevice };
  /** Add a common-area lock assignment to a room */
  setupCommonAreaLock(roomId: string, lockName: string, ttlockId?: string): LockDevice;
  /** Run one DriftReconciler pass and return stats */
  runDriftPass(): Promise<{ scanned: number; mewsDrift: number; ttlockDrift: number; fixed: number }>;
  /** Reset all state (storage, mock clients) */
  reset(): void;
}

interface UpsertInput {
  pmsId: string;
  status: "Confirmed" | "CheckedIn" | "CheckedOut" | "Cancelled";
  roomPmsId?: string | null;
  roomName?: string | null;
  arrival?: string;
  departure?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  owing?: string | null;
  adults?: number;
  children?: number;
}

/**
 * Extend the base mock storage with methods required by IngestionProcessor.
 */
function createExtendedMockStorage(settings: MockSettings = {}) {
  const base = createMockStorage(settings);

  return Object.assign(base, {
    // Override getReservation to return a copy (not a reference) so
    // IngestionProcessor's existingReservation snapshot isn't mutated by updateReservation.
    async getReservation(id: string) {
      const found = base._reservations.find((r) => r.id === id);
      return found ? { ...found } : undefined;
    },

    // IngestionProcessor needs these:
    async getReservationByPmsId(pmsId: string) {
      const found = base._reservations.find((r) => r.pmsId === pmsId);
      return found ? { ...found } : undefined;
    },

    async getRoomByPmsId(pmsId: string) {
      return base._rooms.find((r) => r.pmsId === pmsId);
    },

    async createReservation(data: any) {
      const id = data.id || randomUUID();
      const reservation = {
        id,
        tenantId: TENANT_ID,
        firstName: "",
        lastName: "",
        email: null,
        arrival: new Date(),
        departure: new Date(),
        pmsId: "",
        extId: null,
        roomId: null,
        adults: 1,
        children: 0,
        status: "Confirmed",
        generatedPin: null,
        preCheckinStatus: null,
        preCheckinToken: null,
        paymentVerifiedAt: null,
        codeDeliveredAt: null,
        pmsCheckinSource: null,
        guestSubmittedId: null,
        owing: null,
        createdAt: new Date(),
        updatedAt: null,
        room: null,
        assignedSpace: null,
        confirmationCode: null,
        preCheckinEmailSent: null,
        boardingCardSent: null,
        mewsPinSyncedAt: null,
        mobile: null,
        ...data,
      };
      base._reservations.push(reservation);
      return reservation;
    },

    async createRoom(data: any) {
      const id = data.id || randomUUID();
      const room = {
        id,
        tenantId: TENANT_ID,
        name: "",
        type: "standard",
        beds: 1,
        pmsStatus: "mapped",
        pmsId: null,
        battery: 100,
        floor: null,
        building: null,
        ordering: null,
        commonAreas: [],
        isDreamBoks: false,
        ttlockId: null,
        spaceCategory: null,
        label: null,
        createdAt: new Date(),
        ...data,
      };
      base._rooms.push(room);
      return room;
    },

    async updateRoom(id: string, data: any) {
      const room = base._rooms.find((r) => r.id === id);
      if (room) Object.assign(room, data);
      return room;
    },

    async getAllReservations() {
      return [...base._reservations];
    },

    async deletePin(id: string) {
      const idx = base._pins.findIndex((p) => p.id === id);
      if (idx >= 0) base._pins.splice(idx, 1);
    },

    async getActivePins() {
      return base._pins.filter((p) => p.status === "active");
    },

    async getAllPins() {
      return [...base._pins];
    },

    async getActiveReservationsWithPins() {
      const pinReservationIds = new Set(
        base._pins
          .filter((p) => ["active", "pending", "used", "delete_failed"].includes(p.status))
          .map((p) => p.reservationId)
      );
      return base._reservations.filter((r) => pinReservationIds.has(r.id));
    },

    async getCancelledReservationsForDriftCheck() {
      const now = new Date();
      return base._reservations.filter(
        (r) =>
          (r.status === "Cancelled" || r.status === "Checked-out") &&
          r.roomId &&
          new Date(r.departure) > now
      );
    },
  });
}

let lockIdCounter = 0;

export function createTestHarness(settingsOverrides: MockSettings = {}): TestHarness {
  const settings: MockSettings = {
    check_in_time: "15:00",
    reservation_checkout_time: "11:00",
    property_timezone: "Europe/Copenhagen",
    ...settingsOverrides,
  };

  const storage = createExtendedMockStorage(settings);
  const ttlock = createMockTTLockClient();
  const mews = createMockMewsClient();
  const pinLifecycle = new PinLifecycleService(storage as any, ttlock as any, mews as any);
  const mockEngine = createMockAutomationEngine(pinLifecycle, ttlock, mews);
  const ingestion = new IngestionProcessor(
    (_tenantId: string) => storage as any,
    mockEngine as any
  );
  const driftReconciler = new DriftReconciler(
    storage as any,
    mockEngine as any,
    ingestion as any,
    TENANT_ID,
    mews as any
  );

  function setupMappedRoom(
    name: string,
    pmsId: string,
    ttlockId?: string
  ): { room: Room; lock: LockDevice } {
    const roomId = randomUUID();
    const lockId = randomUUID();
    const lockTTId = ttlockId || `ttlock-${++lockIdCounter}`;

    const room = makeRoom({
      id: roomId,
      name,
      pmsId,
      pmsStatus: "mapped",
    });
    const lock = makeLockDevice({
      id: lockId,
      name: `Room Lock ${name}`,
      ttlockId: lockTTId,
      doorName: `Room ${name}`,
      lockType: "room",
      keyboardPwdVersion: 4,
    });

    storage._rooms.push(room);
    storage._lockAssignments.push({
      roomId: room.id,
      lockDevice: lock,
      assignmentType: "room_lock",
    });

    return { room, lock };
  }

  function setupCommonAreaLock(
    roomId: string,
    lockName: string,
    ttlockId?: string
  ): LockDevice {
    const lockId = randomUUID();
    const lockTTId = ttlockId || `ttlock-common-${++lockIdCounter}`;

    const lock = makeLockDevice({
      id: lockId,
      name: lockName,
      ttlockId: lockTTId,
      doorName: lockName,
      lockType: "common",
      keyboardPwdVersion: 4,
    });

    storage._lockAssignments.push({
      roomId,
      lockDevice: lock,
      assignmentType: "common_door",
    });

    return lock;
  }

  async function fireUpsertPending(input: UpsertInput): Promise<void> {
    const svc = pinLifecycle as any;
    const realClient = svc.ttlockClient;
    svc.ttlockClient = null;
    try {
      await fireUpsert(input);
    } finally {
      svc.ttlockClient = realClient;
    }
  }

  function fireUpsert(input: UpsertInput): Promise<void> {
    const event: ReservationUpsertedEvent = {
      eventType: "reservation.upserted",
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      tenantId: TENANT_ID,
      pmsType: "mews",
      data: {
        pmsReservationId: input.pmsId,
        status: input.status,
        arrival: input.arrival || isoDaysFromNow(30),
        departure: input.departure || isoDaysFromNow(32),
        guest: {
          firstName: input.firstName || "Test",
          lastName: input.lastName || "Guest",
          email: input.email || "test@example.com",
        },
        roomPmsId: input.roomPmsId ?? null,
        roomName: input.roomName ?? null,
        adults: input.adults ?? 1,
        children: input.children ?? 0,
        owing: input.owing ?? null,
      },
    };
    return ingestion.processEvent(event);
  }

  function fireStatusChange(
    pmsId: string,
    newStatus: "Confirmed" | "CheckedIn" | "CheckedOut" | "Cancelled",
    previousStatus?: string
  ): Promise<void> {
    const event: ReservationStatusChangedEvent = {
      eventType: "reservation.status_changed",
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      tenantId: TENANT_ID,
      pmsType: "mews",
      data: {
        pmsReservationId: pmsId,
        newStatus,
        previousStatus: previousStatus as any,
      },
    };
    return ingestion.processEvent(event);
  }

  function runDriftPass(): Promise<{ scanned: number; mewsDrift: number; ttlockDrift: number; fixed: number }> {
    return driftReconciler.runOnce();
  }

  function reset() {
    storage._pins.length = 0;
    storage._reservations.length = 0;
    storage._rooms.length = 0;
    storage._logs.length = 0;
    storage._reservationLogs.length = 0;
    storage._lockAssignments.length = 0;
    ttlock.reset();
    mews.reset();
    lockIdCounter = 0;
  }

  return {
    storage,
    ttlock,
    mews,
    pinLifecycle,
    ingestion,
    driftReconciler,
    fireUpsert,
    fireUpsertPending,
    fireStatusChange,
    setupMappedRoom,
    setupCommonAreaLock,
    runDriftPass,
    reset,
  };
}
