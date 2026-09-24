/**
 * Churn dampener on the door-code message (28/7, Tziolas: 33 duplicate SMS):
 * the send-once state lives on the reservation row and dies when a bug
 * re-creates the row. The tenant-level content marker (code+capsule+recipient)
 * must absorb the duplicate — same content within 6h sends NOTHING but still
 * stamps the fresh row so the job stops retrying.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReservationStateMachine } from "../../reservation-state-machine";
import { makeReservation } from "../fixtures/reservations";
import type { Reservation } from "@shared/schema";

const smsSpy = vi.fn(async (_p: { to: string; body: string }) => ({ success: true as boolean, error: undefined as string | undefined }));

vi.mock("../../notification-client", () => ({
  createNotificationClient: async () => ({
    sendPlainSMS: smsSpy,
    sendPlainTextEmail: vi.fn(async () => ({ success: false, error: "not used" })),
  }),
}));

function createStorage() {
  const settings = new Map<string, string>();
  const reservations: Reservation[] = [];
  const logs: any[] = [];
  const pins: any[] = [{ id: "pin-1", reservationId: "res-1", roomId: "room-1", status: "active", code: "7103" }];
  return {
    _settings: settings,
    _reservations: reservations,
    _logs: logs,
    async getSetting(key: string) { const v = settings.get(key); return v ? { value: v } : null; },
    async setSetting(key: string, value: string) { settings.set(key, value); },
    async getRoom(_id: string) { return { id: "room-1", name: "713", label: null }; },
    async getReservation(id: string) { return reservations.find(r => r.id === id); },
    async getPinsByReservationId(id: string) { return pins.filter(p => p.reservationId === id); },
    async updateReservation(id: string, data: Partial<Reservation>) {
      const r = reservations.find(x => x.id === id);
      if (r) Object.assign(r, data);
      return r;
    },
    async createLog(l: any) { logs.push(l); },
  };
}

function makeGuest(storage: ReturnType<typeof createStorage>): Reservation {
  const r = makeReservation({
    id: "res-1", pmsId: "PMS-1", status: "Confirmed", roomId: "room-1",
    generatedPin: "7103",
    arrival: new Date(Date.now() + 60 * 60 * 1000),
    departure: new Date(Date.now() + 26 * 60 * 60 * 1000),
    doorCodeSentAt: null, doorCodeSig: null, doorCodeAttempts: 0,
    owing: "0.00",
    email: null, personalEmail: null, mobile: "+4512345678",
  } as any);
  storage._reservations.push(r);
  return r;
}

beforeEach(() => {
  smsSpy.mockClear();
  smsSpy.mockImplementation(async () => ({ success: true, error: undefined }));
});

describe("door-code churn dampener", () => {
  it("a re-created row does NOT trigger a second SMS — dampener absorbs and re-stamps", async () => {
    const storage = createStorage();
    const r = makeGuest(storage);
    const sm = new ReservationStateMachine(storage as any, {} as any, null as any, "test-tenant");

    await (sm as any)._sendDoorCodeMessage(r);
    expect(smsSpy).toHaveBeenCalledTimes(1);
    expect(r.doorCodeSentAt).toBeInstanceOf(Date);

    // Simulate the churn: the row is re-created blank (send state gone).
    r.doorCodeSentAt = null as any;
    (r as any).doorCodeSig = null;
    (r as any).notificationSent = false;

    await (sm as any)._sendDoorCodeMessage(r);
    expect(smsSpy).toHaveBeenCalledTimes(1); // NO second SMS
    expect(r.doorCodeSentAt).toBeInstanceOf(Date); // row re-stamped → job stops retrying
    expect(storage._logs.some(l => l.level === "warn" && l.message.includes("SUPPRESSED"))).toBe(true);
  });

  it("a CODE change is a legitimate re-send — new key, SMS goes out", async () => {
    const storage = createStorage();
    const r = makeGuest(storage);
    const sm = new ReservationStateMachine(storage as any, {} as any, null as any, "test-tenant");

    await (sm as any)._sendDoorCodeMessage(r);
    expect(smsSpy).toHaveBeenCalledTimes(1);

    // New code (e.g. regenerated) → content differs → dampener must not block.
    (r as any).generatedPin = "8888";
    storage._pins?.forEach?.(() => {});
    r.doorCodeSentAt = null as any;
    (r as any).doorCodeSig = null;
    await (sm as any)._sendDoorCodeMessage(r);
    expect(smsSpy).toHaveBeenCalledTimes(2);
  });
});
