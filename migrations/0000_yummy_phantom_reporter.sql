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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "reservation_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"reservation_id" text NOT NULL,
	"message" text NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"detail" text
);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"encrypted" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "settings_tenant_key_unique" UNIQUE("tenant_id","key")
);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "common_areas" ADD CONSTRAINT "common_areas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lock_devices" ADD CONSTRAINT "lock_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pins" ADD CONSTRAINT "pins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_logs" ADD CONSTRAINT "reservation_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_lock_assignments" ADD CONSTRAINT "room_lock_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_lock_assignments" ADD CONSTRAINT "room_lock_assignments_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_lock_assignments" ADD CONSTRAINT "room_lock_assignments_lock_device_id_lock_devices_id_fk" FOREIGN KEY ("lock_device_id") REFERENCES "public"."lock_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invitations" ADD CONSTRAINT "vendor_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "common_areas_tenant_idx" ON "common_areas" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "lock_devices_tenant_idx" ON "lock_devices" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "logs_tenant_idx" ON "logs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "pins_tenant_idx" ON "pins" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "qr_codes_tenant_idx" ON "qr_codes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "reservation_logs_tenant_idx" ON "reservation_logs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "reservations_tenant_idx" ON "reservations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "reservations_tenant_status_arrival_idx" ON "reservations" USING btree ("tenant_id","status","arrival");--> statement-breakpoint
CREATE INDEX "reservations_tenant_arrival_idx" ON "reservations" USING btree ("tenant_id","arrival");--> statement-breakpoint
CREATE INDEX "reservations_tenant_departure_idx" ON "reservations" USING btree ("tenant_id","departure");--> statement-breakpoint
CREATE INDEX "room_lock_assignments_tenant_idx" ON "room_lock_assignments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "room_lock_assignments_room_idx" ON "room_lock_assignments" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_lock_assignments_lock_device_idx" ON "room_lock_assignments" USING btree ("lock_device_id");--> statement-breakpoint
CREATE INDEX "rooms_tenant_idx" ON "rooms" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "settings_tenant_idx" ON "settings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "vendor_invitations_tenant_idx" ON "vendor_invitations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "vendor_invitations_token_idx" ON "vendor_invitations" USING btree ("token");