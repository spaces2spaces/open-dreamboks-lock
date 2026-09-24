import type { Express } from "express";
import type { RouteContext } from "./index";
import { getTenantStorage, getTenantStorageAsync, resolveTenantId, verifyHotelToken } from "./middleware";
import { insertReservationSchema, insertPinSchema } from "@shared/schema";

export function registerReservationRoutes(app: Express, ctx: RouteContext) {
  // Reservations
  app.get("/api/reservations", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const { filter } = req.query;

      let reservations: any[];
      if (filter === 'upcoming') {
        reservations = await storage.getActiveReservationsWithPins();
      } else if (filter === 'active') {
        reservations = await storage.getVisibleReservationsForTTLock();
      } else if (filter === 'checkin') {
        reservations = await storage.getReservationsForCheckinList();
      } else {
        reservations = await storage.getMappedReservations();
      }

      // Enrich reservations with pin status — bulk fetch rooms + ONLY the
      // fetched reservations' pins (perf 23/7: getAllPins moved 2400+ rows of
      // keyId jsonb across the wire per page load).
      const [pins, allRooms] = await Promise.all([
        storage.getPinsByReservationIds(reservations.map(r => r.id)),
        storage.getAllRooms(),
      ]);

      // Group pins by reservation, prefer most recent guest pin
      const pinsByReservation = new Map<string, typeof pins[0]>();
      for (const pin of pins) {
        if (pin.reservationId) {
          const existing = pinsByReservation.get(pin.reservationId);
          // Keep the most recently created pin, preferring guest type
          if (!existing ||
              (pin.type === 'guest' && existing.type !== 'guest') ||
              (pin.type === existing.type && new Date(pin.createdAt) > new Date(existing.createdAt))) {
            pinsByReservation.set(pin.reservationId, pin);
          }
        }
      }

      // Build room label lookup from bulk-fetched rooms (no N+1)
      const roomLabelMap = new Map<string, string | null>(
        allRooms.map(r => [r.id, r.label || null])
      );

      const enrichedReservations = reservations.map(res => {
        const pin = pinsByReservation.get(res.id);
        return {
          ...res,
          pinStatus: pin?.status || null,
          pinFirstUsedAt: pin?.firstUsedAt || null,
          roomLabel: res.roomId ? (roomLabelMap.get(res.roomId) || null) : null,
        };
      });

      res.json(enrichedReservations);
    } catch (error) {
      console.error("Error fetching reservations:", error);
      res.status(500).json({ error: "Failed to fetch reservations" });
    }
  });

  app.get("/api/reservations/:id", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const reservation = await storage.getReservation(req.params.id);
      if (!reservation) {
        return res.status(404).json({ error: "Reservation not found" });
      }
      res.json(reservation);
    } catch (error) {
      console.error("Error fetching reservation:", error);
      res.status(500).json({ error: "Failed to fetch reservation" });
    }
  });

  app.post("/api/reservations", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const validated = insertReservationSchema.parse(req.body);
      const reservation = await storage.createReservation(validated);
      res.status(201).json(reservation);
    } catch (error) {
      console.error("Error creating reservation:", error);
      res.status(400).json({ error: "Failed to create reservation" });
    }
  });

  app.put("/api/reservations/:id", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const validated = insertReservationSchema.partial().parse(req.body);
      const reservation = await storage.updateReservation(req.params.id, validated);
      if (!reservation) {
        return res.status(404).json({ error: "Reservation not found" });
      }
      res.json(reservation);
    } catch (error) {
      console.error("Error updating reservation:", error);
      res.status(400).json({ error: "Failed to update reservation" });
    }
  });

  app.delete("/api/reservations/:id", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const reservation = await storage.getReservation(req.params.id);
      if (!reservation) {
        return res.status(404).json({ error: "Reservation not found" });
      }
      // Revoke the guest's codes from the PHYSICAL locks first (same pattern as
      // DELETE /api/pins/:id). deleteReservation hard-deletes the pin rows, so
      // skipping this leaves orphaned codes that still open the doors with no
      // DB record pointing at them.
      try {
        await ctx.getAutomationEngine(resolveTenantId(req)).getPinLifecycle().onCancelled(reservation, { force: true });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await storage.createLog({
          level: "error",
          message: `Failed to revoke TTLock codes before reservation delete: ${errorMessage} — codes may remain on locks`,
          source: "automation",
          reservationId: reservation.id,
        });
      }
      // Partial revoke (delete_failed) must BLOCK the hard delete: dropping the
      // rows now would erase the retry bookkeeping while the code still sits on
      // some lock — an untracked working code on a door.
      const remainingPins = await storage.getPinsByReservationId(reservation.id);
      const stuck = remainingPins.filter(p => p.status === "delete_failed");
      if (stuck.length > 0) {
        await storage.createLog({
          level: "error",
          message: `Reservation delete blocked: ${stuck.length} pin(s) could not be revoked from TTLock (delete_failed) — retry once locks are reachable`,
          source: "automation",
          reservationId: reservation.id,
        });
        return res.status(409).json({
          error: `Could not remove ${stuck.length} code(s) from the physical locks (offline?). The reservation was NOT deleted — try again once the locks are reachable.`,
        });
      }
      await storage.deleteReservation(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting reservation:", error);
      res.status(500).json({ error: "Failed to delete reservation" });
    }
  });

  // Pins
  app.get("/api/pins", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const pins = await storage.getAllPins();
      res.json(pins);
    } catch (error) {
      console.error("Error fetching pins:", error);
      res.status(500).json({ error: "Failed to fetch pins" });
    }
  });

  app.get("/api/pins/room/:roomId", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const pins = await storage.getPinsByRoomId(req.params.roomId);
      res.json(pins);
    } catch (error) {
      console.error("Error fetching pins:", error);
      res.status(500).json({ error: "Failed to fetch pins" });
    }
  });

  app.post("/api/pins", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const validated = insertPinSchema.parse(req.body);
      const pin = await storage.createPin(validated);
      res.status(201).json(pin);
    } catch (error) {
      console.error("Error creating pin:", error);
      res.status(400).json({ error: "Failed to create pin" });
    }
  });

  app.put("/api/pins/:id", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const validated = insertPinSchema.partial().parse(req.body);
      const pin = await storage.updatePin(req.params.id, validated);
      if (!pin) {
        return res.status(404).json({ error: "Pin not found" });
      }
      res.json(pin);
    } catch (error) {
      console.error("Error updating pin:", error);
      res.status(400).json({ error: "Failed to update pin" });
    }
  });

  app.delete("/api/pins/:id", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const pin = await storage.getPin(req.params.id);
      if (!pin) {
        return res.status(404).json({ error: "Pin not found" });
      }

      // Delete from TTLock via PinLifecycleService (handles all lock types via room_lock_assignments)
      if ((pin.status === "active" || pin.status === "used") && pin.reservationId) {
        try {
          const reservation = await storage.getReservation(pin.reservationId);
          if (reservation) {
            await ctx.getAutomationEngine(resolveTenantId(req)).getPinLifecycle().onCancelled(reservation, { force: true });
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          await storage.createLog({
            level: "error",
            message: `Failed to delete passcode from TTLock: ${errorMessage}`,
            source: "automation",
            roomId: pin.roomId,
            reservationId: pin.reservationId || undefined,
          });
        }
      }

      await storage.deletePin(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting pin:", error);
      res.status(500).json({ error: "Failed to delete pin" });
    }
  });

  app.put("/api/pins/:id/deactivate", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const pin = await storage.getPin(req.params.id);
      if (!pin) {
        return res.status(404).json({ error: "Pin not found" });
      }
      const updated = await storage.updatePin(req.params.id, { status: "inactive" });
      res.json(updated);
    } catch (error) {
      console.error("Error deactivating pin:", error);
      res.status(500).json({ error: "Failed to deactivate pin" });
    }
  });

  // Backfill PINs for old future reservations that were created before the
  // "generate PIN at booking" behavior existed. Iterates all future mapped
  // reservations that don't already have a pending/active PIN row and calls
  // onReservationCreated on each — which generates a PIN, creates the pending
  // row, and syncs it to MEWS. Fully idempotent.
  app.post("/api/reservations/backfill-pins", async (req, res) => {
    if (!await verifyHotelToken(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const storage = getTenantStorage(req);
      const pinLifecycle = ctx.getAutomationEngine(resolveTenantId(req)).getPinLifecycle();

      // All future mapped reservations (up to 1 year ahead, safety cap)
      const now = new Date();
      const oneYearAhead = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
      const futureReservations = await storage.getMappedReservationsByArrivalRange(now, oneYearAhead);

      const dryRun = req.query.dryRun === "true";

      const results = {
        total: futureReservations.length,
        eligible: 0,
        processed: 0,
        skipped: 0,
        failed: 0,
        errors: [] as string[],
      };

      for (const reservation of futureReservations) {
        // Skip cancelled / checked-out
        if (["Cancelled", "Canceled", "Checked-out", "CheckedOut"].includes(reservation.status)) {
          results.skipped++;
          continue;
        }

        // Skip if already has an active/pending pin row (onReservationCreated
        // would skip anyway, but this avoids unnecessary work + log noise)
        const existingPins = await storage.getPinsByReservationId(reservation.id);
        const hasLivePin = existingPins.some(p =>
          ["pending", "active", "used", "delete_failed"].includes(p.status)
        );
        if (hasLivePin) {
          results.skipped++;
          continue;
        }

        results.eligible++;

        if (dryRun) continue;

        try {
          // deferActivation: bulk loop inside an HTTP request must not
          // serialize physical lock writes (2.5s/lock queue) — the scheduler
          // pushes any already-open windows within ~60s.
          await pinLifecycle.onReservationCreated(reservation, { deferActivation: true });
          results.processed++;
        } catch (error) {
          results.failed++;
          const msg = error instanceof Error ? error.message : String(error);
          results.errors.push(`${reservation.pmsId} (${reservation.firstName} ${reservation.lastName}): ${msg}`);
        }
      }

      await storage.createLog({
        level: "info",
        source: "automation",
        message: dryRun
          ? `PIN backfill dry run: ${results.eligible} eligible of ${results.total}`
          : `PIN backfill: ${results.processed} processed, ${results.failed} failed, ${results.skipped} skipped of ${results.total}`,
        metadata: { dryRun, ...results, errors: results.errors.slice(0, 10) },
      });

      res.json({ success: true, dryRun, ...results, errors: results.errors.slice(0, 20) });
    } catch (error) {
      console.error("PIN backfill error:", error);
      res.status(500).json({ error: "Failed to backfill PINs" });
    }
  });
}
