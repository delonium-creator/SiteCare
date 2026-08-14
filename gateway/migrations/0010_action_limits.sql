PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS platform_action_limits (
  bucket_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bucket_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_platform_action_limits_updated
  ON platform_action_limits(updated_at);
