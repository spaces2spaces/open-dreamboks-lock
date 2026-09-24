CREATE TABLE "ekeys" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"reservation_id" text NOT NULL,
	"lock_device_id" text NOT NULL,
	"ttlock_key_id" integer NOT NULL,
	"lock_name" text NOT NULL,
	"lock_type" text NOT NULL,
	"valid_from" timestamp NOT NULL,
	"valid_to" timestamp NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hotel_users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'staff' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "hotel_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "pins" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "pins" ADD COLUMN "qr_code_data" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pins" ADD COLUMN "ttlock_qr_code_ids" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pins" ADD COLUMN "first_used_at" timestamp;--> statement-breakpoint
ALTER TABLE "pins" ADD COLUMN "activated_at" timestamp;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "pre_checkin_token" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "pre_checkin_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "personal_email" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "preferred_channel" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "pre_checkin_email_sent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "mews_customer_id" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "payment_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "code_delivered_at" timestamp;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "pms_checkin_source" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "guest_submitted_id" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "ekeys" ADD CONSTRAINT "ekeys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hotel_users" ADD CONSTRAINT "hotel_users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ekeys_tenant_idx" ON "ekeys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "ekeys_reservation_idx" ON "ekeys" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "ekeys_lock_device_idx" ON "ekeys" USING btree ("lock_device_id");--> statement-breakpoint
CREATE INDEX "hotel_users_tenant_idx" ON "hotel_users" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sessions_token_idx" ON "sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "logs_tenant_reservation_idx" ON "logs" USING btree ("tenant_id","reservation_id");--> statement-breakpoint
CREATE INDEX "logs_tenant_timestamp_idx" ON "logs" USING btree ("tenant_id","timestamp");--> statement-breakpoint
CREATE INDEX "pins_reservation_idx" ON "pins" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "pins_tenant_room_status_idx" ON "pins" USING btree ("tenant_id","room_id","status");--> statement-breakpoint
CREATE INDEX "pins_tenant_status_idx" ON "pins" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "reservations_pre_checkin_token_idx" ON "reservations" USING btree ("pre_checkin_token");--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_pre_checkin_token_unique" UNIQUE("pre_checkin_token");