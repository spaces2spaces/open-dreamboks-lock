# DreamBoks Architecture

## Overview

DreamBoks is a multi-tenant middleware platform that automates guest access management for hostels and hotels. It synchronizes booking data from Property Management Systems (PMS) with smart lock systems to generate and distribute access codes to guests automatically.

---

## System Components

### Simple Architecture (2 Apps)

DreamBoks uses a simple 2-app architecture optimized for maintainability.

| App | Replit Project | Users | Purpose |
|-----|----------------|-------|---------|
| **Hotel Dashboard** | `dreamboks-hotel-dashboard` | Hotel staff + Vendor | All backend + staff UI |
| **Guest Web** | `dreamboks-guest` | Guests | PIN lookup, boarding pass |

### What's in Hotel Dashboard

The Hotel Dashboard is a monolith containing:
- Frontend (React) for staff
- REST API for all operations
- MEWS polling (built-in)
- TTLock integration (built-in)
- Automation engine (built-in)
- Vendor admin panel (built-in)

```
Hotel Dashboard (one app)
├── Staff UI (reservations, rooms, settings)
├── Vendor UI (hotel management)
├── REST API
├── MEWS Poller
├── TTLock Client
└── Automation (PIN lifecycle)
```

### Why Simple?

| Consideration | Simple (2 apps) | Microservices (7+ apps) |
|---------------|-----------------|-------------------------|
| Maintenance | Easy | Complex |
| Debugging | One log | Multiple logs |
| Deployment | Fast | Coordinated |
| Best for | 1-50 hotels | 50+ hotels |

### When to Split

Consider extracting services when:
- You have 50+ hotels and need independent scaling
- Multiple developers need to work in parallel
- A specific component fails frequently and needs isolation

Until then, keep it simple.

---

## Folder Structure

```
DreamBoksLock/
├── /shared
│   ├── schema.ts              # Database schema (Drizzle ORM)
│   ├── api-types.ts           # API request/response types
│   └── /interfaces
│       ├── pms.interface.ts   # PMS adapter contract
│       └── lock.interface.ts  # Lock adapter contract
│
├── /server
│   ├── /adapters
│   │   ├── /pms
│   │   │   ├── index.ts       # Adapter factory/registry
│   │   │   └── mews.adapter.ts
│   │   └── /locks
│   │       ├── index.ts
│   │       └── ttlock.adapter.ts
│   ├── /routes
│   │   └── /v1                # Versioned API endpoints
│   ├── /services              # Business logic
│   ├── /jobs                  # Async job handlers (future)
│   └── index.ts
│
├── /client/src
│   ├── /apps
│   │   ├── /admin             # Staff dashboard
│   │   ├── /guest             # Guest mini-web
│   │   └── /kiosk             # Kiosk app
│   ├── /shared                # Shared UI components
│   └── App.tsx                # Router
│
└── /docs                      # Architecture documentation
```

---

## Sync Strategy

### Data Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│    PMS      │────▶│  DreamBoks  │────▶│   Locks     │
│ (MEWS etc)  │     │  Core API   │     │ (TTLock)    │
└─────────────┘     └─────────────┘     └─────────────┘
```

### Polling vs Webhooks

| Method | Current | Future |
|--------|---------|--------|
| **PMS → DreamBoks** | Polling (60 sec) | Webhooks (planned) |
| **DreamBoks → Locks** | Push on demand | Push on demand |

### Source of Truth

| Data | Source of Truth |
|------|-----------------|
| Reservations | PMS (MEWS) |
| PIN codes | DreamBoks DB |
| Lock status | Lock provider (TTLock) |
| Room assignments | DreamBoks DB (synced from PMS) |

### Reconciliation

- **Drift reconciler**: every 60 s; full physical verification per reservation every 6 h
- **PIN repair job**: every `pin_repair_interval_minutes` (default 5) — re-pushes codes missing from assigned locks
- **Orphan cleanup**: hourly audit; live-guest pins are re-pushed, NEVER deleted (fail-safe post-21/7); terminal/expired pins archived as `cancelled` after 3 sightings spanning 2 h+
- **Arrival report**: force-repairs every gap it detects before reporting (detection → action)
- **Manual trigger**: `/api/reservations/:id/resync` endpoint

---

## PIN Lifecycle

### State Machine

```
                    ┌──────────────┐
                    │   PENDING    │
                    │ (generated)  │
                    └──────┬───────┘
                           │ activate (push to lock)
                           ▼
                    ┌──────────────┐
         ┌─────────│    ACTIVE    │─────────┐
         │         │ (on lock)    │         │
         │         └──────┬───────┘         │
         │                │                 │
    room change      checkout/expire    cancellation
         │                │                 │
         ▼                ▼                 ▼
