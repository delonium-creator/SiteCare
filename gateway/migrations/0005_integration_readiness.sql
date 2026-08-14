PRAGMA foreign_keys = ON;

ALTER TABLE platform_sites ADD COLUMN webhook_verified_at TEXT;
ALTER TABLE platform_sites ADD COLUMN form_verified_at TEXT;
ALTER TABLE platform_sites ADD COLUMN loader_ok INTEGER;
ALTER TABLE platform_sites ADD COLUMN loader_checked_at TEXT;

UPDATE platform_sites
SET webhook_verified_at = last_form_at,
    form_verified_at = last_form_at
WHERE last_form_at IS NOT NULL;
