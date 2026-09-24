/**
 * Door-code SMS template (setting `door_code_sms_text`, per tenant).
 *
 * The door-code message in `door_code_message_only` mode is one billed SMS
 * segment (160 GSM-7 chars). The default body is the three-line
 * code / check-in / check-out text; a tenant can replace it with a template
 * using the placeholders below (owner text for Capsule Inn, 8/9-2026:
 * wayfinding through the mall instead of the times).
 *
 * Shared by the server (renders the real message) and the admin settings
 * page (live preview + character count with sample values).
 */

export interface DoorCodeTemplateVars {
  /** "Capsule 602s" — guest-facing space label. */
  capsule: string;
  /** "602s" — bare space name. */
  room: string;
  /** "1577#" — the code with the keypad's confirm key. */
  code: string;
  /** "Mon 20 Jul" */
  checkin_day: string;
  /** "15:00" */
  checkin_time: string;
  /** "Tue 21 Jul" */
  checkout_day: string;
  /** "11:00" */
  checkout_time: string;
  /** hotel_address setting, may be empty. */
  address: string;
  /** Guest first name. */
  name: string;
}

export const DOOR_CODE_TEMPLATE_PLACEHOLDERS: ReadonlyArray<{ key: keyof DoorCodeTemplateVars; sample: string; help: string }> = [
  { key: "capsule", sample: "Capsule 602s", help: "space label as shown to the guest" },
  { key: "room", sample: "602s", help: "bare space name" },
  { key: "code", sample: "1577#", help: "door code incl. #" },
  { key: "checkin_day", sample: "Mon 20 Jul", help: "check-in day" },
  { key: "checkin_time", sample: "15:00", help: "check-in time" },
  { key: "checkout_day", sample: "Tue 21 Jul", help: "check-out day" },
  { key: "checkout_time", sample: "11:00", help: "check-out time" },
  { key: "address", sample: "Brysselgade 7, 2300 Copenhagen S", help: "Hotel Address setting" },
  { key: "name", sample: "Anna", help: "guest first name" },
];

export const DOOR_CODE_TEMPLATE_SAMPLE_VARS: DoorCodeTemplateVars = Object.fromEntries(
  DOOR_CODE_TEMPLATE_PLACEHOLDERS.map((p) => [p.key, p.sample])
) as unknown as DoorCodeTemplateVars;

/** Replace `{placeholder}` tokens; unknown tokens are left as typed. Whitespace inside braces is tolerated. */
export function renderDoorCodeTemplate(template: string, vars: DoorCodeTemplateVars): string {
  return template.replace(/\{\s*([a-z_]+)\s*\}/gi, (whole, key: string) => {
    const k = key.toLowerCase() as keyof DoorCodeTemplateVars;
    return k in vars ? vars[k] : whole;
  });
}

/**
 * Characters that fit in the GSM-7 basic set cost 1; the extension set
 * (^ { } \ [ ] ~ | €) costs 2; anything else forces UCS-2 (70-char segments).
 * Returns the effective single-segment budget and whether the text fits.
 */
export function smsSegmentInfo(text: string): { length: number; limit: number; unicode: boolean; fits: boolean } {
  const gsm = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
  const ext = "^{}\\[]~|€";
  let length = 0;
  let unicode = false;
  for (const ch of text) {
    if (gsm.includes(ch)) length += 1;
    else if (ext.includes(ch)) length += 2;
    else { unicode = true; break; }
  }
  if (unicode) {
    const len = Array.from(text).length;
    return { length: len, limit: 70, unicode: true, fits: len <= 70 };
  }
  return { length, limit: 160, unicode: false, fits: length <= 160 };
}
