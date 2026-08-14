import {
  telegramGetMe,
  telegramSendMessage,
  telegramSetWebhook,
  validateTelegramBotToken
} from "../../src/notifications.js";
import { PLATFORM_VERSION } from "./platform-core.js";
import { handlePlatformRoute, scheduledPlatformChecks } from "./platform.js";

const encoder = new TextEncoder();
const MAX_JSON_BODY_BYTES = 16 * 1024;
const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;
const SITE_START_PARAMETER_PATTERN = /^sc_[A-Za-z0-9_-]{32}$/u;
const SUPPORT_START_PARAMETER_PATTERN = /^sup_[A-Za-z0-9_-]{32}$/u;
const EVENT_ID_PATTERN = /^[A-Za-z0-9:_-]{8,160}$/u;
const EVENT_TYPES = new Set(["connection", "test", "page-down", "page-recovered", "form-down", "form-recovered"]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    }
  });
}

function safeText(value, maximum = 220) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F<>]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function errorResponse(error, status = 400, code = "BAD_REQUEST") {
  return json({ ok: false, error: safeText(error instanceof Error ? error.message : error) || "Некорректный запрос.", code }, status);
}

async function requestJson(request) {
  if (!(request.headers.get("Content-Type") || "").toLowerCase().includes("application/json")) {
    const error = new Error("Ожидался JSON-запрос.");
    error.status = 415;
    throw error;
  }
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
    const error = new Error("Запрос слишком большой.");
    error.status = 413;
    throw error;
  }
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > MAX_JSON_BODY_BYTES) {
    const error = new Error("Запрос слишком большой.");
    error.status = 413;
    throw error;
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("Некорректный JSON-запрос.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Некорректный запрос.");
  return body;
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function randomToken(byteLength = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function digest(context, value) {
  const result = await crypto.subtle.digest("SHA-256", encoder.encode(`sitecare:${context}:v1:${value}`));
  return base64url(new Uint8Array(result));
}

function constantTimeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  let difference = a.length ^ b.length;
  const maximum = Math.max(a.length, b.length);
  for (let index = 0; index < maximum; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function bearerToken(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/u.exec(request.headers.get("Authorization") || "");
  return match?.[1] || "";
}

function validateSiteId(value) {
  const siteId = String(value || "").trim();
  if (!SITE_ID_PATTERN.test(siteId)) throw new Error("Некорректный код сайта.");
  return siteId;
}

function validateTargetUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
    throw new Error("Укажите безопасный HTTPS-адрес сайта.");
  }
  return url.href;
}

function requireSecrets(env) {
  validateTelegramBotToken(env.TELEGRAM_BOT_TOKEN);
  if (!OPAQUE_TOKEN_PATTERN.test(String(env.TELEGRAM_WEBHOOK_SECRET || ""))) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET is not configured.");
  }
  if (!OPAQUE_TOKEN_PATTERN.test(String(env.GATEWAY_ADMIN_TOKEN || ""))) {
    throw new Error("GATEWAY_ADMIN_TOKEN is not configured.");
  }
  if (!OPAQUE_TOKEN_PATTERN.test(String(env.LEADS_DATA_KEY || ""))) {
    throw new Error("LEADS_DATA_KEY is not configured.");
  }
}

async function requireAdmin(request, env) {
  const provided = bearerToken(request);
  if (!provided || !constantTimeEqual(provided, env.GATEWAY_ADMIN_TOKEN)) {
    const error = new Error("Доступ запрещён.");
    error.status = 401;
    error.code = "UNAUTHORIZED";
    throw error;
  }
}

