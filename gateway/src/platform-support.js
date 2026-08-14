import { newId, safeText } from "./platform-core.js";
import { decryptProtectedJson, encryptProtectedJson } from "./platform-leads.js";

const OPEN_SUPPORT_STATUSES = new Set(["new", "active", "waiting_client"]);
const SUPPORT_STATUSES = new Set([...OPEN_SUPPORT_STATUSES, "resolved", "canceled"]);
const AUTHOR_TYPES = new Set(["client", "ai", "support", "system"]);
const MAX_MESSAGES = 300;

function supportError(message, status = 400, code = "SUPPORT_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizedContent(value, maximum = 1600) {
  const content = safeText(value, maximum);
  if (!content) throw supportError("Напишите сообщение.");
  return content;
}

function safeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "{}";
  const rawDialog = value.dialog && typeof value.dialog === "object" && !Array.isArray(value.dialog) ? value.dialog : null;
  const dialog = rawDialog ? {
    intent: safeText(rawDialog.intent, 20),
    stage: safeText(rawDialog.stage, 20),
    targetHint: safeText(rawDialog.targetHint, 180),
    targetPhone: safeText(rawDialog.targetPhone, 80),
    candidateId: safeText(rawDialog.candidateId, 120),
    scope: new Set(["element", "page", "site"]).has(String(rawDialog.scope)) ? String(rawDialog.scope) : "element",
    kind: safeText(rawDialog.kind, 30),
    pendingValue: safeText(rawDialog.pendingValue, 500),
    attempts: Math.max(0, Math.min(3, Number(rawDialog.attempts) || 0))
  } : null;
  const allowed = {
    type: safeText(value.type, 30),
    kind: safeText(value.kind, 30),
    value: safeText(value.value, 500),
    targetHint: safeText(value.targetHint, 180),
    targetPhone: safeText(value.targetPhone, 80),
    needsTarget: Boolean(value.needsTarget),
    suggestedCandidateId: safeText(value.suggestedCandidateId, 120),
    scope: new Set(["element", "page", "site"]).has(String(value.scope)) ? String(value.scope) : "element",
    supportSuggested: Boolean(value.supportSuggested),
    supportReason: safeText(value.supportReason, 300),
    supportSummary: safeText(value.supportSummary, 700),
    suggestions: (Array.isArray(value.suggestions) ? value.suggestions : [])
      .map((item) => safeText(item, 140))
      .filter(Boolean)
      .slice(0, 3),
    dialog
  };
  return JSON.stringify(allowed).slice(0, 3000);
}

function parsedMetadata(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function publicMessage(env, row) {
  const protectedContent = row.content_ciphertext && row.content_iv
    ? await decryptProtectedJson(env, row.content_ciphertext, row.content_iv)
    : null;
  return {
    messageId: row.message_id,
    role: row.author_type,
    authorName: row.author_name || (row.author_type === "ai" ? "Помощник SiteCare" : row.author_type === "support" ? "Поддержка SiteCare" : ""),
    content: protectedContent?.content || row.content,
    metadata: parsedMetadata(row.metadata_json),
    createdAt: row.created_at
  };
}

function publicRequest(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    conversationId: row.conversation_id,
    accountId: row.account_id,
    accountName: row.account_name || "",
    siteId: row.site_id,
    siteName: row.site_name || "",
    requestedBy: row.requested_by,
    requesterName: row.requester_name || "",
    requesterEmail: row.requester_email || "",
    assignedTo: row.assigned_to || null,
    assignedName: row.assigned_name || "",
    status: row.status,
    summary: row.summary || "",
    reason: row.reason || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at || null,
    lastMessage: row.last_message || "",
    lastMessageAt: row.last_message_at || null
  };
}

async function publicRequestWithLastMessage(env, row) {
  if (!row) return null;
  const protectedContent = row.last_message_ciphertext && row.last_message_iv
    ? await decryptProtectedJson(env, row.last_message_ciphertext, row.last_message_iv)
    : null;
  return publicRequest({
    ...row,
    last_message: protectedContent?.content || row.last_message || ""
  });
}

