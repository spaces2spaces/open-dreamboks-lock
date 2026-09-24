/**
 * Guest-facing reservation identifiers come in two grades:
 *
 *  - LINK-GRADE: the reservation's own UUID. Only ever appears in links the
 *    system sent to the guest (SMS / e-mail / WhatsApp). Unguessable, so a
 *    lookup with it cannot be enumerated.
 *  - FORM-GRADE: a short human-typed number (PMS booking number or OTA
 *    confirmation code). Sequential or short, so a lookup with it CAN be
 *    enumerated — every public endpoint that accepts one applies the
 *    per-reservation lockout and brute-force alerting in
 *    server/guest-access-guard.ts, and remote unlock additionally demands the
 *    guest's door code.
 *
 * Shared between server and client so links built anywhere use the same rule.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isLinkGradeIdentifier(identifier: string | null | undefined): boolean {
  return typeof identifier === "string" && UUID_RE.test(identifier.trim());
}

/** The identifier to put in a link we send to the guest: always the reservation UUID. */
export function linkIdentifierFor(reservation: { id: string }): string {
  return reservation.id;
}
