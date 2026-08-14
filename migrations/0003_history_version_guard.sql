CREATE UNIQUE INDEX IF NOT EXISTS idx_change_history_site_version_unique
  ON change_history(site_id, version);
