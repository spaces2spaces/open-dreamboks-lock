import type { Express } from "express";
import { timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import type { RouteContext } from "./index";
import { verifyHotelToken, arrivalsLimiter } from "./middleware";
import { Storage, db } from "../storage";
import { tenants as tenantsTable } from "@shared/schema";
import {
  buildLockArrivalReportData,
  ARRIVAL_AUDIT_SNAPSHOT_SETTING,
  type ArrivalAuditSnapshot,
} from "../lock-arrival-report";

// The page polls every ~30s per open tab; each build hits MEWS (resources +
// blocks). A short per-tenant cache keeps concurrent tabs from multiplying
// that load. TTLock is NEVER touched here (runAudit: false) — door gaps come
// from the snapshot persisted by the hourly report job's audit.
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map<string, { at: number; payload: unknown }>();

// No-login share link (the URL the report/reminder mails carry): a long random
// per-tenant capability token (`arrivals_share_token` setting) stands in for a
// session. Same resolution pattern as hotel_slug in public-api: compare the
// presented key against every active tenant's setting — constant-time compare,
// shape pre-check so junk never reaches the DB loop.
async function resolveTenantIdByShareToken(key: string): Promise<string | null> {
  if (!/^[a-f0-9]{32,128}$/i.test(key)) return null;
  const activeTenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
  for (const tenant of activeTenants) {
    const ts = Storage.forTenant(tenant.id);
    const token = (await ts.getSetting("arrivals_share_token"))?.value;
    if (
      token &&
      token.length === key.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(key))
    ) {
      return tenant.id;
    }
  }
  return null;
}

export function registerArrivalsRoutes(app: Express, _ctx: RouteContext) {
  // The share page (and everything under /arrivals) is owner-only-by-secrecy:
  // never indexed. Registered before the SPA static catch-all, so the header
  // also lands on the HTML document itself.
  app.use("/arrivals", (_req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Referrer-Policy", "no-referrer");
    // The share URL is a capability; the document must never land in shared
    // or disk caches.
    res.setHeader("Cache-Control", "no-store, private");
    next();
  });

  app.get("/api/arrivals", arrivalsLimiter, async (req, res) => {
    // Owner-shared page: must never be indexed or leak its URL via referrer.
    // Payload carries guest names + door codes — and in key-mode there is no
    // Authorization header to make caches treat it as private, so say it
    // explicitly: never store.
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store, private");

    // Share-token first (the mail link works without login); hotel session as
    // the in-app path. A valid key decides the tenant — headers cannot.
    const key = typeof req.query.key === "string" ? req.query.key : "";
    let tenantId: string | null = key ? await resolveTenantIdByShareToken(key) : null;
    if (!tenantId) {
      if (key) return res.status(401).json({ error: "Unauthorized" }); // invalid key never falls through to headers
      const session = await verifyHotelToken(req);
      if (!session) return res.status(401).json({ error: "Unauthorized" });
      tenantId = session.tenantId;
    }
    try {
      const dateRaw = typeof req.query.date === "string" ? req.query.date : undefined;
      const date = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : undefined;

      const cacheKey = `${tenantId}:${date ?? "auto"}`;
      const hit = cache.get(cacheKey);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        return res.json(hit.payload);
      }

      const storage = Storage.forTenant(tenantId);
      const data = await buildLockArrivalReportData(storage, { runAudit: false, date });

      // Overlay the latest audit snapshot (gaps/offline verified against the
      // locks by the hourly report job) — auditAt tells the page how fresh it is.
      try {
        const raw = (await storage.getSetting(ARRIVAL_AUDIT_SNAPSHOT_SETTING))?.value;
        if (raw) {
          const audit = JSON.parse(raw) as ArrivalAuditSnapshot;
          data.doorGaps = audit.gaps ?? [];
          data.offlineDoors = audit.offlineDoors ?? [];
          data.autoRepairedCount = audit.autoRepairedCount ?? 0;
          data.auditAt = audit.at ?? null;
          data.urgentReasons = [...(audit.urgentOfflineReasons ?? []), ...data.urgentReasons];
        }
      } catch { /* stale/invalid snapshot must never break the page */ }

      if (cache.size > 100) {
        for (const [cKey, entry] of Array.from(cache.entries())) {
          if (Date.now() - entry.at > CACHE_TTL_MS) cache.delete(cKey);
        }
      }
      cache.set(cacheKey, { at: Date.now(), payload: data });
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to build arrivals data" });
    }
  });
}
