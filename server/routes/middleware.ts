import type { Request, Response, NextFunction } from "express";
import { Storage, DEFAULT_TENANT_ID, type ITenantStorage, globalTenantStorage, db } from "../storage";
import { tenants as tenantsTable } from "@shared/schema";
import { eq } from "drizzle-orm";
import { ZodSchema } from "zod";
import rateLimit from "express-rate-limit";

// Session data shape returned by verifyHotelToken
export interface HotelSessionData {
  userId: string;
  tenantId: string;
}

// --- Session Verification (DB-backed) ---

export async function verifyHotelToken(req: Request): Promise<HotelSessionData | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.substring(7);
  const session = await globalTenantStorage.getSessionByToken(token);
  if (!session || session.role !== "hotel_user" || !session.userId || !session.tenantId) {
    return null;
  }
  return { userId: session.userId, tenantId: session.tenantId };
}

export async function verifyAdminToken(req: Request): Promise<boolean> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.substring(7);
  const session = await globalTenantStorage.getSessionByToken(token);
  return session !== null && session.role === "admin";
}

// Quick Setup onboarding runs from the invitation link before a hotel_user
// session exists. A valid, unused, non-expired invitation token (sent as the
// `x-setup-token` header) authorizes calls ONLY for its own tenant — the
// request's x-tenant-id must match the invitation's tenant.
export async function verifySetupToken(req: Request): Promise<HotelSessionData | null> {
  const token = req.headers["x-setup-token"] as string | undefined;
  if (!token) {
    return null;
  }
  const invitation = await globalTenantStorage.getInvitationByToken(token);
  if (!invitation || invitation.usedAt) {
    return null;
  }
  if (new Date() > invitation.expiresAt) {
    return null;
  }
  await refreshTenantCache();
  if (invitation.tenantId !== resolveTenantId(req)) {
    return null;
  }
  return { userId: `setup:${invitation.id}`, tenantId: invitation.tenantId };
}

// Accept either a logged-in hotel_user session or a valid setup token.
// Used by the endpoints the Quick Setup wizard needs before login.
export async function verifyHotelOrSetupToken(req: Request): Promise<HotelSessionData | null> {
  const hotelSession = await verifyHotelToken(req);
  if (hotelSession) {
    return hotelSession;
  }
  return verifySetupToken(req);
}

// --- Tenant Resolution ---

let validTenantIds: Set<string> = new Set([DEFAULT_TENANT_ID]);
let tenantCacheLastRefresh = 0;
let tenantCacheInitialized = false;
const TENANT_CACHE_TTL = 60000;

export async function refreshTenantCache(): Promise<void> {
  const now = Date.now();
  if (tenantCacheInitialized && now - tenantCacheLastRefresh < TENANT_CACHE_TTL) return;

  try {
    const { tenantDirectory } = await import("../tenant-directory");
    const tenants = await tenantDirectory.listActiveTenants();
    validTenantIds = new Set(tenants.map(t => t.id));
    validTenantIds.add(DEFAULT_TENANT_ID);
    tenantCacheLastRefresh = now;
    tenantCacheInitialized = true;
  } catch (error) {
    console.error("Failed to refresh tenant cache:", error);
    validTenantIds.add(DEFAULT_TENANT_ID);
  }
}

// Initialize and periodically refresh
refreshTenantCache().catch(console.error);
setInterval(() => {
  refreshTenantCache().catch(console.error);
}, TENANT_CACHE_TTL);

export async function resolveTenantIdAsync(req: Request): Promise<string> {
  await refreshTenantCache();

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("ApiKey ")) {
    const apiKey = authHeader.substring(7);
    const { tenantDirectory } = await import("../tenant-directory");
    const tenant = await tenantDirectory.getTenantByApiKey(apiKey);
    if (tenant) {
      return tenant.id;
    }
  }

  const headerTenantId = req.headers['x-tenant-id'] as string;
  if (headerTenantId && headerTenantId.length > 0) {
    if (validTenantIds.has(headerTenantId)) {
      return headerTenantId;
    }
    console.warn(`Invalid x-tenant-id header: ${headerTenantId.substring(0, 8)}...`);
  }

  return DEFAULT_TENANT_ID;
}

export function resolveTenantId(req: Request): string {
  const headerTenantId = req.headers['x-tenant-id'] as string;
  if (headerTenantId && headerTenantId.length > 0) {
    if (validTenantIds.has(headerTenantId)) {
      return headerTenantId;
    }
    console.warn(`Invalid x-tenant-id header: ${headerTenantId.substring(0, 8)}...`);
  }
  return DEFAULT_TENANT_ID;
}

export function getTenantStorage(req: Request): ITenantStorage {
  const tenantId = resolveTenantId(req);
  return Storage.forTenant(tenantId);
}

export async function getTenantStorageAsync(req: Request): Promise<ITenantStorage> {
  // Check hotel session first
  const session = await verifyHotelToken(req);
  if (session) {
    return Storage.forTenant(session.tenantId);
  }
  const tenantId = resolveTenantId(req);
  return Storage.forTenant(tenantId);
}

// --- Utilities ---

export const ENCRYPTED_SETTING_KEYS = [
  "ttlock_api_key",
  "ttlock_username",
  "ttlock_password",
  "mews_client_token",
  "mews_access_token",
  "gateway_api_key",
  "twilio_account_sid",
  "twilio_auth_token",
  "twilio_from_number",
];

export function isEncryptedKey(key: string): boolean {
  return ENCRYPTED_SETTING_KEYS.includes(key);
}

export async function isDatabaseReady(): Promise<boolean> {
  try {
    const { pool } = await import("../db");
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('DB timeout')), 5000)
    );
    await Promise.race([pool.query('SELECT 1'), timeoutPromise]);
    return true;
  } catch (error) {
    console.log("[DB] Database not ready:", (error as Error).message);
    return false;
  }
}

// --- Request Validation Middleware ---

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: result.error.flatten().fieldErrors,
      });
    }
    req.body = result.data;
    next();
  };
}

// --- Rate Limiting ---

export const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many login attempts. Please try again in 15 minutes." },
});

export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
});

export const findReservationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many lookup attempts. Please try again in an hour." },
});

// Kiosk door-code lookup: the wall tablet is ONE shared IP serving every
// arriving guest, so the 10/hour findReservationLimiter would lock the whole
// hostel out on a busy day. Brute force is bounded by requiring a correct
// last name + arrival date and by physical presence at the kiosk.
export const kioskLookupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many lookup attempts. Please contact reception." },
});

// Early check-in payment polling: the kiosk polls every ~4s while the guest
// pays on their phone (up to 30 min). MUST NOT share the kioskLookupLimiter —
// the kiosk is one IP, and polling would exhaust the door-code lookup budget.
export const earlyCheckinStatusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many status checks. Please wait a moment." },
});

// Arrivals page polling (30s per open tab, share link + in-app). MUST NOT
// share the publicLimiter — that budget also gates /api/public/unlock, and
// staff tabs on the hotel-WiFi NAT would 429 a guest's door-unlock (same
// hazard the hourly and early-checkin limiters were split off for). Budget
// fits several simultaneously open tabs; token brute-force stays infeasible
// (64-hex keyspace, and the shape pre-check rejects junk before the DB loop).
export const arrivalsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment." },
});
