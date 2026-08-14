PRAGMA foreign_keys = ON;

-- A single trackable number turns "nothing broke this week" into a visible
-- result instead of silence. Computed from the same severity counts the
-- diagnostics scan already produces, on its own slower schedule so a full
-- site crawl does not run on every 5-minute uptime tick.
ALTER TABLE platform_sites ADD COLUMN last_health_check_at TEXT;
ALTER TABLE platform_sites ADD COLUMN next_health_check_at TEXT;
ALTER TABLE platform_sites ADD COLUMN health_score INTEGER CHECK (health_score IS NULL OR health_score BETWEEN 0 AND 100);

CREATE TABLE IF NOT EXISTS platform_health_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  high INTEGER NOT NULL DEFAULT 0,
  medium INTEGER NOT NULL DEFAULT 0,
  low INTEGER NOT NULL DEFAULT 0,
  issue_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_health_history_site_checked
  ON platform_health_history(site_id, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_sites_health_due
  ON platform_sites(integration_mode, status, next_health_check_at);
