PRAGMA foreign_keys = ON;

-- A weekly digest is a positive report even when nothing broke: "checked N
-- times, health score steady" instead of silence. Delivered through the same
-- Telegram + dedup path as incident alerts, and kept in-app for a compact
-- "this week" card without a growing event feed.
ALTER TABLE platform_sites ADD COLUMN next_digest_at TEXT;

CREATE TABLE IF NOT EXISTS platform_digests (
  digest_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  score INTEGER,
  score_delta INTEGER,
  checks_count INTEGER NOT NULL DEFAULT 0,
  incidents_opened INTEGER NOT NULL DEFAULT 0,
  incidents_resolved INTEGER NOT NULL DEFAULT 0,
  findings_count INTEGER NOT NULL DEFAULT 0,
  summary_text TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_digests_site_created
  ON platform_digests(site_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_sites_digest_due
  ON platform_sites(integration_mode, status, next_digest_at);

-- Give already-connected sites a first digest a week out, in the same
-- ISO-8601-with-milliseconds format the app writes everywhere else.
UPDATE platform_sites
SET next_digest_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days')
WHERE next_digest_at IS NULL AND status = 'active' AND integration_mode = 'central';
