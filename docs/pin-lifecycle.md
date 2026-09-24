# PIN Lifecycle

## Overview

PIN codes are the primary access mechanism for guests. This document describes the complete lifecycle of a PIN code from generation to deletion.

---

## State Machine

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                         ┌──────────────┐                        │
│                         │   PENDING    │                        │
│                         │ (in DB only) │                        │
│                         └──────┬───────┘                        │
│                                │                                │
│              ┌─────────────────┼─────────────────┐              │
│              │                 │                 │              │
│         pre-check-in      check-in          manual push         │
│         (scheduled)       (on demand)       (staff action)      │
│              │                 │                 │              │
│              └─────────────────┼─────────────────┘              │
│                                │                                │
│                                ▼                                │
│                         ┌──────────────┐                        │
│                         │    ACTIVE    │◄────────┐              │
│                         │ (on locks)   │         │              │
│                         └──────┬───────┘         │              │
│                                │                 │              │
│         ┌──────────────────────┼─────────────────┤              │
│         │                      │                 │              │
│    room change            checkout/         cancellation        │
│    (reuse PIN)            expiry                                │
│         │                      │                 │              │
│         ▼                      ▼                 ▼              │
│  ┌──────────────┐       ┌──────────────┐  ┌──────────────┐      │
│  │ DELETE OLD   │       │   DELETED    │  │   DELETED    │      │
│  │ PUSH TO NEW  │──────▶│  (expired)   │  │ (cancelled)  │      │
│  └──────────────┘       └──────────────┘  └──────────────┘      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## States

| State | Description | On Lock? | In DB? |
|-------|-------------|----------|--------|
| `pending` | Generated, not yet pushed to lock | No | Yes |
| `active` | Pushed to lock, guest can use it | Yes | Yes |
| `deleted` | Removed from lock | No | Yes (historical) |
| `expired` | Past validity period, auto-deleted | No | Yes (historical) |

---

## Lifecycle Events

### 1. Generation

**Trigger:** Reservation created or updated in PMS

**Actions:**
1. Check if reservation already has a PIN (`generatedPin` field)
2. If not, generate unique 4-digit code
3. Create `pins` record with status = `pending`
4. Store code in `reservation.generatedPin` for reuse

**Code:**
```typescript
const pin = await generateUniquePin();
await storage.createPin({
  reservationId,
  roomId,
  code: pin,
  status: 'pending',
  validFrom: arrival - 4 hours,
  validTo: departure + 2 hours,
});
```

### 2. Activation (Push to Lock)

**Triggers:**
- Scheduled job (evening before check-in)
- Guest opens boarding pass (on-demand)
- Staff manual action

**Actions:**
1. Get all locks assigned to room
2. Push PIN to each lock via TTLock API
3. Store lock key IDs in `pins.roomLockKeyIds`
4. Update status to `active`
5. Set `pins.activatedAt` timestamp

**Retry Logic:**
- 3 retries with 2 second delay
- On "gateway busy" (-2011): retry
- On permanent failure: log error, notify staff

### 3. Room Change

**Trigger:** PMS reports room change for reservation

**Actions (same PIN reused):**
1. Delete PIN from old room's locks
2. Push same PIN to new room's locks
3. Update `pins.roomId` to new room
4. Update `pins.roomLockKeyIds` with new lock IDs

**Edge Cases:**
| Scenario | Action |
|----------|--------|
| New room has no lock | Mark PIN as deleted, keep code for future |
| Old lock delete fails | Block room change, notify staff |
| New lock push fails | Retry, log error |

### 4. Checkout / Expiry

**Trigger:** 
- Reservation status changes to "Checked-out"
- Validity period ends (`validTo` passed)

**Actions:**
1. Delete PIN from all locks
2. Update status to `deleted`
3. Clear `reservation.generatedPin` (optional)

**Grace Period:** 2 hours after departure

### 5. Cancellation

**Trigger:** Reservation cancelled in PMS

**Actions:**
1. Delete PIN from all locks immediately
2. Update status to `deleted`
3. Log cancellation reason

---

## Validity Period

```
Timeline:
───────────────────────────────────────────────────────────────────
        │                                              │
   arrival - 4h                                   departure + 2h
        │                                              │
        ├──────────────────────────────────────────────┤
        │           PIN VALID PERIOD                   │
        ├──────────────────────────────────────────────┤
        │                                              │
───────────────────────────────────────────────────────────────────
```

| Parameter | Default | Configurable |
|-----------|---------|--------------|
| Pre-arrival buffer | 4 hours | Yes (per tenant) |
| Post-departure buffer | 2 hours | Yes (per tenant) |
| Timezone | Hotel local | Yes (per tenant) |

---

## PIN Generation Rules

| Rule | Implementation |
|------|----------------|
| Length | 4 digits |
| Uniqueness | Unique per lock at any given time |
| Collision check | Query existing active PINs for same locks |
| Retry on collision | Generate new code, max 10 attempts |
| Excluded codes | 0000, 1234, 1111, 2222, etc. (configurable) |

---

## Database Schema

```sql
CREATE TABLE pins (
  id VARCHAR PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  code VARCHAR(10) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  valid_from TIMESTAMP NOT NULL,
  valid_to TIMESTAMP NOT NULL,
  activated_at TIMESTAMP,
  ttlock_key_id TEXT,
  room_lock_key_ids JSONB,
  common_area_key_ids JSONB,
  qr_code_data JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## Error Handling

| Error | Action |
|-------|--------|
| TTLock API timeout | Retry 3x, then log and notify |
| Invalid lock ID | Log error, skip lock |
| PIN already exists on lock | Delete old, create new |
| Lock offline | Log, retry later via scheduled job |
| Gateway busy (-2011) | Retry with backoff |

---

## Audit Logging

All PIN operations are logged in `reservation_logs`:

| Event | Log Type |
|-------|----------|
| PIN generated | `passcode_generated` |
| PIN pushed to lock | `passcode_synced` |
| PIN deleted from lock | `passcode_deleted` |
| Room change | `room_change` |
| Push failure | `error` |

---

## Scheduled Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| `activatePendingPins` | Every 30 min | Push pending PINs for check-ins within 24h |
| `cleanupExpiredPasscodes` | Every hour | Delete PINs past validity period |
| `cleanupOrphanedPasscodes` | Every hour | Audit + re-push missing codes (never deletes live-guest pins; terminal pins archived after 3 sightings over 2h+) |
| `_jobPinRepair` | Every 5 min (`pin_repair_interval_minutes`) | Re-push codes missing from assigned locks |
| Drift reconciler | Every 60 s (full physical verify per reservation every 6 h) | Verify + re-push against actual lock lists |
