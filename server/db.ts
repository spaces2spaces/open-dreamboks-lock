import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from "ws";
import * as schema from "@shared/schema";

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Perf 23/7: the default pool (max 10, wait-forever) ran at its ceiling —
// 3 tenants' background jobs (schedulers, pollers, sweeps) shared 10 slots
// with every user request, which then queued silently. Verified in prod:
// pg_stat_activity showed exactly 10 connections while pages took seconds.
// Neon's smallest compute allows ~112 connections, so 25 is conservative;
// connectionTimeoutMillis surfaces future saturation as an error instead of
// an invisible queue.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 25,
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 60_000,
});
export const db = drizzle({ client: pool, schema });

/**
 * Idempotent schema guards for columns added after the last full schema sync.
 *
 * Railway deploys run `git push → build → start` with NO migration step, so a
 * deploy that adds a column to shared/schema.ts would otherwise crash every
 * SELECT against that table (Drizzle emits explicit column lists → 42703)
 * until someone manually runs `npm run db:push`. For the pins table that
 * failure mode means NO pin can be created, activated or repaired — a total
 * lockout, which is exactly what the 21/7 hardening must never cause itself.
 *
 * Runs at boot, before routes/jobs start. ADD COLUMN IF NOT EXISTS is a
 * no-op when the column exists, so this is safe on every start.
 */
export async function ensureSchemaGuards(): Promise<void> {
  try {
    await pool.query(`ALTER TABLE "pins" ADD COLUMN IF NOT EXISTS "orphan_observations" jsonb;`);
    // 4/8: marketing_sends must survive the post-checkout reservation purge
    // (was ON DELETE CASCADE — campaign history vanished as guests checked
    // out). Same SET NULL pattern as early_checkins; guest_name keeps the
    // send log readable after the reservation row is gone.
    await pool.query(`ALTER TABLE "marketing_sends" ADD COLUMN IF NOT EXISTS "guest_name" text;`);
    await pool.query(`ALTER TABLE "marketing_sends" ALTER COLUMN "reservation_id" DROP NOT NULL;`);
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'marketing_sends_reservation_id_fkey' AND confdeltype = 'c'
        ) THEN
          ALTER TABLE "marketing_sends" DROP CONSTRAINT "marketing_sends_reservation_id_fkey";
          ALTER TABLE "marketing_sends" ADD CONSTRAINT "marketing_sends_reservation_id_fkey"
            FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    console.log("[DB] Schema guards ensured (pins.orphan_observations, marketing_sends history-preservation)");
  } catch (error) {
    // Never block boot: if the DB is briefly unavailable the guard re-runs on
    // next deploy/restart, and db:push remains the canonical path.
    console.error("[DB] Schema guard failed (run `npm run db:push` manually):", error);
  }
}

