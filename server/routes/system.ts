import type { Express } from "express";
import type { RouteContext } from "./index";
import { getTenantStorage, resolveTenantId, validate, verifyHotelToken, verifyHotelOrSetupToken } from "./middleware";
import { config } from "../config";
import { createFeatureFlagService, type FeatureFlag } from "../feature-flags";
import { settingUpdateSchema, featureFlagUpdateSchema } from "@shared/validation";

export function registerSystemRoutes(app: Express, ctx: RouteContext) {
  // Health Check
  app.get("/api/health", async (req, res) => {
    try {
      const storage = getTenantStorage(req);

      // Check database connectivity
      const dbCheck = await storage.getAllSettings().then(() => true).catch(() => false);

      // Check MEWS credentials exist
      const mewsClientToken = await storage.getSetting("mews_client_token").catch(() => null);
      const mewsAccessToken = await storage.getSetting("mews_access_token").catch(() => null);
      const mewsConfigured = !!(mewsClientToken?.value && mewsAccessToken?.value);

      // Check TTLock credentials exist
      const ttlockUsername = await storage.getSetting("ttlock_username").catch(() => null);
      const ttlockPassword = await storage.getSetting("ttlock_password").catch(() => null);
      const ttlockConfigured = !!(ttlockUsername?.value && ttlockPassword?.value);

      // Check TTLock global credentials (from env)
      const ttlockGlobalConfigured = !!(process.env.TTLOCK_CLIENT_ID && process.env.TTLOCK_API_KEY);

      const allChecks = dbCheck && (mewsConfigured || config.isDevelopment);

      res.json({
        status: allChecks ? "healthy" : "degraded",
        environment: config.environment,
        timestamp: new Date().toISOString(),
        checks: {
          database: dbCheck ? "ok" : "failed",
          mews: mewsConfigured ? "configured" : "not_configured",
          ttlock_hotel: ttlockConfigured ? "configured" : "not_configured",
          ttlock_global: ttlockGlobalConfigured ? "configured" : "not_configured",
        },
      });
    } catch (error) {
      res.status(503).json({
        status: "unhealthy",
        environment: config.environment,
        timestamp: new Date().toISOString(),
        error: "Health check failed",
      });
    }
  });

  // Version / deployed commit — for verifying that GitHub main == Railway live.
  // Railway injects RAILWAY_GIT_* at build time. No tenant/DB/auth needed.
  // Compare `commit` here to `git rev-parse origin/main` on GitHub.
  app.get("/api/version", (_req, res) => {
    res.json({
      commit: process.env.RAILWAY_GIT_COMMIT_SHA || "unknown",
      branch: process.env.RAILWAY_GIT_BRANCH || "unknown",
      deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || "unknown",
      environment: config.environment,
      timestamp: new Date().toISOString(),
    });
  });

  // Feature Flags
  app.get("/api/feature-flags", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const featureFlags = createFeatureFlagService(storage);
      const flags = await featureFlags.getAllFlags();
      res.json(flags);
    } catch (error) {
      console.error("Error fetching feature flags:", error);
      res.status(500).json({ error: "Failed to fetch feature flags" });
    }
  });

  app.put("/api/feature-flags/:flag", validate(featureFlagUpdateSchema), async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const featureFlags = createFeatureFlagService(storage);
      const flag = req.params.flag as FeatureFlag;
      const { enabled } = req.body;

      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be a boolean" });
      }

      await featureFlags.setEnabled(flag, enabled);
      res.json({ flag, enabled });
    } catch (error) {
      console.error("Error updating feature flag:", error);
      res.status(500).json({ error: "Failed to update feature flag" });
    }
  });

  // Settings
  app.get("/api/settings", async (req, res) => {
    if (!await verifyHotelOrSetupToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const settings = await storage.getAllSettings();
      const sanitizedSettings = settings.map(setting => ({
        ...setting,
        value: setting.encrypted ? "" : setting.value,
      }));
      res.json(sanitizedSettings);
    } catch (error) {
      console.error("Error fetching settings:", error);
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  app.get("/api/settings/:key", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const setting = await storage.getSetting(req.params.key);
      if (!setting) {
        return res.status(404).json({ error: "Setting not found" });
      }
      const sanitizedSetting = {
        ...setting,
        value: setting.encrypted ? "" : setting.value,
      };
      res.json(sanitizedSetting);
    } catch (error) {
      console.error("Error fetching setting:", error);
      res.status(500).json({ error: "Failed to fetch setting" });
    }
  });

  app.put("/api/settings/:key", validate(settingUpdateSchema), async (req, res) => {
    if (!await verifyHotelOrSetupToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const { value } = req.body;

      // Block updates to developer credentials - these must be set via environment variables
      const PROTECTED_KEYS = ['ttlock_client_id', 'ttlock_api_key'];
      if (PROTECTED_KEYS.includes(req.params.key)) {
        return res.status(403).json({
          error: "This setting cannot be modified. Please contact support."
        });
      }

      // Validate timezone setting
      if (req.params.key === 'property_timezone') {
        try {
          Intl.DateTimeFormat(undefined, { timeZone: value });
        } catch (error) {
          return res.status(400).json({
            error: `Invalid timezone: ${value}. Please use a valid IANA timezone (e.g., Europe/Copenhagen, America/New_York)`
          });
        }
      }

      // Reset all MEWS data and update platform URL when MEWS environment changes (demo ↔ production)
      if (req.params.key === 'mews_environment') {
        const current = await storage.getSetting('mews_environment');
        if (current?.value && current.value !== value) {
          // deleteAllMewsData is NUCLEAR: every pin, reservation, room and ekey
          // for the tenant goes in one transaction. With live guests that means
          // door codes lose their backing rows. Require an explicit confirmation
          // phrase whenever LIVE pins exist (active AND used — a used pin is a
          // guest who already unlocked once and still has access), and leave a
          // loud audit trail.
          const allPins = await storage.getAllPins();
          const livePins = allPins.filter(p => p.status === "active" || p.status === "used");
          const CONFIRM_PHRASE = "DELETE-ALL-MEWS-DATA";
          if (livePins.length > 0 && req.body.confirm !== CONFIRM_PHRASE) {
            return res.status(409).json({
              error: `Changing mews_environment deletes ALL MEWS data for this hotel (${livePins.length} live door code(s) currently exist). If you are sure, repeat the request with "confirm": "${CONFIRM_PHRASE}".`,
            });
          }
          await storage.createLog({
            level: "error",
            message: `MEWS environment changed ${current.value} → ${value}: deleting ALL MEWS data for tenant (${livePins.length} live pins existed)`,
            source: "System",
          });
          const { sendOpsAlert } = await import("../ops-alert");
          await sendOpsAlert(
            storage as any,
            "mews-environment-wipe",
            "critical",
            `MEWS-miljø skiftet (${current.value} → ${value}) — ALLE MEWS-data for hotellet er slettet`,
            `${livePins.length} live dørkoder fandtes før skiftet. Reservationer, rum og koder skal re-synces fra MEWS.`
          );
          // Best-effort: revoke the physical codes BEFORE the rows disappear —
          // after deleteAllMewsData nothing knows which codes sit on the doors.
          // Failures are logged but never block the (explicitly confirmed) wipe.
          try {
            const pinLifecycle = ctx.getAutomationEngine(resolveTenantId(req)).getPinLifecycle();
            const revokedReservations = new Set<string>();
            for (const pin of livePins) {
              if (!pin.reservationId || revokedReservations.has(pin.reservationId)) continue;
              revokedReservations.add(pin.reservationId);
              const reservation = await storage.getReservation(pin.reservationId);
              if (reservation) {
                try {
                  await pinLifecycle.onCancelled(reservation, { force: true });
                } catch (revokeError) {
                  await storage.createLog({
                    level: "error",
                    message: `Pre-wipe revoke failed for reservation ${pin.reservationId}: ${revokeError instanceof Error ? revokeError.message : String(revokeError)} — code may remain on locks`,
                    source: "System",
                  });
                }
              }
            }
          } catch (revokeSetupError) {
            await storage.createLog({
              level: "error",
              message: `Pre-wipe revoke could not run: ${revokeSetupError instanceof Error ? revokeSetupError.message : String(revokeSetupError)} — codes may remain on locks`,
              source: "System",
            });
          }
          await storage.deleteAllMewsData();
          const platformUrl = value === 'production' ? 'https://api.mews.com/' : 'https://api.mews-demo.com/';
          await storage.setSetting('mews_platform_url', platformUrl);
          console.log(`[settings] MEWS environment changed from ${current.value} to ${value} — all MEWS data deleted, platform URL set to ${platformUrl}`);
        }
      }

      const setting = await storage.setSetting(req.params.key, value);
      const sanitizedSetting = {
        ...setting,
        value: setting.encrypted ? "" : setting.value,
      };
      res.json(sanitizedSetting);
    } catch (error) {
      console.error("Error updating setting:", error);
      res.status(500).json({ error: "Failed to update setting" });
    }
  });
}
