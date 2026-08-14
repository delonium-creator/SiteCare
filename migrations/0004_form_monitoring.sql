CREATE TABLE IF NOT EXISTS form_monitor_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  http_status INTEGER,
  form_count INTEGER NOT NULL CHECK (form_count >= 0),
  ready_count INTEGER NOT NULL CHECK (ready_count >= 0),
  receiver_count INTEGER NOT NULL CHECK (receiver_count >= 0),
  details TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES site_config(site_id)
);

CREATE INDEX IF NOT EXISTS idx_form_monitor_runs_site_checked
  ON form_monitor_runs(site_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS form_test_sessions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  marker_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  FOREIGN KEY (site_id) REFERENCES site_config(site_id)
);

CREATE INDEX IF NOT EXISTS idx_form_test_sessions_site_created
  ON form_test_sessions(site_id, created_at DESC);

CREATE TABLE IF NOT EXISTS form_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  form_id TEXT,
  field_names_json TEXT NOT NULL,
  field_count INTEGER NOT NULL CHECK (field_count > 0),
  payload_hash TEXT NOT NULL,
  matched_test INTEGER NOT NULL DEFAULT 0 CHECK (matched_test IN (0, 1)),
  test_session_id TEXT,
  FOREIGN KEY (site_id) REFERENCES site_config(site_id),
  FOREIGN KEY (test_session_id) REFERENCES form_test_sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_form_receipts_site_received
  ON form_receipts(site_id, received_at DESC);
