PRAGMA foreign_keys = ON;

-- SiteCare 4.5 manages a Tilda project as one site. Existing page-scoped
-- records are widened to the same origin so clients do not have to reconnect.
UPDATE platform_sites
SET scope = 'site'
WHERE scope = 'page';

CREATE TABLE IF NOT EXISTS platform_button_rules (
  rule_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  page_path TEXT NOT NULL DEFAULT '/',
  block_id TEXT NOT NULL DEFAULT '',
  original_text TEXT NOT NULL DEFAULT '',
  original_url TEXT NOT NULL DEFAULT '',
  match_index INTEGER NOT NULL DEFAULT 0 CHECK (match_index BETWEEN 0 AND 10000),
  scope TEXT NOT NULL DEFAULT 'element' CHECK (scope IN ('element', 'page', 'site')),
  new_text TEXT NOT NULL DEFAULT '',
  new_url TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id),
  FOREIGN KEY (created_by) REFERENCES platform_users(user_id),
  UNIQUE (site_id, candidate_id, scope)
);

CREATE INDEX IF NOT EXISTS idx_platform_button_rules_site_enabled
  ON platform_button_rules(site_id, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_button_rule_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  candidate_id TEXT NOT NULL,
  page_path TEXT NOT NULL DEFAULT '/',
  block_id TEXT NOT NULL DEFAULT '',
  original_text TEXT NOT NULL DEFAULT '',
  original_url TEXT NOT NULL DEFAULT '',
  match_index INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL CHECK (scope IN ('element', 'page', 'site')),
  new_text TEXT NOT NULL DEFAULT '',
  new_url TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id),
  FOREIGN KEY (created_by) REFERENCES platform_users(user_id),
  UNIQUE (site_id, version, candidate_id, scope)
);

CREATE INDEX IF NOT EXISTS idx_platform_button_rule_history_site_version
  ON platform_button_rule_history(site_id, version DESC);

CREATE TABLE IF NOT EXISTS platform_runtime_reports (
  site_id TEXT NOT NULL,
  pathname TEXT NOT NULL,
  config_version INTEGER NOT NULL CHECK (config_version > 0),
  phone_count INTEGER NOT NULL DEFAULT 0 CHECK (phone_count BETWEEN 0 AND 10000),
  schedule_count INTEGER NOT NULL DEFAULT 0 CHECK (schedule_count BETWEEN 0 AND 10000),
  button_count INTEGER NOT NULL DEFAULT 0 CHECK (button_count BETWEEN 0 AND 10000),
  error_text TEXT NOT NULL DEFAULT '',
  reported_at TEXT NOT NULL,
  PRIMARY KEY (site_id, pathname),
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_runtime_reports_site_version
  ON platform_runtime_reports(site_id, config_version, reported_at DESC);

CREATE TABLE IF NOT EXISTS platform_change_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  kind TEXT NOT NULL CHECK (kind IN ('phone', 'schedule', 'button_text', 'button_url', 'rollback')),
  summary TEXT NOT NULL,
  target_label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'not_found')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id),
  FOREIGN KEY (created_by) REFERENCES platform_users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_change_records_site_created
  ON platform_change_records(site_id, created_at DESC);
