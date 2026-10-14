-- ─────────────────────────────────────────────────────────────
-- Team inbox: support teams + safe agent assignment
--
--   * teams / team_members: a conversation can be assigned to a support team (and/or an agent).
--   * conversations.assigned_team_id: the team the case is routed to.
--   * conversations.assigned_agent_id previously had no ON DELETE action, so removing a team
--     member who still had assigned conversations failed; it now becomes unassigned instead.
--
-- The ALTER of the FK takes a short ACCESS EXCLUSIVE lock on conversations; run it in a quiet window.
--
-- Rollback: DROP INDEX IF EXISTS conversations_tenant_team_idx, conversations_tenant_agent_idx;
--           ALTER TABLE conversations DROP COLUMN IF EXISTS assigned_team_id;
--           DROP TABLE IF EXISTS team_members; DROP TABLE IF EXISTS teams;
--           (the assigned_agent_id FK can stay as ON DELETE SET NULL; it is backwards compatible)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS team_members_tenant_user_idx ON team_members (tenant_id, user_id);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS assigned_team_id UUID REFERENCES teams(id) ON DELETE SET NULL;

-- Replace the assigned_agent_id FK (whatever it is named) with an ON DELETE SET NULL one.
DO $$
DECLARE
  fk_name TEXT;
BEGIN
  SELECT con.conname INTO fk_name
  FROM pg_constraint con
  JOIN pg_attribute att
    ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
  WHERE con.conrelid = 'conversations'::regclass
    AND con.contype = 'f'
    AND att.attname = 'assigned_agent_id';

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE conversations DROP CONSTRAINT %I', fk_name);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'conversations'::regclass AND conname = 'conversations_assigned_agent_id_fkey'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_assigned_agent_id_fkey
      FOREIGN KEY (assigned_agent_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS conversations_tenant_agent_idx
  ON conversations (tenant_id, assigned_agent_id);
CREATE INDEX IF NOT EXISTS conversations_tenant_team_idx
  ON conversations (tenant_id, assigned_team_id);

COMMENT ON COLUMN conversations.status IS 'open | pending | closed';
