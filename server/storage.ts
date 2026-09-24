import crypto from "crypto";
import {
  rooms,
  commonAreas,
  reservations,
  pins,
  ekeys,
  logs,
  settings,
  lockDevices,
  reservationLogs,
  qrCodes,
  roomLockAssignments,
  tenants,
  vendorInvitations,
  hotelUsers,
  sessions,
  type Room,
  type InsertRoom,
  type CommonArea,
  type InsertCommonArea,
  type Reservation,
  type InsertReservation,
  type Pin,
  type InsertPin,
  type Ekey,
  type InsertEkey,
  type Log,
  type InsertLog,
  type Setting,
  type InsertSetting,
  type LockDevice,
  type InsertLockDevice,
  type ReservationLog,
  type InsertReservationLog,
  type QrCode,
  type InsertQrCode,
  type RoomLockAssignment,
  type InsertRoomLockAssignment,
  type Tenant,
  type InsertTenant,
  type VendorInvitation,
  type InsertVendorInvitation,
  type HotelUser,
  type InsertHotelUser,
  type Session,
  type InsertSession,
  hourlyBookings,
  earlyCheckins,
  marketingSends,
  type MarketingSend,
  type InsertMarketingSend,
  type HourlyBooking,
  type InsertHourlyBooking,
} from "@shared/schema";
import { db } from "./db";
import { hasActiveLateCheckout } from "./pin-validity-window";
import { spacesOutsideRoomScopedLock } from "@shared/room-scoped-locks";
import { isLinkGradeIdentifier } from "@shared/guest-identifier";
export { db };
import { eq, desc, and, gte, gt, lt, inArray, isNotNull, or, sql, count, not } from "drizzle-orm";
import { DateTime } from "luxon";

// Default tenant ID for single-tenant operation
// Used as fallback when tenant context is not available
export const DEFAULT_TENANT_ID = "f5f2311b-c963-4ff5-9bb1-98d1bf629f77";

// Tenant-less input types for public API (tenantId injected by storage layer)
export type TenantlessRoomInput = Omit<InsertRoom, 'tenantId'>;
export type TenantlessCommonAreaInput = Omit<InsertCommonArea, 'tenantId'>;
export type TenantlessReservationInput = Omit<InsertReservation, 'tenantId'>;
export type TenantlessPinInput = Omit<InsertPin, 'tenantId'>;
export type TenantlessLogInput = Omit<InsertLog, 'tenantId'>;
export type TenantlessLockDeviceInput = Omit<InsertLockDevice, 'tenantId'>;
export type TenantlessReservationLogInput = Omit<InsertReservationLog, 'tenantId'>;
export type TenantlessQrCodeInput = Omit<InsertQrCode, 'tenantId'>;
export type TenantlessRoomLockAssignmentInput = Omit<InsertRoomLockAssignment, 'tenantId'>;
export type TenantlessEkeyInput = Omit<InsertEkey, 'tenantId'>;
export type TenantlessHourlyBookingInput = Omit<InsertHourlyBooking, 'tenantId'>;

// Tenant-scoped storage interface (public API)
export interface ITenantStorage {
  // Get the tenant ID this storage is scoped to
  readonly tenantId: string;

  // Rooms
  getAllRooms(): Promise<Room[]>;
  getRoom(id: string): Promise<Room | undefined>;
  getRoomByPmsId(pmsId: string): Promise<Room | undefined>;
  createRoom(room: TenantlessRoomInput): Promise<Room>;
  updateRoom(id: string, room: Partial<TenantlessRoomInput>): Promise<Room | undefined>;
  deleteRoom(id: string): Promise<void>;
  deleteAllRooms(): Promise<void>;
  deleteAllMewsData(): Promise<void>;

  // Common Areas
  getAllCommonAreas(): Promise<CommonArea[]>;
  getCommonArea(id: string): Promise<CommonArea | undefined>;
  createCommonArea(area: TenantlessCommonAreaInput): Promise<CommonArea>;
  updateCommonArea(id: string, area: Partial<TenantlessCommonAreaInput>): Promise<CommonArea | undefined>;

  // Reservations
  getAllReservations(): Promise<Reservation[]>;
  getReservationsByArrivalRange(startDate: Date, endDate: Date): Promise<Reservation[]>;
  getMappedReservationsByArrivalRange(startDate: Date, endDate: Date): Promise<Reservation[]>;
  getReservationsWithLateCheckoutBetween(startDate: Date, endDate: Date): Promise<Reservation[]>;
  getActiveReservationsWithPins(): Promise<Reservation[]>;
  getCancelledReservationsForDriftCheck(): Promise<Reservation[]>;
  getVisibleReservationsForTTLock(): Promise<Reservation[]>;
  getMappedReservations(): Promise<Reservation[]>;
  getReservationsForCheckinList(): Promise<Reservation[]>;
  getReservation(id: string): Promise<Reservation | undefined>;
  getReservationByPmsId(pmsId: string): Promise<Reservation | undefined>;
  getReservationByPreCheckinToken(token: string): Promise<Reservation | undefined>;
  getReservationByNumberAndName(reservationNumber: string, lastName: string): Promise<{ reservation: Reservation; pin: Pin | null } | null>;
  createReservation(reservation: TenantlessReservationInput): Promise<Reservation>;
  updateReservation(id: string, reservation: Partial<TenantlessReservationInput>): Promise<Reservation | undefined>;
  deleteReservation(id: string): Promise<void>;
  deleteExpiredReservations(): Promise<number>;
  deleteOrphanedPins(): Promise<number>;

  // Hourly bookings (standalone, outside MEWS)
  getHourlyBookings(limit?: number): Promise<HourlyBooking[]>;
  getHourlyBooking(id: string): Promise<HourlyBooking | undefined>;
  getHourlyBookingByMewsReservationId(pmsReservationId: string): Promise<HourlyBooking | undefined>;
  getHourlyBookingsOverlapping(startAt: Date, endAt: Date, statuses: string[]): Promise<HourlyBooking[]>;
  createHourlyBooking(booking: TenantlessHourlyBookingInput): Promise<HourlyBooking>;
  updateHourlyBooking(id: string, booking: Partial<TenantlessHourlyBookingInput>): Promise<HourlyBooking | undefined>;
  confirmHourlyBookingIfNotConfirmed(id: string, booking: Partial<TenantlessHourlyBookingInput>): Promise<HourlyBooking | undefined>;

  // Pins
  getAllPins(): Promise<Pin[]>;
  getPin(id: string): Promise<Pin | undefined>;
  getPinsByRoomId(roomId: string): Promise<Pin[]>;
  getPinsByReservationId(reservationId: string): Promise<Pin[]>;
  getPinsByReservationIds(reservationIds: string[]): Promise<Pin[]>;
  getPendingPinsForTodayArrivals(): Promise<(Pin & { reservation: Reservation })[]>;
  getActivePins(): Promise<Pin[]>;
  getRepairablePins(): Promise<Pin[]>;
  getPinsWithDeleteFailed(): Promise<Pin[]>;
  getDeletedPinsWithinValidity(): Promise<Pin[]>;
  getCompletedUpsellsSince(since: Date): Promise<Array<typeof earlyCheckins.$inferSelect>>;
  getMappedReservationsByDepartureRange(startDate: Date, endDate: Date): Promise<Reservation[]>;
  getUpsellsByReservationIds(reservationIds: string[]): Promise<Array<typeof earlyCheckins.$inferSelect>>;
  getMarketingSentReservationIds(campaign: string): Promise<Set<string>>;
  createMarketingSendClaim(row: Omit<InsertMarketingSend, "tenantId">): Promise<MarketingSend | undefined>;
  updateMarketingSend(id: string, patch: Partial<Pick<MarketingSend, "status" | "error" | "sentTo">>): Promise<void>;
  getMarketingSendsWithReservations(limit?: number): Promise<Array<MarketingSend & { guestName: string }>>;
  getMarketingDailyHistory(days: number, tz: string): Promise<Array<{ day: string; campaign: string; sent: number; failed: number }>>;
  getUpsellDailyHistory(days: number, tz: string): Promise<Array<{ day: string; kind: string; purchases: number; revenue: number }>>;
  createPin(pin: TenantlessPinInput): Promise<Pin>;
  updatePin(id: string, pin: Partial<TenantlessPinInput>): Promise<Pin | undefined>;
  updatePinFirstUsedAt(id: string, firstUsedAt: Date): Promise<Pin | undefined>;
  deletePin(id: string): Promise<void>;

  // Logs
  createLog(log: TenantlessLogInput): Promise<Log>;
  getLogsByReservation(reservationId: string): Promise<Log[]>;
  getAllLogs(limit?: number): Promise<Log[]>;
  getLogsBySourceSince(source: string, since: Date, limit?: number): Promise<Log[]>;

  // Settings
  getSetting(key: string): Promise<Setting | undefined>;
  setSetting(key: string, value: string): Promise<Setting>;
  getAllSettings(): Promise<Setting[]>;

  // Lock Devices
  getAllLockDevices(): Promise<LockDevice[]>;
  getLockDevice(id: string): Promise<LockDevice | undefined>;
  getLockDeviceByTTLockId(ttlockId: string): Promise<LockDevice | undefined>;
  createLockDevice(device: TenantlessLockDeviceInput): Promise<LockDevice>;
  updateLockDevice(id: string, device: Partial<TenantlessLockDeviceInput>): Promise<LockDevice | undefined>;
  upsertLockDevice(device: TenantlessLockDeviceInput): Promise<LockDevice>;
  syncLockDeviceFromTTLock(ttlockId: string, ttlockData: { name: string; mac: string; battery: number }): Promise<LockDevice>;
  deleteLockDevice(id: string): Promise<void>;
  mapLockDeviceToRoom(deviceTtlockId: string, newRoomId: string | null): Promise<{ previousRoom: Room | null; newRoom: Room | null; error?: string }>;
  updateLockDeviceWithMapping(deviceId: string, metadata: { name: string; lockType: string; doorName?: string | null }, newRoomId: string | null | undefined): Promise<{ device: LockDevice; previousRoom: Room | null; newRoom: Room | null; error?: string }>;
  getAvailableLockDevicesForSpace(spaceId: string): Promise<LockDevice[]>;

  // Reservation Logs
  getReservationLogs(reservationId: string): Promise<ReservationLog[]>;
  createReservationLog(log: TenantlessReservationLogInput): Promise<ReservationLog>;

  // QR Codes
  getQrCodesByRoom(roomId: string): Promise<QrCode[]>;
  createQrCode(code: TenantlessQrCodeInput): Promise<QrCode>;

