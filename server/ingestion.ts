import { z } from "zod";
import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";

export const NormalizedGuestSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email().optional().nullable(),
  mobile: z.string().optional().nullable(),
});

export const NormalizedReservationSchema = z.object({
  pmsReservationId: z.string().min(1),
  confirmationNumber: z.string().optional().nullable(),
  channelNumber: z.string().optional().nullable(),
  channelManagerNumber: z.string().optional().nullable(),
  status: z.enum(["Confirmed", "CheckedIn", "CheckedOut", "Cancelled"]),
  arrival: z.string().datetime(),
  departure: z.string().datetime(),
  guest: NormalizedGuestSchema,
  roomPmsId: z.string().optional().nullable(),
  roomName: z.string().optional().nullable(),
  bedName: z.string().optional().nullable(),
  adults: z.number().int().min(0).default(1),
  children: z.number().int().min(0).default(0),
  groupName: z.string().optional().nullable(),
  requestedCategory: z.string().optional().nullable(),
  spaceCategory: z.string().optional().nullable(),
  rateName: z.string().optional().nullable(),
  avgRate: z.string().optional().nullable(),
  totalAmount: z.string().optional().nullable(),
  currency: z.string().optional().nullable(),
  owing: z.string().optional().nullable(),
  origin: z.string().optional().nullable(),
  reservationSource: z.string().optional().nullable(),
  pmsCustomerId: z.string().optional().nullable(),
});

export const NormalizedRoomSchema = z.object({
  pmsRoomId: z.string().min(1),
  name: z.string().min(1),
  category: z.string().optional().nullable(),
  state: z.enum(["Active", "Inactive", "Deleted"]).default("Active"),
});

export const ReservationUpsertedEventSchema = z.object({
  eventType: z.literal("reservation.upserted"),
  eventId: z.string().uuid(),
  timestamp: z.string().datetime(),
  tenantId: z.string().uuid(),
  pmsType: z.enum(["mews", "opera", "protel", "cloudbeds", "other"]),
  data: NormalizedReservationSchema,
});

export const ReservationStatusChangedEventSchema = z.object({
  eventType: z.literal("reservation.status_changed"),
  eventId: z.string().uuid(),
  timestamp: z.string().datetime(),
  tenantId: z.string().uuid(),
  pmsType: z.enum(["mews", "opera", "protel", "cloudbeds", "other"]),
  data: z.object({
    pmsReservationId: z.string().min(1),
    previousStatus: z.enum(["Confirmed", "CheckedIn", "CheckedOut", "Cancelled"]).optional(),
    newStatus: z.enum(["Confirmed", "CheckedIn", "CheckedOut", "Cancelled"]),
  }),
});

export const RoomSyncEventSchema = z.object({
  eventType: z.literal("room.sync"),
  eventId: z.string().uuid(),
  timestamp: z.string().datetime(),
  tenantId: z.string().uuid(),
  pmsType: z.enum(["mews", "opera", "protel", "cloudbeds", "other"]),
  data: z.object({
    rooms: z.array(NormalizedRoomSchema),
  }),
});

export const IngestionEventSchema = z.discriminatedUnion("eventType", [
  ReservationUpsertedEventSchema,
  ReservationStatusChangedEventSchema,
  RoomSyncEventSchema,
]);

export const IngestionBatchSchema = z.object({
  events: z.array(IngestionEventSchema).min(1).max(100),
  idempotencyKey: z.string().min(1),
});

export type NormalizedGuest = z.infer<typeof NormalizedGuestSchema>;
export type NormalizedReservation = z.infer<typeof NormalizedReservationSchema>;
export type NormalizedRoom = z.infer<typeof NormalizedRoomSchema>;
export type ReservationUpsertedEvent = z.infer<typeof ReservationUpsertedEventSchema>;
export type ReservationStatusChangedEvent = z.infer<typeof ReservationStatusChangedEventSchema>;
export type RoomSyncEvent = z.infer<typeof RoomSyncEventSchema>;
export type IngestionEvent = z.infer<typeof IngestionEventSchema>;
export type IngestionBatch = z.infer<typeof IngestionBatchSchema>;

