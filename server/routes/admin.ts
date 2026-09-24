import type { Express, Request, Response } from "express";
import { config } from "../config";
import crypto from "crypto";
import type { RouteContext } from "./index";
import { verifyAdminToken, getTenantStorage, validate } from "./middleware";
import { globalTenantStorage, Storage } from "../storage";
import { adminPinSchema, adminLoginSchema, createTenantSchema, createInvitationSchema, createHotelUserSchema } from "@shared/validation";

const VENDOR_USERNAME = process.env.VENDOR_ADMIN_USERNAME || "admin";
const VENDOR_PASSWORD = process.env.VENDOR_ADMIN_PASSWORD || "";

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Always do a constant-time comparison to prevent timing oracle attacks.
  // If lengths differ, compare bufA against a dummy of bufB's length so the
  // timing path is the same regardless of which branch is taken.
  if (bufA.length !== bufB.length) {
    const dummy = Buffer.alloc(bufB.length);
    crypto.timingSafeEqual(Buffer.from(a.substring(0, bufB.length).padEnd(bufB.length, "\0")), dummy);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function registerAdminRoutes(app: Express, ctx: RouteContext) {
  // =====================================================
  // Admin Endpoints (Owner-level access - credentials protected)
  // =====================================================

  // Login with username + password, issue session token
  app.post("/api/admin/login", validate(adminLoginSchema), async (req: Request, res: Response) => {
    if (!VENDOR_PASSWORD) {
      return res.status(503).json({
        error: "Vendor admin not configured. Set VENDOR_ADMIN_USERNAME and VENDOR_ADMIN_PASSWORD environment variables.",
      });
    }

    const { username, password } = req.body;

    const usernameOk = timingSafeStringEqual(username, VENDOR_USERNAME);
    const passwordOk = timingSafeStringEqual(password, VENDOR_PASSWORD);

    if (!usernameOk || !passwordOk) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = crypto.randomBytes(32).toString("hex");

    await globalTenantStorage.createSession({
      token,
      role: "admin",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    res.json({ success: true, token });
  });

  // Verify existing admin token is still valid
  app.get("/api/admin/verify-token", async (req: Request, res: Response) => {
    const valid = await verifyAdminToken(req);
    if (!valid) {
      return res.status(401).json({ valid: false, error: "Invalid or expired token" });
    }
    res.json({ valid: true });
  });

  // ===============================================================
  // Vendor Admin: Tenant Management APIs (requires admin token)
  // ===============================================================

  // List all tenants with basic info
  app.get("/api/admin/tenants", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      const tenants = await globalTenantStorage.getAllTenants();
      res.json({ success: true, tenants });
    } catch (error) {
      console.error("Error fetching tenants:", error);
      res.status(500).json({ error: "Failed to fetch tenants" });
    }
  });

  // Get tenant stats
  app.get("/api/admin/tenants/:id/stats", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      const stats = await globalTenantStorage.getTenantStats(req.params.id);
      res.json({ success: true, stats });
    } catch (error) {
      console.error("Error fetching tenant stats:", error);
      res.status(500).json({ error: "Failed to fetch tenant stats" });
    }
  });

  // Get single tenant
  app.get("/api/admin/tenants/:id", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      const tenant = await globalTenantStorage.getTenant(req.params.id);
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }
      res.json({ success: true, tenant });
    } catch (error) {
      console.error("Error fetching tenant:", error);
      res.status(500).json({ error: "Failed to fetch tenant" });
    }
  });

  // Create new tenant
  app.post("/api/admin/tenants", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      const { insertTenantSchema } = await import("@shared/schema");

      // Generate API key if not provided
      const apiKey = req.body.apiKey || crypto.randomBytes(32).toString("hex");

      const parsed = insertTenantSchema.parse({
        ...req.body,
        apiKey,
      });

      const tenant = await globalTenantStorage.createTenant(parsed);
      res.status(201).json({ success: true, tenant });
    } catch (error) {
      console.error("Error creating tenant:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes("duplicate") || errorMessage.includes("unique")) {
        return res.status(409).json({ error: "Tenant with this name or slug already exists" });
      }
      if (errorMessage.includes("relation") && errorMessage.includes("does not exist")) {
        return res.status(500).json({
          error: "Database schema not initialized. Please redeploy the application.",
          details: errorMessage,
        });
      }
      res.status(500).json({
        error: "Failed to create tenant",
        details: errorMessage,
      });
    }
  });

  // Update tenant
  app.put("/api/admin/tenants/:id", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      const tenant = await globalTenantStorage.updateTenant(req.params.id, req.body);
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }
      res.json({ success: true, tenant });
    } catch (error) {
      console.error("Error updating tenant:", error);
      res.status(500).json({ error: "Failed to update tenant" });
    }
  });

  // Delete tenant (soft delete by setting active=false)
  app.delete("/api/admin/tenants/:id", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      // First check if there's any active data
      const stats = await globalTenantStorage.getTenantStats(req.params.id);
      if (stats.activeReservationCount > 0 || stats.activePinCount > 0) {
        return res.status(400).json({
          error: "Cannot delete tenant with active reservations or passcodes. Please wait until all active bookings have ended.",
        });
      }

      // Soft delete by setting active=false
      const tenant = await globalTenantStorage.updateTenant(req.params.id, { active: false });
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }
      res.json({ success: true, message: "Tenant deactivated" });
    } catch (error) {
      console.error("Error deleting tenant:", error);
      res.status(500).json({ error: "Failed to delete tenant" });
    }
  });

  // Get tenant credentials (vendor admin only - shows actual values)
  app.get("/api/admin/tenants/:id/credentials", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      const tenantStorage = Storage.forTenant(req.params.id);
      const allSettings = await tenantStorage.getAllSettings();

      // Group credentials by category
      const credentials = {
        mews: {
          environment: allSettings.find(s => s.key === "mews_environment")?.value || null,
          clientToken: allSettings.find(s => s.key === "mews_client_token")?.value || null,
          accessToken: allSettings.find(s => s.key === "mews_access_token")?.value || null,
        },
        ttlock: {
          username: allSettings.find(s => s.key === "ttlock_username")?.value || null,
          password: allSettings.find(s => s.key === "ttlock_password")?.value || null,
          accessToken: allSettings.find(s => s.key === "ttlock_access_token")?.value || null,
          region: allSettings.find(s => s.key === "ttlock_region")?.value || null,
        },
        notifications: {
          smsEnabled: !!(allSettings.find(s => s.key === "twilio_account_sid")?.value &&
            allSettings.find(s => s.key === "twilio_auth_token")?.value),
          emailEnabled: !!(allSettings.find(s => s.key === "sendgrid_api_key")?.value),
        },
        other: allSettings
          .filter(s => !["mews_environment", "mews_client_token", "mews_access_token",
            "ttlock_username", "ttlock_password", "ttlock_access_token", "ttlock_region",
            "sms_enabled", "email_enabled"].includes(s.key))
          .map(s => ({ key: s.key, value: s.value, encrypted: s.encrypted })),
      };

      res.json({ success: true, credentials });
    } catch (error) {
      console.error("Error fetching tenant credentials:", error);
      res.status(500).json({ error: "Failed to fetch tenant credentials" });
    }
  });

  // ===============================================================
  // Vendor Admin: Invitation Management APIs
  // ===============================================================

  // List all invitations
  app.get("/api/admin/invitations", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      const invitations = await globalTenantStorage.getAllInvitations();
      res.json({ success: true, invitations });
    } catch (error) {
      console.error("Error fetching invitations:", error);
      res.status(500).json({ error: "Failed to fetch invitations" });
    }
  });

  // Create invitation and optionally send email
  app.post("/api/admin/invitations", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      const { tenantId, email, sendEmail } = req.body;

      if (!tenantId || !email) {
        return res.status(400).json({ error: "tenantId and email are required" });
      }

      // Verify tenant exists
      const tenant = await globalTenantStorage.getTenant(tenantId);
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      // Generate unique token
      const token = crypto.randomBytes(32).toString("hex");

      // Expires in 7 days
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const invitation = await globalTenantStorage.createInvitation({
        tenantId,
        email,
        token,
        expiresAt,
      });

      // Optionally send email
      let emailSent = false;
      if (sendEmail) {
        try {
          const { NotificationClient } = await import("../notification-client");
          const client = new NotificationClient({});

          // Get base URL from request origin for proper development/production support
          const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
          const host = req.headers["x-forwarded-host"] || req.headers.host || new URL(config.appBaseUrl).host;
          const baseUrl = `${protocol}://${host}`;
          const setupUrl = `${baseUrl}/setup?token=${token}`;

          // Send invitation email
          const result = await client.sendInvitationEmail({
            email,
            hotelName: tenant.name,
            setupUrl,
            expiresAt,
          });

          emailSent = result.success;
        } catch (emailError) {
          console.error("Failed to send invitation email:", emailError);
        }
      }

      res.status(201).json({
        success: true,
        invitation,
        emailSent,
        setupUrl: `/setup?token=${token}`,
      });
    } catch (error) {
      console.error("Error creating invitation:", error);
      res.status(500).json({ error: "Failed to create invitation" });
    }
  });

  // Accept invitation - validate token, mark as used, create hotel user
  // Uses idempotent response - if already used, returns success with same tenantId
  app.post("/api/admin/invitations/:token/accept", async (req: Request, res: Response) => {
    try {
      const invitation = await globalTenantStorage.getInvitationByToken(req.params.token);

      if (!invitation) {
        return res.status(404).json({ success: false, error: "Invitation not found" });
      }

      if (new Date() > invitation.expiresAt && !invitation.usedAt) {
        return res.status(400).json({ success: false, error: "Invitation expired" });
      }

      // Idempotent: if already used, just return success with tenantId
      if (invitation.usedAt) {
        return res.json({
          success: true,
          tenantId: invitation.tenantId,
          alreadyUsed: true,
          message: "Invitation was already used",
        });
      }

      // Get password from request body or generate random one
      const { password, name } = req.body || {};
      const userPassword = password || crypto.randomBytes(8).toString("hex");
      const userName = name || "Hotel Admin";

      // Hash password using scrypt
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = await new Promise<string>((resolve, reject) => {
        crypto.scrypt(userPassword, salt, 64, (err, key) => {
          if (err) reject(err);
          else resolve(key.toString("hex"));
        });
      });
      const passwordHash = `${salt}:${hash}`;

      // Check if user already exists
      const existingUser = await globalTenantStorage.getHotelUserByEmail(invitation.email);
      if (!existingUser) {
        // Send credentials email BEFORE creating user - if email fails, don't create user
        const { NotificationClient } = await import("../notification-client");
        const notificationClient = new NotificationClient({});
        const tenant = await globalTenantStorage.getTenant(invitation.tenantId);
        const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
        const host = req.headers["x-forwarded-host"] || req.headers.host || req.hostname;
        const loginUrl = `${protocol}://${host}/login`;

        const emailResult = await notificationClient.sendCredentialsEmail({
          email: invitation.email,
          name: userName,
          hotelName: tenant?.name || "Your Hotel",
          password: userPassword,
          loginUrl,
        });

        if (!emailResult.success) {
          console.error("Failed to send credentials email:", emailResult.error);
          return res.status(502).json({
            success: false,
            error: "Failed to send login credentials email. Please try again or contact support.",
          });
        }

        await globalTenantStorage.createHotelUser({
          tenantId: invitation.tenantId,
          email: invitation.email,
          passwordHash,
          name: userName,
          role: "admin",
          active: true,
        });
      }

      await globalTenantStorage.markInvitationUsed(req.params.token);

      res.json({
        success: true,
        tenantId: invitation.tenantId,
        alreadyUsed: false,
      });
    } catch (error) {
      console.error("Error accepting invitation:", error);
      res.status(500).json({ success: false, error: "Failed to accept invitation" });
    }
  });

  // Validate invitation token (public endpoint for Quick Setup)
  app.get("/api/invitations/validate/:token", async (req: Request, res: Response) => {
    try {
      const invitation = await globalTenantStorage.getInvitationByToken(req.params.token);

      if (!invitation) {
        return res.status(404).json({ valid: false, error: "Invitation not found" });
      }

      if (invitation.usedAt) {
        return res.status(400).json({ valid: false, error: "Invitation already used" });
      }

      if (new Date() > invitation.expiresAt) {
        return res.status(400).json({ valid: false, error: "Invitation expired" });
      }

      // Get tenant info
      const tenant = await globalTenantStorage.getTenant(invitation.tenantId);

      res.json({
        valid: true,
        tenantId: invitation.tenantId,
        tenantName: tenant?.name,
        tenantSlug: tenant?.slug,
        email: invitation.email,
      });
    } catch (error) {
      console.error("Error validating invitation:", error);
      res.status(500).json({ valid: false, error: "Failed to validate invitation" });
    }
  });

  // Delete invitation
  app.delete("/api/admin/invitations/:id", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      await globalTenantStorage.deleteInvitation(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting invitation:", error);
      res.status(500).json({ error: "Failed to delete invitation" });
    }
  });

  // ===============================================================
  // Vendor Admin: Hotel User Management APIs
  // ===============================================================

  // List all hotel users (optionally filtered by tenantId query param)
  app.get("/api/admin/hotel-users", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      const tenantId = req.query.tenantId as string | undefined;
      let users;

      if (tenantId) {
        users = await globalTenantStorage.getHotelUsersByTenant(tenantId);
      } else {
        // Get all tenants and aggregate users
        const tenants = await globalTenantStorage.getAllTenants();
        const allUsers = await Promise.all(
          tenants.map(t => globalTenantStorage.getHotelUsersByTenant(t.id)),
        );
        users = allUsers.flat();
      }

      res.json({
        success: true,
        users: users.map(u => ({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          tenantId: u.tenantId,
          active: u.active,
          lastLoginAt: u.lastLoginAt,
          createdAt: u.createdAt,
        })),
      });
    } catch (error) {
      console.error("Error listing hotel users:", error);
      res.status(500).json({ error: "Failed to list users" });
    }
  });

  // List hotel users for a specific tenant
  app.get("/api/admin/tenants/:tenantId/users", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      const users = await globalTenantStorage.getHotelUsersByTenant(req.params.tenantId);
      res.json({
        success: true,
        users: users.map(u => ({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          active: u.active,
          lastLoginAt: u.lastLoginAt,
          createdAt: u.createdAt,
        })),
      });
    } catch (error) {
      console.error("Error listing hotel users:", error);
      res.status(500).json({ error: "Failed to list users" });
    }
  });

  // Create hotel user
  app.post("/api/admin/hotel-users", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      const { tenantId, email, password, name, role } = req.body;

      if (!tenantId || !email || !password || !name) {
        return res.status(400).json({ error: "tenantId, email, password, and name are required" });
      }

      // Verify tenant exists
      const tenant = await globalTenantStorage.getTenant(tenantId);
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      // Check if user already exists
      const existingUser = await globalTenantStorage.getHotelUserByEmail(email);
      if (existingUser) {
        return res.status(400).json({ error: "User with this email already exists" });
      }

      // Hash password
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = await new Promise<string>((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (err, key) => {
          if (err) reject(err);
          else resolve(key.toString("hex"));
        });
      });
      const passwordHash = `${salt}:${hash}`;

      const user = await globalTenantStorage.createHotelUser({
        tenantId,
        email,
        passwordHash,
        name,
        role: role || "staff",
        active: true,
      });

      res.status(201).json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId,
        },
      });
    } catch (error) {
      console.error("Error creating hotel user:", error);
      res.status(500).json({ error: "Failed to create user" });
    }
  });

  // Create hotel user for a specific tenant (legacy route)
  app.post("/api/admin/tenants/:tenantId/users", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      const { email, password, name, role } = req.body;

      if (!email || !password || !name) {
        return res.status(400).json({ error: "Email, password, and name required" });
      }

      // Check if user already exists
      const existingUser = await globalTenantStorage.getHotelUserByEmail(email);
      if (existingUser) {
        return res.status(400).json({ error: "User with this email already exists" });
      }

      // Hash password
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = await new Promise<string>((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (err, key) => {
          if (err) reject(err);
          else resolve(key.toString("hex"));
        });
      });
      const passwordHash = `${salt}:${hash}`;

      const user = await globalTenantStorage.createHotelUser({
        tenantId: req.params.tenantId,
        email,
        passwordHash,
        name,
        role: role || "staff",
        active: true,
      });

      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      });
    } catch (error) {
      console.error("Error creating hotel user:", error);
      res.status(500).json({ error: "Failed to create user" });
    }
  });

  // Update hotel user
  app.put("/api/admin/hotel-users/:id", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      const { name, email, role, active, password } = req.body;
      const updateData: Record<string, any> = {};

      if (name !== undefined) updateData.name = name;
      if (email !== undefined) updateData.email = email;
      if (role !== undefined) updateData.role = role;
      if (active !== undefined) updateData.active = active;

      // Hash password if provided
      if (password) {
        const salt = crypto.randomBytes(16).toString("hex");
        const hash = await new Promise<string>((resolve, reject) => {
          crypto.scrypt(password, salt, 64, (err, key) => {
            if (err) reject(err);
            else resolve(key.toString("hex"));
          });
        });
        updateData.passwordHash = `${salt}:${hash}`;
      }

      const user = await globalTenantStorage.updateHotelUser(req.params.id, updateData);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          active: user.active,
          tenantId: user.tenantId,
        },
      });
    } catch (error) {
      console.error("Error updating hotel user:", error);
      res.status(500).json({ error: "Failed to update user" });
    }
  });

  // Delete hotel user (soft delete by setting active=false)
  app.delete("/api/admin/hotel-users/:id", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      const user = await globalTenantStorage.updateHotelUser(req.params.id, { active: false });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ success: true, message: "User deactivated" });
    } catch (error) {
      console.error("Error deleting hotel user:", error);
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  // ===============================================================
  // Admin: TTLock Owner Lock Management
  // ===============================================================

  // List ALL locks across all hotels using owner credentials
  app.get("/api/admin/ttlock/locks", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      const { createOwnerClient } = await import("../ttlock-client");
      const ownerClient = await createOwnerClient("eu");

      // Fetch locks and groups in parallel
      const [locks, groups] = await Promise.all([
        ownerClient.listAllLocks(),
        ownerClient.listGroups(),
      ]);

      // Create a map of groupId to groupName for easy lookup
      const groupMap = new Map(groups.map(g => [g.groupId, g.groupName]));

      res.json({
        success: true,
        total: locks.length,
        groups,
        locks: locks.map(lock => ({
          lockId: lock.lockId,
          name: lock.name,
          alias: lock.alias,
          mac: lock.mac,
          battery: lock.battery,
          date: lock.date,
          groupId: lock.groupId,
          groupName: lock.groupId ? groupMap.get(lock.groupId) || null : null,
        })),
      });
    } catch (error) {
      console.error("Error fetching owner locks:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Failed to fetch locks: ${errorMessage}` });
    }
  });

  // Import the locks of a single TTLock group into one tenant, using OWNER
  // credentials. This is a surgical, one-shot restore that deliberately bypasses
  // the per-hotel token probe in /api/sync-ttlocks: a hotel whose own TTLock
  // account is not Authorized-Admin on its locks (they are administered by the
  // shared owner account and merely grouped per hotel) would have every lock
  // rejected by that probe and wiped. Here we trust the group membership the
  // owner account already reports — the same signal the owner "All Locks" view
  // uses — and only ever INSERT/UPDATE. No lock is deleted and no other tenant
  // is read or written, so the blast radius is exactly the target tenant.
  app.post("/api/admin/ttlock/import-group", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    const { tenantId, groupId } = req.body ?? {};
    if (!tenantId || groupId === undefined || groupId === null) {
      return res.status(400).json({ error: "tenantId and groupId are required" });
    }
    const groupIdNum = Number(groupId);
    if (!Number.isFinite(groupIdNum)) {
      return res.status(400).json({ error: "groupId must be a number" });
    }

    try {
      const tenant = await globalTenantStorage.getTenant(tenantId);
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      const { createOwnerClient } = await import("../ttlock-client");
      const ownerClient = await createOwnerClient("eu");
      const allLocks = await ownerClient.listAllLocks();

      // Only the locks that belong to the requested TTLock group.
      const groupLocks = allLocks.filter(lock => lock.groupId === groupIdNum);
      if (groupLocks.length === 0) {
        return res.status(404).json({
          error: `No locks found in group ${groupIdNum} on the owner account`,
        });
      }

      const storage = Storage.forTenant(tenant.id);

      let imported = 0;
      let updated = 0;
      const importedLocks: string[] = [];
      for (const lock of groupLocks) {
        const existing = await storage.getLockDeviceByTTLockId(lock.lockId.toString());
        await storage.syncLockDeviceFromTTLock(lock.lockId.toString(), {
          name: lock.name,
          mac: lock.mac,
          battery: lock.battery,
        });
        if (existing) {
          updated++;
        } else {
          imported++;
        }
        importedLocks.push(lock.name);
      }

      await storage.createLog({
        level: "info",
        message: `Owner import of TTLock group ${groupIdNum} into tenant "${tenant.name}": ${imported} imported, ${updated} updated (${importedLocks.length} total)`,
        source: "System",
      });
      console.log(`[TTLock Import] Group ${groupIdNum} → tenant ${tenant.id}: ${imported} imported, ${updated} updated`);

      res.json({
        success: true,
        tenantId: tenant.id,
        tenantName: tenant.name,
        groupId: groupIdNum,
        imported,
        updated,
        total: importedLocks.length,
        locks: importedLocks,
      });
    } catch (error) {
      console.error("Error importing TTLock group:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Failed to import group: ${errorMessage}` });
    }
  });

  // ===============================================================
  // Admin: Test Notification Endpoints
  // ===============================================================

  // Send test email
  app.post("/api/admin/test-email", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      const { email, guestName, pin } = req.body;

      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      const { NotificationClient } = await import("../notification-client");
      const client = new NotificationClient({});

      // Get hotel settings
      const storage = getTenantStorage(req);
      const hotelSlugSetting = await storage.getSetting("hotel_slug");
      const hotelNameSetting = await storage.getSetting("hotel_name");
      const appBaseUrlSetting = await storage.getSetting("app_base_url");

      const hotelSlug = hotelSlugSetting?.value || "downtown";
      const hotelName = hotelNameSetting?.value || config.defaultHotelName;
      const appBaseUrl = appBaseUrlSetting?.value || config.appBaseUrl;

      const checkInUrl = `${appBaseUrl}/check-in/preview-token-example`;
      const { format } = await import("date-fns");
      const arrivalDate = format(new Date(), "EEEE, MMMM d, yyyy");
      const departureDate = format(new Date(Date.now() + 24 * 60 * 60 * 1000), "EEEE, MMMM d, yyyy");

      const result = await client.sendPreCheckInPlainTextEmail({
        email,
        guestName: guestName || "Test Guest",
        hotelName,
        checkInUrl,
        arrivalDate,
        departureDate,
      });

      if (result.success) {
        res.json({ success: true, message: `Pre-check-in email sent to ${email}` });
      } else {
        res.status(500).json({ success: false, error: result.error });
      }
    } catch (error) {
      console.error("Test email error:", error);
      res.status(500).json({ error: "Failed to send test email" });
    }
  });

  // ===============================================================
  // Admin: Reservation Management
  // ===============================================================

  // Refresh reservation data from MEWS (admin endpoint)
  app.post("/api/admin/reservations/:id/refresh-mews", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    try {
      const { defaultStorage } = ctx;
      const reservation = await defaultStorage.getReservation(req.params.id);
      if (!reservation) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      const mewsClientTokenSetting = await defaultStorage.getSetting("mews_client_token");
      const mewsAccessTokenSetting = await defaultStorage.getSetting("mews_access_token");
      const mewsEnvironmentSetting = await defaultStorage.getSetting("mews_environment");

      if (!mewsClientTokenSetting?.value || !mewsAccessTokenSetting?.value) {
        return res.status(400).json({ error: "MEWS not configured" });
      }

      const { MewsClient } = await import("../mews-client");
      const mewsEnvironment = (mewsEnvironmentSetting?.value === "production" ? "production" : "demo") as "demo" | "production";
      const mewsClient = new MewsClient(mewsClientTokenSetting.value, mewsAccessTokenSetting.value, mewsEnvironment);
      const mewsReservations = await mewsClient.getReservations([reservation.pmsId]);

      if (mewsReservations.length === 0) {
        return res.status(404).json({ error: "Reservation not found in MEWS" });
      }

      const mewsRes = mewsReservations[0];
      await defaultStorage.updateReservation(reservation.id, {
        mewsCustomerId: mewsRes.CustomerId,
      });

      res.json({
        success: true,
        message: "Reservation refreshed from MEWS",
        mewsCustomerId: mewsRes.CustomerId,
      });
    } catch (error) {
      console.error("Error refreshing reservation from MEWS:", error);
      res.status(500).json({ error: "Failed to refresh reservation from MEWS" });
    }
  });

  // ===============================================================
  // Admin: Drift diagnostics & resync
  // ===============================================================

  // 3-way state diagnosis: MEWS ↔ DB ↔ TTLock
  app.get("/api/admin/reservations/:id/diagnose", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }
    try {
      const storage = getTenantStorage(req);
      const reservation = await storage.getReservation(req.params.id);
      if (!reservation) {
        return res.status(404).json({ error: "Reservation not found" });
      }
      const reconciler = ctx.getDriftReconciler();
      if (!reconciler) {
        return res.status(503).json({ error: "Drift reconciler not available" });
      }
      const report = await reconciler.diagnose(reservation);
      res.json(report);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Error diagnosing reservation:", error);
      res.status(500).json({ error: `Diagnosis failed: ${msg}` });
    }
  });

  // One-click resync: re-fetch from MEWS, re-ingest, then re-push to TTLock
  app.post("/api/admin/reservations/:id/resync", async (req: Request, res: Response) => {
    if (!await verifyAdminToken(req)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }
    try {
      const storage = getTenantStorage(req);
      const reservation = await storage.getReservation(req.params.id);
      if (!reservation) {
        return res.status(404).json({ error: "Reservation not found" });
      }
      const reconciler = ctx.getDriftReconciler();
      if (!reconciler) {
        return res.status(503).json({ error: "Drift reconciler not available" });
      }

      const before = await reconciler.diagnose(reservation);
      const result = await reconciler.reconcileReservation(reservation);
      // Re-read fresh reservation for the "after" snapshot
      const fresh = (await storage.getReservation(reservation.id)) || reservation;
      const after = await reconciler.diagnose(fresh);

      res.json({ result, before, after });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Error resyncing reservation:", error);
      res.status(500).json({ error: `Resync failed: ${msg}` });
    }
  });
}
