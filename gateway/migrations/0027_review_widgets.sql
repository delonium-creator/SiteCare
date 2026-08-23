PRAGMA foreign_keys = ON;

-- Replaces the old two-URL-per-site table (platform_review_sources): the
-- operator now configures any number of real review sources per site, each
-- synced server-side into platform_reviews below instead of shown as a raw
-- third-party iframe. service_key and design_template_key are both
-- intentionally NOT constrained by a CHECK -- they're validated in
-- application code against the adapter registry
-- (gateway/src/review-sources/index.js) and the template registry
-- (gateway/src/platform-core.js) respectively, so adding future services or
-- design templates never forces a SQLite table-rebuild migration.
DROP TABLE IF EXISTS platform_review_sources;

CREATE TABLE IF NOT EXISTS platform_review_widgets (
  widget_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  service_key TEXT NOT NULL,
  business_identifier TEXT NOT NULL,
  design_template_key TEXT NOT NULL DEFAULT 'classic',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'ok', 'failed')),
  last_sync_at TEXT,
  last_sync_error TEXT,
  next_sync_at TEXT,
  review_count INTEGER NOT NULL DEFAULT 0,
  average_rating REAL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  UNIQUE (site_id, service_key, business_identifier),
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES platform_users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES platform_users(user_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_review_widgets_site ON platform_review_widgets(site_id, enabled);
CREATE INDEX IF NOT EXISTS idx_platform_review_widgets_due ON platform_review_widgets(enabled, next_sync_at);

-- One row per fetched review. external_review_id only needs to be stable
-- across syncs of the SAME widget_id (the source's own review id), so a
-- re-sync upserts in place instead of duplicating.
CREATE TABLE IF NOT EXISTS platform_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  widget_id TEXT NOT NULL,
  external_review_id TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  author_avatar_url TEXT,
  rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  review_text TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT,
  fetched_at TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  UNIQUE (widget_id, external_review_id),
  FOREIGN KEY (widget_id) REFERENCES platform_review_widgets(widget_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_platform_reviews_widget_date ON platform_reviews(widget_id, reviewed_at DESC);

-- Separate from loader_key -- the reviews widget script is optional and
-- typically lives on a different Tilda page/block than the main loader, so
-- rotating one must never require touching the other.
ALTER TABLE platform_sites ADD COLUMN reviews_widget_key TEXT;
