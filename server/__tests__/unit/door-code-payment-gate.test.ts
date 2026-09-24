/**
 * Payment gate on the Capsule door-code message (the Elynn Herrou incident):
 * PIN activation refuses to program locks while owing > 0, so sending the
 * code SMS to an unpaid guest hands them a DEAD code. The send must be
 * DEFERRED (no markers stamped, no attempts counted) until the balance is 0 —
 * then it goes out on the next tick automatically.
 */

import { describe, it, expect } from "vitest";
import { ReservationStateMachine } from "../../reservation-state-machine";
import { makeReservation } from "../fixtures/reservations";
import type { Reservation } from "@shared/schema";

function createStorage() {
  const reservations: Reservation[] = [];
  const logs: any[] = [];
  const pins: any[] = [];
  // Default: an active pin on the guest's room, so the lock-programming gate
  // passes and payment-gate tests stay deterministic at any time of day.
  pins.push({ id: "pin-1", reservationId: "res-1", roomId: "room-1", status: "active", code: "7103" });
  return {
    _reservations: reservations,
    _logs: logs,
    _pins: pins,
    async getSetting(_key: string) { return null; }, // defaults: check-in 15:00 etc.
    async getRoom(_id: string) { return { id: "room-1", name: "302", label: null }; },
    async getReservation(id: string) { return reservations.find(r => r.id === id); },
    async getPinsByReservationId(id: string) { return pins.filter(p => p.reservationId === id); },
    async updateReservation(id: string, data: Partial<Reservation>) {
      const r = reservations.find(r => r.id === id);
      if (r) Object.assign(r, data);
      return r;
    },
    async createLog(l: any) { logs.push(l); },
  };
}

function makeGuest(storage: ReturnType<typeof createStorage>, over: Partial<Reservation>): Reservation {
  const r = makeReservation({
    id: "res-1", pmsId: "PMS-1", status: "Confirmed", roomId: "room-1",
    generatedPin: "7103",
    arrival: new Date(Date.now() + 60 * 60 * 1000),          // arrives in 1h → inside 23h window
    departure: new Date(Date.now() + 26 * 60 * 60 * 1000),
    doorCodeSentAt: null, doorCodeSig: "seeded-sig", doorCodeAttempts: 0,
    email: null, personalEmail: null, mobile: null,           // no contacts → send path increments attempts
    ...over,
  } as any);
  // Signature must match current content so the change-detector doesn't reset.
  storage._reservations.push(r);
  return r;
}

function makeSm(storage: any) {
  return new ReservationStateMachine(storage as any, {} as any, null as any, "test-tenant");
}

describe("door-code payment gate (owing > 0 → defer send)", () => {
  it("defers the send for an UNPAID guest: no markers, no attempts, warn log", async () => {
    const storage = createStorage();
    const r = makeGuest(storage, { owing: "2079.00" } as any);
    // Align sig with actual content:
    (r as any).doorCodeSig = (makeSm(storage) as any).doorCodeSignature(r);

    const sm = makeSm(storage);
    await (sm as any)._sendDoorCodeMessage(r);

    expect(r.doorCodeSentAt).toBeNull();          // not marked sent
    expect(r.doorCodeAttempts ?? 0).toBe(0);      // no attempt burned
    expect(storage._logs.some(l => l.level === "warn" && l.message.includes("awaiting payment") && l.message.includes("2079.00"))).toBe(true);
    expect(storage._logs.some(l => l.message.includes("Door code sent"))).toBe(false);
  });

  it("logs the deferral only ONCE across repeated ticks", async () => {
    const storage = createStorage();
    const r = makeGuest(storage, { owing: "500.00" } as any);
    (r as any).doorCodeSig = (makeSm(storage) as any).doorCodeSignature(r);

    const sm = makeSm(storage);
    await (sm as any)._sendDoorCodeMessage(r);
    await (sm as any)._sendDoorCodeMessage(r);
    await (sm as any)._sendDoorCodeMessage(r);

    const deferLogs = storage._logs.filter(l => l.message.includes("awaiting payment"));
    expect(deferLogs.length).toBe(1);
  });

  it("proceeds past the gate when owing is 0 (send path reached)", async () => {
    const storage = createStorage();
    const r = makeGuest(storage, { owing: "0.00" } as any);
    (r as any).doorCodeSig = (makeSm(storage) as any).doorCodeSignature(r);

    const sm = makeSm(storage);
    await (sm as any)._sendDoorCodeMessage(r);

    // No contacts → delivery fails → the send path increments attempts.
    // (Reaching this counter proves the payment gate let the send proceed.)
    expect(r.doorCodeAttempts).toBe(1);
    expect(storage._logs.some(l => l.message.includes("awaiting payment"))).toBe(false);
  });
});

