# TTLock API Integration

## Overview

TTLock is a smart lock platform with API access for managing locks, passcodes, and eKeys. DreamBoks uses TTLock to push/delete passcodes for guest access.

---

## Authentication

### OAuth 2.0 Flow

TTLock uses OAuth with username/password grant:

```typescript
const tokenResponse = await fetch('https://euapi.ttlock.com/oauth2/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({
    client_id: TTLOCK_CLIENT_ID,
    client_secret: TTLOCK_CLIENT_SECRET,
    username: TTLOCK_USERNAME,
    password: md5(TTLOCK_PASSWORD), // Password must be MD5 hashed
    grant_type: 'password',
  }),
});

const { access_token, refresh_token, expires_in } = await tokenResponse.json();
```

**Important:** Password must be MD5 hashed before sending!

### Token Refresh

```typescript
const refreshResponse = await fetch('https://euapi.ttlock.com/oauth2/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({
    client_id: TTLOCK_CLIENT_ID,
    client_secret: TTLOCK_CLIENT_SECRET,
    refresh_token: storedRefreshToken,
    grant_type: 'refresh_token',
  }),
});
```

### Regional Endpoints

| Region | Base URL |
|--------|----------|
| Europe | `https://euapi.ttlock.com` |
| China | `https://api.ttlock.com` |
| US | `https://api.ttlock.com` |

---

## Dual-Credential Architecture

### The Problem

TTLock API has a limitation:
- `lock/list` only returns locks you **own** (added to your account)
- Other APIs work on locks you have **access to** (via eKey)

### DreamBoks Solution

Use **two accounts**:

| Account | Purpose | Operations |
|---------|---------|------------|
| **Owner Account** | List all locks | `lock/list`, read operations |
| **Hotel Account** | Manage passcodes | `keyboardPwd/add`, `keyboardPwd/delete` |

### Why This Works

1. Owner account owns all locks → can list them all
2. Hotel account has eKeys to all locks → can create/delete passcodes
3. If hotel account is compromised → attacker can't list all locks
4. Each hotel has separate credentials → isolation

### Implementation

```typescript
class TTLockClient {
  private ownerToken: string;  // For listing locks
  private hotelToken: string;  // For passcode operations
  
  async getLocks(): Promise<Lock[]> {
    // Use owner account
    return this.callApi('lock/list', { accessToken: this.ownerToken });
  }
  
  async createPasscode(lockId, code, startTime, endTime): Promise<Result> {
    // Use hotel account
    return this.callApi('keyboardPwd/add', { 
      accessToken: this.hotelToken,
      lockId,
      keyboardPwd: code,
      startDate: startTime,
      endDate: endTime,
    });
  }
}
```

---

## Endpoints Used by DreamBoks

### 1. lock/list

**Purpose:** Get all locks owned by an account.

**Request:**
```
POST /v3/lock/list
Content-Type: application/x-www-form-urlencoded

clientId=xxx&accessToken=xxx&pageNo=1&pageSize=100&date=1706620800000
```

**Response:**
```json
{
  "list": [
    {
      "lockId": 12345678,
      "lockName": "Room 113.7",
      "lockMac": "AA:BB:CC:DD:EE:FF",
      "electricQuantity": 85,
      "lockData": "...",
      "hasGateway": 1,
      "specialValue": 0
    }
  ],
  "pageNo": 1,
  "pageSize": 100,
  "pages": 1,
  "total": 25
}
```

**Key Fields:**
- `lockId`: Unique identifier for the lock
- `lockName`: Display name
- `electricQuantity`: Battery percentage (0-100)
- `hasGateway`: 1 = connected to WiFi gateway, 0 = Bluetooth only

---

### 2. keyboardPwd/add

**Purpose:** Create a passcode on a lock.

