import { useEffect } from "react";
import type { CSSProperties } from "react";

// Per-tenant guest-flow theme (mirrors the boarding card's theme object). Returned by
// the public guest endpoints only when the tenant opted into guest-flow branding —
// so default tenants get `null` and the screens keep their existing look.
export interface GuestTheme {
  mode?: string | null;
  brand?: string | null;
  name?: string | null;
  tagline?: string | null;
  logoUrl?: string | null;
  font?: string | null;
  showName?: boolean | null;
  openedBg?: string | null;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex || "").trim());
  const h = m ? m[1] : "cc352a";
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
export function darkenHex(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c * (1 - amount))));
  const to = (c: number) => f(c).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}
export function rgba(hex: string, a: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// Convert a hex colour to the "H S% L%" component string that shadcn/Tailwind
// CSS variables (e.g. --primary, consumed via hsl(var(--primary))) expect.
export function hexToHslComponents(hex: string): string {
  let { r, g, b } = hexToRgb(hex);
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

// Inline CSS variables to set on a guest page's root element. Empty object when no
// brand → every `var(--brand, <fallback>)` reference keeps its hardcoded fallback,
// so default tenants render byte-identically.
export function guestThemeStyle(theme: GuestTheme | null | undefined): CSSProperties {
  if (!theme?.brand) return {};
  const style: Record<string, string> = {
    "--brand": theme.brand,
    "--brand-dark": darkenHex(theme.brand, 0.14),
    "--brand-tint": rgba(theme.brand, 0.12),
  };
  if (theme.font) style["--guest-font"] = `"${theme.font}", system-ui, -apple-system, sans-serif`;
  return style as CSSProperties;
}

// Swap the browser-tab favicon (+ apple-touch-icon and theme-color) to the tenant's
// branding while a branded guest page is mounted, restoring the defaults on unmount.
// No-op for default tenants (no logoUrl) so they keep the red DreamBoks favicon.
//
// The logo asset is typically a white mark on a transparent background (shown in-app
// inside a coloured chip), which would be invisible as a bare favicon. So we composite
// it onto a rounded brand-coloured tile via canvas — mirroring the in-app logo chip —
// and fall back to the raw logo if the canvas/image step fails.
export function useFavicon(logoUrl: string | null | undefined, brand?: string | null): void {
  useEffect(() => {
    if (!logoUrl) return;

    const setHref = (rel: string, href: string) => {
      let el = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
      const prev = el?.getAttribute("href") ?? null;
      if (!el) {
        el = document.createElement("link");
        el.setAttribute("rel", rel);
        document.head.appendChild(el);
      }
      el.setAttribute("href", href);
      return { el, prev };
    };

    const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const prevThemeColor = themeMeta?.getAttribute("content") ?? null;
    if (themeMeta && brand) themeMeta.setAttribute("content", brand);

    // Set raw logo first as an immediate fallback, then upgrade to the composited
    // tile once the image loads. Both restore their original href on unmount.
    const icon = setHref("icon", logoUrl);
    const apple = setHref("apple-touch-icon", logoUrl);
    let cancelled = false;

    if (brand) {
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        try {
          const S = 64;
          const canvas = document.createElement("canvas");
          canvas.width = S;
          canvas.height = S;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          // Rounded brand tile.
          const r = 14;
          ctx.fillStyle = brand;
          ctx.beginPath();
          ctx.moveTo(r, 0);
          ctx.arcTo(S, 0, S, S, r);
          ctx.arcTo(S, S, 0, S, r);
          ctx.arcTo(0, S, 0, 0, r);
          ctx.arcTo(0, 0, S, 0, r);
          ctx.closePath();
          ctx.fill();
          // Logo centred at ~64% with aspect ratio preserved.
          const box = S * 0.64;
          const ratio = img.width && img.height ? img.width / img.height : 1;
          let w = box, h = box;
          if (ratio > 1) h = box / ratio; else w = box * ratio;
          ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
          const url = canvas.toDataURL("image/png");
          icon.el.setAttribute("href", url);
          apple.el.setAttribute("href", url);
        } catch {
          // Keep the raw-logo fallback already set.
        }
      };
      img.src = logoUrl;
    }

    return () => {
      cancelled = true;
      if (icon.prev !== null) icon.el.setAttribute("href", icon.prev);
      if (apple.prev !== null) apple.el.setAttribute("href", apple.prev);
      if (themeMeta && prevThemeColor !== null) themeMeta.setAttribute("content", prevThemeColor);
    };
  }, [logoUrl, brand]);
}

// Lazily load a Google Font when the theme specifies one (no-op otherwise).
export function useGuestFont(font: string | null | undefined): void {
  useEffect(() => {
    if (!font) return;
    const id = `gfont-${font.replace(/[^a-z0-9]+/gi, "-")}`;
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font).replace(/%20/g, "+")}:wght@400;600;700;800&display=swap`;
    document.head.appendChild(link);
  }, [font]);
}
