-- 002_flows_extra.sql
-- Lets a channel declare which published flow greets a brand-new conversation.

ALTER TABLE channels ADD COLUMN default_flow_id UUID REFERENCES flows(id);
