-- ─────────────────────────────────────────────────────────────
-- Forgot / reset password
--
-- password_reset_tokens stores only the SHA-256 hash of each emailed token,
-- never the token itself. Tokens are single-use (used_at) and short-lived
-- (expires_at, 30 minutes from issue).
--
-- users.password_changed_at is set when a password is reset; requireAuth
-- rejects JWTs issued before it so old sessions are logged out. It is NULL
-- for every existing user, so nobody is affected until they reset.
--
-- Rollback: DROP TABLE IF EXISTS password_reset_tokens;
--           ALTER TABLE users DROP COLUMN IF EXISTS password_changed_at;
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  request_ip  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens (user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
