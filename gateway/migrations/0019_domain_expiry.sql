PRAGMA foreign_keys = ON;

-- RDAP lookup runs weekly (registration data changes rarely); latest-known
-- value only, no history table -- same "cache facts directly on the site
-- row" approach platform_sites already uses for domain_ok/tls_ok.
ALTER TABLE platform_sites ADD COLUMN domain_expires_at TEXT;
ALTER TABLE platform_sites ADD COLUMN domain_registrar TEXT;
ALTER TABLE platform_sites ADD COLUMN last_domain_check_at TEXT;
ALTER TABLE platform_sites ADD COLUMN next_domain_check_at TEXT;
ALTER TABLE platform_sites ADD COLUMN domain_check_error TEXT;

CREATE INDEX IF NOT EXISTS idx_platform_sites_domain_due
  ON platform_sites(integration_mode, status, next_domain_check_at);

-- Pre-existing bug found while wiring the new domain-expiry Telegram alert
-- through the shared notification path: sendDigest() has been calling
-- sendNotification(..., "digest", ...) since digests shipped, but the
-- gateway_deliveries CHECK never allowed 'digest' as an event_type, and the
-- insert sits outside the try/catch that guards Telegram failures -- every
-- weekly digest to a Telegram-connected site has been throwing silently.
-- SQLite has no ALTER COLUMN for CHECK constraints, so recreate the table.
CREATE TABLE gateway_deliveries_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('connection', 'test', 'page-down', 'page-recovered', 'form-down', 'form-recovered', 'digest', 'domain-expiring')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  details TEXT NOT NULL,
  UNIQUE (site_id, event_id),
  FOREIGN KEY (site_id) REFERENCES gateway_sites(site_id)
);

INSERT INTO gateway_deliveries_new SELECT * FROM gateway_deliveries;
DROP TABLE gateway_deliveries;
ALTER TABLE gateway_deliveries_new RENAME TO gateway_deliveries;

-- Dropping the old table also dropped its index; recreate it (the UNIQUE
-- constraint above already covers (site_id, event_id) with its own index).
CREATE INDEX IF NOT EXISTS idx_gateway_deliveries_site_created
  ON gateway_deliveries(site_id, created_at DESC);
