/**
 * Shared validity window calculator for PIN lifecycle.
 *
 * Single source of truth — used by both AutomationEngine and PinLifecycleService.
 * Reads check_in_time, reservation_checkout_time, and property_timezone from tenant settings.
 */

import { DateTime } from "luxon";
import type { Reservation } from "@shared/schema";

interface SettingsReader {
  getSetting(key: string): Promise<{ value: string } | null | undefined>;
}

/**
 * Safely parse a "HH:MM" time component, returning `fallback` on NaN or missing parts.
 */
function safeParseTimeComponent(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export async function buildValidityWindow(
  storage: SettingsReader,
  reservation: Reservation
): Promise<{ validFrom: Date; validTo: Date }> {
  const checkInTimeSetting = await storage.getSetting("check_in_time");
  const checkoutTimeSetting = await storage.getSetting("reservation_checkout_time");
  const timezoneSetting = await storage.getSetting("property_timezone");

  const checkInTime = checkInTimeSetting?.value || "15:00";
  const checkoutTime = checkoutTimeSetting?.value || "11:00";
  const timezone = timezoneSetting?.value || "Europe/Copenhagen";

  const checkInParts = checkInTime.split(":");
  const checkoutParts = checkoutTime.split(":");

  const arrivalDateTime = DateTime.fromJSDate(new Date(reservation.arrival), { zone: "utc" })
    .setZone(timezone)
    .set({
      hour: safeParseTimeComponent(checkInParts[0], 15),
      minute: safeParseTimeComponent(checkInParts[1], 0),
      second: 0,
      millisecond: 0,
    });

  const departureDateTime = DateTime.fromJSDate(new Date(reservation.departure), { zone: "utc" })
    .setZone(timezone)
    .set({
      hour: safeParseTimeComponent(checkoutParts[0], 11),
      minute: safeParseTimeComponent(checkoutParts[1], 0),
      second: 0,
      millisecond: 0,
    });

  let validFrom = arrivalDateTime.toJSDate();
  let validTo = departureDateTime.toJSDate();

  // DAY-USE / same-day stays (e.g. Booking.com "24h rate": arrive 10:08,
  // depart 15:00 the same day): forcing the window to check_in_time→checkout
  // time INVERTS it (15:00 → 11:00). An inverted window is poison — TTLock
  // rejects the push ("endDate must be after startDate"), the pin looks
  // instantly expired, cleanup cancels it and the create loop spams MEWS with
  // fresh codes (22/7 incident, Karim/724s). When the computed window is
  // inverted or absurdly short, fall back to the reservation's ACTUAL
  // arrival/departure timestamps, which are authoritative for day-use.
  if (validTo.getTime() <= validFrom.getTime()) {
    const actualArrival = new Date(reservation.arrival);
    const actualDeparture = new Date(reservation.departure);
    if (actualDeparture.getTime() > actualArrival.getTime()) {
      validFrom = actualArrival;
      validTo = actualDeparture;
    }
  }

  // Early check-in purchased at the kiosk: honor the earlier start, but ONLY
  // within the sale horizon (72h — early check-in is sellable 24/7 when the
  // capsule is ready). Stale values after an arrival-date change are cleared
  // explicitly by onArrivalDateChanged (the band alone no longer guarantees
  // staleness-immunity for 1-2 day moves). Every consumer (activation gate,
  // repair, reconcile, boarding/door-code displays) folds this in
  // automatically because this function is the single source of truth.
  const earlyFrom = reservation.earlyCheckinFrom ? new Date(reservation.earlyCheckinFrom) : null;
  if (
    earlyFrom &&
    earlyFrom.getTime() < validFrom.getTime() &&
    validFrom.getTime() - earlyFrom.getTime() <= EARLY_CHECKIN_MAX_ADVANCE_MS
  ) {
    validFrom = earlyFrom;
  }

  // Paid late checkout: honor the later end, but ONLY within 12h after the
  // standard checkout — a departure-date change (≥1 day) pushes the stale
  // value outside the band, making it inert with no clearing hook. Mirrors
  // the earlyCheckinFrom fold above. The guest's code digits never change.
  const lateUntil = reservation.lateCheckoutUntil ? new Date(reservation.lateCheckoutUntil) : null;
  if (
    lateUntil &&
    lateUntil.getTime() > validTo.getTime() &&
    lateUntil.getTime() - validTo.getTime() <= LATE_CHECKOUT_MAX_EXTENSION_MS
  ) {
    validTo = lateUntil;
  }

  return { validFrom, validTo };
}

export const LATE_CHECKOUT_MAX_EXTENSION_MS = 12 * 60 * 60 * 1000;

// Sale horizon for early check-in: purchasable 24/7 when the capsule is ready,
// up to 72h before the standard check-in. The fold above honors the same band,
// and onArrivalDateChanged clears the field so date moves can't leave a stale
// value inside the band.
export const EARLY_CHECKIN_MAX_ADVANCE_MS = 72 * 60 * 60 * 1000;

/**
 * True when the reservation has a paid late checkout that is still in effect
 * RIGHT NOW (used to defer PIN revocation on MEWS's ~11:00 bulk auto-checkout
 * and in the poller's expiry cleanup). Same 12h sanity band as the fold.
 */
export function hasActiveLateCheckout(reservation: { lateCheckoutUntil?: Date | string | null }): boolean {
  if (!reservation.lateCheckoutUntil) return false;
  const until = new Date(reservation.lateCheckoutUntil).getTime();
  const now = Date.now();
  return until > now && until - now <= LATE_CHECKOUT_MAX_EXTENSION_MS;
}
