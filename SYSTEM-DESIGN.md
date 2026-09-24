# DreamBoks Lock — System Design

> Architecture, the hard rules learned from real incidents, and the integration gotchas that will bite again if forgotten. Read this before changing anything in `server/`.
>
> Extracted from the internal multi-system design document; only the parts that concern this repository are kept.


## What it does
Multi-tenant SaaS for hotels (main tenants: **Copenhagen Downtown Hostel** and **Hotel Capsule Inn**, a fully unmanned capsule hotel). It:
1. Polls/receives reservations from **MEWS PMS** and mirrors them locally.
2. Generates and programs **PIN codes on TTLock smart locks** (room locks + common doors) with correct validity windows.
3. Sends guests their door code via SMS/WhatsApp/email, serves guest-facing pages (check-in, boarding pass/digital key, hourly booking, upsell extras, info kiosk).
4. Sells upsells: early check-in, late checkout, standalone hourly capsule rentals — billed via MEWS payment requests.
5. Checks guests in to MEWS automatically when they first use their PIN (TTLock webhook + poller safety net).

## Architecture — the load-bearing pieces
- **`server/pin-lifecycle-service.ts` — ALL PIN operations go through `PinLifecycleService`.** Never call TTLock for guest PINs from anywhere else.
- **`server/reservation-state-machine.ts`** — reservation transitions (created/changed/room-moved/cancelled/checked-in/out) drive PIN actions.
- **`server/pin-validity-window.ts`** — the shared, single source of validity-window calculation.
- **`server/mews-poller.ts` + `server/mews-client.ts` + `server/mews-adapter.ts`** — MEWS sync (fast poll for near-term, wider syncs chunked ≤96h, see gotchas).
- **`server/automation.ts`** — scheduled jobs (hourly audit+repair+snapshot, night-run guard, activation sweeps).
- **`server/ttlock-client.ts`** — TTLock API wrapper (one shared owner account for all tenants).
- **`server/storage.ts`** — all DB access; **settings live in the `settings` table per tenant and are cached in-memory with a 5-min TTL** (direct DB writes don't bust the cache — restart or wait).
- **`server/room-pairing.ts`** — twin capsule spaces: e.g. `"401s"` and `"401"` are the SAME physical bed (1- vs 2-person rate). 78 beds = 156 sellable spaces. All availability/sales logic must use pairing. Guest count = capsule type (`s` = 1, else 2), never `AdultCount`.
- Per-reservation **mutex** prevents concurrent PIN races; `isRoomMapped()` requires a **room-type** lock (common-area-only isn't enough).
- Guest-facing routes are scoped by the **`hotel_slug` setting** (NOT `tenants.slug`): `/<slug>/checkin`, `/<slug>/hourly`, `/<slug>/extras`, `/<slug>/info`, boarding pass links.

DB tables: `tenants, hotel_users, vendor_invitations, rooms, common_areas, reservations, pins, ekeys, logs (7-day retention), settings, lock_devices, reservation_logs, qr_codes, sessions, room_lock_assignments, hourly_bookings, early_checkins, marketing_sends, cancellation_audit`.

## Inviolable rules (learned from real incidents)
1. **Guest door codes are the point of truth.** NEVER fix a problem by changing/rotating a guest's code — always repair with the SAME digits. Guests already have the code on their phone.
2. **Capsule Inn is unmanned.** No fix, report, or alert may instruct manual TTLock-app action at the door — everything must be remote/automatic.
3. **PIN deletions are never given up.** Failed deletes go on a 30-min retry lane + alarm, never silently dropped.
4. **Never run the TTLock "Sync" delete-step casually** — a 2026-07-15 sync with an expired token wiped all of Downtown's `lock_devices` (CASCADE to assignments).
5. **`door_name` on locks is a guest-display override** (`doorName || name` on boarding buttons) — only real door names belong there.
6. **A room's own door may only serve that room's spaces.** Shared capsule-room doors are `common` locks named after the room ("411 Room", "509 Room"), so the "one room lock = one space" guard does not cover them. Re-mapping after the 15/7 wipe (rule 4) put "411 Room" on all 11 spaces of room 509 — every 509 guest's PIN opened room 411 until 18/8-2026 (found via a guest report). Enforced in code by `shared/room-scoped-locks.ts`, checked in both `createRoomLockAssignment` paths.

## Integration gotchas (will bite again if forgotten)
- **MEWS `reservations/getAll` rejects windows > 100h.** All wide syncs must chunk into ≤96h slices (a ~30-day window silently broke ALL sync for 13h once).
- **MEWS price overrides (`Amount`) MUST include `TaxCodes`** (setting `hourly_mews_tax_code`, default `DK-S`) or revenue books VAT-free.
- **MEWS `reservations/add` honors `AssignedResourceId` + `Locked`** (own category required) — hourly capsules are assigned at creation.
- **MEWS check-in returns 403 until the space is "Inspected"** (housekeeping) — lock-arrival check-in retries hourly.
- Revenue accounts: 1013 Hour Booking, 1014 Early Check-in, 1015 Late Checkout; hourly books on main service "Stay Night 15:00". `accountingCategories/products/rates getAll` are OUTSIDE our API scope.
- **TTLock error -3007** ("code exists") can be a phantom: `listKeyboardPwd` never lists the code but it WORKS on hardware. There is a `confirmedUnlisted` escape hatch — see commit c2d38d1.
- **TTLock error -3037** (lock busy): storms occur when pushing many codes at once; activation sweeps have an overlap guard (single-flight) — don't remove it.
- Twilio: Capsule has its own Messaging Service (branded sender "CapsuleInn"); WhatsApp uses the raw number. Phone numbers with `00`-prefix are normalized.
- SMS/email branding uses the **`hotel_name` setting** (not `boarding_brand_name`); boarding-card theme uses `boarding_*` settings per tenant.
- Capsule-only mode `door_code_message_only`: one combined "door code" SMS+email 23h before arrival (replaces pre-checkin + digital-key messages), re-sent on change.
  - **`door_code_sms_text` setting** (Settings → Guest Journey, 8/9-2026): optional per-tenant template for that SMS with `{capsule} {room} {code} {checkin_day} {checkin_time} {checkout_day} {checkout_time} {address} {name}` (renderer + GSM-7 counter in `shared/door-code-template.ts`). Capsule uses the owner's mall-wayfinding text (159 chars). Email = template + check-in/out lines. Not part of the re-send signature, so editing it never re-sends.
- Booking.com strips unique links from emails → digital-key email also contains the static `/<slug>/checkin` URL + PIN as plain text.
- **Kiosk "Find my door code" (`POST /api/public/kiosk-door-code`)**: one field, name OR booking number, today's arrivals only. Ranking in `server/kiosk-lookup-match.ts`: booking number (MEWS `Number`, OTA `ChannelNumber`, `ChannelManagerNumber` — stored as `reservations.channel_number` / `channel_manager_number` since 8/9-2026) > exact name (first or last, either order, diacritics folded) > typo-tolerant (1 edit for 4–7 letters, 2 for 8+). Several different guests → ask for booking number. Legacy `lastName` body field still accepted.
- **`pin_checkin_kiosk_qr` setting** (per tenant): `true` = `/<slug>/checkin` shows a QR after the door code (staffed reception iPad, Copenhagen Downtown); unset/false = jumps straight to the boarding card (unmanned, Capsule). The July 2026 "direct jump" change broke Downtown's reception until this setting existed (fixed 7/9-2026).
- A fixed screenshot-able TTLock QR is impossible (rotates every 10 min) — PIN + remote-unlock button are the access methods.

## Feature state (all LIVE as of 2026-08-14)
- Early check-in with tiered prices (10:00=119 / 12:00=79 / 14:00=49 DKK), guest picks start time; cleaning buffer = occupied capsule requires +60 min (setting `early_checkin_cleaning_buffer_minutes`) before earliest sellable start; MEWS StartUtc moved on purchase.
- Late checkout tiers (`late_checkout_price_tiers`: 12:00=49 / 13:00=79 / 14:00=119); campaign SMS 19:00 the evening before to TOMORROW's departures.
- Standalone hourly rentals outside MEWS: public `/<slug>/hourly` slot grid with midnight-stitching; all lock-mapped inventory sellable by default (kill switch `hourly_dynamic_inventory=false`); MEWS-block created per booking; grace-move: after a MEWS room move of an arrived hourly guest, codes stay on BOTH capsules until the guest uses the new one (blocks sales of both meanwhile). Staff guide at `/manual`.
- **House reserve + conflict watch (19/8-2026 oversell, capsule 604):** an UNASSIGNED MEWS reservation occupies a capsule without saying which — it is invisible to room-id matching, so the sale path sold the house's last capsule and MEWS then refused the block 12× with `403 "no availability"`. Now: (1) every unassigned arrival overlapping the window reserves one physical capsule in `allocate`/`countBookableRooms`/the public slot grid (kill switch `hourly_unassigned_reserve=false`; an admin naming a capsule is warned, not blocked), (2) MEWS' "no availability" is a **critical ops alert** + 30-min retry backoff, never a soft hiccup, (3) sweep step 4d re-tests confirmed bookings against MEWS occupancy (twin-aware) and moves the guest to a free capsule with the SAME code, or alerts critically when the house is full (kill switch `hourly_conflict_watch=false`).
- Marketing upsell module (`/marketing` admin, `/extras` guest page): SMS+email campaigns, funnel logging, daily 12:00 report (`upsell_report_email`), links open only their own offer (`?offer=ec|lc`).
- Lock-arrival → MEWS check-in via TTLock realtime webhook (seconds) + hourly poller safety net.
- Operational reporting: **all report emails are retired** — the live list is `/arrivals` (+ share link). Only the 01:00 checklist + ops alerts email (`lock_arrival_report_email`).
- Night-run guard + day-use checkout signal (latest commit `68eefdb`).

## Dev workflow
```
npm run dev        # local dev (tsx, .env)
npm run check      # tsc — must pass
npm test           # Vitest — must pass
npm run db:push    # drizzle-kit push — CAUTION: check drift first (see below)
```
- **db:push drift status (2026-08):** remaining drift is 5 harmless FK-constraint renames on `early_checkins`/`hourly_bookings`. `cancellation_audit` IS in `shared/schema.ts` (no DROP danger). Always review the plan before confirming a push against prod.
- DB pool: was silently capped at default 10 — pool sizing and the `logs` timestamp index matter for performance (login 4.9s→0.25s fix).

## Public guest endpoints — security model

All routes under `/api/public/*` are unauthenticated by design (guests have
no account). They are built to withstand a reader who has this source.

**Identifier grades** — `shared/guest-identifier.ts`. `isLinkGradeIdentifier()`
is true only for the reservation UUID. `buildBoardingPassUrl()` in
`shared/boarding-pass-url.ts` is the single builder for digital-key links and
always uses it; `notification-client.sendBoardingPassEmail` takes
`reservationId` for the link and keeps `reservationNumber` for display.
`storage.getReservationByNumberAndName()` accepts the UUID in addition to the
PMS number / confirmation code / PMS id.

**Guard** — `server/guest-access-guard.ts`, wired through `guardedByNumber()` /
`guardedWithLocks()` in `server/routes/public-api.ts`. Every number+name lookup
must go through one of them; a direct `storage.getReservation…(reservationNumber…)`
call in a public route is a bug. Lockout is per (tenant, identifier); alerts go
through `sendOpsAlert` with key `public-lookup-bruteforce` and a bucketed
message so the hourly dedupe holds. State is per process.

**Remote unlock** (`POST /api/public/unlock`): form-grade identifier ⇒ `pin`
must equal the reservation's active code (constant-time compare). Wrong or
missing code counts as a failure for that identifier.

**Kiosk** (`POST /api/public/kiosk-door-code`): setting `guest_info_token`
(constant-time compare against body `kioskToken`) — the tablet gets it via
`?k=` and keeps it in localStorage under `kioskToken:<slug>`. No token ⇒ the
older Host-header check against `guest_info_domain`. Misses count as probes.

**PIN check-in** (`POST /api/public/lookup-by-pin`): `pinLookupLimiter`
(30 / 15 min / IP); response is the minimal shape typed in
`client/src/pages/PinCheckinPage.tsx`. Misses count as probes.

**Deployment identity** — `server/config.ts`: `appBaseUrl`, `defaultHotelName`,
`guestEmailFallbackDomain` from env. No file under `server/` may name a
specific hotel or domain as a fallback; tests assert on `*.example.com`
values set in `vitest.config.ts`.
