# API v1 Specification

## Overview

All API endpoints are versioned under `/api/v1/`. This document describes the complete API surface.

---

## Base URL

```
Production: https://your-app.replit.app/api/v1
Development: http://localhost:5000/api/v1
```

---

## Authentication

### Staff/Vendor (Replit Auth)

```http
Authorization: Bearer <replit-session-token>
X-Tenant-ID: <tenant-uuid> (optional, for super admins)
```

### Guest (Public endpoints)

```http
Content-Type: application/json
Body: { "reservationNumber": "...", "lastName": "..." }
```

---

## Response Format

### Success

```json
{
  "data": { ... },
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 100
  }
}
```

### Error

```json
{
  "error": "Human readable message",
  "code": "ERROR_CODE",
  "details": { ... }
}
```

---

## Endpoints

### Health & Status

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Liveness check |
| GET | `/health/ready` | Readiness check (DB, integrations) |
| GET | `/status` | System status (per tenant) |

#### GET /health

```json
// Response 200
{
  "status": "healthy",
  "timestamp": "2025-01-30T12:00:00Z",
  "version": "1.0.0"
}
```

#### GET /health/ready

```json
// Response 200
{
  "status": "ready",
  "checks": {
    "database": { "status": "up", "latencyMs": 5 },
    "ttlock": { "status": "up", "latencyMs": 120 },
    "mews": { "status": "up", "latencyMs": 85 }
  }
}
```

---

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/auth/me` | Get current user |
| POST | `/auth/logout` | End session |

#### GET /auth/me

```json
// Response 200
{
  "user": {
    "id": "uuid",
    "email": "user@hotel.com",
    "name": "John Doe",
    "role": "admin",
    "tenantId": "uuid",
    "tenantName": "Copenhagen Downtown Hostel"
  }
}
```

---

### Tenants

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/tenants` | List all tenants | Super Admin |
| GET | `/tenants/:id` | Get tenant | Admin |
| POST | `/tenants` | Create tenant | Super Admin |
| PATCH | `/tenants/:id` | Update tenant | Super Admin |
| DELETE | `/tenants/:id` | Delete tenant | Super Admin |

#### GET /tenants

```json
// Response 200
{
  "data": [
    {
      "id": "uuid",
      "name": "Copenhagen Downtown Hostel",
      "slug": "copenhagen-downtown",
      "active": true,
      "createdAt": "2025-01-01T00:00:00Z"
    }
  ]
}
```

---

### Reservations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/reservations` | List reservations |
| GET | `/reservations/:id` | Get reservation |
| POST | `/reservations/:id/resync` | Resync from PMS |
| POST | `/reservations/:id/activate-pin` | Activate PIN |
| POST | `/reservations/:id/send-email` | Send pre-check-in email |

#### GET /reservations

Query parameters:
- `status`: Filter by status (Confirmed, Checked-in, etc.)
- `from`: Start date (ISO 8601)
- `to`: End date (ISO 8601)
- `search`: Search by name/email
- `page`: Page number (default 1)
- `limit`: Items per page (default 20)

```json
// Response 200
{
  "data": [
    {
      "id": "uuid",
      "pmsId": "mews-id",
      "reservationNumber": "RES-123456",
      "firstName": "John",
      "lastName": "Doe",
      "email": "john@example.com",
      "mobile": "+45123456789",
      "arrival": "2025-01-30T14:00:00Z",
      "departure": "2025-02-01T11:00:00Z",
      "status": "Confirmed",
      "room": {
        "id": "uuid",
        "name": "Room 113",
        "bed": "Bed 7"
      },
      "pin": {
        "code": "9733",
        "status": "active",
        "validFrom": "2025-01-30T10:00:00Z",
        "validTo": "2025-02-01T13:00:00Z"
      },
      "preCheckinEmailSent": true,
      "createdAt": "2025-01-20T10:00:00Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 150
  }
}
```

#### POST /reservations/:id/activate-pin

