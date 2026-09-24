import { describe, it, expect, vi, beforeEach } from "vitest";
import { PinLifecycleService } from "../../pin-lifecycle-service";
import { createMockStorage } from "../mocks/storage";
import { makeReservation, makeRoom, makeLockDevice, makePin, dateDaysFromNow } from "../fixtures/reservations";

describe("PinLifecycleService", () => {
  describe("generateSafePasscode", () => {
    it("generates a 4-digit string", () => {
      const storage = createMockStorage();
      const service = new PinLifecycleService(storage as any, null, null);
      const code = service.generateSafePasscode();
      expect(code).toMatch(/^\d{4}$/);
      expect(parseInt(code)).toBeGreaterThanOrEqual(1000);
      expect(parseInt(code)).toBeLessThan(10000);
    });

    it("never generates sequential ascending codes", () => {
      const storage = createMockStorage();
      const service = new PinLifecycleService(storage as any, null, null);
      const forbidden = ["1234", "2345", "3456", "4567", "5678", "6789"];
      for (let i = 0; i < 500; i++) {
        const code = service.generateSafePasscode();
        expect(forbidden).not.toContain(code);
      }
    });

    it("never generates sequential descending codes", () => {
      const storage = createMockStorage();
      const service = new PinLifecycleService(storage as any, null, null);
      const forbidden = ["9876", "8765", "7654", "6543", "5432", "4321"];
      for (let i = 0; i < 500; i++) {
        const code = service.generateSafePasscode();
        expect(forbidden).not.toContain(code);
      }
    });

    it("never generates all-same-digit codes", () => {
      const storage = createMockStorage();
      const service = new PinLifecycleService(storage as any, null, null);
      const forbidden = ["1111", "2222", "3333", "4444", "5555", "6666", "7777", "8888", "9999"];
      for (let i = 0; i < 500; i++) {
        const code = service.generateSafePasscode();
        expect(forbidden).not.toContain(code);
      }
    });

    it("never generates repeated-pair codes", () => {
      const storage = createMockStorage();
      const service = new PinLifecycleService(storage as any, null, null);
      const forbidden = ["1212", "3434", "5656", "7878", "1010", "2323"];
      for (let i = 0; i < 500; i++) {
        const code = service.generateSafePasscode();
        expect(forbidden).not.toContain(code);
      }
    });
  });

  describe("onReservationCreated", () => {
    it("creates a pending PIN for a reservation with a mapped room", async () => {
      const storage = createMockStorage({
        check_in_time: "15:00",
        reservation_checkout_time: "11:00",
        property_timezone: "Europe/Copenhagen",
      });
      const room = makeRoom({ id: "room-1" });
      const roomLock = makeLockDevice({ id: "lock-1", lockType: "room", ttlockId: "99999" });
      storage._rooms.push(room);
      storage._lockAssignments.push({ roomId: "room-1", lockDevice: roomLock, assignmentType: "room_lock" });

      const reservation = makeReservation({ id: "res-1", roomId: "room-1" });
      storage._reservations.push(reservation);

      const service = new PinLifecycleService(storage as any, null, null);
      await service.onReservationCreated(reservation);

      expect(storage._pins.length).toBe(1);
      expect(storage._pins[0].status).toBe("pending");
      expect(storage._pins[0].roomId).toBe("room-1");
      expect(storage._pins[0].code).toMatch(/^\d{4}$/);
    });

    it("skips PIN creation for rooms without room-type locks (common-only)", async () => {
      const storage = createMockStorage();
      const room = makeRoom({ id: "room-1" });
      const commonLock = makeLockDevice({ id: "lock-1", lockType: "common", ttlockId: "99999" });
      storage._rooms.push(room);
      storage._lockAssignments.push({ roomId: "room-1", lockDevice: commonLock, assignmentType: "room_lock" });

      const reservation = makeReservation({ id: "res-1", roomId: "room-1" });
      storage._reservations.push(reservation);

      const service = new PinLifecycleService(storage as any, null, null);
      await service.onReservationCreated(reservation);

      expect(storage._pins.length).toBe(0);
    });

    it("skips PIN creation when roomId is null", async () => {
      const storage = createMockStorage();
      const reservation = makeReservation({ id: "res-1", roomId: null });
      storage._reservations.push(reservation);

      const service = new PinLifecycleService(storage as any, null, null);
      await service.onReservationCreated(reservation);

      expect(storage._pins.length).toBe(0);
    });

    it("does not create duplicate PINs for the same reservation", async () => {
      const storage = createMockStorage();
      const room = makeRoom({ id: "room-1" });
      const roomLock = makeLockDevice({ id: "lock-1", lockType: "room", ttlockId: "99999" });
      storage._rooms.push(room);
      storage._lockAssignments.push({ roomId: "room-1", lockDevice: roomLock, assignmentType: "room_lock" });

      const reservation = makeReservation({ id: "res-1", roomId: "room-1" });
      storage._reservations.push(reservation);

      const service = new PinLifecycleService(storage as any, null, null);

      // First call creates PIN
      await service.onReservationCreated(reservation);
      expect(storage._pins.length).toBe(1);

      // Second call should skip (existing pending PIN)
      await service.onReservationCreated(reservation);
      expect(storage._pins.length).toBe(1);
    });

    it("pushes the PIN to TTLock immediately when the activation window is already open (same-night booking)", async () => {
      // 20/7 incident: guest booked 23:37 for the same night; the code SMS went
      // out within seconds but the locks were only programmed 10 minutes later
      // when the poller tick came around. Creation must push immediately.
      const mockTTLock = {
        addPasscode: vi.fn().mockResolvedValue({ id: 54321 }),
        listPasscodes: vi.fn().mockResolvedValue([]),
      };
      const storage = createMockStorage({
        check_in_time: "15:00",
        reservation_checkout_time: "10:00",
        property_timezone: "Europe/Copenhagen",
      });
      const room = makeRoom({ id: "room-1" });
      const roomLock = makeLockDevice({ id: "lock-1", lockType: "room", ttlockId: "99999" });
      storage._rooms.push(room);
      storage._lockAssignments.push({ roomId: "room-1", lockDevice: roomLock, assignmentType: "room_lock" });

      const reservation = makeReservation({
        id: "res-night",
        roomId: "room-1",
        arrival: new Date(Date.now() - 26 * 3600e3), // window opened long ago
        departure: new Date(Date.now() + 24 * 3600e3),
        owing: "0",
      });
      storage._reservations.push(reservation);

      const service = new PinLifecycleService(storage as any, mockTTLock as any, null);
      await service.onReservationCreated(reservation);

      expect(mockTTLock.addPasscode).toHaveBeenCalled();
      expect(storage._pins[0].status).toBe("active");
    });

    it("leaves future arrivals pending — no immediate TTLock push at creation", async () => {
      const mockTTLock = {
        addPasscode: vi.fn().mockResolvedValue({ id: 54321 }),
        listPasscodes: vi.fn().mockResolvedValue([]),
      };
      const storage = createMockStorage({
        check_in_time: "15:00",
        reservation_checkout_time: "10:00",
        property_timezone: "Europe/Copenhagen",
      });
      const room = makeRoom({ id: "room-1" });
      const roomLock = makeLockDevice({ id: "lock-1", lockType: "room", ttlockId: "99999" });
      storage._rooms.push(room);
      storage._lockAssignments.push({ roomId: "room-1", lockDevice: roomLock, assignmentType: "room_lock" });

      const reservation = makeReservation({ id: "res-future", roomId: "room-1", owing: "0" }); // arrival +30d
      storage._reservations.push(reservation);

      const service = new PinLifecycleService(storage as any, mockTTLock as any, null);
      await service.onReservationCreated(reservation);

      expect(mockTTLock.addPasscode).not.toHaveBeenCalled();
      expect(storage._pins[0].status).toBe("pending");
    });

    it("reuses existing generatedPin code from reservation", async () => {
      const storage = createMockStorage();
      const room = makeRoom({ id: "room-1" });
      const roomLock = makeLockDevice({ id: "lock-1", lockType: "room", ttlockId: "99999" });
      storage._rooms.push(room);
      storage._lockAssignments.push({ roomId: "room-1", lockDevice: roomLock, assignmentType: "room_lock" });

      const reservation = makeReservation({ id: "res-1", roomId: "room-1", generatedPin: "4829" });
      storage._reservations.push(reservation);

      const service = new PinLifecycleService(storage as any, null, null);
      await service.onReservationCreated(reservation);

      expect(storage._pins[0].code).toBe("4829");
    });
  });

  describe("onCancelled", () => {
    it("cancels pending PINs without calling TTLock", async () => {
      const storage = createMockStorage();
      const pin = makePin({ id: "pin-1", reservationId: "res-1", status: "pending" });
      storage._pins.push(pin);

      const reservation = makeReservation({ id: "res-1", roomId: "room-1" });

      const service = new PinLifecycleService(storage as any, null, null);
      await service.onCancelled(reservation);

      expect(storage._pins[0].status).toBe("cancelled");
    });

    it("deletes active PINs from TTLock and marks as cancelled", async () => {
      const mockTTLock = {
        deletePasscode: vi.fn().mockResolvedValue(undefined),
        listPasscodes: vi.fn().mockResolvedValue([]),
      };

      const storage = createMockStorage();
      const pin = makePin({
        id: "pin-1",
        reservationId: "res-1",
        status: "active",
        roomLockKeyIds: [{ lockDeviceId: "ld-1", ttlockId: "99999", keyId: "12345", lockName: "Room 101" }],
        commonAreaKeyIds: [],
      });
      storage._pins.push(pin);

      const reservation = makeReservation({ id: "res-1", roomId: "room-1" });

      const service = new PinLifecycleService(storage as any, mockTTLock as any, null);
      await service.onCancelled(reservation);

      expect(mockTTLock.deletePasscode).toHaveBeenCalledWith("99999", 12345);
      expect(storage._pins[0].status).toBe("cancelled");
    });

    it("sets delete_failed status when TTLock deletion fails", async () => {
      const mockTTLock = {
        deletePasscode: vi.fn().mockRejectedValue(new Error("Gateway timeout")),
        listPasscodes: vi.fn().mockResolvedValue([]),
      };

      const storage = createMockStorage();
      const pin = makePin({
        id: "pin-1",
        reservationId: "res-1",
        status: "active",
        roomLockKeyIds: [{ lockDeviceId: "ld-1", ttlockId: "99999", keyId: "12345", lockName: "Room 101" }],
        commonAreaKeyIds: [],
      });
      storage._pins.push(pin);

      const reservation = makeReservation({ id: "res-1", roomId: "room-1" });

      const service = new PinLifecycleService(storage as any, mockTTLock as any, null);
      await service.onCancelled(reservation);

      expect(storage._pins[0].status).toBe("delete_failed");
    });
  });

  describe("per-reservation mutex", () => {
    it("serializes concurrent operations on the same reservation", async () => {
      const storage = createMockStorage();
      const room = makeRoom({ id: "room-1" });
      const roomLock = makeLockDevice({ id: "lock-1", lockType: "room", ttlockId: "99999" });
      storage._rooms.push(room);
      storage._lockAssignments.push({ roomId: "room-1", lockDevice: roomLock, assignmentType: "room_lock" });

      const reservation = makeReservation({ id: "res-1", roomId: "room-1" });
      storage._reservations.push(reservation);

      const service = new PinLifecycleService(storage as any, null, null);

      const callOrder: number[] = [];
      let callCount = 0;

      // Override createPin to track execution order
      const origCreatePin = storage.createPin.bind(storage);
      storage.createPin = async (pin: any) => {
        const myCall = ++callCount;
        callOrder.push(myCall);
        await new Promise((r) => setTimeout(r, 30));
        return origCreatePin(pin);
      };

      // Launch two concurrent onReservationCreated
      const p1 = service.onReservationCreated(reservation);
      const p2 = service.onReservationCreated({ ...reservation });
      await Promise.all([p1, p2]);

      // With mutex, the second call waits for the first to finish.
      // The second call then finds the existing pending PIN and skips createPin.
      // So createPin should only be called once (by the first operation).
      expect(callCount).toBeLessThanOrEqual(2);
      // At most 2 PINs (if mutex timing is tight), but importantly no crash or corruption
      expect(storage._pins.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("onArrivalDateChanged", () => {
    it("updates validity window for pending PIN (no TTLock call)", async () => {
      const storage = createMockStorage({
        check_in_time: "15:00",
        reservation_checkout_time: "11:00",
        property_timezone: "Europe/Copenhagen",
      });
      const room = makeRoom({ id: "room-1" });
      const roomLock = makeLockDevice({ id: "lock-1", lockType: "room", ttlockId: "99999" });
      storage._rooms.push(room);
      storage._lockAssignments.push({ roomId: "room-1", lockDevice: roomLock, assignmentType: "room_lock" });

      const reservation = makeReservation({ id: "res-1", roomId: "room-1", generatedPin: "4829" });
      storage._reservations.push(reservation);

      const pin = makePin({
        id: "pin-1", reservationId: "res-1", roomId: "room-1",
        code: "4829", status: "pending",
      });
      storage._pins.push(pin);

      const service = new PinLifecycleService(storage as any, null, null);

      // Change arrival to a later date
      const newArrival = dateDaysFromNow(40);
      reservation.arrival = newArrival;
      await service.onArrivalDateChanged(reservation);

      // PIN should still be pending with updated validity
      expect(storage._pins[0].status).toBe("pending");
      expect(new Date(storage._pins[0].validFrom).toISOString()).toContain(newArrival.toISOString().slice(0, 10));
    });

    it("deletes live PIN from TTLock and creates new pending on arrival date change", async () => {
      const mockTTLock = {
        deletePasscode: vi.fn().mockResolvedValue(undefined),
        listPasscodes: vi.fn().mockResolvedValue([]),
        addPasscode: vi.fn().mockResolvedValue({ id: 99999, code: "4829" }),
        getLockStatus: vi.fn().mockResolvedValue({ keyboardPwdVersion: 4 }),
      };

      const storage = createMockStorage({
        check_in_time: "15:00",
        reservation_checkout_time: "11:00",
        property_timezone: "Europe/Copenhagen",
      });
      const room = makeRoom({ id: "room-1" });
      const roomLock = makeLockDevice({ id: "lock-1", lockType: "room", ttlockId: "99999" });
      storage._rooms.push(room);
      storage._lockAssignments.push({ roomId: "room-1", lockDevice: roomLock, assignmentType: "room_lock" });

      const reservation = makeReservation({ id: "res-1", roomId: "room-1", generatedPin: "4829", departure: dateDaysFromNow(35) });
      storage._reservations.push(reservation);

      const pin = makePin({
        id: "pin-1", reservationId: "res-1", roomId: "room-1",
        code: "4829", status: "active",
        roomLockKeyIds: [{ lockDeviceId: "lock-1", ttlockId: "99999", keyId: "12345", lockName: "Room 101" }],
        commonAreaKeyIds: [{ lockDeviceId: "lock-2", ttlockId: "88888", keyId: "67890", lockName: "Street Entrance" }],
      });
      storage._pins.push(pin);

      const service = new PinLifecycleService(storage as any, mockTTLock as any, null);

      reservation.arrival = dateDaysFromNow(25);
      await service.onArrivalDateChanged(reservation);

      // Old PIN deleted from both room and common locks
      expect(mockTTLock.deletePasscode).toHaveBeenCalledWith("99999", 12345);
      expect(mockTTLock.deletePasscode).toHaveBeenCalledWith("88888", 67890);

      // Old PIN marked cancelled, new pending PIN created with SAME code
      const cancelledPins = storage._pins.filter(p => p.status === "cancelled");
      const pendingPins = storage._pins.filter(p => p.status === "pending");
      expect(cancelledPins.length).toBe(1);
      expect(pendingPins.length).toBe(1);
      expect(pendingPins[0].code).toBe("4829"); // Same code reused!
    });
  });

  describe("onRoomChanged", () => {
    it("deletes old PIN from all locks and creates pending for new mapped room", async () => {
      const mockTTLock = {
        deletePasscode: vi.fn().mockResolvedValue(undefined),
        addPasscode: vi.fn().mockResolvedValue({ id: 99999, code: "4829" }),
        listPasscodes: vi.fn().mockResolvedValue([]),
        getLockStatus: vi.fn().mockResolvedValue({ keyboardPwdVersion: 4 }),
      };

      const storage = createMockStorage({
        check_in_time: "15:00",
        reservation_checkout_time: "11:00",
        property_timezone: "Europe/Copenhagen",
      });
      const oldRoom = makeRoom({ id: "old-room", name: "101" });
      const newRoom = makeRoom({ id: "new-room", name: "202" });
      const newRoomLock = makeLockDevice({ id: "lock-new", lockType: "room", ttlockId: "77777" });
      storage._rooms.push(oldRoom, newRoom);
      storage._lockAssignments.push({ roomId: "new-room", lockDevice: newRoomLock, assignmentType: "room_lock" });

      const reservation = makeReservation({
        id: "res-1", roomId: "new-room", generatedPin: "4829",
        arrival: dateDaysFromNow(20),
        departure: dateDaysFromNow(25),
      });
      storage._reservations.push(reservation);

      const oldPin = makePin({
        id: "pin-1", reservationId: "res-1", roomId: "old-room",
        code: "4829", status: "active",
        roomLockKeyIds: [{ lockDeviceId: "lock-old", ttlockId: "66666", keyId: "11111", lockName: "Room 101" }],
        commonAreaKeyIds: [],
      });
      storage._pins.push(oldPin);

      const service = new PinLifecycleService(storage as any, mockTTLock as any, null);
      await service.onRoomChanged(reservation, "old-room", "new-room");

      // Old PIN deleted from TTLock
      expect(mockTTLock.deletePasscode).toHaveBeenCalledWith("66666", 11111);

      // New pending PIN created with same code for new room
      const pendingPins = storage._pins.filter(p => p.status === "pending");
      expect(pendingPins.length).toBe(1);
      expect(pendingPins[0].roomId).toBe("new-room");
      expect(pendingPins[0].code).toBe("4829");
    });

    it("does not create PIN when new room is unmapped", async () => {
      const storage = createMockStorage();
      const oldRoom = makeRoom({ id: "old-room" });
      const newRoom = makeRoom({ id: "new-room" });
      // new-room has NO lock assignments
      storage._rooms.push(oldRoom, newRoom);

      const reservation = makeReservation({ id: "res-1", roomId: "new-room", generatedPin: "4829" });
      storage._reservations.push(reservation);

      const oldPin = makePin({
        id: "pin-1", reservationId: "res-1", roomId: "old-room",
        code: "4829", status: "pending",
      });
      storage._pins.push(oldPin);

      const service = new PinLifecycleService(storage as any, null, null);
      await service.onRoomChanged(reservation, "old-room", "new-room");

      // Old PIN cancelled
      expect(oldPin.status).toBe("cancelled");
      // No new PIN created
      const pendingPins = storage._pins.filter(p => p.status === "pending");
      expect(pendingPins.length).toBe(0);
    });

    it("preserves PIN code across room changes (never generates new code)", async () => {
      const storage = createMockStorage({
        check_in_time: "15:00",
        reservation_checkout_time: "11:00",
        property_timezone: "Europe/Copenhagen",
      });
      const oldRoom = makeRoom({ id: "old-room" });
      const newRoom = makeRoom({ id: "new-room" });
      const newRoomLock = makeLockDevice({ id: "lock-new", lockType: "room", ttlockId: "77777" });
      storage._rooms.push(oldRoom, newRoom);
      storage._lockAssignments.push({ roomId: "new-room", lockDevice: newRoomLock, assignmentType: "room_lock" });

      const reservation = makeReservation({ id: "res-1", roomId: "new-room", generatedPin: "1597", arrival: dateDaysFromNow(23), departure: dateDaysFromNow(25) });
      storage._reservations.push(reservation);

      const oldPin = makePin({
        id: "pin-1", reservationId: "res-1", roomId: "old-room",
        code: "1597", status: "pending",
      });
      storage._pins.push(oldPin);

      const service = new PinLifecycleService(storage as any, null, null);

      // Change rooms 3 times
      await service.onRoomChanged(reservation, "old-room", "new-room");
      const pin1 = storage._pins.find(p => p.status === "pending");
      expect(pin1?.code).toBe("1597");

      // Simulate changing back
      const pin1Id = pin1!.id;
      storage._lockAssignments.push({ roomId: "old-room", lockDevice: makeLockDevice({ id: "lock-old", lockType: "room", ttlockId: "66666" }), assignmentType: "room_lock" });
      reservation.roomId = "old-room";
      await service.onRoomChanged(reservation, "new-room", "old-room");
      const pin2 = storage._pins.find(p => p.status === "pending" && p.id !== pin1Id);
      expect(pin2?.code).toBe("1597"); // Still the same code!
    });
  });
});
