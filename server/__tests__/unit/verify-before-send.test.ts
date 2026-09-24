/**
 * Verify-before-send tests (C4, post-21/7).
 *
 * On MEWS check-in the boarding card (with the door code) used to be sent
 * regardless of whether the code had landed on ANY lock. Now:
 *  - code confirmed on >= 1 lock → send immediately (unchanged happy path)
 *  - unconfirmed → defer up to 3 scheduler ticks (activation retries first)
 *  - still unconfirmed on tick 3 → send anyway (card carries remote-unlock)
 *    but log an error so ops sees "code sent UNVERIFIED".
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ReservationStateMachine } from "../../reservation-state-machine";
import { createMockStorage } from "../mocks/storage";

const HOUR = 60 * 60 * 1000;

function makeSm() {
  const storage = createMockStorage({
    check_in_time: "15:00",
    reservation_checkout_time: "11:00",
    property_timezone: "Europe/Copenhagen",
  });

  const reservation: any = {
    id: "res-1",
    pmsId: "MEWS-1",
    roomId: "room-1",
    status: "Checked-in",
    preCheckinStatus: null,
    pmsCheckinSource: null,
    firstName: "Anna",
    lastName: "Guest",
    arrival: new Date(Date.now() - HOUR),
    departure: new Date(Date.now() + 20 * HOUR),
  };
  storage._reservations.push(reservation);

  const sm = new ReservationStateMachine(storage as any, {} as any, null, "test-tenant");

  // Stub the heavy collaborators — this test targets the send gate only.
  let sent = 0;
  (sm as any).isRoomMapped = async () => true;
  (sm as any).isPinCreated = async () => true;
  (sm as any).activatePin = async () => true;
  (sm as any).sendBoardingCard = async () => { sent++; return true; };

  return { storage, reservation, sm, sentCount: () => sent };
}

function addPin(storage: any, entries: { room?: any[]; common?: any[] }, status = "active") {
  storage._pins.push({
    id: `pin-${storage._pins.length + 1}`,
    roomId: "room-1",
    reservationId: "res-1",
    code: "4711",
    status,
    validFrom: new Date(Date.now() - HOUR),
    validTo: new Date(Date.now() + 20 * HOUR),
    roomLockKeyIds: entries.room ?? [],
    commonAreaKeyIds: entries.common ?? [],
  });
}

describe("verify-before-send (_handleCheckedIn)", () => {
  let s: ReturnType<typeof makeSm>;

  beforeEach(() => {
    s = makeSm();
  });

  it("sends immediately when the code is confirmed on at least one lock", async () => {
    addPin(s.storage, { room: [{ lockDeviceId: "ld1", ttlockId: "tt1", keyId: "1001", lockName: "Room" }] });

    await (s.sm as any)._handleCheckedIn(s.reservation);

    expect(s.sentCount()).toBe(1);
    expect(s.storage._logs.some((l: any) => String(l.message).includes("UNVERIFIED"))).toBe(false);
  });

  it("defers when the code is on zero locks, then sends anyway on the 3rd attempt with an error log", async () => {
    addPin(s.storage, {}); // active pin, no key entries anywhere

    await (s.sm as any)._handleCheckedIn(s.reservation);
    expect(s.sentCount()).toBe(0); // deferred (1/3)

    await (s.sm as any)._handleCheckedIn(s.reservation);
    expect(s.sentCount()).toBe(0); // deferred (2/3)

    await (s.sm as any)._handleCheckedIn(s.reservation);
    expect(s.sentCount()).toBe(1); // sent anyway — guest must not be left with nothing

    expect(s.storage._logs.some((l: any) => l.level === "error" && String(l.message).includes("UNVERIFIED"))).toBe(true);
    // Deferral logs on the way there:
    expect(s.storage._logs.filter((l: any) => String(l.message).includes("Boarding card deferred")).length).toBe(2);
  });

  it("recovers mid-deferral: code lands on a lock on tick 2 → verified send, no error", async () => {
    const pin: any = { room: [] as any[] };
    addPin(s.storage, { room: pin.room });

    await (s.sm as any)._handleCheckedIn(s.reservation);
    expect(s.sentCount()).toBe(0);

    // Repair/drift pushed the code between ticks:
    s.storage._pins[0].roomLockKeyIds = [{ lockDeviceId: "ld1", ttlockId: "tt1", keyId: "1001", lockName: "Room" }];

    await (s.sm as any)._handleCheckedIn(s.reservation);
    expect(s.sentCount()).toBe(1);
    expect(s.storage._logs.some((l: any) => String(l.message).includes("UNVERIFIED"))).toBe(false);
  });

  it("pmsCheckinSource is tracked even while the send is deferred", async () => {
    addPin(s.storage, {});

    await (s.sm as any)._handleCheckedIn(s.reservation);

    expect(s.sentCount()).toBe(0);
    expect(s.reservation.pmsCheckinSource).toBe("mews");
  });

  it("used pins (guest already unlocked once) count as confirmed", async () => {
    addPin(s.storage, { common: [{ lockDeviceId: "ld2", ttlockId: "tt2", keyId: "1002", lockName: "Main" }] }, "used");

    await (s.sm as any)._handleCheckedIn(s.reservation);

    expect(s.sentCount()).toBe(1);
  });
});
