-- Add sessions table for persistent auth sessions
CREATE TABLE IF NOT EXISTS "sessions" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token" text NOT NULL,
  "user_id" text,
  "tenant_id" text,
  "role" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "sessions_token_unique" UNIQUE("token")
);

CREATE INDEX IF NOT EXISTS "sessions_token_idx" ON "sessions" USING btree ("token");
CREATE INDEX IF NOT EXISTS "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");
