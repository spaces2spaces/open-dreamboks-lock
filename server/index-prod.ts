import fs from "node:fs";
import { type Server } from "node:http";
import path from "node:path";

import express, { type Express, type Request } from "express";
import { eq } from "drizzle-orm";

import runApp from "./app";
import { Storage, db } from "./storage";
import { tenants as tenantsTable } from "@shared/schema";

// Resolve a tenant's branding (link previews + home-screen icon/title) from its
// hotel slug. Cached briefly — misses too — so per-request work stays cheap.
interface TenantBranding {
  brandName: string | null;
  ogImage: string | null;
  touchIcon: string | null;
  brandColor: string | null;
}
const brandingCache = new Map<string, { branding: TenantBranding | null; expires: number }>();
async function resolveTenantBranding(slug: string): Promise<TenantBranding | null> {
  const key = slug.trim().toLowerCase();
  const cached = brandingCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.branding;
  let branding: TenantBranding | null = null;
  try {
    const activeTenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
    for (const tenant of activeTenants) {
      const ts = Storage.forTenant(tenant.id);
      const slugSetting = await ts.getSetting("hotel_slug");
      if (slugSetting?.value?.trim().toLowerCase() === key) {
        branding = {
          brandName: (await ts.getSetting("boarding_brand_name"))?.value ?? tenant.name ?? null,
          ogImage: (await ts.getSetting("boarding_og_image"))?.value ?? null,
          touchIcon: (await ts.getSetting("boarding_touch_icon"))?.value ?? null,
          brandColor: (await ts.getSetting("boarding_brand_color"))?.value ?? null,
        };
        break;
      }
    }
  } catch (err) {
    console.error("[Branding] Failed to resolve branding for slug", slug, err);
    return null; // don't cache transient DB errors
  }
  brandingCache.set(key, { branding, expires: Date.now() + 5 * 60 * 1000 });
  return branding;
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Inject per-tenant tags into the static index.html: Open Graph/title so shared
// links unfurl with the correct hotel name + logo, and apple-touch-icon /
// web-app-title / theme-color so "Add to Home Screen" on a tenant page (e.g. the
// info kiosk) gets the tenant's icon and name instead of the DreamBoks defaults.
function injectBranding(html: string, origin: string, branding: TenantBranding, manifestHref: string | null, noindex = false): string {
  const { brandName, ogImage, touchIcon, brandColor } = branding;
  let out = html;
  if (noindex) {
    // Internal screens (info kiosk) must stay out of search engines.
    out = out.replace("</title>", `</title>\n    <meta name="robots" content="noindex, nofollow" />`);
  }
  if (brandName) {
    const name = htmlEscape(brandName);
    const desc = htmlEscape(`${brandName} – online check-in & digital key.`);
    out = out
      .replace(/<title>[^<]*<\/title>/, `<title>${name}</title>`)
      .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${name}$2`)
      .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${desc}$2`)
      .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${name}$2`)
      .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${desc}$2`)
      .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, `$1${name}$2`);
  }
  if (ogImage) {
    const abs = /^https?:\/\//.test(ogImage) ? ogImage : `${origin}${ogImage}`;
    const absEsc = htmlEscape(abs);
    out = out
      .replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${absEsc}$2`)
      .replace(/(<meta name="twitter:image" content=")[^"]*(")/, `$1${absEsc}$2`)
      .replace(/(<meta name="twitter:card" content=")[^"]*(")/, `$1summary_large_image$2`);
  }
  if (touchIcon) {
    out = out.replace(/(<link rel="apple-touch-icon"[^>]*href=")[^"]*(")/, `$1${htmlEscape(touchIcon)}$2`);
  }
  if (brandColor) {
    out = out.replace(/(<meta name="theme-color" content=")[^"]*(")/, `$1${htmlEscape(brandColor)}$2`);
  }
  if (manifestHref) {
    out = out.replace(/(<link rel="manifest" href=")[^"]*(")/, `$1${htmlEscape(manifestHref)}$2`);
  }
  return out;
}

export async function serveStatic(app: Express, server: Server) {
  const distPath = path.resolve(import.meta.dirname, "public");

  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  const indexPath = path.resolve(distPath, "index.html");

  app.use(express.static(distPath));

  // Per-tenant web-app manifest for the info kiosk, so "Add to Home Screen"
  // uses the tenant's name/icon and reopens the info page (not /boarding-pass).
  app.get("/:slug/info.webmanifest", async (req: Request, res) => {
    const branding = await resolveTenantBranding(req.params.slug);
    if (!branding || !branding.brandName) return res.status(404).end();
    res.set("Content-Type", "application/manifest+json").json({
      name: branding.brandName,
      short_name: branding.brandName,
      start_url: `/${req.params.slug}/info`,
      display: "standalone",
      background_color: "#ffffff",
      theme_color: branding.brandColor ?? "#ffffff",
      icons: branding.touchIcon
        ? [{ src: branding.touchIcon, sizes: "512x512", type: "image/png", purpose: "any maskable" }]
        : [],
    });
  });

  // Admin/system SPA routes are never tenant-slugged — serving them must not
  // pay the branding lookup (perf 23/7: /login took seconds when the DB pool
  // was saturated because every static page resolved branding first).
  const NON_SLUG_ROUTES = new Set([
    "login", "arrivals", "reservations", "spaces", "lock-mapping", "hourly",
    "logs", "settings", "unlock-qr", "rate", "setup", "vendor", "check-in", "assets",
  ]);

  // fall through to index.html if the file doesn't exist
  app.use("*", async (req: Request, res) => {
    // Branded HTML: /boarding-pass?hotel=<slug> and any /<slug>/... guest page
    // (checkin, info kiosk, hourly, …) get tenant OG + home-screen tags.
    try {
      const url = new URL(req.originalUrl, "http://localhost");
      let slug: string | null = null;
      if (url.pathname === "/boarding-pass") {
        slug = url.searchParams.get("hotel");
      } else {
        slug = url.pathname.split("/")[1] || null;
        if (slug && (NON_SLUG_ROUTES.has(slug) || slug.includes("."))) slug = null;
      }
      if (slug) {
        const branding = await resolveTenantBranding(slug);
        if (branding && (branding.brandName || branding.ogImage)) {
          const isInfoPage = /^\/[^/]+\/(info|guide)\/?$/.test(url.pathname);
          const manifestHref = /^\/[^/]+\/info\/?$/.test(url.pathname) ? `/${slug}/info.webmanifest` : null;
          const html = fs.readFileSync(indexPath, "utf-8");
          const origin = `${req.protocol}://${req.get("host")}`;
          if (isInfoPage) res.set("X-Robots-Tag", "noindex, nofollow");
          res.set("Content-Type", "text/html").send(injectBranding(html, origin, branding, manifestHref, isInfoPage));
          return;
        }
      }
    } catch (err) {
      console.error("[Branding] injection error:", err);
    }
    res.sendFile(indexPath);
  });
}

(async () => {
  await runApp(serveStatic);
})();
