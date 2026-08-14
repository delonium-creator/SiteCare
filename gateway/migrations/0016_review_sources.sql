PRAGMA foreign_keys = ON;

-- Reviews are shown to the client as a read-only widget from Yandex Maps and
-- 2GIS themselves (their own official embeds), never scraped or hand-entered.
-- Support pastes the organization/branch id once; nothing else to maintain.
CREATE TABLE IF NOT EXISTS platform_review_sources (
  site_id TEXT PRIMARY KEY,
  yandex_org_id TEXT,
  dgis_branch_id TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES platform_users(user_id) ON DELETE SET NULL
);
