# Database Schema

## Overview

DreamBoks uses PostgreSQL (Neon serverless) with Drizzle ORM. All tables are multi-tenant with `tenant_id` column.

---

## Entity Relationship Diagram

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   tenants   │────<│   rooms     │────<│ reservations│
└─────────────┘     └──────┬──────┘     └──────┬──────┘
                           │                    │
                    ┌──────┴──────┐      ┌──────┴──────┐
                    │room_lock_   │      │    pins     │
                    │assignments  │      └─────────────┘
                    └──────┬──────┘
                           │
                    ┌──────┴──────┐
                    │lock_devices │
                    └─────────────┘
```

---

## Core Tables

### tenants

Represents a hotel/property in the system.

```sql
CREATE TABLE tenants (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

| Column | Type | Description |
|--------|------|-------------|
| id | VARCHAR (UUID) | Primary key |
| name | TEXT | Hotel name |
| slug | TEXT | URL-friendly identifier |
| active | BOOLEAN | Is tenant active |
| created_at | TIMESTAMP | Creation timestamp |

---

### users (Planned - Replit Auth)

Maps Replit Auth users to tenants.

```sql
CREATE TABLE users (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  replit_user_id TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'viewer',
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  is_super_admin BOOLEAN DEFAULT FALSE,
  last_login_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX users_tenant_idx ON users(tenant_id);
CREATE INDEX users_replit_id_idx ON users(replit_user_id);
```

| Column | Type | Description |
|--------|------|-------------|
| replit_user_id | TEXT | Replit user ID |
| role | TEXT | admin, manager, frontdesk, viewer |
| is_super_admin | BOOLEAN | Can access all tenants |

---

### rooms

Rooms/beds that can be booked.

```sql
CREATE TABLE rooms (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pms_id TEXT,
  name TEXT NOT NULL,
  type TEXT,
  floor TEXT,
  capacity INTEGER DEFAULT 1,
  ttlock_id TEXT, -- Legacy, use room_lock_assignments
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX rooms_tenant_idx ON rooms(tenant_id);
CREATE INDEX rooms_pms_id_idx ON rooms(pms_id);
```

---

### lock_devices

Smart locks managed by the system.

```sql
CREATE TABLE lock_devices (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ttlock_id TEXT,
  name TEXT NOT NULL,
  lock_type TEXT NOT NULL DEFAULT 'room', -- room, common, entrance
  mac_address TEXT,
  battery_level INTEGER,
  is_online BOOLEAN DEFAULT TRUE,
  last_seen TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX lock_devices_tenant_idx ON lock_devices(tenant_id);
CREATE INDEX lock_devices_ttlock_id_idx ON lock_devices(ttlock_id);
```

| Column | Type | Description |
|--------|------|-------------|
| lock_type | TEXT | room, common, entrance |
| battery_level | INTEGER | 0-100 percentage |
| is_online | BOOLEAN | Lock reachable |

---

### room_lock_assignments

Many-to-many relationship between rooms and locks.

```sql
CREATE TABLE room_lock_assignments (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  lock_device_id TEXT NOT NULL REFERENCES lock_devices(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(room_id, lock_device_id)
);

CREATE INDEX room_lock_assignments_room_idx ON room_lock_assignments(room_id);
CREATE INDEX room_lock_assignments_lock_idx ON room_lock_assignments(lock_device_id);
```

---

### reservations

Guest bookings synced from PMS.

```sql
CREATE TABLE reservations (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pms_id TEXT,
  reservation_number TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  mobile TEXT,
  arrival TIMESTAMP NOT NULL,
  departure TIMESTAMP NOT NULL,
  status TEXT NOT NULL DEFAULT 'Confirmed',
  room_id TEXT REFERENCES rooms(id),
  generated_pin TEXT,
  pre_checkin_token TEXT,
  pre_checkin_status TEXT,
  pre_checkin_email_sent BOOLEAN DEFAULT FALSE,
  code_delivered_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX reservations_tenant_idx ON reservations(tenant_id);
CREATE INDEX reservations_pms_id_idx ON reservations(pms_id);
CREATE INDEX reservations_room_idx ON reservations(room_id);
CREATE INDEX reservations_arrival_idx ON reservations(arrival);
CREATE INDEX reservations_status_idx ON reservations(status);
```

| Column | Type | Description |
|--------|------|-------------|
| status | TEXT | Confirmed, Checked-in, Checked-out, Cancelled |
| generated_pin | TEXT | 4-digit PIN (preserved across room changes) |
| pre_checkin_email_sent | BOOLEAN | Email sent to guest |

---

### pins

PIN codes for lock access.

```sql
CREATE TABLE pins (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  code VARCHAR(10) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, active, deleted
  valid_from TIMESTAMP NOT NULL,
  valid_to TIMESTAMP NOT NULL,
  activated_at TIMESTAMP,
  ttlock_key_id TEXT,
  room_lock_key_ids JSONB, -- [{ttlockId, keyId, lockName}]
  common_area_key_ids JSONB,
  qr_code_data JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX pins_tenant_idx ON pins(tenant_id);
CREATE INDEX pins_reservation_idx ON pins(reservation_id);
CREATE INDEX pins_room_idx ON pins(room_id);
CREATE INDEX pins_status_idx ON pins(status);
```

| Column | Type | Description |
|--------|------|-------------|
| status | TEXT | pending, active, deleted |
| room_lock_key_ids | JSONB | TTLock key IDs for each lock |
| common_area_key_ids | JSONB | Keys for common area locks |

---

### logs

System logs for debugging and audit.

```sql
CREATE TABLE logs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  level TEXT NOT NULL, -- error, warn, info, debug
  message TEXT NOT NULL,
  source TEXT NOT NULL, -- automation, pms, ttlock, auth
  reservation_id TEXT,
  room_id TEXT,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX logs_tenant_idx ON logs(tenant_id);
CREATE INDEX logs_level_idx ON logs(level);
CREATE INDEX logs_source_idx ON logs(source);
CREATE INDEX logs_created_at_idx ON logs(created_at);
CREATE INDEX logs_reservation_idx ON logs(reservation_id);
```

---

### reservation_logs

Business events for reservations.

```sql
CREATE TABLE reservation_logs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  type TEXT NOT NULL, -- room_change, passcode_synced, error, etc.
  detail TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX reservation_logs_tenant_idx ON reservation_logs(tenant_id);
CREATE INDEX reservation_logs_reservation_idx ON reservation_logs(reservation_id);
```

---

### settings

Per-tenant configuration.

```sql
CREATE TABLE settings (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, key)
);

CREATE INDEX settings_tenant_key_idx ON settings(tenant_id, key);
```

Common settings:
- `mews_access_token`, `mews_client_token`, `mews_environment`
- `ttlock_username`, `ttlock_password`, `ttlock_region`
- `timezone`, `hotel_name`, `hotel_slug`
- `check_in_method`, `unlock_method`

---

## Planned Tables

### integration_accounts

Per-tenant integration credentials (replace settings for secrets).

```sql
CREATE TABLE integration_accounts (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, -- mews, ttlock, sendgrid, twilio
  credentials JSONB NOT NULL, -- encrypted
  config JSONB,
  status TEXT DEFAULT 'active',
  last_sync_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, provider)
);
```

---

### sync_runs

Track sync job history.

```sql
CREATE TABLE sync_runs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- pms_sync, lock_sync, cleanup
  status TEXT NOT NULL, -- running, completed, failed
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  items_processed INTEGER DEFAULT 0,
  items_created INTEGER DEFAULT 0,
  items_updated INTEGER DEFAULT 0,
  items_deleted INTEGER DEFAULT 0,
  errors JSONB,
  metadata JSONB
);

CREATE INDEX sync_runs_tenant_idx ON sync_runs(tenant_id);
CREATE INDEX sync_runs_type_idx ON sync_runs(type);
```

---

### lock_actions

Audit trail for lock operations.

```sql
CREATE TABLE lock_actions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lock_device_id TEXT NOT NULL REFERENCES lock_devices(id),
  action TEXT NOT NULL, -- unlock, push_passcode, delete_passcode
  actor_type TEXT NOT NULL, -- guest, staff, system
  actor_id TEXT,
  reservation_id TEXT,
  success BOOLEAN NOT NULL,
  latency_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX lock_actions_tenant_idx ON lock_actions(tenant_id);
CREATE INDEX lock_actions_lock_idx ON lock_actions(lock_device_id);
CREATE INDEX lock_actions_created_at_idx ON lock_actions(created_at);
```

---

## Indexes Strategy

### Primary Indexes

- All tables have `tenant_id` index for tenant isolation
- Foreign key columns indexed for joins
- Timestamp columns indexed for range queries

### Query Optimization

```sql
-- Common query: active reservations for a room
CREATE INDEX reservations_room_status_idx 
ON reservations(room_id, status) 
WHERE status NOT IN ('Cancelled', 'Checked-out');

-- Common query: pending PINs to activate
CREATE INDEX pins_pending_idx 
ON pins(tenant_id, status, valid_from) 
WHERE status = 'pending';
```

---

## Data Retention

| Table | Retention | Action |
|-------|-----------|--------|
| reservations | 2 years | Archive |
| pins | 90 days after checkout | Delete |
| logs | 1 year | Archive then delete |
| reservation_logs | 1 year | Archive then delete |
| lock_actions | 1 year | Archive then delete |
| sync_runs | 30 days | Delete |

---

## Migration Notes

When adding new tables:

1. Add schema to `shared/schema.ts`
2. Run `npm run db:push` to sync
3. Never change primary key types
4. Add indexes for query patterns
5. Include `tenant_id` for multi-tenancy
