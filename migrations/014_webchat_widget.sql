-- 014_webchat_widget.sql
-- Live Webchat Widget feature: Schema support for multi-tenant website chat widget and webchat channels

-- 1. Update channels table CHECK constraint to allow 'webchat' channel type
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check
  CHECK (type IN ('whatsapp', 'instagram', 'facebook', 'telegram', 'web', 'webchat'));

-- 2. Create webchat_widgets table for tenant widget customization and configuration
CREATE TABLE IF NOT EXISTS webchat_widgets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id         UUID NOT NULL UNIQUE REFERENCES channels(id) ON DELETE CASCADE,
  widget_key         TEXT NOT NULL UNIQUE,
  title              TEXT NOT NULL DEFAULT 'Chat with us',
  subtitle           TEXT NOT NULL DEFAULT 'We usually reply in minutes',
  primary_color      TEXT NOT NULL DEFAULT '#2563eb',
  greeting_message   TEXT NOT NULL DEFAULT 'Hello! How can we help you today?',
  placeholder_text   TEXT NOT NULL DEFAULT 'Type your message...',
  launcher_text      TEXT NOT NULL DEFAULT 'Chat with us',
  launcher_icon      TEXT NOT NULL DEFAULT 'chat',
  position           TEXT NOT NULL DEFAULT 'bottom-right' CHECK (position IN ('bottom-right', 'bottom-left')),
  require_email      BOOLEAN NOT NULL DEFAULT false,
  require_name       BOOLEAN NOT NULL DEFAULT false,
  allowed_origins    TEXT[] NOT NULL DEFAULT '{"*"}',
  is_active          BOOLEAN NOT NULL DEFAULT true,
  show_agent_avatar  BOOLEAN NOT NULL DEFAULT true,
  offline_message    TEXT NOT NULL DEFAULT 'We are currently offline. Please leave your message and email and we will get back to you.',
  business_hours     JSONB NOT NULL DEFAULT '{"enabled": false, "timezone": "UTC", "schedule": {}}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webchat_widgets_tenant_id ON webchat_widgets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_webchat_widgets_widget_key ON webchat_widgets(widget_key);
CREATE INDEX IF NOT EXISTS idx_webchat_widgets_channel_id ON webchat_widgets(channel_id);
