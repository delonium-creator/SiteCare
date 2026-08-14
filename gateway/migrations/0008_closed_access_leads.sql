CREATE TABLE IF NOT EXISTS platform_leads (
  lead_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  form_id TEXT,
  form_label TEXT NOT NULL DEFAULT 'Форма на сайте',
  page_url TEXT NOT NULL DEFAULT '',
  page_title TEXT NOT NULL DEFAULT '',
  source_label TEXT NOT NULL DEFAULT 'Сайт',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'completed', 'spam')),
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  note_ciphertext TEXT,
  note_iv TEXT,
  payload_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES platform_accounts(account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_leads_account_received
  ON platform_leads(account_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_leads_site_received
  ON platform_leads(site_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_leads_account_status
  ON platform_leads(account_id, status, received_at DESC);

CREATE TABLE IF NOT EXISTS platform_access_requests (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  FOREIGN KEY (user_id) REFERENCES platform_users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES platform_accounts(account_id) ON DELETE CASCADE,
  FOREIGN KEY (resolved_by) REFERENCES platform_users(user_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_platform_access_requests_status
  ON platform_access_requests(status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_access_requests_user
  ON platform_access_requests(user_id, requested_at DESC);
