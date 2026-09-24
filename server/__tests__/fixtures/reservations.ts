/**
 * Test data factories for reservations, rooms, pins, and lock devices.
 */

import type { Reservation, Room, Pin, LockDevice } from "@shared/schema";

let idCounter = 0;
function nextId() {
  return `test-${++idCounter}`;
}

// All test dates are computed relative to "now" — hardcoded dates rot and make
// the suite fail once they pass in real time.
export function dateDaysFromNow(days: number): Date {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function isoDaysFromNow(days: number): string {
  return dateDaysFromNow(days).toISOString().replace(".000Z", "Z");
}

export function makeReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: nextId(),
    tenantId: "test-tenant",
    firstName: "Test",
    lastName: "Guest",
    email: "test@example.com",
    arrival: dateDaysFromNow(30),
    departure: dateDaysFromNow(32),
    pmsId: `PMS-${Date.now()}`,
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
    ...overrides,
  } as Reservation;
}

export function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: nextId(),
    tenantId: "test-tenant",
    name: "101",
    type: "room",
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
    ...overrides,
  } as Room;
}

export function makeLockDevice(overrides: Partial<LockDevice> = {}): LockDevice {
  return {
    id: nextId(),
    tenantId: "test-tenant",
    name: "Room Lock 101",
    ttlockId: "12345678",
    doorName: "Room 101",
    lockType: "room",
    keyboardPwdVersion: 4,
    battery: 100,
    mac: "AA:BB:CC:DD:EE:FF",
    createdAt: new Date(),
    ...overrides,
  } as LockDevice;
}

export function makePin(overrides: Partial<Pin> = {}): Pin {
  return {
    id: nextId(),
    tenantId: "test-tenant",
    roomId: "room-1",
    reservationId: "res-1",
    type: "Passcode",
    code: "5738",
    name: "Test Guest",
    email: "test@example.com",
    validFrom: new Date(dateDaysFromNow(30).getTime() + 13 * 3_600_000), // 15:00 CEST on arrival day
    validTo: new Date(dateDaysFromNow(32).getTime() + 9 * 3_600_000), // 11:00 CEST on departure day
    status: "pending",
    doors: [],
    assigner: "Automation",
    assigningTime: new Date(),
    ttlockKeyId: null,
    roomLockKeyIds: [],
    commonAreaKeyIds: [],
    qrCodeData: [],
    ttlockQrCodeIds: {},
    firstUsedAt: null,
    activatedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as Pin;
}
