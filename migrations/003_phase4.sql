-- 003_phase4.sql
-- CRM pipeline + broadcast/drip campaigns.

-- ─────────────────────────────────────────────────────────────
-- CRM: deals / pipeline
-- ─────────────────────────────────────────────────────────────

CREATE TABLE deals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  stage       TEXT NOT NULL DEFAULT 'new', -- new | contacted | qualified | won | lost (tenant-defined, not enforced by a CHECK — see tracker)
  value       NUMERIC(12, 2),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX deals_tenant_idx ON deals (tenant_id);
CREATE INDEX deals_stage_idx ON deals (tenant_id, stage);

-- ─────────────────────────────────────────────────────────────
-- Campaigns: one-shot broadcasts and multi-step drips
-- ─────────────────────────────────────────────────────────────

CREATE TABLE campaigns (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('broadcast', 'drip')),
  -- broadcast: {"text": "..."}
  -- drip:      {"steps": [{"delayHours": 0, "text": "..."}, {"delayHours": 24, "text": "..."}]}
  definition    JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft | sending | completed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX campaigns_tenant_idx ON campaigns (tenant_id);

-- One row per (campaign, contact). Drives both send tracking for a
-- broadcast and step progression for a drip.
CREATE TABLE campaign_recipients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | completed
  current_step    INTEGER NOT NULL DEFAULT 0, -- index into definition.steps, drip campaigns only
  next_send_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id)
);

CREATE INDEX campaign_recipients_due_idx ON campaign_recipients (status, next_send_at);
