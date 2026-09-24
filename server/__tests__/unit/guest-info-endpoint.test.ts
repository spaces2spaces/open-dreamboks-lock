/**
 * Guest info screen (kiosk) response builders.
 *
 * buildGuestInfoResponse feeds the public /api/public/guest-info endpoint that
 * renders on a shared wall tablet — the whitelist test is the important one:
 * the settings store also holds MEWS/TTLock/Stripe credentials, and nothing
 * outside the explicit whitelist may ever reach the response.
 *
 * buildDoorCodeResult gates the kiosk "Find my door code" lookup (stricter
 * than the boarding card): already-checked-in guests get NO code (shared
 * screen), unpaid → no code (it would be dead on the lock), optional
 * hold-until-checkin, and only lock-programmed (active/used) codes.
 */

import { describe, it, expect } from "vitest";
import { buildGuestInfoResponse, buildDoorCodeResult, isSameGuest } from "../../guest-info";
import type { Reservation, Pin } from "@shared/schema";

function getFrom(settings: Record<string, string>) {
  return (key: string) => settings[key];
}

const ENABLED = { guest_info_enabled: "true" };

describe("buildGuestInfoResponse", () => {
  it("returns null when guest_info_enabled is not 'true'", () => {
    expect(buildGuestInfoResponse(getFrom({}))).toBeNull();
    expect(buildGuestInfoResponse(getFrom({ guest_info_enabled: "false" }))).toBeNull();
    expect(buildGuestInfoResponse(getFrom({ guest_info_enabled: "TRUE" }))).toBeNull();
  });

  it("returns null sections and defaults when only enabled", () => {
    const result = buildGuestInfoResponse(getFrom(ENABLED))!;
    expect(result.checkInTime).toBe("15:00");
    expect(result.checkOutTime).toBe("11:00");
    expect(result.address).toBeNull();
    expect(result.wifi).toBeNull();
    expect(Object.values(result.sections).every((s) => s === null)).toBe(true);
  });

  it("returns full object when populated", () => {
    const result = buildGuestInfoResponse(getFrom({
      ...ENABLED,
      check_in_time: "16:00",
      reservation_checkout_time: "10:00",
      hotel_address: "Vestergade 1, Copenhagen",
      guest_info_wifi_network: "CapsuleInn Guest",
      guest_info_wifi_password: "sleep-tight",
      guest_info_checkin_text: "Check in at the kiosk.",
      guest_info_parking_text: "Garage entry from Ålandsgade 37.",
      guest_info_facilities_text: "Showers downstairs.",
      guest_info_rules_text: "- Quiet hours 22-08",
      guest_info_getting_around_text: "Metro: M3.",
      guest_info_contact_text: "Call +45 12 34 56 78.",
      guest_info_explore_text: "Try the harbour bath.",
    }))!;
    expect(result.checkInTime).toBe("16:00");
    expect(result.checkOutTime).toBe("10:00");
    expect(result.address).toBe("Vestergade 1, Copenhagen");
    expect(result.wifi).toEqual({ network: "CapsuleInn Guest", password: "sleep-tight" });
    expect(result.sections).toEqual({
      checkin: "Check in at the kiosk.",
      parking: "Garage entry from Ålandsgade 37.",
      facilities: "Showers downstairs.",
      rules: "- Quiet hours 22-08",
      gettingAround: "Metro: M3.",
      contact: "Call +45 12 34 56 78.",
      explore: "Try the harbour bath.",
    });
  });

  it("treats whitespace-only text as empty (tile hidden)", () => {
    const result = buildGuestInfoResponse(getFrom({
      ...ENABLED,
      guest_info_rules_text: "   \n  ",
    }))!;
    expect(result.sections.rules).toBeNull();
  });

  it("wifi is null when network unset, even if password is set", () => {
    const result = buildGuestInfoResponse(getFrom({
      ...ENABLED,
      guest_info_wifi_password: "secret",
    }))!;
    expect(result.wifi).toBeNull();
  });

  it("hasFlights reflects guest_info_flights_url (URL itself never exposed)", () => {
    expect(buildGuestInfoResponse(getFrom(ENABLED))!.hasFlights).toBe(false);
    const withUrl = buildGuestInfoResponse(getFrom({
      ...ENABLED,
      guest_info_flights_url: "https://example.com/api/flights",
    }))!;
    expect(withUrl.hasFlights).toBe(true);
    expect(JSON.stringify(withUrl)).not.toContain("example.com");
  });

  it("never leaks non-whitelisted settings (credentials)", () => {
    const secrets = {
      ttlock_password: "TTLOCK-SECRET-1",
      mews_access_token: "MEWS-SECRET-2",
      stripe_secret_key: "sk_live_SECRET-3",
      twilio_auth_token: "TWILIO-SECRET-4",
      sendgrid_api_key: "SG.SECRET-5",
    };
    const result = buildGuestInfoResponse(getFrom({ ...ENABLED, ...secrets }));
    const serialized = JSON.stringify(result);
    for (const value of Object.values(secrets)) {
      expect(serialized).not.toContain(value);
    }
  });
});

