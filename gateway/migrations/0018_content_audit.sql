PRAGMA foreign_keys = ON;

-- Detects edits made directly in Tilda (not through SiteCare) by diffing each
-- day's scan against the last known value per tracked field. Snapshot rows
-- hold "last known value" only (upserted every audit); the log table is the
-- append-only history a client actually reads. Field values are stored as
-- content, not hashes, so the change log can render human-readable
-- "before -> after" text without re-fetching the page.
ALTER TABLE platform_sites ADD COLUMN last_content_audit_at TEXT;
ALTER TABLE platform_sites ADD COLUMN next_content_audit_at TEXT;

CREATE TABLE IF NOT EXISTS platform_content_snapshots (
  site_id TEXT NOT NULL,
  page_path TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('title', 'description', 'h1', 'schedule', 'phone', 'button_text', 'button_url')),
  slot_key TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, page_path, field, slot_key),
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS platform_content_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  page_path TEXT NOT NULL,
  page_title TEXT NOT NULL DEFAULT '',
  field TEXT NOT NULL CHECK (field IN ('title', 'description', 'h1', 'schedule', 'phone', 'button_text', 'button_url')),
  slot_label TEXT NOT NULL DEFAULT '',
  old_value TEXT NOT NULL DEFAULT '',
  new_value TEXT NOT NULL DEFAULT '',
  detected_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_content_changes_site_detected
  ON platform_content_changes(site_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_sites_content_audit_due
  ON platform_sites(integration_mode, status, next_content_audit_at);