export async function ensureConversation(env, { accountId, siteId, userId }) {
  let row = await env.GATEWAY_DB.prepare(
    "SELECT conversation_id, account_id, site_id, user_id, created_at, updated_at FROM platform_conversations WHERE site_id = ? AND user_id = ?"
  ).bind(siteId, userId).first();
  if (row) return row;
  const now = new Date().toISOString();
  const conversationId = newId("conv", siteId);
  await env.GATEWAY_DB.prepare(
    "INSERT OR IGNORE INTO platform_conversations (conversation_id, account_id, site_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(conversationId, accountId, siteId, userId, now, now).run();
  row = await env.GATEWAY_DB.prepare(
    "SELECT conversation_id, account_id, site_id, user_id, created_at, updated_at FROM platform_conversations WHERE site_id = ? AND user_id = ?"
  ).bind(siteId, userId).first();
  if (!row) throw supportError("Не удалось открыть диалог.", 500, "CONVERSATION_CREATE_FAILED");
  return row;
}

export async function appendConversationMessage(env, conversationId, { authorType, authorUserId = null, content, metadata = null }) {
  if (!AUTHOR_TYPES.has(authorType)) throw supportError("Некорректный автор сообщения.");
  const cleanContent = normalizedContent(content);
  const now = new Date().toISOString();
  const messageId = newId("msg", authorType);
  const protectedContent = authorType === "system" ? null : await encryptProtectedJson(env, { content: cleanContent });
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_conversation_messages (message_id, conversation_id, author_type, author_user_id, content, metadata_json, created_at, content_ciphertext, content_iv) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(messageId, conversationId, authorType, authorUserId, protectedContent ? "Защищённое сообщение" : cleanContent, safeMetadata(metadata), now, protectedContent?.ciphertext || null, protectedContent?.iv || null),
    env.GATEWAY_DB.prepare("UPDATE platform_conversations SET updated_at = ? WHERE conversation_id = ?").bind(now, conversationId),
    env.GATEWAY_DB.prepare(
      "DELETE FROM platform_conversation_messages WHERE conversation_id = ? AND message_id NOT IN (SELECT message_id FROM platform_conversation_messages WHERE conversation_id = ? ORDER BY created_at DESC, message_id DESC LIMIT ?)"
    ).bind(conversationId, conversationId, MAX_MESSAGES)
  ]);
  return { messageId, content: cleanContent, createdAt: now };
}

export async function openSupportRequest(env, conversationId) {
  return env.GATEWAY_DB.prepare(
    "SELECT r.*, a.name AS account_name, s.name AS site_name, requester.display_name AS requester_name, requester.email AS requester_email, assigned.display_name AS assigned_name " +
    "FROM platform_support_requests r JOIN platform_accounts a ON a.account_id = r.account_id JOIN platform_sites s ON s.site_id = r.site_id " +
    "JOIN platform_users requester ON requester.user_id = r.requested_by LEFT JOIN platform_users assigned ON assigned.user_id = r.assigned_to " +
    "WHERE r.conversation_id = ? AND r.status IN ('new','active','waiting_client') ORDER BY r.created_at DESC LIMIT 1"
  ).bind(conversationId).first();
}

export async function conversationSnapshot(env, conversationId, limit = 100) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 150));
  const [conversation, messagesResult, supportRequest] = await Promise.all([
    env.GATEWAY_DB.prepare(
      "SELECT conversation_id, account_id, site_id, user_id, created_at, updated_at FROM platform_conversations WHERE conversation_id = ?"
    ).bind(conversationId).first(),
    env.GATEWAY_DB.prepare(
      "SELECT m.message_id, m.author_type, m.author_user_id, m.content, m.content_ciphertext, m.content_iv, m.metadata_json, m.created_at, u.display_name AS author_name " +
      "FROM platform_conversation_messages m LEFT JOIN platform_users u ON u.user_id = m.author_user_id WHERE m.conversation_id = ? " +
      "ORDER BY m.created_at DESC, m.message_id DESC LIMIT ?"
    ).bind(conversationId, boundedLimit).all(),
    openSupportRequest(env, conversationId)
  ]);
  if (!conversation) throw supportError("Диалог не найден.", 404, "CONVERSATION_NOT_FOUND");
  return {
    conversationId: conversation.conversation_id,
    siteId: conversation.site_id,
    updatedAt: conversation.updated_at,
    messages: await Promise.all((messagesResult?.results || []).reverse().map((row) => publicMessage(env, row))),
    supportRequest: publicRequest(supportRequest)
  };
}

