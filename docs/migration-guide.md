# Migration Guide

## Overview

This guide describes how to set up and maintain DreamBoks in the Teams project.

---

## Architecture

DreamBoks uses a simple 2-app architecture:

| App | Purpose |
|-----|---------|
| **Hotel Dashboard** | All backend + staff/vendor UI |
| **Guest Web** | Guest self-service (future) |

---

## Setup in Teams

### 1. Copy Files

Upload these folders/files to the Teams project root:
- `client/` - Frontend React app
- `server/` - Backend Express server
- `shared/` - Shared schema and types
- `docs/` - Documentation
- `migrations/` - Database migrations
- `package.json`, `tsconfig.json`, `vite.config.ts`, etc.

### 2. Configure Environment

Set these secrets in the Teams project:
- `DATABASE_URL` - Neon PostgreSQL connection
- `TTLOCK_CLIENT_ID` - TTLock app ID
- `TTLOCK_API_KEY` - TTLock app secret
- `TTLOCK_OWNER_USERNAME` - Owner account
- `TTLOCK_OWNER_PASSWORD` - Owner password
- `MEWS_CLIENT_TOKEN` - MEWS client token
- `MEWS_ACCESS_TOKEN` - MEWS access token

### 3. Run

```bash
npm install
npm run dev
```

---

## Future: Guest Web App

When ready to create the Guest Web app:

1. Create new Replit: `dreamboks-guest`
2. Build simple React app with:
   - PIN lookup by reservation number
   - Boarding pass display
   - No login required
3. Connect to same database

---

## Database

All apps share the same PostgreSQL database (Neon):
- Schema defined in `shared/schema.ts`
- Migrations in `migrations/`
- Run `npm run db:push` to sync schema

---

## Testing Checklist

After setup:
- [ ] Server starts without errors
- [ ] MEWS poller fetches reservations
- [ ] TTLock API connects
- [ ] Staff can log in
- [ ] Reservations display correctly

---

## Support

Questions? Check:
- `/docs/architecture.md` - System overview
- `/docs/api-v1-spec.md` - API reference
- `/docs/pin-lifecycle.md` - PIN behavior
