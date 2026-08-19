PRAGMA foreign_keys = ON;

-- AI Analyst: short, structured observations generated from data SiteCare
-- already collects (health-score trend, leads volume, open incidents,
-- confirmed site changes). One active row per (site_id, type) — a fresh
-- run updates the existing row instead of piling up duplicates, and the
-- underlying condition clearing marks it resolved instead of leaving a
-- stale card on the dashboard forever.
CREATE TABLE IF NOT EXISTS ai_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('site_health', 'leads', 'diagnostics', 'site_change', 'connection', 'general')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'success', 'warning', 'critical')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  details TEXT,
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  source_data_json TEXT,
  recommended_action TEXT,
  action_target TEXT CHECK (action_target IS NULL OR action_target IN ('diagnostics', 'leads', 'site')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dismissed', 'resolved', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_site_status
  ON ai_insights(site_id, status, created_at DESC);
