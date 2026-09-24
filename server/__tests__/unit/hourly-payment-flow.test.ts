/**
 * Tests for the hourly-rental payment flow pieces:
 *  - Stripe webhook signature verification (manual HMAC — must reject forgeries)
 *  - price computation (whole started hours)
 *  - confirmAndIssue idempotency (webhook + poll fallback can race)
 */

import { describe, it, expect, vi } from "vitest";
import { createHmac } from "crypto";
import { verifyStripeSignature } from "../../stripe-client";
import { HourlyRentalService } from "../../hourly-rental-service";

describe("verifyStripeSignature", () => {
  const secret = "whsec_test_secret";
  const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });

  function sign(ts: number, body: string, key: string): string {
    const mac = createHmac("sha256", key).update(`${ts}.${body}`).digest("hex");
    return `t=${ts},v1=${mac}`;
  }

  it("accepts a valid signature", () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyStripeSignature(payload, sign(ts, payload, secret), secret)).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyStripeSignature(payload, sign(ts, payload, "whsec_wrong"), secret)).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = sign(ts, payload, secret);
    expect(verifyStripeSignature(payload.replace("evt_1", "evt_2"), header, secret)).toBe(false);
  });

  it("rejects a replayed (too old) timestamp", () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(verifyStripeSignature(payload, sign(old, payload, secret), secret)).toBe(false);
  });

  it("rejects missing/malformed headers", () => {
    expect(verifyStripeSignature(payload, undefined, secret)).toBe(false);
    expect(verifyStripeSignature(payload, "garbage", secret)).toBe(false);
    expect(verifyStripeSignature(payload, "t=123", secret)).toBe(false);
  });
});

describe("computeAmount", () => {
  const svc = new HourlyRentalService({} as any, {} as any);
  const T0 = Date.parse("2026-08-01T10:00:00Z");

  it("charges whole started hours", () => {
    expect(svc.computeAmount(new Date(T0), new Date(T0 + 2 * 3600_000), 100)).toEqual({ amount: 200, hours: 2 });
    expect(svc.computeAmount(new Date(T0), new Date(T0 + 90 * 60_000), 100)).toEqual({ amount: 200, hours: 2 }); // 90 min → 2h
    expect(svc.computeAmount(new Date(T0), new Date(T0 + 10 * 60_000), 100)).toEqual({ amount: 100, hours: 1 }); // min 1h
  });
});

