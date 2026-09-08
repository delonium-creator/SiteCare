-- Site accompaniment: independent requests with explicit offers and outcomes.
CREATE TABLE platform_care_requests (
  request_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES platform_sites(site_id),
  account_id TEXT NOT NULL REFERENCES platform_accounts(account_id),
  created_by TEXT NOT NULL REFERENCES platform_users(user_id),
  title TEXT NOT NULL,
  finding_id TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','quoted','approved','in_progress','waiting_client','completed','canceled')),
  revision INTEGER NOT NULL DEFAULT 1,
  quote_minor INTEGER CHECK(quote_minor IS NULL OR quote_minor >= 0),
  quote_scope TEXT,
  quote_due TEXT,
  accepted_at TEXT,
  payment_reference TEXT,
  paid_at TEXT,
  resolution TEXT,
  verification TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_care_site_updated ON platform_care_requests(site_id, updated_at DESC);
CREATE UNIQUE INDEX idx_care_open_finding ON platform_care_requests(site_id,finding_id) WHERE finding_id IS NOT NULL AND status NOT IN ('completed','canceled');
CREATE TABLE platform_care_messages (
  message_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES platform_care_requests(request_id),
  author_type TEXT NOT NULL CHECK(author_type IN ('client','support','system','ai')),
  author_user_id TEXT,
  content TEXT NOT NULL DEFAULT '',
  content_ciphertext TEXT,
  content_iv TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_care_messages ON platform_care_messages(request_id,created_at);
-- Keep existing support history available in the new workspace.
INSERT INTO platform_care_requests(request_id,site_id,account_id,created_by,title,status,created_at,updated_at)
SELECT request_id,site_id,account_id,requested_by,summary,
  CASE status WHEN 'active' THEN 'in_progress' WHEN 'resolved' THEN 'completed' ELSE status END,
  created_at,updated_at FROM platform_support_requests;
INSERT INTO platform_care_messages(message_id,request_id,author_type,author_user_id,content,content_ciphertext,content_iv,created_at)
SELECT r.request_id || '_' || m.message_id,r.request_id,m.author_type,m.author_user_id,m.content,m.content_ciphertext,m.content_iv,m.created_at
FROM platform_support_requests r JOIN platform_conversation_messages m ON m.conversation_id=r.conversation_id
WHERE (m.created_at >= r.created_at AND (r.resolved_at IS NULL OR m.created_at<=r.resolved_at)
  AND NOT EXISTS (SELECT 1 FROM platform_support_requests newer WHERE newer.conversation_id=r.conversation_id AND newer.created_at>r.created_at AND newer.created_at<=m.created_at)) OR m.message_id=(SELECT message_id FROM platform_conversation_messages WHERE conversation_id=r.conversation_id AND created_at<=r.created_at AND author_type='client' ORDER BY created_at DESC LIMIT 1);