async function requireSite(request, env, rawSiteId) {
  const siteId = validateSiteId(rawSiteId);
  const provided = bearerToken(request);
  if (!OPAQUE_TOKEN_PATTERN.test(provided)) {
    const error = new Error("Доступ сайта запрещён.");
    error.status = 401;
    error.code = "UNAUTHORIZED";
    throw error;
  }
  const row = await env.GATEWAY_DB.prepare(
    "SELECT site_id, site_name, target_url, site_token_hash, enabled FROM gateway_sites WHERE site_id = ?"
  ).bind(siteId).first();
  const providedHash = await digest("site-token", provided);
  if (!row || !row.enabled || !constantTimeEqual(providedHash, row.site_token_hash)) {
    const error = new Error("Доступ сайта запрещён.");
    error.status = 401;
    error.code = "UNAUTHORIZED";
    throw error;
  }
  return row;
}

async function setting(env, key) {
  return (await env.GATEWAY_DB.prepare("SELECT value FROM gateway_settings WHERE key = ?").bind(key).first())?.value || "";
}

async function handleBootstrap(request, env, requestUrl) {
  await requireAdmin(request, env);
  const body = await requestJson(request);
  const siteId = validateSiteId(body.siteId);
  const siteName = safeText(body.siteName, 120);
  if (!siteName) throw new Error("Укажите название сайта.");
  const targetUrl = validateTargetUrl(body.targetUrl);
  const bot = await telegramGetMe(env.TELEGRAM_BOT_TOKEN);
  if (!bot?.id || bot?.is_bot !== true || !/^[A-Za-z0-9_]{5,64}$/u.test(String(bot.username || ""))) {
    throw new Error("Telegram не подтвердил официальный SiteCareBot.");
  }
  await telegramSetWebhook(
    env.TELEGRAM_BOT_TOKEN,
    `${requestUrl.origin}/v1/telegram/webhook`,
    env.TELEGRAM_WEBHOOK_SECRET
  );
  const siteToken = randomToken(32);
  const siteTokenHash = await digest("site-token", siteToken);
  const now = new Date().toISOString();
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare(
      "INSERT INTO gateway_settings (key, value, updated_at) VALUES ('bot_username', ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).bind(String(bot.username), now),
    env.GATEWAY_DB.prepare(
      "INSERT INTO gateway_sites (site_id, site_name, target_url, site_token_hash, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?) " +
      "ON CONFLICT(site_id) DO UPDATE SET site_name = excluded.site_name, target_url = excluded.target_url, site_token_hash = excluded.site_token_hash, enabled = 1, updated_at = excluded.updated_at"
    ).bind(siteId, siteName, targetUrl, siteTokenHash, now, now)
  ]);
  return json({ ok: true, siteId, siteToken, botUsername: String(bot.username) });
}

async function handleCreateConnection(request, env, site) {
  const botUsername = await setting(env, "bot_username");
  if (!botUsername) {
    const error = new Error("Официальный SiteCareBot ещё не настроен.");
    error.status = 503;
    error.code = "BOT_NOT_CONFIGURED";
    throw error;
  }
  const startParameter = `sc_${randomToken(24)}`;
  const tokenHash = await digest("connect-token", startParameter);
  const now = new Date();
  const ttl = Math.min(Math.max(Number(env.CONNECT_TTL_MINUTES) || 15, 5), 60);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttl * 60 * 1000).toISOString();
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare(
      "DELETE FROM telegram_connect_sessions WHERE site_id = ? AND used_at IS NULL"
    ).bind(site.site_id),
    env.GATEWAY_DB.prepare(
      "INSERT INTO telegram_connect_sessions (token_hash, site_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)"
    ).bind(tokenHash, site.site_id, createdAt, expiresAt),
    env.GATEWAY_DB.prepare(
      "DELETE FROM telegram_connect_sessions WHERE expires_at < ? OR used_at IS NOT NULL AND used_at < ?"
    ).bind(createdAt, new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString())
  ]);
  return json({
    ok: true,
    connectUrl: `https://t.me/${botUsername}?start=${startParameter}`,
    botUsername,
    expiresAt,
    expiresInMinutes: ttl
  });
}

