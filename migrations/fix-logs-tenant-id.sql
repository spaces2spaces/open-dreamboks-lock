-- Add tenant_id column to logs table if it doesn't exist
-- This migration is for production database sync

-- First, check if column exists and add it if not
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'logs' AND column_name = 'tenant_id'
    ) THEN
        -- Add the column as nullable first
        ALTER TABLE logs ADD COLUMN tenant_id text;
        
        -- Get the default tenant ID (first tenant in the system)
        UPDATE logs SET tenant_id = (
            SELECT id FROM tenants ORDER BY created_at LIMIT 1
        ) WHERE tenant_id IS NULL;
        
        -- Make it NOT NULL
        ALTER TABLE logs ALTER COLUMN tenant_id SET NOT NULL;
        
        -- Add foreign key constraint
        ALTER TABLE logs ADD CONSTRAINT logs_tenant_id_tenants_id_fk 
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
        
        -- Add index
        CREATE INDEX IF NOT EXISTS logs_tenant_idx ON logs(tenant_id);
        
        RAISE NOTICE 'Added tenant_id column to logs table';
    ELSE
        RAISE NOTICE 'tenant_id column already exists in logs table';
    END IF;
END $$;

-- Also add unique constraint to settings if missing
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'settings_tenant_key_unique'
    ) THEN
        -- This might fail if there are duplicates, so we handle it
        BEGIN
            ALTER TABLE settings ADD CONSTRAINT settings_tenant_key_unique 
                UNIQUE (tenant_id, key);
            RAISE NOTICE 'Added unique constraint to settings table';
        EXCEPTION WHEN unique_violation THEN
            RAISE NOTICE 'Could not add unique constraint - duplicate values exist';
        END;
    ELSE
        RAISE NOTICE 'settings_tenant_key_unique constraint already exists';
    END IF;
END $$;

-- Add vendor_invitations table if it doesn't exist
CREATE TABLE IF NOT EXISTS vendor_invitations (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    token text NOT NULL,
    email text NOT NULL,
    expires_at timestamp NOT NULL,
    used_at timestamp,
    created_at timestamp DEFAULT now() NOT NULL,
    CONSTRAINT vendor_invitations_token_unique UNIQUE(token)
);

-- Add foreign key to vendor_invitations if table was just created
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'vendor_invitations_tenant_id_tenants_id_fk'
    ) THEN
        ALTER TABLE vendor_invitations ADD CONSTRAINT vendor_invitations_tenant_id_tenants_id_fk 
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Add indexes if missing
CREATE INDEX IF NOT EXISTS vendor_invitations_tenant_idx ON vendor_invitations(tenant_id);
CREATE INDEX IF NOT EXISTS vendor_invitations_token_idx ON vendor_invitations(token);
