-- 010_conversations_24h_window.sql
-- Adds last_inbound_at to conversations to track Meta's 24-hour customer service window

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ DEFAULT NULL;

-- Fast index for window queries
CREATE INDEX IF NOT EXISTS idx_conversations_last_inbound_at ON conversations(tenant_id, last_inbound_at);
