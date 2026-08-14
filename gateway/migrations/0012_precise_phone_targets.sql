PRAGMA foreign_keys = ON;

-- Precise phone rules distinguish identical numbers by page, section and
-- occurrence. Legacy number-wide rules remain supported and are migrated
-- lazily when a client chooses an exact occurrence in the assistant.
CREATE TABLE IF NOT EXISTS platform_phone_target_rules (
  rule_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  page_path TEXT NOT NULL DEFAULT '/',
  block_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'text' CHECK (source IN ('link', 'text')),
  original_phone TEXT NOT NULL,
  original_digits TEXT NOT NULL,
  occurrence_index INTEGER NOT NULL DEFAULT 0 CHECK (occurrence_index BETWEEN 0 AND 10000),
  scope TEXT NOT NULL DEFAULT 'element' CHECK (scope IN ('element', 'page', 'site')),
  new_phone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL CHECK (version > 0),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id),
  FOREIGN KEY (created_by) REFERENCES platform_users(user_id),
  UNIQUE (site_id, candidate_id, scope)
);

CREATE INDEX IF NOT EXISTS idx_platform_phone_target_rules_site_enabled
  ON platform_phone_target_rules(site_id, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_phone_target_rule_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  candidate_id TEXT NOT NULL,
  page_path TEXT NOT NULL DEFAULT '/',
  block_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'text' CHECK (source IN ('link', 'text')),
  original_phone TEXT NOT NULL,
  original_digits TEXT NOT NULL,
  occurrence_index INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL CHECK (scope IN ('element', 'page', 'site')),
  new_phone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id),
  FOREIGN KEY (created_by) REFERENCES platform_users(user_id),
  UNIQUE (site_id, version, candidate_id, scope)
);

CREATE INDEX IF NOT EXISTS idx_platform_phone_target_rule_history_site_version
  ON platform_phone_target_rule_history(site_id, version DESC);
