# DreamBoks Testing Guide

## End-to-End Flow Overview

```
MEWS Check-in → Webhook → Automation Engine → TTLock Passcode → SMS Notification → Guest
```

## Prerequisites

### 1. Configure TTLock Credentials
Navigate to Settings → TTLock Integration and configure:
- **Client ID**: Your TTLock client ID
- **Access Token**: Generated from TTLock OAuth with MD5(password)
- **Region**: `eu` or `cn`

### 2. Configure Twilio SMS
Navigate to Settings → Communication Gateway and configure:
- **Account SID**: Your Twilio account SID (encrypted)
- **Auth Token**: Your Twilio auth token (encrypted)
- **From Number**: Your Twilio phone number (encrypted)

### 3. Configure MEWS Integration
Navigate to Settings → MEWS Integration and configure:
- **Client Token**: Your MEWS API client token (encrypted)
- **Access Token**: Your MEWS API access token (encrypted)
- **API Endpoint**: MEWS API base URL

### 4. Map Rooms to Locks
Navigate to Spaces → Edit each room:
- Set **PMS ID** to match MEWS resource ID (e.g., "RM-201")
- Set **TTLock ID** to the lock device ID from TTLock system
- Mark **Is DreamBoks** if this capsule uses automation

## Testing Scenarios

### Scenario 1: Manual Passcode Generation

**Purpose**: Test automation engine without MEWS webhook

**Steps**:
1. Go to Reservations page
2. Find a checked-in reservation
3. Click "Generate Passcode" button
4. Verify passcode is created
5. Check Logs page for automation events

**Expected Results**:
- Passcode generated (6 digits)
- TTLock API called (if configured)
- SMS sent to guest (if Twilio configured)
- Logs show: "Passcode created for reservation"
- Reservation log shows "Passcode generated"

**API Test**:
```bash
curl -X POST http://localhost:5000/api/automation/generate-passcode/{reservationId}
```

### Scenario 2: MEWS Webhook Integration

**Purpose**: Test automatic passcode generation on check-in

**Steps**:
1. Configure MEWS webhook to point to: `https://your-domain.replit.app/api/webhooks/mews`
2. Check in a guest in MEWS
3. MEWS sends webhook event
4. Verify automation creates passcode
5. Guest receives SMS with passcode

**Expected Results**:
- Webhook received: Log shows "MEWS webhook received"
- Reservation synced: Status = "Checked-in", roomId mapped
- Passcode created: 6-digit code generated
- TTLock updated: Passcode active on lock
- SMS delivered: Guest receives welcome message with code
- Reservation log timeline shows all events

**Webhook Payload Example**:
```json
{
  "Events": [{
    "Id": "event-123",
    "Type": "Reservation",
    "State": "Processed",
    "StartUtc": "2025-11-23T10:00:00Z",
    "EndUtc": "2025-11-23T10:00:01Z"
  }]
}
```

### Scenario 3: Checkout Flow

**Purpose**: Test passcode deletion on checkout

**Steps**:
1. Check out a guest in MEWS
2. MEWS sends webhook event (state=Checked-out)
3. Verify passcode is deleted from TTLock
4. Verify database is cleaned up

**Expected Results**:
- Passcode deleted from TTLock
- Reservation.generatedPin = null
- Reservation log shows "Passcode deleted"
- Logs show "Passcode deleted for reservation"

### Scenario 4: Error Handling

**Purpose**: Test system resilience

**Test Cases**:

1. **No Room Mapped**
   - Create reservation without roomId
   - Attempt passcode generation
   - Expected: Error "No room assigned to reservation"

2. **Room Has No Lock**
   - Map reservation to room without ttlockId
   - Attempt passcode generation
   - Expected: Error "Room has no lock configured"

3. **TTLock API Failure**
   - Provide invalid TTLock credentials
   - Attempt passcode generation
   - Expected: Error logged, operation fails gracefully

4. **Twilio SMS Failure**
   - Provide invalid Twilio credentials
   - Generate passcode (should succeed)
   - Expected: Passcode created, SMS fails gracefully, warning logged

## Validation Checklist

### Data Integrity
- [ ] Room PMS IDs match MEWS resource IDs exactly
- [ ] Room TTLock IDs match lock device IDs in TTLock
- [ ] Reservations have valid roomId after webhook processing
- [ ] Generated passcodes are 6 digits (TTLock requirement)
- [ ] Passcode dates match reservation arrival/departure

### Automation Flow
- [ ] MEWS webhook endpoint accessible
- [ ] Webhook processes reservation events
- [ ] Room mapping logic works (PMS ID → roomId → ttlockId)
- [ ] Passcode generation is idempotent (no duplicates)
- [ ] Checkout deletes passcode correctly
- [ ] Logs capture every step

### Notification Delivery
- [ ] SMS sent to guest mobile number
- [ ] Message includes: passcode, room, dates, confirmation code
- [ ] Message format is user-friendly
- [ ] Failed SMS logged but doesn't block passcode creation
- [ ] Twilio errors show specific error codes

### Security
- [ ] All credentials encrypted in database
- [ ] Settings API sanitizes encrypted fields (returns "********")
- [ ] TTLock access token never exposed in logs
- [ ] Twilio credentials never exposed in API responses

## Common Issues

### "TTLock credentials not configured"
**Solution**: Go to Settings → TTLock Integration and configure credentials

### "Notification gateway not configured"
**Solution**: Go to Settings → Communication Gateway and configure Twilio

### "No room assigned to reservation"
**Solution**: 
1. Check room has correct PMS ID in Spaces page
2. Verify MEWS webhook is sending resource ID
3. Check reservation.roomId in database

### "Room has no lock configured"
**Solution**: Edit room in Spaces page and set TTLock ID

### Passcode not working on lock
**Possible Causes**:
1. Lock time not synchronized
2. Passcode dates don't cover check-in time
3. Lock firmware outdated
4. TTLock gateway offline

## Monitoring & Debugging

### Check System Logs
```
GET /api/logs?limit=50&source=automation
```

Shows all automation engine activities:
- Passcode creation/deletion
- TTLock API calls
- Notification delivery
- Errors and warnings

### Check Reservation Logs
```
GET /api/reservations/{id}/logs
```

Shows timeline for specific reservation:
- Webhook received
- Room mapped
- Passcode generated
- Notification sent
- Passcode deleted

### Check TTLock Passcodes
```
GET /api/automation/list-passcodes/{lockId}
```

Lists all active passcodes on a lock device

## Production Readiness

### Before Going Live
1. ✅ Configure production TTLock credentials
2. ✅ Configure production Twilio credentials  
3. ✅ Map all rooms to locks
4. ✅ Set up MEWS webhook URL in MEWS dashboard
5. ✅ Test end-to-end flow with test reservation
6. ✅ Verify SMS delivery to real phone number
7. ✅ Test checkout flow removes passcodes
8. ✅ Monitor logs for 24 hours

### Known Limitations (MVP)
- **No email notifications**: Only SMS implemented
- **No retry logic**: Failed TTLock/SMS calls not retried
- **Manual cleanup**: Orphaned passcodes require manual intervention
- **No distributed transactions**: TTLock + DB updates not atomic

### Future Enhancements
- Email notification channel
- Retry queue for failed operations
- Saga pattern for distributed consistency
- Integration tests for partial failures
- Dashboard for notification delivery status
- SMS-only mode indicator in UI
