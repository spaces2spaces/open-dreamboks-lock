/**
 * Door-code SMS template (door_code_sms_text): placeholder rendering and the
 * one-segment budget. The Capsule Inn text is asserted verbatim — it is the
 * owner's wording and must stay under 160 GSM-7 chars for every capsule.
 */
import { describe, it, expect } from "vitest";
import {
  renderDoorCodeTemplate,
  smsSegmentInfo,
  DOOR_CODE_TEMPLATE_SAMPLE_VARS,
  type DoorCodeTemplateVars,
} from "@shared/door-code-template";

const CAPSULE_TEMPLATE =
  "CAPSULE INN Check In > Amager Centret mall, BRYSSELGADE 7 (a main entrance) > 20 m to Elevator > FLOOR 2 > {capsule}. Doorcode {code} (opens all doors 24/7).";

function vars(over: Partial<DoorCodeTemplateVars> = {}): DoorCodeTemplateVars {
  return { ...DOOR_CODE_TEMPLATE_SAMPLE_VARS, ...over };
}

describe("renderDoorCodeTemplate", () => {
  it("renders the Capsule Inn text exactly as the owner wrote it (159 chars)", () => {
    const out = renderDoorCodeTemplate(CAPSULE_TEMPLATE, vars({ capsule: "Capsule 602s", code: "1577#" }));
    expect(out).toBe(
      "CAPSULE INN Check In > Amager Centret mall, BRYSSELGADE 7 (a main entrance) > 20 m to Elevator > FLOOR 2 > Capsule 602s. Doorcode 1577# (opens all doors 24/7)."
    );
    expect(smsSegmentInfo(out)).toEqual({ length: 159, limit: 160, unicode: false, fits: true });
  });

  it("stays within one segment for the longest capsule name (4 chars) and a 4-digit code", () => {
    const out = renderDoorCodeTemplate(CAPSULE_TEMPLATE, vars({ capsule: "Capsule 1012", code: "9876#" }));
    expect(smsSegmentInfo(out).fits).toBe(true);
  });

  it("supports every placeholder and tolerates spaces/case inside braces", () => {
    const out = renderDoorCodeTemplate(
      "{name}: {room}/{capsule} {code} {checkin_day} { checkin_time } {CHECKOUT_DAY} {checkout_time} {address}",
      vars()
    );
    expect(out).toBe("Anna: 602s/Capsule 602s 1577# Mon 20 Jul 15:00 Tue 21 Jul 11:00 Brysselgade 7, 2300 Copenhagen S");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(renderDoorCodeTemplate("Hi {nope} {code}", vars())).toBe("Hi {nope} 1577#");
  });
});

describe("smsSegmentInfo", () => {
  it("counts GSM-7 extension chars double and flags unicode as 70-char", () => {
    expect(smsSegmentInfo("a{b}").length).toBe(6); // { and } are GSM-7 extension chars (2 each)
    expect(smsSegmentInfo("Ærø ok").unicode).toBe(false); // Æ, ø are GSM-7
    expect(smsSegmentInfo("Wayfinding →").unicode).toBe(true);
    expect(smsSegmentInfo("Wayfinding →").limit).toBe(70);
  });
});