describe("confirmAndIssue", () => {
  const T0 = Date.now() + 3600_000;

  function makeWorld(initialStatus: string) {
    const booking: any = {
      id: "b1", roomId: "r1", guestName: "Guest", guestEmail: null, guestPhone: null,
      startAt: new Date(T0), endAt: new Date(T0 + 2 * 3600_000),
      status: initialStatus, pinCode: null, lockKeyIds: [], paymentRef: "cs_1",
    };
    const addPasscode = vi.fn(async () => ({ id: 111, code: "4711" }));
    const storage: any = {
      getHourlyBooking: async () => ({ ...booking }),
      getRoom: async () => ({ id: "r1", name: "103", label: null, hourlyPool: true }),
      updateHourlyBooking: async (_id: string, patch: any) => Object.assign(booking, patch),
      // CAS: only flips when not already confirmed (mirrors the SQL WHERE clause)
      confirmHourlyBookingIfNotConfirmed: async (_id: string, patch: any) =>
        booking.status === "confirmed" ? undefined : Object.assign(booking, patch),
      getRoomLockAssignments: async () => [
        { lockDevice: { id: "ld1", ttlockId: "999", name: "103", keyboardPwdVersion: 4, lockType: "room" } },
      ],
      getAllPins: async () => [],
      getAllReservations: async () => [],
      getHourlyBookingsOverlapping: async () => [],
      getSetting: async () => undefined,
      createLog: async () => ({}),
    };
    const engine: any = {
      getPinLifecycle: () => ({ generateSafePasscode: () => "4711" }),
      getTTLockClient: () => ({ addPasscode }),
    };
    return { booking, storage, engine, addPasscode };
  }

  it("flips a pending hold to confirmed, generates a code and pushes it", async () => {
    const { booking, storage, engine, addPasscode } = makeWorld("pending_payment");
    const svc = new HourlyRentalService(storage, engine);
    const result = await svc.confirmAndIssue("b1", { provider: "stripe", ref: "cs_1" });
    expect(booking.status).toBe("confirmed");
    expect(booking.pinCode).toBe("4711");
    expect(booking.paidAt).toBeInstanceOf(Date);
    expect(addPasscode).toHaveBeenCalledTimes(1);
    expect(result.booking.lockKeyIds).toHaveLength(1);
  });

  it("is idempotent — an already-confirmed booking is returned untouched (no second push)", async () => {
    const { storage, engine, addPasscode } = makeWorld("confirmed");
    const svc = new HourlyRentalService(storage, engine);
    const result = await svc.confirmAndIssue("b1", { provider: "stripe" });
    expect(result.booking.status).toBe("confirmed");
    expect(addPasscode).not.toHaveBeenCalled();
  });

  it("refuses a cancelled booking", async () => {
    const { storage, engine } = makeWorld("cancelled");
    const svc = new HourlyRentalService(storage, engine);
    await expect(svc.confirmAndIssue("b1", { provider: "stripe" })).rejects.toThrow(/annulleret/);
  });

  it("never auto-cancels a PAID booking on total push failure — sweep retries instead", async () => {
    const { booking, storage, engine } = makeWorld("pending_payment");
    engine.getTTLockClient = () => ({
      addPasscode: vi.fn(async () => { throw new Error("TTLock API error: -1 - boom"); }),
    });
    const svc = new HourlyRentalService(storage, engine);
    const result = await svc.confirmAndIssue("b1", { provider: "stripe" });
    expect(booking.status).toBe("confirmed"); // stays paid+confirmed
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("surfaces a slot-retaken exclusion violation as a refund case", async () => {
    const { storage, engine } = makeWorld("expired");
    storage.confirmHourlyBookingIfNotConfirmed = async () => {
      const err: any = new Error("conflicting key value violates exclusion constraint \"hourly_bookings_no_overlap\"");
      err.code = "23P01";
      throw err;
    };
    const logs: string[] = [];
    storage.createLog = async (l: any) => { logs.push(l.message); return {}; };
    const svc = new HourlyRentalService(storage, engine);
    await expect(svc.confirmAndIssue("b1", { provider: "stripe" })).rejects.toThrow(/refunderes/);
    expect(logs.some(m => m.includes("REFUND REQUIRED"))).toBe(true);
  });

  it("webhook⇄poll race: the CAS loser never pushes a second code", async () => {
    const { booking, storage, engine, addPasscode } = makeWorld("pending_payment");
    // Simulate: loser read the booking as pending, but the winner confirmed it
    // between the read and the CAS — CAS returns undefined, re-read shows confirmed.
    storage.confirmHourlyBookingIfNotConfirmed = async () => {
      booking.status = "confirmed";
      booking.pinCode = "9999"; // winner's code
      return undefined; // 0 rows updated for the loser
    };
    const svc = new HourlyRentalService(storage, engine);
    const result = await svc.confirmAndIssue("b1", { provider: "stripe" });
    expect(result.booking.status).toBe("confirmed");
    expect(result.booking.pinCode).toBe("9999"); // winner's code, not a new one
    expect(addPasscode).not.toHaveBeenCalled(); // loser never touches the locks
  });

  it("refuses to issue when payment lands after the window ended (refund case)", async () => {
    const { booking, storage, engine, addPasscode } = makeWorld("pending_payment");
    booking.startAt = new Date(Date.now() - 5 * 3600_000);
    booking.endAt = new Date(Date.now() - 3 * 3600_000); // window already over
    const logs: string[] = [];
    storage.createLog = async (l: any) => { logs.push(l.message); return {}; };
    const svc = new HourlyRentalService(storage, engine);
    await expect(svc.confirmAndIssue("b1", { provider: "stripe" })).rejects.toThrow(/refunderes/);
    expect(logs.some(m => m.includes("REFUND REQUIRED"))).toBe(true);
    expect(addPasscode).not.toHaveBeenCalled();
  });
});
