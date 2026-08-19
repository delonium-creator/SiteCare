PRAGMA foreign_keys = ON;

-- Image alt text is the fifth AI-editable kind. Unlike phone and button
-- edits (each with a dedicated rule table predating this pattern), every
-- new edit kind from here on reuses this one generalized table pair
-- instead of getting its own -- `field` distinguishes kinds, so adding the
-- next kind needs no new table and rollback support is automatic.
CREATE TABLE IF NOT EXISTS platform_content_rules (
  rule_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  field TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  page_path TEXT NOT NULL DEFAULT '/',
  block_id TEXT NOT NULL DEFAULT '',
  match_index INTEGER NOT NULL DEFAULT 0 CHECK (match_index BETWEEN 0 AND 10000),
  scope TEXT NOT NULL DEFAULT 'element' CHECK (scope IN ('element', 'page', 'site')),
  original_value TEXT NOT NULL DEFAULT '',
  new_value TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL CHECK (version > 0),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id),
  FOREIGN KEY (created_by) REFERENCES platform_users(user_id),
  UNIQUE (site_id, candidate_id, scope, field)
);
CREATE INDEX IF NOT EXISTS idx_platform_content_rules_site_field
  ON platform_content_rules(site_id, field, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_content_rule_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  field TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  page_path TEXT NOT NULL DEFAULT '/',
  block_id TEXT NOT NULL DEFAULT '',
  match_index INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL CHECK (scope IN ('element', 'page', 'site')),
  original_value TEXT NOT NULL DEFAULT '',
  new_value TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id),
  FOREIGN KEY (created_by) REFERENCES platform_users(user_id),
  UNIQUE (site_id, version, candidate_id, scope, field)
);
CREATE INDEX IF NOT EXISTS idx_platform_content_rule_history_site_version
  ON platform_content_rule_history(site_id, version DESC);

-- Same pattern as the phone_verified/schedule_verified/button_verified
-- columns added to this table in 0007_modular_access.sql.
ALTER TABLE platform_runtime_reports ADD COLUMN content_count INTEGER NOT NULL DEFAULT 0 CHECK (content_count BETWEEN 0 AND 10000);
ALTER TABLE platform_runtime_reports ADD COLUMN content_verified INTEGER NOT NULL DEFAULT 0 CHECK (content_verified IN (0, 1));

-- platform_change_records.kind is a CHECK constraint; SQLite has no ALTER
-- COLUMN for that, so rebuild the table -- same pattern already used for
-- gateway_deliveries in 0019_domain_expiry.sql when 'digest' was added.
CREATE TABLE platform_change_records_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  kind TEXT NOT NULL CHECK (kind IN ('phone', 'schedule', 'button_text', 'button_url', 'image_alt', 'rollback')),
  summary TEXT NOT NULL,
  target_label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'not_found')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id),
  FOREIGN KEY (created_by) REFERENCES platform_users(user_id)
);
INSERT INTO platform_change_records_new SELECT * FROM platform_change_records;
DROP TABLE platform_change_records;
ALTER TABLE platform_change_records_new RENAME TO platform_change_records;
CREATE INDEX IF NOT EXISTS idx_platform_change_records_site_created
  ON platform_change_records(site_id, created_at DESC);
