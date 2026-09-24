import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import { Storage, DEFAULT_TENANT_ID, type ITenantStorage, globalTenantStorage, db } from "../storage";
import { sql } from "drizzle-orm";
import { AutomationEngine } from "../automation";
import { MewsPoller } from "../mews-poller";
import { ReservationStateMachine } from "../reservation-state-machine";
import { UserStatsScheduler } from "../user-stats-scheduler";
import { DriftReconciler } from "../drift-reconciler";
import { createIngestionProcessor } from "../ingestion-processor";
import { isDatabaseReady, getTenantStorage } from "./middleware";

import { registerPublicApiRoutes } from "./public-api";
import { registerSystemRoutes } from "./system";
import { registerWebhookRoutes } from "./webhooks";
import { registerSpacesRoutes } from "./spaces";
import { registerLockDeviceRoutes } from "./lock-devices";
import { registerReservationRoutes } from "./reservations";
import { registerLogRoutes } from "./logs";
import { registerAutomationRoutes } from "./automation";
import { registerIngestionRoutes } from "./ingestion";
import { registerAuthRoutes } from "./auth";
import { registerAdminRoutes } from "./admin";
import { registerCheckinRoutes } from "./checkin";
import { registerHourlyRentalRoutes } from "./hourly-rentals";
import { registerArrivalsRoutes } from "./arrivals";
import { registerMarketingRoutes } from "./marketing";
import { HourlyRentalService } from "../hourly-rental-service";
import { sweepEarlyCheckins } from "../early-checkin-service";

export interface RouteContext {
  getAutomationEngine: (tenantId?: string) => AutomationEngine;
  isAutomationReady: (tenantId?: string) => boolean;
  getMewsPoller: (tenantId?: string) => MewsPoller | null;
  getDriftReconciler: (tenantId?: string) => DriftReconciler | null;
  getStateMachine: (tenantId?: string) => ReservationStateMachine | null;
  defaultStorage: ITenantStorage;
  getTenantStorage: (req: Request) => ITenantStorage;
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Per-tenant worker maps
  const automationEngines = new Map<string, AutomationEngine>();
  const mewsPollers = new Map<string, MewsPoller>();
  const stateMachines = new Map<string, ReservationStateMachine>();
  const stateMachineIntervals = new Map<string, NodeJS.Timeout>();
  const userStatsSchedulers = new Map<string, UserStatsScheduler>();
  const driftReconcilers = new Map<string, DriftReconciler>();
  const hourlySweepIntervals = new Map<string, NodeJS.Timeout>();
  const earlyCheckinSweepIntervals = new Map<string, NodeJS.Timeout>();
  let cleanupInterval: NodeJS.Timeout | null = null;

  const defaultStorage = Storage.forTenant(DEFAULT_TENANT_ID);

  const getAutomationEngine = (tenantId: string = DEFAULT_TENANT_ID): AutomationEngine => {
    const engine = automationEngines.get(tenantId);
    if (!engine) {
      const error = new Error("Service temporarily unavailable - automation engine not ready");
      (error as any).status = 503;
      throw error;
    }
    return engine;
  };

  const isAutomationReady = (tenantId: string = DEFAULT_TENANT_ID): boolean =>
    automationEngines.has(tenantId);

