PRAGMA foreign_keys = ON;

-- Products are deliberately data, not constants in the interface. The
-- operator can change prices and checkout links without rebuilding SiteCare.
CREATE TABLE IF NOT EXISTS platform_products (
  product_key TEXT PRIMARY KEY CHECK (product_key IN ('control', 'reviews', 'bundle')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_minor INTEGER NOT NULL DEFAULT 0 CHECK (price_minor BETWEEN 0 AND 100000000),
  currency TEXT NOT NULL DEFAULT 'RUB',
  billing_period TEXT NOT NULL DEFAULT 'month' CHECK (billing_period IN ('month', 'year', 'one_time')),
  checkout_url TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO platform_products (
  product_key, name, description, price_minor, currency, billing_period, checkout_url, active, sort_order, updated_at
) VALUES
  ('control', 'Контроль сайта', 'Проверки сайта, заявки, Telegram и безопасные изменения.', 149000, 'RUB', 'month', '', 1, 10, datetime('now')),
  ('reviews', 'Отзывы', 'Отзывы из подключённых источников и виджет на сайте.', 99000, 'RUB', 'month', '', 1, 20, datetime('now')),
  ('bundle', 'SiteCare полностью', 'Контроль сайта и отзывы в одной подписке.', 199000, 'RUB', 'month', '', 1, 30, datetime('now'));

CREATE TABLE IF NOT EXISTS platform_account_features (
  account_id TEXT NOT NULL,
  feature_key TEXT NOT NULL CHECK (feature_key IN ('control', 'reviews')),
  status TEXT NOT NULL DEFAULT 'canceled' CHECK (status IN ('trial_pending', 'trial', 'active', 'past_due', 'complimentary', 'paused', 'canceled')),
  source_product_key TEXT NOT NULL DEFAULT 'manual' CHECK (source_product_key IN ('manual', 'control', 'reviews', 'bundle')),
  trial_started_at TEXT,
  current_period_end TEXT,
  provider TEXT NOT NULL DEFAULT 'manual',
  provider_subscription_id TEXT NOT NULL DEFAULT '',
  checkout_url TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, feature_key),
  FOREIGN KEY (account_id) REFERENCES platform_accounts(account_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_account_features_status
  ON platform_account_features(feature_key, status, current_period_end);

-- Every existing subscription represented the original site-control product.
INSERT OR IGNORE INTO platform_account_features (
  account_id, feature_key, status, source_product_key, trial_started_at,
  current_period_end, provider, provider_subscription_id, checkout_url, updated_at
)
SELECT
  account_id, 'control', status, 'control', trial_started_at,
  current_period_end, provider, '', checkout_url, updated_at
FROM platform_billing;

-- The operator workspace receives both modules so it can be demonstrated and
-- previewed without creating a paid subscription for the service itself.
INSERT OR IGNORE INTO platform_account_features (
  account_id, feature_key, status, source_product_key, trial_started_at,
  current_period_end, provider, provider_subscription_id, checkout_url, updated_at
)
SELECT DISTINCT
  m.account_id, 'reviews', 'complimentary', 'manual', NULL,
  NULL, 'manual', '', '', datetime('now')
FROM platform_memberships m
JOIN platform_users u ON u.user_id = m.user_id
WHERE u.platform_role = 'operator';

ALTER TABLE platform_runtime_reports ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0 CHECK (phone_verified IN (0, 1));
ALTER TABLE platform_runtime_reports ADD COLUMN schedule_verified INTEGER NOT NULL DEFAULT 0 CHECK (schedule_verified IN (0, 1));
ALTER TABLE platform_runtime_reports ADD COLUMN button_verified INTEGER NOT NULL DEFAULT 0 CHECK (button_verified IN (0, 1));