export function modelHistory(messages, limit = 16) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role !== "system" && message?.content)
    .slice(-Math.max(1, Math.min(Number(limit) || 16, 24)))
    .map((message) => ({
      role: message.role === "client" ? "user" : "assistant",
      content: safeText(message.content, 900),
      metadata: message.metadata && typeof message.metadata === "object" ? message.metadata : {}
    }));
}

export async function requestSupport(env, conversation, user, reason = "") {
  const existing = await openSupportRequest(env, conversation.conversation_id);
  if (existing) return { created: false, request: publicRequest(existing) };
  const recent = (await conversationSnapshot(env, conversation.conversation_id, 12)).messages
    .filter((message) => message.role === "client")
    .at(-1);
  const summary = safeText(recent?.content || "Нужна помощь с сайтом", 180);
  const cleanReason = safeText(reason || "Клиент попросил подключить поддержку.", 300);
  const requestId = newId("sup", conversation.site_id);
  const now = new Date().toISOString();
  try {
    await env.GATEWAY_DB.batch([
      env.GATEWAY_DB.prepare(
        "INSERT INTO platform_support_requests (request_id, conversation_id, account_id, site_id, requested_by, assigned_to, status, summary, reason, created_at, updated_at, resolved_at) VALUES (?, ?, ?, ?, ?, NULL, 'new', ?, ?, ?, ?, NULL)"
      ).bind(requestId, conversation.conversation_id, conversation.account_id, conversation.site_id, user.user_id, summary, cleanReason, now, now),
      env.GATEWAY_DB.prepare(
        "INSERT INTO platform_conversation_messages (message_id, conversation_id, author_type, author_user_id, content, metadata_json, created_at) VALUES (?, ?, 'system', NULL, ?, '{}', ?)"
      ).bind(newId("msg", "support-requested"), conversation.conversation_id, "Запрос передан в поддержку. Ответ появится в этом чате.", now),
      env.GATEWAY_DB.prepare("UPDATE platform_conversations SET updated_at = ? WHERE conversation_id = ?").bind(now, conversation.conversation_id)
    ]);
  } catch (error) {
    const raced = await openSupportRequest(env, conversation.conversation_id);
    if (raced) return { created: false, request: publicRequest(raced) };
    throw error;
  }
  const created = await env.GATEWAY_DB.prepare(
    "SELECT r.*, a.name AS account_name, s.name AS site_name, requester.display_name AS requester_name, requester.email AS requester_email, assigned.display_name AS assigned_name " +
    "FROM platform_support_requests r JOIN platform_accounts a ON a.account_id = r.account_id JOIN platform_sites s ON s.site_id = r.site_id " +
    "JOIN platform_users requester ON requester.user_id = r.requested_by LEFT JOIN platform_users assigned ON assigned.user_id = r.assigned_to WHERE r.request_id = ?"
  ).bind(requestId).first();
  return { created: true, request: publicRequest(created) };
}

export async function forwardClientMessageToSupport(env, requestRow) {
  if (!requestRow || !OPEN_SUPPORT_STATUSES.has(requestRow.status)) return;
  const now = new Date().toISOString();
  const nextStatus = requestRow.assigned_to ? "active" : "new";
  await env.GATEWAY_DB.prepare(
    "UPDATE platform_support_requests SET status = ?, updated_at = ? WHERE request_id = ? AND status IN ('new','active','waiting_client')"
  ).bind(nextStatus, now, requestRow.request_id).run();
}