**Request:**
```
POST /v3/keyboardPwd/add
Content-Type: application/x-www-form-urlencoded

clientId=xxx&accessToken=xxx&lockId=12345678&keyboardPwd=9733&keyboardPwdName=John Doe&startDate=1706620800000&endDate=1706793600000&addType=2&date=1706620800000
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| lockId | number | Lock ID |
| keyboardPwd | string | 4-9 digit code |
| keyboardPwdName | string | Label (guest name) |
| startDate | number | Valid from (Unix ms) |
| endDate | number | Valid until (Unix ms) |
| addType | number | 2 = timed passcode |

**Response:**
```json
{
  "keyboardPwdId": 987654321
}
```

**Store `keyboardPwdId`** - needed to delete the passcode later!

---

### 3. keyboardPwd/delete

**Purpose:** Delete a passcode from a lock.

**Request:**
```
POST /v3/keyboardPwd/delete
Content-Type: application/x-www-form-urlencoded

clientId=xxx&accessToken=xxx&lockId=12345678&keyboardPwdId=987654321&deleteType=2&date=1706620800000
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| lockId | number | Lock ID |
| keyboardPwdId | number | The ID returned when creating |
| deleteType | number | 2 = delete from lock via gateway |

---

### 4. keyboardPwd/list

**Purpose:** Get all passcodes on a lock.

**Request:**
```
POST /v3/keyboardPwd/list
Content-Type: application/x-www-form-urlencoded

clientId=xxx&accessToken=xxx&lockId=12345678&pageNo=1&pageSize=100&date=1706620800000
```

**Response:**
```json
{
  "list": [
    {
      "keyboardPwdId": 987654321,
      "keyboardPwd": "9733",
      "keyboardPwdName": "John Doe",
      "startDate": 1706620800000,
      "endDate": 1706793600000,
      "sendDate": 1706620900000,
      "status": 1
    }
  ]
}
```

**Status Values:**
- 1 = Normal (active)
- 2 = Invalid (deleted/expired)

---

### 5. lock/unlock

**Purpose:** Remote unlock via gateway.

**Request:**
```
POST /v3/lock/unlock
Content-Type: application/x-www-form-urlencoded

clientId=xxx&accessToken=xxx&lockId=12345678&date=1706620800000
```

**Response:**
```json
{
  "errcode": 0,
  "errmsg": "success"
}
```

**Important:** Only works if lock has a gateway connected!

---

### 6. lock/queryOpenState

**Purpose:** Check if lock is online (gateway connected).

**Request:**
```
POST /v3/lock/queryOpenState
Content-Type: application/x-www-form-urlencoded

clientId=xxx&accessToken=xxx&lockId=12345678&date=1706620800000
```

**Response:**
```json
{
  "state": 0
}
```

**State Values:**
- 0 = Locked
- 1 = Unlocked
- 2 = Unknown (no gateway)

---

## Error Codes

### Common Error Codes

| Code | Name | Meaning | Solution |
|------|------|---------|----------|
| 0 | Success | Operation succeeded | - |
| -1 | Failed | General failure | Check request format |
| -3 | Invalid Access Token | Token expired | Refresh token |
| -2011 | Gateway Busy | Gateway processing | Retry after 2 seconds |
| -3003 | Lock Not Exist | Invalid lockId | Check lock ID |
| -3007 | No Permission | No access to lock | Check eKey |
| -3008 | Passcode Exists | Duplicate code | Generate new code |
| -3009 | Passcode Invalid | Wrong format | Use 4-9 digits |

### Retry Strategy for -2011

```typescript
async function callTTLockWithRetry(endpoint, params, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const response = await callTTLock(endpoint, params);
    
    if (response.errcode === -2011) {
      // Gateway busy - wait and retry
      console.log(`Gateway busy, retry ${i + 1}/${retries}`);
      await sleep(2000);
      continue;
    }
    
    if (response.errcode === -3) {
      // Token expired - refresh and retry
      await refreshToken();
      continue;
    }
    
    return response;
  }
  
  throw new Error('Max retries exceeded');
}
```

---

## Passcode Lifecycle

