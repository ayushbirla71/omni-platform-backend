-- 004_tags_and_flow_campaigns.sql
-- Add GIN index for fast contact tag filtering and update campaign type check to allow 'flow'

CREATE INDEX IF NOT EXISTS contacts_attributes_gin_idx ON contacts USING gin (attributes);

ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_type_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_type_check CHECK (type IN ('broadcast', 'drip', 'flow'));
