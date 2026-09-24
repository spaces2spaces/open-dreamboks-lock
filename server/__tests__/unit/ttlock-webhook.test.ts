/**
 * Tests for the TTLock realtime webhook path:
 *  - normalizeTtlockRecords (defensive parsing of the undocumented push payload)
 *  - ReservationStateMachine.handleLockUnlockRecords (same matching pipeline as
 *    the hourly _jobLockArrivals poller, driven by pushed records instead of
 *    polled ones; the poller itself is untouched and stays the safety net)
 */

import { describe, it, expect } from "vitest";
import { ReservationStateMachine } from "../../reservation-state-machine";
import { normalizeTtlockRecords } from "../../routes/webhooks";
import { makeReservation, makePin, makeLockDevice } from "../fixtures/reservations";
import type { Reservation, Pin, LockDevice } from "@shared/schema";

function createStorage(settings: Record<string, string>) {
  const pins: Pin[] = [];
  const reservations: Reservation[] = [];
  const logs: any[] = [];

  return {
    _pins: pins,
    _reservations: reservations,
    _logs: logs,

    async getSetting(key: string) {
      const v = settings[key];
      return v !== undefined ? { value: v } : null;
    },
    async getAllPins() {
      return [...pins];
    },
    async getReservation(id: string) {
      return reservations.find((r) => r.id === id);
    },
    async updatePinFirstUsedAt(id: string, date: Date) {
      const p = pins.find((p) => p.id === id);
      if (p) p.firstUsedAt = date;
    },
    async updatePin(id: string, data: Partial<Pin>) {
      const p = pins.find((p) => p.id === id);
      if (p) Object.assign(p, data);
      return p;
    },
    async updateReservation(id: string, data: Partial<Reservation>) {
      const r = reservations.find((r) => r.id === id);
      if (r) Object.assign(r, data);
      return r;
    },
    async createLog(log: any) {
      logs.push(log);
    },
  };
}

function createMews() {
  const started: string[] = [];
  return {
    _started: started,
    async startReservation(pmsId: string) {
      started.push(pmsId);
      return { success: true };
    },
  };
}

const TENANT = "test-tenant";
const now = Date.now();
const validFrom = new Date(now - 60 * 60 * 1000);
const validTo = new Date(now + 24 * 60 * 60 * 1000);

// LIVE settings: master flag on + webhook explicitly out of shadow mode.
const LIVE = {
  lock_arrival_checkin_enabled: "true",
  lock_arrival_webhook_log_only: "false",
};

function setup(settings: Record<string, string>, reservationStatus = "Confirmed") {
  const storage = createStorage(settings);
  const mews = createMews();
  const lock = makeLockDevice({ ttlockId: "common-1", lockType: "common", name: "Street Entrance" });
  const reservation = makeReservation({
    id: "res-1",
    roomId: "room-1",
    pmsId: "PMS-RES-1",
    status: reservationStatus,
  });
  const pin = makePin({
    id: "pin-1",
    reservationId: "res-1",
    roomId: "room-1",
    code: "4829",
    status: "active",
    firstUsedAt: null,
    validFrom,
    validTo,
  });
  storage._reservations.push(reservation);
  storage._pins.push(pin);
  const sm = new ReservationStateMachine(storage as any, { getTTLockClient: () => null } as any, mews as any, TENANT);
  return { storage, mews, lock, reservation, pin, sm };
}

const keypadRecord = (code = "4829", lockDate = now) => ({
  recordType: 4,
  success: 1,
  keyboardPwd: code,
  lockDate,
});

