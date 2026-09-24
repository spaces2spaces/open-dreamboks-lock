/**
 * Maps an hourly-booking window to the MEWS reservation that should occupy the
 * capsule (user decisions 21/7):
 *
 * - Window touching/after check-in time (15:00) — e.g. 15–18, 17–23, 23–05:
 *   standard NIGHT anchored on the booking's start date:
 *   StartUtc = D@15:00, EndUtc = (D+1)@10:00. The guest only experiences the
 *   requested interval (door code + confirmation) — MEWS just shows the
 *   capsule occupied for the night; the checkout signal frees it when the
 *   booking ends.
 *
 * - Window entirely BEFORE 15:00 — e.g. 09–14: DAY-USE reservation
 *   StartUtc = interval start, EndUtc = D@15:00 (never touches the night).
 *   MEWS may reject sub-day intervals on the nightly service — callers treat
 *   that as a soft failure (booking proceeds without a MEWS reservation).
 */

import { DateTime } from "luxon";

export interface MewsStayWindow {
  startUtc: Date;
  endUtc: Date;
  kind: "night" | "dayuse";
}

export function mapHourlyWindowToMewsStay(
  startAt: Date,
  endAt: Date,
  tz: string,
  checkInHHMM: string,
  checkoutHHMM: string
): MewsStayWindow {
  const [inH, inM] = checkInHHMM.split(":").map((v) => parseInt(v, 10) || 0);
  const [outH, outM] = checkoutHHMM.split(":").map((v) => parseInt(v, 10) || 0);

  const startLocal = DateTime.fromJSDate(startAt, { zone: "utc" }).setZone(tz);
  const endLocal = DateTime.fromJSDate(endAt, { zone: "utc" }).setZone(tz);

  // Check-in instant on the booking's start DATE (property tz — DST safe via luxon).
  const checkInInstant = startLocal.set({ hour: inH, minute: inM, second: 0, millisecond: 0 });

  if (endLocal > checkInInstant) {
    // Night anchored on the start date: D@15:00 → (D+1)@10:00.
    const nightEnd = checkInInstant
      .plus({ days: 1 })
      .set({ hour: outH, minute: outM, second: 0, millisecond: 0 });
    return { startUtc: checkInInstant.toUTC().toJSDate(), endUtc: nightEnd.toUTC().toJSDate(), kind: "night" };
  }

  // Entirely before check-in: day-use from interval start to D@15:00.
  return { startUtc: startAt, endUtc: checkInInstant.toUTC().toJSDate(), kind: "dayuse" };
}
