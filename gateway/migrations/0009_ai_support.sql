PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS platform_conversations (
  conversation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, user_id),
  FOREIGN KEY (account_id) REFERENCES platform_accounts(account_id) ON DELETE CASCADE,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES platform_users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_conversations_account_updated
  ON platform_conversations(account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_conversation_messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('client', 'ai', 'support', 'system')),
  author_user_id TEXT,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES platform_conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (author_user_id) REFERENCES platform_users(user_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_platform_conversation_messages_created
  ON platform_conversation_messages(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_support_requests (
  request_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  assigned_to TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'active', 'waiting_client', 'resolved', 'canceled')),
  summary TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES platform_conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES platform_accounts(account_id) ON DELETE CASCADE,
  FOREIGN KEY (site_id) REFERENCES platform_sites(site_id) ON DELETE CASCADE,
  FOREIGN KEY (requested_by) REFERENCES platform_users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_to) REFERENCES platform_users(user_id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_support_one_open_request
  ON platform_support_requests(conversation_id)
  WHERE status IN ('new', 'active', 'waiting_client');

CREATE INDEX IF NOT EXISTS idx_platform_support_queue
  ON platform_support_requests(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_support_account
  ON platform_support_requests(account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_support_destinations (
  user_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  chat_type TEXT NOT NULL CHECK (chat_type IN ('private', 'group', 'supergroup')),
  telegram_user_id TEXT,
  linked_at TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  FOREIGN KEY (user_id) REFERENCES platform_users(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS platform_support_connect_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES platform_users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_support_connect_user_expires
  ON platform_support_connect_sessions(user_id, expires_at DESC);
