/**
 * IN-HOUSE GUARD on cancellation revokes (Martinsen 16-17/7 + natten 22/7):
 * MEWS' ~06:00 no-show audit cancels un-checked-in reservations — but a guest
 * whose auto check-in was REJECTED (occupied space) is asleep inside with a
 * used code. A cancellation must never silently pull the codes of a guest who
 * is demonstrably inside their stay window; it must keep the codes and alert.
 * Normal checkouts and never-arrived cancellations are untouched.
 */
import { describe, it, expect, vi } from "vitest";
import { PinLifecycleService } from "../../pin-lifecycle-service";
import { createMockStorage } from "../mocks/storage";
import { makeReservation, makePin } from "../fixtures/reservations";

function makeTTLock() {
  return {
    deletePasscode: vi.fn().mockResolvedValue(undefined),
    listPasscodes: vi.fn().mockResolvedValue([]),
  };
}

const usedInHousePin = () =>
  makePin({
    id: "pin-1",
    reservationId: "res-1",
    status: "used",
    firstUsedAt: new Date(Date.now() - 3 * 3600e3), // entered 3h ago
    validFrom: new Date(Date.now() - 6 * 3600e3),
    validTo: new Date(Date.now() + 12 * 3600e3), // stay window still open
    roomLockKeyIds: [{ lockDeviceId: "ld-1", ttlockId: "99999", keyId: "12345", lockName: "Capsule 204" }],
    commonAreaKeyIds: [],
  });

describe("onCancelled in-house guard", () => {
  it("BLOCKS the revoke for a cancelled guest who used their code inside an open window", async () => {
    const ttlock = makeTTLock();
    const storage = createMockStorage({ lock_arrival_report_email: "ops@hotel.dk" });
    storage._pins.push(usedInHousePin());
    const reservation = makeReservation({ id: "res-1", roomId: "room-1", status: "Cancelled" });

    const service = new PinLifecycleService(storage as any, ttlock as any, null);
    const revoked = await service.onCancelled(reservation);

    expect(revoked).toBe(false);
    expect(ttlock.deletePasscode).not.toHaveBeenCalled();
    expect(storage._pins[0].status).toBe("used"); // untouched — guest keeps access
    const blockedLog = storage._logs.find(
      (l: any) => l.level === "error" && l.message.includes("BLOCKED")
    );
    expect(blockedLog).toBeDefined();
  });

  it("lets a normal CHECKOUT through — used code + open window is the everyday morning case", async () => {
    const ttlock = makeTTLock();
    const storage = createMockStorage();
    storage._pins.push(usedInHousePin());
    const reservation = makeReservation({ id: "res-1", roomId: "room-1", status: "Checked-out" });

    const service = new PinLifecycleService(storage as any, ttlock as any, null);
    const revoked = await service.onCancelled(reservation);

    expect(revoked).toBe(true);
    expect(ttlock.deletePasscode).toHaveBeenCalledWith("99999", 12345);
    expect(storage._pins[0].status).toBe("cancelled");
  });

  it("lets a never-arrived cancellation through (code never used)", async () => {
    const ttlock = makeTTLock();
    const storage = createMockStorage();
    const pin = usedInHousePin();
    pin.firstUsedAt = null;
    pin.status = "active";
    storage._pins.push(pin);
    const reservation = makeReservation({ id: "res-1", roomId: "room-1", status: "Cancelled" });

    const service = new PinLifecycleService(storage as any, ttlock as any, null);
    const revoked = await service.onCancelled(reservation);

    expect(revoked).toBe(true);
    expect(storage._pins[0].status).toBe("cancelled");
  });

  it("lets an EXPIRED stay through (window already over)", async () => {
    const ttlock = makeTTLock();
    const storage = createMockStorage();
    const pin = usedInHousePin();
    pin.validTo = new Date(Date.now() - 3600e3); // stay over an hour ago
    storage._pins.push(pin);
    const reservation = makeReservation({ id: "res-1", roomId: "room-1", status: "Confirmed" });

    const service = new PinLifecycleService(storage as any, ttlock as any, null);
    const revoked = await service.onCancelled(reservation);

    expect(revoked).toBe(true);
    expect(storage._pins[0].status).toBe("cancelled");
  });

  it("force bypasses the guard (explicit admin actions)", async () => {
    const ttlock = makeTTLock();
    const storage = createMockStorage();
    storage._pins.push(usedInHousePin());
    const reservation = makeReservation({ id: "res-1", roomId: "room-1", status: "Cancelled" });

    const service = new PinLifecycleService(storage as any, ttlock as any, null);
    const revoked = await service.onCancelled(reservation, { force: true });

    expect(revoked).toBe(true);
    expect(storage._pins[0].status).toBe("cancelled");
  });
});
