-- ─────────────────────────────────────────────────────────────
-- Campaign flow answers
--
-- Flow answers were only kept in flow_runs.variables (overwritten in place, no
-- question text, no timestamp, no link to a campaign). To let a tenant export the
-- responses to a campaign we now:
--   1. stamp the flow run started by a campaign with the campaign + recipient, and
--   2. store each answered question (input node / template button) in campaign_answers.
--
-- One row per (flow_run_id, node_id): a re-asked question keeps the latest answer.
-- Only runs that belong to a campaign write here; this does not track outbound messages.
--
-- Rollback: DROP TABLE IF EXISTS campaign_answers;
--           DROP INDEX IF EXISTS flow_runs_campaign_recipient_idx;
--           ALTER TABLE flow_runs DROP COLUMN IF EXISTS campaign_id,
--             DROP COLUMN IF EXISTS campaign_recipient_id;
-- ─────────────────────────────────────────────────────────────

ALTER TABLE flow_runs
  ADD COLUMN IF NOT EXISTS campaign_id           UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS campaign_recipient_id UUID REFERENCES campaign_recipients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS flow_runs_campaign_recipient_idx
  ON flow_runs (campaign_recipient_id)
  WHERE campaign_recipient_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS campaign_answers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id           UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  campaign_recipient_id UUID NOT NULL REFERENCES campaign_recipients(id) ON DELETE CASCADE,
  flow_run_id           UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  node_id               TEXT NOT NULL,
  question              TEXT NOT NULL,
  answer                TEXT NOT NULL,
  answered_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (flow_run_id, node_id)
);

CREATE INDEX IF NOT EXISTS campaign_answers_tenant_campaign_idx
  ON campaign_answers (tenant_id, campaign_id);

CREATE INDEX IF NOT EXISTS campaign_answers_recipient_idx
  ON campaign_answers (campaign_recipient_id);
