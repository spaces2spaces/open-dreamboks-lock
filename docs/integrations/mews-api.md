# MEWS Connector API Integration

## Overview

MEWS is a cloud-based Property Management System (PMS). DreamBoks uses the MEWS Connector API to sync reservations, rooms, and guest data.

---

## Authentication

### Credentials

| Credential | Description | Where to get |
|------------|-------------|--------------|
| `ClientToken` | Identifies the integration partner | MEWS Marketplace after app approval |
| `AccessToken` | Identifies the specific hotel property | Hotel provides after installing integration |

### Environments

| Environment | Base URL |
|-------------|----------|
| Demo | `https://api.mews-demo.com` |
| Production | `https://api.mews.com` |

### Request Format

All requests are `POST` with JSON body:

```typescript
const response = await fetch(`${baseUrl}/api/connector/v1/${endpoint}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    ClientToken: clientToken,
    AccessToken: accessToken,
    Client: 'DreamBoks Integration',
    ...requestBody,
  }),
});
```

---

## Endpoints Used by DreamBoks

### 1. reservations/getAll

**Purpose:** Fetch all reservations within a date range.

**Request:**
```json
{
  "ClientToken": "...",
  "AccessToken": "...",
  "Client": "DreamBoks Integration",
  "StartUtc": "2025-01-01T00:00:00Z",
  "EndUtc": "2025-01-31T23:59:59Z",
  "States": ["Confirmed", "Started"],
  "Extent": {
    "Reservations": true,
    "ReservationGroups": true,
    "Customers": true,
    "Resources": true
  }
}
```

**Key Fields:**
- `StartUtc` / `EndUtc`: Date range for arrival dates
- `States`: Filter by reservation state
- `Extent`: What related data to include

**Response Structure:**
```json
{
  "Reservations": [
    {
      "Id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "Number": "123",
      "State": "Confirmed",
      "StartUtc": "2025-01-15T14:00:00Z",
      "EndUtc": "2025-01-17T11:00:00Z",
      "AssignedResourceId": "resource-uuid",
      "CustomerId": "customer-uuid",
      "GroupId": "group-uuid",
      "AdultCount": 1,
      "ChildCount": 0
    }
  ],
  "Customers": [...],
  "Resources": [...]
}
```

**State Mapping:**

| MEWS State | DreamBoks Status |
|------------|------------------|
| `Confirmed` | Confirmed |
| `Started` | Checked-in |
| `Processed` | Checked-out |
| `Canceled` | Cancelled |
| `Optional` | Optional |
| `Enquired` | Enquired |

---

### 2. resources/getAll

**Purpose:** Fetch all rooms/beds (called "Resources" in MEWS).

**Request:**
```json
{
  "ClientToken": "...",
  "AccessToken": "...",
  "Client": "DreamBoks Integration",
  "Extent": {
    "Resources": true,
    "ResourceCategories": true
  }
}
```

**Response:**
```json
{
  "Resources": [
    {
      "Id": "resource-uuid",
      "Name": "Room 113.7",
      "ParentResourceId": "parent-uuid",
      "State": "Active",
      "FloorNumber": "1",
      "Capacity": 1
    }
  ],
  "ResourceCategories": [
    {
      "Id": "category-uuid",
      "Name": "Dormitory Bed",
      "Capacity": 1
    }
  ]
}
```

**Important:** In hostels, a "Resource" is typically a bed, not a room. The `ParentResourceId` links beds to their parent room.

---

### 3. customers/getAll

**Purpose:** Fetch guest details.

**Request:**
```json
{
  "ClientToken": "...",
  "AccessToken": "...",
  "Client": "DreamBoks Integration",
  "CustomerIds": ["customer-uuid-1", "customer-uuid-2"]
}
```

**Response:**
```json
{
  "Customers": [
    {
      "Id": "customer-uuid",
      "FirstName": "John",
      "LastName": "Doe",
      "Email": "john@example.com",
      "Phone": "+45123456789",
      "NationalityCode": "DK"
    }
  ]
}
```

---

### 4. reservations/start

**Purpose:** Check in a guest (change state to Started).

**Request:**
```json
{
  "ClientToken": "...",
  "AccessToken": "...",
  "Client": "DreamBoks Integration",
  "ReservationIds": ["reservation-uuid"]
}
```

**Response:**
```json
{
  "Reservations": [
    {
      "Id": "reservation-uuid",
      "State": "Started"
    }
  ]
}
```

---

### 5. reservations/cancel

**Purpose:** Cancel a reservation.

**Request:**
```json
{
  "ClientToken": "...",
  "AccessToken": "...",
  "Client": "DreamBoks Integration",
  "ReservationIds": ["reservation-uuid"],
  "Notes": "Guest requested cancellation"
}
```

---

### 6. serviceOrderNotes/add

**Purpose:** Add a note to a reservation (e.g., PIN code).

**Request:**
```json
{
  "ClientToken": "...",
  "AccessToken": "...",
  "Client": "DreamBoks Integration",
  "ServiceOrderId": "reservation-uuid",
  "Text": "Door PIN: 9733"
}
```

---

### 7. payments/getAll

**Purpose:** Check payment status for reservations.

**Request:**
```json
{
  "ClientToken": "...",
  "AccessToken": "...",
  "Client": "DreamBoks Integration",
  "ReservationIds": ["reservation-uuid"]
}
```

---

### 8. paymentrequests/add

**Purpose:** Create a payment request (used for Booking.com reservations).

**Request:**
```json
{
  "ClientToken": "...",
  "AccessToken": "...",
  "Client": "DreamBoks Integration",
  "ReservationId": "reservation-uuid",
  "Amount": {
    "Currency": "EUR",
    "GrossValue": 50.00
  },
  "Reason": "Remaining balance",
  "ExpirationUtc": "2025-01-15T12:00:00Z"
}
```

---

## Data Mapping

### Reservation Number

MEWS uses `Number` field, but it's just a sequential number. For unique identification:

```typescript
const reservationNumber = `RES-${reservation.Number}`;
// or use reservation.Id directly
```

### Room/Bed Mapping

MEWS structure for hostels:

```
Room 113 (Parent Resource)
├── Bed 113.1 (Resource)
├── Bed 113.2 (Resource)
├── Bed 113.3 (Resource)
└── ... etc
```

DreamBoks maps:
- `Resource.Name` → `room.name` (e.g., "Room 113.7" includes bed number)
- `Resource.ParentResourceId` → Used to group beds

### Customer Phone Number

MEWS stores phone in multiple formats. Normalize:

```typescript
const mobile = customer.Phone?.replace(/\s/g, '') || null;
```

---

## Polling Strategy

### Current Implementation

```typescript
// Poll every 60 seconds
const POLL_INTERVAL = 60 * 1000;