┌──────────────┐   ┌──────────────┐  ┌──────────────┐
│ DELETE OLD   │   │   DELETED    │  │   DELETED    │
│ PUSH TO NEW  │   │  (expired)   │  │ (cancelled)  │
└──────────────┘   └──────────────┘  └──────────────┘
```

### PIN Policy

| Event | Action |
|-------|--------|
| Reservation created | Generate 4-digit PIN, status = `pending` |
| Pre-check-in (evening before) | Push PIN to lock(s), status = `active` |
| Check-in | Push PIN if not already active |
| Room change | Delete from old lock, push to new lock, **reuse same PIN** |
| Checkout | Delete PIN after grace period (2 hours) |
| Cancellation | Delete PIN immediately |
| Lock failure | Retry 3x with 2 sec delay, log error, notify staff |

### Validity Period

```
[arrival - 4 hours] ──────────────────── [departure + 2 hours]
         │                                        │
    PIN becomes valid                    PIN expires
```

### Timezone

- Per-tenant configuration (`settings.timezone`)
- All times stored as UTC in database
- Converted to local time for display and lock scheduling

---

## Retry & Idempotency

### Current Implementation

| Component | Retry Strategy |
|-----------|---------------|
| TTLock API calls | 3 retries, 2 sec delay on "gateway busy" (-2011) |
| MEWS sync | Idempotency via `pmsId` check |
| PIN push | Retry on failure, log for manual intervention |

### Planned Improvements (Phase 2)

| Feature | Purpose |
|---------|---------|
| **Job Queue** (BullMQ/Redis) | Async processing of PIN push, sync, notifications |
| **Outbox Pattern** | Ensure DB commit + external call atomicity |
| **Dead Letter Queue** | Failed jobs for manual review |
| **Idempotency Keys** | On all mutating endpoints |

---

## Multi-tenant Architecture

### Tenant Isolation

- All database queries filter by `tenant_id`
- Storage class scoped: `Storage.forTenant(tenantId)`
- API routes validate tenant access via auth middleware
- No cross-tenant data leakage

### Per-tenant Configuration

| Setting | Stored In |
|---------|-----------|
| PMS credentials | `settings` table (encrypted) |
| Lock credentials | `settings` table (encrypted) |
| Timezone | `settings` table |
| Feature flags | `settings` table |
| Hotel branding | `settings` table |

---

## Scalability

### Current Limits

| Dimension | Current Capacity | Bottleneck |
|-----------|------------------|------------|
| Hotels | 10+ | Single server |
| Reservations | 10,000+ | Database |
| Concurrent users | 100+ | Server memory |

### Scaling Path

| Stage | Solution |
|-------|----------|
| 1-10 hotels | Current architecture |
| 10-50 hotels | Add Redis cache, job queue |
| 50-100 hotels | Horizontal scaling, read replicas |
| 100+ hotels | Microservices, dedicated lock gateway |

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| Frontend | React, TypeScript, Vite, Tailwind, Shadcn UI |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL (Neon serverless) |
| ORM | Drizzle ORM |
| Auth | Replit Auth (planned) |
| Email | SendGrid |
| SMS | Twilio |
| Locks | TTLock API |
| PMS | MEWS Connector API |

---

## External Integrations

### PMS (Property Management System)

| Provider | Status | Adapter |
|----------|--------|---------|
| MEWS | ✅ Implemented | `mews.adapter.ts` |
| Opera | 🔜 Planned | `opera.adapter.ts` |
| Cloudbeds | 🔜 Planned | `cloudbeds.adapter.ts` |

### Lock Systems

| Provider | Status | Adapter |
|----------|--------|---------|
| TTLock | ✅ Implemented | `ttlock.adapter.ts` |
| Salto | 🔜 Planned | `salto.adapter.ts` |
| ASSA Abloy | 🔜 Planned | `assa.adapter.ts` |

---

## API Versioning

All API endpoints are versioned under `/api/v1/`:

- Breaking changes → new version (`/api/v2/`)
- Non-breaking additions → same version
- Deprecation period: 6 months minimum

---

## Document Index

| Document | Content |
|----------|---------|
| [api-v1-spec.md](./api-v1-spec.md) | Complete API endpoint specification |
| [pin-lifecycle.md](./pin-lifecycle.md) | Detailed PIN state machine and policy |
| [auth-rbac.md](./auth-rbac.md) | Authentication and role-based access |
| [security.md](./security.md) | Security controls and best practices |
| [observability.md](./observability.md) | Logging, metrics, and monitoring |
| [database-schema.md](./database-schema.md) | Database tables and relationships |
| [migration-guide.md](./migration-guide.md) | How to implement in Teams project |

### Integration Guides

| Document | Content |
|----------|---------|
| [integrations/mews-api.md](./integrations/mews-api.md) | MEWS API endpoints, auth, data mapping, quirks |
| [integrations/ttlock-api.md](./integrations/ttlock-api.md) | TTLock dual-credential, OAuth, error codes, passcode flow |
