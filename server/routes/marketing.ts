/**
 * Marketing/upsell campaign routes (staff-only): campaign status + audience
 * preview, send log, and the send trigger (dryRun / testTo / real).
 */
import type { Express, Request } from "express";
import { DateTime } from "luxon";
import { Storage, type ITenantStorage } from "../storage";
import { verifyHotelToken } from "./middleware";
import type { RouteContext } from "./index";
import {
  MARKETING_CAMPAIGNS,
  getCampaign,
  renderSmsText,
  runCampaign,
} from "../marketing-service";

export function registerMarketingRoutes(app: Express, _ctx: RouteContext) {
  // Tenant from the AUTHENTICATED SESSION (never headers).
  const resolve = async (req: Request): Promise<{ storage: ITenantStorage } | null> => {
    const session = await verifyHotelToken(req);
    if (!session) return null;
    return { storage: Storage.forTenant(session.tenantId) };
  };

  app.get("/api/marketing/campaigns", async (req, res) => {
    const r = await resolve(req);
    if (!r) return res.status(401).json({ error: "Unauthorized" });
    try {
      const tz = (await r.storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
      const now = DateTime.now().setZone(tz);
      const roomName = new Map(
        (await r.storage.getAllRooms()).map(rm => [rm.id, rm.label || rm.name]),
      );
      const campaigns = [];
      for (const c of MARKETING_CAMPAIGNS) {
        const audience = await c.audience(r.storage, now);
        campaigns.push({
          id: c.id,
          label: c.label,
          enabled: (await r.storage.getSetting(`marketing_${c.id}_enabled`))?.value === "true",
          sendTime: (await r.storage.getSetting(`marketing_${c.id}_send_time`))?.value || c.defaultSendTime,
          smsText: (await r.storage.getSetting(`marketing_${c.id}_sms_text`))?.value || null,
          defaultSmsText: c.defaultSmsText,
          lastSentDate: (await r.storage.getSetting(`marketing_${c.id}_last_sent_date`))?.value || null,
          preview: await renderSmsText(r.storage, c),
          audienceCount: audience.length,
          audience: audience.map(a => ({
            reservationId: a.id,
            name: `${a.firstName} ${a.lastName}`.trim(),
            mobile: a.mobile,
            capsule: a.roomId ? roomName.get(a.roomId) || "?" : "?",
            arrival: a.arrival,
            departure: a.departure,
          })),
        });
      }
      res.json({ campaigns });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/marketing/sends", async (req, res) => {
    const r = await resolve(req);
    if (!r) return res.status(401).json({ error: "Unauthorized" });
    try {
      const limit = Math.min(500, parseInt(String(req.query.limit || "100"), 10) || 100);
      res.json({ sends: await r.storage.getMarketingSendsWithReservations(limit) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Day-by-day campaign history: sends per campaign + resulting EC/LC
  // purchases, zero-filled so the curve has a point for every day.
  app.get("/api/marketing/history", async (req, res) => {
    const r = await resolve(req);
    if (!r) return res.status(401).json({ error: "Unauthorized" });
    try {
      const days = Math.min(365, Math.max(7, parseInt(String(req.query.days || "30"), 10) || 30));
      const tz = (await r.storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
      const [sends, purchases] = await Promise.all([
        r.storage.getMarketingDailyHistory(days, tz),
        r.storage.getUpsellDailyHistory(days, tz),
      ]);

      const byDay = new Map<string, {
        day: string;
        ecSent: number; lcSent: number; failed: number;
        ecPurchases: number; lcPurchases: number; revenue: number;
      }>();
      const today = DateTime.now().setZone(tz).startOf("day");
      for (let i = days - 1; i >= 0; i--) {
        const day = today.minus({ days: i }).toFormat("yyyy-MM-dd");
        byDay.set(day, { day, ecSent: 0, lcSent: 0, failed: 0, ecPurchases: 0, lcPurchases: 0, revenue: 0 });
      }
      for (const s of sends) {
        const row = byDay.get(s.day);
        if (!row) continue;
        if (s.campaign === "early_checkin_offer") row.ecSent += s.sent;
        else if (s.campaign === "late_checkout_offer") row.lcSent += s.sent;
        row.failed += s.failed;
      }
      for (const p of purchases) {
        const row = byDay.get(p.day);
        if (!row) continue;
        if (p.kind === "late_checkout") row.lcPurchases += p.purchases;
        else row.ecPurchases += p.purchases;
        row.revenue += p.revenue;
      }
      res.json({ days: Array.from(byDay.values()) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/marketing/send", async (req, res) => {
    const r = await resolve(req);
    if (!r) return res.status(401).json({ error: "Unauthorized" });
    try {
      const campaignId = String(req.body?.campaign || "");
      if (!getCampaign(campaignId)) return res.status(400).json({ error: "Unknown campaign" });
      const result = await runCampaign(r.storage, campaignId, {
        dryRun: req.body?.dryRun === true,
        testTo: req.body?.testTo ? String(req.body.testTo) : undefined,
        trigger: "manual",
      });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
