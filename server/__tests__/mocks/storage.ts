/**
 * Mock ITenantStorage for unit tests.
 * Returns configurable settings and stores PIN/reservation data in memory.
 */

import type { Reservation, Pin, Room, LockDevice } from "@shared/schema";

export interface MockSettings {
  check_in_time?: string;
  reservation_checkout_time?: string;
  property_timezone?: string;
  check_in_method?: string;
  [key: string]: string | undefined;
}

export function createMockStorage(settings: MockSettings = {}) {
  const pins: Pin[] = [];
  const reservations: Reservation[] = [];
  const rooms: Room[] = [];
  const logs: any[] = [];
  const reservationLogs: any[] = [];
  const lockAssignments: Array<{ roomId: string; lockDevice: LockDevice; assignmentType: string }> = [];
  const commonAreas: any[] = [];
  const upsells: any[] = [];
  const marketingSendRows: any[] = [];
  const hourlyBookingRows: any[] = [];

  return {
    tenantId: "test-tenant",
    _pins: pins,
    _reservations: reservations,
    _rooms: rooms,
    _logs: logs,
    _reservationLogs: reservationLogs,
    _lockAssignments: lockAssignments,
    _commonAreas: commonAreas,

    // Settings
    async getSetting(key: string) {
      const value = settings[key];
      return value ? { value } : null;
    },
    async setSetting(key: string, value: string) {
      settings[key] = value;
    },

    // Rooms
    async getRoom(id: string) {
      return rooms.find((r) => r.id === id);
    },
    async isRoomMapped(roomId: string) {
      return lockAssignments.some(
        (a) => a.roomId === roomId && a.lockDevice.lockType === "room"
      );
    },
    async getRoomLockAssignments(roomId: string) {
      return lockAssignments.filter((a) => a.roomId === roomId);
    },

    // Reservations
    async getReservation(id: string) {
      return reservations.find((r) => r.id === id);
    },
    async getAllReservations() {
      return reservations;
    },
    async updateReservation(id: string, data: Partial<Reservation>) {
      const res = reservations.find((r) => r.id === id);
      if (res) Object.assign(res, data);
      return res;
    },

    // Pins
    async createPin(pin: any) {
      const created = { id: `pin-${Date.now()}-${Math.random().toString(36).slice(2)}`, ...pin, createdAt: new Date() };
      pins.push(created);
      return created;
    },
    async getPin(id: string) {
      return pins.find((p) => p.id === id);
    },
    async updatePin(id: string, data: Partial<Pin>) {
      const pin = pins.find((p) => p.id === id);
      if (pin) Object.assign(pin, data);
      return pin;
    },
    async getPinsByRoomId(roomId: string) {
      return pins.filter((p) => p.roomId === roomId);
    },
    async getPinsByReservationId(reservationId: string) {
      return pins.filter((p) => p.reservationId === reservationId);
    },
    async getPinsByReservationIds(reservationIds: string[]) {
      const ids = new Set(reservationIds);
      return pins.filter((p) => p.reservationId && ids.has(p.reservationId));
    },
    async getPendingPinsForTodayArrivals() {
      return [];
    },
    async getPinsWithDeleteFailed() {
      return pins.filter((p) => p.status === "delete_failed");
    },
    async getAllPins() {
      return pins;
    },
    async getActivePins() {
      return pins.filter((p) => p.status === "active");
    },
    async getRepairablePins() {
      const now = Date.now();
      return pins.filter(
        (p) => (p.status === "active" || p.status === "used") && new Date(p.validTo).getTime() > now
      );
    },
    async getDeletedPinsWithinValidity() {
      const now = Date.now();
      return pins.filter((p) => p.status === "deleted" && new Date(p.validTo).getTime() > now);
    },

    // Rooms/common areas (bulk)
    async getAllRooms() {
      return rooms;
    },
    async getAllCommonAreas() {
      return commonAreas;
    },
    async getAllLockDevices() {
      const seen = new Set<string>();
      const devices: LockDevice[] = [];
      for (const a of lockAssignments) {
        if (!seen.has(a.lockDevice.id)) {
          seen.add(a.lockDevice.id);
          devices.push(a.lockDevice);
        }
      }
      return devices;
    },

    // Lock devices
    async getLockDevice(id: string) {
      for (const a of lockAssignments) {
        if (a.lockDevice.id === id) return a.lockDevice;
      }
      return undefined;
    },
    async getLockDeviceByTTLockId(ttlockId: string) {
      for (const a of lockAssignments) {
        if (a.lockDevice.ttlockId === ttlockId) return a.lockDevice;
      }
      return undefined;
    },
    async updateLockDevice(_id: string, _data: any) {},

    // Hourly bookings — ingestion guard checks this; default: no match.
    async getHourlyBookingByMewsReservationId(_pmsReservationId: string) {
      return undefined;
    },

    // Reservations by arrival range (arrival report)
    async getMappedReservationsByArrivalRange(start: Date, end: Date) {
      return reservations.filter((r) => {
        const arrival = new Date(r.arrival).getTime();
        return arrival >= start.getTime() && arrival <= end.getTime();
      });
    },

    // Paid upsells (early check-in / late check-out) — arrival report revenue line
    _upsells: upsells,
    async getCompletedUpsellsSince(since: Date) {
      return upsells.filter(
        (u) => u.status === "completed" && u.completedAt && new Date(u.completedAt).getTime() >= since.getTime()
      );
    },
    async getUpsellsByReservationIds(reservationIds: string[]) {
      const ids = new Set(reservationIds);
      return upsells.filter((u) => ids.has(u.reservationId));
    },

    // Hourly bookings — daily upsell report
    _hourlyBookings: hourlyBookingRows,
    async getHourlyBookings(limit: number = 200) {
      return hourlyBookingRows.slice(-limit);
    },

    // Reservations by departure range (marketing LC audience)
    async getMappedReservationsByDepartureRange(start: Date, end: Date) {
      return reservations.filter((r) => {
        const departure = new Date(r.departure).getTime();
        return departure >= start.getTime() && departure < end.getTime();
      });
    },

    // Marketing sends — mirrors the partial unique index claim semantics.
    _marketingSends: marketingSendRows,
    async getMarketingSentReservationIds(campaign: string) {
      return new Set(
        marketingSendRows.filter((m) => m.campaign === campaign && m.status === "sent").map((m) => m.reservationId)
      );
    },
    async createMarketingSendClaim(row: any) {
      const conflict = marketingSendRows.some(
        (m) => m.reservationId === row.reservationId && m.campaign === row.campaign && m.status === "sent"
      );
      if (conflict) return undefined;
      const created = { id: `ms-${marketingSendRows.length + 1}`, sentAt: new Date(), ...row };
      marketingSendRows.push(created);
      return created;
    },
    async updateMarketingSend(id: string, patch: any) {
      const row = marketingSendRows.find((m) => m.id === id);
      if (row) Object.assign(row, patch);
    },
    async getMarketingSendsWithReservations(limit: number = 100) {
      return marketingSendRows.slice(-limit).map((m) => ({ ...m, guestName: m.guestName || "Mock Guest" }));
    },
    async getMarketingDailyHistory(_days: number, _tz: string) {
      return [] as Array<{ day: string; campaign: string; sent: number; failed: number }>;
    },
    async getUpsellDailyHistory(_days: number, _tz: string) {
      return [] as Array<{ day: string; kind: string; purchases: number; revenue: number }>;
    },

    // Logs
    async createLog(log: any) {
      logs.push({ timestamp: new Date(), ...log });
    },
    async getAllLogs(limit: number = 200) {
      return logs.slice(-limit);
    },
    async getLogsBySourceSince(source: string, since: Date, limit: number = 2000) {
      return logs
        .filter((l: any) => l.source === source && new Date(l.timestamp) >= since)
        .slice(-limit);
    },
    async createReservationLog(log: any) {
      reservationLogs.push(log);
    },
  };
}
