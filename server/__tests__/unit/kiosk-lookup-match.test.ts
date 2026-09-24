/**
 * Kiosk "Find my door code" matching — guests type names that don't match
 * MEWS letter-for-letter (swapped first/last, typos, dropped diacritics), or
 * they type their Booking.com / MEWS number instead.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeText,
  editDistance,
  fuzzyEquals,
  matchGuestName,
  matchesBookingNumber,
  normalizeBookingNumber,
  rankKioskMatches,
} from "../../kiosk-lookup-match";

describe("normalizeText", () => {
  it("lowercases, folds diacritics and Nordic letters, collapses punctuation", () => {
    expect(normalizeText("  Søren  Ærø-Åberg ")).toBe("soren aero aberg");
    expect(normalizeText("Müller")).toBe("muller");
    expect(normalizeText("O'Neil")).toBe("o neil");
    expect(normalizeText("Łukasz Đorđević")).toBe("lukasz dordevic");
    expect(normalizeText(null)).toBe("");
  });
});

describe("editDistance / fuzzyEquals", () => {
  it("counts substitutions, insertions and transpositions", () => {
    expect(editDistance("hansen", "hanson")).toBe(1);
    expect(editDistance("hansen", "hansne")).toBe(1);
    expect(editDistance("hansen", "hansenn")).toBe(1);
    expect(editDistance("abc", "xyz")).toBe(3);
  });
  it("scales tolerance with word length", () => {
    expect(fuzzyEquals("li", "lu")).toBe(false); // short: exact only
    expect(fuzzyEquals("hansen", "hanson")).toBe(true); // 6 letters: 1 edit
    expect(fuzzyEquals("hansen", "hanzon")).toBe(false); // 2 edits too many
    expect(fuzzyEquals("andersson", "anderson")).toBe(true);
    expect(fuzzyEquals("kristensen", "christensen")).toBe(true); // 10 letters: 2 edits
  });
});

describe("matchGuestName", () => {
  const guest = { firstName: "Dovilė", lastName: "Žukaitė" };

  it("matches the last name exactly, ignoring case and diacritics", () => {
    expect(matchGuestName(guest, "zukaite")).toBe("exact");
    expect(matchGuestName(guest, "ŽUKAITĖ")).toBe("exact");
  });
  it("matches when first and last name are swapped", () => {
    expect(matchGuestName(guest, "Dovile")).toBe("exact");
    expect(matchGuestName({ firstName: "Hansen", lastName: "Jesper" }, "Hansen")).toBe("exact");
  });
  it("matches the full name in either order, with or without spaces", () => {
    expect(matchGuestName(guest, "Dovile Zukaite")).toBe("exact");
    expect(matchGuestName(guest, "Zukaite Dovile")).toBe("exact");
    expect(matchGuestName(guest, "DovileZukaite")).toBe("exact");
  });
  it("handles multi-word surnames and particles", () => {
    const g = { firstName: "Anna", lastName: "van der Berg" };
    expect(matchGuestName(g, "vanderberg")).toBe("exact");
    expect(matchGuestName(g, "Berg")).toBe("exact");
    expect(matchGuestName(g, "van Berg")).toBe("exact");
  });
  it("matches when MEWS holds the full name in one field", () => {
    const g = { firstName: "Jesper Hansen", lastName: "Guest" };
    expect(matchGuestName(g, "Hansen")).toBe("exact");
    expect(matchGuestName(g, "Jesper Hansen")).toBe("exact");
  });
  it("tolerates typos as fuzzy, not exact", () => {
    expect(matchGuestName(guest, "Zukaide")).toBe("fuzzy");
    expect(matchGuestName(guest, "Dovle")).toBe("fuzzy");
    expect(matchGuestName({ firstName: "Peter", lastName: "Hansen" }, "Hanson")).toBe("fuzzy");
  });
  it("rejects unrelated names and short/empty queries", () => {
    expect(matchGuestName(guest, "Jensen")).toBeNull();
    expect(matchGuestName(guest, "D")).toBeNull();
    expect(matchGuestName(guest, "Dovile Jensen")).toBeNull(); // one word doesn't fit
    expect(matchGuestName({ firstName: "Guest", lastName: "2" }, "2")).toBeNull();
  });
});

describe("matchesBookingNumber", () => {
  const r = { confirmationCode: "1054", extId: "1054", channelNumber: "4321098765", channelManagerNumber: "SM-77881122" };
  it("normalizes spacing, dots and dashes", () => {
    expect(normalizeBookingNumber("4321.098.765")).toBe("4321098765");
    expect(matchesBookingNumber(r, "4321.098.765")).toBe(true);
    expect(matchesBookingNumber(r, " 4321 098 765 ")).toBe(true);
  });
  it("matches the MEWS number and the channel-manager number", () => {
    expect(matchesBookingNumber(r, "1054")).toBe(true);
    expect(matchesBookingNumber(r, "sm-77881122")).toBe(true);
    expect(matchesBookingNumber(r, "77881122")).toBe(true); // digits of a prefixed id
  });
  it("rejects partial, short and unrelated numbers", () => {
    expect(matchesBookingNumber(r, "105")).toBe(false);
    expect(matchesBookingNumber(r, "10")).toBe(false);
    expect(matchesBookingNumber(r, "4321098766")).toBe(false);
    expect(matchesBookingNumber({ confirmationCode: null }, "1054")).toBe(false);
  });
});

describe("rankKioskMatches", () => {
  const a = { firstName: "Peter", lastName: "Hansen", confirmationCode: "1001", extId: "1001", channelNumber: "5555555555", channelManagerNumber: null };
  const b = { firstName: "Mette", lastName: "Hanson", confirmationCode: "1002", extId: "1002", channelNumber: null, channelManagerNumber: null };
  const c = { firstName: "Hansen", lastName: "Lars", confirmationCode: "1003", extId: "1003", channelNumber: null, channelManagerNumber: null };

  it("booking number beats everything", () => {
    expect(rankKioskMatches([a, b, c], "5555555555")).toEqual({ quality: "booking", matches: [a] });
    expect(rankKioskMatches([a, b, c], "1002")).toEqual({ quality: "booking", matches: [b] });
  });
  it("exact hits exclude fuzzy ones", () => {
    const r = rankKioskMatches([a, b, c], "Hansen");
    expect(r.quality).toBe("exact");
    expect(r.matches).toEqual([a, c]); // swapped-name guest included, Hanson (fuzzy) excluded
  });
  it("falls back to fuzzy only when nothing is exact", () => {
    const r = rankKioskMatches([a, b, c], "Hansn");
    expect(r.quality).toBe("fuzzy");
    expect(r.matches).toEqual([a, b, c]); // one edit from Hansen AND Hanson → endpoint asks for booking number
  });
  it("returns nothing for strangers", () => {
    expect(rankKioskMatches([a, b, c], "Nielsen")).toEqual({ quality: null, matches: [] });
  });
});
