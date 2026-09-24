// Shared per-tenant boarding/guest-flow theme builder.
//
// The digital-key card (boarding-pass-ekey) has long returned a theme object built
// from per-tenant boarding_* settings. The rest of the guest flow (find / check-in /
// rating screens) mirrors that — but only when a tenant has opted into guest-flow
// branding via `boarding_guest_branded`, so default tenants (e.g. Downtown) keep
// their existing look on those screens.

export interface BoardingTheme {
  mode: string;
  brand: string;
  name: string | null;
  tagline: string | null;
  logoUrl: string | null;
  font: string | null;
  showName: boolean;
  openedBg: string | null;
}

export function buildBoardingTheme(get: (key: string) => string | undefined | null): BoardingTheme {
  return {
    mode: get("boarding_theme_mode") || "light",
    brand: get("boarding_brand_color") || "#cc352a",
    name: get("boarding_brand_name") || null,
    tagline: get("boarding_tagline") || "Tap a button to unlock your doors",
    logoUrl: get("boarding_logo_url") || null,
    font: get("boarding_font") || null,
    showName: get("boarding_logo_show_name") === "true",
    openedBg: get("boarding_opened_bg") || null,
  };
}

// Theme for the guest-flow screens — returned only when the tenant has explicitly
// opted in. Returns null otherwise so the client keeps the default (Downtown) look.
export function buildGuestFlowTheme(get: (key: string) => string | undefined | null): BoardingTheme | null {
  if (get("boarding_guest_branded") !== "true") return null;
  return buildBoardingTheme(get);
}
