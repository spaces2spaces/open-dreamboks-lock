# Authentication & Role-Based Access Control (RBAC)

## Overview

DreamBoks uses a hybrid authentication model:
- **Staff/Vendor**: Replit Auth (OAuth with Google, GitHub, Apple, email)
- **Guests**: Reservation-based authentication (reservationNumber + lastName)

---

## Authentication Methods

### 1. Replit Auth (Staff & Vendor)

**Used by:** Admin Dashboard, Vendor Panel

**Flow:**
1. User clicks "Log in with Replit"
2. Redirected to Replit OAuth
3. Returns with user profile (id, email, name)
4. System looks up user → tenant mapping
5. Session created with tenant context

**Benefits:**
- No password management
- SSO with Google, GitHub, Apple
- Secure token handling
- Session management by Replit

### 2. Reservation Auth (Guests)

**Used by:** Guest Mini-Web, Kiosk, Mobile App

**Flow:**
1. Guest enters reservationNumber + lastName
2. System validates against reservations table
3. Returns booking + PIN data
4. Credentials stored in localStorage (optional)

**Security Controls:**
- Rate limiting: 5 attempts per 15 minutes
- Lockout: 15 minute cooldown after failed attempts
- Session: 24 hour expiry
- Audit: All attempts logged

---

## User Types

| Type | Auth Method | Scope |
|------|-------------|-------|
| **Super Admin** | Replit Auth | All tenants, system config |
| **Hotel Admin** | Replit Auth | Single tenant, all features |
| **Hotel Manager** | Replit Auth | Single tenant, limited settings |
| **Frontdesk** | Replit Auth | Single tenant, operations only |
| **Viewer** | Replit Auth | Single tenant, read-only |
| **Guest** | Reservation | Own reservation only |

---

## Roles & Permissions

### Permission Matrix

| Permission | Super Admin | Hotel Admin | Manager | Frontdesk | Viewer |
|------------|:-----------:|:-----------:|:-------:|:---------:|:------:|
| View reservations | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit reservations | ✅ | ✅ | ✅ | ❌ | ❌ |
| Send check-in emails | ✅ | ✅ | ✅ | ✅ | ❌ |
| View PINs | ✅ | ✅ | ✅ | ✅ | ❌ |
| Remote unlock | ✅ | ✅ | ✅ | ✅ | ❌ |
| View rooms | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit rooms | ✅ | ✅ | ✅ | ❌ | ❌ |
| Manage locks | ✅ | ✅ | ✅ | ❌ | ❌ |
| View logs | ✅ | ✅ | ✅ | ✅ | ✅ |
| Change settings | ✅ | ✅ | ❌ | ❌ | ❌ |
| Manage users | ✅ | ✅ | ❌ | ❌ | ❌ |
| Manage integrations | ✅ | ✅ | ❌ | ❌ | ❌ |
| View all tenants | ✅ | ❌ | ❌ | ❌ | ❌ |
| Create tenants | ✅ | ❌ | ❌ | ❌ | ❌ |
| System config | ✅ | ❌ | ❌ | ❌ | ❌ |

### Permission Definitions

```typescript
export const PERMISSIONS = {
  RESERVATIONS_VIEW: 'reservations:view',
  RESERVATIONS_EDIT: 'reservations:edit',
  RESERVATIONS_SEND_EMAIL: 'reservations:send_email',
  PINS_VIEW: 'pins:view',
  PINS_UNLOCK: 'pins:unlock',
  ROOMS_VIEW: 'rooms:view',
  ROOMS_EDIT: 'rooms:edit',
  LOCKS_MANAGE: 'locks:manage',
  LOGS_VIEW: 'logs:view',
  SETTINGS_CHANGE: 'settings:change',
  USERS_MANAGE: 'users:manage',
  INTEGRATIONS_MANAGE: 'integrations:manage',
  TENANTS_VIEW_ALL: 'tenants:view_all',
  TENANTS_CREATE: 'tenants:create',
  SYSTEM_CONFIG: 'system:config',
} as const;
```

---

## Database Schema

### Users Table (Replit Auth Mapping)

```sql
CREATE TABLE users (
  id VARCHAR PRIMARY KEY,
  replit_user_id TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'viewer',
  tenant_id TEXT REFERENCES tenants(id),
  is_super_admin BOOLEAN DEFAULT FALSE,
  last_login_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Sessions Table (Optional - Replit manages)

```sql
CREATE TABLE sessions (
  id VARCHAR PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Tenant Isolation

### Middleware Implementation

```typescript
const tenantMiddleware = async (req, res, next) => {
  const user = req.user; // From Replit Auth
  
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Super admins can access any tenant
  if (user.isSuperAdmin) {
    req.tenantId = req.headers['x-tenant-id'] || user.tenantId;
    return next();
  }
  
  // Regular users can only access their tenant
  req.tenantId = user.tenantId;
  
  if (!req.tenantId) {
    return res.status(403).json({ error: 'No tenant assigned' });
  }
  
  next();
};
```

### Query Scoping

All database queries automatically include tenant filter:

```typescript
class Storage {
  constructor(private tenantId: string) {}
  
  async getReservations() {
    return db.select()
      .from(reservations)
      .where(eq(reservations.tenantId, this.tenantId));
  }
}
```

---

## Guest Access Security

### Rate Limiting

```typescript
const guestRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  message: { error: 'Too many attempts. Please try again later.' },
  keyGenerator: (req) => req.ip + ':' + req.body.reservationNumber,
});
```

### Lockout Policy

| Attempts | Action |
|----------|--------|
| 1-5 | Allow |
| 6+ | Block for 15 minutes |
| After cooldown | Reset counter |

### Session Management

```typescript
// Credentials stored in localStorage
localStorage.setItem('dreamlock-reservation', reservationNumber);
localStorage.setItem('dreamlock-lastname', lastName);

// Auto-expire after 24 hours
const SESSION_DURATION = 24 * 60 * 60 * 1000;
```

---

## Audit Logging

All authentication events are logged:

| Event | Data Captured |
|-------|---------------|
| Login success | userId, email, timestamp, IP |
| Login failure | email, reason, timestamp, IP |
| Logout | userId, timestamp |
| Permission denied | userId, action, resource, timestamp |
| Guest access | reservationNumber, timestamp, IP |
| Remote unlock | reservationNumber, lockId, timestamp, IP |

---

## Implementation Checklist

- [ ] Install Replit Auth integration
- [ ] Create users table with Replit ID mapping
- [ ] Implement tenant middleware
- [ ] Add role column to users table
- [ ] Create permissions lookup
- [ ] Add permission checks to routes
- [ ] Implement guest rate limiting
- [ ] Add audit logging
- [ ] Create user management UI
- [ ] Test tenant isolation