async function syncReservations() {
  const now = new Date();
  const startDate = subDays(now, 1); // Yesterday
  const endDate = addDays(now, 30);  // 30 days ahead
  
  const reservations = await mewsClient.getReservations({
    startDate,
    endDate,
    states: ['Confirmed', 'Started'],
  });
  
  for (const reservation of reservations) {
    await upsertReservation(reservation);
  }
}
```

### Webhook Alternative (Future)

MEWS supports webhooks for real-time updates:

| Webhook | Event |
|---------|-------|
| `ServiceOrderUpdated` | Reservation created/modified |
| `CustomerUpdated` | Guest profile changed |
| `PaymentUpdated` | Payment received |

---

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| 401 Unauthorized | Invalid tokens | Check AccessToken is correct |
| 400 Bad Request | Invalid request body | Validate request format |
| 429 Too Many Requests | Rate limited | Add exponential backoff |
| 500 Server Error | MEWS issue | Retry after delay |

### Retry Strategy

```typescript
async function callMewsWithRetry(endpoint, body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await callMews(endpoint, body);
      return response;
    } catch (error) {
      if (error.status === 429 || error.status >= 500) {
        await sleep(2000 * (i + 1)); // Exponential backoff
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Failed after ${retries} retries`);
}
```

---

## Rate Limits

MEWS doesn't publish specific rate limits, but:
- Keep polling to 1 request per minute max
- Batch customer lookups (use arrays of IDs)
- Cache resource data (rooms don't change often)

---

## Testing

### Demo Environment

Use MEWS demo environment for testing:
- Base URL: `https://api.mews-demo.com`
- Demo hotels available in MEWS Marketplace
- Test reservations can be created in MEWS Commander

### Sample Test Request

```bash
curl -X POST https://api.mews-demo.com/api/connector/v1/reservations/getAll \
  -H "Content-Type: application/json" \
  -d '{
    "ClientToken": "YOUR_CLIENT_TOKEN",
    "AccessToken": "YOUR_ACCESS_TOKEN",
    "Client": "DreamBoks Integration",
    "StartUtc": "2025-01-01T00:00:00Z",
    "EndUtc": "2025-01-31T23:59:59Z",
    "States": ["Confirmed"]
  }'
```

---

## Quirks & Gotchas

1. **Resources vs Rooms**: In MEWS, everything is a "Resource". Beds are resources with a parent room.

2. **Reservation Groups**: Multiple beds booked together share a `GroupId`.

3. **Time Zones**: All times are UTC. Convert to hotel timezone for display.

4. **State Machine**: Reservations flow: `Optional` → `Confirmed` → `Started` → `Processed`

5. **Extent Parameter**: Always specify which related data you need. Without it, you only get IDs.

6. **Customer Phone**: May be empty even for confirmed reservations. Handle gracefully.

7. **Number Field**: Is NOT unique across the system. Use `Id` for unique identification.