const SIGNATURE_HEADER = "x-dreamboks-signature";
const TIMESTAMP_HEADER = "x-dreamboks-timestamp";
const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;

export function verifyHmacSignature(
  payload: string,
  signature: string,
  timestamp: string,
  secret: string
): boolean {
  const signedPayload = `${timestamp}.${payload}`;
  const expectedSignature = createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");
  
  const signatureBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expectedSignature, "hex");
  
  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }
  
  return timingSafeEqual(signatureBuffer, expectedBuffer);
}

export function createHmacSignatureMiddleware(getSecret: (tenantId: string) => Promise<string | null>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const signature = req.headers[SIGNATURE_HEADER] as string | undefined;
    const timestamp = req.headers[TIMESTAMP_HEADER] as string | undefined;
    
    if (!signature || !timestamp) {
      return res.status(401).json({ 
        error: "Missing signature headers",
        required: [SIGNATURE_HEADER, TIMESTAMP_HEADER]
      });
    }
    
    const timestampMs = parseInt(timestamp, 10);
    if (isNaN(timestampMs)) {
      return res.status(401).json({ error: "Invalid timestamp format" });
    }
    
    const now = Date.now();
    if (Math.abs(now - timestampMs) > MAX_TIMESTAMP_DRIFT_MS) {
      return res.status(401).json({ 
        error: "Timestamp too old or in future",
        maxDriftSeconds: MAX_TIMESTAMP_DRIFT_MS / 1000
      });
    }
    
    const body = req.body as IngestionBatch;
    if (!body.events || body.events.length === 0) {
      return res.status(400).json({ error: "No events in batch" });
    }
    
    const tenantId = body.events[0].tenantId;
    
    const allSameTenant = body.events.every(e => e.tenantId === tenantId);
    if (!allSameTenant) {
      return res.status(400).json({ error: "All events in batch must be for the same tenant" });
    }
    
    const secret = await getSecret(tenantId);
    if (!secret) {
      return res.status(401).json({ error: "Unknown tenant or missing webhook secret" });
    }
    
    const rawBody = JSON.stringify(req.body);
    const isValid = verifyHmacSignature(rawBody, signature, timestamp, secret);
    
    if (!isValid) {
      return res.status(401).json({ error: "Invalid signature" });
    }
    
    (req as any).tenantId = tenantId;
    next();
  };
}

export function mapMewsStatusToNormalized(mewsState: string): "Confirmed" | "CheckedIn" | "CheckedOut" | "Cancelled" {
  switch (mewsState) {
    case "Confirmed":
      return "Confirmed";
    case "Started":
      return "CheckedIn";
    case "Processed":
      return "CheckedOut";
    case "Canceled":
      return "Cancelled";
    default:
      return "Confirmed";
  }
}

export function mapNormalizedStatusToInternal(status: string): string {
  switch (status) {
    case "Confirmed":
      return "Confirmed";
    case "CheckedIn":
      return "Checked-in";
    case "CheckedOut":
      return "Checked-out";
    case "Cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

export const processedIdempotencyKeys = new Map<string, { timestamp: number; result: any }>();

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export function checkIdempotency(key: string): { isDuplicate: boolean; cachedResult?: any } {
  const cached = processedIdempotencyKeys.get(key);
  if (cached) {
    if (Date.now() - cached.timestamp < IDEMPOTENCY_TTL_MS) {
      return { isDuplicate: true, cachedResult: cached.result };
    }
    processedIdempotencyKeys.delete(key);
  }
  return { isDuplicate: false };
}

export function storeIdempotencyResult(key: string, result: any): void {
  processedIdempotencyKeys.set(key, { timestamp: Date.now(), result });
  
  if (processedIdempotencyKeys.size > 10000) {
    const now = Date.now();
    const keysToDelete: string[] = [];
    processedIdempotencyKeys.forEach((v, k) => {
      if (now - v.timestamp > IDEMPOTENCY_TTL_MS) {
        keysToDelete.push(k);
      }
    });
    keysToDelete.forEach(k => processedIdempotencyKeys.delete(k));
  }
}
