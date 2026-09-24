import { describe, it, expect } from "vitest";
import { buildValidityWindow, hasActiveLateCheckout } from "../../pin-validity-window";

function mockSettings(overrides: Record<string, string> = {}) {
  const settings: Record<string, string> = {
    check_in_time: "15:00",
    reservation_checkout_time: "11:00",
    property_timezone: "Europe/Copenhagen",
    ...overrides,
  };
  return {
    async getSetting(key: string) {
      return settings[key] ? { value: settings[key] } : null;
    },
  };
}

describe("buildValidityWindow", () => {
  it("day-use (same-day 24h-rate): falls back to ACTUAL arrival/departure instead of an inverted window", async () => {
    // 22/7 incident (Karim/724s): arrive 10:08, depart 15:00 the same day.
    // Forcing check_in_time→checkout_time inverts the window (15:00 → 11:00),
    // which TTLock rejects and which sent the create loop spamming MEWS notes.
    const storage = mockSettings();
    const reservation = {
      arrival: new Date("2026-07-22T08:08:00Z"),   // 10:08 Copenhagen
      departure: new Date("2026-07-22T13:00:00Z"), // 15:00 Copenhagen
    } as any;

    const result = await buildValidityWindow(storage, reservation);

    expect(result.validFrom.toISOString()).toBe("2026-07-22T08:08:00.000Z");
    expect(result.validTo.toISOString()).toBe("2026-07-22T13:00:00.000Z");
    expect(result.validTo.getTime()).toBeGreaterThan(result.validFrom.getTime());
  });

  it("day-use fallback never fires for normal overnight stays", async () => {
    const storage = mockSettings();
    const reservation = {
      arrival: new Date("2026-07-22T08:08:00Z"),
      departure: new Date("2026-07-23T09:00:00Z"), // next day
    } as any;

    const result = await buildValidityWindow(storage, reservation);

    // Standard behavior untouched: 15:00 arrival day → 11:00 departure day (CPH, UTC+2)
    expect(result.validFrom.toISOString()).toBe("2026-07-22T13:00:00.000Z");
    expect(result.validTo.toISOString()).toBe("2026-07-23T09:00:00.000Z");
  });

  it("returns correct validFrom/validTo for standard check-in/checkout", async () => {
    const storage = mockSettings();
    const reservation = {
      arrival: new Date("2026-04-10T00:00:00Z"),
      departure: new Date("2026-04-12T00:00:00Z"),
    } as any;

    const result = await buildValidityWindow(storage, reservation);

    // April 10 at 15:00 Copenhagen (UTC+2) = 13:00 UTC
    expect(result.validFrom.toISOString()).toBe("2026-04-10T13:00:00.000Z");
    // April 12 at 11:00 Copenhagen (UTC+2) = 09:00 UTC
    expect(result.validTo.toISOString()).toBe("2026-04-12T09:00:00.000Z");
  });

  it("uses fallback defaults when settings are missing", async () => {
    const storage = {
      async getSetting() { return null; },
    };
    const reservation = {
      arrival: new Date("2026-04-10T00:00:00Z"),
      departure: new Date("2026-04-12T00:00:00Z"),
    } as any;

    const result = await buildValidityWindow(storage, reservation);

    // Defaults: 15:00 check-in, 11:00 checkout, Europe/Copenhagen
    expect(result.validFrom.toISOString()).toBe("2026-04-10T13:00:00.000Z");
    expect(result.validTo.toISOString()).toBe("2026-04-12T09:00:00.000Z");
  });

  it("handles NaN-producing malformed time strings gracefully", async () => {
    const storage = mockSettings({
      check_in_time: "invalid",
      reservation_checkout_time: "also-bad",
    });
    const reservation = {
      arrival: new Date("2026-04-10T00:00:00Z"),
      departure: new Date("2026-04-12T00:00:00Z"),
    } as any;

    const result = await buildValidityWindow(storage, reservation);

    // Fallbacks: hour 15, minute 0 for check-in; hour 11, minute 0 for checkout
    expect(result.validFrom.toISOString()).toBe("2026-04-10T13:00:00.000Z");
    expect(result.validTo.toISOString()).toBe("2026-04-12T09:00:00.000Z");
  });

  it("handles different timezone (America/New_York)", async () => {
    const storage = mockSettings({
      property_timezone: "America/New_York",
    });
    const reservation = {
      arrival: new Date("2026-04-10T00:00:00Z"),
      departure: new Date("2026-04-12T00:00:00Z"),
    } as any;

    const result = await buildValidityWindow(storage, reservation);

    // Arrival is "2026-04-10T00:00:00Z" — in EDT that's April 9 at 20:00.
    // Luxon sets the time to 15:00 on that local date (April 9), so validFrom = April 9 15:00 EDT = 19:00 UTC
    expect(result.validFrom.toISOString()).toBe("2026-04-09T19:00:00.000Z");
    // Departure "2026-04-12T00:00:00Z" — in EDT that's April 11 at 20:00.
    // Luxon sets checkout to 11:00 on that local date (April 11), so validTo = April 11 11:00 EDT = 15:00 UTC
    expect(result.validTo.toISOString()).toBe("2026-04-11T15:00:00.000Z");
  });

  it("handles midnight check-in (00:00)", async () => {
    const storage = mockSettings({ check_in_time: "00:00" });
    const reservation = {
      arrival: new Date("2026-04-10T00:00:00Z"),
      departure: new Date("2026-04-12T00:00:00Z"),
    } as any;

    const result = await buildValidityWindow(storage, reservation);

    // April 10 at 00:00 Copenhagen (UTC+2) = April 9 22:00 UTC
    expect(result.validFrom.toISOString()).toBe("2026-04-09T22:00:00.000Z");
  });

  it("handles non-standard check-in time with minutes (14:30)", async () => {
    const storage = mockSettings({ check_in_time: "14:30" });
    const reservation = {
      arrival: new Date("2026-04-10T00:00:00Z"),
      departure: new Date("2026-04-12T00:00:00Z"),
    } as any;

    const result = await buildValidityWindow(storage, reservation);

    // April 10 at 14:30 Copenhagen (UTC+2) = 12:30 UTC
    expect(result.validFrom.toISOString()).toBe("2026-04-10T12:30:00.000Z");
  });
});

