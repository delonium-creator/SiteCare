CREATE TABLE IF NOT EXISTS gateway_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_sites (
  site_id TEXT PRIMARY KEY,
  site_name TEXT NOT NULL,
  target_url TEXT NOT NULL,
  site_token_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_destinations (
  site_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  chat_type TEXT NOT NULL CHECK (chat_type IN ('private', 'group', 'supergroup')),
  telegram_user_id TEXT,
  linked_at TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  FOREIGN KEY (site_id) REFERENCES gateway_sites(site_id)
);

CREATE TABLE IF NOT EXISTS telegram_connect_sessions (
  token_hash TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (site_id) REFERENCES gateway_sites(site_id)
);

CREATE INDEX IF NOT EXISTS idx_gateway_connect_site_expires
  ON telegram_connect_sessions(site_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS gateway_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('connection', 'test', 'page-down', 'page-recovered', 'form-down', 'form-recovered')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  details TEXT NOT NULL,
  UNIQUE (site_id, event_id),
  FOREIGN KEY (site_id) REFERENCES gateway_sites(site_id)
);

CREATE INDEX IF NOT EXISTS idx_gateway_deliveries_site_created
  ON gateway_deliveries(site_id, created_at DESC);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL
);
