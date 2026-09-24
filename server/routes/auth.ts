import type { Express, Request, Response } from "express";
import crypto from "crypto";
import type { RouteContext } from "./index";
import { verifyHotelToken, getTenantStorage, authLimiter, validate } from "./middleware";
import { globalTenantStorage, Storage } from "../storage";
import { loginSchema } from "@shared/validation";

// Rate limiting for login attempts (IP + email scoped, in-memory)
const loginAttempts = new Map<string, { count: number; blockedUntil: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const BLOCK_DURATION = 15 * 60 * 1000; // 15 minutes

function cleanupLoginAttempts() {
  const now = Date.now();
  Array.from(loginAttempts.entries()).forEach(([key, data]) => {
    if (data.blockedUntil < now && data.count === 0) {
      loginAttempts.delete(key);
    }
  });
}

export function registerAuthRoutes(app: Express, ctx: RouteContext) {
  // =====================================================
  // Hotel Authentication Endpoints
  // =====================================================

  // Hotel user login
  app.post("/api/auth/login", authLimiter, validate(loginSchema), async (req: Request, res: Response) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    const attemptKey = `${clientIp}:${email.toLowerCase()}`;
    const now = Date.now();

    // Check rate limit
    const attempts = loginAttempts.get(attemptKey);
    if (attempts && attempts.blockedUntil > now) {
      const remainingMinutes = Math.ceil((attempts.blockedUntil - now) / 60000);
      return res.status(429).json({
        error: `Too many login attempts. Please try again in ${remainingMinutes} minutes.`,
      });
    }

    try {
      const user = await globalTenantStorage.getHotelUserByEmail(email);

      // Track failed attempt helper
      const trackFailedAttempt = () => {
        const current = loginAttempts.get(attemptKey) || { count: 0, blockedUntil: 0 };
        current.count++;
        if (current.count >= MAX_LOGIN_ATTEMPTS) {
          current.blockedUntil = Date.now() + BLOCK_DURATION;
          current.count = 0;
        }
        loginAttempts.set(attemptKey, current);
        cleanupLoginAttempts();
      };

      if (!user || !user.active) {
        trackFailedAttempt();
        return res.status(401).json({ error: "Invalid email or password" });
      }

      // Verify password using crypto scrypt
      const [salt, hash] = user.passwordHash.split(":");
      const hashBuffer = Buffer.from(hash, "hex");

      const derivedKey = await new Promise<Buffer>((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (err, key) => {
          if (err) reject(err);
          else resolve(key);
        });
      });

      if (!crypto.timingSafeEqual(hashBuffer, derivedKey)) {
        trackFailedAttempt();
        return res.status(401).json({ error: "Invalid email or password" });
      }

      // Clear failed attempts on successful login
      loginAttempts.delete(attemptKey);

      // Generate session token
      const token = crypto.randomBytes(32).toString("hex");

      // Create DB-backed session
      await globalTenantStorage.createSession({
        token,
        userId: user.id,
        tenantId: user.tenantId,
        role: "hotel_user",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      // Update last login
      await globalTenantStorage.updateHotelUserLastLogin(user.id);

      // Get tenant info
      const tenant = await globalTenantStorage.getTenant(user.tenantId);
      // Expose the per-tenant hotel slug so admin-built boarding-pass links can be
      // scoped to the correct tenant (the public /boarding-pass page needs ?hotel=).
      const hotelSlug = tenant ? (await Storage.forTenant(tenant.id).getSetting("hotel_slug"))?.value ?? null : null;

      res.json({
        success: true,
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
        hotel: tenant ? { id: tenant.id, name: tenant.name, slug: hotelSlug } : null,
      });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // Hotel user logout
  app.post("/api/auth/logout", async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      await globalTenantStorage.deleteSession(token);
    }
    res.json({ success: true });
  });

  // Get current hotel user session
  app.get("/api/auth/session", async (req: Request, res: Response) => {
    const session = await verifyHotelToken(req);
    if (!session) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const user = await globalTenantStorage.getHotelUser(session.userId);
      if (!user || !user.active) {
        return res.status(401).json({ error: "User not found or inactive" });
      }

      const tenant = await globalTenantStorage.getTenant(session.tenantId);
      const hotelSlug = tenant ? (await Storage.forTenant(tenant.id).getSetting("hotel_slug"))?.value ?? null : null;

      res.json({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
        hotel: tenant ? { id: tenant.id, name: tenant.name, slug: hotelSlug } : null,
      });
    } catch (error) {
      console.error("Session check error:", error);
      res.status(500).json({ error: "Session check failed" });
    }
  });
}
