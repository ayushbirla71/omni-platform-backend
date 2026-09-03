-- 001_init.sql
-- Core schema for the omnichannel platform. Plain SQL, applied by src/db/migrate.ts.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ─────────────────────────────────────────────────────────────
-- Tenancy & auth
-- ─────────────────────────────────────────────────────────────

CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'free',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'owner', -- owner | admin | agent | viewer
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- Email must be globally lookup-able at login time before we know the tenant
CREATE UNIQUE INDEX users_email_unique_idx ON users (lower(email));

-- ─────────────────────────────────────────────────────────────
-- Channels (WhatsApp / Instagram / Facebook / Telegram / Web)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE channels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('whatsapp','instagram','facebook','telegram','web')),
  display_name    TEXT NOT NULL,
  credentials     JSONB NOT NULL DEFAULT '{}',  -- BSP API key, phone number id, page token, etc. (encrypt at app layer)
  status          TEXT NOT NULL DEFAULT 'active', -- active | disabled
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX channels_tenant_idx ON channels (tenant_id);

-- ─────────────────────────────────────────────────────────────
-- Contacts (the person on the other end of a channel)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_id   TEXT NOT NULL,  -- phone number / IG user id / Telegram chat id, etc.
  name          TEXT,
  attributes    JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, external_id)
);

CREATE INDEX contacts_tenant_idx ON contacts (tenant_id);

-- ─────────────────────────────────────────────────────────────
-- Conversations & messages
-- ─────────────────────────────────────────────────────────────

CREATE TABLE conversations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id        UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel_id        UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'open', -- open | pending | closed
  assigned_agent_id UUID REFERENCES users(id),
  last_message_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX conversations_tenant_idx ON conversations (tenant_id);
CREATE INDEX conversations_status_idx ON conversations (tenant_id, status);

CREATE TABLE messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id   UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction         TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  type              TEXT NOT NULL DEFAULT 'text', -- text | image | document | template | button, etc.
  content           JSONB NOT NULL,
  sender_user_id    UUID REFERENCES users(id), -- set for outbound agent-sent messages
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX messages_conversation_idx ON messages (conversation_id, sent_at);
CREATE INDEX messages_tenant_idx ON messages (tenant_id);

-- ─────────────────────────────────────────────────────────────
-- Flows (no-code bot builder) — schema only, engine comes in phase 2
-- ─────────────────────────────────────────────────────────────

CREATE TABLE flows (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  definition    JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  status        TEXT NOT NULL DEFAULT 'draft', -- draft | published
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX flows_tenant_idx ON flows (tenant_id);

CREATE TABLE flow_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  flow_id           UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  current_node_id   TEXT,
  variables         JSONB NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'running', -- running | completed | handed_off
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX flow_runs_conversation_idx ON flow_runs (conversation_id);
