import type { Express } from "express";
import type { RouteContext } from "./index";
import { getTenantStorage, resolveTenantId, verifyHotelToken, verifyHotelOrSetupToken } from "./middleware";
import { insertRoomLockAssignmentSchema } from "@shared/schema";
import { MewsClient } from "../mews-client";

export function registerLockDeviceRoutes(app: Express, ctx: RouteContext) {
  // Lock Devices
  app.get("/api/lock-devices", async (req, res) => {
    if (!await verifyHotelOrSetupToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const devices = await storage.getAllLockDevices();
      res.json(devices);
    } catch (error) {
      console.error("Error fetching lock devices:", error);
      res.status(500).json({ error: "Failed to fetch lock devices" });
    }
  });

  app.patch("/api/lock-devices/:id", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const { name, lockType, doorName, roomId, isLinked } = req.body;
      const deviceId = req.params.id;

      const device = await storage.getLockDevice(deviceId);
      if (!device) {
        return res.status(404).json({ error: "Lock device not found" });
      }

      const allRooms = await storage.getAllRooms();
      const mappedRooms = allRooms.filter(r => r.ttlockId === device.ttlockId);

      if ((lockType !== undefined && lockType !== device.lockType) || (roomId !== undefined)) {
        const allActivePins = [];
        const affectedRoomNames = [];

        for (const room of mappedRooms) {
          if (roomId !== undefined && room.id === roomId) {
            continue;
          }

          const pins = await storage.getPinsByRoomId(room.id);
          const activePins = pins.filter(p => p.status === "active");

          if (activePins.length > 0) {
            allActivePins.push(...activePins);
            affectedRoomNames.push(room.name);
          }
        }

        if (roomId !== undefined && roomId !== null) {
          const destinationRoom = allRooms.find(r => r.id === roomId);
          if (destinationRoom) {
            const destPins = await storage.getPinsByRoomId(destinationRoom.id);
            const destActivePins = destPins.filter(p => p.status === "active");

            if (destActivePins.length > 0) {
              allActivePins.push(...destActivePins);
              affectedRoomNames.push(destinationRoom.name + ' (destination)');
            }
          }
        }

        if (allActivePins.length > 0) {
          const roomsList = affectedRoomNames.join(', ');
          return res.status(400).json({
            error: `Kan ikke ændre mapping - ${allActivePins.length} aktiv${allActivePins.length > 1 ? 'e' : ''} adgangskode${allActivePins.length > 1 ? 'r' : ''} findes for værelse(r): "${roomsList}". Slet adgangskoderne først eller brug "Sync TTLock Devices" for at rense op.`
          });
        }
      }

      if (roomId !== undefined || name !== undefined || lockType !== undefined) {
        const result = await storage.updateLockDeviceWithMapping(
          deviceId,
          { name: name ?? device.name, lockType: lockType ?? device.lockType, doorName },
          roomId
        );

        if (result.error) {
          return res.status(400).json({ error: result.error });
        }

        if (isLinked !== undefined) {
          await storage.updateLockDevice(result.device.id, { isLinked });
        }

        const finalDevice = await storage.getLockDevice(deviceId);
        res.json(finalDevice);
      } else if (doorName !== undefined || isLinked !== undefined) {
        const updates: Record<string, unknown> = {};
        if (doorName !== undefined) updates.doorName = doorName;
        if (isLinked !== undefined) updates.isLinked = isLinked;
        const updated = await storage.updateLockDevice(deviceId, updates as any);
        if (!updated) {
          return res.status(404).json({ error: "Lock device not found" });
        }
        res.json(updated);
      } else {
        const currentDevice = await storage.getLockDevice(deviceId);
        res.json(currentDevice);
      }
    } catch (error: any) {
      console.error("Error updating lock device:", error);
      res.status(500).json({ error: error.message || "Failed to update lock device" });
    }
  });

  app.get("/api/spaces/:id/available-locks", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const spaceId = req.params.id;
      const space = await storage.getRoom(spaceId);
      if (!space) {
        return res.status(404).json({ error: "Space not found" });
      }
      const availableLocks = await storage.getAvailableLockDevicesForSpace(spaceId);
      res.json(availableLocks);
    } catch (error) {
      console.error("Error fetching available locks:", error);
      res.status(500).json({ error: "Failed to fetch available locks" });
    }
  });

  // Room Lock Assignments
  app.get("/api/room-lock-assignments", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const assignments = await storage.getAllRoomLockAssignments();
      res.json(assignments);
    } catch (error) {
      console.error("Error fetching room lock assignments:", error);
      res.status(500).json({ error: "Failed to fetch room lock assignments" });
    }
  });

  app.get("/api/room-lock-assignments/room/:roomId", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const assignments = await storage.getRoomLockAssignments(req.params.roomId);
      res.json(assignments);
    } catch (error) {
      console.error("Error fetching room lock assignments:", error);
      res.status(500).json({ error: "Failed to fetch room lock assignments" });
    }
  });

  app.get("/api/room-lock-assignments/device/:deviceId", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const assignments = await storage.getLockDeviceAssignments(req.params.deviceId);
      res.json(assignments);
    } catch (error) {
      console.error("Error fetching lock device assignments:", error);
      res.status(500).json({ error: "Failed to fetch lock device assignments" });
    }
  });

  app.post("/api/room-lock-assignments", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const { roomId, lockDeviceId, assignmentType, accessScope } = req.body;

      if (!roomId || !lockDeviceId) {
        return res.status(400).json({ error: "roomId and lockDeviceId are required" });
      }

      const room = await storage.getRoom(roomId);
      if (!room) {
        return res.status(404).json({ error: "Room not found" });
      }

      const device = await storage.getLockDevice(lockDeviceId);
      if (!device) {
        return res.status(404).json({ error: "Lock device not found" });
      }

      const assignment = await storage.createRoomLockAssignment({
        roomId,
        lockDeviceId,
        assignmentType: assignmentType || "room_lock",
        accessScope: accessScope || null,
      });

      res.status(201).json(assignment);
    } catch (error: any) {
      console.error("Error creating room lock assignment:", error);
      if (error.message?.includes("unique constraint")) {
        return res.status(400).json({ error: "This room-lock assignment already exists" });
      }
      if (error.message?.includes("Room lock") && error.message?.includes("already assigned")) {
        return res.status(400).json({ error: error.message });
      }
      res.status(400).json({ error: "Failed to create room lock assignment" });
    }
  });

  app.delete("/api/room-lock-assignments/:id", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      await storage.deleteRoomLockAssignment(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting room lock assignment:", error);
      res.status(500).json({ error: "Failed to delete room lock assignment" });
    }
  });

  app.delete("/api/room-lock-assignments/room/:roomId/device/:deviceId", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      await storage.deleteRoomLockAssignmentByRoomAndDevice(req.params.roomId, req.params.deviceId);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting room lock assignment:", error);
      res.status(500).json({ error: "Failed to delete room lock assignment" });
    }
  });

  // Bulk create room lock assignments
  app.post("/api/room-lock-assignments/bulk", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const { assignments } = req.body;

      if (!Array.isArray(assignments) || assignments.length === 0) {
        return res.status(400).json({ error: "assignments array is required" });
      }

      // Validate all rooms and devices exist for this tenant
      const roomIds = Array.from(new Set(assignments.map((a: any) => a.roomId)));
      const deviceIds = Array.from(new Set(assignments.map((a: any) => a.lockDeviceId)));

      const rooms = await storage.getAllRooms();
      const devices = await storage.getAllLockDevices();

      const validRoomIds = new Set(rooms.map(r => r.id));
      const validDeviceIds = new Set(devices.map(d => d.id));

      const invalidRooms = roomIds.filter(id => !validRoomIds.has(id));
      const invalidDevices = deviceIds.filter(id => !validDeviceIds.has(id));

      if (invalidRooms.length > 0 || invalidDevices.length > 0) {
        return res.status(400).json({
          error: "Some rooms or devices not found",
          invalidRooms,
          invalidDevices
        });
      }

      const validAssignments = assignments.map((a: any) => ({
        roomId: a.roomId,
        lockDeviceId: a.lockDeviceId,
        assignmentType: a.assignmentType || "room_lock",
        accessScope: a.accessScope || null,
      }));

      const created = await storage.createRoomLockAssignmentsBulk(validAssignments);
      res.status(201).json({ created: created.length, assignments: created });
    } catch (error: any) {
      console.error("Error bulk creating room lock assignments:", error);
      if (error.message?.includes("unique constraint")) {
        return res.status(400).json({ error: "Some assignments already exist" });
      }
      if (error.message?.includes("Room lock") && error.message?.includes("already assigned")) {
        return res.status(400).json({ error: error.message });
      }
      res.status(400).json({ error: "Failed to create room lock assignments" });
    }
  });

  // Bulk delete room lock assignments
  app.post("/api/room-lock-assignments/bulk-delete", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const { ids, force } = req.body;

      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: "ids array is required" });
      }

      // Removing an assignment silently stops codes from being pushed to that
      // door AND blinds both the repair job and the door-code audit for it.
      // A >20 batch is almost always a UI mistake — require explicit force.
      if (ids.length > 20 && force !== true) {
        return res.status(409).json({
          error: `Bulk-deleting ${ids.length} room-lock assignments blocks code pushes to those doors. If intentional, repeat with "force": true.`,
        });
      }
      await storage.createLog({
        level: "warn",
        message: `Bulk-deleting ${ids.length} room-lock assignment(s)${force === true ? " (forced)" : ""}`,
        source: "System",
      });

      await storage.deleteRoomLockAssignmentsBulk(ids);
      res.status(200).json({ deleted: ids.length });
    } catch (error) {
      console.error("Error bulk deleting room lock assignments:", error);
      res.status(500).json({ error: "Failed to delete room lock assignments" });
    }
  });

  // Debug endpoint to show what MEWS poller fetches (same logic as poller)
  app.get("/api/debug/mews-poller-preview", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const mewsEnvironment = await storage.getSetting("mews_environment");
      const mewsClientToken = await storage.getSetting("mews_client_token");
      const mewsAccessToken = await storage.getSetting("mews_access_token");
      const daysAheadSetting = await storage.getSetting("reservation_list_days_ahead");

      if (!mewsClientToken || !mewsAccessToken) {
        return res.status(500).json({ error: "MEWS credentials not configured" });
      }

      const daysAhead = daysAheadSetting?.value ? parseInt(daysAheadSetting.value, 10) : 1;
      const mewsClient = new MewsClient(
        mewsClientToken.value,
        mewsAccessToken.value,
        (mewsEnvironment?.value as "demo" | "production") || "demo"
      );

      const mewsData = await mewsClient.getActiveReservations(daysAhead);

      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const endDate = new Date(startOfToday);
      endDate.setDate(startOfToday.getDate() + daysAhead + 1);

      res.json({
        settings: {
          daysAhead,
          environment: mewsEnvironment?.value || "demo",
          dateRange: {
            from: startOfToday.toISOString(),
            to: endDate.toISOString()
          },
          filter: {
            timeFilter: "Start (arrival date)",
            states: ["Confirmed", "Started"]
          }
        },
        totalReservations: mewsData.Reservations?.length || 0,
        reservations: (mewsData.Reservations || []).map(r => ({
          id: r.Id,
          number: r.Number,
          state: r.State,
          arrival: r.StartUtc,
          departure: r.EndUtc,
          resourceId: r.AssignedResourceId
        }))
      });
    } catch (error) {
      console.error("Error fetching MEWS poller preview:", error);
      res.status(500).json({ error: "Failed to fetch MEWS data" });
    }
  });
}