async function destinationState(env, site) {
  const row = await env.GATEWAY_DB.prepare(
    "SELECT chat_type, linked_at, enabled FROM telegram_destinations WHERE site_id = ?"
  ).bind(site.site_id).first();
  const botUsername = await setting(env, "bot_username");
  return {
    ok: true,
    configured: Boolean(row?.enabled),
    enabled: Boolean(row?.enabled),
    destination: row?.enabled ? row.chat_type === "private" ? "личный чат" : "группа" : null,
    linkedAt: row?.linked_at || null,
    botUsername: botUsername || null
  };
}

async function handleSendNotification(request, env, site) {
  const body = await requestJson(request);
  const eventId = String(body.eventId || "").trim();
  const eventType = String(body.eventType || "");
  const text = String(body.text || "").trim();
  if (!EVENT_ID_PATTERN.test(eventId)) throw new Error("Некорректный код уведомления.");
  if (!EVENT_TYPES.has(eventType)) throw new Error("Некорректный тип уведомления.");
  if (!text || text.length > 3500) throw new Error("Некорректный текст уведомления.");
  const destination = await env.GATEWAY_DB.prepare(
    "SELECT chat_id, enabled FROM telegram_destinations WHERE site_id = ?"
  ).bind(site.site_id).first();
  if (!destination?.enabled) {
    const error = new Error("Telegram для этого сайта ещё не подключён.");
    error.status = 409;
    error.code = "NOT_LINKED";
    throw error;
  }
  const existing = await env.GATEWAY_DB.prepare(
    "SELECT status FROM gateway_deliveries WHERE site_id = ? AND event_id = ?"
  ).bind(site.site_id, eventId).first();
  if (existing?.status === "sent") return json({ ok: true, sent: true, duplicate: true });
  if (existing?.status === "pending") return json({ ok: true, sent: false, pending: true }, 202);
  const now = new Date().toISOString();
  if (existing) {
    const claimed = await env.GATEWAY_DB.prepare(
      "UPDATE gateway_deliveries SET status = 'pending', updated_at = ?, details = 'Повторная отправка.' WHERE site_id = ? AND event_id = ? AND status = 'failed'"
    ).bind(now, site.site_id, eventId).run();
    if (Number(claimed?.meta?.changes || 0) === 0) return json({ ok: true, sent: false, pending: true }, 202);
  } else {
    const inserted = await env.GATEWAY_DB.prepare(
      "INSERT OR IGNORE INTO gateway_deliveries (site_id, event_id, event_type, status, created_at, updated_at, details) VALUES (?, ?, ?, 'pending', ?, ?, 'Отправка начата.')"
    ).bind(site.site_id, eventId, eventType, now, now).run();
    if (Number(inserted?.meta?.changes || 0) === 0) return json({ ok: true, sent: false, pending: true }, 202);
  }
  try {
    await telegramSendMessage(env.TELEGRAM_BOT_TOKEN, destination.chat_id, text);
    const sentAt = new Date().toISOString();
    await env.GATEWAY_DB.prepare(
      "UPDATE gateway_deliveries SET status = 'sent', updated_at = ?, details = 'Уведомление отправлено в Telegram.' WHERE site_id = ? AND event_id = ?"
    ).bind(sentAt, site.site_id, eventId).run();
    return json({ ok: true, sent: true, duplicate: false });
  } catch (error) {
    const failedAt = new Date().toISOString();
    const details = safeText(error instanceof Error ? error.message : "Telegram недоступен.");
    await env.GATEWAY_DB.prepare(
      "UPDATE gateway_deliveries SET status = 'failed', updated_at = ?, details = ? WHERE site_id = ? AND event_id = ?"
    ).bind(failedAt, details, site.site_id, eventId).run();
    const failure = new Error(details || "Telegram не принял уведомление.");
    failure.status = 502;
    failure.code = "TELEGRAM_DELIVERY_FAILED";
    throw failure;
  }
}

async function handleDisconnect(env, site) {
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare("DELETE FROM telegram_destinations WHERE site_id = ?").bind(site.site_id),
    env.GATEWAY_DB.prepare("DELETE FROM telegram_connect_sessions WHERE site_id = ?").bind(site.site_id)
  ]);
  return json({ ok: true });
}

