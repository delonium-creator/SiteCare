PRAGMA foreign_keys = ON;

-- Yandex Metrica read-only integration. One SiteCare-wide OAuth app
-- (client_id/client_secret set as Worker secrets by the operator)
-- authorizes access to many different clients' own counters, mirroring
-- the Telegram bot pattern: one bot, many linked chats. The counter id
-- is auto-detected during the existing site scan when possible, so a
-- client with Metrica already installed never has to type it in.
ALTER TABLE platform_sites ADD COLUMN metrika_counter_id TEXT;

CREATE TABLE IF NOT EXISTS yandex_metrica_connect_sessions (
  state_hash TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_yandex_connect_site_expires ON yandex_metrica_connect_sessions(site_id, expires_at DESC);

-- Tokens are stored encrypted (AES-GCM, same at-rest approach as
-- platform_leads.payload_ciphertext) - the ciphertext/iv pair is
-- meaningless without the LEADS_DATA_KEY Worker secret.
CREATE TABLE IF NOT EXISTS yandex_metrica_connections (
  site_id TEXT PRIMARY KEY,
  counter_id TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  refresh_token_iv TEXT,
  token_expires_at TEXT,
  yandex_login TEXT,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE
);
