# Observability

## Overview

Observability enables understanding system behavior through logs, metrics, and traces. This document describes the monitoring strategy for DreamBoks.

---

## Three Pillars

| Pillar | Purpose | Tools |
|--------|---------|-------|
| **Logs** | Debug issues, audit trail | Database logs, console |
| **Metrics** | Performance, health, trends | (Planned: Prometheus) |
| **Traces** | Request flow, latency | (Planned: correlation IDs) |

---

## Logging

### Log Levels

| Level | Use Case | Example |
|-------|----------|---------|
| `error` | System failures, exceptions | TTLock API failure |
| `warn` | Recoverable issues | Retry succeeded |
| `info` | Business events | PIN activated |
| `debug` | Development details | Request payload |

### Log Sources

| Source | Description |
|--------|-------------|
| `automation` | PIN lifecycle, sync jobs |
| `pms` | MEWS integration events |
| `ttlock` | Lock operations |
| `auth` | Login/logout events |
| `api` | HTTP request/response |
| `boarding-pass` | Guest access events |

### Database Log Tables

#### `logs` Table

```sql
CREATE TABLE logs (
  id VARCHAR PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  source TEXT NOT NULL,
  reservation_id TEXT,
  room_id TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
```

#### `reservation_logs` Table

```sql
CREATE TABLE reservation_logs (
  id VARCHAR PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Log Entry Example

```typescript
await storage.createLog({
  level: 'info',
  message: 'Passcode pushed to lock successfully',
  source: 'automation',
  reservationId: 'uuid',
  roomId: 'uuid',
  metadata: {
    lockName: 'Room 113.7',
    code: '****', // masked
    ttlockKeyId: '12345',
    latencyMs: 850,
  },
});
```

---

## Audit Logging

### Events to Audit

| Category | Events |
|----------|--------|
| **Authentication** | Login success, login failure, logout |
| **Authorization** | Permission denied, role change |
| **Guest Access** | Boarding pass lookup, remote unlock |
| **PIN Operations** | Generate, activate, delete |
| **Settings** | Config change, integration update |
| **User Management** | Create, update, delete users |

### Audit Log Format

```json
{
  "timestamp": "2025-01-30T12:00:00.000Z",
  "eventType": "remote_unlock",
  "actor": {
    "type": "guest",
    "id": "RES-123456",
    "ip": "192.168.1.1"
  },
  "resource": {
    "type": "lock",
    "id": "uuid",
    "name": "Room 113.7"
  },
  "action": "unlock",
  "result": "success",
  "tenantId": "uuid",
  "correlationId": "req-abc123",
  "metadata": {
    "latencyMs": 450,
    "method": "remote"
  }
}
```

---

## Metrics (Planned)

### Key Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `dreamboks_reservations_total` | Counter | Total reservations synced |
| `dreamboks_pins_active` | Gauge | Currently active PINs |
| `dreamboks_unlock_requests_total` | Counter | Remote unlock attempts |
| `dreamboks_unlock_success_rate` | Gauge | Unlock success percentage |
| `dreamboks_ttlock_latency_ms` | Histogram | TTLock API latency |
| `dreamboks_mews_sync_duration_ms` | Histogram | MEWS sync duration |
| `dreamboks_mews_sync_errors_total` | Counter | MEWS sync failures |

### Metric Labels

```typescript
// Example metric with labels
const unlockRequests = new Counter({
  name: 'dreamboks_unlock_requests_total',
  help: 'Total remote unlock requests',
  labelNames: ['tenant', 'result', 'lock_type'],
});

// Usage
unlockRequests.inc({ 
  tenant: tenantId, 
  result: 'success', 
  lock_type: 'room' 
});
```

---

## Correlation IDs (Planned)

### Implementation

```typescript
import { v4 as uuidv4 } from 'uuid';

const correlationMiddleware = (req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || uuidv4();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
};
```

### Usage in Logs

```typescript
await storage.createLog({
  level: 'info',
  message: 'Processing request',
  source: 'api',
  metadata: {
    correlationId: req.correlationId,
    path: req.path,
    method: req.method,
  },
});
```

---

## Health Checks

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/health` | Basic liveness check |
| `/health/ready` | Readiness (DB, integrations) |
| `/health/live` | Kubernetes liveness probe |

### Health Check Response

```json
{
  "status": "healthy",
  "timestamp": "2025-01-30T12:00:00.000Z",
  "version": "1.0.0",
  "checks": {
    "database": { "status": "up", "latencyMs": 5 },
    "ttlock": { "status": "up", "latencyMs": 120 },
    "mews": { "status": "up", "latencyMs": 85 }
  }
}
```

### Implementation

```typescript
app.get('/health', async (req, res) => {
  const checks = {
    database: await checkDatabase(),
    ttlock: await checkTTLock(),
    mews: await checkMews(),
  };
  
  const allHealthy = Object.values(checks)
    .every(c => c.status === 'up');
  
  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version,
    checks,
  });
});
```

---

## Alerting (Planned)

### Alert Rules

| Alert | Condition | Severity |
|-------|-----------|----------|
| High error rate | >5% errors in 5 min | Critical |
| TTLock API down | 3+ failures in 1 min | Critical |
| MEWS sync failed | No sync in 10 min | Warning |
| PIN push backlog | >50 pending PINs | Warning |
| Database slow | >500ms latency | Warning |
| Low disk space | <10% free | Critical |

### Notification Channels

| Channel | Use Case |
|---------|----------|
| Email | Non-urgent alerts |
| SMS | Critical alerts |
| Slack | Team notifications |
| PagerDuty | On-call escalation |

---

## Dashboards (Planned)

### Operations Dashboard

- Active reservations by status
- PIN states (pending, active, deleted)
- Sync status (last run, errors)
- Lock status (online, battery)

### Performance Dashboard

- API response times (p50, p95, p99)
- TTLock API latency
- MEWS sync duration
- Error rates by endpoint

### Business Dashboard

- Check-ins today
- Remote unlocks today
- Pre-check-in email sent
- Reservations by source

---

## Log Retention

| Log Type | Retention | Storage |
|----------|-----------|---------|
| Application logs | 30 days | Database |
| Audit logs | 7 years | Database + Archive |
| Metrics | 90 days | Time-series DB |
| Debug logs | 7 days | Ephemeral |

---

## Troubleshooting Runbook

### "PIN not working on lock"

1. Check `pins` table for reservation
2. Verify `status = 'active'`
3. Check `roomLockKeyIds` populated
4. Look for errors in `logs` table
5. Verify lock online in TTLock app
6. Try manual resync via admin dashboard

### "MEWS sync not running"

1. Check `logs` for MEWS source
2. Verify MEWS credentials in settings
3. Check MEWS API status
4. Look for rate limiting
5. Restart MEWS poller

### "Remote unlock failing"

1. Check `logs` for ttlock source
2. Verify lock online
3. Check TTLock API status
4. Verify owner credentials
5. Check gateway connection

---

## Implementation Checklist

- [x] Database logging (`logs`, `reservation_logs`)
- [x] Log levels and sources
- [ ] Correlation IDs
- [ ] Health check endpoints
- [ ] Metrics collection
- [ ] Alerting rules
- [ ] Dashboards
- [ ] Log aggregation (external)
