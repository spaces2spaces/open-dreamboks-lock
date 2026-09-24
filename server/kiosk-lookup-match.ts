/**
 * Matching for the kiosk "Find my door code" lookup.
 *
 * Guests type their name on a wall tablet, and what is in MEWS is often not
 * what they type: first/last name swapped (OTA imports), misspellings on
 * either side, diacritics dropped ("Soren" for "Søren"), particles spaced
 * differently ("vanderberg" / "van der Berg"). The old exact LOWER(last_name)
 * comparison sent all of those to reception. This module is a pure ranking
 * layer: the endpoint still restricts candidates to TODAY's arrivals for the
 * tenant, and only a single unambiguous guest ever gets a code.
 *
 * Match qualities, strongest first:
 *   - booking: the query equals a reservation/OTA number (MEWS number,
 *     Booking.com / channel-manager number). A number is a far stronger
 *     secret than a surname, so it always wins.
 *   - exact: the normalized query equals the last name, the first name, the
 *     full name in either order, or every query word is one of the guest's
 *     name words (swapped names, partial multi-word surnames).
 *   - fuzzy: every query word is within a small edit distance of a name word
 *     (typos), or the whole query is within edit distance of the joined name.
 *
 * The endpoint uses exact matches when there are any and falls back to fuzzy
 * only when nothing matched exactly, so a typo never steals a hit from a
 * correctly spelled guest.
 */

export type MatchQuality = "booking" | "exact" | "fuzzy";

export interface NameLike {
  firstName: string | null | undefined;
  lastName: string | null | undefined;
}

export interface BookingNumberLike {
  confirmationCode?: string | null;
  extId?: string | null;
  channelNumber?: string | null;
  channelManagerNumber?: string | null;
}

/** Lowercase, ASCII-fold (ø→o, æ→ae, å→a, é→e…), keep letters/digits, single spaces. */
export function normalizeText(input: string | null | undefined): string {
  return (input || "")
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ß/g, "ss")
    .replace(/ł/g, "l")
    .replace(/đ/g, "d")
    .replace(/þ/g, "th")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(s: string | null | undefined): string[] {
  return normalizeText(s).split(" ").filter(Boolean);
}

/** Optimal string alignment distance (Levenshtein + adjacent transposition). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const n = a.length, m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[n][m];
}

/**
 * Typo tolerance scaled to word length: short words must match exactly (a
 * one-letter slip in "Li" is a different name), 4–7 letters allow one edit,
 * 8+ allow two.
 */
export function fuzzyEquals(a: string, b: string): boolean {
  if (a === b) return true;
  const len = Math.max(a.length, b.length);
  const allowed = len >= 8 ? 2 : len >= 4 ? 1 : 0;
  if (allowed === 0 || Math.abs(a.length - b.length) > allowed) return false;
  return editDistance(a, b) <= allowed;
}

/** Match a typed name against a guest's first/last name. null = no match. */
export function matchGuestName(guest: NameLike, query: string): "exact" | "fuzzy" | null {
  const q = normalizeText(query);
  if (q.length < 2) return null;
  const qTokens = q.split(" ");
  const qJoined = qTokens.join("");

  const last = normalizeText(guest.lastName);
  const first = normalizeText(guest.firstName);
  if (!last && !first) return null;
  const lastJoined = last.replace(/ /g, "");
  const firstJoined = first.replace(/ /g, "");
  // Name words a query word may match. Digits (e.g. "Guest 2") never count.
  const nameTokens = [...tokens(last), ...tokens(first)].filter((t) => !/^\d+$/.test(t));

  // Exact: whole last name / first name / full name in either order.
  const wholeTargets = [lastJoined, firstJoined, firstJoined + lastJoined, lastJoined + firstJoined].filter(Boolean);
  if (wholeTargets.includes(qJoined)) return "exact";
  // Exact: every typed word is one of the guest's name words ("Jensen Peter",
  // "van berg" for "van der Berg", or the surname typed into first name).
  if (nameTokens.length > 0 && qTokens.every((t) => nameTokens.includes(t))) return "exact";

  // Fuzzy: every typed word is a near-miss of some name word.
  if (nameTokens.length > 0 && qTokens.every((t) => nameTokens.some((n) => fuzzyEquals(t, n)))) return "fuzzy";
  // Fuzzy: the whole query (spaces removed) is a near-miss of a whole name.
  if (wholeTargets.some((t) => fuzzyEquals(qJoined, t))) return "fuzzy";

  return null;
}

/** Uppercase alphanumerics only: "1234.567.890" and "1234-567-890" both → "1234567890". */
export function normalizeBookingNumber(input: string | null | undefined): string {
  return (input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Does the typed value equal one of the reservation's numbers (MEWS number,
 * OTA / channel-manager number)? Also accepts a digits-only match of 6+
 * digits so a prefixed channel number ("BDC-1234567890") still matches the
 * bare number on the guest's confirmation.
 */
export function matchesBookingNumber(reservation: BookingNumberLike, query: string): boolean {
  const q = normalizeBookingNumber(query);
  if (q.length < 3) return false;
  const qDigits = q.replace(/\D/g, "");
  const stored = [
    reservation.confirmationCode,
    reservation.extId,
    reservation.channelNumber,
    reservation.channelManagerNumber,
  ];
  for (const raw of stored) {
    if (!raw) continue;
    const s = normalizeBookingNumber(raw);
    if (!s) continue;
    if (s === q) return true;
    const sDigits = s.replace(/\D/g, "");
    if (qDigits.length >= 6 && qDigits === sDigits) return true;
  }
  return false;
}

/**
 * Rank candidates for a free-text query (name OR booking number) and return
 * the strongest non-empty tier. Booking-number hits beat exact name hits,
 * which beat fuzzy ones — the tiers never mix.
 */
export function rankKioskMatches<T extends NameLike & BookingNumberLike>(
  candidates: T[],
  query: string
): { quality: MatchQuality | null; matches: T[] } {
  const booking = candidates.filter((c) => matchesBookingNumber(c, query));
  if (booking.length > 0) return { quality: "booking", matches: booking };

  const exact: T[] = [];
  const fuzzy: T[] = [];
  for (const c of candidates) {
    const q = matchGuestName(c, query);
    if (q === "exact") exact.push(c);
    else if (q === "fuzzy") fuzzy.push(c);
  }
  if (exact.length > 0) return { quality: "exact", matches: exact };
  if (fuzzy.length > 0) return { quality: "fuzzy", matches: fuzzy };
  return { quality: null, matches: [] };
}