```json
// Response 200
{
  "success": true,
  "pin": {
    "code": "9733",
    "status": "active",
    "locks": ["Room 113.7", "Entrance Door"]
  }
}
```

---

### Rooms

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/rooms` | List rooms |
| GET | `/rooms/:id` | Get room with locks |
| POST | `/rooms` | Create room |
| PATCH | `/rooms/:id` | Update room |
| DELETE | `/rooms/:id` | Delete room |
| POST | `/rooms/:id/locks` | Assign lock to room |
| DELETE | `/rooms/:id/locks/:lockId` | Remove lock from room |

#### GET /rooms

```json
// Response 200
{
  "data": [
    {
      "id": "uuid",
      "pmsId": "mews-room-id",
      "name": "Room 113",
      "type": "Dorm",
      "floor": "1",
      "capacity": 8,
      "locks": [
        {
          "id": "uuid",
          "name": "Room 113.7",
          "type": "room",
          "isOnline": true
        }
      ]
    }
  ]
}
```

---

### Locks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/locks` | List all locks |
| GET | `/locks/:id` | Get lock details |
| POST | `/locks/sync` | Sync from TTLock |
| GET | `/locks/:id/passcodes` | List passcodes on lock |
| POST | `/locks/:id/unlock` | Remote unlock (staff) |

#### GET /locks

```json
// Response 200
{
  "data": [
    {
      "id": "uuid",
      "ttlockId": "12345678",
      "name": "Room 113.7",
      "type": "room",
      "batteryLevel": 85,
      "isOnline": true,
      "firmwareVersion": "5.3.0",
      "lastSeen": "2025-01-30T11:55:00Z"
    }
  ]
}
```

#### POST /locks/:id/unlock

```json
// Request
{
  "reason": "Guest locked out"
}

// Response 200
{
  "success": true,
  "latencyMs": 450
}
```

---

### PINs

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/pins` | List active PINs |
| GET | `/pins/:id` | Get PIN details |
| POST | `/pins/:id/resync` | Resync PIN to locks |
| DELETE | `/pins/:id` | Delete PIN from locks |

#### GET /pins

Query parameters:
- `status`: pending, active, deleted
- `roomId`: Filter by room

```json
// Response 200
{
  "data": [
    {
      "id": "uuid",
      "code": "9733",
      "status": "active",
      "validFrom": "2025-01-30T10:00:00Z",
      "validTo": "2025-02-01T13:00:00Z",
      "reservation": {
        "id": "uuid",
        "guestName": "John Doe",
        "reservationNumber": "RES-123456"
      },
      "room": {
        "id": "uuid",
        "name": "Room 113"
      },
      "locks": ["Room 113.7", "Entrance Door"]
    }
  ]
}
```

---

### Integrations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/integrations` | List configured integrations |
| GET | `/integrations/:type` | Get integration config (pms, locks) |
| POST | `/integrations/:type/test` | Test connection |
| PATCH | `/integrations/:type` | Update credentials |

#### GET /integrations

```json
// Response 200
{
  "data": {
    "pms": {
      "provider": "mews",
      "status": "connected",
      "lastSync": "2025-01-30T11:58:00Z"
    },
    "locks": {
      "provider": "ttlock",
      "status": "connected",
      "locksCount": 25
    },
    "notifications": {
      "email": { "provider": "sendgrid", "status": "configured" },
      "sms": { "provider": "twilio", "status": "configured" }
    }
  }
}
```

#### POST /integrations/:type/test

```json
// Response 200
{
  "success": true,
  "latencyMs": 120,
  "message": "Connection successful"
}

// Response 400
{
  "success": false,
  "error": "Invalid credentials"
}
```

---

### Logs

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/logs` | List system logs |
| GET | `/logs/reservations/:id` | Logs for reservation |

#### GET /logs

Query parameters:
- `level`: error, warn, info
- `source`: automation, pms, ttlock, auth
- `from`: Start date
- `to`: End date
- `search`: Search message text

```json
// Response 200
{
  "data": [
    {
      "id": "uuid",
      "level": "info",
      "message": "Passcode pushed to lock successfully",
      "source": "automation",
      "reservationId": "uuid",
      "roomId": "uuid",
      "metadata": { "lockName": "Room 113.7" },
      "createdAt": "2025-01-30T12:00:00Z"
    }
  ]
}
```

---

### Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/settings` | Get all settings |
| GET | `/settings/:key` | Get specific setting |
| PATCH | `/settings/:key` | Update setting |

