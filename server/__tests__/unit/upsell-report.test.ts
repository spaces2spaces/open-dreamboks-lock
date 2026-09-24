/**
 * Daily upsell report (3/8): day bucketing (today vs yesterday, hotel tz),
 * hourly paid/abandoned split, EC funnel parsed from the targeted log
 * sources, and the render's funnel line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildUpsellReportData, renderUpsellReport } from "../../upsell-report";
import { createMockStorage } from "../mocks/storage";

// 12:00 Copenhagen summer time (CEST = UTC+2) on 3/8.
const NOW_UTC = "2026-08-03T10:00:00.000Z";

function makeWorld() {
  return createMockStorage({
    property_timezone: "Europe/Copenhagen",
    hotel_name: "Hotel Capsule inn",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_UTC));
});
afterEach(() => vi.useRealTimers());

describe("buildUpsellReportData", () => {
  it("buckets purchases into today vs yesterday in hotel time", async () => {
    const storage = makeWorld();
    storage._upsells.push(
      { reservationId: "a", kind: "early_checkin", status: "completed", amount: "150", completedAt: new Date("2026-08-03T07:20:00Z") }, // today
      { reservationId: "b", kind: "late_checkout", status: "completed", amount: "75", completedAt: new Date("2026-08-02T21:00:00Z") },  // yesterday 23:00 local
      { reservationId: "c", kind: "late_checkout", status: "completed", amount: "75", completedAt: new Date("2026-08-03T08:00:00Z") },  // today
    );
    storage._hourlyBookings.push(
      { id: "h1", status: "confirmed", amount: "499", paidAt: new Date("2026-08-03T06:00:00Z"), createdAt: new Date("2026-08-03T05:50:00Z") },
      { id: "h2", status: "expired", amount: "599", paidAt: new Date("2026-08-02T10:00:00Z"), createdAt: new Date("2026-08-02T09:50:00Z") },
      { id: "h3", status: "cancelled", amount: "499", paidAt: null, createdAt: new Date("2026-08-03T04:00:00Z") }, // abandoned today
      { id: "h4", status: "cancelled", amount: "75", paidAt: new Date("2026-08-02T12:00:00Z"), createdAt: new Date("2026-08-02T11:00:00Z") }, // paid-then-cancelled: counts as paid, not abandoned
    );

    const data = await buildUpsellReportData(storage as any);
    expect(data.today).toMatchObject({ ecCount: 1, ecDkk: 150, lcCount: 1, lcDkk: 75, hourlyPaidCount: 1, hourlyPaidDkk: 499, hourlyAbandonedCount: 1 });
    expect(data.yesterday).toMatchObject({ ecCount: 0, lcCount: 1, lcDkk: 75, hourlyPaidCount: 2, hourlyPaidDkk: 674, hourlyAbandonedCount: 0 });
  });

  it("parses today's EC funnel from marketing + extras-funnel logs", async () => {
    const storage = makeWorld();
    const log = (source: string, message: string, at: string) =>
      storage._logs?.push?.({ source, message, timestamp: new Date(at) });
    await storage.createLog({ source: "marketing", message: "Marketing early_checkin_offer run (scheduled): 33 sent, 3 failed, 0 skipped", level: "info" });
    await storage.createLog({ source: "extras-funnel", message: "Extras funnel: early_checkin lookup (extras) → quoted 4h 150 DKK — Anna Test (401s)", level: "info" });
    await storage.createLog({ source: "extras-funnel", message: "Extras funnel: early_checkin lookup (extras) → rejected: too_early", level: "info" });
    await storage.createLog({ source: "extras-funnel", message: "Extras funnel: early_checkin lookup (kiosk) → rejected: too_early", level: "info" });
    await storage.createLog({ source: "extras-funnel", message: "Extras funnel: late_checkout lookup (extras) → quoted 2 option(s) — X Y (401s)", level: "info" }); // ignored (LC)
    void log;

    const data = await buildUpsellReportData(storage as any);
    expect(data.funnel).toMatchObject({ smsSent: 33, smsFailed: 3, lookups: 3, quoted: 1 });
    expect(data.funnel.rejectedByReason).toEqual({ too_early: 2 });

    const { body, subject } = renderUpsellReport(data);
    expect(subject).toContain("Mersalg");
    expect(body).toContain("33 SMS sendt (3 fejlede) → 3 åbnede tilbuddet → 1 fik pris (afvist: 2× too_early) → 0 købte");
  });
});