  // Room Lock Assignments
  isRoomMapped(roomId: string): Promise<boolean>;
  getRoomLockAssignments(roomId: string): Promise<(RoomLockAssignment & { lockDevice: LockDevice })[]>;
  getLockDeviceAssignments(lockDeviceId: string): Promise<(RoomLockAssignment & { room: Room })[]>;
  getAllRoomLockAssignments(): Promise<(RoomLockAssignment & { room: Room; lockDevice: LockDevice })[]>;
  createRoomLockAssignment(assignment: TenantlessRoomLockAssignmentInput): Promise<RoomLockAssignment>;
  createRoomLockAssignmentsBulk(assignments: TenantlessRoomLockAssignmentInput[]): Promise<RoomLockAssignment[]>;
  deleteRoomLockAssignment(id: string): Promise<void>;
  deleteRoomLockAssignmentByRoomAndDevice(roomId: string, lockDeviceId: string): Promise<void>;
  deleteRoomLockAssignmentsBulk(ids: string[]): Promise<void>;

  // Ekeys
  getEkeysByReservation(reservationId: string): Promise<Ekey[]>;
  createEkey(ekey: TenantlessEkeyInput): Promise<Ekey>;
  createEkeysBulk(ekeys: TenantlessEkeyInput[]): Promise<Ekey[]>;
  deleteEkeysByReservation(reservationId: string): Promise<void>;

  // Boarding Pass with Locks
  getReservationWithLocks(reservationNumber: string, lastName: string): Promise<{
    reservation: Reservation;
    pin: Pin | null;
    locks: Array<{ id: string; ttlockId: string; name: string; lockType: string; doorName: string | null }>;
  } | null>;
}

// Legacy interface for backward compatibility (deprecated - use ITenantStorage)
export type IStorage = ITenantStorage;

// Storage factory interface
export interface IStorageFactory {
  forTenant(tenantId: string): ITenantStorage;
  getDefaultTenantId(): string;
}

// Settings cache for performance optimization
// TTL: 5 minutes (300000ms)
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class SettingsCache {
  private static instance: SettingsCache;
  private cache: Map<string, CacheEntry<Setting | undefined>> = new Map();
  private static TTL_MS = 5 * 60 * 1000; // 5 minutes

  static getInstance(): SettingsCache {
    if (!SettingsCache.instance) {
      SettingsCache.instance = new SettingsCache();
    }
    return SettingsCache.instance;
  }

  private getCacheKey(tenantId: string, key: string): string {
    return `${tenantId}:${key}`;
  }

  get(tenantId: string, key: string): Setting | undefined | null {
    const cacheKey = this.getCacheKey(tenantId, key);
    const entry = this.cache.get(cacheKey);
    
    if (!entry) {
      return null; // Cache miss
    }
    
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(cacheKey);
      return null; // Expired
    }
    
    return entry.value; // Cache hit (may be undefined if setting doesn't exist)
  }

  set(tenantId: string, key: string, value: Setting | undefined): void {
    const cacheKey = this.getCacheKey(tenantId, key);
    this.cache.set(cacheKey, {
      value,
      expiresAt: Date.now() + SettingsCache.TTL_MS,
    });
  }

  invalidate(tenantId: string, key: string): void {
    const cacheKey = this.getCacheKey(tenantId, key);
    this.cache.delete(cacheKey);
  }

  invalidateAll(tenantId: string): void {
    const prefix = `${tenantId}:`;
    const keysToDelete = Array.from(this.cache.keys()).filter(key => key.startsWith(prefix));
    keysToDelete.forEach(key => this.cache.delete(key));
  }

  // Clean up expired entries periodically
  cleanup(): void {
    const now = Date.now();
    const entriesToCheck = Array.from(this.cache.entries());
    entriesToCheck.forEach(([key, entry]) => {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    });
  }
}

// Tenant-scoped storage implementation
export class TenantStorage implements ITenantStorage {
  private settingsCache = SettingsCache.getInstance();
  
  constructor(public readonly tenantId: string) {}
  // Rooms
  async getAllRooms(): Promise<Room[]> {
    return await db.select().from(rooms).where(eq(rooms.tenantId, this.tenantId));
  }

  async getRoom(id: string): Promise<Room | undefined> {
    const [room] = await db.select().from(rooms).where(and(eq(rooms.id, id), eq(rooms.tenantId, this.tenantId)));
    return room || undefined;
  }

  async getRoomByPmsId(pmsId: string): Promise<Room | undefined> {
    const [room] = await db.select().from(rooms).where(and(eq(rooms.pmsId, pmsId), eq(rooms.tenantId, this.tenantId)));
    return room || undefined;
  }

  async createRoom(room: TenantlessRoomInput): Promise<Room> {
    const rest = room;
    const [newRoom] = await db.insert(rooms).values({ 
      tenantId: this.tenantId,
      ...rest 
    }).returning();
    return newRoom;
  }

  async updateRoom(id: string, room: Partial<TenantlessRoomInput>): Promise<Room | undefined> {
    const rest = room;
    const [updated] = await db
      .update(rooms)
      .set(rest)
      .where(and(eq(rooms.id, id), eq(rooms.tenantId, this.tenantId)))
      .returning();
    return updated || undefined;
  }

  async deleteRoom(id: string): Promise<void> {
    await db.delete(rooms).where(and(eq(rooms.id, id), eq(rooms.tenantId, this.tenantId)));
  }

  async deleteAllRooms(): Promise<void> {
    await db.delete(rooms).where(eq(rooms.tenantId, this.tenantId));
  }

