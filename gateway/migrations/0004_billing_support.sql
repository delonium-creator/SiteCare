PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS platform_billing (
  account_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'trial_pending' CHECK (status IN ('trial_pending', 'trial', 'active', 'past_due', 'complimentary', 'paused', 'canceled')),
  trial_started_at TEXT,
  current_period_end TEXT,
  extra_site_slots INTEGER NOT NULL DEFAULT 0 CHECK (extra_site_slots BETWEEN 0 AND 100),
  provider TEXT NOT NULL DEFAULT 'manual',
  checkout_url TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES platform_accounts(account_id)
);

INSERT OR IGNORE INTO platform_billing (
  account_id, status, trial_started_at, current_period_end, extra_site_slots, provider, checkout_url, updated_at
)
SELECT
  account_id,
  CASE
    WHEN plan = 'trial' AND trial_ends_at IS NULL THEN 'trial_pending'
    WHEN plan = 'trial' THEN 'trial'
    ELSE 'active'
  END,
  NULL,
  CASE WHEN plan = 'trial' THEN trial_ends_at ELSE NULL END,
  CASE plan WHEN 'starter' THEN 2 WHEN 'business' THEN 19 ELSE 0 END,
  'manual',
  '',
  updated_at
FROM platform_accounts;

CREATE TABLE IF NOT EXISTS platform_billing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES platform_accounts(account_id),
  FOREIGN KEY (created_by) REFERENCES platform_users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_billing_events_account_created
  ON platform_billing_events(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_support_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES platform_accounts(account_id),
  FOREIGN KEY (author_user_id) REFERENCES platform_users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_support_notes_account_created
  ON platform_support_notes(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_override_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  phone TEXT NOT NULL DEFAULT '',
  schedule_text TEXT NOT NULL DEFAULT '',
  button_text TEXT NOT NULL DEFAULT '',
  button_url TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id),
  FOREIGN KEY (created_by) REFERENCES platform_users(user_id),
  UNIQUE (site_id, version)
);

CREATE INDEX IF NOT EXISTS idx_platform_override_history_site_version
  ON platform_override_history(site_id, version DESC);

INSERT OR IGNORE INTO platform_override_history (
  site_id, version, enabled, phone, schedule_text, button_text, button_url, created_by, created_at
)
SELECT site_id, version, enabled, phone, schedule_text, button_text, button_url, NULL, updated_at
FROM platform_site_overrides;