export async function cancelSupportRequest(env, conversationId, userId) {
  const request = await openSupportRequest(env, conversationId);
  if (!request) throw supportError("Активного обращения уже нет.", 409, "SUPPORT_NOT_OPEN");
  if (request.requested_by !== userId) throw supportError("Отменить обращение может только его автор.", 403, "FORBIDDEN");
  const now = new Date().toISOString();
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare(
      "UPDATE platform_support_requests SET status = 'canceled', updated_at = ?, resolved_at = ? WHERE request_id = ?"
    ).bind(now, now, request.request_id),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_conversation_messages (message_id, conversation_id, author_type, author_user_id, content, metadata_json, created_at) VALUES (?, ?, 'system', NULL, ?, '{}', ?)"
    ).bind(newId("msg", "support-canceled"), conversationId, "Обращение в поддержку отменено. Помощник снова отвечает в этом чате.", now),
    env.GATEWAY_DB.prepare("UPDATE platform_conversations SET updated_at = ? WHERE conversation_id = ?").bind(now, conversationId)
  ]);
  return request.request_id;
}

const SUPPORT_SELECT =
  "SELECT r.*, a.name AS account_name, s.name AS site_name, requester.display_name AS requester_name, requester.email AS requester_email, assigned.display_name AS assigned_name, " +
  "(SELECT content FROM platform_conversation_messages m WHERE m.conversation_id = r.conversation_id ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1) AS last_message, " +
  "(SELECT content_ciphertext FROM platform_conversation_messages m WHERE m.conversation_id = r.conversation_id ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1) AS last_message_ciphertext, " +
  "(SELECT content_iv FROM platform_conversation_messages m WHERE m.conversation_id = r.conversation_id ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1) AS last_message_iv, " +
  "(SELECT created_at FROM platform_conversation_messages m WHERE m.conversation_id = r.conversation_id ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1) AS last_message_at " +
  "FROM platform_support_requests r JOIN platform_accounts a ON a.account_id = r.account_id JOIN platform_sites s ON s.site_id = r.site_id " +
  "JOIN platform_users requester ON requester.user_id = r.requested_by LEFT JOIN platform_users assigned ON assigned.user_id = r.assigned_to ";

export async function supportQueue(env, { includeResolved = false } = {}) {
  const where = includeResolved ? "" : "WHERE r.status IN ('new','active','waiting_client') ";
  const result = await env.GATEWAY_DB.prepare(
    SUPPORT_SELECT + where + "ORDER BY CASE r.status WHEN 'new' THEN 0 WHEN 'active' THEN 1 WHEN 'waiting_client' THEN 2 ELSE 3 END, r.updated_at DESC LIMIT 200"
  ).all();
  const requests = await Promise.all((result?.results || []).map((row) => publicRequestWithLastMessage(env, row)));
  return {
    requests,
    counts: {
      open: requests.filter((item) => OPEN_SUPPORT_STATUSES.has(item.status)).length,
      new: requests.filter((item) => item.status === "new").length,
      active: requests.filter((item) => item.status === "active").length,
      waitingClient: requests.filter((item) => item.status === "waiting_client").length
    }
  };
}

export async function supportRequestDetails(env, requestId) {
  const request = await env.GATEWAY_DB.prepare(SUPPORT_SELECT + "WHERE r.request_id = ? LIMIT 1").bind(requestId).first();
  if (!request) throw supportError("Обращение не найдено.", 404, "SUPPORT_NOT_FOUND");
  return {
    request: await publicRequestWithLastMessage(env, request),
    conversation: await conversationSnapshot(env, request.conversation_id, 150)
  };
}

