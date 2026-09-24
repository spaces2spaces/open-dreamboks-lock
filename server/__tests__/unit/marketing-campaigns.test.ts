/**
 * Marketing/upsell SMS campaigns (27/7):
 *  - audience selection filters for both built-in campaigns
 *  - per-stay dedupe via claim-then-send (failed send frees the slot)
 *  - dryRun sends nothing and writes nothing
 *  - scheduler: fires only inside [send_time, +90 min), once per day,
 *    all-failed re-opens the day stamp
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DateTime } from "luxon";
import { runCampaign, runDueMarketingCampaigns } from "../../marketing-service";
import { createMockStorage } from "../mocks/storage";

const smsSpy = vi.fn(async (_p: { to: string; body: string }) => ({ success: true as boolean, error: undefined as string | undefined }));
const emailSpy = vi.fn(async (_p: { to: string; subject: string; text: string }) => ({ success: true as boolean, error: undefined as string | undefined }));

vi.mock("../../notification-client", () => ({
  createNotificationClient: async () => ({ sendPlainSMS: smsSpy, sendPlainTextEmail: emailSpy }),
}));

// 10:00 Copenhagen summer time (CEST = UTC+2) on 27/7.
const NOW_UTC = "2026-07-27T08:00:00.000Z";

function guest(over: Partial<Record<string, any>> = {}) {
  return {
    id: over.id || `res-${Math.random().toString(36).slice(2)}`,
    firstName: "Anna", lastName: "Test",
    status: "Confirmed",
    mobile: "+4512345678",
    owing: "0.00",
    generatedPin: "1234",
    doorCodeSentAt: new Date("2026-07-26T18:00:00Z"),
    notificationSent: null,
    earlyCheckinFrom: null,
    lateCheckoutUntil: null,
    arrival: new Date("2026-07-27T13:00:00Z"),
    departure: new Date("2026-07-28T08:00:00Z"),
    ...over,
  } as any;
}

function makeWorld(settings: Record<string, string> = {}) {
  const storage = createMockStorage({
    property_timezone: "Europe/Copenhagen",
    hotel_name: "Hotel Capsule inn",
    hotel_slug: "hotel-capsule-inn",
    check_in_time: "15:00",
    reservation_checkout_time: "10:00",
    ...settings,
  });
  return storage;
}

beforeEach(() => {
  smsSpy.mockClear();
  smsSpy.mockImplementation(async () => ({ success: true, error: undefined }));
  emailSpy.mockClear();
  emailSpy.mockImplementation(async () => ({ success: true, error: undefined }));
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_UTC));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("early_checkin_offer audience", () => {
  it("includes only clean confirmed arrivals and excludes every disqualifier", async () => {
    const storage = makeWorld();
    storage._reservations.push(
      guest({ id: "ok" }),
      guest({ id: "checked-in", status: "Checked-in" }),
      guest({ id: "no-mobile", mobile: null }),
      guest({ id: "owing", owing: "300.00" }),
      guest({ id: "no-msg", doorCodeSentAt: null }),
      guest({ id: "has-ec", earlyCheckinFrom: new Date("2026-07-27T10:00:00Z") }),
      guest({ id: "bought", }),
      guest({ id: "already-sent" }),
    );
    storage._upsells.push({ reservationId: "bought", kind: "early_checkin", status: "completed", completedAt: new Date() });
    storage._marketingSends.push({ id: "ms-0", reservationId: "already-sent", campaign: "early_checkin_offer", status: "sent" });

    const result = await runCampaign(storage as any, "early_checkin_offer", { dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.recipients!.map(r => r.reservationId)).toEqual(["ok"]);
    // The link opens ONLY this campaign's offer (owner 5/8): &offer=ec.
    expect(result.recipients![0].body).toContain("https://lock.example.com/hotel-capsule-inn/extras?code=1234&offer=ec");
    expect(result.recipients![0].body).toContain("Anna");
    expect(smsSpy).not.toHaveBeenCalled();
    expect(storage._marketingSends.filter(m => m.reservationId === "ok")).toHaveLength(0);
  });

  it("audience is empty after check-in time", async () => {
    vi.setSystemTime(new Date("2026-07-27T14:00:00.000Z")); // 16:00 local > 15:00
    const storage = makeWorld();
    storage._reservations.push(guest({ id: "ok" }));
    const result = await runCampaign(storage as any, "early_checkin_offer", { dryRun: true });
    expect(result.recipients).toEqual([]);
  });
});

describe("late_checkout_offer audience", () => {
  it("targets TOMORROW's departures (evening send), incl. tonight's not-yet-arrived guests", async () => {
    vi.setSystemTime(new Date("2026-07-27T17:05:00.000Z")); // 19:05 local
    const storage = makeWorld();
    storage._reservations.push(
      guest({ id: "ok", status: "Checked-in", mobile: "+4511111111", departure: new Date("2026-07-28T08:00:00Z") }),
      guest({ id: "not-arrived", status: "Confirmed", mobile: "+4522222222", departure: new Date("2026-07-28T08:00:00Z") }),
      guest({ id: "has-lc", status: "Checked-in", mobile: "+4533333333", departure: new Date("2026-07-28T08:00:00Z"), lateCheckoutUntil: new Date("2026-07-28T12:00:00Z") }),
      guest({ id: "no-pin", status: "Checked-in", mobile: "+4544444444", departure: new Date("2026-07-28T08:00:00Z"), generatedPin: null }),
      guest({ id: "today", status: "Checked-in", mobile: "+4555555555", departure: new Date("2026-07-27T08:00:00Z") }),
      guest({ id: "day-after", status: "Checked-in", mobile: "+4566666666", departure: new Date("2026-07-29T08:00:00Z") }),
    );
    const result = await runCampaign(storage as any, "late_checkout_offer", { dryRun: true });
    expect(result.recipients!.map(r => r.reservationId).sort()).toEqual(["not-arrived", "ok"]);
    // The LC link must carry the guest's door code, exactly like early check-in
    // — and open ONLY the late-checkout offer.
    expect(result.recipients![0].body).toContain("https://lock.example.com/hotel-capsule-inn/extras?code=1234&offer=lc");
    // The default text is the evening offer — times but no prices (the guest
    // sees prices on the extras page).
    expect(result.recipients![0].body).toContain("Sleep longer tomorrow?");
    expect(result.recipients![0].body).toContain("12:00, 13:00 or 14:00");
    expect(result.recipients![0].body).not.toContain("DKK");
  });

  it("uses the short /e/<code> link on a hotel's own domain and fits ONE SMS segment", async () => {
    vi.setSystemTime(new Date("2026-07-27T17:05:00.000Z")); // 19:05 local
    const storage = makeWorld({ app_base_url: "https://my.example-hotel.com" });
    storage._reservations.push(guest({ id: "ok", status: "Checked-in", departure: new Date("2026-07-28T08:00:00Z") }));
    const result = await runCampaign(storage as any, "late_checkout_offer", { dryRun: true });
    // ?o=lc: the /e redirect passes the offer scope through to the extras page.
    expect(result.recipients![0].body).toContain("https://my.example-hotel.com/e/1234?o=lc");
    expect(result.recipients![0].body).not.toContain("extras?code=");
    expect(result.recipients![0].body.length).toBeLessThanOrEqual(160);
  });
});

describe("runCampaign real send", () => {
  it("claims, sends, and dedupes on the second run", async () => {
    const storage = makeWorld();
    storage._reservations.push(guest({ id: "g1", mobile: "+4511111111" }), guest({ id: "g2", mobile: "+4522222222" }));

    const first = await runCampaign(storage as any, "early_checkin_offer", {});
    expect(first.sent).toHaveLength(2);
    expect(smsSpy).toHaveBeenCalledTimes(2);

    const second = await runCampaign(storage as any, "early_checkin_offer", {});
    expect(second.sent).toHaveLength(0);
    expect(smsSpy).toHaveBeenCalledTimes(2); // no new sends
  });

  it("a failed send frees the dedupe slot for retry", async () => {
    const storage = makeWorld();
    storage._reservations.push(guest({ id: "g1" }));
    smsSpy.mockImplementationOnce(async () => ({ success: false, error: "twilio down" }));

    const first = await runCampaign(storage as any, "early_checkin_offer", {});
    expect(first.failed).toHaveLength(1);
    expect(storage._marketingSends[0].status).toBe("failed");
    expect(emailSpy).not.toHaveBeenCalled(); // generic failure — no email fallback

    const second = await runCampaign(storage as any, "early_checkin_offer", {});
    expect(second.sent).toHaveLength(1);
  });

  it("guest with email gets BOTH SMS and email (dual channel, 4/8)", async () => {
    const storage = makeWorld();
    storage._reservations.push(guest({ id: "g1", email: "anna@example.com" }));

    const result = await runCampaign(storage as any, "early_checkin_offer", {});
    expect(result.sent).toHaveLength(1);
    expect(smsSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0][0].to).toBe("anna@example.com");
    expect(emailSpy.mock.calls[0][0].text).toContain("extras?code=1234");
    expect(storage._marketingSends[0].sentTo).toBe("+4512345678 + anna@example.com");

    // One claim covers both channels — the second run sends on neither.
    const second = await runCampaign(storage as any, "early_checkin_offer", {});
    expect(second.sent).toHaveLength(0);
    expect(smsSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });

  it("SMS provider down but email delivered → counts as sent, no retry", async () => {
    const storage = makeWorld();
    storage._reservations.push(guest({ id: "g1", email: "anna@example.com" }));
    smsSpy.mockImplementationOnce(async () => ({ success: false, error: "twilio down" }));

    const result = await runCampaign(storage as any, "early_checkin_offer", {});
    expect(result.sent).toHaveLength(1);
    expect(result.failed ?? []).toHaveLength(0);
    expect(storage._marketingSends[0].status).toBe("sent");
    expect(storage._marketingSends[0].sentTo).toBe("anna@example.com");

    const second = await runCampaign(storage as any, "early_checkin_offer", {});
    expect(second.sent).toHaveLength(0); // guest already reached by email
  });

  it("invalid number + guest email → delivered by email, claim stays sent", async () => {
    const storage = makeWorld();
    storage._reservations.push(guest({ id: "g1", email: "anna@example.com" }));
    smsSpy.mockImplementationOnce(async () => ({
      success: false,
      error: `SMS error: {"code":21211,"message":"The 'To' number +4702157106 is not a valid phone number."}`,
    }));

    const result = await runCampaign(storage as any, "early_checkin_offer", {});
    expect(result.sent).toHaveLength(1);
    expect(result.failed ?? []).toHaveLength(0);
    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0][0].to).toBe("anna@example.com");
    expect(emailSpy.mock.calls[0][0].text).toContain("extras?code=1234");
    // Dedupe must hold: the claim stays 'sent' with the actual channel recorded.
    expect(storage._marketingSends[0].status).toBe("sent");
    expect(storage._marketingSends[0].sentTo).toBe("anna@example.com");

    const second = await runCampaign(storage as any, "early_checkin_offer", {});
    expect(second.sent).toHaveLength(0);
  });

  it("invalid number WITHOUT guest email → failed as before", async () => {
    const storage = makeWorld();
    storage._reservations.push(guest({ id: "g1", email: null, personalEmail: null }));
    smsSpy.mockImplementationOnce(async () => ({
      success: false,
      error: `SMS error: {"code":21211,"message":"The 'To' number +269929 is not a valid phone number."}`,
    }));

    const result = await runCampaign(storage as any, "early_checkin_offer", {});
    expect(result.failed).toHaveLength(1);
    expect(emailSpy).not.toHaveBeenCalled();
    expect(storage._marketingSends[0].status).toBe("failed");
  });

  it("duplicate mobiles (multi-capsule bookings) collapse to one SMS", async () => {
    const storage = makeWorld();
    storage._reservations.push(
      guest({ id: "g1", mobile: "+45 12 34 56 78" }),
      guest({ id: "g2", mobile: "+4512345678" }),
    );
    const result = await runCampaign(storage as any, "early_checkin_offer", {});
    expect(result.sent).toHaveLength(1);
    expect(smsSpy).toHaveBeenCalledTimes(1);
  });

  it("aborts above the recipient safety cap without sending", async () => {
    const storage = makeWorld({ marketing_max_recipients: "2" });
    storage._reservations.push(
      guest({ mobile: "+4511111111" }),
      guest({ mobile: "+4522222222" }),
      guest({ mobile: "+4533333333" }),
    );
    const result = await runCampaign(storage as any, "early_checkin_offer", {});
    expect(result.ok).toBe(false);
    expect(smsSpy).not.toHaveBeenCalled();
  });

  it("testTo sends one sample without claiming, personalized from the audience", async () => {
    const storage = makeWorld();
    storage._reservations.push(guest({ id: "g1" }));
    const result = await runCampaign(storage as any, "early_checkin_offer", { testTo: "+4520000000" });
    expect(result.ok).toBe(true);
    expect(smsSpy).toHaveBeenCalledTimes(1);
    expect(smsSpy.mock.calls[0][0].to).toBe("+4520000000");
    expect(smsSpy.mock.calls[0][0].body).toContain("/extras?code=1234");
    expect(smsSpy.mock.calls[0][0].body).toContain("Anna");
    expect(storage._marketingSends).toHaveLength(0);
  });

  it("testTo after the real run still renders a personalized ?code link (5/8: sample fallback)", async () => {
    const storage = makeWorld();
    storage._reservations.push(guest({ id: "g1" }));
    storage._marketingSends.push({ id: "ms-0", reservationId: "g1", campaign: "early_checkin_offer", status: "sent" });

    const result = await runCampaign(storage as any, "early_checkin_offer", { testTo: "+4520000000" });
    expect(result.ok).toBe(true);
    expect(smsSpy.mock.calls[0][0].body).toContain("extras?code=1234&offer=ec");
    expect(storage._marketingSends).toHaveLength(1); // the test claims nothing
  });

  it("testTo with truly no reservations falls back to the plain link", async () => {
    const storage = makeWorld();
    const result = await runCampaign(storage as any, "early_checkin_offer", { testTo: "+4520000000" });
    expect(result.ok).toBe(true);
    expect(smsSpy.mock.calls[0][0].body).toContain("/extras");
    expect(smsSpy.mock.calls[0][0].body).not.toContain("code=");
  });
});

describe("runDueMarketingCampaigns scheduler", () => {
  const tzNow = (iso: string) => DateTime.fromISO(iso, { zone: "Europe/Copenhagen" });

  it("fires only inside [send_time, +90min) and once per day", async () => {
    const storage = makeWorld({
      marketing_early_checkin_offer_enabled: "true",
      marketing_early_checkin_offer_send_time: "09:00",
    });
    storage._reservations.push(guest({ id: "g1" }));

    await runDueMarketingCampaigns(storage as any, tzNow("2026-07-27T08:59"));
    expect(smsSpy).not.toHaveBeenCalled();

    await runDueMarketingCampaigns(storage as any, tzNow("2026-07-27T09:05"));
    expect(smsSpy).toHaveBeenCalledTimes(1);
    expect((await storage.getSetting("marketing_early_checkin_offer_last_sent_date"))?.value).toBe("2026-07-27");

    storage._reservations.push(guest({ id: "g2" }));
    await runDueMarketingCampaigns(storage as any, tzNow("2026-07-27T09:30"));
    expect(smsSpy).toHaveBeenCalledTimes(1); // same day → no second run
  });

  it("does not fire outside the 90-minute window (late enabling)", async () => {
    const storage = makeWorld({
      marketing_early_checkin_offer_enabled: "true",
      marketing_early_checkin_offer_send_time: "09:00",
    });
    storage._reservations.push(guest({ id: "g1" }));
    await runDueMarketingCampaigns(storage as any, tzNow("2026-07-27T12:00"));
    expect(smsSpy).not.toHaveBeenCalled();
  });

  it("disabled campaigns never fire from the scheduler", async () => {
    const storage = makeWorld({ marketing_early_checkin_offer_send_time: "09:00" });
    storage._reservations.push(guest({ id: "g1" }));
    await runDueMarketingCampaigns(storage as any, tzNow("2026-07-27T09:05"));
    expect(smsSpy).not.toHaveBeenCalled();
  });

  it("all-failed re-opens the day stamp", async () => {
    // runCampaign derives its own clock — align the fake system time with the
    // scheduler override (LC fires 19:00, targeting tomorrow's departures).
    vi.setSystemTime(new Date("2026-07-27T17:05:00.000Z")); // 19:05 local
    const storage = makeWorld({
      marketing_late_checkout_offer_enabled: "true",
      marketing_late_checkout_offer_send_time: "19:00",
    });
    storage._reservations.push(guest({ id: "g1", status: "Checked-in", departure: new Date("2026-07-28T08:00:00Z") }));
    smsSpy.mockImplementation(async () => ({ success: false, error: "twilio down" }));

    await runDueMarketingCampaigns(storage as any, tzNow("2026-07-27T19:05"));
    expect((await storage.getSetting("marketing_late_checkout_offer_last_sent_date"))?.value ?? "").toBe("");
  });
});
