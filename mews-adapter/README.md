# MEWS Adapter for DreamBoks

This adapter fetches reservations from MEWS PMS and sends normalized events to DreamBoks Core.

## Setup

### 1. Install dependencies

```bash
cd mews-adapter
npm install
```

### 2. Configure environment variables

Create a `.env` file or set these environment variables:

```bash
# MEWS Credentials
MEWS_CLIENT_TOKEN=your-client-token
MEWS_ACCESS_TOKEN=your-access-token
MEWS_ENVIRONMENT=demo  # or "production"
MEWS_POLL_INTERVAL_MS=60000  # 60 seconds

# DreamBoks Core Connection
DREAMBOKS_CORE_URL=https://your-dreamboks-core.replit.app
DREAMBOKS_TENANT_ID=your-tenant-uuid
DREAMBOKS_WEBHOOK_SECRET=your-ingestion-webhook-secret
```

### 3. Run the adapter

```bash
npm run dev
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Basic info and config status |
| `/status` | GET | Polling status, last sync time, error count |
| `/poll-now` | POST | Trigger immediate poll |
| `/start` | POST | Start the poller |
| `/stop` | POST | Stop the poller |

## How it works

1. **Poller** fetches reservations from MEWS API every 60 seconds (configurable)
2. **Converter** transforms MEWS data to normalized event format
3. **Ingestion Client** sends events to DreamBoks Core via `POST /api/ingest`
4. Events are signed with HMAC-SHA256 for security

## Moving to Production

1. Create a new Replit project
2. Copy the contents of this folder to the new project
3. Configure the environment variables
4. Deploy the adapter

The adapter will run independently and sync data to your DreamBoks Core instance.
