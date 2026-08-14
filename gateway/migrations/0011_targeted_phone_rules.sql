PRAGMA foreign_keys = ON;

-- Phone changes are bound to the exact number found on the published site.
-- The legacy site-wide phone column remains readable for older installations
-- and is converted to explicit rules on the first targeted edit.
CREATE TABLE IF NOT EXISTS platform_phone_rules (
  rule_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  original_phone TEXT NOT NULL,
  original_digits TEXT NOT NULL,
  new_phone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL CHECK (version > 0),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id),
  FOREIGN KEY (created_by) REFERENCES platform_users(user_id),
  UNIQUE (site_id, original_digits)
);

CREATE INDEX IF NOT EXISTS idx_platform_phone_rules_site_enabled
  ON platform_phone_rules(site_id, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_phone_rule_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  original_phone TEXT NOT NULL,
  original_digits TEXT NOT NULL,
  new_phone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id),
  FOREIGN KEY (created_by) REFERENCES platform_users(user_id),
  UNIQUE (site_id, version, original_digits)
);

CREATE INDEX IF NOT EXISTS idx_platform_phone_rule_history_site_version
  ON platform_phone_rule_history(site_id, version DESC);
