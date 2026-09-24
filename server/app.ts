import { type Server } from "node:http";

import express, { type Express, type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes/index";

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

export const app = express();

// Trust reverse proxy (Railway, Nginx, etc.) for correct client IP in rate limiting
app.set("trust proxy", 1);

declare module 'http' {
  interface IncomingMessage {
    rawBody: unknown
  }
}
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

// Guest custom domains: a tenant can point its own domains at this app —
//  - guest_info_domain (e.g. infoscreen.hotelcapsuleinn.com): the wall
//    tablet's domain; bare root redirects to /{slug}/info.
//  - guest_links_domain (e.g. my.hotelcapsuleinn.com, 27/7): the domain used
//    in guest links (marketing SMS /extras etc. — app_base_url points here);
//    bare root redirects to /{slug}/extras.
// On BOTH kinds, slug-less guest paths (/extras, /extend, ...) redirect into
// the tenant's slug path, so short hand-typed links work. Host→hit is cached
// (misses too) so normal traffic doesn't loop over tenants.
const guestDomainCache = new Map<string, { hit: { slug: string; rootPath: string } | null; expires: number }>();
async function resolveGuestDomain(hostname: string | undefined): Promise<{ slug: string; rootPath: string } | null> {
  const host = (hostname || "").trim().toLowerCase();
  if (!host) return null;

  const cached = guestDomainCache.get(host);
  if (cached && cached.expires > Date.now()) return cached.hit;

  const { Storage, db } = await import("./storage");
  const { tenants: tenantsTable } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");

  let hit: { slug: string; rootPath: string } | null = null;
  const activeTenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
  for (const tenant of activeTenants) {
    const ts = Storage.forTenant(tenant.id);
    const infoDomain = (await ts.getSetting("guest_info_domain"))?.value?.trim().toLowerCase();
    const linksDomain = (await ts.getSetting("guest_links_domain"))?.value?.trim().toLowerCase();
    if (host === infoDomain || host === linksDomain) {
      const slug = (await ts.getSetting("hotel_slug"))?.value?.trim();
      if (slug) hit = { slug, rootPath: host === infoDomain ? `/${slug}/info` : `/${slug}/extras` };
      break;
    }
  }

  guestDomainCache.set(host, { hit, expires: Date.now() + 5 * 60 * 1000 });
  return hit;
}

// Guest domains must stay out of search engines: every response on such a
// host carries noindex. Deliberately no robots.txt Disallow — crawlers must
// be able to fetch the page to SEE the noindex directive.
app.use(async (req, res, next) => {
  try {
    if (await resolveGuestDomain(req.hostname)) {
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
    }
  } catch (err) {
    console.error("[Kiosk] noindex middleware error:", err);
  }
  next();
});

app.get("/", async (req, res, next) => {
  try {
    const hit = await resolveGuestDomain(req.hostname);
    return hit ? res.redirect(302, hit.rootPath) : next();
  } catch (err) {
    console.error("[Kiosk] domain redirect error:", err);
    return next();
  }
});

// Slug-less guest paths on a matched guest domain → the tenant's slug path
// (query string preserved). Without this, the SPA would treat "/extras" as
// the :hotel param and show a broken page.
const GUEST_BARE_PATHS = ["/extras", "/extend", "/hourly", "/checkin", "/find", "/info", "/guide"];
app.get(GUEST_BARE_PATHS, async (req, res, next) => {
  try {
    const hit = await resolveGuestDomain(req.hostname);
    return hit ? res.redirect(302, `/${hit.slug}${req.originalUrl}`) : next();
  } catch (err) {
    console.error("[Kiosk] bare-path redirect error:", err);
    return next();
  }
});

// The FULL kiosk experience — including the name+date door-code lookup — is
// served only on the tenant's own kiosk domain (guest_info_domain). On any
// other host, /:slug/info redirects to the mobile guide: same screen minus
// the kiosk-only lookup (29/7 owner decision; the lookup API is additionally
// Host-gated server-side). localhost stays open for development.
const infoHostCache = new Map<string, { domain: string | null; expires: number }>();
app.get("/:slug/info", async (req, res, next) => {
  try {
    const slug = (req.params.slug || "").toLowerCase();
    const host = (req.hostname || "").toLowerCase();
    if (!slug || slug.includes(".") || host === "localhost" || host.startsWith("127.")) return next();
    let cached = infoHostCache.get(slug);
    if (!cached || cached.expires <= Date.now()) {
      const { Storage, db } = await import("./storage");
      const { tenants: tenantsTable } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      let domain: string | null = null;
      const activeTenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
      for (const tenant of activeTenants) {
        const ts = Storage.forTenant(tenant.id);
        if ((await ts.getSetting("hotel_slug"))?.value?.trim().toLowerCase() === slug) {
          domain = (await ts.getSetting("guest_info_domain"))?.value?.trim().toLowerCase() || null;
          break;
        }
      }
      cached = { domain, expires: Date.now() + 5 * 60 * 1000 };
      infoHostCache.set(slug, cached);
    }
    if (cached.domain && host !== cached.domain) return res.redirect(302, `/${req.params.slug}/guide`);
    return next();
  } catch (err) {
    console.error("[Kiosk] info-host guard error:", err);
    return next();
  }
});

async function seedSettingsFromEnv() {
  try {
    const { globalTenantStorage } = await import("./storage");
    const tenants = await globalTenantStorage.getAllTenants();
    if (tenants.length === 0) return;

    for (const tenant of tenants) {
      const { Storage } = await import("./storage");
      const tenantStorage = Storage.forTenant(tenant.id);

      const envMappings: Array<[string, string | undefined]> = [
        ["ttlock_username", process.env.TTLOCK_OWNER_USERNAME],
        ["ttlock_password", process.env.TTLOCK_OWNER_PASSWORD],
        ["ttlock_api_key", process.env.TTLOCK_API_KEY],
        ["mews_client_token", process.env.MEWS_CLIENT_TOKEN],
        ["mews_access_token", process.env.MEWS_ACCESS_TOKEN],
        ["mews_platform_url", process.env.MEWS_PLATFORM_URL],
        ["twilio_account_sid", process.env.TWILIO_ACCOUNT_SID],
        ["twilio_auth_token", process.env.TWILIO_AUTH_TOKEN],
        ["twilio_from_number", process.env.TWILIO_FROM_NUMBER],
        ["sendgrid_api_key", process.env.SENDGRID_API_KEY],
        ["sendgrid_from_email", process.env.SENDGRID_FROM_EMAIL],
      ];

      // Env vars only seed settings that aren't already set in the DB.
      // All settings are managed through the Settings UI per tenant.
      for (const [key, value] of envMappings) {
        if (value) {
          const existing = await tenantStorage.getSetting(key);
          if (!existing?.value) {
            await tenantStorage.setSetting(key, value);
          }
        }
      }
    }
    console.log("[App] Settings seeded from environment variables");
  } catch (err) {
    console.error("[App] Failed to seed settings from env:", err);
  }
}

export default async function runApp(
  setup: (app: Express, server: Server) => Promise<void>,
) {
  // Schema guards FIRST: a deploy that adds a column must never leave the
  // running code querying a column the database doesn't have yet.
  const { ensureSchemaGuards } = await import("./db");
  await ensureSchemaGuards();

  const server = await registerRoutes(app);
  await seedSettingsFromEnv();

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly run the final setup after setting up all the other routes so
  // the catch-all route doesn't interfere with the other routes
  await setup(app, server);

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen(port, "0.0.0.0", () => {
    log(`serving on port ${port}`);
  });
}
