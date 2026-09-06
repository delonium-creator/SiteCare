-- DNS/TLS were not independently measured when a request failed. Preserve
-- history, representing those observations as unknown rather than broken.
CREATE TABLE platform_monitor_runs_reliable (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  domain_ok INTEGER CHECK (domain_ok IS NULL OR domain_ok IN (0, 1)),
  tls_ok INTEGER CHECK (tls_ok IS NULL OR tls_ok IN (0, 1)),
  page_ok INTEGER NOT NULL CHECK (page_ok IN (0, 1)),
  form_ok INTEGER NOT NULL CHECK (form_ok IN (0, 1)),
  http_status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  form_count INTEGER NOT NULL,
  details TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id)
);
INSERT INTO platform_monitor_runs_reliable
  SELECT id, site_id, checked_at,
    CASE WHEN http_status = 0 THEN NULL ELSE domain_ok END,
    CASE WHEN http_status = 0 THEN NULL ELSE tls_ok END,
    page_ok, form_ok, http_status, latency_ms, form_count, details
  FROM platform_monitor_runs;
DROP TABLE platform_monitor_runs;
ALTER TABLE platform_monitor_runs_reliable RENAME TO platform_monitor_runs;
CREATE INDEX idx_platform_monitor_runs_site_checked ON platform_monitor_runs(site_id, checked_at DESC);
UPDATE platform_sites SET domain_ok = NULL, tls_ok = NULL WHERE last_http_status = 0;

-- An attempt timestamp is not proof of a successful snapshot. Revision
-- guards prevent an in-flight fetch from repopulating a replaced source.
ALTER TABLE platform_review_widgets ADD COLUMN last_success_at TEXT;
ALTER TABLE platform_review_widgets ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 1;
UPDATE platform_review_widgets SET last_success_at = CASE
  WHEN sync_status = 'ok' THEN last_sync_at
  ELSE (SELECT MAX(fetched_at) FROM platform_reviews r WHERE r.widget_id = platform_review_widgets.widget_id)
END;
