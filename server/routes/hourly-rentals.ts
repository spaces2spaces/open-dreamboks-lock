import type { Express, Request } from "express";
import type { RouteContext } from "./index";
import { verifyHotelToken, webhookLimiter } from "./middleware";
import rateLimit from "express-rate-limit";
import { Storage, db, type ITenantStorage } from "../storage";
import { tenants as tenantsTable } from "@shared/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { HourlyRentalService } from "../hourly-rental-service";
import { getCachedDayAvailability, computePublicStartHours, applyStartNow } from "../hourly-public-availability";
import { createCheckoutSession, getCheckoutSession, verifyStripeSignature } from "../stripe-client";
import { getSpaceDisplayName } from "@shared/display-name";
import { createNotificationClient } from "../notification-client";
import { DateTime } from "luxon";

const availabilitySchema = z.object({
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
});

const createBookingSchema = z.object({
  guestName: z.string().min(1).max(120),
  guestEmail: z.string().email().optional().or(z.literal("")),
  guestPhone: z.string().max(30).optional().or(z.literal("")),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  roomId: z.string().optional(),
  amount: z.string().max(20).optional(),
  currency: z.string().max(8).optional(),
});

export function registerHourlyRentalRoutes(app: Express, ctx: RouteContext) {
  // Tenant comes from the AUTHENTICATED SESSION (not the spoofable
  // x-tenant-id header), and the feature is opt-in per tenant via the
  // hourly_rentals_enabled setting — other hotels get 403, not an empty UI.
  const resolve = async (req: Request): Promise<
    | { ok: true; storage: ITenantStorage; service: HourlyRentalService; tenantId: string }
    | { ok: false; status: number; error: string }
  > => {
    const session = await verifyHotelToken(req);
    if (!session) return { ok: false, status: 401, error: "Unauthorized" };
    const storage = Storage.forTenant(session.tenantId);
    let service: HourlyRentalService;
    try {
      service = new HourlyRentalService(storage, ctx.getAutomationEngine(session.tenantId));
    } catch (err: any) {
      return { ok: false, status: err?.status || 503, error: "Service temporarily unavailable" };
    }
    if (!(await service.isEnabled())) {
      return { ok: false, status: 403, error: "Timeudlejning er ikke aktiveret for dette hotel" };
    }
    return { ok: true, storage, service, tenantId: session.tenantId };
  };

  app.get("/api/hourly/bookings", async (req, res) => {
    const r = await resolve(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    try {
      res.json(await r.storage.getHourlyBookings(200));
    } catch (error) {
      console.error("Error fetching hourly bookings:", error);
      res.status(500).json({ error: "Failed to fetch hourly bookings" });
    }
  });

  // Day-level inventory overview: per capsule, which intervals are free for
  // hourly rentals on the given date (priority: overnight stays + purchased
  // early/late extensions own the capsule; hourly fills the gaps).
  app.get("/api/hourly/availability-overview", async (req, res) => {
    const r = await resolve(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    try {
      const date = String(req.query.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !DateTime.fromISO(date).isValid) {
        return res.status(400).json({ error: "date skal være YYYY-MM-DD" });
      }
      // Horizon: today through +7 days (user decision 21/7 — "indtil videre").
      const tz = (await r.storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
      const today = DateTime.now().setZone(tz).startOf("day");
      const chosen = DateTime.fromISO(date, { zone: tz }).startOf("day");
      if (chosen < today || chosen > today.plus({ days: 7 })) {
        return res.status(400).json({ error: "Dato skal være mellem i dag og 7 dage frem" });
      }
      res.json(await r.service.getDayOverview(date));
    } catch (error) {
      console.error("Error computing availability overview:", error);
      res.status(500).json({ error: "Kunne ikke beregne ledighed" });
    }
  });

  app.post("/api/hourly/availability", async (req, res) => {
    const r = await resolve(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    try {
      const { startAt, endAt } = availabilitySchema.parse(req.body);
      const start = new Date(startAt);
      const end = new Date(endAt);
      if (end.getTime() <= start.getTime()) {
        return res.status(400).json({ error: "Sluttid skal være efter starttid" });
      }
      const free = await r.service.findFreeRooms(start, end);
      res.json({ free: free.map(x => ({ id: x.id, name: x.name, label: x.label })), count: free.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: msg });
    }
  });

  app.post("/api/hourly/bookings", async (req, res) => {
    const r = await resolve(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    try {
      const input = createBookingSchema.parse(req.body);
      const { booking, warnings } = await r.service.createAndIssueBooking({
        guestName: input.guestName,
        guestEmail: input.guestEmail || undefined,
        guestPhone: input.guestPhone || undefined,
        startAt: new Date(input.startAt),
        endAt: new Date(input.endAt),
        roomId: input.roomId,
        amount: input.amount,
        currency: input.currency,
        paymentProvider: "manual",
      });
      res.status(201).json({ booking, warnings });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Error creating hourly booking:", error);
      res.status(400).json({ error: msg });
    }
  });

  // Pricing for the Create-booking dialog (per-hour rate + currency).
  app.get("/api/hourly/pricing", async (req, res) => {
    const r = await resolve(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const pricing = await r.service.getPricing();
    const mewsEnabled = (await r.storage.getSetting("hourly_mews_reservation_enabled"))?.value === "true";
    res.json({ perHour: pricing?.perHour ?? 75, currency: pricing?.currency ?? "DKK", mewsEnabled });
  });

  // ── Admin "Create booking" (phase 2, 21/7): payment via MEWS payment
  // request (QR in the dialog + link texted to the guest) OR skip-payment
  // (complimentary/cash → confirmed immediately). Both paths end in
  // confirmAndIssue/createAndIssueBooking, which also create the real MEWS
  // reservation (ensureMewsReservation) and fire the cleaning SMS.
  app.post("/api/hourly/bookings/with-payment", async (req, res) => {
    const r = await resolve(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    try {
      const input = createBookingSchema.extend({ skipPayment: z.boolean().optional() }).parse(req.body);
      const start = new Date(input.startAt);
      const end = new Date(input.endAt);
      const guestEmail = input.guestEmail || undefined;
      const guestPhone = input.guestPhone || undefined;

      const pricing = await r.service.getPricing();
      const perHour = pricing?.perHour ?? 75;
      const currency = input.currency || pricing?.currency || "DKK";
      const computed = r.service.computeAmount(start, end, perHour);
      const amount = input.amount ? parseFloat(input.amount) : computed.amount;
      if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ error: "Ugyldigt beløb" });
      }

      if (input.skipPayment) {
        const { booking, warnings } = await r.service.createAndIssueBooking({
          guestName: input.guestName,
          guestEmail,
          guestPhone,
          startAt: start,
          endAt: end,
          roomId: input.roomId,
          amount: String(amount),
          currency,
          paymentProvider: "manual",
        });
        return res.status(201).json({ mode: "confirmed", bookingId: booking.id, code: booking.pinCode, warnings });
      }

      if (!guestEmail && !guestPhone) {
        return res.status(400).json({ error: "Telefon eller email er påkrævet ved betaling (til betalingslink + kode)" });
      }
      const engine = ctx.getAutomationEngine(r.tenantId);
      const mewsClient = engine.getMewsClient?.();
      if (!mewsClient) return res.status(503).json({ error: "MEWS er ikke tilgængelig — brug 'uden betaling' eller prøv igen" });

      // Hold the slot, then create customer + payment request (public-flow pattern).
      const { booking, room } = await r.service.createHold({
        guestName: input.guestName,
        guestEmail,
        guestPhone,
        startAt: start,
        endAt: end,
        roomId: input.roomId,
        amount: String(amount),
        currency,
      });

      const hotelName = (await r.storage.getSetting("hotel_name"))?.value || "Hotel";
      const tz = (await r.storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
      const fmt = (d: Date) => DateTime.fromJSDate(d).setZone(tz).toFormat("d LLL HH:mm");
      const productName = `${hotelName} — Capsule ${getSpaceDisplayName(room.name, room.label)} (${computed.hours}h, ${fmt(start)}–${fmt(end)})`;

      let paymentUrl: string;
      try {
        const nameParts = input.guestName.trim().split(/\s+/);
        const customer = await mewsClient.addCustomer({
          firstName: nameParts.length > 1 ? nameParts[0] : undefined,
          lastName: nameParts.length > 1 ? nameParts.slice(1).join(" ") : nameParts[0],
          email: guestEmail,
          phone: guestPhone,
        });
        const paymentRequest = await mewsClient.createPaymentRequest(
          customer.Id,
          amount,
          currency,
          undefined,
          productName,
          new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          true, // MEWS emails the payment link when the customer has an email
        );
        await r.storage.updateHourlyBooking(booking.id, {
          paymentProvider: "mews",
          paymentRef: paymentRequest.Id,
          mewsCustomerId: customer.Id,
        });
        paymentUrl = mewsClient.getPaymentRequestUrl(paymentRequest.Id);
      } catch (paymentError) {
        await r.storage.updateHourlyBooking(booking.id, { status: "cancelled" });
        throw paymentError;
      }

      // Also text the link — MEWS only emails, and many hourly guests give a
      // phone number only. Best-effort: the QR in the dialog is the primary path.
      if (guestPhone) {
        try {
          const notif = await createNotificationClient(r.storage);
          await notif.sendPlainSMS({
            to: guestPhone,
            body: `${hotelName}: betal din time-booking (${computed.hours}t, ${fmt(start)}–${fmt(end)}, ${amount} ${currency}) her: ${paymentUrl} — koden sendes automatisk efter betaling.`,
          });
        } catch (smsError) {
          console.error("Payment-link SMS failed:", smsError);
        }
      }

      res.status(201).json({ mode: "pending_payment", bookingId: booking.id, paymentUrl, amount, currency });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Error creating hourly booking with payment:", error);
      res.status(400).json({ error: msg });
    }
  });

  // Admin status poll for the dialog — mirrors the public confirmation poll;
  // the 5-min sweep is the safety net if the admin closes the dialog.
  app.get("/api/hourly/bookings/:id/status", async (req, res) => {
    const r = await resolve(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    try {
      let booking = await r.storage.getHourlyBooking(req.params.id);
      if (!booking) return res.status(404).json({ error: "Booking ikke fundet" });

      let warnings: string[] = [];
      if (booking.status === "pending_payment" && booking.paymentProvider === "mews" && booking.paymentRef) {
        const engine = ctx.getAutomationEngine(r.tenantId);
        const mewsClient = engine.getMewsClient?.();
        if (mewsClient) {
          try {
            const [pr] = await mewsClient.getPaymentRequestsByIds([booking.paymentRef]);
            if (pr?.State === "Completed") {
              const confirmed = await r.service.confirmAndIssue(booking.id, { provider: "mews", ref: pr.Id });
              booking = confirmed.booking;
              warnings = confirmed.warnings;
            } else if (pr?.State === "Canceled" || pr?.State === "Expired") {
              booking = (await r.storage.updateHourlyBooking(booking.id, { status: "cancelled" })) || booking;
            }
          } catch (pollError) {
            console.error("Admin payment poll failed:", pollError);
          }
        }
      }

      res.json({
        status: booking.status,
        code: booking.status === "confirmed" ? booking.pinCode : null,
        mewsReservationId: booking.mewsReservationId,
        warnings,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: msg });
    }
  });

  app.post("/api/hourly/bookings/:id/cancel", async (req, res) => {
    const r = await resolve(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    try {
      res.json(await r.service.cancelBooking(req.params.id));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: msg });
    }
  });

  // ════════════════════════ PUBLIC (guest self-service) ════════════════════

  // Dedicated limiter: the confirmation page polls booking status, and the
  // SHARED publicLimiter also guards /api/public/unlock — hourly polling must
  // never 429 another guest's door-unlock from the same (hotel-WiFi NAT) IP.
  const hourlyPublicLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please try again later." },
  });

  // Resolve a tenant by its public hotel_slug setting (same contract as
  // public-api.ts's getPublicTenantStorage, but slug-required — no fallback
  // to a default tenant for the hourly flow).
  const resolvePublicTenant = async (rawSlug: unknown): Promise<{ tenantId: string; storage: ITenantStorage } | null> => {
    const slug = typeof rawSlug === "string" ? rawSlug.trim().toLowerCase() : "";
    if (!slug) return null;
    const activeTenants = await db.select().from(tenantsTable).where(eq(tenantsTable.active, true));
    for (const tenant of activeTenants) {
      const ts = Storage.forTenant(tenant.id);
      const slugSetting = await ts.getSetting("hotel_slug");
      if (slugSetting?.value?.trim().toLowerCase() === slug) {
        return { tenantId: tenant.id, storage: ts };
      }
    }
    return null;
  };

  const resolvePublic = async (rawSlug: unknown): Promise<
    | { ok: true; tenantId: string; storage: ITenantStorage; service: HourlyRentalService; engine: ReturnType<RouteContext["getAutomationEngine"]> }
    | { ok: false; status: number; error: string }
  > => {
    const t = await resolvePublicTenant(rawSlug);
    if (!t) return { ok: false, status: 404, error: "Unknown hotel" };
    let service: HourlyRentalService;
    let engine: ReturnType<RouteContext["getAutomationEngine"]>;
    try {
      engine = ctx.getAutomationEngine(t.tenantId);
      service = new HourlyRentalService(t.storage, engine);
    } catch (err: any) {
      return { ok: false, status: err?.status || 503, error: "Service temporarily unavailable" };
    }
    if (!(await service.isEnabled())) return { ok: false, status: 404, error: "Hourly booking is not available at this hotel" };
    return { ok: true, tenantId: t.tenantId, storage: t.storage, service, engine };
  };

  // Payment provider per tenant: "mews" (default — payment requests via the
  // MEWS API the hotel already uses; money settles with the hotel's normal
  // MEWS Payments) or "stripe" (hosted Checkout; needs stripe_secret_key).
  const paymentProviderOf = async (storage: ITenantStorage): Promise<string> =>
    (await storage.getSetting("hourly_payment_provider"))?.value || "mews";

  const publicInfoSchema = z.object({ hotelSlug: z.string().min(1) });

  const publicAvailabilitySchema = z.object({
    hotelSlug: z.string().min(1),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
  });

  const publicSlotsSchema = z.object({
    hotelSlug: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  });

  // Real bookable start hours for a date (owner request 23/7: guests picked
  // times blind). Aggregated across capsules — no room ids, labels,
  // housekeeping states or per-bed occupancy timelines leak; the page only
  // learns "from this hour, up to N contiguous hours are bookable".
  app.post("/api/public/hourly/slots", hourlyPublicLimiter, async (req, res) => {
    try {
      const { hotelSlug, date } = publicSlotsSchema.parse(req.body);
      const r = await resolvePublic(hotelSlug);
      if (!r.ok) return res.status(r.status).json({ error: r.error });

      const tz = (await r.storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
      const today = DateTime.now().setZone(tz).startOf("day");
      const wanted = DateTime.fromISO(date, { zone: tz }).startOf("day");
      if (!wanted.isValid || wanted < today || wanted > today.plus({ days: 7 })) {
        return res.status(400).json({ error: "Date must be within the next 7 days" });
      }

      const mews = r.engine.getMewsClient?.() ?? null;
      // Two consecutive days so a late start still offers its full run
      // across midnight; both cached 30s per tenant+date.
      const [dayA, dayB] = await Promise.all([
        getCachedDayAvailability(r.tenantId, r.storage, mews, date),
        getCachedDayAvailability(r.tenantId, r.storage, mews, wanted.plus({ days: 1 }).toISODate()!),
      ]);

      const sellable = await r.service.getSellableRooms();
      const sellableIds = new Set(sellable.map(rm => rm.id));
      const maxHours = parseInt((await r.storage.getSetting("hourly_max_hours"))?.value || "24", 10) || 24;
      // Walk-in fix (29/7): admit the CURRENT hour's slot (floor of now), then
      // rewrite it to start at the actual instant — a guest at 07:42 books
      // from 07:42, not 08:00. The 30-min validateWindow grace previously
      // dropped the current hour after :30.
      const startHours = applyStartNow(
        computePublicStartHours(dayA, dayB, {
          rowAllowed: (row) => row.roomIds.some(id => sellableIds.has(id)),
          notBeforeMs: DateTime.now().setZone(tz).startOf("hour").toMillis(),
          maxHoursCap: maxHours,
        }),
        Date.now(),
      );
      const pricing = await r.service.getPricing();
      res.json({
        date,
        timezone: tz,
        maxHours,
        pricePerHour: pricing?.perHour ?? null,
        currency: pricing?.currency ?? null,
        startHours,
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Owner decision 24/7: BOTH email and phone are required — the door code
  // goes out on both channels (mail + SMS).
  const publicBookSchema = z.object({
    hotelSlug: z.string().min(1),
    guestName: z.string().min(2).max(120),
    guestEmail: z.string().email(),
    guestPhone: z.string().min(6).max(30),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
  });

  // Hotel + pricing info for the public booking page
  app.post("/api/public/hourly/info", hourlyPublicLimiter, async (req, res) => {
    try {
      const { hotelSlug } = publicInfoSchema.parse(req.body);
      const r = await resolvePublic(hotelSlug);
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      const [pricing, products, hotelName, tz, maxHoursSetting] = await Promise.all([
        r.service.getPricing(),
        r.service.getProducts(),
        r.storage.getSetting("hotel_name"),
        r.storage.getSetting("property_timezone"),
        r.storage.getSetting("hourly_max_hours"),
      ]);
      const provider = await paymentProviderOf(r.storage);
      const paymentConfigured = !!pricing && (
        provider === "mews"
          ? !!r.engine.getMewsClient?.()
          : !!(await r.storage.getSetting("stripe_secret_key"))?.value
      );
      // EUR display rate (owner request 24/7 — prices show "399 DKK (≈ €54)"
      // like the early/late check-in flows). Own setting with fallback to the
      // late-checkout rate so one configured rate covers all guest flows.
      const eurRate = parseFloat(
        (await r.storage.getSetting("hourly_eur_rate"))?.value ||
        (await r.storage.getSetting("late_checkout_eur_rate"))?.value ||
        "7.45",
      ) || 7.45;
      res.json({
        hotelName: hotelName?.value || "the hotel",
        timezone: tz?.value || "Europe/Copenhagen",
        maxHours: parseInt(maxHoursSetting?.value || "24", 10) || 24,
        pricePerHour: pricing?.perHour ?? null,
        currency: pricing?.currency ?? null,
        eurRate,
        // Fixed-price packages (guest flow sells ONLY these when present).
        products,
        paymentConfigured,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: msg });
    }
  });

  // Free-capsule count for a window (counts only — no room details leak)
  app.post("/api/public/hourly/availability", hourlyPublicLimiter, async (req, res) => {
    try {
      const { hotelSlug, startAt, endAt } = publicAvailabilitySchema.parse(req.body);
      const r = await resolvePublic(hotelSlug);
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      const start = new Date(startAt);
      const end = new Date(endAt);
      if (end.getTime() <= start.getTime()) return res.status(400).json({ error: "End time must be after start time" });
      // Same filters booking uses (sellable set + hourly + MEWS occupancy) —
      // the old pool-only check could say "available" for windows booking
      // would then reject on a MEWS reservation.
      const count = await r.service.countBookableRooms(start, end);
      const pricing = await r.service.getPricing();
      // Product-aware price (packages win; mismatching duration → no price
      // shown rather than a misleading per-hour figure).
      let amount: { amount: number; hours: number } | null = null;
      if (pricing) {
        try {
          amount = r.service.resolvePublicPrice(await r.service.getProducts(), start, end, pricing.perHour);
        } catch { amount = null; }
      }
      res.json({
        count,
        price: amount ? { total: amount.amount, hours: amount.hours, perHour: pricing!.perHour, currency: pricing!.currency } : null,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: msg });
    }
  });

  // Create a pending hold + Stripe Checkout session → guest pays on Stripe
  app.post("/api/public/hourly/book", hourlyPublicLimiter, async (req, res) => {
    try {
      const input = publicBookSchema.parse(req.body);
      const guestEmail = input.guestEmail.trim();
      const guestPhone = input.guestPhone.trim();
      if (!guestEmail || !guestPhone) {
        return res.status(400).json({ error: "Provide both your email and mobile number — the door code is sent to both" });
      }
      const r = await resolvePublic(input.hotelSlug);
      if (!r.ok) return res.status(r.status).json({ error: r.error });

      const pricing = await r.service.getPricing();
      const provider = await paymentProviderOf(r.storage);
      const stripeKey = (await r.storage.getSetting("stripe_secret_key"))?.value;
      const mewsClient = r.engine.getMewsClient?.();
      const configured = !!pricing && (provider === "mews" ? !!mewsClient : !!stripeKey);
      if (!configured) {
        return res.status(503).json({ error: "Online payment is not configured yet — please contact the hotel" });
      }

      // Hold-spam guard: pending holds block real inventory for up to ~35 min,
      // so cap open holds per contact — 3 unpaid bookings in flight is plenty.
      const recent = await r.storage.getHourlyBookings(100);
      const openHolds = recent.filter(b =>
        b.status === "pending_payment" &&
        ((guestEmail && b.guestEmail === guestEmail) || (guestPhone && b.guestPhone === guestPhone)),
      );
      if (openHolds.length >= 3) {
        return res.status(429).json({ error: "You already have unpaid bookings in progress — complete or wait for them to expire" });
      }

      const start = new Date(input.startAt);
      let end = new Date(input.endAt);
      // Walk-in end-rounding (29/7 owner decision): a mid-hour "Now" start
      // keeps the FULL package and the END rounds UP to the next whole hour
      // (12:47 + 3h → 16:00) — walk-ins never wait, the guest gets the bonus
      // minutes, and the calendar stays on hour boundaries. Server-side so
      // stale client bundles are covered too.
      if (end.getUTCMinutes() !== 0 || end.getUTCSeconds() !== 0 || end.getUTCMilliseconds() !== 0) {
        end = new Date(Math.ceil(end.getTime() / 3_600_000) * 3_600_000);
      }
      // SERVER-side price: fixed packages (3h/6h etc.) when configured — the
      // duration must then match a package (plus up to 59 walk-in bonus
      // minutes); the client never sends a price.
      const products = await r.service.getProducts();
      const { amount, hours } = r.service.resolvePublicPrice(products, start, end, pricing.perHour);

      // Reserve the slot first (pending hold; auto-released if unpaid)
      const { booking, room } = await r.service.createHold({
        guestName: input.guestName,
        guestEmail,
        guestPhone,
        startAt: start,
        endAt: end,
        amount: String(amount),
        currency: pricing.currency,
      });

      // Base URL: app_base_url setting (public deployments) → request origin
      const baseUrlSetting = await r.storage.getSetting("app_base_url");
      const origin = `${req.headers["x-forwarded-proto"] || req.protocol || "https"}://${req.headers["x-forwarded-host"] || req.headers.host}`;
      const baseUrl = (baseUrlSetting?.value || origin).replace(/\/$/, "");
      const pageUrl = `${baseUrl}/${encodeURIComponent(input.hotelSlug)}/hourly`;

      const hotelName = (await r.storage.getSetting("hotel_name"))?.value || "Hotel";
      const tz = (await r.storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
      const fmt = (d: Date) => DateTime.fromJSDate(d).setZone(tz).toFormat("d LLL HH:mm");
      const productName = `${hotelName} — Capsule ${getSpaceDisplayName(room.name, room.label)} (${hours}h, ${fmt(start)}–${fmt(end)})`;

      let checkoutUrl: string | null;
      try {
        if (provider === "mews") {
          // MEWS payment request: money settles through the hotel's normal
          // MEWS Payments. Hourly guests aren't MEWS customers, so create a
          // minimal profile first (required AccountId for the request).
          const nameParts = input.guestName.trim().split(/\s+/);
          const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : nameParts[0];
          const firstName = nameParts.length > 1 ? nameParts[0] : undefined;
          const customer = await mewsClient!.addCustomer({
            firstName,
            lastName,
            email: guestEmail,
            phone: guestPhone,
          });
          const paymentRequest = await mewsClient!.createPaymentRequest(
            customer.Id,
            amount,
            pricing.currency,
            undefined, // no reservation — hourly bookings live outside MEWS
            productName,
            new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            true, // MEWS also emails the payment link (belt & braces)
          );
          await r.storage.updateHourlyBooking(booking.id, {
            paymentProvider: "mews",
            paymentRef: paymentRequest.Id,
          });
          checkoutUrl = mewsClient!.getPaymentRequestUrl(paymentRequest.Id);
        } else {
          const session = await createCheckoutSession(stripeKey!, {
            amountMinor: Math.round(amount * 100),
            currency: pricing.currency,
            productName,
            successUrl: `${pageUrl}?booking=${booking.id}&paid=1`,
            cancelUrl: `${pageUrl}?cancelled=1`,
            customerEmail: guestEmail,
            metadata: { bookingId: booking.id, tenantId: r.tenantId },
            expiresInMinutes: 30,
          });
          await r.storage.updateHourlyBooking(booking.id, {
            paymentProvider: "stripe",
            paymentRef: session.id,
          });
          checkoutUrl = session.url;
        }
      } catch (paymentError) {
        // Release the hold if the payment provider refused — don't strand the slot.
        await r.storage.updateHourlyBooking(booking.id, { status: "cancelled" });
        throw paymentError;
      }

      // MEWS has no success-redirect on its payment page, so hand the client
      // the confirmation URL too — it opens payment in a new tab and shows
      // the "waiting for payment" screen that polls until Completed.
      res.status(201).json({
        bookingId: booking.id,
        checkoutUrl,
        confirmationUrl: `${pageUrl}?booking=${booking.id}`,
        provider,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Error creating public hourly booking:", error);
      res.status(400).json({ error: msg });
    }
  });

  // Booking status for the confirmation page. Includes a Stripe poll-fallback
  // so payment completes the booking even if the webhook isn't configured yet.
  app.get("/api/public/hourly/booking/:id", hourlyPublicLimiter, async (req, res) => {
    try {
      const r = await resolvePublic(req.query.hotel);
      if (!r.ok) return res.status(r.status).json({ error: r.error });

      let booking = await r.storage.getHourlyBooking(req.params.id);
      if (!booking) return res.status(404).json({ error: "Booking not found" });

      // Poll fallback: the confirmation page polls this endpoint until the
      // payment lands. MEWS has no webhook to us, so this IS the primary
      // confirmation path for provider=mews; for Stripe it backs up the webhook.
      if (booking.status === "pending_payment" && booking.paymentRef) {
        try {
          if (booking.paymentProvider === "mews") {
            const mewsClient = r.engine.getMewsClient?.();
            if (mewsClient) {
              const [pr] = await mewsClient.getPaymentRequestsByIds([booking.paymentRef]);
              if (pr?.State === "Completed") {
                const { booking: confirmed } = await r.service.confirmAndIssue(booking.id, { provider: "mews", ref: pr.Id });
                booking = confirmed;
              } else if (pr?.State === "Canceled" || pr?.State === "Expired") {
                booking = (await r.storage.updateHourlyBooking(booking.id, { status: "cancelled" })) || booking;
              }
            }
          } else {
            const stripeKey = (await r.storage.getSetting("stripe_secret_key"))?.value;
            if (stripeKey) {
              const session = await getCheckoutSession(stripeKey, booking.paymentRef);
              if (session.payment_status === "paid") {
                const { booking: confirmed } = await r.service.confirmAndIssue(booking.id, { provider: "stripe", ref: session.id });
                booking = confirmed;
              }
            }
          }
        } catch (pollError) {
          console.error("Payment poll fallback failed:", pollError);
        }
      }

      const room = await r.storage.getRoom(booking.roomId);
      res.json({
        status: booking.status,
        // The booking id is an unguessable UUID handed to the payer — showing
        // the code here mirrors the SMS/email the guest just received.
        code: booking.status === "confirmed" ? booking.pinCode : null,
        capsule: room ? getSpaceDisplayName(room.name, room.label) : null,
        startAt: booking.startAt,
        endAt: booking.endAt,
        codeDelivered: !!booking.codeDeliveredAt,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: msg });
    }
  });

  // Stripe webhook — tenant resolved from event metadata, then the signature
  // is verified with THAT tenant's stripe_webhook_secret (a forged tenantId
  // simply fails verification against the real tenant's secret).
  app.post("/api/public/hourly/stripe-webhook", webhookLimiter, async (req, res) => {
    try {
      const event = req.body;
      const session = event?.data?.object;
      const bookingId = session?.metadata?.bookingId;
      const tenantId = session?.metadata?.tenantId;
      // Events that aren't ours (other products on the same Stripe account,
      // operator subscribed to extra event types): ACK with 200 — a 4xx makes
      // Stripe mark the endpoint failing and eventually disable it.
      if (!event?.type || !bookingId || !tenantId) {
        return res.status(200).json({ received: true, ignored: true });
      }

      const storage = Storage.forTenant(tenantId);
      const webhookSecret = (await storage.getSetting("stripe_webhook_secret"))?.value;
      if (!webhookSecret) {
        // Not configured → the poll fallback owns confirmation. 200 so Stripe
        // doesn't retry forever against an intentionally unused endpoint.
        return res.status(200).json({ received: true, note: "webhook secret not configured" });
      }
      const rawBody = (req as any).rawBody;
      if (!rawBody || !verifyStripeSignature(rawBody, req.headers["stripe-signature"] as string | undefined, webhookSecret)) {
        return res.status(401).json({ error: "Invalid signature" });
      }

      const isPaidEvent =
        (event.type === "checkout.session.completed" && session.payment_status === "paid") ||
        event.type === "checkout.session.async_payment_succeeded";

      if (isPaidEvent) {
        let service: HourlyRentalService;
        try {
          service = new HourlyRentalService(storage, ctx.getAutomationEngine(tenantId));
        } catch {
          // Engine not ready — let Stripe retry the delivery later.
          return res.status(503).json({ error: "Not ready" });
        }
        try {
          await service.confirmAndIssue(bookingId, { provider: "stripe", ref: session.id });
        } catch (issueError) {
          // Refund cases (cancelled booking / expired window / slot re-taken)
          // are logged REFUND REQUIRED by the service — ACK so Stripe doesn't
          // retry a permanently unfulfillable event for days.
          const msg = issueError instanceof Error ? issueError.message : String(issueError);
          if (msg.includes("refunderes")) {
            return res.status(200).json({ received: true, refundRequired: true });
          }
          throw issueError;
        }
      } else if (event.type === "checkout.session.completed" && session.payment_status !== "paid") {
        // Delayed payment method (bank transfer etc.) — funds not settled yet.
        // Wait for async_payment_succeeded; never issue a code on unpaid money.
        return res.status(200).json({ received: true, awaitingPayment: true });
      } else if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
        const booking = await storage.getHourlyBooking(bookingId);
        if (booking?.status === "pending_payment") {
          await storage.updateHourlyBooking(bookingId, { status: "cancelled" });
        }
      }

      res.json({ received: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Stripe webhook error:", error);
      res.status(500).json({ error: msg });
    }
  });
}
