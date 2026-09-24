/**
 * Tests for the hourly arrival report's categorization: today's arrivals are
 * bucketed into checked-in-via-code / checked-in-other / not-arrived / no-show,
 * and cancelled reservations are excluded entirely.
 */

import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { categorizeArrivals, resolveReportDate, compactMewsReason, buildLockArrivalReportData } from "../../lock-arrival-report";

describe("compactMewsReason (rejection reason column)", () => {
  it("extracts the MEWS Message and drops the parenthetical reservation detail", () => {
    const raw = 'MEWS check-in write-back failed: MEWS API error: 403 - {"Message":"Cannot check in reservation because assigned space is blocked. (Stay Night 15:00 66 (Else Marie Martinsen, 7/16/2026 - 7/21/2026, Upper Double Capsule (For 2 Guests), 104))","RequestId":"abc","Details":null}';
    expect(compactMewsReason(raw)).toBe("Cannot check in reservation because assigned space is blocked.");
  });

  it("handles the remote-unlock failure format", () => {
    const raw = 'Auto check-in via remote unlock failed: MEWS API error: 403 - {"Message":"Cannot check in reservation because assigned space is blocked. (Stay Night 15:00 895 (6344364097, Rustam Seyidov, 16.07.2026 - 18.07.2026, 408))","RequestId":"x"}';
    expect(compactMewsReason(raw)).toBe("Cannot check in reservation because assigned space is blocked.");
  });

  it("falls back to stripped raw text when there is no JSON Message", () => {
    expect(compactMewsReason("MEWS check-in write-back failed: fetch failed")).toBe("fetch failed");
  });

  it("truncates very long reasons", () => {
    const long = `MEWS check-in write-back failed: ${"x".repeat(200)}`;
    expect(compactMewsReason(long).length).toBeLessThanOrEqual(90);
    expect(compactMewsReason(long).endsWith("…")).toBe(true);
  });
});

describe("resolveReportDate (07:00 rollover)", () => {
  const tz = "Europe/Copenhagen";
  const at = (iso: string) => DateTime.fromISO(iso, { zone: tz });

  it("before 07:00 → still the PREVIOUS calendar day's arrivals", () => {
    expect(resolveReportDate(at("2026-07-17T02:30"), 7).toISODate()).toBe("2026-07-16");
    expect(resolveReportDate(at("2026-07-17T06:59"), 7).toISODate()).toBe("2026-07-16");
    expect(resolveReportDate(at("2026-07-17T00:00"), 7).toISODate()).toBe("2026-07-16");
  });

  it("at/after 07:00 → switches to the new (current) day", () => {
    expect(resolveReportDate(at("2026-07-17T07:00"), 7).toISODate()).toBe("2026-07-17");
    expect(resolveReportDate(at("2026-07-17T15:00"), 7).toISODate()).toBe("2026-07-17");
    expect(resolveReportDate(at("2026-07-17T23:59"), 7).toISODate()).toBe("2026-07-17");
  });

  it("honours a custom rollover hour", () => {
    expect(resolveReportDate(at("2026-07-17T05:00"), 6).toISODate()).toBe("2026-07-16");
    expect(resolveReportDate(at("2026-07-17T06:00"), 6).toISODate()).toBe("2026-07-17");
  });
});

const r = (over: any) => ({
  id: over.id || Math.random().toString(36),
  firstName: "G", lastName: "Guest",
  status: "Confirmed", pmsCheckinSource: null,
  ...over,
} as any);

