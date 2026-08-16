PRAGMA foreign_keys = ON;

-- "Select on site" hands a clicked phone/button location back to the panel.
-- window.opener/postMessage is not reliable across origins (a site's own
-- Cross-Origin-Opener-Policy can silently sever it), so the loader instead
-- reports the click to the gateway itself; the panel picks it up when the
-- browser tab regains focus. Single-row-per-site, short-lived, overwritten
-- on every new selection -- not an audit log.
CREATE TABLE IF NOT EXISTS platform_pending_selections (
  site_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE
);
