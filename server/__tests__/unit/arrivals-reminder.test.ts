/**
 * Daily arrivals checklist reminder (_jobArrivalsChecklistReminder):
 *  - fires only at/after `arrivals_reminder_time` (default 01:00 hotel time)
 *  - sends ONE mail per day to every lock_arrival_report_email recipient
 *    (persisted last-sent date guards deploys/restarts)
 *  - a failed send re-opens the day's stamp but backs off 30 min so a dead
 *    mail provider can't turn into a send-per-tick storm
 *  - silent when no recipients are configured
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReservationStateMachine } from "../../reservation-state-machine";
import { createMockStorage } from "../mocks/storage";

const sendSpy = vi.fn(async (_params: { to: string; subject: string; text: string; html?: string }) => ({ success: true as boolean, error: undefined as string | undefined }));

vi.mock("../../notification-client", () => ({
  createNotificationClient: async () => ({ sendPlainTextEmail: sendSpy }),
}));

function makeSm(settings: Record<string, string>) {
  const storage = createMockStorage({
    property_timezone: "Europe/Copenhagen",
    hotel_name: "Testhotel",
    ...settings,
  });
  const sm = new ReservationStateMachine(storage as any, {} as any, null, "test-tenant");
  return { storage, sm, run: () => (sm as any)._jobArrivalsChecklistReminder() as Promise<void> };
}

describe("_jobArrivalsChecklistReminder", () => {
  beforeEach(() => {
    sendSpy.mockClear();
    sendSpy.mockImplementation(async () => ({ success: true, error: undefined }));
    vi.useFakeTimers();
    // 03:00 Copenhagen summer time (CEST = UTC+2) on 23/7 → 01:00 default is due.
    vi.setSystemTime(new Date("2026-07-23T01:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends one mail per recipient once due, and stamps the day", async () => {
    const s = makeSm({ lock_arrival_report_email: "je@example.com, mhm@example.com" });

    await s.run();

    expect(sendSpy).toHaveBeenCalledTimes(2);
    const recipients = sendSpy.mock.calls.map(c => c[0].to).sort();
    expect(recipients).toEqual(["je@example.com", "mhm@example.com"]);
    expect(sendSpy.mock.calls[0][0].subject).toContain("Huskeliste");
    // Share link: secret token, no login — and menu-free rendering client-side.
    expect(sendSpy.mock.calls[0][0].text).toMatch(/\/arrivals\/t\/[a-f0-9]{64}\?date=2026-07-23/);
    expect(sendSpy.mock.calls[0][0].text).toContain("betalingslink");
    expect(sendSpy.mock.calls[0][0].text).toContain("Inspiceret");
    expect((await s.storage.getSetting("arrivals_reminder_last_sent_date"))?.value).toBe("2026-07-23");
  });

  it("does not send before the configured time", async () => {
    const s = makeSm({
      lock_arrival_report_email: "je@example.com",
      arrivals_reminder_time: "05:00", // local now is 03:00
    });

    await s.run();

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("sends only once per day (persisted stamp survives a second run)", async () => {
    const s = makeSm({ lock_arrival_report_email: "je@example.com" });

    await s.run();
    await s.run();

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("a failed send re-opens the stamp but backs off 30 minutes", async () => {
    const s = makeSm({ lock_arrival_report_email: "je@example.com" });
    sendSpy.mockImplementation(async () => ({ success: false, error: "smtp down" }));

    await s.run();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    // Stamp re-opened: no longer today's date (mock returns undefined for "").
    expect((await s.storage.getSetting("arrivals_reminder_last_sent_date"))?.value || "").not.toBe("2026-07-23");

    // Immediately after: blocked by the in-memory backoff (no storm).
    await s.run();
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // 31 minutes later the mail provider works again → retry succeeds.
    vi.setSystemTime(new Date("2026-07-23T01:31:00.000Z"));
    sendSpy.mockImplementation(async () => ({ success: true, error: undefined }));
    await s.run();
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect((await s.storage.getSetting("arrivals_reminder_last_sent_date"))?.value).toBe("2026-07-23");
  });

  it("does nothing when no recipients are configured", async () => {
    const s = makeSm({});

    await s.run();

    expect(sendSpy).not.toHaveBeenCalled();
  });
});