### Create Flow

```
1. Generate unique 4-digit code
2. Calculate validity period:
   - startDate = arrival - 4 hours
   - endDate = departure + 2 hours
3. Push to lock via keyboardPwd/add
4. Store keyboardPwdId in database
5. Update PIN status to 'active'
```

### Delete Flow

```
1. Get keyboardPwdId from database
2. Call keyboardPwd/delete
3. Update PIN status to 'deleted'
4. Log the action
```

### Room Change Flow

```
1. Guest moves from Room A to Room B
2. Get old room's lock IDs
3. Delete passcode from old locks
4. Get new room's lock IDs
5. Push SAME passcode to new locks
6. Update keyboardPwdId references
```

---

## Time Handling

### Unix Milliseconds

TTLock uses Unix timestamps in **milliseconds**:

```typescript
const startDate = arrival.getTime(); // JavaScript Date to Unix ms
const endDate = departure.getTime();
```

### Timezone

All times should be in the **lock's timezone**. TTLock stores the lock's timezone internally.

```typescript
// Convert to lock's local time before sending
const localArrival = zonedTimeToUtc(arrival, 'Europe/Copenhagen');
const startDate = localArrival.getTime();
```

---

## Gateway Requirements

### What is a Gateway?

A WiFi device that connects Bluetooth locks to the internet. Required for:
- Remote unlock
- Remote passcode push/delete
- Real-time status updates

### Gateway Status

Check if lock has gateway:

```typescript
const locks = await ttlock.getLocks();
for (const lock of locks) {
  if (lock.hasGateway === 1) {
    // Can use remote operations
  } else {
    // Bluetooth only - guest must be near lock
  }
}
```

### Fallback for No Gateway

If no gateway:
1. Generate QR code with passcode data
2. Guest scans with TTLock app
3. App pushes passcode via Bluetooth

---

## Rate Limits

TTLock doesn't publish official limits, but observed:

| Operation | Estimated Limit |
|-----------|-----------------|
| Token refresh | 10/minute |
| Lock list | 30/minute |
| Passcode add | 60/minute |
| Passcode delete | 60/minute |
| Remote unlock | 30/minute |

**Best Practice:** Add 100ms delay between rapid operations.

---

## Common Issues

### 1. "Gateway Busy" (-2011)

**Cause:** Gateway is processing another command.

**Solution:** Retry after 2 seconds, max 3 retries.

### 2. "No Permission" (-3007)

**Cause:** Account doesn't have eKey for this lock.

**Solution:** Owner must share eKey to hotel account.

### 3. "Passcode Exists" (-3008)

**Cause:** Same code already active on lock.

**Solution:** Generate different code or delete existing first.

### 4. Token Expires

**Cause:** Access token has 90-day expiry.

**Solution:** Store refresh token, refresh before expiry.

### 5. Lock Offline

**Cause:** Gateway disconnected or battery dead.

**Solution:** 
1. Check `hasGateway` field
2. Check `electricQuantity` for battery
3. Alert staff if offline

---

## Testing

### Sandbox Environment

TTLock doesn't have a separate sandbox. Use a development lock for testing.

### Test Lock Setup

1. Add physical test lock to TTLock app
2. Share eKey with hotel account
3. Use test lock ID in development

### Mock Mode

For unit tests, mock TTLock responses:

```typescript
const mockTTLock = {
  createPasscode: async () => ({ keyboardPwdId: 123456 }),
  deletePasscode: async () => ({ errcode: 0 }),
  getLocks: async () => ({ list: [{ lockId: 1, lockName: 'Test' }] }),
};
```

---

## Security Considerations

1. **Never log passcodes** - Mask in logs: `****` or last 2 digits only
2. **Store credentials encrypted** - Use Replit Secrets
3. **Rotate hotel credentials** - If compromised, regenerate
4. **Audit all operations** - Log who/when/what lock
5. **Use timed passcodes** - Never permanent codes for guests