function makeReservation(over: Partial<Reservation> = {}): Reservation {
  return {
    id: "res-1",
    firstName: "Anna",
    lastName: "Jensen",
    status: "Confirmed",
    owing: "0",
    assignedSpace: "Capsule 12",
    room: "Pod Room",
    ...over,
  } as Reservation;
}

function makePin(over: Partial<Pin> = {}): Pin {
  return {
    id: "pin-1",
    code: "4711",
    status: "active",
    validFrom: new Date("2026-07-18T13:00:00Z"),
    validTo: new Date("2026-07-19T09:00:00Z"),
    ...over,
  } as Pin;
}

describe("buildDoorCodeResult", () => {
  it("checked-in guest → NO code, reason 'already_checked_in' (shared screen)", () => {
    const result = buildDoorCodeResult(makeReservation({ status: "Checked-in" }), makePin(), getFrom({}));
    expect(result.pin).toBeNull();
    expect(result.reason).toBe("already_checked_in");
    expect(result.capsule).toBe("Capsule 12");
  });

  it("'Started' status also counts as checked in", () => {
    const result = buildDoorCodeResult(makeReservation({ status: "Started" }), makePin(), getFrom({}));
    expect(result.pin).toBeNull();
    expect(result.reason).toBe("already_checked_in");
  });

  it("owing > 0 → no code, reason 'payment'", () => {
    const result = buildDoorCodeResult(makeReservation({ owing: "2079.00" }), makePin(), getFrom({}));
    expect(result.pin).toBeNull();
    expect(result.reason).toBe("payment");
    expect(result.capsule).toBe("Capsule 12");
  });

  it("pin_requires_checkin + Confirmed → no code, reason 'not_checked_in'", () => {
    const result = buildDoorCodeResult(
      makeReservation(),
      makePin(),
      getFrom({ boarding_pin_requires_checkin: "true" })
    );
    expect(result.pin).toBeNull();
    expect(result.reason).toBe("not_checked_in");
  });

  it("pending pin → code IS shown (same-day arrival; digits are final from creation)", () => {
    const result = buildDoorCodeResult(makeReservation(), makePin({ status: "pending" }), getFrom({}));
    expect(result.reason).toBeNull();
    expect(result.pin?.code).toBe("4711");
  });

  it("cancelled pin → no code, reason 'not_ready'", () => {
    const result = buildDoorCodeResult(makeReservation(), makePin({ status: "cancelled" }), getFrom({}));
    expect(result.pin).toBeNull();
    expect(result.reason).toBe("not_ready");
  });

  it("missing pin → reason 'not_ready'", () => {
    const result = buildDoorCodeResult(makeReservation(), null, getFrom({}));
    expect(result.pin).toBeNull();
    expect(result.reason).toBe("not_ready");
  });

  it("Confirmed (not yet arrived) + paid + active pin → code with validity", () => {
    const result = buildDoorCodeResult(makeReservation(), makePin(), getFrom({}));
    expect(result.reason).toBeNull();
    expect(result.pin).toEqual({
      code: "4711",
      validFrom: new Date("2026-07-18T13:00:00Z"),
      validTo: new Date("2026-07-19T09:00:00Z"),
    });
    expect(result.firstName).toBe("Anna");
  });

  it("'used' pin still shows for a not-yet-checked-in guest (lock-arrival lag)", () => {
    const result = buildDoorCodeResult(makeReservation(), makePin({ status: "used" }), getFrom({}));
    expect(result.reason).toBeNull();
    expect(result.pin?.code).toBe("4711");
  });

  it("capsule falls back to room when assignedSpace is unset", () => {
    const result = buildDoorCodeResult(
      makeReservation({ assignedSpace: null }),
      makePin(),
      getFrom({})
    );
    expect(result.capsule).toBe("Pod Room");
  });
});

describe("isSameGuest (same guest with several capsules)", () => {
  const guest = (firstName: string, lastName: string) => ({ firstName, lastName });

  it("same full name, different case/whitespace → same guest", () => {
    expect(isSameGuest([
      guest("Anna", "Jensen"),
      guest("anna", "JENSEN"),
      guest("  Anna ", "Jensen "),
    ])).toBe(true);
  });

  it("same last name but different first names → NOT same guest", () => {
    expect(isSameGuest([guest("Anna", "Jensen"), guest("Bo", "Jensen")])).toBe(false);
  });

  it("single reservation → trivially same guest", () => {
    expect(isSameGuest([guest("Anna", "Jensen")])).toBe(true);
  });

  it("normalizes doubled inner whitespace in names", () => {
    expect(isSameGuest([guest("Anna  Marie", "Jensen"), guest("Anna Marie", "Jensen")])).toBe(true);
  });
});
