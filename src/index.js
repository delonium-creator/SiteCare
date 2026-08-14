import {
  FIELD_LABELS,
  LOCK,
  assertLockedEnvironment,
  configFromRow,
  looksLikeDirectEditRequest,
  monitorResult,
  parseCommand,
  publicConfig,
  validateFieldValue
} from "./core.js";
import {
  AI_DAILY_REQUEST_LIMIT,
  adviceIsGrounded,
  assistantFallback,
  buildAiMessages,
  extractPageText,
  groundedAuditAdvice,
  isAuditRequest,
  localActionFromMessage,
  localAssistantAnswer,
  localQuestionKind,
  normalizeAssistantInput,
  requestAiAnswer
} from "./assistant.js";
import { adminHtml } from "./admin.js";
import {
  TEST_MARKER_TTL_MINUTES,
  createTestMarker,
  formMonitorResult,
  hashTestMarker,
  parseWebhookRequest,
  submissionMetadata,
  testMarkerKindForForms,
  testMarkerFromEntries,
  webhookToken
} from "./forms.js";
import { formatWeeklySchedule, isCompleteSchedule, parseWeeklySchedule } from "./schedule.js";
import {
  TELEGRAM_CONNECT_TTL_MINUTES,
  createTelegramConnectCode,
  decryptTelegramBotToken,
  encryptTelegramBotToken,
  findTelegramChatByCode,
  hashTelegramConnectCode,
  telegramGetMe,
  telegramGetUpdates,
  telegramSendMessage,
  validateTelegramBotToken
} from "./notifications.js";
import {
  gatewayConfig,
  gatewayConnectionStatus,
  gatewayCreateConnection,
  gatewayDisconnect,
  gatewaySendNotification
} from "./gateway-notifications.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const COOKIE_NAME = "sitecare_session";
const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_PAGE_BODY_BYTES = 1_500_000;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...extraHeaders
    }
  });
}

function errorResponse(error, status = 400) {
  const message = error instanceof Error ? error.message : "Неизвестная ошибка.";
  return json({ error: message }, status, { "Cache-Control": "no-store" });
}

async function requestJson(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    const error = new Error("Ожидался JSON-запрос.");
    error.status = 415;
    throw error;
  }
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
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
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Некорректный запрос.");
  }
  return body;
}

async function boundedResponseText(response, maximum = MAX_PAGE_BODY_BYTES) {
  const declaredLength = Number(response.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    throw new Error("Ответ страницы слишком большой.");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (encoder.encode(text).byteLength > maximum) throw new Error("Ответ страницы слишком большой.");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new Error("Ответ страницы слишком большой.");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(result);
}

function assertTargetResponse(response) {
  if (!response.url) return;
  const finalUrl = new URL(response.url);
  if (finalUrl.origin !== LOCK.origin || finalUrl.pathname !== LOCK.pathname) {
    throw new Error("Страница перенаправила проверку за пределы разрешённого адреса.");
  }
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new Error("Некорректный base64url.");
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64url(bytes) !== value) throw new Error("Неканоничный base64url.");
  return bytes;
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function signToken(payload, secret) {
  const encoded = base64url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${base64url(await hmac(encoded, secret))}`;
}

async function verifyToken(token, secret, kind) {
  const [encoded, signature, extra] = String(token || "").split(".");
  if (!encoded || !signature || extra) throw new Error("Недействительное подтверждение.");
  const expected = await hmac(encoded, secret);
  let actual;
  try {
    actual = fromBase64url(signature);
  } catch {
    throw new Error("Недействительное подтверждение.");
  }
  if (!equalBytes(actual, expected)) throw new Error("Недействительное подтверждение.");
  const payload = JSON.parse(decoder.decode(fromBase64url(encoded)));
  if (payload.kind !== kind || payload.siteId !== LOCK.siteId || Number(payload.exp) < Date.now()) {
    throw new Error("Подтверждение истекло. Повторите команду.");
  }
  return payload;
}

async function passwordMatches(value, expected) {
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(value || ""))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(expected || "")))
  ]);
  return equalBytes(new Uint8Array(left), new Uint8Array(right));
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

async function requireSession(request, env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET is not configured.");
  }
  return verifyToken(getCookie(request, COOKIE_NAME), env.SESSION_SECRET, "session");
}

function requireSameOrigin(request) {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("Origin");
  if (origin !== requestOrigin) throw new Error("Запрос с другого сайта запрещён.");
}

async function getConfig(env) {
  const row = await env.DB.prepare("SELECT * FROM site_config WHERE site_id = ?").bind(LOCK.siteId).first();
  const config = configFromRow(row);
  if (!config) throw new Error("Настройки страницы не найдены.");
  return config;
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return origin === LOCK.origin
    ? { "Access-Control-Allow-Origin": LOCK.origin, "Vary": "Origin" }
    : { "Vary": "Origin" };
}

async function hashIp(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${ip}:${env.SESSION_SECRET}`));
  return base64url(new Uint8Array(digest));
}

async function loginAllowed(request, env) {
  const ipHash = await hashIp(request, env);
  const row = await env.DB.prepare("SELECT * FROM auth_attempts WHERE ip_hash = ?").bind(ipHash).first();
  const now = Date.now();
  if (row?.blocked_until && Date.parse(row.blocked_until) > now) {
    return { allowed: false, ipHash };
  }
  return { allowed: true, ipHash, row };
}

async function recordLoginFailure(env, ipHash, row) {
  const now = Date.now();
  const oldWindow = row?.window_started ? Date.parse(row.window_started) : 0;
  const attempts = now - oldWindow > 15 * 60 * 1000 ? 1 : Number(row?.attempts || 0) + 1;
  const windowStarted = now - oldWindow > 15 * 60 * 1000 ? new Date(now).toISOString() : row.window_started;
  const blockedUntil = attempts >= 5 ? new Date(now + 15 * 60 * 1000).toISOString() : null;
  await env.DB.prepare(
    "INSERT INTO auth_attempts (ip_hash, attempts, window_started, blocked_until) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(ip_hash) DO UPDATE SET attempts=excluded.attempts, window_started=excluded.window_started, blocked_until=excluded.blocked_until"
  ).bind(ipHash, attempts, windowStarted, blockedUntil).run();
}

async function handleLogin(request, env) {
  requireSameOrigin(request);
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    return errorResponse(new Error("Защита входа ещё не настроена."), 503);
  }
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 12) {
    return errorResponse(new Error("Пароль владельца ещё не настроен."), 503);
  }
  const attempt = await loginAllowed(request, env);
  if (!attempt.allowed) return errorResponse(new Error("Слишком много попыток. Повторите через 15 минут."), 429);
  const body = await requestJson(request);
  if (!(await passwordMatches(body.password, env.ADMIN_PASSWORD))) {
    await recordLoginFailure(env, attempt.ipHash, attempt.row);
    return errorResponse(new Error("Неверный пароль."), 401);
  }
  await env.DB.prepare("DELETE FROM auth_attempts WHERE ip_hash = ?").bind(attempt.ipHash).run();
  const hours = Math.min(Math.max(Number(env.SESSION_HOURS) || 12, 1), 24);
  const expiresAt = Date.now() + hours * 60 * 60 * 1000;
  const token = await signToken({ kind: "session", siteId: LOCK.siteId, exp: expiresAt }, env.SESSION_SECRET);
  return json(
    { ok: true },
    200,
    {
      "Cache-Control": "no-store",
      "Set-Cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${hours * 3600}`
    }
  );
}