  async deleteAllMewsData(): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(ekeys).where(eq(ekeys.tenantId, this.tenantId));
      await tx.delete(reservationLogs).where(eq(reservationLogs.tenantId, this.tenantId));
      await tx.delete(pins).where(eq(pins.tenantId, this.tenantId));
      await tx.delete(reservations).where(eq(reservations.tenantId, this.tenantId));
      await tx.delete(rooms).where(eq(rooms.tenantId, this.tenantId));
      await tx.delete(logs).where(and(eq(logs.tenantId, this.tenantId), eq(logs.source, 'ingestion')));
    });
  }

  // Common Areas
  async getAllCommonAreas(): Promise<CommonArea[]> {
    return await db.select().from(commonAreas).where(eq(commonAreas.tenantId, this.tenantId));
  }

  async getCommonArea(id: string): Promise<CommonArea | undefined> {
    const [area] = await db.select().from(commonAreas).where(and(eq(commonAreas.id, id), eq(commonAreas.tenantId, this.tenantId)));
    return area || undefined;
  }

  async createCommonArea(area: TenantlessCommonAreaInput): Promise<CommonArea> {
    const rest = area;
    const [newArea] = await db.insert(commonAreas).values({ 
      tenantId: this.tenantId,
      ...rest 
    }).returning();
    return newArea;
  }

  async updateCommonArea(id: string, area: Partial<TenantlessCommonAreaInput>): Promise<CommonArea | undefined> {
    const rest = area;
    const [updated] = await db
      .update(commonAreas)
      .set(rest)
      .where(and(eq(commonAreas.id, id), eq(commonAreas.tenantId, this.tenantId)))
      .returning();
    return updated || undefined;
  }

  // Reservations
  async getAllReservations(): Promise<Reservation[]> {
    return await db.select().from(reservations).where(eq(reservations.tenantId, this.tenantId)).orderBy(desc(reservations.arrival));
  }

  async getReservationsByArrivalRange(startDate: Date, endDate: Date): Promise<Reservation[]> {
    return await db
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.tenantId, this.tenantId),
          gte(reservations.arrival, startDate),
          lt(reservations.arrival, endDate)
        )
      )
      .orderBy(desc(reservations.arrival));
  }

  async getActiveReservationsWithPins(): Promise<Reservation[]> {
    const daysAheadSetting = await this.getSetting('reservation_list_days_ahead');
    const daysAhead = parseInt(daysAheadSetting?.value || '1', 10);

    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const futureEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead + 1, 0, 0, 0));

    const result = await db
      .selectDistinct({ reservation: reservations })
      .from(reservations)
      .innerJoin(rooms, and(eq(reservations.roomId, rooms.id), eq(rooms.tenantId, reservations.tenantId)))
      .innerJoin(roomLockAssignments, and(eq(rooms.id, roomLockAssignments.roomId), eq(roomLockAssignments.tenantId, reservations.tenantId)))
      .innerJoin(lockDevices, eq(roomLockAssignments.lockDeviceId, lockDevices.id))
      .where(
        and(
          eq(reservations.tenantId, this.tenantId),
          eq(lockDevices.lockType, "room"),
          inArray(reservations.status, ['Confirmed', 'Checked-in']),
          or(
            and(
              eq(reservations.status, 'Confirmed'),
              gte(reservations.arrival, todayStart),
              lt(reservations.arrival, futureEnd)
            ),
            and(
              eq(reservations.status, 'Checked-in'),
              gte(reservations.departure, todayStart)
            )
          )
        )
      )
      .orderBy(desc(reservations.arrival));

    return result.map(r => r.reservation);
  }

  /**
   * Returns Cancelled/Checked-out reservations with future departures in mapped rooms.
   * Used by DriftReconciler to detect reverse drift (MEWS re-confirmed a cancelled reservation).
   */
  async getCancelledReservationsForDriftCheck(): Promise<Reservation[]> {
    const now = new Date();

    const result = await db
      .selectDistinct({ reservation: reservations })
      .from(reservations)
      .innerJoin(rooms, and(eq(reservations.roomId, rooms.id), eq(rooms.tenantId, reservations.tenantId)))
      .innerJoin(roomLockAssignments, and(eq(rooms.id, roomLockAssignments.roomId), eq(roomLockAssignments.tenantId, reservations.tenantId)))
      .innerJoin(lockDevices, eq(roomLockAssignments.lockDeviceId, lockDevices.id))
      .where(
        and(
          eq(reservations.tenantId, this.tenantId),
          eq(lockDevices.lockType, "room"),
          inArray(reservations.status, ['Cancelled', 'Checked-out']),
          gte(reservations.departure, now)
        )
      )
      .orderBy(desc(reservations.arrival));

    return result.map(r => r.reservation);
  }

  async getVisibleReservationsForTTLock(): Promise<Reservation[]> {
    const daysAheadSetting = await this.getSetting('mews_fast_poll_days_ahead');
    const daysAhead = parseInt(daysAheadSetting?.value || '2', 10);
    
    const timezoneSetting = await this.getSetting('property_timezone');
    const timezone = timezoneSetting?.value || 'Europe/Copenhagen';
    
    const nowInZone = DateTime.now().setZone(timezone);
    const todayStart = nowInZone.startOf('day');
    const gracePeriodStart = todayStart.minus({ days: 1 });
    const targetArrivalDateEnd = todayStart.plus({ days: daysAhead + 1 });
    
    const nowUtc = nowInZone.toJSDate();
    const gracePeriodStartUtc = gracePeriodStart.toJSDate();
    const targetArrivalEndUtc = targetArrivalDateEnd.toJSDate();

    const result = await db
      .selectDistinct({ reservation: reservations })
      .from(reservations)
      .innerJoin(rooms, and(eq(reservations.roomId, rooms.id), eq(rooms.tenantId, reservations.tenantId)))
      .innerJoin(roomLockAssignments, and(eq(rooms.id, roomLockAssignments.roomId), eq(roomLockAssignments.tenantId, reservations.tenantId)))
      .innerJoin(lockDevices, eq(roomLockAssignments.lockDeviceId, lockDevices.id))
      .where(
        and(
          eq(reservations.tenantId, this.tenantId),
          eq(lockDevices.lockType, "room"),
          inArray(reservations.status, ['Confirmed', 'Checked-in']),
          or(
            and(
              eq(reservations.status, 'Confirmed'),
              gte(reservations.arrival, gracePeriodStartUtc),
              lt(reservations.arrival, targetArrivalEndUtc)
            ),
            eq(reservations.status, 'Checked-in')
          ),
          gte(reservations.departure, nowUtc)
        )
      )
      .orderBy(desc(reservations.arrival));

    return result.map(r => r.reservation);
  }

  async getReservation(id: string): Promise<Reservation | undefined> {
    const [reservation] = await db.select().from(reservations).where(and(eq(reservations.id, id), eq(reservations.tenantId, this.tenantId)));
    return reservation || undefined;
  }

  async getReservationByPmsId(pmsId: string): Promise<Reservation | undefined> {
    const [reservation] = await db.select().from(reservations).where(and(eq(reservations.pmsId, pmsId), eq(reservations.tenantId, this.tenantId)));
    return reservation || undefined;
  }

  async getReservationByPreCheckinToken(token: string): Promise<Reservation | undefined> {
    const [reservation] = await db.select().from(reservations).where(and(eq(reservations.preCheckinToken, token), eq(reservations.tenantId, this.tenantId)));
    return reservation || undefined;
  }

  async getReservationByNumberAndName(reservationNumber: string, lastName: string): Promise<{ reservation: Reservation; pin: Pin | null } | null> {
    let [reservation] = await db
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.tenantId, this.tenantId),
          or(
            eq(reservations.extId, reservationNumber),
            eq(reservations.confirmationCode, reservationNumber),
            eq(reservations.pmsId, reservationNumber),
            // Link-grade identifier (reservation UUID) from a link we sent —
            // see shared/guest-identifier.ts. Only tried when UUID-shaped.
            ...(isLinkGradeIdentifier(reservationNumber) ? [eq(reservations.id, reservationNumber)] : [])
          ),
          sql`LOWER(${reservations.lastName}) = LOWER(${lastName})`
        )
      );
    
    if (!reservation) {
      return null;
    }

    // Allow viewing boarding pass for Confirmed, Checked-in, and Checked-out reservations
    const allowedStatuses = ["Confirmed", "Checked-in", "Checked-out", "checked-in", "checked-out"];
    if (!allowedStatuses.includes(reservation.status)) {
      return null;
    }

    // Include active, pending, and used PINs so guests can still view their expired/used codes
    const [pin] = await db
      .select()
      .from(pins)
      .where(
        and(
          eq(pins.tenantId, this.tenantId),
          eq(pins.reservationId, reservation.id),
          or(eq(pins.status, 'active'), eq(pins.status, 'pending'), eq(pins.status, 'used'))
        )
      )
      .orderBy(desc(pins.createdAt))
      .limit(1);

    // If no active/pending/used pin record found but reservation has a generatedPin,
    // show the generatedPin — it is the guest's permanent personal code.
    // TTLock status (cancelled/pending/active) is backend state; the boarding card
    // normally reflects the DB code regardless.
    //
    // EXCEPTION: if the current room is unmapped (no room-type lock), the PIN has
    // been revoked (e.g. staff moved reservation from mapped→unmapped room) and
    // the guest should NOT see a code — it is no longer programmed on any lock.
    const roomIsMapped = reservation.roomId
      ? await this.isRoomMapped(reservation.roomId)
      : false;
    if (!pin && reservation.generatedPin && roomIsMapped) {
      return {
        reservation,
        pin: {
          id: 'virtual',
          tenantId: this.tenantId,
          roomId: reservation.roomId || '',
          reservationId: reservation.id,
          type: 'Passcode',
          code: reservation.generatedPin,
          name: `${reservation.firstName} ${reservation.lastName}`,
          email: reservation.email,
          validFrom: reservation.arrival,
          validTo: reservation.departure,
          status: 'active',
          doors: [],
          assigner: 'System',
          ttlockKeyId: null,
          roomLockKeyIds: [],
          commonAreaKeyIds: [],
          qrCodeData: null,
          createdAt: reservation.createdAt || new Date(),
          firstUsedAt: null,
        } as Pin,
      };
    }

    return {
      reservation,
      pin: pin || null
    };
  }

  async createReservation(reservation: TenantlessReservationInput): Promise<Reservation> {
    const rest = reservation;
    const preCheckinToken = rest.preCheckinToken || crypto.randomBytes(32).toString("hex");
    const [newReservation] = await db.insert(reservations).values({ 
      tenantId: this.tenantId,
      ...rest,
      preCheckinToken,
    }).returning();
    return newReservation;
  }

  async updateReservation(id: string, reservation: Partial<TenantlessReservationInput>): Promise<Reservation | undefined> {
    // Build set object explicitly: keep null values (they map to SQL NULL to clear columns
    // like roomId), filter out undefined values (those should not overwrite existing data).
    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    for (const [key, value] of Object.entries(reservation)) {
      if (value !== undefined) {
        setValues[key] = value;
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [updated] = await db
      .update(reservations)
      .set(setValues as any)
      .where(and(eq(reservations.id, id), eq(reservations.tenantId, this.tenantId)))
      .returning();
    return updated || undefined;
  }

  async deleteReservation(id: string): Promise<void> {
    await db.transaction(async (tx) => {
      const tenantFilter = eq(pins.tenantId, this.tenantId);
      await tx.delete(pins).where(and(tenantFilter, eq(pins.reservationId, id)));
      await tx.delete(ekeys).where(and(eq(ekeys.tenantId, this.tenantId), eq(ekeys.reservationId, id)));
      await tx.delete(reservationLogs).where(and(eq(reservationLogs.tenantId, this.tenantId), eq(reservationLogs.reservationId, id)));
      await tx.delete(reservations).where(and(eq(reservations.id, id), eq(reservations.tenantId, this.tenantId)));
    });
  }

  async deleteExpiredReservations(): Promise<number> {
    const now = new Date();
    const checkoutTimeSetting = await this.getSetting("reservation_checkout_time");
    const timezoneSetting = await this.getSetting("property_timezone");
    const checkoutTime = checkoutTimeSetting?.value || "11:00";
    const timezone = timezoneSetting?.value || "Europe/Copenhagen";
    const [checkoutHour, checkoutMinute] = checkoutTime.split(":").map(Number);

    const allRes = await db
      .select({ id: reservations.id, departure: reservations.departure, status: reservations.status, lateCheckoutUntil: reservations.lateCheckoutUntil })
      .from(reservations)
      .where(eq(reservations.tenantId, this.tenantId));

    // Live pending late-checkout payments protect their reservations (guest
    // may be mid-payment when MEWS's ~11:00 bulk checkout lands). Inline query
    // (not the service helper) to avoid a circular import.
    const pendingLateRows = await db
      .select({ reservationId: earlyCheckins.reservationId, createdAt: earlyCheckins.createdAt })
      .from(earlyCheckins)
      .where(and(
        eq(earlyCheckins.tenantId, this.tenantId),
        eq(earlyCheckins.kind, "late_checkout"),
        eq(earlyCheckins.status, "pending_payment"),
      ));
    const pendingCutoff = Date.now() - 40 * 60 * 1000;
    const pendingLateIds = new Set(
      pendingLateRows.filter((r) => new Date(r.createdAt).getTime() > pendingCutoff).map((r) => r.reservationId)
    );

    const nowLuxon = DateTime.now().setZone(timezone);
    const expiredRes = allRes.filter((res: { id: string; departure: Date | string; status: string | null; lateCheckoutUntil: Date | null }) => {
      // Paid late checkout: the reservation must survive until the paid end,
      // even after MEWS's bulk auto-checkout flips it to Checked-out. Same 12h
      // band as the validity-window fold (a stale value must not block forever).
      if (hasActiveLateCheckout(res)) return false;
      if (pendingLateIds.has(res.id)) return false;
      // Checked-out: delete immediately (guest has left)
      if (res.status === "Checked-out") return true;
      // Cancelled: keep until checkout time passes so a subsequent good MEWS sync
      // can reinstate the reservation by pmsId and preserve pre_checkin_email_sent.
      // Use timezone-aware comparison (not setUTCHours which treats local times as UTC)
      const departureInZone = DateTime.fromJSDate(new Date(res.departure), { zone: "utc" })
        .setZone(timezone)
        .set({ hour: checkoutHour, minute: checkoutMinute, second: 0, millisecond: 0 });
      return departureInZone < nowLuxon;
    });

    if (expiredRes.length === 0) return 0;

    const expiredIds = expiredRes.map(r => r.id);

    return await db.transaction(async (tx) => {
      await tx.delete(pins).where(
        and(
          eq(pins.tenantId, this.tenantId),
          inArray(pins.reservationId, expiredIds)
        )
      );

      await tx.delete(reservationLogs).where(
        and(
          eq(reservationLogs.tenantId, this.tenantId),
          inArray(reservationLogs.reservationId, expiredIds)
        )
      );

      await tx.delete(ekeys).where(
        and(
          eq(ekeys.tenantId, this.tenantId),
          inArray(ekeys.reservationId, expiredIds)
        )
      );

      const result = await tx
        .delete(reservations)
        .where(
          and(
            eq(reservations.tenantId, this.tenantId),
            inArray(reservations.id, expiredIds)
          )
        )
        .returning({ id: reservations.id });
      return result.length;
    });
  }

  async deleteOrphanedPins(): Promise<number> {
    const allPins = await db
      .select({ id: pins.id, reservationId: pins.reservationId })
      .from(pins)
      .where(eq(pins.tenantId, this.tenantId));

    const orphanedIds: string[] = [];
    for (const pin of allPins) {
      if (!pin.reservationId) {
        orphanedIds.push(pin.id);
        continue;
      }
      const res = await db
        .select({ id: reservations.id })
        .from(reservations)
        .where(eq(reservations.id, pin.reservationId))
        .limit(1);
      if (res.length === 0) {
        orphanedIds.push(pin.id);
      }
    }

    if (orphanedIds.length === 0) return 0;

    await db.delete(pins).where(
      and(
        eq(pins.tenantId, this.tenantId),
        inArray(pins.id, orphanedIds)
      )
    );

    return orphanedIds.length;
  }

  async getMappedReservationsByArrivalRange(startDate: Date, endDate: Date): Promise<Reservation[]> {
    const result = await db
      .selectDistinct({ reservation: reservations })
      .from(reservations)
      .innerJoin(rooms, and(eq(reservations.roomId, rooms.id), eq(rooms.tenantId, this.tenantId)))
      .innerJoin(roomLockAssignments, and(eq(rooms.id, roomLockAssignments.roomId), eq(roomLockAssignments.tenantId, this.tenantId)))
      .innerJoin(lockDevices, eq(roomLockAssignments.lockDeviceId, lockDevices.id))
      .where(
        and(
          eq(reservations.tenantId, this.tenantId),
          eq(lockDevices.lockType, "room"),
          gte(reservations.arrival, startDate),
          lt(reservations.arrival, endDate)
        )
      )
      .orderBy(desc(reservations.arrival));
    return result.map(r => r.reservation);
  }

  async getReservationsWithLateCheckoutBetween(startDate: Date, endDate: Date): Promise<Reservation[]> {
    // Departing guests with a PAID late checkout ending in the window — the
    // arrivals page lists them as extra cleaning tasks (the cleaner's morning
    // round is over before a 14:00 checkout frees the capsule).
    const result = await db
      .selectDistinct({ reservation: reservations })
      .from(reservations)
      .innerJoin(rooms, and(eq(reservations.roomId, rooms.id), eq(rooms.tenantId, this.tenantId)))
      .innerJoin(roomLockAssignments, and(eq(rooms.id, roomLockAssignments.roomId), eq(roomLockAssignments.tenantId, this.tenantId)))
      .innerJoin(lockDevices, eq(roomLockAssignments.lockDeviceId, lockDevices.id))
      .where(
        and(
          eq(reservations.tenantId, this.tenantId),
          eq(lockDevices.lockType, "room"),
          gte(reservations.lateCheckoutUntil, startDate),
          lt(reservations.lateCheckoutUntil, endDate)
        )
      )
      .orderBy(desc(reservations.lateCheckoutUntil));
    return result.map(r => r.reservation);
  }

  async getMappedReservations(): Promise<Reservation[]> {
    // Only return reservations where the room has at least one room-type lock.
    // Common-area-only rooms are excluded (they don't qualify for PIN processing).
    // Limited to arrivals within the MEWS poller window (same as fast poll + full sync).
    const now = new Date();
    const windowStart = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // yesterday
    const windowEnd = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000); // 2 days ahead (fast poll window)
    const result = await db
      .selectDistinct({ reservation: reservations })
      .from(reservations)
      .innerJoin(rooms, and(eq(reservations.roomId, rooms.id), eq(rooms.tenantId, this.tenantId)))
      .innerJoin(roomLockAssignments, and(eq(rooms.id, roomLockAssignments.roomId), eq(roomLockAssignments.tenantId, this.tenantId)))
      .innerJoin(lockDevices, eq(roomLockAssignments.lockDeviceId, lockDevices.id))
      .where(
        and(
          eq(reservations.tenantId, this.tenantId),
          eq(lockDevices.lockType, "room"),
          gte(reservations.arrival, windowStart),
          lt(reservations.arrival, windowEnd),
          not(inArray(reservations.status, ["Cancelled", "Checked-out"]))
        )
      )
      .orderBy(desc(reservations.arrival));
    return result.map(r => r.reservation);
  }

  async getReservationsForCheckinList(): Promise<Reservation[]> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000); // yesterday
    const windowEnd = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000); // 8 days ahead

    // Only return reservations where the room has at least one room-type lock.
    // Common-area-only rooms are excluded.
    const result = await db
      .selectDistinct({ reservation: reservations })
      .from(reservations)
      .innerJoin(rooms, and(eq(reservations.roomId, rooms.id), eq(rooms.tenantId, this.tenantId)))
      .innerJoin(
        roomLockAssignments,
        and(
          eq(rooms.id, roomLockAssignments.roomId),
          eq(roomLockAssignments.tenantId, this.tenantId)
        )
      )
      .innerJoin(
        lockDevices,
        eq(roomLockAssignments.lockDeviceId, lockDevices.id)
      )
      .where(
        and(
          eq(reservations.tenantId, this.tenantId),
          eq(lockDevices.lockType, "room"),
          gte(reservations.arrival, windowStart),
          lt(reservations.arrival, windowEnd),
          not(inArray(reservations.status, ["Cancelled", "Checked-out"]))
        )
      )
      .orderBy(reservations.arrival);

    return result.map(r => r.reservation);
  }

  // Pins
  async getAllPins(): Promise<Pin[]> {
    return await db.select().from(pins).where(eq(pins.tenantId, this.tenantId));
  }

  async getPin(id: string): Promise<Pin | undefined> {
    const [pin] = await db.select().from(pins).where(and(eq(pins.id, id), eq(pins.tenantId, this.tenantId)));
    return pin || undefined;
  }

  async getPinsByRoomId(roomId: string): Promise<Pin[]> {
    return await db.select().from(pins).where(and(eq(pins.roomId, roomId), eq(pins.tenantId, this.tenantId)));
  }

  async getPinsByReservationId(reservationId: string): Promise<Pin[]> {
    return await db.select().from(pins).where(and(eq(pins.reservationId, reservationId), eq(pins.tenantId, this.tenantId)));
  }

  // Bulk variant (perf 23/7): arrivals/reservations enrichment used to fetch
  // ALL pins (2400+ rows with heavy keyId jsonb) just to look up the day's
  // 40 reservations.
  async getPinsByReservationIds(reservationIds: string[]): Promise<Pin[]> {
    if (reservationIds.length === 0) return [];
    return await db.select().from(pins).where(and(inArray(pins.reservationId, reservationIds), eq(pins.tenantId, this.tenantId)));
  }

  async getPendingPinsForTodayArrivals(): Promise<(Pin & { reservation: Reservation })[]> {
    const timezoneSetting = await this.getSetting('property_timezone');
    const timezone = timezoneSetting?.value || 'Europe/Copenhagen';

    const nowInZone = DateTime.now().setZone(timezone);
    const tomorrowStart = nowInZone.plus({ days: 1 }).startOf('day').toJSDate();
    const now = nowInZone.toJSDate();

    // Include today's arrivals AND overdue pending pins (arrived in past, guest still staying)
    const results = await db
      .select({
        pin: pins,
        reservation: reservations,
      })
      .from(pins)
      .innerJoin(reservations, eq(pins.reservationId, reservations.id))
      .where(
        and(
          eq(pins.tenantId, this.tenantId),
          eq(pins.status, "pending"),
          lt(reservations.arrival, tomorrowStart),   // arrival is today or earlier
          gt(reservations.departure, now)             // guest hasn't checked out yet
        )
      );

    return results.map(r => ({ ...r.pin, reservation: r.reservation }));
  }

  async getActivePins(): Promise<Pin[]> {
    return await db.select().from(pins).where(and(eq(pins.tenantId, this.tenantId), eq(pins.status, "active")));
  }

  async getRepairablePins(): Promise<Pin[]> {
    // Active pins plus "used" ones still inside their validity window — a guest
    // who has already unlocked once (status flips to "used" via lock-arrival)
    // must still get missing locks repaired for the rest of the stay.
    return await db.select().from(pins).where(and(
      eq(pins.tenantId, this.tenantId),
      inArray(pins.status, ["active", "used"]),
      gt(pins.validTo, new Date()),
    ));
  }

  async getPinsWithDeleteFailed(): Promise<Pin[]> {
    return await db.select().from(pins).where(and(eq(pins.tenantId, this.tenantId), eq(pins.status, "delete_failed")));
  }

  async getCompletedUpsellsSince(since: Date): Promise<Array<typeof earlyCheckins.$inferSelect>> {
    // Paid upsells (early check-in / late check-out) completed since `since` —
    // used by the arrival report's revenue line.
    return await db.select().from(earlyCheckins).where(and(
      eq(earlyCheckins.tenantId, this.tenantId),
      eq(earlyCheckins.status, "completed"),
      gte(earlyCheckins.completedAt, since),
    )).orderBy(earlyCheckins.completedAt);
  }

  async getMappedReservationsByDepartureRange(startDate: Date, endDate: Date): Promise<Reservation[]> {
    // Departing guests in [start, end) with a mapped room lock — the
    // late-checkout marketing audience (mirror of the arrival-range query).
    const result = await db
      .selectDistinct({ reservation: reservations })
      .from(reservations)
      .innerJoin(rooms, and(eq(reservations.roomId, rooms.id), eq(rooms.tenantId, this.tenantId)))
      .innerJoin(roomLockAssignments, and(eq(rooms.id, roomLockAssignments.roomId), eq(roomLockAssignments.tenantId, this.tenantId)))
      .innerJoin(lockDevices, eq(roomLockAssignments.lockDeviceId, lockDevices.id))
      .where(
        and(
          eq(reservations.tenantId, this.tenantId),
          eq(lockDevices.lockType, "room"),
          gte(reservations.departure, startDate),
          lt(reservations.departure, endDate)
        )
      )
      .orderBy(desc(reservations.departure));
    return result.map(r => r.reservation);
  }

  async getUpsellsByReservationIds(reservationIds: string[]): Promise<Array<typeof earlyCheckins.$inferSelect>> {
    if (reservationIds.length === 0) return [];
    return await db.select().from(earlyCheckins).where(and(
      eq(earlyCheckins.tenantId, this.tenantId),
      inArray(earlyCheckins.reservationId, reservationIds),
    ));
  }

  async getMarketingSentReservationIds(campaign: string): Promise<Set<string>> {
    const rows = await db.select({ reservationId: marketingSends.reservationId }).from(marketingSends).where(and(
      eq(marketingSends.tenantId, this.tenantId),
      eq(marketingSends.campaign, campaign),
      eq(marketingSends.status, "sent"),
    ));
    // reservationId is null once the reservation is purged post-checkout —
    // those rows are history only, never dedupe candidates.
    return new Set(rows.map(r => r.reservationId).filter((id): id is string => id !== null));
  }

  async createMarketingSendClaim(row: Omit<InsertMarketingSend, "tenantId">): Promise<MarketingSend | undefined> {
    // Claim-then-send: the partial unique index (reservation, campaign) WHERE
    // status='sent' makes this the race guard — undefined = already claimed.
    const inserted = await db
      .insert(marketingSends)
      .values({ ...row, tenantId: this.tenantId })
      .onConflictDoNothing()
      .returning();
    return inserted[0];
  }

  async updateMarketingSend(id: string, patch: Partial<Pick<MarketingSend, "status" | "error" | "sentTo">>): Promise<void> {
    await db.update(marketingSends).set(patch).where(and(
      eq(marketingSends.id, id),
      eq(marketingSends.tenantId, this.tenantId),
    ));
  }

  async getMarketingSendsWithReservations(limit = 100): Promise<Array<MarketingSend & { guestName: string }>> {
    const rows = await db
      .select({ send: marketingSends, firstName: reservations.firstName, lastName: reservations.lastName })
      .from(marketingSends)
      .leftJoin(reservations, eq(marketingSends.reservationId, reservations.id))
      .where(eq(marketingSends.tenantId, this.tenantId))
      .orderBy(desc(marketingSends.sentAt))
      .limit(limit);
    return rows.map(r => ({
      ...r.send,
      guestName: r.send.guestName || `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || "(departed guest)",
    }));
  }

  async getMarketingDailyHistory(days: number, tz: string): Promise<Array<{ day: string; campaign: string; sent: number; failed: number }>> {
    // sent_at is naive UTC — shift to hotel-local before bucketing by day.
    const result = await db.execute(sql`
      SELECT to_char(sent_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day,
             campaign,
             count(*) FILTER (WHERE status = 'sent')::int AS sent,
             count(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM marketing_sends
      WHERE tenant_id = ${this.tenantId}
        AND sent_at >= now() AT TIME ZONE 'UTC' - make_interval(days => ${days})
      GROUP BY 1, 2
      ORDER BY 1`);
    return result.rows as Array<{ day: string; campaign: string; sent: number; failed: number }>;
  }

  async getUpsellDailyHistory(days: number, tz: string): Promise<Array<{ day: string; kind: string; purchases: number; revenue: number }>> {
    const result = await db.execute(sql`
      SELECT to_char(completed_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day,
             kind,
             count(*)::int AS purchases,
             COALESCE(sum(NULLIF(amount, '')::numeric), 0)::float AS revenue
      FROM early_checkins
      WHERE tenant_id = ${this.tenantId}
        AND status = 'completed'
        AND completed_at IS NOT NULL
        AND completed_at >= now() AT TIME ZONE 'UTC' - make_interval(days => ${days})
      GROUP BY 1, 2
      ORDER BY 1`);
    return result.rows as Array<{ day: string; kind: string; purchases: number; revenue: number }>;
  }

  async getDeletedPinsWithinValidity(): Promise<Pin[]> {
    // "deleted" is the legacy ad-hoc status the old orphan cleanup wrote — it is
    // outside the official status set and invisible to every repair mechanism.
    // This query exists solely for the one-shot recovery of wrongly-deleted pins.
    return await db.select().from(pins).where(and(
      eq(pins.tenantId, this.tenantId),
      eq(pins.status, "deleted"),
      gt(pins.validTo, new Date()),
    ));
  }

  // ── Hourly bookings (standalone, outside MEWS) ──────────────────────────

  async getHourlyBookings(limit: number = 200): Promise<HourlyBooking[]> {
    return await db.select().from(hourlyBookings)
      .where(eq(hourlyBookings.tenantId, this.tenantId))
      .orderBy(desc(hourlyBookings.startAt))
      .limit(limit);
  }

  async getHourlyBooking(id: string): Promise<HourlyBooking | undefined> {
    const [row] = await db.select().from(hourlyBookings)
      .where(and(eq(hourlyBookings.id, id), eq(hourlyBookings.tenantId, this.tenantId)));
    return row || undefined;
  }

  // Match a MEWS reservation to the hourly booking that CREATED it — used by
  // the ingestion guard so our own hourly-driven MEWS reservations are never
  // ingested as regular guest reservations (second pin + door-code messages).
  async getHourlyBookingByMewsReservationId(pmsReservationId: string): Promise<HourlyBooking | undefined> {
    const [row] = await db.select().from(hourlyBookings)
      .where(and(
        eq(hourlyBookings.tenantId, this.tenantId),
        eq(hourlyBookings.mewsReservationId, pmsReservationId),
      ));
    return row || undefined;
  }

  // Overlap: existing.startAt < endAt AND existing.endAt > startAt.
  // Used for availability — callers pass the statuses that block a slot
  // (typically confirmed + pending_payment holds).
  async getHourlyBookingsOverlapping(startAt: Date, endAt: Date, statuses: string[]): Promise<HourlyBooking[]> {
    return await db.select().from(hourlyBookings)
      .where(and(
        eq(hourlyBookings.tenantId, this.tenantId),
        inArray(hourlyBookings.status, statuses),
        lt(hourlyBookings.startAt, endAt),
        gt(hourlyBookings.endAt, startAt),
      ));
  }

  async createHourlyBooking(booking: TenantlessHourlyBookingInput): Promise<HourlyBooking> {
    const [row] = await db.insert(hourlyBookings).values({
      tenantId: this.tenantId,
      ...booking,
    }).returning();
    return row;
  }

  async updateHourlyBooking(id: string, booking: Partial<TenantlessHourlyBookingInput>): Promise<HourlyBooking | undefined> {
    const [row] = await db.update(hourlyBookings)
      .set({ ...booking, updatedAt: new Date() })
      .where(and(eq(hourlyBookings.id, id), eq(hourlyBookings.tenantId, this.tenantId)))
      .returning();
    return row || undefined;
  }

  // Compare-and-set for payment confirmation: the Stripe webhook and the
  // status-poll fallback can race — only ONE caller may win the flip to
  // confirmed (and thus push + deliver the code). Returns undefined when the
  // booking was already confirmed (loser) or doesn't exist.
  async confirmHourlyBookingIfNotConfirmed(id: string, booking: Partial<TenantlessHourlyBookingInput>): Promise<HourlyBooking | undefined> {
    const [row] = await db.update(hourlyBookings)
      .set({ ...booking, updatedAt: new Date() })
      .where(and(
        eq(hourlyBookings.id, id),
        eq(hourlyBookings.tenantId, this.tenantId),
        not(eq(hourlyBookings.status, "confirmed")),
      ))
      .returning();
    return row || undefined;
  }

  async createPin(pin: TenantlessPinInput): Promise<Pin> {
    const rest = pin;
    const [newPin] = await db.insert(pins).values({ 
      tenantId: this.tenantId,
      ...rest 
    }).returning();
    return newPin;
  }

  async updatePin(id: string, pin: Partial<TenantlessPinInput>): Promise<Pin | undefined> {
    const rest = pin;
    const [updated] = await db
      .update(pins)
      .set(rest)
      .where(and(eq(pins.id, id), eq(pins.tenantId, this.tenantId)))
      .returning();
    return updated || undefined;
  }

  async updatePinFirstUsedAt(id: string, firstUsedAt: Date): Promise<Pin | undefined> {
    const [updated] = await db
      .update(pins)
      .set({ firstUsedAt })
      .where(and(eq(pins.id, id), eq(pins.tenantId, this.tenantId)))
      .returning();
    return updated || undefined;
  }

  async deletePin(id: string): Promise<void> {
    await db.delete(pins).where(and(eq(pins.id, id), eq(pins.tenantId, this.tenantId)));
  }

  // Logs
  async createLog(log: TenantlessLogInput): Promise<Log> {
    const rest = log;
    const [newLog] = await db.insert(logs).values({ 
      tenantId: this.tenantId,
      ...rest 
    }).returning();
    return newLog;
  }

  async getLogsByReservation(reservationId: string): Promise<Log[]> {
    return await db.select().from(logs).where(and(eq(logs.reservationId, reservationId), eq(logs.tenantId, this.tenantId))).orderBy(desc(logs.timestamp));
  }

  async getAllLogs(limit: number = 100): Promise<Log[]> {
    return await db.select().from(logs).where(eq(logs.tenantId, this.tenantId)).orderBy(desc(logs.timestamp)).limit(limit);
  }

  // Targeted log fetch for report/funnel readers: getAllLogs' window is easily
  // flooded by repair/offline noise (a single flapping gateway can log
  // hundreds of lines per day), so funnel counters must filter in SQL.
  async getLogsBySourceSince(source: string, since: Date, limit: number = 2000): Promise<Log[]> {
    return await db.select().from(logs)
      .where(and(eq(logs.tenantId, this.tenantId), eq(logs.source, source), gte(logs.timestamp, since)))
      .orderBy(desc(logs.timestamp)).limit(limit);
  }

  // Settings (with caching for performance)
  async getSetting(key: string): Promise<Setting | undefined> {
    // Check cache first
    const cached = this.settingsCache.get(this.tenantId, key);
    if (cached !== null) {
      return cached; // Cache hit (including undefined for non-existent settings)
    }
    
    // Cache miss - fetch from database
    const [setting] = await db.select().from(settings).where(and(eq(settings.tenantId, this.tenantId), eq(settings.key, key)));
    const result = setting || undefined;
    
    // Store in cache
    this.settingsCache.set(this.tenantId, key, result);
    
    return result;
  }

  async setSetting(key: string, value: string): Promise<Setting> {
    const ENCRYPTED_KEYS = [
      "ttlock_api_key",
      "ttlock_username",
      "ttlock_password",
      "mews_client_token",
      "mews_access_token",
      "gateway_api_key",
      "twilio_account_sid",
      "twilio_auth_token",
      "stripe_secret_key",
      "stripe_webhook_secret",
    ];
    
    // Query database directly (bypass cache) to check if setting exists
    const [existingFromDb] = await db.select().from(settings).where(
      and(eq(settings.tenantId, this.tenantId), eq(settings.key, key))
    );
    const existing = existingFromDb || undefined;
    const encrypted = ENCRYPTED_KEYS.includes(key) || (existing?.encrypted ?? false);
    
    let result: Setting;
    if (existing) {
      const [updated] = await db
        .update(settings)
        .set({ value, encrypted, updatedAt: new Date() })
        .where(and(eq(settings.tenantId, this.tenantId), eq(settings.key, key)))
        .returning();
      result = updated;
    } else {
      const [newSetting] = await db
        .insert(settings)
        .values({ tenantId: this.tenantId, key, value, encrypted })
        .returning();
      result = newSetting;
    }
    
    // Update cache with new value
    this.settingsCache.set(this.tenantId, key, result);
    
    return result;
  }

  async getAllSettings(): Promise<Setting[]> {
    return await db.select().from(settings).where(eq(settings.tenantId, this.tenantId));
  }

  // Lock Devices
  async getAllLockDevices(): Promise<LockDevice[]> {
    return await db.select().from(lockDevices).where(eq(lockDevices.tenantId, this.tenantId));
  }

  async getLockDevice(id: string): Promise<LockDevice | undefined> {
    const [device] = await db.select().from(lockDevices).where(and(eq(lockDevices.id, id), eq(lockDevices.tenantId, this.tenantId)));
    return device || undefined;
  }

  async getLockDeviceByTTLockId(ttlockId: string): Promise<LockDevice | undefined> {
    const [device] = await db.select().from(lockDevices).where(and(eq(lockDevices.ttlockId, ttlockId), eq(lockDevices.tenantId, this.tenantId)));
    return device || undefined;
  }

  async createLockDevice(device: TenantlessLockDeviceInput): Promise<LockDevice> {
    const rest = device;
    const [newDevice] = await db.insert(lockDevices).values({ 
      tenantId: this.tenantId,
      ...rest 
    }).returning();
    return newDevice;
  }

  async updateLockDevice(id: string, device: Partial<TenantlessLockDeviceInput>): Promise<LockDevice | undefined> {
    const rest = device;
    const [updated] = await db
      .update(lockDevices)
      .set(rest)
      .where(and(eq(lockDevices.id, id), eq(lockDevices.tenantId, this.tenantId)))
      .returning();
    return updated || undefined;
  }

  async upsertLockDevice(device: TenantlessLockDeviceInput): Promise<LockDevice> {
    const existing = await this.getLockDeviceByTTLockId(device.ttlockId);
    const rest = device;
    if (existing) {
      const [updated] = await db
        .update(lockDevices)
        .set(rest)
        .where(and(eq(lockDevices.ttlockId, device.ttlockId), eq(lockDevices.tenantId, this.tenantId)))
        .returning();
      return updated;
    } else {
      return await this.createLockDevice(device);
    }
  }

  async syncLockDeviceFromTTLock(
    ttlockId: string,
    ttlockData: { name: string; mac: string; battery: number }
  ): Promise<LockDevice> {
    const existing = await this.getLockDeviceByTTLockId(ttlockId);
    if (existing) {
      const [updated] = await db
        .update(lockDevices)
        .set({
          name: ttlockData.name,
          mac: ttlockData.mac,
          battery: ttlockData.battery,
          lastSync: new Date(),
        })
        .where(and(eq(lockDevices.ttlockId, ttlockId), eq(lockDevices.tenantId, this.tenantId)))
        .returning();
      return updated;
    } else{
      const [newDevice] = await db
        .insert(lockDevices)
        .values({
          tenantId: this.tenantId,
          name: ttlockData.name,
          mac: ttlockData.mac,
          battery: ttlockData.battery,
          lockType: "room",
          isLinked: false,
          ttlockId: ttlockId,
          lastSync: new Date(),
        })
        .returning();
      return newDevice;
    }
  }

  async deleteLockDevice(id: string): Promise<void> {
    // First delete any room lock assignments for this device
    await db.delete(roomLockAssignments)
      .where(and(
        eq(roomLockAssignments.lockDeviceId, id),
        eq(roomLockAssignments.tenantId, this.tenantId)
      ));
    
    // Then delete the lock device itself
    await db.delete(lockDevices)
      .where(and(
        eq(lockDevices.id, id),
        eq(lockDevices.tenantId, this.tenantId)
      ));
  }

  async mapLockDeviceToRoom(
    deviceTtlockId: string,
    newRoomId: string | null
  ): Promise<{ previousRoom: Room | null; newRoom: Room | null; error?: string }> {
    return await db.transaction(async (tx) => {
      const allRooms = await tx.select().from(rooms).where(eq(rooms.tenantId, this.tenantId));
      const previousRoom = allRooms.find(r => r.ttlockId === deviceTtlockId) || null;

      if (newRoomId) {
        const targetRoom = allRooms.find(r => r.id === newRoomId);
        if (!targetRoom) {
          throw new Error(`Room with id ${newRoomId} not found`);
        }
        if (targetRoom.ttlockId && targetRoom.ttlockId !== deviceTtlockId) {
          return {
            previousRoom,
            newRoom: null,
            error: `Room "${targetRoom.name}" is already mapped to lock device ${targetRoom.ttlockId}`,
          };
        }
      }

      if (previousRoom) {
        const prevResult = await tx
          .update(rooms)
          .set({ ttlockId: null })
          .where(and(eq(rooms.id, previousRoom.id), eq(rooms.tenantId, this.tenantId)))
          .returning();
        
        if (prevResult.length === 0) {
          throw new Error(`Failed to clear previous room mapping for room ${previousRoom.id}`);
        }
      }

      let newRoom: Room | null = null;
      if (newRoomId) {
        const updated = await tx
          .update(rooms)
          .set({ ttlockId: deviceTtlockId })
          .where(and(eq(rooms.id, newRoomId), eq(rooms.tenantId, this.tenantId)))
          .returning();
        
        if (updated.length === 0) {
          throw new Error(`Failed to map lock device to room ${newRoomId}`);
        }
        newRoom = updated[0];
      }

      return { previousRoom, newRoom, error: undefined };
    });
  }

  async updateLockDeviceWithMapping(
    deviceId: string,
    metadata: { name: string; lockType: string; doorName?: string | null },
    newRoomId: string | null | undefined
  ): Promise<{ device: LockDevice; previousRoom: Room | null; newRoom: Room | null; error?: string }> {
    return await db.transaction(async (tx) => {
      const [currentDevice] = await tx.select().from(lockDevices).where(and(eq(lockDevices.id, deviceId), eq(lockDevices.tenantId, this.tenantId)));
      if (!currentDevice) {
        throw new Error(`Lock device with id ${deviceId} not found`);
      }

      const updateData: Record<string, unknown> = { name: metadata.name, lockType: metadata.lockType };
      if (metadata.doorName !== undefined) updateData.doorName = metadata.doorName;
      const [updatedDevice] = await tx
        .update(lockDevices)
        .set(updateData)
        .where(and(eq(lockDevices.id, deviceId), eq(lockDevices.tenantId, this.tenantId)))
        .returning();

      if (!updatedDevice) {
        throw new Error(`Failed to update lock device ${deviceId}`);
      }

      if (newRoomId === undefined) {
        return { device: updatedDevice, previousRoom: null, newRoom: null, error: undefined };
      }

      const allRooms = await tx.select().from(rooms).where(eq(rooms.tenantId, this.tenantId));
      const previousRoom = allRooms.find(r => r.ttlockId === updatedDevice.ttlockId) || null;

      if (newRoomId) {
        const targetRoom = allRooms.find(r => r.id === newRoomId);
        if (!targetRoom) {
          throw new Error(`Room with id ${newRoomId} not found`);
        }
        if (targetRoom.ttlockId && targetRoom.ttlockId !== updatedDevice.ttlockId) {
          throw new Error(`Room "${targetRoom.name}" is already mapped to another lock device`);
        }
      }

      if (previousRoom) {
        const prevResult = await tx
          .update(rooms)
          .set({ ttlockId: null })
          .where(and(eq(rooms.id, previousRoom.id), eq(rooms.tenantId, this.tenantId)))
          .returning();
        
        if (prevResult.length === 0) {
          throw new Error(`Failed to clear previous room mapping`);
        }
      }

      let newRoom: Room | null = null;
      if (newRoomId) {
        const updated = await tx
          .update(rooms)
          .set({ ttlockId: updatedDevice.ttlockId })
          .where(and(eq(rooms.id, newRoomId), eq(rooms.tenantId, this.tenantId)))
          .returning();
        
        if (updated.length === 0) {
          throw new Error(`Failed to map lock device to room`);
        }
        newRoom = updated[0];
      }

      return { device: updatedDevice, previousRoom, newRoom, error: undefined };
    });
  }

  async getAvailableLockDevicesForSpace(spaceId: string): Promise<LockDevice[]> {
    const space = await this.getRoom(spaceId);
    if (!space) {
      return [];
    }
    
    const allDevices = await this.getAllLockDevices();
    const allAssignments = await db
      .select()
      .from(roomLockAssignments)
      .where(eq(roomLockAssignments.tenantId, this.tenantId));

    // Capsule/dormitory tenants may share one room lock across several spaces.
    const sharedRoomLocksAllowed = await this.allowSharedRoomLocks();

    return allDevices.filter(device => {
      if (device.lockType === "common") {
        return true;
      }
      const deviceAssignments = allAssignments.filter(a => a.lockDeviceId === device.id);
      if (deviceAssignments.length === 0) {
        return true;
      }
      const isAssignedToThisSpace = deviceAssignments.some(a => a.roomId === spaceId);
      const isAssignedToOtherSpaces = deviceAssignments.some(a => a.roomId !== spaceId);
      if (isAssignedToOtherSpaces && !sharedRoomLocksAllowed) {
        return false;
      }
      return isAssignedToThisSpace || isAssignedToOtherSpaces || deviceAssignments.length === 0;
    });
  }

  // Reservation Logs
  async getReservationLogs(reservationId: string): Promise<ReservationLog[]> {
    return await db.select().from(reservationLogs).where(and(eq(reservationLogs.reservationId, reservationId), eq(reservationLogs.tenantId, this.tenantId))).orderBy(desc(reservationLogs.timestamp));
  }

  async createReservationLog(log: TenantlessReservationLogInput): Promise<ReservationLog> {
    const rest = log;
    const [newLog] = await db.insert(reservationLogs).values({ 
      tenantId: this.tenantId,
      ...rest 
    }).returning();
    return newLog;
  }

  // QR Codes
  async getQrCodesByRoom(roomId: string): Promise<QrCode[]> {
    return await db.select().from(qrCodes).where(and(eq(qrCodes.roomId, roomId || ""), eq(qrCodes.tenantId, this.tenantId)));
  }

  async createQrCode(code: TenantlessQrCodeInput): Promise<QrCode> {
    const rest = code;
    const [newCode] = await db.insert(qrCodes).values({ 
      tenantId: this.tenantId,
      ...rest 
    }).returning();
    return newCode;
  }

  // Room Lock Assignments
  async isRoomMapped(roomId: string): Promise<boolean> {
    // A room is mapped only if it has at least one "room"-type lock assignment.
    // Common-area-only locks (e.g. Street Entrance) are NOT sufficient — they don't
    // give the guest access to their private room, so PIN creation, boarding cards,
    // and pre-checkin emails should NOT be triggered for common-area-only rooms.
    const result = await db
      .select({ id: roomLockAssignments.id })
      .from(roomLockAssignments)
      .innerJoin(lockDevices, eq(roomLockAssignments.lockDeviceId, lockDevices.id))
      .where(
        and(
          eq(roomLockAssignments.roomId, roomId),
          eq(roomLockAssignments.tenantId, this.tenantId),
          eq(lockDevices.lockType, "room")
        )
      )
      .limit(1);
    return result.length > 0;
  }

  async getRoomLockAssignments(roomId: string): Promise<(RoomLockAssignment & { lockDevice: LockDevice })[]> {
    const result = await db
      .select({
        assignment: roomLockAssignments,
        lockDevice: lockDevices,
      })
      .from(roomLockAssignments)
      .innerJoin(lockDevices, eq(roomLockAssignments.lockDeviceId, lockDevices.id))
      .where(and(
        eq(roomLockAssignments.roomId, roomId),
        eq(roomLockAssignments.tenantId, this.tenantId)
      ));
    
    return result.map(r => ({
      ...r.assignment,
      lockDevice: r.lockDevice,
    }));
  }

  async getLockDeviceAssignments(lockDeviceId: string): Promise<(RoomLockAssignment & { room: Room })[]> {
    const result = await db
      .select({
        assignment: roomLockAssignments,
        room: rooms,
      })
      .from(roomLockAssignments)
      .innerJoin(rooms, eq(roomLockAssignments.roomId, rooms.id))
      .where(and(
        eq(roomLockAssignments.lockDeviceId, lockDeviceId),
        eq(roomLockAssignments.tenantId, this.tenantId)
      ));
    
    return result.map(r => ({
      ...r.assignment,
      room: r.room,
    }));
  }

  async getAllRoomLockAssignments(): Promise<(RoomLockAssignment & { room: Room; lockDevice: LockDevice })[]> {
    const result = await db
      .select({
        assignment: roomLockAssignments,
        room: rooms,
        lockDevice: lockDevices,
      })
      .from(roomLockAssignments)
      .innerJoin(rooms, eq(roomLockAssignments.roomId, rooms.id))
      .innerJoin(lockDevices, eq(roomLockAssignments.lockDeviceId, lockDevices.id))
      .where(eq(roomLockAssignments.tenantId, this.tenantId));
    
    return result.map(r => ({
      ...r.assignment,
      room: r.room,
      lockDevice: r.lockDevice,
    }));
  }

  // True when this tenant runs capsule/dormitory-style: several MEWS spaces may share
  // one physical room lock, so the "one room lock = one space" guard must be skipped.
  private async allowSharedRoomLocks(): Promise<boolean> {
    return (await this.getSetting('allow_shared_room_locks'))?.value === 'true';
  }

  async createRoomLockAssignment(assignment: TenantlessRoomLockAssignmentInput): Promise<RoomLockAssignment> {
    // Check if this is a room-type lock that's already assigned to a different space.
    // Capsule/dormitory hotels (allow_shared_room_locks=true) legitimately have several
    // MEWS spaces behind one physical lock, so the exclusivity guard is skipped for them.
    const lockDevice = await this.getLockDevice(assignment.lockDeviceId);
    if (lockDevice && lockDevice.lockType === 'room' && !(await this.allowSharedRoomLocks())) {
      const existingAssignments = await this.getLockDeviceAssignments(assignment.lockDeviceId);
      const assignedToOther = existingAssignments.some(a => a.roomId !== assignment.roomId);
      if (assignedToOther) {
        throw new Error(`Room lock "${lockDevice.name}" is already assigned to another space. Room locks can only be assigned to one space.`);
      }
    }

    // A common door named after a room ("411 Room") belongs to that room only —
    // the exclusivity guard above never covers it, so check the space names.
    if (lockDevice) {
      const room = await this.getRoom(assignment.roomId);
      const outside = room ? spacesOutsideRoomScopedLock(lockDevice.name, [room.name]) : [];
      if (outside.length > 0) {
        throw new Error(`Lock "${lockDevice.name}" is room ${lockDevice.name.replace(/\s*room\s*$/i, "")}'s own door and cannot be assigned to space ${outside[0]}.`);
      }
    }

    const [newAssignment] = await db.insert(roomLockAssignments).values({
      tenantId: this.tenantId,
      ...assignment,
    }).returning();
    return newAssignment;
  }

  async deleteRoomLockAssignment(id: string): Promise<void> {
    await db.delete(roomLockAssignments).where(and(
      eq(roomLockAssignments.id, id),
      eq(roomLockAssignments.tenantId, this.tenantId)
    ));
  }

  async deleteRoomLockAssignmentByRoomAndDevice(roomId: string, lockDeviceId: string): Promise<void> {
    await db.delete(roomLockAssignments).where(and(
      eq(roomLockAssignments.roomId, roomId),
      eq(roomLockAssignments.lockDeviceId, lockDeviceId),
      eq(roomLockAssignments.tenantId, this.tenantId)
    ));
  }

  async createRoomLockAssignmentsBulk(assignments: TenantlessRoomLockAssignmentInput[]): Promise<RoomLockAssignment[]> {
    if (assignments.length === 0) return [];

    // Capsule/dormitory hotels allow multiple MEWS spaces behind one physical lock.
    const allowSharedRoomLocks = await this.allowSharedRoomLocks();

    return await db.transaction(async (tx) => {
      // Group assignments by lock device ID to check room lock exclusivity
      const lockDeviceIds = Array.from(new Set(assignments.map(a => a.lockDeviceId)));

      for (const lockDeviceId of lockDeviceIds) {
        const [lockDevice] = await tx.select().from(lockDevices)
          .where(and(eq(lockDevices.id, lockDeviceId), eq(lockDevices.tenantId, this.tenantId)));

        if (lockDevice && lockDevice.lockType === 'room' && !allowSharedRoomLocks) {
          // Get existing assignments for this lock
          const existingAssignments = await tx.select({ roomId: roomLockAssignments.roomId })
            .from(roomLockAssignments)
            .where(and(
              eq(roomLockAssignments.lockDeviceId, lockDeviceId),
              eq(roomLockAssignments.tenantId, this.tenantId)
            ));

          // Get room IDs from the new assignments for this lock
          const newRoomIds = assignments.filter(a => a.lockDeviceId === lockDeviceId).map(a => a.roomId);

          // Check if already assigned to a different space
          const assignedToOther = existingAssignments.some(a => !newRoomIds.includes(a.roomId));
          if (assignedToOther) {
            throw new Error(`Room lock "${lockDevice.name}" is already assigned to another space. Room locks can only be assigned to one space.`);
          }

          // Also check if trying to assign to multiple spaces in this batch
          const uniqueRoomIds = Array.from(new Set(newRoomIds));
          if (uniqueRoomIds.length > 1) {
            throw new Error(`Room lock "${lockDevice.name}" cannot be assigned to multiple spaces. Room locks can only be assigned to one space.`);
          }
        }

        // Room-scoped common door ("411 Room") → only that room's own spaces.
        if (lockDevice) {
          const batchRoomIds = Array.from(new Set(
            assignments.filter(a => a.lockDeviceId === lockDeviceId).map(a => a.roomId)
          ));
          const batchRooms = await tx.select({ name: rooms.name }).from(rooms)
            .where(and(inArray(rooms.id, batchRoomIds), eq(rooms.tenantId, this.tenantId)));
          const outside = spacesOutsideRoomScopedLock(lockDevice.name, batchRooms.map(r => r.name));
          if (outside.length > 0) {
            throw new Error(`Lock "${lockDevice.name}" is room ${lockDevice.name.replace(/\s*room\s*$/i, "")}'s own door and cannot be assigned to space${outside.length > 1 ? "s" : ""} ${outside.join(", ")}.`);
          }
        }
      }

      const values = assignments.map(a => ({
        tenantId: this.tenantId,
        ...a,
      }));
      return await tx.insert(roomLockAssignments).values(values).returning();
    });
  }

  async deleteRoomLockAssignmentsBulk(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await db.delete(roomLockAssignments).where(and(
      inArray(roomLockAssignments.id, ids),
      eq(roomLockAssignments.tenantId, this.tenantId)
    ));
  }

  // Ekeys
  async getEkeysByReservation(reservationId: string): Promise<Ekey[]> {
    return await db.select().from(ekeys).where(
      and(
        eq(ekeys.tenantId, this.tenantId),
        eq(ekeys.reservationId, reservationId)
      )
    );
  }

  async createEkey(ekey: TenantlessEkeyInput): Promise<Ekey> {
    const [newEkey] = await db.insert(ekeys).values({
      tenantId: this.tenantId,
      ...ekey
    }).returning();
    return newEkey;
  }

  async createEkeysBulk(ekeyInputs: TenantlessEkeyInput[]): Promise<Ekey[]> {
    if (ekeyInputs.length === 0) return [];
    const values = ekeyInputs.map(ekey => ({
      tenantId: this.tenantId,
      ...ekey
    }));
    return await db.insert(ekeys).values(values).returning();
  }

  async deleteEkeysByReservation(reservationId: string): Promise<void> {
    await db.delete(ekeys).where(
      and(
        eq(ekeys.tenantId, this.tenantId),
        eq(ekeys.reservationId, reservationId)
      )
    );
  }

  async getReservationWithLocks(reservationNumber: string, lastName: string): Promise<{
    reservation: Reservation;
    pin: Pin | null;
    locks: Array<{ id: string; ttlockId: string; name: string; lockType: string; doorName: string | null; connectedRoomsCount: number }>;
  } | null> {
    const result = await this.getReservationByNumberAndName(reservationNumber, lastName);
    if (!result) {
      return null;
    }

    const { reservation, pin } = result;

    if (!reservation.roomId) {
      return { reservation, pin, locks: [] };
    }

    // If the current room is not mapped (no room-type lock), the guest has no
    // valid access — e.g. staff moved reservation from a mapped room to an
    // unmapped one. The old PIN has been deleted from TTLock and the new room
    // has no private lock to program. Return no pin and no locks so the
    // boarding pass does not display a stale code.
    // Fetch lock assignments once; a room is "mapped" iff it has a room-type lock.
    // Derive it from the assignments instead of a separate isRoomMapped query.
    const lockAssignments = await this.getRoomLockAssignments(reservation.roomId);
    const roomIsMapped = lockAssignments.some(a => a.lockDevice.lockType === "room");
    if (!roomIsMapped) {
      return { reservation, pin: null, locks: [] };
    }

    // Count how many rooms each lock device is connected to (for sorting common area doors)
    const lockDeviceIds = lockAssignments.map(a => a.lockDevice.id);
    const roomCountRows = lockDeviceIds.length > 0
      ? await db
          .select({ lockDeviceId: roomLockAssignments.lockDeviceId, roomCount: count() })
          .from(roomLockAssignments)
          .where(and(
            inArray(roomLockAssignments.lockDeviceId, lockDeviceIds),
            eq(roomLockAssignments.tenantId, this.tenantId)
          ))
          .groupBy(roomLockAssignments.lockDeviceId)
      : [];
    const countByLock = new Map(roomCountRows.map(r => [r.lockDeviceId, r.roomCount]));

    const locks = lockAssignments
      .filter(a => a.lockDevice.ttlockId)
      .map(a => ({
        id: a.lockDevice.id,
        ttlockId: a.lockDevice.ttlockId!,
        name: a.lockDevice.name,
        lockType: a.lockDevice.lockType,
        doorName: a.lockDevice.doorName ?? null,
        connectedRoomsCount: countByLock.get(a.lockDevice.id) ?? 1,
      }));

    return { reservation, pin, locks };
  }
}

// Global tenant operations (not scoped to a single tenant)
export interface IGlobalTenantOperations {
  getAllTenants(): Promise<Tenant[]>;
  getTenant(id: string): Promise<Tenant | undefined>;
  getTenantBySlug(slug: string): Promise<Tenant | undefined>;
  getTenantByApiKey(apiKey: string): Promise<Tenant | undefined>;
  // Cross-tenant lookup by the globally-unique pre-check-in token (resolves the
  // owning tenant for unscoped public check-in routes).
  findReservationByPreCheckinToken(token: string): Promise<Reservation | undefined>;
  createTenant(tenant: InsertTenant): Promise<Tenant>;
  updateTenant(id: string, tenant: Partial<InsertTenant>): Promise<Tenant | undefined>;
  deleteTenant(id: string): Promise<void>;
  getTenantStats(tenantId: string): Promise<{
    reservationCount: number;
    activeReservationCount: number;
    pinCount: number;
    activePinCount: number;
    roomCount: number;
    lockDeviceCount: number;
    lastError: Log | null;
  }>;
  
  // Invitation operations
  createInvitation(invitation: InsertVendorInvitation): Promise<VendorInvitation>;
  getInvitationByToken(token: string): Promise<VendorInvitation | undefined>;
  getInvitationsByTenant(tenantId: string): Promise<VendorInvitation[]>;
  getAllInvitations(): Promise<VendorInvitation[]>;
  markInvitationUsed(token: string): Promise<VendorInvitation | undefined>;
  deleteInvitation(id: string): Promise<void>;

  // Session operations
  createSession(data: InsertSession): Promise<Session>;
  getSessionByToken(token: string): Promise<Session | null>;
  deleteSession(token: string): Promise<void>;
  cleanupExpiredSessions(): Promise<number>;
}

class GlobalTenantStorage implements IGlobalTenantOperations {
  async getAllTenants(): Promise<Tenant[]> {
    return await db.select().from(tenants).orderBy(tenants.name);
  }

  async getTenant(id: string): Promise<Tenant | undefined> {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id));
    return tenant || undefined;
  }

  async getTenantBySlug(slug: string): Promise<Tenant | undefined> {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, slug));
    return tenant || undefined;
  }

  async getTenantByApiKey(apiKey: string): Promise<Tenant | undefined> {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.apiKey, apiKey));
    return tenant || undefined;
  }

  async findReservationByPreCheckinToken(token: string): Promise<Reservation | undefined> {
    // preCheckinToken is globally unique (no tenant filter) — used to resolve the
    // owning tenant on the unscoped public check-in routes.
    const [reservation] = await db.select().from(reservations).where(eq(reservations.preCheckinToken, token));
    return reservation || undefined;
  }

  async createTenant(tenant: InsertTenant): Promise<Tenant> {
    const [newTenant] = await db.insert(tenants).values(tenant).returning();
    return newTenant;
  }

  async updateTenant(id: string, tenant: Partial<InsertTenant>): Promise<Tenant | undefined> {
    const [updated] = await db
      .update(tenants)
      .set({ ...tenant, updatedAt: new Date() })
      .where(eq(tenants.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteTenant(id: string): Promise<void> {
    await db.delete(tenants).where(eq(tenants.id, id));
  }

  async getTenantStats(tenantId: string): Promise<{
    reservationCount: number;
    activeReservationCount: number;
    pinCount: number;
    activePinCount: number;
    roomCount: number;
    lockDeviceCount: number;
    lastError: Log | null;
  }> {
    const [reservationStats] = await db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${reservations.status} in ('Confirmed', 'Checked-in'))::int`,
      })
      .from(reservations)
      .where(eq(reservations.tenantId, tenantId));

    const [pinStats] = await db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${pins.status} = 'active')::int`,
      })
      .from(pins)
      .where(eq(pins.tenantId, tenantId));

    const [roomStats] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(rooms)
      .where(eq(rooms.tenantId, tenantId));

    const [lockStats] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(lockDevices)
      .where(eq(lockDevices.tenantId, tenantId));

    const [lastError] = await db
      .select()
      .from(logs)
      .where(and(eq(logs.tenantId, tenantId), eq(logs.level, "error")))
      .orderBy(desc(logs.timestamp))
      .limit(1);

    const [lastSuccess] = await db
      .select()
      .from(logs)
      .where(and(eq(logs.tenantId, tenantId), eq(logs.level, "info")))
      .orderBy(desc(logs.timestamp))
      .limit(1);

    // Only show the error if it occurred after the last successful operation
    const errorIsStale =
      lastError &&
      lastSuccess &&
      new Date(lastSuccess.timestamp) > new Date(lastError.timestamp);

    return {
      reservationCount: reservationStats?.total || 0,
      activeReservationCount: reservationStats?.active || 0,
      pinCount: pinStats?.total || 0,
      activePinCount: pinStats?.active || 0,
      roomCount: roomStats?.count || 0,
      lockDeviceCount: lockStats?.count || 0,
      lastError: errorIsStale ? null : (lastError || null),
    };
  }

  // Invitation operations
  async createInvitation(invitation: InsertVendorInvitation): Promise<VendorInvitation> {
    const [newInvitation] = await db.insert(vendorInvitations).values(invitation).returning();
    return newInvitation;
  }

  async getInvitationByToken(token: string): Promise<VendorInvitation | undefined> {
    const [invitation] = await db.select().from(vendorInvitations).where(eq(vendorInvitations.token, token));
    return invitation || undefined;
  }

  async getInvitationsByTenant(tenantId: string): Promise<VendorInvitation[]> {
    return await db.select().from(vendorInvitations)
      .where(eq(vendorInvitations.tenantId, tenantId))
      .orderBy(desc(vendorInvitations.createdAt));
  }

  async getAllInvitations(): Promise<VendorInvitation[]> {
    return await db.select().from(vendorInvitations).orderBy(desc(vendorInvitations.createdAt));
  }

  async markInvitationUsed(token: string): Promise<VendorInvitation | undefined> {
    const [updated] = await db
      .update(vendorInvitations)
      .set({ usedAt: new Date() })
      .where(eq(vendorInvitations.token, token))
      .returning();
    return updated || undefined;
  }

  async deleteInvitation(id: string): Promise<void> {
    await db.delete(vendorInvitations).where(eq(vendorInvitations.id, id));
  }

  // Hotel User operations
  async getHotelUserByEmail(email: string): Promise<HotelUser | undefined> {
    const [user] = await db.select().from(hotelUsers).where(eq(hotelUsers.email, email.toLowerCase()));
    return user || undefined;
  }

  async getHotelUser(id: string): Promise<HotelUser | undefined> {
    const [user] = await db.select().from(hotelUsers).where(eq(hotelUsers.id, id));
    return user || undefined;
  }

  async getHotelUsersByTenant(tenantId: string): Promise<HotelUser[]> {
    return await db.select().from(hotelUsers)
      .where(eq(hotelUsers.tenantId, tenantId))
      .orderBy(hotelUsers.name);
  }

  async createHotelUser(user: InsertHotelUser): Promise<HotelUser> {
    const [newUser] = await db.insert(hotelUsers).values({
      ...user,
      email: user.email.toLowerCase(),
    }).returning();
    return newUser;
  }

  async updateHotelUser(id: string, data: Partial<InsertHotelUser>): Promise<HotelUser | undefined> {
    const updateData = { ...data };
    if (updateData.email) {
      updateData.email = updateData.email.toLowerCase();
    }
    const [updated] = await db.update(hotelUsers)
      .set(updateData)
      .where(eq(hotelUsers.id, id))
      .returning();
    return updated || undefined;
  }

  async updateHotelUserLastLogin(id: string): Promise<void> {
    await db.update(hotelUsers)
      .set({ lastLoginAt: new Date() })
      .where(eq(hotelUsers.id, id));
  }

  async deleteHotelUser(id: string): Promise<void> {
    await db.delete(hotelUsers).where(eq(hotelUsers.id, id));
  }

  // Session operations
  async createSession(data: InsertSession): Promise<Session> {
    const [session] = await db.insert(sessions).values(data).returning();
    return session;
  }

  async getSessionByToken(token: string): Promise<Session | null> {
    const [session] = await db.select().from(sessions).where(eq(sessions.token, token));
    if (!session) return null;
    if (session.expiresAt < new Date()) {
      await db.delete(sessions).where(eq(sessions.id, session.id));
      return null;
    }
    return session;
  }

  async deleteSession(token: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.token, token));
  }

  async cleanupExpiredSessions(): Promise<number> {
    const result = await db.delete(sessions)
      .where(lt(sessions.expiresAt, new Date()))
      .returning({ id: sessions.id });
    return result.length;
  }
}

export const globalTenantStorage = new GlobalTenantStorage();

// Storage factory for creating tenant-scoped storage instances
export const Storage: IStorageFactory = {
  forTenant(tenantId: string): ITenantStorage {
    return new TenantStorage(tenantId);
  },
  getDefaultTenantId(): string {
    return DEFAULT_TENANT_ID;
  }
};

// Default storage instance for backward compatibility (uses default tenant)
export const storage = new TenantStorage(DEFAULT_TENANT_ID);

// Deliberately tenant-UNscoped: the TTLock webhook only knows the lockId and
// must find the owning tenant(s). ttlockId is unique per (tenantId, ttlockId),
// so this can return more than one row.
export async function getLockDevicesByTTLockIdUnscoped(ttlockId: string): Promise<LockDevice[]> {
  return await db.select().from(lockDevices).where(eq(lockDevices.ttlockId, ttlockId));
}

// Alias for backward compatibility
export type DatabaseStorage = TenantStorage;
