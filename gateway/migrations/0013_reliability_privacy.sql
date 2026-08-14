PRAGMA foreign_keys = ON;

-- Every form is tracked separately. One working form can no longer make an
-- account with several disconnected forms look completely healthy.
CREATE TABLE IF NOT EXISTS platform_form_connections (
  site_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  first_received_at TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  receipt_count INTEGER NOT NULL DEFAULT 1 CHECK (receipt_count > 0),
  PRIMARY KEY (site_id, form_id),
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_form_connections_site_last
  ON platform_form_connections(site_id, last_received_at DESC);

-- Test markers are valid only when the panel issued them. Marker-looking user
-- data is stored as a normal lead instead of being silently discarded.
CREATE TABLE IF NOT EXISTS platform_form_test_sessions (
  session_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  marker_hash TEXT NOT NULL,
  marker_kind TEXT NOT NULL CHECK (marker_kind IN ('text', 'phone')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'expired')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES platform_users(user_id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_form_test_marker
  ON platform_form_test_sessions(site_id, marker_hash);

CREATE INDEX IF NOT EXISTS idx_platform_form_test_site_created
  ON platform_form_test_sessions(site_id, created_at DESC);

-- Tilda repeats webhook delivery when a response is delayed. This short-lived
-- idempotency table prevents duplicate leads without blocking a genuinely new
-- submission with the same answers on another day.
CREATE TABLE IF NOT EXISTS platform_webhook_dedup (
  site_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  lead_id TEXT,
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (site_id, payload_hash),
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_webhook_dedup_expires
  ON platform_webhook_dedup(expires_at);

-- New client/support messages are encrypted with the same protected-data key
-- as leads. Existing rows remain readable through the legacy content column.
ALTER TABLE platform_conversation_messages ADD COLUMN content_ciphertext TEXT;
ALTER TABLE platform_conversation_messages ADD COLUMN content_iv TEXT;