async function handlePublicConfig(request, env) {
  const config = await getConfig(env);
  const result = publicConfig(config);
  const etag = `\"sitecare-${config.version}-${config.enabled ? 1 : 0}\"`;
  const headers = {
    ...corsHeaders(request),
    "Cache-Control": "public, max-age=15, stale-if-error=300",
    ETag: etag
  };
  if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  return json(result, 200, headers);
}

async function handleAdminState(env) {
  const [config, history, monitor, ai, forms, notifications] = await Promise.all([
    getConfig(env),
    env.DB.prepare(
      "SELECT id, version, action, field, old_value, new_value, changed_at FROM change_history WHERE site_id = ? ORDER BY id DESC LIMIT 30"
    ).bind(LOCK.siteId).all(),
    env.DB.prepare(
      "SELECT checked_at, ok, http_status, details FROM monitor_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1"
    ).bind(LOCK.siteId).first(),
    getAiUsage(env),
    getFormsState(env),
    getNotificationsState(env)
  ]);
  return json({
    config,
    history: (history.results || []).map((item) => ({
      ...item,
      field_label: FIELD_LABELS[item.field] || (item.field === "enabled" ? "Показ изменений" : item.field)
    })),
    monitor: monitor ? { ...monitor, ok: Boolean(monitor.ok) } : null,
    ai,
    forms,
    notifications
  }, 200, { "Cache-Control": "no-store" });
}

function parseStoredJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

async function expireFormTests(env, now = new Date().toISOString()) {
  await env.DB.prepare(
    "UPDATE form_test_sessions SET status = 'expired' WHERE site_id = ? AND status = 'pending' AND expires_at <= ?"
  ).bind(LOCK.siteId, now).run();
}

async function getFormsState(env) {
  await expireFormTests(env);
  const [monitor, receipts, testSession] = await Promise.all([
    env.DB.prepare(
      "SELECT checked_at, ok, http_status, form_count, ready_count, receiver_count, details, summary_json FROM form_monitor_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1"
    ).bind(LOCK.siteId).first(),
    env.DB.prepare(
      "SELECT received_at, form_id, field_names_json, field_count, matched_test FROM form_receipts WHERE site_id = ? ORDER BY id DESC LIMIT 200"
    ).bind(LOCK.siteId).all(),
    env.DB.prepare(
      "SELECT id, status, created_at, expires_at, confirmed_at FROM form_test_sessions WHERE site_id = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(LOCK.siteId).first()
  ]);
  const recentReceipts = (receipts.results || []).map((receipt) => ({
    receivedAt: receipt.received_at,
    formId: receipt.form_id || null,
    fieldNames: parseStoredJson(receipt.field_names_json, []),
    fieldCount: Number(receipt.field_count || 0),
    matchedTest: Boolean(receipt.matched_test)
  }));
  return {
    webhookReady: Boolean(env.FORM_WEBHOOK_SECRET && env.FORM_WEBHOOK_SECRET.length >= 32),
    monitor: monitor ? {
      checked_at: monitor.checked_at,
      ok: Boolean(monitor.ok),
      httpStatus: Number(monitor.http_status || 0),
      formCount: Number(monitor.form_count || 0),
      readyCount: Number(monitor.ready_count || 0),
      receiverCount: Number(monitor.receiver_count || 0),
      details: monitor.details,
      forms: parseStoredJson(monitor.summary_json, [])
    } : null,
    lastReceipt: recentReceipts[0] || null,
    recentReceipts,
    testSession: testSession ? {
      id: testSession.id,
      status: testSession.status,
      createdAt: testSession.created_at,
      expiresAt: testSession.expires_at,
      confirmedAt: testSession.confirmed_at || null
    } : null
  };
}

function safeNotificationDetails(value, maximum = 220) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F<>]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

async function getNotificationsState(env) {
  const [settings, events] = await Promise.all([
    env.DB.prepare(
      "SELECT chat_type, enabled, connect_code_hash, connect_expires_at, last_delivery_at, last_delivery_ok, last_error, encrypted_bot_token, chat_id FROM notification_settings WHERE site_id = ?"
    ).bind(LOCK.siteId).first(),
    env.DB.prepare(
      "SELECT event_type, status, created_at, details FROM notification_events WHERE site_id = ? ORDER BY id DESC LIMIT 8"
    ).bind(LOCK.siteId).all()
  ]);
  const now = new Date().toISOString();
  const directConfigured = Boolean(settings?.encrypted_bot_token && settings?.chat_id);
  const sharedMode = Boolean(env.TELEGRAM_GATEWAY_URL || env.TELEGRAM_SITE_TOKEN);
  let shared = null;
  let gatewayError = null;
  if (sharedMode) {
    try {
      shared = await gatewayConnectionStatus(env, LOCK.siteId);
    } catch (error) {
      gatewayError = safeNotificationDetails(error instanceof Error ? error.message : "Общий SiteCareBot недоступен.");
    }
  }
  const sharedLocalMarker = sharedMode && !directConfigured && Boolean(settings?.enabled);
  const configured = sharedMode
    ? shared
      ? Boolean(shared.configured && shared.enabled)
      : sharedLocalMarker
    : directConfigured;
  return {
    connectionMode: sharedMode ? "shared" : "direct",
    configured,
    enabled: sharedMode ? configured : configured && Boolean(settings.enabled),
    legacyConfigured: sharedMode && directConfigured && Boolean(settings.enabled),
    botUsername: shared?.botUsername || null,
    destination: configured
      ? sharedMode
        ? shared?.destination || "личный чат (шлюз временно недоступен)"
        : settings.chat_type === "private" ? "личный чат" : "группа"
      : null,
    connectionPending: !sharedMode && Boolean(settings?.connect_code_hash && settings?.connect_expires_at > now),
    connectExpiresAt: !sharedMode && settings?.connect_code_hash ? settings.connect_expires_at : null,
    lastDeliveryAt: settings?.last_delivery_at || null,
    lastDeliveryOk: settings?.last_delivery_ok === null || settings?.last_delivery_ok === undefined
      ? null
      : Boolean(settings.last_delivery_ok),
    lastError: settings?.last_error || null,
    gatewayError,
    events: (events.results || []).map((event) => ({
      eventType: event.event_type,
      status: event.status,
      createdAt: event.created_at,
      details: event.details
    }))
  };
}

