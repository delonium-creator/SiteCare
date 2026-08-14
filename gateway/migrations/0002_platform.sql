PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS platform_accounts (
  account_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial', 'starter', 'business')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  trial_ends_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_users (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK (password_iterations BETWEEN 50000 AND 500000),
  platform_role TEXT NOT NULL DEFAULT 'user' CHECK (platform_role IN ('user', 'operator')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_memberships (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'viewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, user_id),
  FOREIGN KEY (account_id) REFERENCES platform_accounts(account_id),
  FOREIGN KEY (user_id) REFERENCES platform_users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_memberships_user
  ON platform_memberships(user_id, account_id);

CREATE TABLE IF NOT EXISTS platform_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES platform_users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_sessions_user_expires
  ON platform_sessions(user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS platform_auth_attempts (
  identity_hash TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  blocked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_invites (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'viewer')),
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by TEXT,
  FOREIGN KEY (account_id) REFERENCES platform_accounts(account_id),
  FOREIGN KEY (invited_by) REFERENCES platform_users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_invites_account_expires
  ON platform_invites(account_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS platform_sites (
  site_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  target_url TEXT NOT NULL,
  target_origin TEXT NOT NULL,
  target_pathname TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'page' CHECK (scope IN ('page', 'site')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  integration_mode TEXT NOT NULL DEFAULT 'central' CHECK (integration_mode IN ('central', 'legacy')),
  form_required INTEGER NOT NULL DEFAULT 0 CHECK (form_required IN (0, 1)),
  expected_form_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_form_count BETWEEN 0 AND 20),
  webhook_token_hash TEXT,
  loader_key TEXT NOT NULL,
  monitor_interval_minutes INTEGER NOT NULL DEFAULT 30 CHECK (monitor_interval_minutes BETWEEN 5 AND 1440),
  last_monitor_at TEXT,
  next_monitor_at TEXT,
  domain_ok INTEGER CHECK (domain_ok IS NULL OR domain_ok IN (0, 1)),
  tls_ok INTEGER CHECK (tls_ok IS NULL OR tls_ok IN (0, 1)),
  page_ok INTEGER CHECK (page_ok IS NULL OR page_ok IN (0, 1)),
  form_ok INTEGER CHECK (form_ok IS NULL OR form_ok IN (0, 1)),
  last_http_status INTEGER,
  last_latency_ms INTEGER,
  last_error TEXT,
  last_form_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES platform_accounts(account_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_sites_account_status
  ON platform_sites(account_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_sites_due
  ON platform_sites(integration_mode, status, next_monitor_at);

CREATE TABLE IF NOT EXISTS platform_site_overrides (
  site_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  phone TEXT NOT NULL DEFAULT '',
  schedule_text TEXT NOT NULL DEFAULT '',
  button_text TEXT NOT NULL DEFAULT '',
  button_url TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id)
);

CREATE TABLE IF NOT EXISTS platform_monitor_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  domain_ok INTEGER NOT NULL CHECK (domain_ok IN (0, 1)),
  tls_ok INTEGER NOT NULL CHECK (tls_ok IN (0, 1)),
  page_ok INTEGER NOT NULL CHECK (page_ok IN (0, 1)),
  form_ok INTEGER NOT NULL CHECK (form_ok IN (0, 1)),
  http_status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  form_count INTEGER NOT NULL,
  details TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_monitor_runs_site_checked
  ON platform_monitor_runs(site_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS platform_incidents (
  incident_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('page', 'form')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  summary TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  last_notified_at TEXT,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_incidents_one_open
  ON platform_incidents(site_id, kind) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_platform_incidents_site_opened
  ON platform_incidents(site_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS platform_form_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  form_id TEXT,
  field_names_json TEXT NOT NULL,
  field_count INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_form_receipts_site_received
  ON platform_form_receipts(site_id, received_at DESC);

CREATE TABLE IF NOT EXISTS platform_usage_daily (
  account_id TEXT NOT NULL,
  usage_day TEXT NOT NULL,
  monitor_checks INTEGER NOT NULL DEFAULT 0,
  form_signals INTEGER NOT NULL DEFAULT 0,
  ai_requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, usage_day),
  FOREIGN KEY (account_id) REFERENCES platform_accounts(account_id)
);

CREATE TABLE IF NOT EXISTS platform_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_account_created
  ON platform_audit_log(account_id, created_at DESC);