#### GET /settings

```json
// Response 200
{
  "data": {
    "timezone": "Europe/Copenhagen",
    "check_in_method": "door_unlock",
    "unlock_method": "ekey",
    "pre_arrival_buffer_hours": 4,
    "post_departure_buffer_hours": 2,
    "hotel_name": "Copenhagen Downtown Hostel",
    "hotel_slug": "copenhagen-downtown"
  }
}
```

---

### Jobs (Admin Actions)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/jobs/sync-pms` | Force PMS sync |
| POST | `/jobs/sync-locks` | Force lock sync |
| POST | `/jobs/cleanup-expired` | Run expired PIN cleanup |
| GET | `/jobs/status` | Get job statuses |

#### POST /jobs/sync-pms

```json
// Response 200
{
  "success": true,
  "job": {
    "id": "job-uuid",
    "type": "sync-pms",
    "status": "running",
    "startedAt": "2025-01-30T12:00:00Z"
  }
}
```

---

### Public Endpoints (Guest)

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | `/public/boarding-pass` | Get boarding pass | Guest |
| POST | `/public/unlock` | Remote unlock | Guest |
| GET | `/public/hotel/:slug` | Get hotel info | None |

#### POST /public/boarding-pass

```json
// Request
{
  "reservationNumber": "RES-123456",
  "lastName": "Doe"
}

// Response 200
{
  "reservation": {
    "firstName": "John",
    "lastName": "Doe",
    "room": "Room 113",
    "bed": "Bed 7",
    "arrival": "2025-01-30T14:00:00Z",
    "departure": "2025-02-01T11:00:00Z",
    "status": "Confirmed"
  },
  "pin": {
    "code": "9733",
    "validFrom": "2025-01-30T10:00:00Z",
    "validTo": "2025-02-01T13:00:00Z",
    "status": "active"
  },
  "locks": [
    { "id": "uuid", "name": "Entrance Door", "type": "entrance" },
    { "id": "uuid", "name": "Room 113.7", "type": "room" }
  ],
  "checkInMethod": "door_unlock"
}
```

#### POST /public/unlock

```json
// Request
{
  "reservationNumber": "RES-123456",
  "lastName": "Doe",
  "lockId": "uuid"
}

// Response 200
{
  "success": true,
  "message": "Door unlocked successfully",
  "lockName": "Room 113.7"
}

// Response 403
{
  "error": "Your access is not yet active. Please wait until check-in time."
}
```

---

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid auth |
| `FORBIDDEN` | 403 | No permission for action |
| `NOT_FOUND` | 404 | Resource not found |
| `VALIDATION_ERROR` | 400 | Invalid request data |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTEGRATION_ERROR` | 502 | External service failure |
| `INTERNAL_ERROR` | 500 | Server error |

---

## Rate Limits

| Endpoint Category | Limit | Window |
|-------------------|-------|--------|
| Public (guest) | 5 | 15 min |
| Unlock | 10 | 1 min |
| General API | 100 | 1 min |
| Sync jobs | 5 | 5 min |

---

## Pagination

All list endpoints support pagination:

```
GET /api/v1/reservations?page=2&limit=50
```

Response includes meta:

```json
{
  "data": [...],
  "meta": {
    "page": 2,
    "limit": 50,
    "total": 150,
    "totalPages": 3
  }
}
```

---

## Webhooks (Planned)

| Event | Payload |
|-------|---------|
| `reservation.created` | Reservation object |
| `reservation.updated` | Reservation object |
| `reservation.cancelled` | Reservation ID |
| `pin.activated` | PIN + reservation |
| `unlock.success` | Lock + reservation |
