-- 012_platform_governance.sql
-- Phase 9: Platform Governance, Staff RBAC, Audit Logging & Privacy Shield Architecture

-- ─────────────────────────────────────────────────────────────
-- 1. Platform Staff Users Table (Strictly isolated from tenant users)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('super_admin', 'platform_dev', 'platform_tester', 'support_agent')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deactivated')),
  permissions     JSONB NOT NULL DEFAULT '[]', -- Granular permission strings if needed
  mfa_enabled     BOOLEAN NOT NULL DEFAULT false,
  mfa_secret      TEXT,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive unique index on email
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_users_email_lower ON platform_users (lower(email));
CREATE INDEX IF NOT EXISTS idx_platform_users_role ON platform_users (role);
CREATE INDEX IF NOT EXISTS idx_platform_users_status ON platform_users (status);

-- Initial Seed for Platform Staff Users
INSERT INTO platform_users (email, password_hash, name, role, status, permissions)
VALUES
  (
    'superadmin@omniplatform.internal',
    '$2b$12$MdfIhiS855wYAJoPX83iGOee1BxfwMm1tcxKOlZLcBrBJOXYnf9KS',
    'Master Super Admin',
    'super_admin',
    'active',
    '["*"]'
  ),
  (
    'dev@omniplatform.internal',
    '$2b$12$MdfIhiS855wYAJoPX83iGOee1BxfwMm1tcxKOlZLcBrBJOXYnf9KS',
    'Platform Lead Dev',
    'platform_dev',
    'active',
    '["telemetry:read", "logs:read"]'
  ),
  (
    'qa@omniplatform.internal',
    '$2b$12$MdfIhiS855wYAJoPX83iGOee1BxfwMm1tcxKOlZLcBrBJOXYnf9KS',
    'Platform QA Lead',
    'platform_tester',
    'active',
    '["testing:execute", "channels:ping"]'
  ),
  (
    'support@omniplatform.internal',
    '$2b$12$MdfIhiS855wYAJoPX83iGOee1BxfwMm1tcxKOlZLcBrBJOXYnf9KS',
    'Support Specialist',
    'support_agent',
    'active',
    '["tenants:read_metadata"]'
  )
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- 2. Platform Audit Logs Table (Full compliance trail for internal staff actions)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_user_id    UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  platform_user_email TEXT,
  platform_user_role  TEXT,
  action              TEXT NOT NULL, -- 'tenant.suspend', 'tenant.activate', 'tenant.plan_override', 'staff.create', 'staff.role_change', 'test.webhook_dispatch', 'system.cache_purge'
  target_type         TEXT NOT NULL, -- 'tenant', 'platform_user', 'system_config', 'test_job'
  target_id           TEXT,          -- UUID or identifier of target
  details             JSONB NOT NULL DEFAULT '{}', -- Strictly metadata only, NEVER tenant PII or messages
  ip_address          TEXT,
  user_agent          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure columns exist if table was previously created with legacy schema
ALTER TABLE platform_audit_logs
  ADD COLUMN IF NOT EXISTS platform_user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS platform_user_email TEXT,
  ADD COLUMN IF NOT EXISTS platform_user_role TEXT,
  ADD COLUMN IF NOT EXISTS user_agent TEXT;

-- Safely backfill legacy columns if they exist (only link platform_user_id if user exists in platform_users)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'platform_audit_logs' AND column_name = 'user_id') THEN
    EXECUTE 'UPDATE platform_audit_logs pal
             SET platform_user_id = pu.id
             FROM platform_users pu
             WHERE pal.user_id = pu.id AND pal.platform_user_id IS NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'platform_audit_logs' AND column_name = 'user_email') THEN
    EXECUTE 'UPDATE platform_audit_logs SET platform_user_email = COALESCE(platform_user_email, user_email) WHERE platform_user_email IS NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'platform_audit_logs' AND column_name = 'platform_role') THEN
    EXECUTE 'UPDATE platform_audit_logs SET platform_user_role = COALESCE(platform_user_role, platform_role) WHERE platform_user_role IS NULL';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_user ON platform_audit_logs (platform_user_id);
CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_action ON platform_audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_created ON platform_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_target ON platform_audit_logs (target_type, target_id);

-- ─────────────────────────────────────────────────────────────
-- 3. Platform Global System Settings & Feature Flags
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_system_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  description TEXT,
  updated_by  UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default platform configurations
INSERT INTO platform_system_settings (key, value, description)
VALUES
  ('maintenance_mode', '{"enabled": false, "message": "Omni Platform is undergoing scheduled maintenance."}'::jsonb, 'Global maintenance toggle'),
  ('global_rate_limits', '{"api_rpm": 1200, "webhook_rpm": 6000}'::jsonb, 'Global baseline rate limits per tenant'),
  ('privacy_shield_enforced', '{"enforced": true, "strict_zero_pii": true}'::jsonb, 'Zero-PII Privacy Shield status enforcement')
ON CONFLICT (key) DO NOTHING;
