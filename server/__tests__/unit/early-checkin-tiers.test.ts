/**
 * Tiered early check-in pricing (owner 5/8): `early_checkin_price_tiers` =
 * "10:00=119,12:00=79,14:00=49" — the guest picks WHEN their unchanged door
 * code starts working. selectEarlyCheckinTierOptions turns the tiers into
 * buyable options given now / the normal window start / when the capsule
 * becomes free.
 */
import { describe, it, expect } from "vitest";
import { selectEarlyCheckinTierOptions, withCleaningBuffer } from "../../early-checkin-service";
import { DateTime } from "luxon";

const TZ = "Europe/Copenhagen";
const TIERS = [
  { hhmm: "10:00", dkk: 119 },
  { hhmm: "12:00", dkk: 79 },
  { hhmm: "14:00", dkk: 49 },
];
// Arrival day 5/8-2026, normal check-in 15:00 CEST (= 13:00Z).
const at = (hhmm: string) => DateTime.fromISO(`2026-08-05T${hhmm}`, { zone: TZ }).toMillis();
const VALID_FROM = at("15:00");

const run = (nowHHMM: string, freeFromMs = 0) =>
  selectEarlyCheckinTierOptions(TIERS, VALID_FROM, at(nowHHMM), freeFromMs, TZ, 7.45);

describe("selectEarlyCheckinTierOptions", () => {
  it("before the first tier: all three starts are buyable, earlier = pricier", () => {
    const options = run("09:00");
    expect(options.map(o => [o.label, o.dkk, o.hours])).toEqual([
      ["10:00", 119, 5],
      ["12:00", 79, 3],
      ["14:00", 49, 1],
    ]);
    // Completion derives the start back from hours: validFrom − hours.
    expect(new Date(options[0].from).getTime()).toBe(VALID_FROM - 5 * 3600e3);
  });

  it("mid-day: only the LATEST passed tier survives as 'check in now'", () => {
    const options = run("12:30");
    // 10:00 (119) is dominated by 12:00 (79) — same immediate access, cheaper.
    expect(options.map(o => [o.label, o.dkk])).toEqual([
      ["12:00", 79],
      ["14:00", 49],
    ]);
  });

  it("occupied until 12:00 (late checkout): only starts at/after the capsule frees", () => {
    const options = run("09:00", at("12:00"));
    expect(options.map(o => o.label)).toEqual(["12:00", "14:00"]);
  });

  it("fully blocked: no options — the quote rejects as occupied", () => {
    expect(run("14:30", at("15:00"))).toEqual([]);
  });

  it("cleaning buffer: previous guest until 10:00 kills the 10:00 tier (511-hændelsen 6/8)", () => {
    // Occupied until 10:00 + 60 min buffer → earliest sellable start 11:00.
    const options = run("09:00", withCleaningBuffer(at("10:00"), 60));
    expect(options.map(o => o.label)).toEqual(["12:00", "14:00"]);
  });

  it("cleaning buffer: a FREE capsule is untouched — 10:00 stays sellable", () => {
    expect(withCleaningBuffer(0, 60)).toBe(0);
    const options = run("09:00", withCleaningBuffer(0, 60));
    expect(options.map(o => o.label)).toEqual(["10:00", "12:00", "14:00"]);
  });

  it("tiers at/after the normal check-in are never offered", () => {
    const late = selectEarlyCheckinTierOptions(
      [{ hhmm: "14:00", dkk: 49 }, { hhmm: "15:00", dkk: 10 }, { hhmm: "16:00", dkk: 5 }],
      VALID_FROM,
      at("09:00"),
      0,
      TZ,
      7.45
    );
    expect(late.map(o => o.label)).toEqual(["14:00"]);
  });
});