describe("categorizeArrivals", () => {
  it("buckets by status + pmsCheckinSource", () => {
    const buckets = categorizeArrivals([
      r({ id: "a", status: "checked-in", pmsCheckinSource: "lock" }),
      r({ id: "b", status: "Checked-in", pmsCheckinSource: "lock" }), // case-insensitive status
      r({ id: "c", status: "checked-in", pmsCheckinSource: null }),   // manual/MEWS check-in
      r({ id: "d", status: "Started", pmsCheckinSource: "boarding" }),
      r({ id: "e", status: "Confirmed" }),
      r({ id: "f", status: "no-show" }),
      r({ id: "g", status: "Cancelled" }), // excluded
    ]);
    expect(buckets.checkedInViaCode.map(x => x.id)).toEqual(["a", "b"]);
    expect(buckets.checkedInOther.map(x => x.id)).toEqual(["c", "d"]);
    expect(buckets.notArrived.map(x => x.id)).toEqual(["e"]);
    expect(buckets.noShow.map(x => x.id)).toEqual(["f"]);
  });

  it("handles empty input", () => {
    const buckets = categorizeArrivals([]);
    expect(buckets.checkedInViaCode).toEqual([]);
    expect(buckets.notArrived).toEqual([]);
  });
});

describe("buildLockArrivalReport — stale rejection reason", () => {
  // A duplicate check-in attempt logs a MEWS rejection even though the guest
  // ends up checked in; the Årsag column must not keep showing it.
  const mewsError =
    'MEWS check-in write-back failed: MEWS API error: 400 - {"Message":"Cannot check in reservation because it is not in confirmed state.","RequestId":"x","Details":null}';

  const mkStorage = (reservations: any[], logs: any[]): any => ({
    getSetting: async () => undefined,
    getMappedReservationsByArrivalRange: async () => reservations,
    getAllRooms: async () => [],
    getPinsByReservationIds: async () => [],
    getPinsByReservationId: async () => [],
    getAllLogs: async () => logs,
  });

  it("drops the logged reason for a checked-in guest but keeps it for a still-rejected one", async () => {
    const now = new Date();
    const reservations = [
      r({ id: "in", firstName: "Tobias", lastName: "B", status: "Checked-in", pmsCheckinSource: "lock", room: "405", owing: "0", generatedPin: "2629", updatedAt: now }),
      r({ id: "rej", firstName: "Rita", lastName: "R", status: "Confirmed", room: "301", owing: "0", generatedPin: "1111" }),
    ];
    const logs = [
      { timestamp: now, level: "warn", message: mewsError, reservationId: "in" },
      { timestamp: now, level: "warn", message: mewsError, reservationId: "rej" },
    ];
    const data = await buildLockArrivalReportData(mkStorage(reservations, logs), { runAudit: false });
    const rowOf = (name: string) => data.rows.find(x => x.guestName.startsWith(name))!;

    expect(rowOf("Tobias").status.text).toContain("✅ Via code");
    expect(rowOf("Tobias").reason).not.toContain("not in confirmed state");

    expect(rowOf("Rita").status.text).toContain("❌ MEWS rejected");
    expect(rowOf("Rita").reason).toContain("not in confirmed state");
  });

  it("unpaid reason says PIN blocked (not code withheld) when the message already went out", async () => {
    const reservations = [
      r({ id: "u1", firstName: "Amalie", lastName: "C", status: "Confirmed", room: "508", owing: "906.44", doorCodeSentAt: new Date() }),
      r({ id: "u2", firstName: "Ubesked", lastName: "U", status: "Confirmed", room: "509", owing: "300.00" }),
    ];
    const data = await buildLockArrivalReportData(mkStorage(reservations, []), { runAudit: false });
    const rowOf = (name: string) => data.rows.find(x => x.guestName.startsWith(name))!;

    expect(rowOf("Amalie").status.text).toContain("💰 Awaiting payment");
    expect(rowOf("Amalie").reason).toContain("Owes 906.44 kr — message sent, but PIN blocked until payment");

    expect(rowOf("Ubesked").reason).toContain("Owes 300.00 kr — code withheld until payment");
    expect(data.counts.awaitingPayment).toBe(2);
  });
});

