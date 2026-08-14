CREATE TABLE IF NOT EXISTS notification_settings (
  site_id TEXT PRIMARY KEY,
  encrypted_bot_token TEXT,
  chat_id TEXT,
  chat_type TEXT CHECK (chat_type IN ('private', 'group', 'supergroup')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  connect_code_hash TEXT,
  connect_expires_at TEXT,
  updated_at TEXT NOT NULL,
  last_delivery_at TEXT,
  last_delivery_ok INTEGER CHECK (last_delivery_ok IN (0, 1)),
  last_error TEXT,
  FOREIGN KEY (site_id) REFERENCES site_config(site_id)
);

CREATE TABLE IF NOT EXISTS notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('connection', 'test', 'page-down', 'page-recovered', 'form-down', 'form-recovered')),
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  created_at TEXT NOT NULL,
  details TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES site_config(site_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_events_site_created
  ON notification_events(site_id, created_at DESC);
