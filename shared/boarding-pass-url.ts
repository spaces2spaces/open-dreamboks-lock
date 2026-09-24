import { linkIdentifierFor } from "./guest-identifier";

/**
 * Append the tenant's hotel slug to a /boarding-pass digital-key URL.
 *
 * The public /boarding-pass page is not slug-scoped in its path, so without a
 * `?hotel=<slug>` param it resolves to the default tenant. Every server-built
 * delivery link (email / SMS / WhatsApp) must carry the slug so a non-default
 * tenant's guest lands on the right hotel. No-op when the slug is empty/unset
 * (preserves the previous behaviour for the default tenant).
 */
export function appendHotelSlug(boardingPassUrl: string, hotelSlug?: string | null): string {
  const slug = (hotelSlug ?? "").trim();
  if (!slug) return boardingPassUrl;
  const sep = boardingPassUrl.includes("?") ? "&" : "?";
  return `${boardingPassUrl}${sep}hotel=${encodeURIComponent(slug)}`;
}

/**
 * Build the digital-key link for a reservation. Uses the LINK-GRADE identifier
 * (reservation UUID) so the link cannot be guessed — see shared/guest-identifier.ts.
 */
export function buildBoardingPassUrl(
  baseUrl: string,
  reservation: { id: string; lastName: string },
  hotelSlug?: string | null,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  return appendHotelSlug(
    `${base}/boarding-pass?res=${encodeURIComponent(linkIdentifierFor(reservation))}&name=${encodeURIComponent(reservation.lastName)}`,
    hotelSlug,
  );
}
