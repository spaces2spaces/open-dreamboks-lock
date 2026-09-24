import type { Express } from "express";
import type { RouteContext } from "./index";
import { getTenantStorage, verifyHotelToken } from "./middleware";
import { insertLogSchema, insertReservationLogSchema } from "@shared/schema";

export function registerLogRoutes(app: Express, ctx: RouteContext) {
  // Logs
  app.get("/api/logs", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
      const logs = await storage.getAllLogs(limit);
      res.json(logs);
    } catch (error) {
      console.error("Error fetching logs:", error);
      res.status(500).json({ error: "Failed to fetch logs" });
    }
  });

  app.get("/api/logs/reservation/:reservationId", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const logs = await storage.getLogsByReservation(req.params.reservationId);
      res.json(logs);
    } catch (error) {
      console.error("Error fetching reservation logs:", error);
      res.status(500).json({ error: "Failed to fetch reservation logs" });
    }
  });

  app.post("/api/logs", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const validated = insertLogSchema.parse(req.body);
      const log = await storage.createLog(validated);
      res.status(201).json(log);
    } catch (error) {
      console.error("Error creating log:", error);
      res.status(400).json({ error: "Failed to create log" });
    }
  });

  // Reservation Logs
  app.get("/api/reservation-logs/:reservationId", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const logs = await storage.getReservationLogs(req.params.reservationId);
      res.json(logs);
    } catch (error) {
      console.error("Error fetching reservation logs:", error);
      res.status(500).json({ error: "Failed to fetch reservation logs" });
    }
  });

  app.post("/api/reservation-logs", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const validated = insertReservationLogSchema.parse(req.body);
      const log = await storage.createReservationLog(validated);
      res.status(201).json(log);
    } catch (error) {
      console.error("Error creating reservation log:", error);
      res.status(400).json({ error: "Failed to create reservation log" });
    }
  });
}