describe("buildValidityWindow — early check-in fold", () => {
  const base = {
    arrival: new Date("2026-04-10T00:00:00Z"),
    departure: new Date("2026-04-12T00:00:00Z"),
  };

  it("uses earlyCheckinFrom when earlier than standard validFrom and within 72h", async () => {
    const storage = mockSettings();
    // Standard validFrom = 2026-04-10T13:00Z (15:00 CPH). Early purchase 10:23 CPH.
    const early = new Date("2026-04-10T08:23:00Z");
    const result = await buildValidityWindow(storage, { ...base, earlyCheckinFrom: early } as any);
    expect(result.validFrom.toISOString()).toBe(early.toISOString());
    expect(result.validTo.toISOString()).toBe("2026-04-12T09:00:00.000Z");
  });

  it("ignores earlyCheckinFrom beyond the 72h sale horizon", async () => {
    const storage = mockSettings();
    const stale = new Date("2026-04-06T10:00:00Z"); // >72h before 2026-04-10T13:00Z
    const result = await buildValidityWindow(storage, { ...base, earlyCheckinFrom: stale } as any);
    expect(result.validFrom.toISOString()).toBe("2026-04-10T13:00:00.000Z");
  });

  it("ignores earlyCheckinFrom that is not earlier than standard validFrom", async () => {
    const storage = mockSettings();
    const later = new Date("2026-04-10T14:30:00Z"); // after 13:00Z
    const result = await buildValidityWindow(storage, { ...base, earlyCheckinFrom: later } as any);
    expect(result.validFrom.toISOString()).toBe("2026-04-10T13:00:00.000Z");
  });

  it("ignores null earlyCheckinFrom", async () => {
    const storage = mockSettings();
    const result = await buildValidityWindow(storage, { ...base, earlyCheckinFrom: null } as any);
    expect(result.validFrom.toISOString()).toBe("2026-04-10T13:00:00.000Z");
  });
});

describe("buildValidityWindow — late checkout fold", () => {
  const base = {
    arrival: new Date("2026-04-10T00:00:00Z"),
    departure: new Date("2026-04-12T00:00:00Z"),
  };
  // Standard validTo = 2026-04-12T09:00Z (11:00 CPH)

  it("uses lateCheckoutUntil when later than standard validTo and within 12h", async () => {
    const storage = mockSettings();
    const late = new Date("2026-04-12T12:00:00Z"); // 14:00 CPH
    const result = await buildValidityWindow(storage, { ...base, lateCheckoutUntil: late } as any);
    expect(result.validTo.toISOString()).toBe(late.toISOString());
    expect(result.validFrom.toISOString()).toBe("2026-04-10T13:00:00.000Z");
  });

  it("ignores lateCheckoutUntil more than 12h past checkout (stale after date change)", async () => {
    const storage = mockSettings();
    const stale = new Date("2026-04-13T12:00:00Z");
    const result = await buildValidityWindow(storage, { ...base, lateCheckoutUntil: stale } as any);
    expect(result.validTo.toISOString()).toBe("2026-04-12T09:00:00.000Z");
  });

  it("ignores lateCheckoutUntil earlier than standard validTo", async () => {
    const storage = mockSettings();
    const earlier = new Date("2026-04-12T07:00:00Z");
    const result = await buildValidityWindow(storage, { ...base, lateCheckoutUntil: earlier } as any);
    expect(result.validTo.toISOString()).toBe("2026-04-12T09:00:00.000Z");
  });

  it("folds BOTH early check-in and late checkout on the same reservation", async () => {
    const storage = mockSettings();
    const early = new Date("2026-04-10T09:00:00Z");
    const late = new Date("2026-04-12T11:30:00Z");
    const result = await buildValidityWindow(storage, { ...base, earlyCheckinFrom: early, lateCheckoutUntil: late } as any);
    expect(result.validFrom.toISOString()).toBe(early.toISOString());
    expect(result.validTo.toISOString()).toBe(late.toISOString());
  });
});

describe("hasActiveLateCheckout", () => {
  it("true for a future lateCheckoutUntil within 12h", () => {
    expect(hasActiveLateCheckout({ lateCheckoutUntil: new Date(Date.now() + 2 * 3600e3) })).toBe(true);
  });
  it("false when unset, past, or absurdly far in the future", () => {
    expect(hasActiveLateCheckout({ lateCheckoutUntil: null })).toBe(false);
    expect(hasActiveLateCheckout({ lateCheckoutUntil: new Date(Date.now() - 60e3) })).toBe(false);
    expect(hasActiveLateCheckout({ lateCheckoutUntil: new Date(Date.now() + 13 * 3600e3) })).toBe(false);
  });
});