describe("normalizeTtlockRecords (defensive payload parsing)", () => {
  it("parses a JSON-string array with numeric strings", () => {
    const out = normalizeTtlockRecords(
      '[{"recordType":"4","success":"1","keyboardPwd":"4829","lockDate":"1752912000000"}]'
    );
    expect(out).toEqual([{ recordType: 4, success: 1, keyboardPwd: "4829", lockDate: 1752912000000 }]);
  });

  it("accepts an already-parsed array and a single object", () => {
    expect(normalizeTtlockRecords([keypadRecord()])).toHaveLength(1);
    expect(normalizeTtlockRecords(keypadRecord())).toHaveLength(1);
  });

  it("never throws on malformed input — returns []", () => {
    expect(normalizeTtlockRecords("not json {")).toEqual([]);
    expect(normalizeTtlockRecords(undefined)).toEqual([]);
    expect(normalizeTtlockRecords(null)).toEqual([]);
    expect(normalizeTtlockRecords(42)).toEqual([]);
    expect(normalizeTtlockRecords('["strings","only"]')).toEqual([]);
  });

  it("tolerates missing fields", () => {
    const [r] = normalizeTtlockRecords('[{"electricQuantity":93}]');
    expect(r).toEqual({ recordType: undefined, success: undefined, keyboardPwd: undefined, lockDate: undefined });
  });
});

