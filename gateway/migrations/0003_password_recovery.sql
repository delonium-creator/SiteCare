PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS platform_password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES platform_users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_password_resets_user
  ON platform_password_resets(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_password_resets_expiry
  ON platform_password_resets(expires_at, used_at);

CREATE TABLE IF NOT EXISTS platform_password_reset_limits (
  key_hash TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0 CHECK (requests BETWEEN 0 AND 1000),
  window_started_at TEXT NOT NULL,
  blocked_until TEXT,
  updated_at TEXT NOT NULL
);