async function recordNotificationDelivery(env, eventType, ok, details, createdAt = new Date().toISOString()) {
  const safeDetails = safeNotificationDetails(details) || (ok ? "Уведомление отправлено." : "Уведомление не отправлено.");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO notification_settings (site_id, enabled, updated_at, last_delivery_at, last_delivery_ok, last_error) VALUES (?, 0, ?, ?, ?, ?) " +
      "ON CONFLICT(site_id) DO UPDATE SET last_delivery_at = excluded.last_delivery_at, last_delivery_ok = excluded.last_delivery_ok, last_error = excluded.last_error, updated_at = excluded.updated_at"
    ).bind(LOCK.siteId, createdAt, createdAt, ok ? 1 : 0, ok ? null : safeDetails),
    env.DB.prepare(
      "INSERT INTO notification_events (site_id, event_type, status, created_at, details) VALUES (?, ?, ?, ?, ?)"
    ).bind(LOCK.siteId, eventType, ok ? "sent" : "failed", createdAt, safeDetails),
    env.DB.prepare(
      "DELETE FROM notification_events WHERE site_id = ? AND id NOT IN (SELECT id FROM notification_events WHERE site_id = ? ORDER BY id DESC LIMIT 100)"
    ).bind(LOCK.siteId, LOCK.siteId)
  ]);
}

