/**
 * Builds the check-in URL used in pre-arrival emails/SMS.
 *
 * Whenever the tenant has a real hotel_slug configured, we use the STATIC
 * find-by-name link (`/<slug>/find`). It is the reliable default because:
 *  - OTAs (Booking.com etc.) strip/rewrite unique per-reservation links, so a
 *    `/check-in/<token>` link arrives dead for those guests.
 *  - The reservation `origin` value is NOT a dependable OTA signal — real MEWS
 *    channel bookings are "ChannelManager", but channel/test bookings also show
 *    up as "CommanderChannel" etc. — so we no longer branch on it.
 *
 * Only when no real slug is configured do we fall back to the pre-filled token
 * link (`/check-in/<token>`), since `/find` needs a slug to resolve the tenant.
 */
export function buildPreCheckinUrl(params: {
  baseUrl: string;
  hotelSlug: string | undefined | null;
  preCheckinToken: string | undefined | null;
}): string {
  const { baseUrl, hotelSlug, preCheckinToken } = params;
  // Placeholder slugs ("hotel"/"default") mean the tenant slug is not configured.
  const hasHotelSlug = !!hotelSlug && hotelSlug !== "hotel" && hotelSlug !== "default";
  return hasHotelSlug
    ? `${baseUrl}/${hotelSlug}/find`
    : `${baseUrl}/check-in/${preCheckinToken}`;
}
