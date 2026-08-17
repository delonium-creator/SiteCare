PRAGMA foreign_keys = ON;

-- platform_monitor_runs is capped at the last 1000 rows/site (see
-- platform-monitor.js), which at the 5-minute cron cadence is only ~3.5
-- days -- any report window beyond that has been silently under-counting.
-- A once-daily rollup keeps a compact, unbounded-retention record per site
-- so 30/90-day uptime reporting stays accurate long after raw runs are
-- pruned. platform_incidents has no retention cap anywhere, so incident
-- counts already stay accurate without a rollup -- only the raw run table
-- needed one.
ALTER TABLE platform_sites ADD COLUMN next_rollup_at TEXT;

CREATE TABLE IF NOT EXISTS platform_monitor_daily (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  checks INTEGER NOT NULL DEFAULT 0,
  page_ok_count INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day),
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_monitor_daily_site_day
  ON platform_monitor_daily(site_id, day DESC);

CREATE INDEX IF NOT EXISTS idx_platform_sites_rollup_due
  ON platform_sites(integration_mode, status, next_rollup_at);