async function sendConfiguredNotification(env, eventType, message, stableEventId = null) {
  const settings = await env.DB.prepare(
    "SELECT encrypted_bot_token, chat_id, enabled FROM notification_settings WHERE site_id = ?"
  ).bind(LOCK.siteId).first();
  const sharedMode = Boolean(env.TELEGRAM_GATEWAY_URL || env.TELEGRAM_SITE_TOKEN);
  let sharedError = null;
  let ambiguousGatewayFailure = false;
  if (sharedMode) {
    const eventId = stableEventId || `${LOCK.siteId}:${eventType}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        gatewayConfig(env);
        const result = await gatewaySendNotification(env, LOCK.siteId, { eventId, eventType, text: message });
        if (result?.sent || result?.pending) {
          await recordNotificationDelivery(env, eventType, true, result.pending
            ? "Уведомление уже обрабатывается общим SiteCareBot."
            : "Уведомление отправлено через общий SiteCareBot."
          );
          return { sent: true, skipped: false, provider: "shared" };
        }
        throw new Error("Общий SiteCareBot не подтвердил отправку.");
      } catch (error) {
        sharedError = safeNotificationDetails(error instanceof Error ? error.message : "Общий SiteCareBot недоступен.");
        ambiguousGatewayFailure = /BOT-GATEWAY-(?:TIMEOUT|NET|RESPONSE)/u.test(sharedError);
        if (!ambiguousGatewayFailure || attempt === 1) break;
      }
    }
  }
  if (!settings?.encrypted_bot_token || !settings?.chat_id || !settings.enabled || ambiguousGatewayFailure) {
    if (sharedError) {
      await recordNotificationDelivery(env, eventType, false, sharedError);
      return { sent: false, skipped: false, error: sharedError };
    }
    return { sent: false, skipped: true };
  }
  try {
    const token = await decryptTelegramBotToken(settings.encrypted_bot_token, env.SESSION_SECRET);
    await telegramSendMessage(token, settings.chat_id, message);
    await recordNotificationDelivery(
      env,
      eventType,
      true,
      sharedError ? "Общий SiteCareBot временно недоступен; уведомление отправлено через резервное подключение." : "Уведомление отправлено в Telegram."
    );
    return { sent: true, skipped: false, provider: sharedError ? "legacy-fallback" : "direct" };
  } catch (error) {
    const details = safeNotificationDetails(error instanceof Error ? error.message : "Telegram недоступен.");
    await recordNotificationDelivery(env, eventType, false, details);
    return { sent: false, skipped: false, error: details };
  }
}

async function handleTelegramStart(request, env) {
  if (env.TELEGRAM_GATEWAY_URL || env.TELEGRAM_SITE_TOKEN) {
    gatewayConfig(env);
    const result = await gatewayCreateConnection(env, LOCK.siteId);
    return json(result, 200, { "Cache-Control": "no-store" });
  }
  const body = await requestJson(request);
  const token = validateTelegramBotToken(body.botToken);
  const bot = await telegramGetMe(token);
  if (!bot?.id || bot?.is_bot !== true) throw new Error("Telegram не подтвердил этого бота.");

  const code = createTelegramConnectCode();
  const now = new Date();
  const updatedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + TELEGRAM_CONNECT_TTL_MINUTES * 60 * 1000).toISOString();
  const [encryptedToken, codeHash] = await Promise.all([
    encryptTelegramBotToken(token, env.SESSION_SECRET),
    hashTelegramConnectCode(code, env.SESSION_SECRET)
  ]);
  await env.DB.prepare(
    `INSERT INTO notification_settings (
      site_id, encrypted_bot_token, chat_id, chat_type, enabled, connect_code_hash, connect_expires_at, updated_at, last_error
    ) VALUES (?, ?, NULL, NULL, 0, ?, ?, ?, NULL)
    ON CONFLICT(site_id) DO UPDATE SET
      encrypted_bot_token = excluded.encrypted_bot_token,
      chat_id = NULL,
      chat_type = NULL,
      enabled = 0,
      connect_code_hash = excluded.connect_code_hash,
      connect_expires_at = excluded.connect_expires_at,
      updated_at = excluded.updated_at,
      last_error = NULL`
  ).bind(LOCK.siteId, encryptedToken, codeHash, expiresAt, updatedAt).run();
  return json({
    ok: true,
    code,
    expiresAt,
    expiresInMinutes: TELEGRAM_CONNECT_TTL_MINUTES,
    botUsername: safeNotificationDetails(bot.username, 80) || null
  }, 200, { "Cache-Control": "no-store" });
}

async function handleTelegramConfirm(env) {
  if (env.TELEGRAM_GATEWAY_URL || env.TELEGRAM_SITE_TOKEN) {
    gatewayConfig(env);
    const status = await gatewayConnectionStatus(env, LOCK.siteId);
    if (!status?.configured || !status?.enabled) {
      throw new Error("Подключение пока не подтверждено. Откройте SiteCareBot по выданной ссылке и нажмите Start.");
    }
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO notification_settings (site_id, enabled, updated_at, last_delivery_at, last_delivery_ok, last_error) VALUES (?, 1, ?, ?, 1, NULL) " +
        "ON CONFLICT(site_id) DO UPDATE SET encrypted_bot_token = NULL, chat_id = NULL, chat_type = NULL, enabled = 1, connect_code_hash = NULL, connect_expires_at = NULL, updated_at = excluded.updated_at, last_delivery_at = excluded.last_delivery_at, last_delivery_ok = 1, last_error = NULL"
      ).bind(LOCK.siteId, now, now),
      env.DB.prepare(
        "INSERT INTO notification_events (site_id, event_type, status, created_at, details) VALUES (?, 'connection', 'sent', ?, 'Общий SiteCareBot подключён и проверен.')"
      ).bind(LOCK.siteId, now)
    ]);
    return json({ ok: true, provider: "shared" }, 200, { "Cache-Control": "no-store" });
  }
  const settings = await env.DB.prepare(
    "SELECT encrypted_bot_token, connect_code_hash, connect_expires_at FROM notification_settings WHERE site_id = ?"
  ).bind(LOCK.siteId).first();
  const now = new Date().toISOString();
  if (!settings?.encrypted_bot_token || !settings?.connect_code_hash) {
    throw new Error("Сначала начните подключение Telegram в панели.");
  }
  if (!settings.connect_expires_at || settings.connect_expires_at <= now) {
    throw new Error("Код подключения истёк. Начните подключение заново.");
  }
  const token = await decryptTelegramBotToken(settings.encrypted_bot_token, env.SESSION_SECRET);
  const updates = await telegramGetUpdates(token);
  const chat = await findTelegramChatByCode(updates, settings.connect_code_hash, env.SESSION_SECRET);
  if (!chat) {
    throw new Error("Код пока не найден. Отправьте его своему боту в Telegram и повторите проверку.");
  }
  await telegramSendMessage(
    token,
    chat.chatId,
    `✅ SiteCare подключён\n${LOCK.targetUrl}\nУведомления о сбое страницы и формы будут приходить в этот чат.`
  );
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE notification_settings SET chat_id = ?, chat_type = ?, enabled = 1, connect_code_hash = NULL, connect_expires_at = NULL, updated_at = ?, last_delivery_at = ?, last_delivery_ok = 1, last_error = NULL WHERE site_id = ?"
    ).bind(chat.chatId, chat.chatType, now, now, LOCK.siteId),
    env.DB.prepare(
      "INSERT INTO notification_events (site_id, event_type, status, created_at, details) VALUES (?, 'connection', 'sent', ?, 'Telegram подключён и проверен.')"
    ).bind(LOCK.siteId, now)
  ]);
  return json({ ok: true }, 200, { "Cache-Control": "no-store" });
}

async function handleTelegramTest(env) {
  const result = await sendConfiguredNotification(
    env,
    "test",
    `✅ Тест SiteCare\n${LOCK.targetUrl}\nУведомления работают.`
  );
  if (!result.sent) {
    const error = new Error(result.skipped ? "Telegram ещё не подключён." : result.error || "Telegram не принял уведомление.");
    error.status = 502;
    throw error;
  }
  return json({ ok: true }, 200, { "Cache-Control": "no-store" });
}

async function handleTelegramDisconnect(env) {
  if (env.TELEGRAM_GATEWAY_URL || env.TELEGRAM_SITE_TOKEN) {
    gatewayConfig(env);
    await gatewayDisconnect(env, LOCK.siteId);
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE notification_settings SET encrypted_bot_token = NULL, chat_id = NULL, chat_type = NULL, enabled = 0, connect_code_hash = NULL, connect_expires_at = NULL, updated_at = ?, last_error = NULL WHERE site_id = ?"
  ).bind(now, LOCK.siteId).run();
  return json({ ok: true }, 200, { "Cache-Control": "no-store" });
}

async function getAiUsage(env) {
  const today = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare("SELECT request_count FROM ai_daily_usage WHERE day = ?").bind(today).first();
  const used = Math.max(0, Number(row?.request_count || 0));
  return {
    dailyLimit: AI_DAILY_REQUEST_LIMIT,
    used,
    remaining: Math.max(0, AI_DAILY_REQUEST_LIMIT - used)
  };
}

async function createProposal(change, env) {
  const token = await signToken(
    {
      kind: "proposal",
      siteId: LOCK.siteId,
      field: change.field,
      before: change.before,
      after: change.after,
      baseVersion: change.baseVersion,
      operation: change.operation || "update",
      exp: Date.now() + 10 * 60 * 1000
    },
    env.SESSION_SECRET
  );
  return { change, token };
}

async function handlePropose(request, env) {
  const body = await requestJson(request);
  const config = await getConfig(env);
  const change = parseCommand(body.command, config);
  return json(await createProposal(change, env), 200, { "Cache-Control": "no-store" });
}

async function consumeAiAllowance(env) {
  const day = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "INSERT INTO ai_daily_usage (day, request_count, updated_at) VALUES (?, 1, ?) " +
      "ON CONFLICT(day) DO UPDATE SET request_count = request_count + 1, updated_at = excluded.updated_at " +
      "WHERE request_count < ?"
  ).bind(day, now, AI_DAILY_REQUEST_LIMIT).run();
  const changed = Number(result?.meta?.changes || 0);
  const row = await env.DB.prepare("SELECT request_count FROM ai_daily_usage WHERE day = ?").bind(day).first();
  const used = Math.max(0, Number(row?.request_count || 0));
  return {
    allowed: changed > 0,
    remaining: Math.max(0, AI_DAILY_REQUEST_LIMIT - used)
  };
}

async function getPageTextForAssistant() {
  try {
    const response = await fetch(LOCK.targetUrl, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "SiteCare-Assistant/1.0" },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return "";
    assertTargetResponse(response);
    return extractPageText(await boundedResponseText(response));
  } catch {
    return "";
  }
}

async function handleAssistant(request, env) {
  const body = await requestJson(request);
  const rawMessage = String(body.message ?? body.command ?? "");
  const explicitAi = rawMessage.match(/^\s*(?:ии|нейросеть)\s*:\s*(.+)$/isu);
  const input = normalizeAssistantInput(explicitAi ? explicitAi[1] : rawMessage, body.history);
  let confirmedAi = false;
  if (body.aiConfirmationToken) {
    const confirmation = await verifyToken(body.aiConfirmationToken, env.SESSION_SECRET, "ai-confirmation");
    if (confirmation.message !== input.message) {
      throw new Error("Подтверждение ИИ относится к другому вопросу. Отправьте вопрос заново.");
    }
    confirmedAi = true;
  }
  const forceAi = confirmedAi || Boolean(explicitAi);
  const config = await getConfig(env);

  if (!forceAi) {
    let directError;
    try {
      const directChange = parseCommand(input.message, config);
      const proposal = await createProposal(directChange, env);
      return json({
        kind: "proposal",
        source: "rules",
        usesAi: false,
        message: "Я подготовил безопасную правку. Проверьте вариант ниже и нажмите «Подтвердить», если всё верно.",
        ...proposal
      }, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      directError = error;
    }

    if (looksLikeDirectEditRequest(input.message)) {
      const usage = await getAiUsage(env);
      return json({
        kind: "advice",
        source: "rules",
        usesAi: false,
        message: directError instanceof Error ? directError.message : "Не удалось подготовить правку.",
        remaining: usage.remaining
      }, 200, { "Cache-Control": "no-store" });
    }

    const localAction = localActionFromMessage(input.message);
    if (localAction?.kind === "check-forms") {
      const [usage, checks] = await Promise.all([getAiUsage(env), runSiteChecks(env)]);
      return json({
        kind: "advice",
        source: "local-action",
        usesAi: false,
        message: `${checks.formMonitor.details} Проверка не отправляла тестовую заявку.`,
        remaining: usage.remaining
      }, 200, { "Cache-Control": "no-store" });
    }
    if (localAction?.kind === "check") {
      const [usage, monitor] = await Promise.all([getAiUsage(env), runMonitor(env)]);
      return json({
        kind: "advice",
        source: "local-action",
        usesAi: false,
        message: monitor.details,
        remaining: usage.remaining
      }, 200, { "Cache-Control": "no-store" });
    }
    if (localAction?.kind === "toggle") {
      const usage = await getAiUsage(env);
      if (config.enabled === localAction.enabled) {
        return json({
          kind: "advice",
          source: "local-action",
          usesAi: false,
          message: localAction.enabled ? "Показ изменений уже включён." : "Показ изменений уже выключен.",
          remaining: usage.remaining
        }, 200, { "Cache-Control": "no-store" });
      }
      const proposal = await createProposal({
        field: "enabled",
        label: "Показ изменений",
        before: config.enabled,
        after: localAction.enabled,
        baseVersion: config.version,
        operation: localAction.enabled ? "enable" : "disable"
      }, env);
      return json({
        kind: "proposal",
        source: "local-action",
        usesAi: false,
        message: localAction.enabled
          ? "Подтвердите включение: после этого сохранённые значения будут показаны на закреплённой странице."
          : "Подтвердите выключение: страница вернётся к исходным значениям Tilda.",
        remaining: usage.remaining,
        ...proposal
      }, 200, { "Cache-Control": "no-store" });
    }
    if (localAction?.kind === "undo") {
      const usage = await getAiUsage(env);
      const query = localAction.field
        ? env.DB.prepare("SELECT * FROM change_history WHERE site_id = ? AND field = ? ORDER BY id DESC LIMIT 20").bind(LOCK.siteId, localAction.field)
        : env.DB.prepare("SELECT * FROM change_history WHERE site_id = ? ORDER BY id DESC LIMIT 20").bind(LOCK.siteId);
      const history = await query.all();
      let change = null;
      for (const item of history.results || []) {
        try {
          if (item.field === "enabled") {
            const after = item.old_value === "true" || item.old_value === "1";
            if (after !== config.enabled) {
              change = { field: "enabled", label: "Показ изменений", before: config.enabled, after, baseVersion: config.version, operation: "rollback" };
              break;
            }
          } else if (COLUMN_BY_FIELD[item.field]) {
            const after = validateFieldValue(item.field, item.old_value);
            if (after !== config[item.field]) {
              change = { field: item.field, label: FIELD_LABELS[item.field], before: config[item.field], after, baseVersion: config.version, operation: "rollback" };
              break;
            }
          }
        } catch {
          // Invalid legacy history records are skipped instead of being restored.
        }
      }
      if (!change) {
        return json({
          kind: "advice",
          source: "local-action",
          usesAi: false,
          message: "Не нашёл подходящую правку для возврата.",
          remaining: usage.remaining
        }, 200, { "Cache-Control": "no-store" });
      }
      return json({
        kind: "proposal",
        source: "local-action",
        usesAi: false,
        message: "Я нашёл последнее подходящее изменение. Проверьте значения и подтвердите возврат.",
        remaining: usage.remaining,
        ...(await createProposal(change, env))
      }, 200, { "Cache-Control": "no-store" });
    }

    const localKind = localQuestionKind(input.message);
    if (localKind) {
      const [usage, monitor, recent, pageText, forms, notifications] = await Promise.all([
        getAiUsage(env),
        localKind === "status" || localKind === "audit"
          ? env.DB.prepare("SELECT checked_at, ok, http_status, details FROM monitor_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1").bind(LOCK.siteId).first()
          : Promise.resolve(null),
        localKind === "history"
          ? env.DB.prepare("SELECT field, old_value, new_value, changed_at FROM change_history WHERE site_id = ? ORDER BY id DESC LIMIT 5").bind(LOCK.siteId).all()
          : Promise.resolve({ results: [] }),
        localKind === "audit" ? getPageTextForAssistant() : Promise.resolve(""),
        localKind === "forms" ? getFormsState(env) : Promise.resolve(null),
        localKind === "notifications" ? getNotificationsState(env) : Promise.resolve(null)
      ]);
      return json({
        kind: "advice",
        source: "local-rules",
        usesAi: false,
        message: localAssistantAnswer(localKind, {
          config,
          monitor,
          forms,
          notifications,
          recentChanges: recent.results || [],
          remaining: usage.remaining,
          pageText
        }),
        remaining: usage.remaining
      }, 200, { "Cache-Control": "no-store" });
    }
  }

  if (!env.AI || typeof env.AI.run !== "function") {
    return json({
      kind: "advice",
      message: assistantFallback("binding"),
      diagnosticCode: "AI-01",
      aiUnavailable: true,
      usesAi: false
    }, 200, { "Cache-Control": "no-store" });
  }

  if (!forceAi) {
    const usage = await getAiUsage(env);
    if (usage.remaining <= 0) {
      return json({
        kind: "advice",
        message: assistantFallback("limit"),
        remaining: 0,
        limitReached: true,
        usesAi: false
      }, 200, { "Cache-Control": "no-store" });
    }
    return json({
      kind: "ai-confirmation",
      source: "local-rules",
      usesAi: false,
      message: "Этот запрос не относится к известной безопасной команде. Для ответа потребуется нейросеть. Разрешить ИИ для этого вопроса?",
      remaining: usage.remaining,
      confirmationToken: await signToken({
        kind: "ai-confirmation",
        siteId: LOCK.siteId,
        message: input.message,
        exp: Date.now() + 10 * 60 * 1000
      }, env.SESSION_SECRET)
    }, 200, { "Cache-Control": "no-store" });
  }

  const allowance = await consumeAiAllowance(env);
  if (!allowance.allowed) {
    return json({
      kind: "advice",
      message: assistantFallback("limit"),
      remaining: 0,
      limitReached: true,
      usesAi: false
    }, 200, { "Cache-Control": "no-store" });
  }

  const [monitor, recent, pageText] = await Promise.all([
    env.DB.prepare(
      "SELECT checked_at, ok, http_status, details FROM monitor_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1"
    ).bind(LOCK.siteId).first(),
    env.DB.prepare(
      "SELECT field, old_value, new_value, changed_at FROM change_history WHERE site_id = ? ORDER BY id DESC LIMIT 5"
    ).bind(LOCK.siteId).all(),
    getPageTextForAssistant()
  ]);

  const auditRequest = isAuditRequest(input.message);
  try {
    const { answer } = await requestAiAnswer(env.AI, buildAiMessages({
      ...input,
      config,
      monitor,
      pageText,
      recentChanges: recent.results || []
    }), (candidate) => !auditRequest || adviceIsGrounded(candidate, config, pageText));
    if (answer.type === "advice") {
      return json({
        kind: "advice",
        message: answer.message,
        remaining: allowance.remaining,
        usesAi: true
      }, 200, { "Cache-Control": "no-store" });
    }

    let proposedValue = answer.value;
    if (answer.field === "hours") {
      const schedule = parseWeeklySchedule(proposedValue);
      if (isCompleteSchedule(schedule)) {
        const mode = /по\s+дням|в\s+столбик|по\s+строк/iu.test(input.message)
          ? "expanded"
          : /в\s+одну\s+строк/iu.test(input.message)
            ? "single-line"
            : "grouped";
        proposedValue = formatWeeklySchedule(schedule, mode);
      }
    }
    const after = validateFieldValue(answer.field, proposedValue);
    const before = String(config[answer.field] ?? "");
    if (after === before) {
      return json({
        kind: "advice",
        message: "Это значение уже установлено, поэтому я ничего не предлагаю менять.",
        remaining: allowance.remaining,
        usesAi: true
      }, 200, { "Cache-Control": "no-store" });
    }
    const change = {
      field: answer.field,
      label: FIELD_LABELS[answer.field],
      before,
      after,
      baseVersion: config.version
    };
    const proposal = await createProposal(change, env);
    return json({
      kind: "proposal",
      source: "ai",
      usesAi: true,
      message: answer.message,
      remaining: allowance.remaining,
      ...proposal
    }, 200, { "Cache-Control": "no-store" });
  } catch {
    if (auditRequest) {
      return json({
        kind: "advice",
        source: "grounded-rules",
        message: groundedAuditAdvice(config, pageText),
        remaining: allowance.remaining,
        limitedAnalysis: true,
        usesAi: true
      }, 200, { "Cache-Control": "no-store" });
    }
    return json({
      kind: "advice",
      message: assistantFallback("models"),
      remaining: allowance.remaining,
      diagnosticCode: "AI-02",
      aiUnavailable: true,
      usesAi: true
    }, 200, { "Cache-Control": "no-store" });
  }
}

const COLUMN_BY_FIELD = Object.freeze({
  phone: "phone",
  hours: "hours",
  ctaText: "cta_text",
  ctaLink: "cta_link"
});

async function handleApply(request, env) {
  const body = await requestJson(request);
  const proposal = await verifyToken(body.token, env.SESSION_SECRET, "proposal");
  const config = await getConfig(env);
  if (proposal.field === "enabled") {
    if (typeof proposal.after !== "boolean" || typeof proposal.before !== "boolean") {
      throw new Error("Некорректное состояние показа.");
    }
    if (config.version !== Number(proposal.baseVersion) || config.enabled !== proposal.before) {
      return errorResponse(new Error("Настройки уже изменились. Повторите команду, чтобы увидеть актуальный вариант."), 409);
    }
    const now = new Date().toISOString();
    const nextVersion = config.version + 1;
    const action = proposal.operation === "rollback" ? "rollback" : proposal.after ? "enable" : "disable";
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE site_config SET enabled = ?, version = ?, updated_at = ?, updated_by = 'owner-assistant' WHERE site_id = ? AND version = ?"
      ).bind(proposal.after ? 1 : 0, nextVersion, now, LOCK.siteId, config.version),
      env.DB.prepare(
        "INSERT INTO change_history (site_id, version, action, field, old_value, new_value, changed_at, changed_by) VALUES (?, ?, ?, 'enabled', ?, ?, ?, 'owner')"
      ).bind(LOCK.siteId, nextVersion, action, String(proposal.before), String(proposal.after), now)
    ]);
    return json({ ok: true, config: await getConfig(env) }, 200, { "Cache-Control": "no-store" });
  }
  const column = COLUMN_BY_FIELD[proposal.field];
  if (!column) throw new Error("Это поле нельзя менять.");
  const after = validateFieldValue(proposal.field, proposal.after);
  if (config.version !== Number(proposal.baseVersion) || config[proposal.field] !== proposal.before) {
    return errorResponse(new Error("Настройки уже изменились. Повторите команду, чтобы увидеть актуальный вариант."), 409);
  }
  const now = new Date().toISOString();
  const nextVersion = config.version + 1;
  const action = proposal.operation === "rollback" ? "rollback" : "update";
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE site_config SET ${column} = ?, version = ?, updated_at = ?, updated_by = ? WHERE site_id = ? AND version = ?`
    ).bind(after, nextVersion, now, "owner", LOCK.siteId, config.version),
    env.DB.prepare(
      "INSERT INTO change_history (site_id, version, action, field, old_value, new_value, changed_at, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'owner')"
    ).bind(LOCK.siteId, nextVersion, action, proposal.field, proposal.before, after, now)
  ]);
  return json({ ok: true, config: await getConfig(env) }, 200, { "Cache-Control": "no-store" });
}

