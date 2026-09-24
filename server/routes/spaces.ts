import type { Express } from "express";
import type { RouteContext } from "./index";
import { getTenantStorage, resolveTenantId, verifyHotelToken, verifyHotelOrSetupToken } from "./middleware";
import { insertRoomSchema, insertCommonAreaSchema } from "@shared/schema";
import { Storage } from "../storage";
import { MewsClient } from "../mews-client";

export function registerSpacesRoutes(app: Express, ctx: RouteContext) {
  // Rooms
  app.get("/api/rooms", async (req, res) => {
    if (!await verifyHotelOrSetupToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const rooms = await storage.getAllRooms();
      res.json(rooms);
    } catch (error) {
      console.error("Error fetching rooms:", error);
      res.status(500).json({ error: "Failed to fetch rooms" });
    }
  });

  app.get("/api/rooms/:id", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const room = await storage.getRoom(req.params.id);
      if (!room) {
        return res.status(404).json({ error: "Room not found" });
      }
      res.json(room);
    } catch (error) {
      console.error("Error fetching room:", error);
      res.status(500).json({ error: "Failed to fetch room" });
    }
  });

  app.post("/api/rooms", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const validated = insertRoomSchema.parse(req.body);
      const room = await storage.createRoom(validated);
      res.status(201).json(room);
    } catch (error) {
      console.error("Error creating room:", error);
      res.status(400).json({ error: "Failed to create room" });
    }
  });

  app.put("/api/rooms/:id", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const validated = insertRoomSchema.partial().parse(req.body);

      // Prevent changing lock mapping if active passcodes exist for this room
      if (validated.ttlockId !== undefined) {
        const existingRoom = await storage.getRoom(req.params.id);
        if (existingRoom && existingRoom.ttlockId !== validated.ttlockId) {
          const pins = await storage.getPinsByRoomId(req.params.id);
          const activePins = pins.filter(p => p.status === "active");

          if (activePins.length > 0) {
            return res.status(400).json({
              error: `Kan ikke ændre TTLock mapping - ${activePins.length} aktiv${activePins.length > 1 ? 'e' : ''} adgangskode${activePins.length > 1 ? 'r' : ''} findes for dette værelse. Slet adgangskoderne først eller brug "Sync TTLock Devices" for at rense op.`
            });
          }
        }
      }

      const room = await storage.updateRoom(req.params.id, validated);
      if (!room) {
        return res.status(404).json({ error: "Room not found" });
      }
      res.json(room);
    } catch (error) {
      console.error("Error updating room:", error);
      const msg = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: msg || "Failed to update room" });
    }
  });

  app.delete("/api/rooms/:id", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      await storage.deleteRoom(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting room:", error);
      res.status(500).json({ error: "Failed to delete room" });
    }
  });

  app.post("/api/rooms/sync-mews", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const mewsClientToken = await storage.getSetting("mews_client_token");
      const mewsAccessToken = await storage.getSetting("mews_access_token");
      const mewsEnvironment = await storage.getSetting("mews_environment");

      if (!mewsClientToken || !mewsAccessToken) {
        return res.status(400).json({ error: "MEWS credentials not configured" });
      }

      const mewsClient = new MewsClient(
        mewsClientToken.value,
        mewsAccessToken.value,
        (mewsEnvironment?.value as "demo" | "production") || "demo"
      );

      const allResources = await mewsClient.getResources();

      let created = 0;
      let updated = 0;

      for (const resource of allResources) {
        const existingRoom = await storage.getRoomByPmsId(resource.Id);

        if (existingRoom) {
          await storage.updateRoom(existingRoom.id, {
            name: resource.Name,
            pmsId: resource.Id,
          });
          updated++;
        } else {
          await storage.createRoom({
            name: resource.Name,
            type: "capsule",
            beds: 1,
            pmsId: resource.Id,
            pmsStatus: "mapped",
            battery: 100,
            isDreamBoks: true,
          });
          created++;
        }
      }

      await storage.createLog({
        level: "info",
        message: `MEWS resources synchronized: ${created} created, ${updated} updated`,
        source: "System",
      });

      res.json({
        success: true,
        created,
        updated,
        total: allResources.length,
      });
    } catch (error) {
      console.error("Error syncing MEWS resources:", error);
      res.status(500).json({ error: "Failed to sync MEWS resources" });
    }
  });

  // Common Areas
  app.get("/api/common-areas", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const areas = await storage.getAllCommonAreas();
      res.json(areas);
    } catch (error) {
      console.error("Error fetching common areas:", error);
      res.status(500).json({ error: "Failed to fetch common areas" });
    }
  });

  app.get("/api/common-areas/:id", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const area = await storage.getCommonArea(req.params.id);
      if (!area) {
        return res.status(404).json({ error: "Common area not found" });
      }
      res.json(area);
    } catch (error) {
      console.error("Error fetching common area:", error);
      res.status(500).json({ error: "Failed to fetch common area" });
    }
  });

  app.post("/api/common-areas", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const validated = insertCommonAreaSchema.parse(req.body);
      const area = await storage.createCommonArea(validated);
      res.status(201).json(area);
    } catch (error) {
      console.error("Error creating common area:", error);
      res.status(400).json({ error: "Failed to create common area" });
    }
  });

  app.put("/api/common-areas/:id", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const validated = insertCommonAreaSchema.partial().parse(req.body);

      if (validated.ttlockId !== undefined) {
        const existingArea = await storage.getCommonArea(req.params.id);
        if (existingArea && existingArea.ttlockId !== validated.ttlockId) {
          const allPins = await storage.getAllPins();
          const affectedPins = allPins.filter(pin => {
            if (pin.status !== "active") return false;

            const commonAreaKeyIds = pin.commonAreaKeyIds;
            if (!Array.isArray(commonAreaKeyIds)) return false;

            return commonAreaKeyIds.some((key: any) => key?.commonAreaId === req.params.id);
          });

          if (affectedPins.length > 0) {
            return res.status(400).json({
              error: `Kan ikke ændre TTLock mapping - ${affectedPins.length} aktiv${affectedPins.length > 1 ? 'e' : ''} adgangskode${affectedPins.length > 1 ? 'r' : ''} bruger denne common area. Slet adgangskoderne først eller brug "Sync TTLock Devices" for at rense op.`
            });
          }
        }
      }

      const area = await storage.updateCommonArea(req.params.id, validated);
      if (!area) {
        return res.status(404).json({ error: "Common area not found" });
      }
      res.json(area);
    } catch (error) {
      console.error("Error updating common area:", error);
      res.status(400).json({ error: "Failed to update common area" });
    }
  });

}
