-- 009_flows_soft_delete.sql
-- Adds soft deletion support to the flows table

ALTER TABLE flows ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Fast index for tenant queries excluding soft-deleted flows
CREATE INDEX IF NOT EXISTS idx_flows_tenant_deleted_at ON flows(tenant_id, deleted_at);