describe("hourly bookings on the day list", () => {
  const mkStorage = (hourly: any[]): any => ({
    getSetting: async () => undefined,
    getMappedReservationsByArrivalRange: async () => [],
    getAllRooms: async () => [{ id: "room-1", name: "208s", label: null }],
    getPinsByReservationIds: async () => [],
    getPinsByReservationId: async () => [],
    getAllLogs: async () => [],
    getHourlyBookingsOverlapping: async () => hourly,
  });

  it("shows a time booking as a ⏱-row with its exact window", async () => {
    const start = new Date(); start.setHours(12, 0, 0, 0);
    const end = new Date(); end.setHours(18, 0, 0, 0);
    const data = await buildLockArrivalReportData(mkStorage([{
      id: "hb-1", roomId: "room-1", guestName: "Nap Guest", status: "confirmed",
      startAt: start, endAt: end, pinCode: "9161", codeDeliveredAt: new Date(),
    }]), { runAudit: false });

    const row = data.rows.find(r => r.reservationId === "hourly:hb-1")!;
    expect(row).toBeDefined();
    expect(row.guestName).toBe("Nap Guest");
    expect(row.room).toBe("208s");
    expect(row.code).toBe("9161");
    expect(row.msgSent).toBe(true);
    expect(row.status.text).toContain("⏱ Time booking 12:00–18:00");
    // Every time booking frees the capsule dirty at its end → extra cleaning task.
    expect(row.reason).toBe("🧹 Extra cleaning after 18:00");
    expect(data.counts.hourly).toBe(1);
    expect(data.counts.cleaning).toBe(1);
  });

  it("storages without the hourly table yield no hourly rows (report never breaks)", async () => {
    const s = mkStorage([]);
    delete s.getHourlyBookingsOverlapping;
    const data = await buildLockArrivalReportData(s, { runAudit: false });
    expect(data.counts.hourly).toBe(0);
    expect(data.counts.cleaning).toBe(0);
  });

  it("a finished, checked-out booking says so explicitly (28/7: bare '(finished)' read as 'never checked out')", async () => {
    const start = new Date(Date.now() - 5 * 3600_000);
    const end = new Date(Date.now() - 2 * 3600_000);
    const data = await buildLockArrivalReportData(mkStorage([{
      id: "hb-out", roomId: "room-1", guestName: "Done Guest", status: "expired",
      startAt: start, endAt: end, pinCode: "1111", codeDeliveredAt: new Date(),
      mewsReservationId: "mews-1", mewsCheckedOutAt: end,
    }]), { runAudit: false });
    const row = data.rows.find(r => r.reservationId === "hourly:hb-out")!;
    expect(row.status.text).toContain("✅ checked out");
    expect(row.status.color).toBe("#6b7280");
  });

  it("a finished booking whose MEWS checkout has not landed yet warns amber", async () => {
    const data = await buildLockArrivalReportData(mkStorage([{
      id: "hb-pend", roomId: "room-1", guestName: "Pending Guest", status: "expired",
      startAt: new Date(Date.now() - 5 * 3600_000), endAt: new Date(Date.now() - 3600_000),
      pinCode: "2222", codeDeliveredAt: new Date(),
      mewsReservationId: "mews-2", mewsCheckedOutAt: null,
    }]), { runAudit: false });
    const row = data.rows.find(r => r.reservationId === "hourly:hb-pend")!;
    expect(row.status.text).toContain("⏳ checkout pending");
    expect(row.status.color).toBe("#d97706");
  });

  it("abandoned unpaid holds (legacy 'expired' rows without code/payment) never surface", async () => {
    const start = new Date(); start.setHours(12, 0, 0, 0);
    const end = new Date(); end.setHours(18, 0, 0, 0);
    const data = await buildLockArrivalReportData(mkStorage([{
      id: "hb-ghost", roomId: "room-1", guestName: "Ghost", status: "expired",
      startAt: start, endAt: end, pinCode: null, paidAt: null,
    }]), { runAudit: false });
    expect(data.rows.some(x => x.reservationId === "hourly:hb-ghost")).toBe(false);
    expect(data.counts.hourly).toBe(0);
    expect(data.counts.cleaning).toBe(0);
  });
});