export async function resetAndSyncSchema() {
  console.log("[DB] Checking if schema reset is needed...");
  
  // Skip in development - only run in production
  if (process.env.NODE_ENV === 'development') {
    console.log("[DB] Skipping schema reset in development mode");
    return;
  }
  
  try {
    // Test database connection first with timeout
    const testConnection = async () => {
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Connection timeout')), 5000)
      );
      const queryPromise = pool.query('SELECT 1');
      return Promise.race([queryPromise, timeoutPromise]);
    };
    
    try {
      await testConnection();
    } catch (connError) {
      console.log("[DB] Database not available yet, skipping schema reset. App will retry on first request.");
      return;
    }
    
    // Check if schema is outdated (missing tenant_id in logs)
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'logs' AND column_name = 'tenant_id'
      ) as has_tenant_id
    `);
    
    const hasCorrectSchema = result.rows[0]?.has_tenant_id === true;
    
    if (hasCorrectSchema) {
      console.log("[DB] Schema is up to date, no reset needed");
      return;
    }
    
    console.log("[DB] Schema is outdated - performing full reset...");
    
    // Drop all tables
    await pool.query(`
      DROP TABLE IF EXISTS sessions CASCADE;
      DROP TABLE IF EXISTS vendor_invitations CASCADE;
      DROP TABLE IF EXISTS room_lock_assignments CASCADE;
      DROP TABLE IF EXISTS reservation_logs CASCADE;
      DROP TABLE IF EXISTS qr_codes CASCADE;
      DROP TABLE IF EXISTS pins CASCADE;
      DROP TABLE IF EXISTS logs CASCADE;
      DROP TABLE IF EXISTS reservations CASCADE;
      DROP TABLE IF EXISTS rooms CASCADE;
      DROP TABLE IF EXISTS common_areas CASCADE;
      DROP TABLE IF EXISTS lock_devices CASCADE;
      DROP TABLE IF EXISTS settings CASCADE;
      DROP TABLE IF EXISTS tenants CASCADE;
    `);
    
    console.log("[DB] All tables dropped. Creating fresh schema...");
    
    // Create all tables with correct schema
    await pool.query(`
      CREATE TABLE "tenants" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "name" text NOT NULL,
        "slug" text NOT NULL,
        "pms_type" text,
        "pms_enterprise_id" text,
        "api_key" text NOT NULL,
        "active" boolean DEFAULT true NOT NULL,
        "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
        CONSTRAINT "tenants_api_key_unique" UNIQUE("api_key")
      );
      
      CREATE TABLE "common_areas" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "tenant_id" text NOT NULL,
        "name" text NOT NULL,
        "battery" integer DEFAULT 100 NOT NULL,
        "floor" text,
        "building" text,
        "access_scope" text DEFAULT 'universal' NOT NULL,
        "ttlock_id" text,
        "created_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "common_areas_tenant_ttlock_id_unique" UNIQUE("tenant_id","ttlock_id")
      );
      
      CREATE TABLE "lock_devices" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "tenant_id" text NOT NULL,
        "name" text NOT NULL,
        "mac" text NOT NULL,
        "battery" integer DEFAULT 100 NOT NULL,
        "lock_type" text DEFAULT 'room' NOT NULL,
        "is_linked" boolean DEFAULT false NOT NULL,
        "ttlock_id" text NOT NULL,
        "last_sync" timestamp,
        "created_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "lock_devices_tenant_mac_unique" UNIQUE("tenant_id","mac"),
        CONSTRAINT "lock_devices_tenant_ttlock_id_unique" UNIQUE("tenant_id","ttlock_id")
      );
      
      CREATE TABLE "logs" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "tenant_id" text NOT NULL,
        "timestamp" timestamp DEFAULT now() NOT NULL,
        "level" text NOT NULL,
        "message" text NOT NULL,
        "source" text NOT NULL,
        "reservation_id" text,
        "room_id" text,
        "metadata" jsonb
      );
      
      CREATE TABLE "pins" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "tenant_id" text NOT NULL,
        "room_id" text NOT NULL,
        "reservation_id" text,
        "type" text NOT NULL,
        "code" text NOT NULL,
        "name" text NOT NULL,
        "email" text,
        "valid_from" timestamp NOT NULL,
        "valid_to" timestamp NOT NULL,
        "status" text DEFAULT 'active' NOT NULL,
        "doors" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "assigner" text,
        "assigning_time" timestamp DEFAULT now() NOT NULL,
        "ttlock_key_id" text,
        "room_lock_key_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "common_area_key_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
      
      CREATE TABLE "qr_codes" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "tenant_id" text NOT NULL,
        "name" text NOT NULL,
        "assigner" text NOT NULL,
        "assigning_time" timestamp DEFAULT now() NOT NULL,
        "validity_period" text NOT NULL,
        "status" text DEFAULT 'Valid' NOT NULL,
        "room_id" text,
        "ttlock_key_id" text,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
      
      CREATE TABLE "reservation_logs" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "tenant_id" text NOT NULL,
        "reservation_id" text NOT NULL,
        "message" text NOT NULL,
        "timestamp" timestamp DEFAULT now() NOT NULL,
        "type" text NOT NULL,
        "detail" text
      );
      
      CREATE TABLE "reservations" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "tenant_id" text NOT NULL,
        "email" text,
        "first_name" text NOT NULL,
        "last_name" text NOT NULL,
        "arrival" timestamp NOT NULL,
        "departure" timestamp NOT NULL,
        "pms_id" text NOT NULL,
        "ext_id" text,
        "room_id" text,
        "adults" integer DEFAULT 1 NOT NULL,
        "children" integer DEFAULT 0 NOT NULL,
        "status" text DEFAULT 'Confirmed' NOT NULL,
        "room" text,
        "bed" text,
        "price" text,
        "currency" text,
        "owing" text,
        "mobile" text,
        "confirmation_code" text,
        "generated_pin" text,
        "group_name" text,
        "requested_category" text,
        "space_category" text,
        "assigned_space" text,
        "rate_name" text,
        "avg_rate" text,
        "total_amount" text,
        "origin" text,
        "reservation_source" text,
        "notification_sent" boolean DEFAULT false NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "reservations_tenant_pms_id_unique" UNIQUE("tenant_id","pms_id")
      );
      
      CREATE TABLE "room_lock_assignments" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "tenant_id" text NOT NULL,
        "room_id" text NOT NULL,
        "lock_device_id" text NOT NULL,
        "assignment_type" text DEFAULT 'room_lock' NOT NULL,
        "access_scope" text,
        "created_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "room_lock_assignments_unique" UNIQUE("room_id","lock_device_id")
      );
      
      CREATE TABLE "rooms" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "tenant_id" text NOT NULL,
        "name" text NOT NULL,
        "type" text NOT NULL,
        "beds" integer DEFAULT 1 NOT NULL,
        "pms_status" text DEFAULT 'unmapped' NOT NULL,
        "pms_id" text,
        "battery" integer DEFAULT 100 NOT NULL,
        "floor" text,
        "building" text,
        "ordering" integer,
        "common_areas" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "is_dream_boks" boolean DEFAULT false NOT NULL,
        "ttlock_id" text,
        "space_category" text,
        "created_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "rooms_tenant_pms_id_unique" UNIQUE("tenant_id","pms_id")
      );
      
      CREATE TABLE "settings" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "tenant_id" text NOT NULL,
        "key" text NOT NULL,
        "value" text NOT NULL,
        "encrypted" boolean DEFAULT false NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "settings_tenant_key_unique" UNIQUE("tenant_id","key")
      );
      
      CREATE TABLE "sessions" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "token" text NOT NULL,
        "user_id" text,
        "tenant_id" text,
        "role" text NOT NULL,
        "expires_at" timestamp NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "sessions_token_unique" UNIQUE("token")
      );

      CREATE TABLE "vendor_invitations" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "tenant_id" text NOT NULL,
        "token" text NOT NULL,
        "email" text NOT NULL,
        "expires_at" timestamp NOT NULL,
        "used_at" timestamp,
        "created_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "vendor_invitations_token_unique" UNIQUE("token")
      );
    `);
    
    // Add foreign keys
    await pool.query(`
      ALTER TABLE "common_areas" ADD CONSTRAINT "common_areas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
      ALTER TABLE "lock_devices" ADD CONSTRAINT "lock_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
      ALTER TABLE "logs" ADD CONSTRAINT "logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
      ALTER TABLE "pins" ADD CONSTRAINT "pins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
      ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
      ALTER TABLE "reservation_logs" ADD CONSTRAINT "reservation_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
      ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
      ALTER TABLE "reservations" ADD CONSTRAINT "reservations_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;
      ALTER TABLE "room_lock_assignments" ADD CONSTRAINT "room_lock_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
      ALTER TABLE "room_lock_assignments" ADD CONSTRAINT "room_lock_assignments_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;
      ALTER TABLE "room_lock_assignments" ADD CONSTRAINT "room_lock_assignments_lock_device_id_lock_devices_id_fk" FOREIGN KEY ("lock_device_id") REFERENCES "public"."lock_devices"("id") ON DELETE cascade ON UPDATE no action;
      ALTER TABLE "rooms" ADD CONSTRAINT "rooms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
      ALTER TABLE "settings" ADD CONSTRAINT "settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
      ALTER TABLE "vendor_invitations" ADD CONSTRAINT "vendor_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
    `);
    
    // Add indexes
    await pool.query(`
      CREATE INDEX "common_areas_tenant_idx" ON "common_areas" USING btree ("tenant_id");
      CREATE INDEX "lock_devices_tenant_idx" ON "lock_devices" USING btree ("tenant_id");
      CREATE INDEX "logs_tenant_idx" ON "logs" USING btree ("tenant_id");
      CREATE INDEX "pins_tenant_idx" ON "pins" USING btree ("tenant_id");
      CREATE INDEX "qr_codes_tenant_idx" ON "qr_codes" USING btree ("tenant_id");
      CREATE INDEX "reservation_logs_tenant_idx" ON "reservation_logs" USING btree ("tenant_id");
      CREATE INDEX "reservations_tenant_idx" ON "reservations" USING btree ("tenant_id");
      CREATE INDEX "reservations_tenant_status_arrival_idx" ON "reservations" USING btree ("tenant_id","status","arrival");
      CREATE INDEX "reservations_tenant_arrival_idx" ON "reservations" USING btree ("tenant_id","arrival");
      CREATE INDEX "reservations_tenant_departure_idx" ON "reservations" USING btree ("tenant_id","departure");
      CREATE INDEX "room_lock_assignments_tenant_idx" ON "room_lock_assignments" USING btree ("tenant_id");
      CREATE INDEX "room_lock_assignments_room_idx" ON "room_lock_assignments" USING btree ("room_id");
      CREATE INDEX "room_lock_assignments_lock_device_idx" ON "room_lock_assignments" USING btree ("lock_device_id");
      CREATE INDEX "rooms_tenant_idx" ON "rooms" USING btree ("tenant_id");
      CREATE INDEX "settings_tenant_idx" ON "settings" USING btree ("tenant_id");
      CREATE INDEX "sessions_token_idx" ON "sessions" USING btree ("token");
      CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");
      CREATE INDEX "vendor_invitations_tenant_idx" ON "vendor_invitations" USING btree ("tenant_id");
      CREATE INDEX "vendor_invitations_token_idx" ON "vendor_invitations" USING btree ("token");
    `);
    
    console.log("[DB] Schema reset complete - fresh database ready!");
    
  } catch (error) {
    console.error("[DB] Schema reset error:", error);
    // Don't throw - let the app try to start anyway
    console.log("[DB] Continuing despite error...");
  }
}
