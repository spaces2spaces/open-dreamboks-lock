/**
 * Arrival-report upsell data: paid early check-ins / late check-outs with
 * amounts must appear as a standing revenue line (owner request 22/7). The
 * section moved from the email to the /arrivals page, so the assertions
 * target the structured report DATA the page consumes.
 */
import { describe, it, expect } from "vitest";
import { buildLockArrivalReportData } from "../../lock-arrival-report";
import { createMockStorage } from "../mocks/storage";

const HOUR = 3600 * 1000;

function makeStorage() {
  const storage = createMockStorage({
    property_timezone: "Europe/Copenhagen",
    hotel_name: "Testhotel",
    check_in_time: "15:00",
    reservation_checkout_time: "11:00",
  });
  storage._reservations.push({
    id: "res-1",
    pmsId: "M-1",
    roomId: "room-1",
    status: "Checked-in",
    firstName: "Anna",
    lastName: "Guest",
    arrival: new Date(),
    departure: new Date(Date.now() + 20 * HOUR),
  } as any);
  storage._rooms.push({ id: "room-1", name: "101" } as any);
  return storage;
}

describe("arrival report — upsell revenue data", () => {
  it("lists paid early check-in and late check-out with amounts and a total", async () => {
    const storage = makeStorage();
    storage._upsells.push(
      {
        id: "u1", reservationId: "res-1", kind: "early_checkin", status: "completed",
        amount: "150.00", currency: "DKK", completedAt: new Date(Date.now() - HOUR),
      },
      {
        id: "u2", reservationId: "res-1", kind: "late_checkout", status: "completed",
        amount: "100.00", currency: "DKK", completedAt: new Date(Date.now() - 2 * HOUR),
      },
    );

    const data = await buildLockArrivalReportData(storage as any, { runAudit: false });

    expect(data.upsells.lines).toHaveLength(2);
    expect(data.upsells.totals).toBe("250.00 DKK");
    const kinds = data.upsells.lines.map(l => `${l.kind}: ${l.guestName}`);
    expect(kinds).toContain("Early check-in: Anna Guest");
    expect(kinds).toContain("Late check-out: Anna Guest");
    expect(data.upsells.lines.map(l => l.amount)).toContain("150.00 DKK");
  });

  it("section is empty when nothing was purchased", async () => {
    const storage = makeStorage();

    const data = await buildLockArrivalReportData(storage as any, { runAudit: false });

    expect(data.upsells.lines).toHaveLength(0);
    expect(data.upsells.totals).toBe("");
  });

  it("rows carry per-guest paid early/late times for the Tilkøb column", async () => {
    const storage = makeStorage();
    const today = new Date();
    today.setHours(10, 30, 0, 0);
    const tomorrow = new Date(Date.now() + 24 * HOUR);
    tomorrow.setHours(15, 0, 0, 0);
    Object.assign(storage._reservations[0], {
      earlyCheckinFrom: today,
      lateCheckoutUntil: tomorrow,
    });

    const data = await buildLockArrivalReportData(storage as any, { runAudit: false });

    const row = data.rows.find(r => r.guestName === "Anna Guest")!;
    expect(row.earlyCheckinFrom).toBe("10:30"); // report day → time only
    expect(row.lateCheckoutUntil).toMatch(/^\d{1,2}\/\d{1,2} 15:00$/); // other day → date-prefixed
  });

  it("rows without purchases have null upsell fields", async () => {
    const storage = makeStorage();

    const data = await buildLockArrivalReportData(storage as any, { runAudit: false });

    const row = data.rows.find(r => r.guestName === "Anna Guest")!;
    expect(row.earlyCheckinFrom).toBeNull();
    expect(row.lateCheckoutUntil).toBeNull();
  });

  it("pending (unpaid) upsells are not counted", async () => {
    const storage = makeStorage();
    storage._upsells.push({
      id: "u3", reservationId: "res-1", kind: "early_checkin", status: "pending_payment",
      amount: "150.00", currency: "DKK", completedAt: null,
    });

    const data = await buildLockArrivalReportData(storage as any, { runAudit: false });

    expect(data.upsells.lines).toHaveLength(0);
  });
});
