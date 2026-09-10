-- 008_phase8_analytics_websockets_infrastructure.sql
-- Outbound Webhook Subscriptions, Delivery Audit Logs, and SLA Tracking

-- ─────────────────────────────────────────────────────────────
-- Outbound Webhook Subscriptions (Tenant Custom Integrations)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  url                 TEXT NOT NULL,
  secret              TEXT NOT NULL, -- Used for HMAC-SHA256 X-Omni-Signature
  events              JSONB NOT NULL DEFAULT '["*"]', -- List of event names, e.g. ["message.received", "order.created"]
  is_active           BOOLEAN NOT NULL DEFAULT true,
  failure_count       INTEGER NOT NULL DEFAULT 0,
  last_triggered_at   TIMESTAMPTZ,
  last_status_code    INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_subs_tenant_idx ON webhook_subscriptions (tenant_id, is_active);
CREATE INDEX IF NOT EXISTS webhook_subs_created_idx ON webhook_subscriptions (tenant_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- Outbound Webhook Delivery Logs
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_delivery_logs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id     UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event               TEXT NOT NULL,
  payload             JSONB NOT NULL DEFAULT '{}',
  response_status     INTEGER,
  response_body       TEXT,
  duration_ms         INTEGER,
  attempt             INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failed', 'retrying')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_logs_sub_idx ON webhook_delivery_logs (subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS webhook_logs_tenant_idx ON webhook_delivery_logs (tenant_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- Conversations SLA & Response Metrics Extensions
-- ─────────────────────────────────────────────────────────────
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_response_duration_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolution_duration_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_conversations_sla ON conversations (tenant_id, first_response_duration_seconds);
CREATE INDEX IF NOT EXISTS idx_conversations_resolved ON conversations (tenant_id, resolved_at);