function startParameter(text) {
  const normalized = String(text || "").trim();
  const match = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([A-Za-z0-9_-]{1,64}))?$/u.exec(normalized);
  return match ? match[1] || "" : null;
}

function isHelpCommand(text) {
  return /^\/help(?:@[A-Za-z0-9_]+)?$/u.test(String(text || "").trim());
}

async function handleTelegramWebhook(request, env) {
  const providedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!constantTimeEqual(providedSecret, env.TELEGRAM_WEBHOOK_SECRET)) {
    return errorResponse(new Error("Доступ запрещён."), 401, "UNAUTHORIZED");
  }
  const update = await requestJson(request);
  const updateId = Number(update.update_id);
  if (!Number.isSafeInteger(updateId) || updateId < 0) throw new Error("Некорректное обновление Telegram.");
  const duplicate = await env.GATEWAY_DB.prepare("SELECT update_id FROM telegram_updates WHERE update_id = ?").bind(updateId).first();
  if (duplicate) return json({ ok: true, duplicate: true });

  const message = update.message;
  const parameter = startParameter(message?.text);
  const chatId = String(message?.chat?.id || "");
  const chatType = String(message?.chat?.type || "");
  const telegramUserId = message?.from?.id ? String(message.from.id) : null;
  const receivedAt = new Date().toISOString();

  if (parameter && SUPPORT_START_PARAMETER_PATTERN.test(parameter) && /^\d{1,24}$/u.test(chatId) && chatType === "private") {
    const tokenHash = await digest("support-connect-token", parameter);
    const session = await env.GATEWAY_DB.prepare(
      "SELECT s.user_id, s.expires_at, s.used_at, u.display_name FROM platform_support_connect_sessions s " +
      "JOIN platform_users u ON u.user_id = s.user_id WHERE s.token_hash = ? AND u.platform_role = 'operator' AND u.status = 'active'"
    ).bind(tokenHash).first();
    if (session && !session.used_at && session.expires_at > receivedAt) {
      await env.GATEWAY_DB.batch([
        env.GATEWAY_DB.prepare(
          "INSERT INTO platform_support_destinations (user_id, chat_id, chat_type, telegram_user_id, linked_at, enabled) VALUES (?, ?, ?, ?, ?, 1) " +
          "ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, chat_type = excluded.chat_type, telegram_user_id = excluded.telegram_user_id, linked_at = excluded.linked_at, enabled = 1"
        ).bind(session.user_id, chatId, chatType, telegramUserId, receivedAt),
        env.GATEWAY_DB.prepare("UPDATE platform_support_connect_sessions SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
          .bind(receivedAt, tokenHash),
        env.GATEWAY_DB.prepare("INSERT INTO telegram_updates (update_id, received_at) VALUES (?, ?)")
          .bind(updateId, receivedAt)
      ]);
      try {
        await telegramSendMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "✅ Уведомления поддержки SiteCare подключены\nНовые обращения клиентов будут приходить сюда. Ответить клиенту можно из раздела «Поддержка» в панели."
        );
      } catch {
        // The destination is stored; the panel test will expose a Telegram delivery issue.
      }
      return json({ ok: true, linked: true, support: true });
    }
  }

  if (parameter && SITE_START_PARAMETER_PATTERN.test(parameter) && /^\d{1,24}$/u.test(chatId) && chatType === "private") {
    const tokenHash = await digest("connect-token", parameter);
    const session = await env.GATEWAY_DB.prepare(
      "SELECT s.site_id, s.expires_at, s.used_at, g.site_name, g.target_url FROM telegram_connect_sessions s " +
      "JOIN gateway_sites g ON g.site_id = s.site_id WHERE s.token_hash = ? AND g.enabled = 1"
    ).bind(tokenHash).first();
    if (session && !session.used_at && session.expires_at > receivedAt) {
      await env.GATEWAY_DB.batch([
        env.GATEWAY_DB.prepare(
          "INSERT INTO telegram_destinations (site_id, chat_id, chat_type, telegram_user_id, linked_at, enabled) VALUES (?, ?, ?, ?, ?, 1) " +
          "ON CONFLICT(site_id) DO UPDATE SET chat_id = excluded.chat_id, chat_type = excluded.chat_type, telegram_user_id = excluded.telegram_user_id, linked_at = excluded.linked_at, enabled = 1"
        ).bind(session.site_id, chatId, chatType, telegramUserId, receivedAt),
        env.GATEWAY_DB.prepare("UPDATE telegram_connect_sessions SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
          .bind(receivedAt, tokenHash),
        env.GATEWAY_DB.prepare("INSERT INTO telegram_updates (update_id, received_at) VALUES (?, ?)")
          .bind(updateId, receivedAt)
      ]);
      try {
        await telegramSendMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          `✅ SiteCare подключён\n${session.site_name}\n${session.target_url}\nУведомления о сбое и восстановлении будут приходить сюда.`
        );
      } catch {
        // The link is already stored. A later test from the panel will expose a delivery issue.
      }
      return json({ ok: true, linked: true });
    }
  }

  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare("INSERT INTO telegram_updates (update_id, received_at) VALUES (?, ?)").bind(updateId, receivedAt),
    env.GATEWAY_DB.prepare(
      "DELETE FROM telegram_updates WHERE update_id NOT IN (SELECT update_id FROM telegram_updates ORDER BY update_id DESC LIMIT 1000)"
    )
  ]);
  if ((parameter !== null || isHelpCommand(message?.text)) && /^\d{1,24}$/u.test(chatId) && chatType === "private") {
    const text = parameter
      ? "Ссылка подключения недействительна или истекла. Вернитесь в панель SiteCare и нажмите «Подключить Telegram» ещё раз."
      : "Это официальный бот SiteCare. Он сообщает о сбоях и восстановлении сайтов. Подключение запускается кнопкой в панели вашего сайта.";
    try {
      await telegramSendMessage(env.TELEGRAM_BOT_TOKEN, chatId, text);
    } catch {
      // Telegram will retry the webhook only for HTTP failures; an explanatory reply is optional.
    }
  }
  return json({ ok: true, linked: false });
}

