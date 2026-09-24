/**
 * Tiered late-checkout pricing (owner 4/8): parseLateCheckoutTiers turns the
 * `late_checkout_price_tiers` setting into sorted {hhmm, dkk} tiers. Prices
 * are CUMULATIVE from the standard checkout — quoteLateCheckout charges the
 * difference between tiers on a top-up.
 */
import { describe, it, expect } from "vitest";
import { parseLateCheckoutTiers } from "../../early-checkin-service";

describe("parseLateCheckoutTiers", () => {
  it("parses the production format", () => {
    expect(parseLateCheckoutTiers("12:00=49,13:00=79,14:00=119")).toEqual([
      { hhmm: "12:00", dkk: 49 },
      { hhmm: "13:00", dkk: 79 },
      { hhmm: "14:00", dkk: 119 },
    ]);
  });

  it("tolerates whitespace, dot decimals, and sorts by time", () => {
    expect(parseLateCheckoutTiers(" 14:00 = 119 , 12:00=49.5 ")).toEqual([
      { hhmm: "12:00", dkk: 49.5 },
      { hhmm: "14:00", dkk: 119 },
    ]);
  });

  it("empty/unset/garbage → no tiers (legacy hourly model applies)", () => {
    expect(parseLateCheckoutTiers(undefined)).toEqual([]);
    expect(parseLateCheckoutTiers(null)).toEqual([]);
    expect(parseLateCheckoutTiers("")).toEqual([]);
    expect(parseLateCheckoutTiers("banana")).toEqual([]);
    // Malformed entries are skipped, valid ones survive.
    expect(parseLateCheckoutTiers("nope,13:00=79")).toEqual([{ hhmm: "13:00", dkk: 79 }]);
  });
});
