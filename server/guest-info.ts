// Guest info screen (kiosk) — pure response builders.
//
// A wall-mounted tablet in the common area shows per-tenant content at
// /:hotel/info, maintained via guest_info_* settings. Everything returned by
// buildGuestInfoResponse is public BY DESIGN (it renders on a shared screen),
// including the WiFi password — which is also why guest_info_wifi_password must
// never be added to ENCRYPTED_KEYS. The explicit whitelist below is the only
// thing the endpoint exposes, so new settings can never leak by accident.

import type { Reservation, Pin } from "@shared/schema";

type Get = (key: string) => string | undefined | null;

export interface GuestInfoResponse {
  checkInTime: string;
  checkOutTime: string;
  address: string | null;
  wifi: { network: string; password: string | null } | null;
  hasFlights: boolean;
  // Early check-in tile: null unless early_checkin_enabled — the kiosk shows
  // the tile and price only when the tenant has the feature on. `tiers` mirrors
  // early_checkin_price_tiers ("10:00=119,12:00=79,14:00=49"); empty = legacy
  // per-hour pricing.
  earlyCheckin: { pricePerHour: number; eurRate: number; tiers: Array<{ label: string; dkk: number }> } | null;
  // Late checkout tile: same gating pattern via late_checkout_enabled.
  lateCheckout: { pricePerHour: number; eurRate: number } | null;
  // Simplyture pay-after-parking link — when set, the kiosk's Parking panel
  // shows ONLY the payment flow (button + QR) instead of the free-text section.
  parkingPaymentUrl: string | null;
  // Phone number rendered LARGE at the top of the Help & contact panel.
  contactPhone: string | null;
  sections: {
    checkin: string | null;
    parking: string | null;
    facilities: string | null;
    rules: string | null;
    gettingAround: string | null;
    contact: string | null;
    explore: string | null;
  };
}

// Returns null unless the tenant has opted in via guest_info_enabled — the
// route maps null to 404 so the kiosk URL does nothing for other tenants.
export function buildGuestInfoResponse(get: Get): GuestInfoResponse | null {
  if (get("guest_info_enabled") !== "true") return null;

  const text = (key: string): string | null => {
    const value = (get(key) || "").trim();
    return value.length > 0 ? value : null;
  };

  const network = text("guest_info_wifi_network");

  return {
    checkInTime: get("check_in_time") || "15:00",
    checkOutTime: get("reservation_checkout_time") || "11:00",
    address: text("hotel_address"),
    wifi: network ? { network, password: text("guest_info_wifi_password") } : null,
    // Airport tile shows when a flight-feed URL is configured (the URL itself
    // stays server-side; the kiosk calls our proxy endpoint).
    hasFlights: !!text("guest_info_flights_url"),
    earlyCheckin:
      get("early_checkin_enabled") === "true"
        ? {
            pricePerHour: parseFloat(get("early_checkin_price_per_hour") || "75") || 75,
            eurRate: parseFloat(get("early_checkin_eur_rate") || "7.45") || 7.45,
            // Same "HH:MM=price" format as the late-checkout tiers (this file
            // stays dependency-free, so the tiny parse lives inline).
            tiers: (get("early_checkin_price_tiers") || "")
              .split(",")
              .map((part) => /^\s*(\d{1,2}:\d{2})\s*=\s*(\d+(?:\.\d+)?)\s*$/.exec(part))
              .filter((m): m is RegExpExecArray => !!m)
              .map((m) => ({ label: m[1], dkk: parseFloat(m[2]) }))
              .sort((a, b) => a.label.localeCompare(b.label)),
          }
        : null,
    parkingPaymentUrl: text("parking_payment_url"),
    contactPhone: text("guest_info_contact_phone"),
    lateCheckout:
      get("late_checkout_enabled") === "true"
        ? {
            pricePerHour: parseFloat(get("late_checkout_price_per_hour") || "75") || 75,
            eurRate: parseFloat(get("late_checkout_eur_rate") || "7.45") || 7.45,
          }
        : null,
    sections: {
      checkin: text("guest_info_checkin_text"),
      parking: text("guest_info_parking_text"),
      facilities: text("guest_info_facilities_text"),
      rules: text("guest_info_rules_text"),
      gettingAround: text("guest_info_getting_around_text"),
      contact: text("guest_info_contact_text"),
      explore: text("guest_info_explore_text"),
    },
  };
}

// Several reservations matching the same last name + arrival date may simply
// be ONE guest who booked several capsules. Same normalized full name → same
// person, and the kiosk shows all their capsules instead of demanding a
// reservation number.
export function isSameGuest(
  reservations: Array<Pick<Reservation, "firstName" | "lastName">>
): boolean {
  const norm = (s: string | null | undefined) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
  return new Set(reservations.map((r) => `${norm(r.firstName)}|${norm(r.lastName)}`)).size === 1;
}

export interface DoorCodeResult {
  firstName: string;
  capsule: string | null;
  pin: { code: string; validFrom: Date | null; validTo: Date | null } | null;
  reason: "already_checked_in" | "payment" | "not_checked_in" | "not_ready" | null;
}

// Gating for the shared kiosk screen — stricter than the boarding card:
// - Already checked-in guests get NO code (they've used it; re-showing it on a
//   shared screen is pure exposure) — the capsule number still shows.
// - An unpaid guest never sees a code (PIN activation refuses to program locks
//   while owing > 0, so showing one would hand out a DEAD code).
// - Tenants with boarding_pin_requires_checkin hold the code until check-in.
// - Pending codes ARE shown (user decision 21/7: every same-day arrival must be
//   able to see their code): the endpoint only serves TODAY's arrivals, the
//   digits are final from creation (guest codes are never rotated), and the
//   scheduler programs the locks well before the validity window opens — the
//   kiosk shows the window next to the code.
export function buildDoorCodeResult(reservation: Reservation, pin: Pin | null, get: Get): DoorCodeResult {
  const owing = reservation.owing !== null && reservation.owing !== undefined
    ? parseFloat(reservation.owing)
    : 0;
  const isCheckedIn = ["checked-in", "started"].includes((reservation.status || "").toLowerCase());
  const pinRequiresCheckin = get("boarding_pin_requires_checkin") === "true";
  const capsule = reservation.assignedSpace || reservation.room || null;

  const base = { firstName: reservation.firstName, capsule, pin: null as null };

  if (isCheckedIn) {
    return { ...base, reason: "already_checked_in" };
  }
  if (owing > 0) {
    return { ...base, reason: "payment" };
  }
  if (pinRequiresCheckin) {
    return { ...base, reason: "not_checked_in" };
  }
  if (!pin || !pin.code || !["pending", "active", "used"].includes(pin.status)) {
    return { ...base, reason: "not_ready" };
  }

  return {
    firstName: reservation.firstName,
    capsule,
    pin: { code: pin.code, validFrom: pin.validFrom ?? null, validTo: pin.validTo ?? null },
    reason: null,
  };
}
