PRAGMA foreign_keys = ON;

-- Tilda's own form "receivers" (a built-in email notification, and a
-- separate native Telegram integration via @TildaFormsBot) run entirely
-- independently of SiteCare's webhook - both can be checked on the same
-- form at once. Without per-channel control here, a client who already
-- has Tilda's own notifications on gets a duplicate ping for every lead.
-- These columns let a client turn SiteCare's own lead notifications on/off
-- per channel without touching the main Telegram connection toggle, which
-- also carries downtime/incident alerts and must stay independent of it.
ALTER TABLE telegram_destinations ADD COLUMN notify_leads INTEGER NOT NULL DEFAULT 1 CHECK (notify_leads IN (0, 1));
ALTER TABLE platform_sites ADD COLUMN lead_email_notify_enabled INTEGER NOT NULL DEFAULT 0 CHECK (lead_email_notify_enabled IN (0, 1));
ALTER TABLE platform_sites ADD COLUMN lead_notify_email TEXT;
