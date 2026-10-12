-- ─────────────────────────────────────────────────────────────
-- Campaign delivery tracking
--
-- Until now a campaign recipient stopped at status 'sent' (provider accepted the
-- request) and provider delivery receipts never reached campaign_recipients, so
-- async failures (unapproved template, 24h window, invalid number) were invisible.
--
-- campaign_recipients.status now also takes: delivered | read
-- campaigns.status now also takes:            failed | partially_failed
-- (both columns are free TEXT without CHECK constraints, so no constraint change.)
--
-- Rollback: DROP INDEX IF EXISTS campaign_recipients_provider_msg_idx;
--           ALTER TABLE campaign_recipients DROP COLUMN IF EXISTS provider_message_id,
--             DROP COLUMN IF EXISTS delivered_at, DROP COLUMN IF EXISTS read_at,
--             DROP COLUMN IF EXISTS failed_at, DROP COLUMN IF EXISTS error_code;
-- ─────────────────────────────────────────────────────────────

ALTER TABLE campaign_recipients
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT,
  ADD COLUMN IF NOT EXISTS delivered_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error_code          TEXT;

-- Receipts arrive keyed by the provider message id; look recipients up by it.
CREATE INDEX IF NOT EXISTS campaign_recipients_provider_msg_idx
  ON campaign_recipients (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

COMMENT ON COLUMN campaigns.status IS 'draft | sending | completed | partially_failed | failed';
COMMENT ON COLUMN campaign_recipients.status IS 'pending | sent | delivered | read | failed | completed';
