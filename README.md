# Open DreamBoks Lock

Guest access automation for hotels and hostels: it turns a reservation in
**MEWS** into a personal door code on **TTLock** smart locks, sends the code to
the guest, and checks the guest in the moment they first use it.

Built by [spaces2spaces](https://spaces2spaces.com) to run
[Hotel Capsule Inn](https://www.hotelcapsuleinn.com) in Copenhagen — a fully
unstaffed 78-bed capsule hotel where the door code is the only way in — and
Copenhagen Downtown Hostel alongside a staffed reception. Published so that
anyone buying DreamBoks units, or anyone with TTLock locks and a MEWS
property, can run or adapt it.

## Status: published as-is, no support

This is the code we run in production, released as open source under Apache-2.0. There is
no roadmap, no support, and no promise to respond to issues or pull requests.
Fork it and make it yours.

## What it does

- Mirrors reservations from MEWS (poller + webhook) and reacts to creation,
  changes, room moves, cancellations, check-in and check-out.
- Generates one personal PIN per reservation and programmes it on the room
  lock and every common-area lock the guest is entitled to, with the correct
  validity window. **The code belongs to the guest, not the room:** a room
  move keeps the same digits; an extension lengthens the same code; a
  problem is never fixed by rotating a guest's code.
- Writes the code into the MEWS reservation as a note, so staff find it where
  they already work.
- Sends the code by SMS / WhatsApp (Twilio) and email (SendGrid), and serves
  guest pages: check-in kiosk, boarding pass / digital key, hourly rental,
  paid extras (early check-in, late checkout).
- Checks the guest in to MEWS when they first use the PIN (TTLock realtime
  webhook + hourly poller safety net).
- Reconciles every lock against what should be programmed on it every hour
  and repairs drift without changing any guest's digits.
- Multi-tenant: one deployment, several properties, settings per tenant.

Read [SYSTEM-DESIGN.md](SYSTEM-DESIGN.md) first — architecture, the
inviolable rules learned from real incidents, and the integration gotchas
that will bite again if forgotten.

## Stack

Node.js · Express · TypeScript · Drizzle ORM · PostgreSQL (Neon serverless
driver) · React · Vite · Vitest.

## Requirements

- Node.js 24 (see `.nvmrc`)
- A PostgreSQL database. The code uses `@neondatabase/serverless`, so a
  [Neon](https://neon.tech) database works out of the box; other Postgres
  hosts need the driver in `server/db.ts` swapped.
- A [TTLock open platform](https://open.ttlock.com) developer app
  (client id + secret) and a TTLock account that owns the locks. Locks must
  be reachable through TTLock gateways — every operation here is remote.
- MEWS Connector API access (client token + access token) for each property.
- Twilio (SMS / WhatsApp) and SendGrid (email) accounts.

## Quick start

```bash
cp .env.example .env      # fill in DATABASE_URL at minimum
npm install
npm run db:push           # creates the schema
npm run dev               # http://localhost:5000
```

Integration credentials (TTLock, MEWS, Twilio, SendGrid) live in the
`settings` table per tenant and are managed in the Settings UI. Values in
`.env` are only used to seed empty settings on first start — once a setting
exists in the database, the env var is ignored.

```bash
npm test                  # Vitest
npm run build && npm start
```

## Layout

| Path | What |
|---|---|
| `server/pin-lifecycle-service.ts` | every PIN operation goes through here |
| `server/reservation-state-machine.ts` | reservation transitions → PIN actions |
| `server/pin-validity-window.ts` | the single validity-window calculation |
| `server/ttlock-client.ts` | TTLock API wrapper |
| `server/mews-*.ts` | MEWS sync (client, adapter, poller) |
| `server/automation.ts` | scheduled jobs: audit, repair, activation sweeps |
| `server/storage.ts` | all database access |
| `shared/schema.ts` | Drizzle schema |
| `client/` | React admin + guest pages |
| `mews-adapter/` | optional standalone MEWS → ingestion-webhook adapter |

## Licence

Apache License 2.0 — see [LICENSE](LICENSE).