  const initializeTenantWorkers = async (tenantId: string) => {
    const tenantStorage = Storage.forTenant(tenantId);

    try {
      if (!automationEngines.has(tenantId)) {
        const engine = await AutomationEngine.initialize(tenantStorage);
        automationEngines.set(tenantId, engine);
        console.log(`[App] Automation engine initialized for tenant ${tenantId}`);
      }

      const engine = automationEngines.get(tenantId)!;
      const ttlockClient = engine.getTTLockClient?.() || null;
      const mewsClient = engine.getMewsClient?.() || null;

      if (!stateMachines.has(tenantId)) {
        try {
          const sm = new ReservationStateMachine(tenantStorage, engine, mewsClient, tenantId);
          stateMachines.set(tenantId, sm);
          // Run scheduled jobs every 60 seconds
          const interval = setInterval(() => sm.runScheduledJobs().catch(console.error), 60_000);
          stateMachineIntervals.set(tenantId, interval);
          // Run immediately on startup
          sm.runScheduledJobs().catch(console.error);
          console.log(`[StateMachine] Started for tenant ${tenantId}`);
        } catch (error) {
          console.error(`[StateMachine] Failed to start for tenant ${tenantId}:`, error);
        }
      }

      // Start DriftReconciler early — it only needs engine + mewsClient (already ready).
      // It must NOT be blocked by potentially slow await calls below.
      if (!driftReconcilers.has(tenantId)) {
        try {
          const ingestion = createIngestionProcessor(engine);
          const reconciler = new DriftReconciler(
            tenantStorage,
            engine,
            ingestion,
            tenantId,
            mewsClient
          );
          reconciler.start();
          driftReconcilers.set(tenantId, reconciler);
        } catch (error) {
          console.error(`[DriftReconciler] Failed to start for tenant ${tenantId}:`, error);
        }
      }

      // Daily report ("Daglig rapport") DISABLED per user decision 21/7: it
      // re-sent on every deploy restart (13-22 mails/day threads) and is not
      // wanted at all — neither generated nor sent. The manual
      // POST /api/send-daily-report endpoint can still trigger one on demand.
      if (!userStatsSchedulers.has(tenantId)) {
        userStatsSchedulers.set(tenantId, new UserStatsScheduler(tenantStorage));
      }

      // Hourly-rental sweep: releases stale payment holds, expires ended
      // bookings and re-pushes codes to locks that were offline at issuance.
      // Small + isolated from the MEWS state machine by design.
      if (!hourlySweepIntervals.has(tenantId)) {
        const hourlyService = new HourlyRentalService(tenantStorage, engine);
        const sweepInterval = setInterval(
          () => hourlyService.sweep().catch((err) =>
            console.error(`[HourlySweep] Failed for tenant ${tenantId}:`, err)),
          5 * 60_000,
        );
        hourlySweepIntervals.set(tenantId, sweepInterval);
      }

      // Early check-in sweep: emails waitlisted guests when their capsule
      // turns Inspected, verifies abandoned MEWS payments, expires stale rows.
      // Gated internally by the early_checkin_enabled setting (no-op otherwise).
      if (!earlyCheckinSweepIntervals.has(tenantId)) {
        const ecInterval = setInterval(
          () => sweepEarlyCheckins(tenantId, engine).catch((err) =>
            console.error(`[EarlyCheckinSweep] Failed for tenant ${tenantId}:`, err)),
          5 * 60_000,
        );
        earlyCheckinSweepIntervals.set(tenantId, ecInterval);
      }

      if (!mewsPollers.has(tenantId)) {
        try {
          console.log(`[App] ${tenantId}: initializing MEWS poller…`);
          const poller = await MewsPoller.initialize(tenantStorage, engine, tenantId);
          poller.start().catch((error: any) => {
            console.error(`[MewsPoller] Failed during initial sync for tenant ${tenantId}:`, error);
          });
          mewsPollers.set(tenantId, poller);
        } catch (error) {
          console.error(`[MewsPoller] Failed to initialize for tenant ${tenantId}:`, error);
        }
      }

      console.log(`[App] Background workers initialized for tenant ${tenantId}`);
      // DB marker so worker liveness per tenant is diagnosable without Railway
      // console access (the boot-hang incident 20/7 was invisible in DB logs).
      await tenantStorage.createLog({
        level: "info",
        message: "Tenant workers initialized (engine + state machine + poller)",
        source: "app",
      });
    } catch (error) {
      console.error(`[App] Failed to initialize workers for tenant ${tenantId}:`, error);
    }
  };

  const initializeBackgroundWorkers = async () => {
    if (!await isDatabaseReady()) {
      console.log("[App] Database not available, background workers will start later");
      setTimeout(initializeBackgroundWorkers, 30000);
      return;
    }

    try {
      const tenants = await globalTenantStorage.getAllTenants();

      if (tenants.length === 0) {
        console.log("[App] No tenants found, retrying in 30s");
        setTimeout(initializeBackgroundWorkers, 30000);
        return;
      }

      // Initialize tenants IN PARALLEL — one tenant's slow/hung init (e.g. a
      // stuck upstream call) must never starve the other tenants of their
      // workers. Each tenant logs its own progress; failures are isolated.
      await Promise.allSettled(
        tenants.map((tenant) =>
          initializeTenantWorkers(tenant.id).catch((error) =>
            console.error(`[App] Tenant init failed for ${tenant.id}:`, error)
          )
        )
      );

      // Cleanup job runs across all tenants
      if (!cleanupInterval) {
        let lastLogCleanupDate = "";
        cleanupInterval = setInterval(async () => {
          for (const [tenantId, engine] of Array.from(automationEngines.entries())) {
            try {
              const expiredResult = await engine.cleanupExpiredPasscodes();
              if (expiredResult.deleted > 0) {
                console.log(`[Cleanup] Tenant ${tenantId}: ${expiredResult.deleted} expired passcodes deleted`);
              }
              const orphanResult = await engine.cleanupOrphanedPasscodes();
              if (orphanResult.deleted > 0) {
                console.log(`[Cleanup] Tenant ${tenantId}: ${orphanResult.deleted} orphaned passcodes deleted`);
              }
            } catch (error) {
              console.error(`[Cleanup] Failed for tenant ${tenantId}:`, error);
            }
          }
          // Daily log cleanup: delete logs older than 7 days
          const today = new Date().toISOString().slice(0, 10);
          if (lastLogCleanupDate !== today) {
            lastLogCleanupDate = today;
            try {
              const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
              const result = await db.execute(
                sql`DELETE FROM logs WHERE "timestamp" < ${cutoff}`
              );
              const deleted = (result as any).rowCount ?? 0;
              if (deleted > 0) {
                console.log(`[Cleanup] Deleted ${deleted} log entries older than 7 days`);
              }
            } catch (error) {
              console.error("[Cleanup] Log cleanup failed:", error);
            }
          }
        }, 3600000);
      }

      // Periodically check for new tenants every 5 minutes
      setTimeout(async () => {
        const allTenants = await globalTenantStorage.getAllTenants();
        for (const tenant of allTenants) {
          if (!automationEngines.has(tenant.id)) {
            console.log(`[App] New tenant detected: ${tenant.id}, initializing workers...`);
            await initializeTenantWorkers(tenant.id);
          }
        }
      }, 5 * 60 * 1000);

      console.log(`[App] Background workers initialized for ${tenants.length} tenant(s)`);
    } catch (error) {
      console.error("[App] Failed to initialize background workers:", error);
      setTimeout(initializeBackgroundWorkers, 30000);
    }
  };

