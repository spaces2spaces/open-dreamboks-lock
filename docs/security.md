# Security

## Overview

This document describes security controls, best practices, and compliance requirements for DreamBoks.

---

## Authentication Security

### Staff Authentication (Replit Auth)

| Control | Implementation |
|---------|----------------|
| OAuth 2.0 | Via Replit (Google, GitHub, Apple) |
| Session management | Handled by Replit |
| Token storage | Secure HTTP-only cookies |
| CSRF protection | Built into Replit Auth |

### Guest Authentication

| Control | Implementation |
|---------|----------------|
| Credentials | reservationNumber + lastName |
| Rate limiting | 5 attempts / 15 minutes |
| Lockout | 15 minute cooldown |
| Session duration | 24 hours |
| Storage | localStorage (optional) |

---

## Rate Limiting

### Endpoints

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/api/public/boarding-pass-ekey` | 5 | 15 min |
| `/api/public/unlock` | 10 | 1 min |
| `/api/auth/login` | 5 | 15 min |
| General API | 100 | 1 min |

### Implementation

```typescript
import rateLimit from 'express-rate-limit';

const guestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many attempts. Please try again later.' },
  keyGenerator: (req) => `${req.ip}:${req.body.reservationNumber}`,
  standardHeaders: true,
  legacyHeaders: false,
});
```

---

## Tenant Isolation

### Database Level

- All tables include `tenant_id` column
- All queries filter by `tenant_id`
- Foreign keys ensure referential integrity within tenant

### Application Level

- Storage class scoped to tenant: `Storage.forTenant(tenantId)`
- Middleware validates tenant access
- No cross-tenant data leakage possible

### Validation

```typescript
const validateTenantAccess = (req, res, next) => {
  const userTenantId = req.user.tenantId;
  const requestedTenantId = req.params.tenantId || req.tenantId;
  
  if (userTenantId !== requestedTenantId && !req.user.isSuperAdmin) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  next();
};
```

---

## Secrets Management

### Storage

| Secret Type | Storage Method |
|-------------|----------------|
| API keys | Replit Secrets (env vars) |
| PMS tokens | `settings` table (per tenant) |
| Lock credentials | `settings` table (per tenant) |
| Database URL | Replit Secrets |

### Access Rules

- Never log secrets
- Never expose in API responses
- Never commit to repository
- Rotate regularly (90 days recommended)

### Environment Variables

```bash
# System-wide (Replit Secrets)
DATABASE_URL=postgresql://...
TTLOCK_CLIENT_ID=...
TTLOCK_CLIENT_SECRET=...

# Per-tenant (in database)
mews_access_token (encrypted)
ttlock_username (encrypted)
ttlock_password (encrypted)
```

---

## Data Protection

### Sensitive Data Classification

| Data | Classification | Handling |
|------|---------------|----------|
| Guest names | PII | Encrypt at rest |
| Email addresses | PII | Encrypt at rest |
| Phone numbers | PII | Encrypt at rest |
| PIN codes | Sensitive | Hash or encrypt |
| Access tokens | Secret | Encrypt at rest |

### Encryption

- Database: Neon provides encryption at rest
- Transport: HTTPS/TLS required
- Application: Consider field-level encryption for PII

### Data Retention

| Data Type | Retention | Action at Expiry |
|-----------|-----------|------------------|
| Reservations | 2 years | Archive |
| PIN records | 90 days after checkout | Delete |
| Logs | 1 year | Archive then delete |
| Audit logs | 7 years | Archive |

---

## API Security

### Headers

```typescript
app.use(helmet({
  contentSecurityPolicy: true,
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy: true,
  crossOriginResourcePolicy: true,
  dnsPrefetchControl: true,
  frameguard: true,
  hidePoweredBy: true,
  hsts: true,
  ieNoOpen: true,
  noSniff: true,
  originAgentCluster: true,
  permittedCrossDomainPolicies: true,
  referrerPolicy: true,
  xssFilter: true,
}));
```

### CORS

```typescript
app.use(cors({
  origin: [
    'https://your-domain.replit.app',
    'https://your-custom-domain.com',
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID'],
}));
```

### Input Validation

- All inputs validated with Zod schemas
- SQL injection prevented by Drizzle ORM (parameterized queries)
- XSS prevented by React's default escaping

---

## Lock Security

### Dual-Credential Architecture

| Account | Purpose | Access Level |
|---------|---------|--------------|
| Owner | List all locks, read operations | Full read |
| Hotel | Create/delete passcodes | Write operations |

**Rationale:** If hotel credentials are compromised, attacker cannot list all locks system-wide.

### Passcode Security

| Rule | Implementation |
|------|----------------|
| Unique per lock | Collision check before creation |
| Time-limited | Valid only during stay +/- buffer |
| Auto-expire | Cleanup job runs hourly |
| Excluded codes | 0000, 1234, etc. blocked |

### Remote Unlock

| Control | Implementation |
|---------|----------------|
| Authentication | Valid reservation required |
| Time validation | Within arrival/departure window |
| Audit logging | Every unlock attempt logged |
| Rate limiting | 10 unlocks per minute |

---

## Audit Logging

### Events Logged

| Category | Events |
|----------|--------|
| Authentication | Login, logout, failed attempts |
| Authorization | Permission denied |
| PIN operations | Generate, push, delete |
| Lock operations | Remote unlock, sync |
| Data access | Reservation view, PIN view |
| Admin actions | Settings change, user management |

### Log Format

```json
{
  "timestamp": "2025-01-30T12:00:00Z",
  "level": "info",
  "event": "remote_unlock",
  "userId": "guest:RES-123456",
  "tenantId": "cc327433-...",
  "resourceType": "lock",
  "resourceId": "lock-uuid",
  "action": "unlock",
  "result": "success",
  "ip": "192.168.1.1",
  "userAgent": "Mozilla/5.0...",
  "metadata": {
    "reservationNumber": "RES-123456",
    "lockName": "Room 113.7",
    "latencyMs": 450
  }
}
```

### Retention

- Standard logs: 1 year
- Security audit logs: 7 years
- Access logs: 90 days

---

## Incident Response

### Detection

- Monitor failed login attempts
- Alert on unusual unlock patterns
- Track API error rates

### Response Procedures

1. **Compromised credentials**
   - Rotate immediately
   - Revoke all active sessions
   - Audit recent activity

2. **Unauthorized access**
   - Block IP/user
   - Review logs
   - Notify affected parties

3. **Data breach**
   - Contain breach
   - Assess impact
   - Notify authorities (GDPR: 72 hours)
   - Notify affected users

---

## Compliance

### GDPR

- [ ] Data processing agreement with sub-processors
- [ ] Privacy policy displayed to guests
- [ ] Right to erasure (data deletion on request)
- [ ] Data portability (export on request)
- [ ] Breach notification (72 hours)

### PCI-DSS (if handling payments)

- Not currently applicable (MEWS handles payments)
- If adding direct payments: Level 4 SAQ-A

---

## Security Checklist

### Deployment

- [ ] HTTPS only (forced redirect)
- [ ] Environment variables for secrets
- [ ] Database connections encrypted
- [ ] Rate limiting enabled
- [ ] CORS configured properly
- [ ] Security headers enabled

### Ongoing

- [ ] Regular dependency updates
- [ ] Credential rotation (90 days)
- [ ] Security audit (annual)
- [ ] Penetration testing (annual)
- [ ] Log review (weekly)
