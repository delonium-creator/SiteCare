PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS site_config (
  site_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  pathname TEXT NOT NULL,
  phone TEXT NOT NULL,
  hours TEXT NOT NULL,
  cta_text TEXT NOT NULL,
  cta_link TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  CHECK (site_id = 'ketedes-page169452909'),
  CHECK (hostname = 'ketedes.tilda.ws'),
  CHECK (pathname = '/page169452909.html')
);

CREATE TABLE IF NOT EXISTS change_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('update', 'rollback', 'enable', 'disable')),
  field TEXT NOT NULL CHECK (field IN ('phone', 'hours', 'ctaText', 'ctaLink', 'enabled')),
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES site_config(site_id)
);

CREATE INDEX IF NOT EXISTS idx_change_history_site_version
  ON change_history(site_id, version DESC);

CREATE TABLE IF NOT EXISTS monitor_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  http_status INTEGER,
  details TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES site_config(site_id)
);

CREATE INDEX IF NOT EXISTS idx_monitor_runs_site_checked
  ON monitor_runs(site_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS auth_attempts (
  ip_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_started TEXT NOT NULL,
  blocked_until TEXT
);

INSERT OR IGNORE INTO site_config (
  site_id,
  hostname,
  pathname,
  phone,
  hours,
  cta_text,
  cta_link,
  enabled,
  version,
  updated_at,
  updated_by
) VALUES (
  'ketedes-page169452909',
  'ketedes.tilda.ws',
  '/page169452909.html',
  '+7 (495) 555-24-10',
  'Ежедневно, 10:00–20:00',
  'Записаться на встречу',
  'https://example.com/booking',
  0,
  1,
  datetime('now'),
  'initial-setup'
);