export async function updateSupportRequest(env, requestId, supportUser, { action, content = "" }) {
  const current = await env.GATEWAY_DB.prepare("SELECT * FROM platform_support_requests WHERE request_id = ?").bind(requestId).first();
  if (!current) throw supportError("Обращение не найдено.", 404, "SUPPORT_NOT_FOUND");
  const now = new Date().toISOString();
  if (action === "take") {
    if (!OPEN_SUPPORT_STATUSES.has(current.status)) throw supportError("Это обращение уже закрыто.", 409, "SUPPORT_CLOSED");
    if (current.assigned_to === supportUser.user_id && current.status !== "new") {
      return supportRequestDetails(env, requestId);
    }
    if (current.assigned_to && current.assigned_to !== supportUser.user_id) {
      throw supportError("Обращение уже взял другой специалист поддержки.", 409, "SUPPORT_ASSIGNED");
    }
    await env.GATEWAY_DB.batch([
      env.GATEWAY_DB.prepare("UPDATE platform_support_requests SET status = 'active', assigned_to = ?, updated_at = ? WHERE request_id = ?")
        .bind(supportUser.user_id, now, requestId),
      env.GATEWAY_DB.prepare(
        "INSERT INTO platform_conversation_messages (message_id, conversation_id, author_type, author_user_id, content, metadata_json, created_at) VALUES (?, ?, 'system', NULL, ?, '{}', ?)"
      ).bind(newId("msg", "support-active"), current.conversation_id, "Поддержка подключилась к диалогу.", now),
      env.GATEWAY_DB.prepare("UPDATE platform_conversations SET updated_at = ? WHERE conversation_id = ?").bind(now, current.conversation_id)
    ]);
  } else if (action === "reply") {
    if (!OPEN_SUPPORT_STATUSES.has(current.status)) throw supportError("Сначала откройте новое обращение.", 409, "SUPPORT_CLOSED");
    const cleanContent = normalizedContent(content);
    const protectedContent = await encryptProtectedJson(env, { content: cleanContent });
    await env.GATEWAY_DB.batch([
      env.GATEWAY_DB.prepare(
        "UPDATE platform_support_requests SET status = 'waiting_client', assigned_to = ?, updated_at = ? WHERE request_id = ?"
      ).bind(supportUser.user_id, now, requestId),
      env.GATEWAY_DB.prepare(
        "INSERT INTO platform_conversation_messages (message_id, conversation_id, author_type, author_user_id, content, metadata_json, created_at, content_ciphertext, content_iv) VALUES (?, ?, 'support', ?, 'Защищённое сообщение', '{}', ?, ?, ?)"
      ).bind(newId("msg", "support"), current.conversation_id, supportUser.user_id, now, protectedContent.ciphertext, protectedContent.iv),
      env.GATEWAY_DB.prepare("UPDATE platform_conversations SET updated_at = ? WHERE conversation_id = ?").bind(now, current.conversation_id)
    ]);
  } else if (action === "resolve") {
    if (!SUPPORT_STATUSES.has(current.status) || current.status === "resolved" || current.status === "canceled") {
      throw supportError("Это обращение уже закрыто.", 409, "SUPPORT_CLOSED");
    }
    await env.GATEWAY_DB.batch([
      env.GATEWAY_DB.prepare(
        "UPDATE platform_support_requests SET status = 'resolved', assigned_to = COALESCE(assigned_to, ?), updated_at = ?, resolved_at = ? WHERE request_id = ?"
      ).bind(supportUser.user_id, now, now, requestId),
      env.GATEWAY_DB.prepare(
        "INSERT INTO platform_conversation_messages (message_id, conversation_id, author_type, author_user_id, content, metadata_json, created_at) VALUES (?, ?, 'system', NULL, ?, '{}', ?)"
      ).bind(newId("msg", "support-resolved"), current.conversation_id, "Обращение решено. Помощник снова отвечает в этом чате.", now),
      env.GATEWAY_DB.prepare("UPDATE platform_conversations SET updated_at = ? WHERE conversation_id = ?").bind(now, current.conversation_id)
    ]);
  } else {
    throw supportError("Неизвестное действие поддержки.");
  }
  return supportRequestDetails(env, requestId);
}

export const supportInternals = Object.freeze({ OPEN_SUPPORT_STATUSES, normalizedContent, parsedMetadata, publicMessage, publicRequest, safeMetadata });