describe("ReservationStateMachine.handleLockUnlockRecords (webhook path)", () => {
  it("checks the guest in live when a valid passcode unlock is pushed", async () => {
    const { storage, mews, lock, reservation, pin, sm } = setup(LIVE);

    const result = await sm.handleLockUnlockRecords(lock, [keypadRecord()]);

    expect(result.matched).toBe(1);
    expect(mews._started).toContain("PMS-RES-1");
    expect(pin.status).toBe("used");
    expect(pin.firstUsedAt).toEqual(new Date(now));
    expect(reservation.status).toBe("checked-in");
    expect(reservation.pmsCheckinSource).toBe("lock");
    // Heartbeat-style summary log with webhook marker
    expect(storage._logs.some((l) => l.metadata?.via === "webhook")).toBe(true);
  });

  it("defaults to log-only (shadow mode) when lock_arrival_webhook_log_only is unset", async () => {
    const { storage, mews, reservation, pin, sm, lock } = setup({ lock_arrival_checkin_enabled: "true" });

    const result = await sm.handleLockUnlockRecords(lock, [keypadRecord()]);

    expect(result.matched).toBe(1);
    expect(mews._started).toHaveLength(0);
    expect(pin.status).toBe("active");
    expect(pin.firstUsedAt).toBeNull();
    expect(reservation.status).toBe("Confirmed");
    expect(storage._logs.some((l) => String(l.message).includes("log-only"))).toBe(true);
  });

  it("is a no-op when the master flag lock_arrival_checkin_enabled is off", async () => {
    const { mews, pin, sm, lock } = setup({ lock_arrival_webhook_log_only: "false" });

    const result = await sm.handleLockUnlockRecords(lock, [keypadRecord()]);

    expect(result).toEqual({ candidates: 0, matched: 0 });
    expect(mews._started).toHaveLength(0);
    expect(pin.status).toBe("active");
  });

  it("filters failed attempts, records without passcode, and invalid lockDate", async () => {
    const { mews, pin, sm, lock } = setup(LIVE);

    const result = await sm.handleLockUnlockRecords(lock, [
      { ...keypadRecord(), success: 0 },                    // failed attempt
      { recordType: 1, success: 1, lockDate: now },         // app unlock, no passcode
      { ...keypadRecord(), lockDate: undefined },           // missing timestamp
    ]);

    expect(result.matched).toBe(0);
    expect(mews._started).toHaveLength(0);
    expect(pin.status).toBe("active");
  });

  it("rejects records outside the PIN validity window", async () => {
    const { mews, pin, sm, lock } = setup(LIVE);

    const beforeWindow = validFrom.getTime() - 2 * 60 * 60 * 1000;
    const result = await sm.handleLockUnlockRecords(lock, [keypadRecord("4829", beforeWindow)]);

    expect(result.matched).toBe(0);
    expect(mews._started).toHaveLength(0);
    expect(pin.firstUsedAt).toBeNull();
  });

  it("matches a pre-window record when a paid early check-in moved the start (Hilger 24/7)", async () => {
    const { mews, reservation, sm, lock } = setup(LIVE);

    // Purchase moved lock access 2h before the pin row's validFrom; the guest
    // entered 30 min after the purchase — before the base window.
    const purchaseAt = validFrom.getTime() - 2 * 60 * 60 * 1000;
    (reservation as any).earlyCheckinFrom = new Date(purchaseAt);
    const usedAt = purchaseAt + 30 * 60 * 1000;

    const result = await sm.handleLockUnlockRecords(lock, [keypadRecord("4829", usedAt)]);

    expect(result.matched).toBe(1);
    expect(mews._started).toEqual(["PMS-RES-1"]);
  });

  it("still rejects records before a paid early check-in start", async () => {
    const { mews, reservation, sm, lock } = setup(LIVE);

    const purchaseAt = validFrom.getTime() - 2 * 60 * 60 * 1000;
    (reservation as any).earlyCheckinFrom = new Date(purchaseAt);

    const result = await sm.handleLockUnlockRecords(lock, [keypadRecord("4829", purchaseAt - 10 * 60 * 1000)]);

    expect(result.matched).toBe(0);
    expect(mews._started).toHaveLength(0);
  });

  it("skips guests who are not Confirmed (already checked in)", async () => {
    const { mews, pin, sm, lock } = setup(LIVE, "checked-in");

    const result = await sm.handleLockUnlockRecords(lock, [keypadRecord()]);

    expect(result.matched).toBe(0);
    expect(mews._started).toHaveLength(0);
    expect(pin.status).toBe("active");
  });

  it("is idempotent — the same record delivered twice checks in once", async () => {
    const { mews, reservation, sm, lock } = setup(LIVE);

    const first = await sm.handleLockUnlockRecords(lock, [keypadRecord()]);
    const second = await sm.handleLockUnlockRecords(lock, [keypadRecord()]);

    expect(first.matched).toBe(1);
    // Second delivery: pin now has firstUsedAt → excluded from candidates.
    expect(second.matched).toBe(0);
    expect(mews._started).toHaveLength(1);
    expect(reservation.status).toBe("checked-in");
  });

  it("dedupes the same pin within one callback (multi-record batch, log-only)", async () => {
    const { storage, sm, lock } = setup({ lock_arrival_checkin_enabled: "true" }); // shadow mode: nothing written

    const result = await sm.handleLockUnlockRecords(lock, [
      keypadRecord("4829", now),
      keypadRecord("4829", now + 1000), // same guest keys twice
    ]);

    expect(result.matched).toBe(1);
    expect(storage._logs.filter((l) => String(l.message).includes("[lock-arrival log-only]"))).toHaveLength(1);
  });

  it("handles a MEWS rejection like the poller: guest stays Confirmed", async () => {
    const storage = createStorage(LIVE);
    const mews = {
      _attempts: [] as string[],
      async startReservation(pmsId: string) {
        this._attempts.push(pmsId);
        return { success: false, error: "MEWS API error: 403 - assigned space is blocked" };
      },
    };
    const lock = makeLockDevice({ ttlockId: "common-1", lockType: "common", name: "Street Entrance" });
    const reservation = makeReservation({ id: "res-1", roomId: "room-1", pmsId: "PMS-RES-1", status: "Confirmed" });
    const pin = makePin({
      id: "pin-1", reservationId: "res-1", roomId: "room-1", code: "4829",
      status: "active", firstUsedAt: null, validFrom, validTo,
    });
    storage._reservations.push(reservation);
    storage._pins.push(pin);
    const sm = new ReservationStateMachine(storage as any, { getTTLockClient: () => null } as any, mews as any, TENANT);

    await sm.handleLockUnlockRecords(lock, [keypadRecord()]);

    expect(mews._attempts).toContain("PMS-RES-1");
    expect(reservation.status).toBe("Confirmed"); // stays Confirmed for the hourly retry sweep
    expect(reservation.pmsCheckinSource ?? null).toBeNull();
  });
});