describe("late checkouts as extra cleaning tasks (24/7)", () => {
  const mkStorage = (late: any[], arrivals: any[] = []): any => ({
    getSetting: async () => undefined,
    getMappedReservationsByArrivalRange: async () => arrivals,
    getAllRooms: async () => [{ id: "room-9", name: "512", label: null }],
    getPinsByReservationIds: async () => [],
    getPinsByReservationId: async () => [],
    getAllLogs: async () => [],
    getReservationsWithLateCheckoutBetween: async () => late,
  });

  it("a departing guest with paid late checkout becomes a 🛏-row with a 🧹 cleaning reason", async () => {
    const until = new Date(); until.setHours(14, 0, 0, 0);
    const data = await buildLockArrivalReportData(mkStorage([
      r({ id: "res-lc", firstName: "Embla", lastName: "L", status: "Checked-in", roomId: "room-9", generatedPin: "2222", lateCheckoutUntil: until, doorCodeSentAt: new Date(), departure: until }),
    ]), { runAudit: false });

    const row = data.rows.find(x => x.reservationId === "late-checkout:res-lc")!;
    expect(row).toBeDefined();
    expect(row.room).toBe("512");
    expect(row.status.text).toContain("🛏 Late check-out until 14:00");
    expect(row.reason).toBe("🧹 Extra cleaning after 14:00");
    expect(row.lateCheckoutUntil).toBe("14:00");
    expect(data.counts.cleaning).toBe(1);
  });

  it("a guest who is ALSO among today's arrivals is not duplicated as a cleaning row", async () => {
    const until = new Date(); until.setHours(14, 0, 0, 0);
    const guest = r({ id: "res-both", status: "Checked-in", roomId: "room-9", lateCheckoutUntil: until, departure: until, owing: "0" });
    const data = await buildLockArrivalReportData(mkStorage([guest], [guest]), { runAudit: false });
    expect(data.rows.filter(x => x.reservationId.includes("res-both")).length).toBe(1);
    expect(data.counts.cleaning).toBe(0);
  });

  it("storages without the method yield no cleaning rows (report never breaks)", async () => {
    const s = mkStorage([]);
    delete s.getReservationsWithLateCheckoutBetween;
    const data = await buildLockArrivalReportData(s, { runAudit: false });
    expect(data.counts.cleaning).toBe(0);
  });
});

describe("deleted-pin invariant watchdog", () => {
  // Must mirror recoverWronglyDeletedPins' skip rule: a deleted pin whose
  // reservation ALSO has a live pin is normal bookkeeping (re-generated pin
  // row) — recovery would skip it, so the report must not alarm on it
  // (23/7: a permanent un-actionable URGENT for a fully-covered guest).
  const HOUR = 3600 * 1000;
  const mkStorage = (opts: { deletedPin: any; allPins: any[]; reservation: any }): any => ({
    getSetting: async () => undefined,
    getMappedReservationsByArrivalRange: async () => [],
    getAllRooms: async () => [],
    getPinsByReservationIds: async () => [],
    getPinsByReservationId: async (id: string) => opts.allPins.filter((p) => p.reservationId === id),
    getAllLogs: async () => [],
    getDeletedPinsWithinValidity: async () => [opts.deletedPin],
    getReservation: async (id: string) => (id === opts.reservation.id ? opts.reservation : undefined),
  });

  const reservation = { id: "res-1", status: "Checked-in" };
  const deletedPin = {
    id: "pin-old", reservationId: "res-1", code: "4584", status: "deleted",
    validFrom: new Date(Date.now() - 24 * HOUR), validTo: new Date(Date.now() + 24 * HOUR),
  };

  it("no alarm when the reservation has a live sibling pin", async () => {
    const livePin = { id: "pin-new", reservationId: "res-1", code: "4584", status: "used" };
    const data = await buildLockArrivalReportData(
      mkStorage({ deletedPin, allPins: [deletedPin, livePin], reservation }),
      { runAudit: false },
    );

    expect(data.urgentReasons.some(r => r.includes("INVARIANT-BRUD"))).toBe(false);
  });

  it("alarms when the deleted pin is the guest's ONLY pin", async () => {
    const data = await buildLockArrivalReportData(
      mkStorage({ deletedPin, allPins: [deletedPin], reservation }),
      { runAudit: false },
    );

    expect(data.urgentReasons.some(r => r.includes("INVARIANT-BRUD: 1 kode(r)"))).toBe(true);
  });
});