describe("door-code lock-programming gate (window open + pin not on locks → defer)", () => {
  // 20/7 incident: same-night booking got the SMS ~10 min before the locks
  // were programmed. When the activation window is already open, the message
  // must wait for an active pin on the guest's CURRENT room.

  const windowOpen = {
    arrival: new Date(Date.now() - 26 * 60 * 60 * 1000),   // window opened long ago
    departure: new Date(Date.now() + 24 * 60 * 60 * 1000),
    owing: "0.00",
  };

  it("defers while the pin is still pending: no markers, no attempts, warn once", async () => {
    const storage = createStorage();
    storage._pins[0].status = "pending";
    const r = makeGuest(storage, windowOpen as any);
    (r as any).doorCodeSig = (makeSm(storage) as any).doorCodeSignature(r);

    const sm = makeSm(storage);
    await (sm as any)._sendDoorCodeMessage(r);
    await (sm as any)._sendDoorCodeMessage(r);

    expect(r.doorCodeSentAt).toBeNull();
    expect(r.doorCodeAttempts ?? 0).toBe(0);
    expect(storage._logs.filter(l => l.level === "warn" && l.message.includes("not on the locks yet")).length).toBe(1);
  });

  it("an active pin on the OLD room does not satisfy the gate after a room move", async () => {
    const storage = createStorage();
    storage._pins[0].roomId = "room-OLD"; // stuck active pin on the old lock
    const r = makeGuest(storage, windowOpen as any);
    (r as any).doorCodeSig = (makeSm(storage) as any).doorCodeSignature(r);

    const sm = makeSm(storage);
    await (sm as any)._sendDoorCodeMessage(r);

    expect(r.doorCodeAttempts ?? 0).toBe(0); // deferred — new room's code not live
  });

  it("sends once the pin is active on the current room", async () => {
    const storage = createStorage();  // default: active pin on room-1
    const r = makeGuest(storage, windowOpen as any);
    (r as any).doorCodeSig = (makeSm(storage) as any).doorCodeSignature(r);

    const sm = makeSm(storage);
    await (sm as any)._sendDoorCodeMessage(r);

    expect(r.doorCodeAttempts).toBe(1); // send path reached (no contacts → attempt burned)
    expect(storage._logs.some(l => l.message.includes("not on the locks yet"))).toBe(false);
  });

  it("future arrival (window closed): pending pin does NOT block the 23h advance send", async () => {
    const storage = createStorage();
    storage._pins[0].status = "pending";
    // Deterministic at any run hour: pin check-in to exactly now+12h so the
    // 23h advance is open (now >= validFrom-23h) while the activation window
    // is not (now < validFrom-1h).
    const { DateTime } = await import("luxon");
    const target = DateTime.now().setZone("Europe/Copenhagen").plus({ hours: 12 });
    storage.getSetting = async (key: string) =>
      key === "check_in_time" ? { value: target.toFormat("HH:mm") } as any : null;
    const r = makeGuest(storage, {
      arrival: target.toJSDate(),
      departure: target.plus({ hours: 24 }).toJSDate(),
      owing: "0.00",
    } as any);
    (r as any).doorCodeSig = (makeSm(storage) as any).doorCodeSignature(r);

    const sm = makeSm(storage);
    await (sm as any)._sendDoorCodeMessage(r);

    expect(r.doorCodeAttempts).toBe(1); // sent — scheduler programs locks before arrival
  });
});
