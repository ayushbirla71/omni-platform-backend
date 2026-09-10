-- 007_phase7_scale_security_compliance.sql
-- Scale, Security, Advanced RBAC, API Keys, Audit Logging & Compliance (GDPR/DPA)

-- ─────────────────────────────────────────────────────────────
-- Enhanced Tenancy & Subscription Metadata
-- ─────────────────────────────────────────────────────────────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS plan_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS max_channels INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS max_contacts INTEGER NOT NULL DEFAULT 5000,
  ADD COLUMN IF NOT EXISTS max_monthly_messages INTEGER NOT NULL DEFAULT 25000,
  ADD COLUMN IF NOT EXISTS max_monthly_ai_queries INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ─────────────────────────────────────────────────────────────
-- Enhanced User Status & Activity
-- ─────────────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated', 'invited')),
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ─────────────────────────────────────────────────────────────
-- API Keys (Developer & External Integrations)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  key_prefix    TEXT NOT NULL, -- e.g. "omni_live_abc12"
  key_hash      TEXT NOT NULL, -- SHA-256 hash of the full key
  scopes        JSONB NOT NULL DEFAULT '["*"]',
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys (tenant_id);
CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS api_keys_active_idx ON api_keys (tenant_id, is_active);

-- ─────────────────────────────────────────────────────────────
-- Audit Logs (Security, Compliance & Administrative Trail)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  user_email    TEXT,
  action        TEXT NOT NULL, -- 'user.invite' | 'user.role_change' | 'user.remove' | 'apikey.create' | 'apikey.revoke' | 'channel.connect' | 'compliance.export' | 'compliance.delete' | 'plan.upgrade'
  resource_type TEXT NOT NULL, -- 'user' | 'api_key' | 'channel' | 'contact' | 'plan' | 'flow' | 'deal'
  resource_id   TEXT,
  details       JSONB NOT NULL DEFAULT '{}',
  ip_address    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_tenant_idx ON audit_logs (tenant_id);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (tenant_id, action);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (tenant_id, created_at DESC);
