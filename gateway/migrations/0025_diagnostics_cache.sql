PRAGMA foreign_keys = ON;

-- Caches the last full diagnostics scan per site so the "Состояние сайта"
-- page can show real numbers on load instead of blanks until the client
-- manually clicks "Запустить проверку" again. platform_health_history
-- already stores a per-scan summary row (score/high/medium/low), but not
-- the full issues list / category scores the diagnostics page renders --
-- this table holds exactly one row per site, overwritten on every scan.
CREATE TABLE IF NOT EXISTS platform_diagnostics_cache (
  site_id TEXT PRIMARY KEY,
  diagnostics_json TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id)
);
