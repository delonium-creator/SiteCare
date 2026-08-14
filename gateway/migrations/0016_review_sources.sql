PRAGMA foreign_keys = ON;

-- Reviews are shown to the client as a read-only widget from Yandex Maps and
-- 2GIS themselves (their own official embeds), never scraped or hand-entered.
-- Yandex/2GIS only hand out a ready-made embed snippet from the business's own
-- account (Поделиться -> Виджет с отзывами / Отзывы -> Виджет с рейтингом),
-- not a bare organization id, so support stores the iframe src url from that
-- snippet -- nothing else to maintain, and SiteCare controls the surrounding
-- iframe markup itself rather than rendering arbitrary pasted HTML.
CREATE TABLE IF NOT EXISTS platform_review_sources (
  site_id TEXT PRIMARY KEY,
  yandex_widget_url TEXT,
  dgis_widget_url TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES platform_users(user_id) ON DELETE SET NULL
);