async function handleRequest(request, env) {
  requireSecrets(env);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/u, "") || "/";
  if (request.method === "GET" && path === "/health") {
    const botUsername = await setting(env, "bot_username");
    return json({ ok: true, service: "sitecare-telegram-gateway", platformVersion: PLATFORM_VERSION, botUsername: botUsername || null });
  }
  const platformResponse = await handlePlatformRoute(request, env, path);
  if (platformResponse) return platformResponse;
  if (request.method === "POST" && path === "/v1/admin/bootstrap") return handleBootstrap(request, env, url);
  if (request.method === "POST" && path === "/v1/telegram/webhook") return handleTelegramWebhook(request, env);

  const match = /^\/v1\/sites\/([a-z0-9][a-z0-9-]{2,63})\/(connect|status|notifications|destination)$/u.exec(path);
  if (match) {
    const site = await requireSite(request, env, match[1]);
    if (request.method === "POST" && match[2] === "connect") return handleCreateConnection(request, env, site);
    if (request.method === "GET" && match[2] === "status") return json(await destinationState(env, site));
    if (request.method === "POST" && match[2] === "notifications") return handleSendNotification(request, env, site);
    if (request.method === "DELETE" && match[2] === "destination") return handleDisconnect(env, site);
  }
  return errorResponse(new Error("Страница не найдена."), 404, "NOT_FOUND");
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      const status = Number.isInteger(Number(error?.status)) ? Number(error.status) : 400;
      return errorResponse(error, status, error?.code || (status === 401 ? "UNAUTHORIZED" : "BAD_REQUEST"));
    }
  },
  async scheduled(_controller, env, context) {
    context.waitUntil(scheduledPlatformChecks(env));
  }
};

export const gatewayInternals = Object.freeze({ digest, isHelpCommand, startParameter, validateSiteId, validateTargetUrl });