  initializeBackgroundWorkers();

  // Periodic session cleanup (every 30 minutes)
  setInterval(async () => {
    try {
      const cleaned = await globalTenantStorage.cleanupExpiredSessions();
      if (cleaned > 0) {
        console.log(`[Sessions] Cleaned up ${cleaned} expired sessions`);
      }
    } catch (error) {
      console.error("[Sessions] Failed to cleanup expired sessions:", error);
    }
  }, 30 * 60 * 1000);

  const ctx: RouteContext = {
    getAutomationEngine,
    isAutomationReady,
    getMewsPoller: (tenantId = DEFAULT_TENANT_ID) => mewsPollers.get(tenantId) || null,
    getDriftReconciler: (tenantId = DEFAULT_TENANT_ID) => driftReconcilers.get(tenantId) || null,
    getStateMachine: (tenantId = DEFAULT_TENANT_ID) => stateMachines.get(tenantId) || null,
    defaultStorage,
    getTenantStorage,
  };

  // Register all route modules
  registerPublicApiRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  registerWebhookRoutes(app, ctx);
  registerSpacesRoutes(app, ctx);
  registerLockDeviceRoutes(app, ctx);
  registerReservationRoutes(app, ctx);
  registerLogRoutes(app, ctx);
  registerAutomationRoutes(app, ctx);
  registerIngestionRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerCheckinRoutes(app, ctx);
  registerHourlyRentalRoutes(app, ctx);
  registerArrivalsRoutes(app, ctx);
  registerMarketingRoutes(app, ctx);

  // Scheduler status endpoint
  app.get("/api/scheduler-status", async (_req, res) => {
    const tenantStatuses: Record<string, object> = {};
    const allTenants = await globalTenantStorage.getAllTenants();
    for (const tenant of allTenants) {
      tenantStatuses[tenant.id] = {
        name: tenant.name,
        stateMachine: stateMachines.has(tenant.id) ? "running" : "stopped",
        mewsPoller: mewsPollers.has(tenant.id) ? "running" : "stopped",
        automationEngine: automationEngines.has(tenant.id) ? "ready" : "not_ready",
        driftReconciler: driftReconcilers.has(tenant.id) ? "running" : "stopped",
      };
    }
    res.json(tenantStatuses);
  });

  app.post("/api/send-daily-report", async (req, res) => {
    const tenantId = (req as any).tenantId || DEFAULT_TENANT_ID;
    const scheduler = userStatsSchedulers.get(tenantId);
    if (!scheduler) {
      return res.status(503).json({ error: "Daily report scheduler not running for this tenant" });
    }
    try {
      await scheduler.sendReport();
      res.json({ success: true, message: "Daily report sent" });
    } catch (error) {
      res.status(500).json({
        error: "Failed to send report",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/test-scheduled-jobs", async (req, res) => {
    const tenantId = (req as any).tenantId || DEFAULT_TENANT_ID;
    const sm = stateMachines.get(tenantId);
    if (!sm) {
      return res.status(503).json({ error: "State machine not running for this tenant" });
    }
    try {
      await sm.runScheduledJobs();
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: "Scheduled jobs failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/cleanup-ttlock-expired", async (req, res) => {
    const tenantId = (req as any).tenantId || DEFAULT_TENANT_ID;
    const engine = automationEngines.get(tenantId);
    if (!engine) {
      return res.status(503).json({ error: "Automation engine not ready for this tenant" });
    }
    try {
      const result = await engine.cleanupExpiredPasscodesFromTTLock();
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(500).json({
        error: "Cleanup failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