async function handleToggle(request, env) {
  const body = await requestJson(request);
  if (typeof body.enabled !== "boolean") throw new Error("Некорректное состояние.");
  const config = await getConfig(env);
  if (config.version !== Number(body.baseVersion)) {
    return errorResponse(new Error("Настройки уже изменились. Обновите страницу и повторите."), 409);
  }
  if (config.enabled === body.enabled) return json({ ok: true, config }, 200, { "Cache-Control": "no-store" });
  const now = new Date().toISOString();
  const nextVersion = config.version + 1;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE site_config SET enabled = ?, version = ?, updated_at = ?, updated_by = 'owner' WHERE site_id = ? AND version = ?"
    ).bind(body.enabled ? 1 : 0, nextVersion, now, LOCK.siteId, config.version),
    env.DB.prepare(
      "INSERT INTO change_history (site_id, version, action, field, old_value, new_value, changed_at, changed_by) VALUES (?, ?, ?, 'enabled', ?, ?, ?, 'owner')"
    ).bind(LOCK.siteId, nextVersion, body.enabled ? "enable" : "disable", String(config.enabled), String(body.enabled), now)
  ]);
  return json({ ok: true, config: await getConfig(env) }, 200, { "Cache-Control": "no-store" });
}

async function handleRollback(request, env) {
  const body = await requestJson(request);
  const historyId = Number(body.historyId);
  if (!Number.isInteger(historyId) || historyId < 1) throw new Error("Некорректная запись истории.");
  const item = await env.DB.prepare(
    "SELECT * FROM change_history WHERE id = ? AND site_id = ?"
  ).bind(historyId, LOCK.siteId).first();
  const column = item && COLUMN_BY_FIELD[item.field];
  if (!item || !column) throw new Error("Эту запись нельзя вернуть.");
  const config = await getConfig(env);
  const before = config[item.field];
  const after = validateFieldValue(item.field, item.old_value);
  if (before === after) throw new Error("Это значение уже установлено.");
  const now = new Date().toISOString();
  const nextVersion = config.version + 1;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE site_config SET ${column} = ?, version = ?, updated_at = ?, updated_by = 'owner-rollback' WHERE site_id = ? AND version = ?`
    ).bind(after, nextVersion, now, LOCK.siteId, config.version),
    env.DB.prepare(
      "INSERT INTO change_history (site_id, version, action, field, old_value, new_value, changed_at, changed_by) VALUES (?, ?, 'rollback', ?, ?, ?, ?, 'owner')"
    ).bind(LOCK.siteId, nextVersion, item.field, before, after, now)
  ]);
  return json({ ok: true, config: await getConfig(env) }, 200, { "Cache-Control": "no-store" });
}

function requireWebhookSecret(env) {
  if (!env.FORM_WEBHOOK_SECRET || env.FORM_WEBHOOK_SECRET.length < 32) {
    const error = new Error("Защита webhook ещё не настроена. Повторно запустите установщик SiteCare.");
    error.status = 503;
    throw error;
  }
  return env.FORM_WEBHOOK_SECRET;
}

async function handleWebhookUrl(request, env) {
  const secret = requireWebhookSecret(env);
  const origin = new URL(request.url).origin;
  const token = await webhookToken(secret, LOCK.siteId);
  return json({
    webhookUrl: `${origin}/api/forms/webhook?token=${encodeURIComponent(token)}`,
    setup: [
      "В Tilda откройте Настройки сайта → Формы → Webhook и добавьте этот HTTPS-адрес.",
      "В блоке формы отметьте WEBHOOK. Оставьте включёнными только те Telegram, почту и CRM, которые принадлежат вам.",
      "Если форма находится в общей шапке или подвале, опубликуйте все страницы сайта; иначе опубликуйте страницу с формой."
    ]
  }, 200, { "Cache-Control": "no-store" });
}

async function handleCreateFormTest(env) {
  const secret = requireWebhookSecret(env);
  const latestMonitor = await env.DB.prepare(
    "SELECT summary_json FROM form_monitor_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1"
  ).bind(LOCK.siteId).first();
  const markerKind = testMarkerKindForForms(parseStoredJson(latestMonitor?.summary_json, []));
  const marker = createTestMarker(markerKind);
  const markerHash = await hashTestMarker(marker, secret);
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + TEST_MARKER_TTL_MINUTES * 60 * 1000).toISOString();
  const id = base64url(crypto.getRandomValues(new Uint8Array(18)));
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE form_test_sessions SET status = 'expired' WHERE site_id = ? AND status = 'pending'"
    ).bind(LOCK.siteId),
    env.DB.prepare(
      "INSERT INTO form_test_sessions (id, site_id, marker_hash, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)"
    ).bind(id, LOCK.siteId, markerHash, createdAt, expiresAt),
    env.DB.prepare(
      "DELETE FROM form_test_sessions WHERE site_id = ? AND id NOT IN (SELECT id FROM form_test_sessions WHERE site_id = ? ORDER BY created_at DESC LIMIT 50)"
    ).bind(LOCK.siteId, LOCK.siteId)
  ]);
  return json({
    marker,
    markerKind,
    expiresAt,
    expiresInMinutes: TEST_MARKER_TTL_MINUTES,
    instruction: markerKind === "phone"
      ? "Введите этот заведомо тестовый номер в поле телефона публичной формы и отправьте её. Не добавляйте настоящий номер: тест также придёт в активные Telegram, почту или CRM."
      : "Вставьте этот код в обычное текстовое поле публичной формы и отправьте её. Не используйте данные реального клиента: тест также придёт в активные Telegram, почту или CRM."
  }, 200, { "Cache-Control": "no-store" });
}

async function handleFormWebhook(request, env) {
  const secret = requireWebhookSecret(env);
  const providedToken = new URL(request.url).searchParams.get("token") || "";
  const expectedToken = await webhookToken(secret, LOCK.siteId);
  if (!(await passwordMatches(providedToken, expectedToken))) {
    const error = new Error("Адрес webhook недействителен.");
    error.status = 401;
    throw error;
  }

  const entries = await parseWebhookRequest(request);
  const [metadata, marker] = await Promise.all([
    submissionMetadata(entries, secret),
    Promise.resolve(testMarkerFromEntries(entries))
  ]);
  const receivedAt = new Date().toISOString();
  let matchedSession = null;
  if (marker) {
    const markerHash = await hashTestMarker(marker, secret);
    const session = await env.DB.prepare(
      "SELECT id, status, expires_at FROM form_test_sessions WHERE site_id = ? AND marker_hash = ? LIMIT 1"
    ).bind(LOCK.siteId, markerHash).first();
    if (session && session.status !== "expired" && session.expires_at > receivedAt) {
      await env.DB.prepare(
        "UPDATE form_test_sessions SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, ?) WHERE id = ? AND site_id = ?"
      ).bind(receivedAt, session.id, LOCK.siteId).run();
      matchedSession = session.id;
    } else if (session?.status === "pending") {
      await env.DB.prepare(
        "UPDATE form_test_sessions SET status = 'expired' WHERE id = ? AND site_id = ?"
      ).bind(session.id, LOCK.siteId).run();
    }
  }

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO form_receipts (site_id, received_at, form_id, field_names_json, field_count, payload_hash, matched_test, test_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      LOCK.siteId,
      receivedAt,
      metadata.formId,
      JSON.stringify(metadata.fieldNames),
      metadata.fieldCount,
      metadata.payloadHash,
      matchedSession ? 1 : 0,
      matchedSession
    ),
    env.DB.prepare(
      "DELETE FROM form_receipts WHERE site_id = ? AND id NOT IN (SELECT id FROM form_receipts WHERE site_id = ? ORDER BY id DESC LIMIT 200)"
    ).bind(LOCK.siteId, LOCK.siteId)
  ]);
  return json({ ok: true }, 200, { "Cache-Control": "no-store" });
}

async function runSiteChecks(env) {
  const [previousPage, previousForm] = await Promise.all([
    env.DB.prepare(
      "SELECT ok FROM monitor_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1"
    ).bind(LOCK.siteId).first(),
    env.DB.prepare(
      "SELECT ok FROM form_monitor_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1"
    ).bind(LOCK.siteId).first()
  ]);
  let pageResult;
  let formsResult;
  try {
    const response = await fetch(LOCK.targetUrl, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "SiteCare-Monitor/2.0" },
      signal: AbortSignal.timeout(8000)
    });
    assertTargetResponse(response);
    const html = await boundedResponseText(response);
    pageResult = monitorResult(response.status, html);
    formsResult = formMonitorResult(response.status, html, "", LOCK.blockIds);
  } catch (error) {
    const message = error instanceof Error ? error.message : "network error";
    pageResult = monitorResult(0, "", message);
    formsResult = formMonitorResult(0, "", message, LOCK.blockIds);
  }
  const checkedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO monitor_runs (site_id, checked_at, ok, http_status, details) VALUES (?, ?, ?, ?, ?)"
    ).bind(LOCK.siteId, checkedAt, pageResult.ok ? 1 : 0, pageResult.httpStatus, pageResult.details),
    env.DB.prepare(
      "DELETE FROM monitor_runs WHERE site_id = ? AND id NOT IN (SELECT id FROM monitor_runs WHERE site_id = ? ORDER BY id DESC LIMIT 200)"
    ).bind(LOCK.siteId, LOCK.siteId),
    env.DB.prepare(
      "INSERT INTO form_monitor_runs (site_id, checked_at, ok, http_status, form_count, ready_count, receiver_count, details, summary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      LOCK.siteId,
      checkedAt,
      formsResult.ok ? 1 : 0,
      formsResult.httpStatus,
      formsResult.formCount,
      formsResult.readyCount,
      formsResult.receiverCount,
      formsResult.details,
      JSON.stringify(formsResult.forms)
    ),
    env.DB.prepare(
      "DELETE FROM form_monitor_runs WHERE site_id = ? AND id NOT IN (SELECT id FROM form_monitor_runs WHERE site_id = ? ORDER BY id DESC LIMIT 200)"
    ).bind(LOCK.siteId, LOCK.siteId)
  ]);

  let notification = null;
  if (previousPage && Boolean(previousPage.ok) !== pageResult.ok) {
    if (pageResult.ok) {
      const formLine = formsResult.ok
        ? "Форма также проходит структурную проверку."
        : `Страница открылась, но форма требует внимания: ${safeNotificationDetails(formsResult.details)}`;
      notification = await sendConfiguredNotification(
        env,
        "page-recovered",
        `✅ SiteCare: страница снова работает\n${LOCK.targetUrl}\n${formLine}`,
        `${LOCK.siteId}:page-recovered:${checkedAt.replace(/[^A-Za-z0-9_-]/gu, "")}`
      );
    } else {
      notification = await sendConfiguredNotification(
        env,
        "page-down",
        `⚠️ SiteCare: страница недоступна или изменилась\n${LOCK.targetUrl}\n${safeNotificationDetails(pageResult.details)}`,
        `${LOCK.siteId}:page-down:${checkedAt.replace(/[^A-Za-z0-9_-]/gu, "")}`
      );
    }
  } else if (
    pageResult.ok &&
    previousPage &&
    Boolean(previousPage.ok) &&
    previousForm &&
    Boolean(previousForm.ok) !== formsResult.ok
  ) {
    const formEventType = formsResult.ok ? "form-recovered" : "form-down";
    notification = await sendConfiguredNotification(
      env,
      formEventType,
      formsResult.ok
        ? `✅ SiteCare: форма снова проходит проверку\n${LOCK.targetUrl}\n${safeNotificationDetails(formsResult.details)}`
        : `⚠️ SiteCare: форма требует внимания\n${LOCK.targetUrl}\n${safeNotificationDetails(formsResult.details)}`,
      `${LOCK.siteId}:${formEventType}:${checkedAt.replace(/[^A-Za-z0-9_-]/gu, "")}`
    );
  }
  return {
    monitor: { ...pageResult, checked_at: checkedAt },
    formMonitor: { ...formsResult, checked_at: checkedAt },
    notification
  };
}

async function runMonitor(env) {
  return (await runSiteChecks(env)).monitor;
}

async function handleRequest(request, env) {
  assertLockedEnvironment(env);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS" && path === "/api/public/config") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(request),
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "If-None-Match",
        "Access-Control-Max-Age": "86400"
      }
    });
  }

  if (request.method === "GET" && path === "/") {
    return Response.redirect(`${url.origin}/admin`, 302);
  }
  if (request.method === "GET" && path === "/admin") {
    return new Response(adminHtml({ sharedBot: Boolean(env.TELEGRAM_GATEWAY_URL || env.TELEGRAM_SITE_TOKEN) }), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
        "Cross-Origin-Opener-Policy": "same-origin"
      }
    });
  }
  if (request.method === "GET" && path === "/api/public/config") return handlePublicConfig(request, env);
  if (request.method === "GET" && path === "/api/health") {
    const config = await getConfig(env);
    return json({ ok: true, siteId: config.siteId, scope: `${config.hostname}${config.pathname}` });
  }
  if (request.method === "POST" && path === "/api/forms/webhook") return handleFormWebhook(request, env);
  if (request.method === "POST" && path === "/api/admin/login") return handleLogin(request, env);
  if (request.method === "POST" && path === "/api/admin/logout") {
    requireSameOrigin(request);
    return json({ ok: true }, 200, {
      "Cache-Control": "no-store",
      "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
    });
  }

  if (path.startsWith("/api/admin/")) {
    await requireSession(request, env);
    if (request.method !== "GET") requireSameOrigin(request);
    if (request.method === "GET" && path === "/api/admin/session") return json({ ok: true }, 200, { "Cache-Control": "no-store" });
    if (request.method === "GET" && path === "/api/admin/state") return handleAdminState(env);
    if (request.method === "POST" && path === "/api/admin/assistant") return handleAssistant(request, env);
    if (request.method === "POST" && path === "/api/admin/propose") return handlePropose(request, env);
    if (request.method === "POST" && path === "/api/admin/apply") return handleApply(request, env);
    if (request.method === "POST" && path === "/api/admin/toggle") return handleToggle(request, env);
    if (request.method === "POST" && path === "/api/admin/rollback") return handleRollback(request, env);
    if (request.method === "POST" && path === "/api/admin/check") return json(await runSiteChecks(env));
    if (request.method === "POST" && path === "/api/admin/forms/check") return json(await runSiteChecks(env));
    if (request.method === "POST" && path === "/api/admin/forms/webhook-url") return handleWebhookUrl(request, env);
    if (request.method === "POST" && path === "/api/admin/forms/test") return handleCreateFormTest(env);
    if (request.method === "POST" && path === "/api/admin/notifications/telegram/start") return handleTelegramStart(request, env);
    if (request.method === "POST" && path === "/api/admin/notifications/telegram/confirm") return handleTelegramConfirm(env);
    if (request.method === "POST" && path === "/api/admin/notifications/telegram/test") return handleTelegramTest(env);
    if (request.method === "POST" && path === "/api/admin/notifications/telegram/disconnect") return handleTelegramDisconnect(env);
  }

  return errorResponse(new Error("Страница не найдена."), 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      const errorMessage = String(error?.message || "");
      const authError = errorMessage.toLocaleLowerCase("ru-RU").includes("подтверждение") || errorMessage.includes("SESSION_SECRET");
      const explicitStatus = Number(error?.status);
      return errorResponse(error, Number.isInteger(explicitStatus) ? explicitStatus : authError ? 401 : 400);
    }
  },
  async scheduled(_controller, env, ctx) {
    assertLockedEnvironment(env);
    ctx.waitUntil(runSiteChecks(env));
  }
};
