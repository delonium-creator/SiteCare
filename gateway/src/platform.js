import {
  createTestMarker,
  hashTestMarker,
  parseWebhookRequest,
  submissionMetadata,
  testMarkerFromEntries,
  testMarkerKindForForms
} from "../../src/forms.js";
import { telegramSendMessage } from "../../src/notifications.js";
import { validateFieldValue } from "../../src/core.js";
import {
  INVITE_HOURS,
  PASSWORD_RESET_MINUTES,
  PLAN_LIMITS,
  PLATFORM_VERSION,
  SESSION_COOKIE_DAYS,
  SESSION_HOURS,
  TRIAL_DAYS,
  clearSessionCookie,
  constantTimeEqual,
  createPasswordRecord,
  dayKey,
  digest,
  integrationUrls,
  loaderJavascript,
  newId,
  nextCheckAt,
  normalizeEmail,
  passwordMatches,
  randomToken,
  readCookie,
  roleAllows,
  safeMessageText,
  safeText,
  sessionCookie,
  siteSlug,
  validateAccountName,
  validateDisplayName,
  validatePassword,
  validatePlan,
  validateRole,
  validateTargetUrl
} from "./platform-core.js";
import {
  emailDeliveryConfigured,
  emailTransport,
  sendEmailSetupTest,
  sendPasswordResetEmail,
  sendSupportReplyEmail,
  sendSupportRequestEmail
} from "./platform-email.js";
import { checkPlatformSite, inspectSite, runDuePlatformChecks, runDueHealthScans, runDueDigests, runDueContentAudits, runDueDomainChecks, runDueMonitorRollups, scanSiteInventory, siteReport } from "./platform-monitor.js";
import { prepareSiteChange, phoneValueQuestion } from "./platform-assistant.js";
import { encryptProtectedJson, leadRowToPublic, normalizeLeadSubmission } from "./platform-leads.js";
import {
  appendConversationMessage,
  cancelSupportRequest,
  conversationSnapshot,
  ensureConversation,
  forwardClientMessageToSupport,
  modelHistory,
  openSupportRequest,
  requestSupport,
  supportQueue,
  supportRequestDetails,
  updateSupportRequest
} from "./platform-support.js";
import { inviteHtml, platformHtml, resetPasswordHtml } from "./platform-ui.js";

const encoder = new TextEncoder();
const MAX_JSON_BODY_BYTES = 32 * 1024;
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{20,256}$/u;
const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,79}$/u;
const PASSWORD_RESET_WINDOW_MINUTES = 15;
const PASSWORD_RESET_ACCEPTED = "Если аккаунт найден, инструкция уже отправлена или запрос передан в поддержку SiteCare.";
const FEATURE_KEYS = new Set(["control", "reviews"]);
const ACCESS_STATUSES = new Set(["trial_pending", "trial", "active", "past_due", "complimentary", "paused", "canceled"]);
const LEAD_STATUSES = new Set(["new", "in_progress", "completed", "spam"]);

function securityHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "X-Frame-Options": "DENY",
    ...extra
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8", ...extra })
  });
}

function html(body, nonce, status = 200) {
  return new Response(body, {
    status,
    headers: securityHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
    })
  });
}

function javascript(body) {
  return new Response(body, {
    headers: securityHeaders({
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-cache, must-revalidate",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin"
    })
  });
}

function fail(message, status = 400, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

async function enforceActionLimit(env, bucketKey, maximum, windowSeconds) {
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSeconds * 1000)) * windowSeconds;
  const updatedAt = new Date(now).toISOString();
  await env.GATEWAY_DB.prepare(
    "INSERT INTO platform_action_limits (bucket_key, window_start, request_count, updated_at) VALUES (?, ?, 1, ?) " +
    "ON CONFLICT(bucket_key, window_start) DO UPDATE SET request_count = request_count + 1, updated_at = excluded.updated_at"
  ).bind(bucketKey, windowStart, updatedAt).run();
  const row = await env.GATEWAY_DB.prepare(
    "SELECT request_count FROM platform_action_limits WHERE bucket_key = ? AND window_start = ?"
  ).bind(bucketKey, windowStart).first();
  if (Number(row?.request_count || 0) > maximum) {
    fail("Слишком много сообщений подряд. Подождите несколько минут и попробуйте снова.", 429, "RATE_LIMITED");
  }
}

async function requestJson(request) {
  if (!(request.headers.get("Content-Type") || "").toLocaleLowerCase("en-US").includes("application/json")) {
    fail("Ожидался JSON-запрос.", 415, "UNSUPPORTED_MEDIA_TYPE");
  }
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) fail("Запрос слишком большой.", 413, "PAYLOAD_TOO_LARGE");
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > MAX_JSON_BODY_BYTES) fail("Запрос слишком большой.", 413, "PAYLOAD_TOO_LARGE");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("Некорректный JSON-запрос.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Некорректный запрос.");
  return value;
}

function sameOrigin(request) {
  const expected = new URL(request.url).origin;
  const origin = request.headers.get("Origin");
  if (origin && origin !== expected) fail("Источник запроса не прошёл проверку.", 403, "ORIGIN_REJECTED");
}

function bearer(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/u.exec(request.headers.get("Authorization") || "");
  return match?.[1] || "";
}

function requireGatewayAdmin(request, env) {
  if (!bearer(request) || !constantTimeEqual(bearer(request), env.GATEWAY_ADMIN_TOKEN)) {
    fail("Доступ запрещён.", 401, "UNAUTHORIZED");
  }
}

async function sessionUser(request, env, { csrf = false } = {}) {
  const token = readCookie(request);
  if (!OPAQUE_PATTERN.test(token)) fail("Войдите в SiteCare.", 401, "UNAUTHORIZED");
  const tokenHash = await digest("platform-session", token);
  const now = new Date().toISOString();
  const row = await env.GATEWAY_DB.prepare(
    "SELECT s.token_hash, s.csrf_token, s.created_at, s.expires_at, s.last_seen_at, u.user_id, u.email, u.display_name, u.platform_role, u.status " +
    "FROM platform_sessions s JOIN platform_users u ON u.user_id = s.user_id WHERE s.token_hash = ?"
  ).bind(tokenHash).first();
  if (!row || row.expires_at <= now || row.status !== "active") fail("Сессия закончилась. Войдите снова.", 401, "UNAUTHORIZED");
  if (csrf) {
    sameOrigin(request);
    const provided = request.headers.get("X-SiteCare-CSRF") || "";
    if (!provided || !constantTimeEqual(provided, row.csrf_token)) fail("Защита запроса не прошла проверку.", 403, "CSRF_REJECTED");
  }
  if (Date.now() - Date.parse(row.last_seen_at || 0) >= 5 * 60 * 1000) {
    const remembered = Date.parse(row.expires_at) - Date.parse(row.created_at) > 24 * 60 * 60 * 1000;
    const lifetimeHours = remembered ? SESSION_COOKIE_DAYS * 24 : SESSION_HOURS;
    const extended = new Date(Date.now() + lifetimeHours * 60 * 60 * 1000).toISOString();
    await env.GATEWAY_DB.prepare("UPDATE platform_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?")
      .bind(now, extended, tokenHash).run();
    row.expires_at = extended;
  }
  return row;
}

function billingAllowsChanges(account) {
  const status = account.billing_status || (account.plan === "trial" ? "trial" : "active");
  if (status === "trial_pending" || status === "active" || status === "complimentary") return true;
  if (status === "trial") {
    const end = account.current_period_end || account.trial_ends_at;
    return !end || end > new Date().toISOString();
  }
  return false;
}

function featureAllowsChanges(feature, fallbackAccount = null) {
  if (!feature) return fallbackAccount ? billingAllowsChanges(fallbackAccount) : false;
  const status = feature.status;
  if (status === "trial_pending" || status === "active" || status === "complimentary") return true;
  if (status === "trial") return !feature.current_period_end || feature.current_period_end > new Date().toISOString();
  return false;
}

async function featureRow(env, accountId, featureKey) {
  if (!FEATURE_KEYS.has(featureKey)) fail("Неизвестный модуль SiteCare.");
  return env.GATEWAY_DB.prepare(
    "SELECT feature_key, status, source_product_key, trial_started_at, current_period_end, provider, provider_subscription_id, checkout_url, updated_at FROM platform_account_features WHERE account_id = ? AND feature_key = ?"
  ).bind(accountId, featureKey).first();
}

async function requireFeature(env, user, account, featureKey) {
  if (user.platform_role === "operator") return null;
  const row = await featureRow(env, account.account_id, featureKey);
  const fallback = featureKey === "control" ? account : null;
  if (!featureAllowsChanges(row, fallback)) {
    const label = featureKey === "reviews" ? "Отзывы" : "Контроль сайта";
    fail(`Модуль «${label}» не подключён или срок доступа закончился.`, 409, "PAYMENT_REQUIRED");
  }
  return row;
}

function effectiveSiteLimit(account) {
  if (account.extra_site_slots !== undefined && account.extra_site_slots !== null) {
    return 1 + Math.max(0, Number(account.extra_site_slots) || 0);
  }
  return PLAN_LIMITS[validatePlan(account.plan)].sites;
}

function accountSelectSql(where) {
  return "SELECT a.*, b.status AS billing_status, b.trial_started_at, b.current_period_end, " +
    "b.extra_site_slots, b.provider AS billing_provider, b.checkout_url " +
    "FROM platform_accounts a LEFT JOIN platform_billing b ON b.account_id = a.account_id " + where;
}

async function accountAccess(env, user, accountId, required = "viewer") {
  const id = String(accountId || "");
  if (!/^acc_[a-z0-9_-]{4,80}$/u.test(id)) fail("Некорректный клиент.");
  if (user.platform_role === "operator") {
    const account = await env.GATEWAY_DB.prepare(accountSelectSql("WHERE a.account_id = ?")).bind(id).first();
    if (!account) fail("Клиент не найден.", 404, "NOT_FOUND");
    return { ...account, role: "owner" };
  }
  const row = await env.GATEWAY_DB.prepare(
    "SELECT a.*, m.role, b.status AS billing_status, b.trial_started_at, b.current_period_end, " +
    "b.extra_site_slots, b.provider AS billing_provider, b.checkout_url " +
    "FROM platform_accounts a JOIN platform_memberships m ON m.account_id = a.account_id " +
    "LEFT JOIN platform_billing b ON b.account_id = a.account_id WHERE a.account_id = ? AND m.user_id = ?"
  ).bind(id, user.user_id).first();
  if (!row) fail("Доступ к этому клиенту запрещён.", 403, "FORBIDDEN");
  if (!roleAllows(row.role, required)) fail("Для этого действия недостаточно прав.", 403, "FORBIDDEN");
  if (row.status !== "active" && required !== "viewer") fail("Кабинет клиента приостановлен.", 409, "ACCOUNT_SUSPENDED");
  return row;
}

async function siteAccess(env, user, siteId, required = "viewer") {
  if (!SITE_ID_PATTERN.test(String(siteId || ""))) fail("Некорректный сайт.");
  const site = await env.GATEWAY_DB.prepare("SELECT * FROM platform_sites WHERE site_id = ?").bind(siteId).first();
  if (!site) fail("Сайт не найден.", 404, "NOT_FOUND");
  const account = await accountAccess(env, user, site.account_id, required);
  if (required !== "viewer") await requireFeature(env, user, account, "control");
  return { site, account };
}

async function audit(env, user, accountId, action, targetType, targetId, details = "") {
  await env.GATEWAY_DB.prepare(
    "INSERT INTO platform_audit_log (account_id, user_id, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(accountId || null, user?.user_id || null, safeText(action, 80), safeText(targetType, 50), targetId || null, safeText(details, 220), new Date().toISOString()).run();
}

async function createSession(env, userId, { remember = false } = {}) {
  const token = randomToken(32);
  const tokenHash = await digest("platform-session", token);
  const csrfToken = randomToken(24);
  const now = new Date();
  const lifetimeHours = remember ? SESSION_COOKIE_DAYS * 24 : SESSION_HOURS;
  const expiresAt = new Date(now.getTime() + lifetimeHours * 60 * 60 * 1000).toISOString();
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_sessions (token_hash, user_id, csrf_token, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(tokenHash, userId, csrfToken, now.toISOString(), expiresAt, now.toISOString()),
    env.GATEWAY_DB.prepare("DELETE FROM platform_sessions WHERE expires_at < ?").bind(now.toISOString())
  ]);
  return { token, csrfToken, expiresAt };
}

async function platformStatus(env) {
  const row = await env.GATEWAY_DB.prepare(
    "SELECT COUNT(*) AS users, MIN(email) AS operator_email FROM platform_users WHERE platform_role = 'operator' AND status = 'active'"
  ).first();
  return {
    ok: true,
    configured: Number(row?.users || 0) > 0,
    operatorEmail: row?.operator_email || null,
    passwordEmail: { enabled: emailDeliveryConfigured(env), transport: emailTransport(env) || null },
    version: PLATFORM_VERSION
  };
}

async function bootstrapPlatform(request, env) {
  requireGatewayAdmin(request, env);
  const existing = await platformStatus(env);
  if (existing.configured) return json({ ...existing, created: false });
  const body = await requestJson(request);
  const email = normalizeEmail(body.email);
  const displayName = validateDisplayName(body.displayName || "Владелец SiteCare");
  const password = validatePassword(body.password);
  const passwordRecord = await createPasswordRecord(password);
  const now = new Date().toISOString();
  const userId = newId("usr", displayName);
  const accountId = newId("acc", "sitecare");
  const legacyRows = await env.GATEWAY_DB.prepare("SELECT site_id, site_name, target_url, created_at, updated_at FROM gateway_sites ORDER BY created_at").all();
  const statements = [
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_users (user_id, email, display_name, password_salt, password_hash, password_iterations, platform_role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'operator', 'active', ?, ?)"
    ).bind(userId, email, displayName, passwordRecord.salt, passwordRecord.hash, passwordRecord.iterations, now, now),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_accounts (account_id, name, plan, status, trial_ends_at, created_at, updated_at) VALUES (?, 'SiteCare', 'business', 'active', NULL, ?, ?)"
    ).bind(accountId, now, now),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_billing (account_id, status, trial_started_at, current_period_end, extra_site_slots, provider, checkout_url, updated_at) VALUES (?, 'complimentary', NULL, NULL, 99, 'manual', '', ?)"
    ).bind(accountId, now),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_account_features (account_id, feature_key, status, source_product_key, trial_started_at, current_period_end, provider, provider_subscription_id, checkout_url, updated_at) VALUES (?, 'control', 'complimentary', 'manual', NULL, NULL, 'manual', '', '', ?)"
    ).bind(accountId, now),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_account_features (account_id, feature_key, status, source_product_key, trial_started_at, current_period_end, provider, provider_subscription_id, checkout_url, updated_at) VALUES (?, 'reviews', 'complimentary', 'manual', NULL, NULL, 'manual', '', '', ?)"
    ).bind(accountId, now),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_memberships (account_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?)"
    ).bind(accountId, userId, now, now)
  ];
  for (const legacy of legacyRows?.results || []) {
    const target = new URL(validateTargetUrl(legacy.target_url));
    statements.push(env.GATEWAY_DB.prepare(
      "INSERT OR IGNORE INTO platform_sites (site_id, account_id, name, target_url, target_origin, target_pathname, scope, status, integration_mode, form_required, expected_form_count, webhook_token_hash, loader_key, monitor_interval_minutes, last_monitor_at, next_monitor_at, domain_ok, tls_ok, page_ok, form_ok, last_http_status, last_latency_ms, last_error, last_form_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'site', 'active', 'legacy', 0, 0, NULL, ?, 30, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)"
    ).bind(legacy.site_id, accountId, legacy.site_name, target.href, target.origin, target.pathname, randomToken(24), legacy.created_at || now, legacy.updated_at || now));
    statements.push(env.GATEWAY_DB.prepare(
      "INSERT OR IGNORE INTO platform_site_overrides (site_id, enabled, phone, schedule_text, button_text, button_url, version, updated_at) VALUES (?, 0, '', '', '', '', 1, ?)"
    ).bind(legacy.site_id, now));
    statements.push(env.GATEWAY_DB.prepare(
      "INSERT OR IGNORE INTO platform_override_history (site_id, version, enabled, phone, schedule_text, button_text, button_url, created_by, created_at) VALUES (?, 1, 0, '', '', '', '', ?, ?)"
    ).bind(legacy.site_id, userId, now));
  }
  await env.GATEWAY_DB.batch(statements);
  await audit(env, { user_id: userId }, accountId, "platform.bootstrap", "platform", null, "Создан центральный кабинет и импортированы пилотные сайты.");
  return json({ ok: true, configured: true, created: true, version: PLATFORM_VERSION });
}

async function login(request, env) {
  sameOrigin(request);
  const body = await requestJson(request);
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  const remember = body.remember === true;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const identityHash = await digest("platform-login", `${email}:${ip}`);
  const now = new Date();
  const attempt = await env.GATEWAY_DB.prepare("SELECT * FROM platform_auth_attempts WHERE identity_hash = ?").bind(identityHash).first();
  if (attempt?.blocked_until && attempt.blocked_until > now.toISOString()) fail("Слишком много попыток. Повторите вход через 15 минут.", 429, "RATE_LIMITED");
  const user = await env.GATEWAY_DB.prepare("SELECT * FROM platform_users WHERE email = ? AND status = 'active'").bind(email).first();
  const valid = user ? await passwordMatches(password, user) : false;
  if (!valid) {
    const windowStart = attempt?.window_started_at && Date.parse(attempt.window_started_at) > now.getTime() - 15 * 60 * 1000
      ? attempt.window_started_at
      : now.toISOString();
    const failures = windowStart === attempt?.window_started_at ? Number(attempt?.failures || 0) + 1 : 1;
    const blockedUntil = failures >= 5 ? new Date(now.getTime() + 15 * 60 * 1000).toISOString() : null;
    await env.GATEWAY_DB.prepare(
      "INSERT INTO platform_auth_attempts (identity_hash, failures, window_started_at, blocked_until, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(identity_hash) DO UPDATE SET failures = excluded.failures, window_started_at = excluded.window_started_at, blocked_until = excluded.blocked_until, updated_at = excluded.updated_at"
    ).bind(identityHash, failures, windowStart, blockedUntil, now.toISOString()).run();
    fail("Неверная почта или пароль.", 401, "UNAUTHORIZED");
  }
  await env.GATEWAY_DB.prepare("DELETE FROM platform_auth_attempts WHERE identity_hash = ?").bind(identityHash).run();
  const session = await createSession(env, user.user_id, { remember });
  await audit(env, user, null, "auth.login", "user", user.user_id, "Успешный вход.");
  const cookieSeconds = remember ? SESSION_COOKIE_DAYS * 24 * 60 * 60 : null;
  return json({ ok: true, csrf: session.csrfToken, expiresAt: session.expiresAt }, 200, { "Set-Cookie": sessionCookie(session.token, cookieSeconds) });
}

async function consumePasswordResetLimit(env, keyHash, maximum) {
  const now = new Date();
  const nowIso = now.toISOString();
  const windowFloor = now.getTime() - PASSWORD_RESET_WINDOW_MINUTES * 60 * 1000;
  const row = await env.GATEWAY_DB.prepare(
    "SELECT requests, window_started_at, blocked_until FROM platform_password_reset_limits WHERE key_hash = ?"
  ).bind(keyHash).first();
  if (row?.blocked_until && row.blocked_until > nowIso) {
    fail("Слишком много запросов. Повторите через 15 минут.", 429, "RATE_LIMITED");
  }
  const sameWindow = Boolean(row?.window_started_at && Date.parse(row.window_started_at) > windowFloor);
  const windowStartedAt = sameWindow ? row.window_started_at : nowIso;
  const requests = sameWindow ? Number(row?.requests || 0) + 1 : 1;
  const blockedUntil = requests > maximum
    ? new Date(now.getTime() + PASSWORD_RESET_WINDOW_MINUTES * 60 * 1000).toISOString()
    : null;
  await env.GATEWAY_DB.prepare(
    "INSERT INTO platform_password_reset_limits (key_hash, requests, window_started_at, blocked_until, updated_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(key_hash) DO UPDATE SET requests = excluded.requests, window_started_at = excluded.window_started_at, blocked_until = excluded.blocked_until, updated_at = excluded.updated_at"
  ).bind(keyHash, requests, windowStartedAt, blockedUntil, nowIso).run();
  if (blockedUntil) fail("Слишком много запросов. Повторите через 15 минут.", 429, "RATE_LIMITED");
}

async function passwordResetStatus(env) {
  return json({
    ok: true,
    enabled: true,
    emailEnabled: emailDeliveryConfigured(env),
    mode: emailDeliveryConfigured(env) ? "email" : "operator",
    expiresInMinutes: PASSWORD_RESET_MINUTES
  });
}

async function testPasswordEmail(request, env) {
  requireGatewayAdmin(request, env);
  if (!emailDeliveryConfigured(env)) fail("Доставка писем не настроена.", 503, "EMAIL_NOT_CONFIGURED");
  const owner = await env.GATEWAY_DB.prepare(
    "SELECT email FROM platform_users WHERE platform_role = 'operator' AND status = 'active' ORDER BY created_at LIMIT 1"
  ).first();
  if (!owner?.email) fail("Активный владелец SiteCare не найден.", 409, "OWNER_NOT_FOUND");
  try {
    const delivery = await sendEmailSetupTest(env, {
      to: owner.email,
      requestId: await digest("platform-email-test", `${owner.email}:${new Date().toISOString()}`)
    });
    return json({ ok: true, deliveredTo: owner.email, transport: delivery.transport });
  } catch (error) {
    console.error("SiteCare email setup test failed:", safeText(error?.code || error?.message || "unknown", 120));
    fail("Почтовый сервис не принял тестовое письмо. Проверьте ключ и адрес отправителя.", 502, "EMAIL_DELIVERY_FAILED");
  }
}

async function requestPasswordReset(request, env) {
  sameOrigin(request);
  const body = await requestJson(request);
  const email = normalizeEmail(body.email);
  const ip = safeText(request.headers.get("CF-Connecting-IP") || "unknown", 80);
  const identityLimit = await digest("platform-password-reset-limit", `identity:${email}:${ip}`);
  const ipLimit = await digest("platform-password-reset-limit", `ip:${ip}`);
  await consumePasswordResetLimit(env, identityLimit, 3);
  await consumePasswordResetLimit(env, ipLimit, 12);

  const user = await env.GATEWAY_DB.prepare(
    "SELECT u.user_id, u.email, u.display_name, u.status, (SELECT account_id FROM platform_memberships WHERE user_id = u.user_id ORDER BY created_at LIMIT 1) AS account_id FROM platform_users u WHERE u.email = ? AND u.status = 'active'"
  ).bind(email).first();
  if (!user) return json({ ok: true, message: PASSWORD_RESET_ACCEPTED }, 202);

  const now = new Date();
  const nowIso = now.toISOString();
  const requestId = newId("access", user.user_id);
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare(
      "UPDATE platform_access_requests SET status = 'resolved', resolved_at = ? WHERE user_id = ? AND status = 'pending'"
    ).bind(nowIso, user.user_id),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_access_requests (request_id, user_id, account_id, status, requested_at, resolved_at, resolved_by) VALUES (?, ?, ?, 'pending', ?, NULL, NULL)"
    ).bind(requestId, user.user_id, user.account_id || null, nowIso),
    env.GATEWAY_DB.prepare(
      "DELETE FROM platform_password_resets WHERE expires_at < ? OR used_at IS NOT NULL AND used_at < ?"
    ).bind(nowIso, new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()),
    env.GATEWAY_DB.prepare(
      "DELETE FROM platform_password_reset_limits WHERE updated_at < ?"
    ).bind(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString())
  ]);

  if (emailDeliveryConfigured(env)) {
    const reset = await createPasswordResetToken(env, user.user_id);
    try {
      await sendPasswordResetEmail(env, {
        to: user.email,
        resetUrl: `${new URL(request.url).origin}/reset-password?token=${encodeURIComponent(reset.token)}`,
        expiresInMinutes: PASSWORD_RESET_MINUTES,
        requestId: reset.tokenHash
      });
    } catch (error) {
      await env.GATEWAY_DB.prepare("DELETE FROM platform_password_resets WHERE token_hash = ?").bind(reset.tokenHash).run();
      console.error("SiteCare password reset delivery failed:", safeText(error?.code || error?.message || "unknown", 120));
    }
  }
  return json({ ok: true, message: PASSWORD_RESET_ACCEPTED }, 202);
}

async function createPasswordResetToken(env, userId) {
  const token = randomToken(32);
  const tokenHash = await digest("platform-password-reset", token);
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_MINUTES * 60 * 1000).toISOString();
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare("DELETE FROM platform_password_resets WHERE user_id = ? AND used_at IS NULL").bind(userId),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_password_resets (token_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)"
    ).bind(tokenHash, userId, nowIso, expiresAt)
  ]);
  return { token, tokenHash, expiresAt };
}

async function closedRegistration(request) {
  sameOrigin(request);
  fail("Новые кабинеты создаёт поддержка SiteCare. Попросите одноразовую ссылку доступа.", 403, "REGISTRATION_CLOSED");
}

async function resetPassword(request, env) {
  sameOrigin(request);
  const body = await requestJson(request);
  const token = String(body.token || "");
  if (!OPAQUE_PATTERN.test(token)) fail("Ссылка недействительна или уже использована.", 400, "RESET_TOKEN_INVALID");
  const password = validatePassword(body.password);
  const tokenHash = await digest("platform-password-reset", token);
  const now = new Date();
  const nowIso = now.toISOString();
  const reset = await env.GATEWAY_DB.prepare(
    "SELECT r.user_id, u.email, u.display_name, u.status FROM platform_password_resets r " +
    "JOIN platform_users u ON u.user_id = r.user_id WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ? AND u.status = 'active'"
  ).bind(tokenHash, nowIso).first();
  if (!reset) fail("Ссылка недействительна или уже использована.", 400, "RESET_TOKEN_INVALID");

  const record = await createPasswordRecord(password);
  const claimed = await env.GATEWAY_DB.prepare(
    "UPDATE platform_password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id"
  ).bind(nowIso, tokenHash, nowIso).first();
  if (!claimed || claimed.user_id !== reset.user_id) {
    fail("Ссылка недействительна или уже использована.", 400, "RESET_TOKEN_INVALID");
  }
  const ip = safeText(request.headers.get("CF-Connecting-IP") || "unknown", 80);
  const loginIdentity = await digest("platform-login", `${reset.email}:${ip}`);
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare(
      "UPDATE platform_users SET password_salt = ?, password_hash = ?, password_iterations = ?, updated_at = ? WHERE user_id = ?"
    ).bind(record.salt, record.hash, record.iterations, nowIso, reset.user_id),
    env.GATEWAY_DB.prepare("DELETE FROM platform_sessions WHERE user_id = ?").bind(reset.user_id),
    env.GATEWAY_DB.prepare("DELETE FROM platform_auth_attempts WHERE identity_hash = ?").bind(loginIdentity),
    env.GATEWAY_DB.prepare("DELETE FROM platform_password_resets WHERE user_id = ? AND token_hash <> ?").bind(reset.user_id, tokenHash)
  ]);
  await audit(env, reset, null, "auth.password.reset", "user", reset.user_id, "Пароль восстановлен по одноразовой ссылке; все сессии завершены.");
  return json({ ok: true, loginRequired: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

async function logout(request, env) {
  const user = await sessionUser(request, env, { csrf: true });
  const tokenHash = await digest("platform-session", readCookie(request));
  await env.GATEWAY_DB.prepare("DELETE FROM platform_sessions WHERE token_hash = ?").bind(tokenHash).run();
  await audit(env, user, null, "auth.logout", "user", user.user_id);
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

async function changePassword(request, env, user) {
  const body = await requestJson(request);
  const fullUser = await env.GATEWAY_DB.prepare("SELECT * FROM platform_users WHERE user_id = ?").bind(user.user_id).first();
  if (!fullUser || !(await passwordMatches(String(body.currentPassword || ""), fullUser))) {
    fail("Текущий пароль указан неверно.", 401, "UNAUTHORIZED");
  }
  const nextPassword = validatePassword(body.newPassword);
  if (constantTimeEqual(String(body.currentPassword || ""), nextPassword)) fail("Новый пароль должен отличаться от текущего.");
  const record = await createPasswordRecord(nextPassword);
  const now = new Date().toISOString();
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare("UPDATE platform_users SET password_salt = ?, password_hash = ?, password_iterations = ?, updated_at = ? WHERE user_id = ?")
      .bind(record.salt, record.hash, record.iterations, now, user.user_id),
    env.GATEWAY_DB.prepare("DELETE FROM platform_sessions WHERE user_id = ?").bind(user.user_id)
  ]);
  await audit(env, user, null, "auth.password", "user", user.user_id, "Пароль изменён, все сессии завершены.");
  return json({ ok: true, loginRequired: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

async function createInvite(env, requestOrigin, account, invitedBy, emailValue, roleValue) {
  const email = normalizeEmail(emailValue);
  const role = validateRole(roleValue, { ownerAllowed: Boolean(invitedBy.platform_role === "operator") });
  const limits = PLAN_LIMITS[validatePlan(account.plan)];
  const counts = await env.GATEWAY_DB.prepare(
    "SELECT (SELECT COUNT(*) FROM platform_memberships WHERE account_id = ?) + (SELECT COUNT(*) FROM platform_invites WHERE account_id = ? AND accepted_at IS NULL AND expires_at > ?) AS total"
  ).bind(account.account_id, account.account_id, new Date().toISOString()).first();
  if (Number(counts?.total || 0) >= limits.users) fail(`В кабинете доступно не более ${limits.users} пользователей.`, 409, "PLAN_LIMIT");
  const token = randomToken(32);
  const tokenHash = await digest("platform-invite", token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_HOURS * 60 * 60 * 1000).toISOString();
  await env.GATEWAY_DB.prepare(
    "INSERT INTO platform_invites (token_hash, account_id, email, role, invited_by, created_at, expires_at, accepted_at, accepted_by) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)"
  ).bind(tokenHash, account.account_id, email, role, invitedBy.user_id, now.toISOString(), expiresAt).run();
  return { token, inviteUrl: `${requestOrigin}/accept?token=${encodeURIComponent(token)}`, expiresAt, email, role };
}

async function acceptInvite(request, env) {
  sameOrigin(request);
  const body = await requestJson(request);
  const token = String(body.token || "");
  if (!OPAQUE_PATTERN.test(token)) fail("Приглашение недействительно или истекло.", 410, "INVITE_EXPIRED");
  const tokenHash = await digest("platform-invite", token);
  const invite = await env.GATEWAY_DB.prepare("SELECT * FROM platform_invites WHERE token_hash = ?").bind(tokenHash).first();
  const now = new Date().toISOString();
  if (!invite || invite.accepted_at || invite.expires_at <= now) fail("Приглашение недействительно или истекло.", 410, "INVITE_EXPIRED");
  const email = normalizeEmail(body.email);
  if (!constantTimeEqual(email, invite.email)) fail("Это приглашение создано для другой электронной почты.", 403, "INVITE_EMAIL_MISMATCH");
  const displayName = validateDisplayName(body.displayName);
  const existing = await env.GATEWAY_DB.prepare("SELECT * FROM platform_users WHERE email = ?").bind(email).first();
  let userId;
  const statements = [];
  if (existing) {
    if (!(await passwordMatches(String(body.password || ""), existing))) fail("Для существующего аккаунта указан неверный пароль.", 401, "UNAUTHORIZED");
    userId = existing.user_id;
  } else {
    const record = await createPasswordRecord(body.password);
    userId = newId("usr", displayName);
    statements.push(env.GATEWAY_DB.prepare(
      "INSERT INTO platform_users (user_id, email, display_name, password_salt, password_hash, password_iterations, platform_role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'user', 'active', ?, ?)"
    ).bind(userId, email, displayName, record.salt, record.hash, record.iterations, now, now));
  }
  statements.push(env.GATEWAY_DB.prepare(
    "INSERT INTO platform_memberships (account_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at"
  ).bind(invite.account_id, userId, invite.role, now, now));
  statements.push(env.GATEWAY_DB.prepare(
    "UPDATE platform_invites SET accepted_at = ?, accepted_by = ? WHERE token_hash = ? AND accepted_at IS NULL"
  ).bind(now, userId, tokenHash));
  await env.GATEWAY_DB.batch(statements);
  const session = await createSession(env, userId);
  await audit(env, { user_id: userId }, invite.account_id, "invite.accept", "user", userId, `Роль: ${invite.role}`);
  return json({ ok: true, csrf: session.csrfToken }, 200, { "Set-Cookie": sessionCookie(session.token) });
}

async function accountDetails(env, account, role, platformRole = "user", { includeSensitive = true } = {}) {
  const limits = PLAN_LIMITS[validatePlan(account.plan)];
  const today = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
  const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [sitesResult, membersResult, incidentsResult, usage, counts, receiptsResult, activityResult, notesResult, billingEventsResult, featureResult, leadsResult, invitesResult, accessRequestsResult] = await Promise.all([
    env.GATEWAY_DB.prepare(
      "SELECT s.*, COALESCE(d.enabled, 0) AS telegram_enabled, rs.yandex_widget_url, rs.dgis_widget_url, ld.summary_text AS digest_summary, ld.created_at AS digest_created_at " +
      "FROM platform_sites s " +
      "LEFT JOIN telegram_destinations d ON d.site_id = s.site_id " +
      "LEFT JOIN platform_review_sources rs ON rs.site_id = s.site_id " +
      "LEFT JOIN (SELECT site_id, summary_text, created_at FROM platform_digests d1 WHERE created_at = (SELECT MAX(created_at) FROM platform_digests d2 WHERE d2.site_id = d1.site_id)) ld ON ld.site_id = s.site_id " +
      "WHERE s.account_id = ? AND s.status != 'archived' ORDER BY s.created_at"
    ).bind(account.account_id).all(),
    env.GATEWAY_DB.prepare(
      "SELECT u.user_id, u.email, u.display_name, u.status, m.role FROM platform_memberships m JOIN platform_users u ON u.user_id = m.user_id WHERE m.account_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'manager' THEN 3 ELSE 4 END, u.display_name"
    ).bind(account.account_id).all(),
    env.GATEWAY_DB.prepare(
      "SELECT i.*, s.name AS site_name FROM platform_incidents i JOIN platform_sites s ON s.site_id = i.site_id WHERE s.account_id = ? AND i.opened_at >= ? ORDER BY CASE i.status WHEN 'open' THEN 0 ELSE 1 END, i.opened_at DESC LIMIT 100"
    ).bind(account.account_id, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()).all(),
    env.GATEWAY_DB.prepare("SELECT * FROM platform_usage_daily WHERE account_id = ? AND usage_day = ?").bind(account.account_id, dayKey()).first(),
    env.GATEWAY_DB.prepare(
      "SELECT (SELECT COUNT(*) FROM platform_sites WHERE account_id = ? AND status != 'archived') AS sites, " +
      "(SELECT COUNT(*) FROM platform_memberships WHERE account_id = ?) AS users, " +
      "(SELECT COUNT(*) FROM platform_incidents i JOIN platform_sites s ON s.site_id = i.site_id WHERE s.account_id = ? AND i.status = 'open') AS open_incidents, " +
      "(SELECT COUNT(*) FROM platform_sites WHERE account_id = ? AND status = 'active' AND page_ok = 1 AND loader_ok = 1 AND (form_required = 0 OR (form_ok = 1 AND webhook_verified_at IS NOT NULL AND form_verified_at IS NOT NULL))) AS healthy, " +
      "(SELECT COUNT(*) FROM platform_leads WHERE account_id = ? AND received_at >= ?) AS leads_today, " +
      "(SELECT COUNT(*) FROM platform_leads WHERE account_id = ? AND received_at >= ?) AS leads_week, " +
      "(SELECT MAX(received_at) FROM platform_leads WHERE account_id = ?) AS last_form_at, " +
      "(SELECT COUNT(*) FROM platform_leads WHERE account_id = ?) AS leads_total"
    ).bind(account.account_id, account.account_id, account.account_id, account.account_id, account.account_id, today, account.account_id, week, account.account_id, account.account_id).first(),
    includeSensitive
      ? env.GATEWAY_DB.prepare(
        "SELECT r.id, r.received_at, r.form_id, r.field_names_json, r.field_count, s.site_id, s.name AS site_name FROM platform_form_receipts r JOIN platform_sites s ON s.site_id = r.site_id WHERE s.account_id = ? ORDER BY r.received_at DESC LIMIT 50"
      ).bind(account.account_id).all()
      : Promise.resolve({ results: [] }),
    env.GATEWAY_DB.prepare(
      "SELECT action, target_type, target_id, details, created_at FROM platform_audit_log WHERE account_id = ? ORDER BY created_at DESC LIMIT 30"
    ).bind(account.account_id).all(),
    platformRole === "operator" && includeSensitive
      ? env.GATEWAY_DB.prepare(
        "SELECT n.id, n.note, n.created_at, u.display_name AS author_name FROM platform_support_notes n JOIN platform_users u ON u.user_id = n.author_user_id WHERE n.account_id = ? ORDER BY n.created_at DESC LIMIT 30"
      ).bind(account.account_id).all()
      : Promise.resolve({ results: [] }),
    env.GATEWAY_DB.prepare(
      "SELECT id, kind, summary, created_at FROM platform_billing_events WHERE account_id = ? ORDER BY created_at DESC LIMIT 30"
    ).bind(account.account_id).all(),
    env.GATEWAY_DB.prepare(
      "SELECT feature_key, status, source_product_key, trial_started_at, current_period_end, provider, provider_subscription_id, checkout_url, updated_at FROM platform_account_features WHERE account_id = ? ORDER BY feature_key"
    ).bind(account.account_id).all(),
    includeSensitive
      ? env.GATEWAY_DB.prepare(
        "SELECT l.*, s.name AS site_name FROM platform_leads l JOIN platform_sites s ON s.site_id = l.site_id WHERE l.account_id = ? ORDER BY l.received_at DESC, l.lead_id DESC LIMIT 50"
      ).bind(account.account_id).all()
      : Promise.resolve({ results: [] }),
    env.GATEWAY_DB.prepare(
      "SELECT email, role, created_at, expires_at FROM platform_invites WHERE account_id = ? AND accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC"
    ).bind(account.account_id, new Date().toISOString()).all(),
    platformRole === "operator"
      ? env.GATEWAY_DB.prepare(
        "SELECT r.request_id, r.user_id, r.status, r.requested_at, u.email, u.display_name FROM platform_access_requests r JOIN platform_users u ON u.user_id = r.user_id WHERE r.account_id = ? AND r.status = 'pending' ORDER BY r.requested_at DESC"
      ).bind(account.account_id).all()
      : Promise.resolve({ results: [] })
  ]);
  const billingStatus = account.billing_status || (account.plan === "trial" ? "trial" : "active");
  const billingLabels = {
    trial_pending: "Ожидает подключения",
    trial: "Пробный период",
    active: "Оплачено",
    past_due: "Нужна оплата",
    complimentary: "Бесплатный доступ",
    paused: "Приостановлено",
    canceled: "Завершено"
  };
  const members = membersResult?.results || [];
  const featureRows = new Map((featureResult?.results || []).map((row) => [row.feature_key, row]));
  const featureDetails = (featureKey) => {
    const row = featureRows.get(featureKey) || null;
    const fallback = featureKey === "control" ? account : null;
    const status = row?.status || (featureKey === "control" ? billingStatus : "canceled");
    return {
      key: featureKey,
      status,
      label: billingLabels[status] || status,
      enabled: featureAllowsChanges(row, fallback),
      sourceProductKey: row?.source_product_key || (featureKey === "control" ? "control" : "manual"),
      trialStartedAt: row?.trial_started_at || (featureKey === "control" ? account.trial_started_at : null) || null,
      currentPeriodEnd: row?.current_period_end || (featureKey === "control" ? account.current_period_end : null) || null,
      provider: row?.provider || "manual",
      checkoutUrl: row?.checkout_url || ""
    };
  };
  const features = { control: featureDetails("control"), reviews: featureDetails("reviews") };
  const enabledFeatureCount = Number(features.control.enabled) + Number(features.reviews.enabled);
  features.bundle = {
    key: "bundle",
    status: enabledFeatureCount === 2 ? "active" : enabledFeatureCount === 1 ? "partial" : "canceled",
    label: enabledFeatureCount === 2 ? "Полный доступ" : enabledFeatureCount === 1 ? "Дополнить комплект" : "Не подключён",
    enabled: features.control.enabled && features.reviews.enabled,
    partiallyEnabled: enabledFeatureCount === 1,
    currentPeriodEnd: [features.control.currentPeriodEnd, features.reviews.currentPeriodEnd].filter(Boolean).sort()[0] || null
  };
  const leads = await Promise.all((leadsResult?.results || []).map((row) => leadRowToPublic(env, row)));
  return {
    account_id: account.account_id,
    name: account.name,
    plan: account.plan,
    plan_label: limits.label,
    status: account.status,
    trial_ends_at: account.trial_ends_at,
    role,
    limits: { ...limits, sites: effectiveSiteLimit(account) },
    billing: {
      status: billingStatus,
      label: billingLabels[billingStatus] || billingStatus,
      trialStartedAt: account.trial_started_at || null,
      currentPeriodEnd: account.current_period_end || account.trial_ends_at || null,
      extraSiteSlots: Math.max(0, Number(account.extra_site_slots) || 0),
      provider: account.billing_provider || "manual",
      checkoutUrl: account.checkout_url || "",
      checkoutConfigured: Boolean(account.checkout_url),
      canChange: features.control.enabled
    },
    features,
    counts: {
      sites: Number(counts?.sites || 0),
      users: Number(counts?.users || 0),
      openIncidents: Number(counts?.open_incidents || 0),
      healthy: Number(counts?.healthy || 0),
      leadsToday: Number(counts?.leads_today || 0),
      leadsWeek: Number(counts?.leads_week || 0),
      lastFormAt: counts?.last_form_at || null,
      leadsTotal: Number(counts?.leads_total || 0)
    },
    usage: {
      monitorChecks: Number(usage?.monitor_checks || 0),
      formSignals: Number(usage?.form_signals || 0),
      aiRequests: Number(usage?.ai_requests || 0)
    },
    sites: sitesResult?.results || [],
    members,
    owner: members.find((member) => member.role === "owner") || null,
    incidents: incidentsResult?.results || [],
    leads,
    leadsHasMore: Number(counts?.leads_total || 0) > leads.length,
    leadsCursor: leads.length ? { receivedAt: leads.at(-1).receivedAt, leadId: leads.at(-1).leadId } : null,
    receipts: (receiptsResult?.results || []).map((receipt) => ({
      ...receipt,
      field_names: (() => { try { return JSON.parse(receipt.field_names_json || "[]"); } catch { return []; } })()
    })),
    activity: activityResult?.results || [],
    ...(platformRole === "operator" ? { supportNotes: notesResult?.results || [] } : {}),
    billingEvents: billingEventsResult?.results || [],
    pendingInvites: invitesResult?.results || [],
    accessRequests: accessRequestsResult?.results || []
  };
}

async function dashboard(request, env, user) {
  const preferred = new URL(request.url).searchParams.get("account") || "";
  const [rows, productsResult] = await Promise.all([
    user.platform_role === "operator"
    ? env.GATEWAY_DB.prepare(
      "SELECT a.*, 'owner' AS role, b.status AS billing_status, b.trial_started_at, b.current_period_end, b.extra_site_slots, b.provider AS billing_provider, b.checkout_url FROM platform_accounts a LEFT JOIN platform_billing b ON b.account_id = a.account_id ORDER BY a.created_at"
    ).all()
    : env.GATEWAY_DB.prepare(
      "SELECT a.*, m.role, b.status AS billing_status, b.trial_started_at, b.current_period_end, b.extra_site_slots, b.provider AS billing_provider, b.checkout_url FROM platform_accounts a JOIN platform_memberships m ON m.account_id = a.account_id LEFT JOIN platform_billing b ON b.account_id = a.account_id WHERE m.user_id = ? ORDER BY a.created_at"
    ).bind(user.user_id).all(),
    env.GATEWAY_DB.prepare(
      "SELECT product_key, name, description, price_minor, currency, billing_period, checkout_url, active, sort_order FROM platform_products WHERE active = 1 ORDER BY sort_order, product_key"
    ).all()
  ]);
  const rawAccounts = rows?.results || [];
  const selected = rawAccounts.some((account) => account.account_id === preferred) ? preferred : rawAccounts[0]?.account_id || null;
  const accounts = await Promise.all(rawAccounts.map((account) => accountDetails(
    env,
    account,
    account.role,
    user.platform_role,
    { includeSensitive: user.platform_role !== "operator" || Boolean(preferred && account.account_id === selected) }
  )));
  const operatorAccounts = user.platform_role === "operator" ? accounts.map((account) => ({
    account_id: account.account_id,
    name: account.name,
    plan: account.plan,
    plan_label: account.plan_label,
    status: account.status,
    billing_status: account.billing.status,
    billing_label: account.billing.label,
    access_until: account.billing.currentPeriodEnd,
    owner_email: account.owner?.email || "",
    site_count: account.counts.sites,
    healthy_count: account.counts.healthy,
    open_incidents: account.counts.openIncidents,
    last_form_at: account.counts.lastFormAt
  })) : [];
  const supportCountRow = user.platform_role === "operator"
    ? await env.GATEWAY_DB.prepare(
      "SELECT COUNT(*) AS open_count, SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_count, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count, SUM(CASE WHEN status = 'waiting_client' THEN 1 ELSE 0 END) AS waiting_count FROM platform_support_requests WHERE status IN ('new','active','waiting_client')"
    ).first()
    : null;
  return json({
    ok: true,
    version: PLATFORM_VERSION,
    csrf: user.csrf_token,
    user: { user_id: user.user_id, email: user.email, display_name: user.display_name, platform_role: user.platform_role },
    selected_account_id: selected,
    accounts,
    operatorAccounts,
    products: (productsResult?.results || []).map((product) => ({
      productKey: product.product_key,
      name: product.name,
      description: product.description,
      priceMinor: Number(product.price_minor || 0),
      currency: product.currency,
      billingPeriod: product.billing_period,
      checkoutUrl: product.checkout_url || "",
      checkoutConfigured: Boolean(product.checkout_url),
      sortOrder: Number(product.sort_order || 0)
    })),
    support: {
      open: Number(supportCountRow?.open_count || 0),
      new: Number(supportCountRow?.new_count || 0),
      active: Number(supportCountRow?.active_count || 0),
      waitingClient: Number(supportCountRow?.waiting_count || 0)
    },
    assistant: {
      mode: env.OPENAI_API_KEY || (env.AI && typeof env.AI.run === "function") ? "ai" : "fallback",
      label: env.OPENAI_API_KEY || (env.AI && typeof env.AI.run === "function") ? "AI-помощник подключён" : "AI временно недоступен"
    }
  });
}

async function createOperatorAccount(request, env, user) {
  if (user.platform_role !== "operator") fail("Доступ запрещён.", 403, "FORBIDDEN");
  const body = await requestJson(request);
  const name = validateAccountName(body.name);
  const ownerEmail = normalizeEmail(body.ownerEmail);
  validateDisplayName(body.ownerName);
  const accountId = newId("acc", name);
  const now = new Date();
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_accounts (account_id, name, plan, status, trial_ends_at, created_at, updated_at) VALUES (?, ?, 'trial', 'active', NULL, ?, ?)"
    ).bind(accountId, name, now.toISOString(), now.toISOString()),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_billing (account_id, status, trial_started_at, current_period_end, extra_site_slots, provider, checkout_url, updated_at) VALUES (?, 'trial_pending', NULL, NULL, 0, 'manual', '', ?)"
    ).bind(accountId, now.toISOString()),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_account_features (account_id, feature_key, status, source_product_key, trial_started_at, current_period_end, provider, provider_subscription_id, checkout_url, updated_at) VALUES (?, 'control', 'trial_pending', 'control', NULL, NULL, 'manual', '', '', ?)"
    ).bind(accountId, now.toISOString())
  ]);
  const account = { account_id: accountId, name, plan: "trial" };
  const invite = await createInvite(env, new URL(request.url).origin, account, user, ownerEmail, "owner");
  await audit(env, user, accountId, "account.create", "account", accountId, `Пробный период: ${TRIAL_DAYS} дня после подключения сайта.`);
  return json({ ok: true, accountId, inviteUrl: invite.inviteUrl, expiresAt: invite.expiresAt });
}

async function updateOperatorAccount(request, env, user, accountId) {
  if (user.platform_role !== "operator") fail("Доступ запрещён.", 403, "FORBIDDEN");
  const body = await requestJson(request);
  const account = await accountAccess(env, user, accountId, "owner");
  const plan = body.plan === undefined ? account.plan : validatePlan(body.plan);
  const status = body.status === undefined ? account.status : String(body.status);
  if (!new Set(["active", "suspended"]).has(status)) fail("Некорректный статус клиента.");
  const name = body.name === undefined ? account.name : validateAccountName(body.name);
  const now = new Date().toISOString();
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare("UPDATE platform_accounts SET name = ?, plan = ?, status = ?, updated_at = ? WHERE account_id = ?")
      .bind(name, plan, status, now, accountId),
    env.GATEWAY_DB.prepare("UPDATE platform_sites SET monitor_interval_minutes = ?, updated_at = ? WHERE account_id = ? AND integration_mode = 'central'")
      .bind(PLAN_LIMITS[plan].monitorMinutes, now, accountId)
  ]);
  await audit(env, user, accountId, "account.update", "account", accountId, `${plan}; ${status}`);
  return json({ ok: true });
}

async function addSite(request, env, user, accountId) {
  const account = await accountAccess(env, user, accountId, "admin");
  await requireFeature(env, user, account, "control");
  const limits = PLAN_LIMITS[validatePlan(account.plan)];
  const count = await env.GATEWAY_DB.prepare("SELECT COUNT(*) AS count FROM platform_sites WHERE account_id = ? AND status != 'archived'").bind(accountId).first();
  const siteLimit = effectiveSiteLimit(account);
  if (Number(count?.count || 0) >= siteLimit) fail(`Доступно сайтов: ${siteLimit}. Дополнительный сайт подключает поддержка SiteCare.`, 409, "PLAN_LIMIT");
  const body = await requestJson(request);
  const name = validateAccountName(body.name);
  const targetUrl = validateTargetUrl(body.url);
  const target = new URL(targetUrl);
  const scope = "site";
  const siteId = `${siteSlug(target.hostname).slice(0, 40)}-${randomToken(5).toLocaleLowerCase("en-US")}`;
  const preliminary = await inspectSite({ target_url: targetUrl, expected_form_count: 0, form_required: 0 });
  const inventoryPreview = preliminary.pageOk && scope === "site"
    ? await scanSiteInventory({ target_url: targetUrl, scope }, fetch, { maxPages: 40 })
    : { formCount: preliminary.formCount };
  const discoveredForms = Math.max(Number(preliminary.formCount || 0), Number(inventoryPreview.formCount || 0));
  const formRequired = preliminary.pageOk && discoveredForms > 0 ? 1 : 0;
  const expectedForms = formRequired ? Math.min(20, discoveredForms) : 0;
  const webhookToken = randomToken(32);
  const webhookHash = await digest("platform-form-webhook", webhookToken);
  const loaderKey = randomToken(24);
  const siteTokenHash = await digest("site-token", randomToken(32));
  const now = new Date().toISOString();
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare(
      "INSERT INTO gateway_sites (site_id, site_name, target_url, site_token_hash, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)"
    ).bind(siteId, name, targetUrl, siteTokenHash, now, now),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_sites (site_id, account_id, name, target_url, target_origin, target_pathname, scope, status, integration_mode, form_required, expected_form_count, webhook_token_hash, loader_key, monitor_interval_minutes, last_monitor_at, next_monitor_at, domain_ok, tls_ok, page_ok, form_ok, last_http_status, last_latency_ms, last_error, last_form_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'central', ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)"
    ).bind(siteId, accountId, name, targetUrl, target.origin, target.pathname, scope, formRequired, expectedForms, webhookHash, loaderKey, limits.monitorMinutes, now, now, now),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_site_overrides (site_id, enabled, phone, schedule_text, button_text, button_url, version, updated_at) VALUES (?, 0, '', '', '', '', 1, ?)"
    ).bind(siteId, now),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_override_history (site_id, version, enabled, phone, schedule_text, button_text, button_url, created_by, created_at) VALUES (?, 1, 0, '', '', '', '', ?, ?)"
    ).bind(siteId, user.user_id, now),
    env.GATEWAY_DB.prepare(
      "UPDATE platform_sites SET next_digest_at = ? WHERE site_id = ?"
    ).bind(nextCheckAt(7 * 24 * 60, new Date(now)), siteId)
  ]);
  if (account.billing_status === "trial_pending") {
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await env.GATEWAY_DB.batch([
      env.GATEWAY_DB.prepare("UPDATE platform_billing SET status = 'trial', trial_started_at = ?, current_period_end = ?, updated_at = ? WHERE account_id = ? AND status = 'trial_pending'")
        .bind(now, trialEndsAt, now, accountId),
      env.GATEWAY_DB.prepare("UPDATE platform_account_features SET status = 'trial', trial_started_at = ?, current_period_end = ?, source_product_key = 'control', updated_at = ? WHERE account_id = ? AND feature_key = 'control' AND status = 'trial_pending'")
        .bind(now, trialEndsAt, now, accountId),
      env.GATEWAY_DB.prepare("UPDATE platform_accounts SET trial_ends_at = ?, updated_at = ? WHERE account_id = ?")
        .bind(trialEndsAt, now, accountId),
      env.GATEWAY_DB.prepare("INSERT INTO platform_billing_events (account_id, kind, summary, created_by, created_at) VALUES (?, 'trial.started', ?, ?, ?)")
        .bind(accountId, `Пробный период начат на ${TRIAL_DAYS} дня.`, user.user_id, now)
    ]);
  }
  const site = await env.GATEWAY_DB.prepare("SELECT * FROM platform_sites WHERE site_id = ?").bind(siteId).first();
  const result = await checkPlatformSite(env, site, { notify: false });
  await audit(env, user, accountId, "site.create", "site", siteId, targetUrl);
  const urls = integrationUrls(new URL(request.url).origin, site);
  return json({
    ok: true,
    siteId,
    scope,
    formRequired: Boolean(formRequired),
    webhookUrl: `${urls.webhookBase}?token=${encodeURIComponent(webhookToken)}`,
    loaderCode: urls.loaderCode,
    initialCheck: result
  }, 201);
}

async function updateSite(request, env, user, siteId) {
  const { site } = await siteAccess(env, user, siteId, "manager");
  const body = await requestJson(request);
  let status = site.status;
  if (body.status !== undefined) {
    status = String(body.status);
    if (!new Set(["active", "paused", "archived"]).has(status)) fail("Некорректный статус сайта.");
    if (status === "archived") await accountAccess(env, user, site.account_id, "admin");
  }
  const name = body.name === undefined ? site.name : validateAccountName(body.name);
  const scope = "site";
  const targetUrl = body.url === undefined ? site.target_url : validateTargetUrl(body.url);
  const target = new URL(targetUrl);
  const formRequired = body.formRequired === undefined ? Number(site.form_required) : body.formRequired ? 1 : 0;
  const expected = body.expectedFormCount === undefined ? Number(site.expected_form_count) : Math.min(20, Math.max(0, Number(body.expectedFormCount) || 0));
  const reset = targetUrl !== site.target_url;
  const now = new Date().toISOString();
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare(
      "UPDATE platform_sites SET name = ?, target_url = ?, target_origin = ?, target_pathname = ?, scope = ?, status = ?, form_required = ?, expected_form_count = ?, page_ok = ?, form_ok = ?, next_monitor_at = ?, updated_at = ? WHERE site_id = ?"
    ).bind(name, targetUrl, target.origin, target.pathname, scope, status, formRequired, expected, reset ? null : site.page_ok, reset ? null : site.form_ok, now, now, siteId),
    env.GATEWAY_DB.prepare("UPDATE gateway_sites SET site_name = ?, target_url = ?, enabled = ?, updated_at = ? WHERE site_id = ?")
      .bind(name, targetUrl, status === "active" ? 1 : 0, now, siteId)
  ]);
  await audit(env, user, site.account_id, "site.update", "site", siteId, status);
  return json({ ok: true });
}

async function checkOneSite(env, user, siteId) {
  const { site } = await siteAccess(env, user, siteId, "manager");
  if (site.status === "archived") fail("Архивный сайт нельзя проверить.", 409, "ARCHIVED");
  return json({ ok: true, ...(await checkPlatformSite(env, site, { notify: site.integration_mode === "central" })) });
}

async function checkAccountSites(env, user, accountId) {
  const account = await accountAccess(env, user, accountId, "manager");
  await requireFeature(env, user, account, "control");
  const rows = await env.GATEWAY_DB.prepare("SELECT * FROM platform_sites WHERE account_id = ? AND status = 'active' ORDER BY created_at LIMIT 20").bind(accountId).all();
  const settled = await Promise.allSettled((rows?.results || []).map((site) => checkPlatformSite(env, site, { notify: site.integration_mode === "central" })));
  return json({ ok: true, checked: settled.length, failed: settled.filter((item) => item.status === "rejected").length });
}

async function rotateWebhook(request, env, user, siteId) {
  const { site } = await siteAccess(env, user, siteId, "manager");
  const token = randomToken(32);
  const tokenHash = await digest("platform-form-webhook", token);
  await env.GATEWAY_DB.prepare("UPDATE platform_sites SET webhook_token_hash = ?, webhook_verified_at = NULL, form_verified_at = NULL, last_form_at = NULL, updated_at = ? WHERE site_id = ?")
    .bind(tokenHash, new Date().toISOString(), siteId).run();
  await audit(env, user, site.account_id, "webhook.rotate", "site", siteId);
  const urls = integrationUrls(new URL(request.url).origin, site);
  return json({ ok: true, webhookUrl: `${urls.webhookBase}?token=${encodeURIComponent(token)}` });
}

async function createFormTestSession(env, user, siteId) {
  const { site } = await siteAccess(env, user, siteId, "manager");
  if (!Number(site.form_required)) fail("На опубликованном сайте формы не найдены.", 409, "NO_FORMS");
  const inspection = await inspectSite(site);
  if (!inspection.pageOk || !inspection.forms?.length) fail("Сначала опубликуйте формы и повторите проверку.", 409, "FORMS_NOT_FOUND");
  const markerKind = testMarkerKindForForms(inspection.forms);
  const marker = createTestMarker(markerKind);
  const markerHash = await hashTestMarker(marker, env.TELEGRAM_WEBHOOK_SECRET || env.LEADS_DATA_KEY || "sitecare-test");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 20 * 60 * 1000).toISOString();
  const sessionId = newId("formtest", siteId);
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare(
      "UPDATE platform_form_test_sessions SET status = 'expired' WHERE site_id = ? AND status = 'pending'"
    ).bind(siteId),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_form_test_sessions (session_id, site_id, marker_hash, marker_kind, status, created_by, created_at, expires_at, confirmed_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, NULL)"
    ).bind(sessionId, siteId, markerHash, markerKind, user.user_id, now.toISOString(), expiresAt),
    env.GATEWAY_DB.prepare(
      "DELETE FROM platform_form_test_sessions WHERE site_id = ? AND session_id NOT IN (SELECT session_id FROM platform_form_test_sessions WHERE site_id = ? ORDER BY created_at DESC LIMIT 30)"
    ).bind(siteId, siteId)
  ]);
  return json({
    ok: true,
    marker,
    markerKind,
    expiresAt,
    instruction: markerKind === "phone"
      ? "Вставьте этот тестовый номер в поле телефона и отправьте форму один раз. Тест не попадёт в список заявок."
      : "Вставьте этот код в любое обычное текстовое поле формы и отправьте её один раз. Тест не попадёт в список заявок."
  });
}

async function integration(request, env, user, siteId) {
  const { site } = await siteAccess(env, user, siteId, "manager");
  const urls = integrationUrls(new URL(request.url).origin, site);
  const formConnections = await env.GATEWAY_DB.prepare(
    "SELECT COUNT(*) AS count FROM platform_form_connections WHERE site_id = ?"
  ).bind(siteId).first();
  return json({
    ok: true,
    loaderCode: urls.loaderCode,
    webhookConfigured: Boolean(site.webhook_token_hash),
    webhookVerified: Boolean(site.webhook_verified_at) || !Number(site.form_required),
    testLeadReceived: Boolean(site.form_verified_at) || !Number(site.form_required),
    loaderVerified: Number(site.loader_ok) === 1,
    formRequired: Boolean(site.form_required),
    connectedForms: Number(formConnections?.count || 0),
    expectedForms: Number(site.expected_form_count || 0),
    scope: site.scope
  });
}

async function siteContentChanges(env, user, siteId) {
  await siteAccess(env, user, siteId, "viewer");
  const rows = await env.GATEWAY_DB.prepare(
    "SELECT page_path, page_title, field, slot_label, old_value, new_value, detected_at FROM platform_content_changes WHERE site_id = ? ORDER BY id DESC LIMIT 100"
  ).bind(siteId).all();
  return json({ ok: true, changes: rows?.results || [] });
}

async function siteIncidents(env, user, siteId, limit = 10) {
  await siteAccess(env, user, siteId, "viewer");
  const rows = await env.GATEWAY_DB.prepare(
    "SELECT incident_id, kind, status, summary, opened_at, resolved_at FROM platform_incidents WHERE site_id = ? ORDER BY opened_at DESC LIMIT ?"
  ).bind(siteId, Math.min(50, Math.max(1, limit))).all();
  return json({ ok: true, incidents: rows?.results || [] });
}

async function siteHealthHistory(env, user, siteId, limit = 10) {
  await siteAccess(env, user, siteId, "viewer");
  const rows = await env.GATEWAY_DB.prepare(
    "SELECT checked_at, score, high, medium, low, issue_count FROM platform_health_history WHERE site_id = ? ORDER BY checked_at DESC LIMIT ?"
  ).bind(siteId, Math.min(50, Math.max(1, limit))).all();
  return json({ ok: true, history: rows?.results || [] });
}

async function requireCompletedIntegration(env, site) {
  const inspection = await inspectSite(site);
  const checkedAt = new Date().toISOString();
  await env.GATEWAY_DB.prepare("UPDATE platform_sites SET loader_ok = ?, loader_checked_at = ?, updated_at = ? WHERE site_id = ?")
    .bind(inspection.loaderOk ? 1 : 0, checkedAt, checkedAt, site.site_id).run();
  const webhookReady = !Number(site.form_required) || (Boolean(site.webhook_verified_at) && Boolean(site.form_verified_at));
  if (!inspection.loaderOk || !webhookReady) {
    const missing = [
      !webhookReady ? "webhook и тестовая заявка" : "",
      !inspection.loaderOk ? "код SiteCare на опубликованной странице" : ""
    ].filter(Boolean).join(" и ");
    fail(`Сначала завершите подключение. Не подтверждены: ${missing}.`, 409, "SETUP_INCOMPLETE");
  }
}

async function requireLoaderConnection(env, site) {
  const inspection = await inspectSite({ ...site, form_required: 0, expected_form_count: 0 });
  const checkedAt = new Date().toISOString();
  await env.GATEWAY_DB.prepare("UPDATE platform_sites SET loader_ok = ?, loader_checked_at = ?, updated_at = ? WHERE site_id = ?")
    .bind(inspection.loaderOk ? 1 : 0, checkedAt, checkedAt, site.site_id).run();
  if (!inspection.loaderOk) {
    fail("Сначала добавьте код SiteCare в HEAD всего сайта, опубликуйте страницы и повторите проверку.", 409, "LOADER_NOT_CONNECTED");
  }
  return inspection;
}

function changeLabel(kind) {
  return {
    phone: "Телефон",
    schedule: "График работы",
    button_text: "Текст кнопки",
    button_url: "Ссылка кнопки"
  }[kind] || "Изменение";
}

function changeField(kind) {
  return { phone: "phone", schedule: "hours", button_text: "ctaText", button_url: "ctaLink" }[kind] || "";
}

function validatedChangeValue(kind, value) {
  const field = changeField(kind);
  if (!field) fail("Выберите доступный тип изменения.");
  return validateFieldValue(field, value);
}

function normalizedPhoneDigits(value) {
  return String(value || "").replace(/\D/gu, "");
}

async function inventory(request, env, user, siteId) {
  const { site } = await siteAccess(env, user, siteId, "manager");
  const result = await scanSiteInventory(site, fetch, { maxPages: site.scope === "site" ? 40 : 1 });
  return json({ ok: true, ...result });
}

async function conversationForSite(env, user, site) {
  return ensureConversation(env, { accountId: site.account_id, siteId: site.site_id, userId: user.user_id });
}

async function supportTelegramRecipients(env) {
  const result = await env.GATEWAY_DB.prepare(
    "SELECT d.chat_id FROM platform_support_destinations d JOIN platform_users u ON u.user_id = d.user_id WHERE d.enabled = 1 AND u.platform_role = 'operator' AND u.status = 'active'"
  ).all();
  return (result?.results || []).map((row) => row.chat_id).filter(Boolean);
}

async function notifySupportTeam(env, request, supportRequest, { followup = false } = {}) {
  const supportUrl = `${new URL(request.url).origin}/app?view=support&request=${encodeURIComponent(supportRequest.requestId)}`;
  const telegramText = followup
    ? `💬 Новое сообщение в поддержке\n${supportRequest.accountName} · ${supportRequest.siteName}\n${supportUrl}`
    : `🆘 Новое обращение в поддержку\n${supportRequest.accountName} · ${supportRequest.siteName}\n${supportRequest.summary}\n${supportUrl}`;
  const chats = await supportTelegramRecipients(env);
  const tasks = chats.map((chatId) => telegramSendMessage(env.TELEGRAM_BOT_TOKEN, chatId, telegramText));
  if (!followup && emailDeliveryConfigured(env)) {
    const operators = await env.GATEWAY_DB.prepare(
      "SELECT email FROM platform_users WHERE platform_role = 'operator' AND status = 'active' ORDER BY created_at"
    ).all();
    for (const recipient of operators?.results || []) {
      tasks.push(sendSupportRequestEmail(env, {
        to: recipient.email,
        clientName: supportRequest.accountName,
        siteName: supportRequest.siteName,
        summary: supportRequest.summary,
        supportUrl,
        requestId: `${supportRequest.requestId}-${recipient.email}`
      }));
    }
  }
  if (tasks.length) await Promise.allSettled(tasks);
}

async function notifySupportReply(env, request, details) {
  const supportRequest = details.request;
  const chatUrl = `${new URL(request.url).origin}/app?view=edit&site=${encodeURIComponent(supportRequest.siteId)}`;
  const tasks = [];
  const destination = await env.GATEWAY_DB.prepare(
    "SELECT chat_id FROM telegram_destinations WHERE site_id = ? AND enabled = 1"
  ).bind(supportRequest.siteId).first();
  if (destination?.chat_id) {
    tasks.push(telegramSendMessage(
      env.TELEGRAM_BOT_TOKEN,
      destination.chat_id,
      `💬 Поддержка SiteCare ответила\n${supportRequest.siteName}\nОткройте диалог в кабинете: ${chatUrl}`
    ));
  }
  if (supportRequest.requesterEmail && emailDeliveryConfigured(env)) {
    tasks.push(sendSupportReplyEmail(env, {
      to: supportRequest.requesterEmail,
      siteName: supportRequest.siteName,
      chatUrl,
      requestId: supportRequest.requestId
    }));
  }
  if (tasks.length) await Promise.allSettled(tasks);
}

async function conversationState(env, user, siteId) {
  const { site } = await siteAccess(env, user, siteId, "manager");
  const conversation = await conversationForSite(env, user, site);
  return json({ ok: true, conversation: clientConversation(await conversationSnapshot(env, conversation.conversation_id)) });
}

// The client's quick-action buttons (status check, SEO summary, etc.) answer
// deterministically without a round trip through the AI pipeline -- but if
// that exchange only lives in local client state, the next real /assistant
// call overwrites the client's conversation with the server's snapshot and
// the quick-action exchange visibly vanishes, since it was never persisted.
// Same author/append machinery as a normal message, just without the AI
// pipeline behind it.
async function appendQuickExchange(request, env, user, siteId) {
  const { site } = await siteAccess(env, user, siteId, "manager");
  await enforceActionLimit(env, `quick-exchange:${user.user_id}:${siteId}`, 30, 300);
  const body = await requestJson(request);
  const userText = safeText(body.userText, 300);
  const aiText = safeMessageText(body.aiText, 4000);
  if (!userText || !aiText) fail("Некорректное сообщение.");
  const conversation = await conversationForSite(env, user, site);
  await appendConversationMessage(env, conversation.conversation_id, { authorType: "client", authorUserId: user.user_id, content: userText });
  await appendConversationMessage(env, conversation.conversation_id, { authorType: "ai", content: aiText, metadata: { kind: "advice", local: true } });
  return json({ ok: true, conversation: clientConversation(await conversationSnapshot(env, conversation.conversation_id)) });
}

function clientConversation(snapshot) {
  return {
    ...snapshot,
    messages: (snapshot.messages || [])
      .filter((message) => message.role !== "system")
      .map((message) => message.role === "support" ? { ...message, authorName: "Поддержка SiteCare" } : message)
  };
}

async function siteSupportAction(request, env, user, siteId) {
  if (user.platform_role === "operator") fail("Поддержка не может создавать обращение самой себе.", 403, "FORBIDDEN");
  const { site } = await siteAccess(env, user, siteId, "manager");
  const body = await requestJson(request);
  const action = String(body.action || "request");
  const conversation = await conversationForSite(env, user, site);
  if (action === "cancel") {
    await cancelSupportRequest(env, conversation.conversation_id, user.user_id);
    await audit(env, user, site.account_id, "support.cancel", "site", siteId, "Обращение отменено клиентом.");
    return json({ ok: true, conversation: clientConversation(await conversationSnapshot(env, conversation.conversation_id)) });
  }
  if (action !== "request") fail("Неизвестное действие поддержки.");
  await enforceActionLimit(env, `support-request:${user.user_id}:${siteId}`, 3, 3600);
  const result = await requestSupport(env, conversation, user, body.reason);
  const snapshot = clientConversation(await conversationSnapshot(env, conversation.conversation_id));
  if (result.created) {
    await audit(env, user, site.account_id, "support.request", "site", siteId, result.request.summary);
    await notifySupportTeam(env, request, result.request);
  }
  return json({ ok: true, created: result.created, request: result.request, conversation: snapshot }, result.created ? 201 : 200);
}

async function operatorSupportList(env, user) {
  if (user.platform_role !== "operator") fail("Доступ запрещён.", 403, "FORBIDDEN");
  return json({ ok: true, ...(await supportQueue(env)) });
}

async function operatorSupportDetails(env, user, requestId) {
  if (user.platform_role !== "operator") fail("Доступ запрещён.", 403, "FORBIDDEN");
  return json({ ok: true, ...(await supportRequestDetails(env, requestId)) });
}

async function operatorSupportUpdate(request, env, user, requestId) {
  if (user.platform_role !== "operator") fail("Доступ запрещён.", 403, "FORBIDDEN");
  const body = await requestJson(request);
  const action = String(body.action || "");
  if (action === "reply") await enforceActionLimit(env, `support-reply:${user.user_id}`, 60, 300);
  const details = await updateSupportRequest(env, requestId, user, { action, content: body.content });
  await audit(env, user, details.request.accountId, `support.${action}`, "support", requestId, details.request.summary);
  if (action === "reply") await notifySupportReply(env, request, details);
  return json({ ok: true, ...details });
}

async function supportTelegramStatus(env, user) {
  if (user.platform_role !== "operator") fail("Доступ запрещён.", 403, "FORBIDDEN");
  const [destination, bot] = await Promise.all([
    env.GATEWAY_DB.prepare("SELECT chat_type, linked_at, enabled FROM platform_support_destinations WHERE user_id = ?").bind(user.user_id).first(),
    env.GATEWAY_DB.prepare("SELECT value FROM gateway_settings WHERE key = 'bot_username'").first()
  ]);
  return json({
    ok: true,
    configured: Boolean(destination?.enabled),
    destination: destination?.enabled ? destination.chat_type === "private" ? "личный чат" : "группа" : null,
    linkedAt: destination?.linked_at || null,
    botUsername: bot?.value || null
  });
}

async function supportTelegramConnect(env, user) {
  if (user.platform_role !== "operator") fail("Доступ запрещён.", 403, "FORBIDDEN");
  const bot = await env.GATEWAY_DB.prepare("SELECT value FROM gateway_settings WHERE key = 'bot_username'").first();
  if (!bot?.value) fail("Официальный SiteCareBot ещё не настроен.", 503, "BOT_NOT_CONFIGURED");
  const parameter = `sup_${randomToken(24)}`;
  const tokenHash = await digest("support-connect-token", parameter);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare("DELETE FROM platform_support_connect_sessions WHERE user_id = ? AND used_at IS NULL").bind(user.user_id),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_support_connect_sessions (token_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)"
    ).bind(tokenHash, user.user_id, now.toISOString(), expiresAt)
  ]);
  return json({ ok: true, connectUrl: `https://t.me/${bot.value}?start=${parameter}`, botUsername: bot.value, expiresAt, expiresInMinutes: 15 });
}

async function supportTelegramTest(env, user) {
  if (user.platform_role !== "operator") fail("Доступ запрещён.", 403, "FORBIDDEN");
  const destination = await env.GATEWAY_DB.prepare(
    "SELECT chat_id FROM platform_support_destinations WHERE user_id = ? AND enabled = 1"
  ).bind(user.user_id).first();
  if (!destination?.chat_id) fail("Сначала подключите Telegram для поддержки.", 409, "NOT_LINKED");
  await telegramSendMessage(env.TELEGRAM_BOT_TOKEN, destination.chat_id, "✅ Уведомления поддержки SiteCare подключены.");
  return json({ ok: true, sent: true });
}

async function supportTelegramDisconnect(env, user) {
  if (user.platform_role !== "operator") fail("Доступ запрещён.", 403, "FORBIDDEN");
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare("DELETE FROM platform_support_destinations WHERE user_id = ?").bind(user.user_id),
    env.GATEWAY_DB.prepare("DELETE FROM platform_support_connect_sessions WHERE user_id = ?").bind(user.user_id)
  ]);
  return json({ ok: true });
}

async function effectiveEditorInventory(env, siteId, inventory) {
  const [phoneRulesResult, phoneTargetRulesResult, buttonRulesResult] = await Promise.all([
    env.GATEWAY_DB.prepare(
      "SELECT original_digits, new_phone FROM platform_phone_rules WHERE site_id = ? AND enabled = 1"
    ).bind(siteId).all(),
    env.GATEWAY_DB.prepare(
      "SELECT candidate_id, page_path, original_digits, scope, new_phone FROM platform_phone_target_rules WHERE site_id = ? AND enabled = 1 ORDER BY updated_at DESC"
    ).bind(siteId).all(),
    env.GATEWAY_DB.prepare(
      "SELECT candidate_id, new_text, new_url FROM platform_button_rules WHERE site_id = ? AND enabled = 1 ORDER BY updated_at DESC"
    ).bind(siteId).all()
  ]);
  const phoneRules = new Map((phoneRulesResult?.results || []).map((rule) => [rule.original_digits, rule.new_phone]));
  const targetRules = phoneTargetRulesResult?.results || [];
  const targetRuleFor = (candidate) => targetRules.find((rule) => rule.original_digits === candidate.originalDigits && (
    rule.scope === "site" ||
    (rule.scope === "page" && rule.page_path === candidate.pagePath) ||
    (rule.scope === "element" && rule.candidate_id === candidate.candidateId)
  ));
  const visiblePhoneCandidates = (inventory.phoneCandidates || []).map((candidate) => {
    const targetRule = targetRuleFor(candidate);
    const visible = targetRule?.new_phone || phoneRules.get(candidate.originalDigits) || candidate.phone;
    return { ...candidate, phone: visible };
  });
  const visiblePhones = new Map();
  if (visiblePhoneCandidates.length) {
    for (const candidate of visiblePhoneCandidates) visiblePhones.set(normalizedPhoneDigits(candidate.phone), candidate.phone);
  } else {
    for (const phone of inventory.phones || []) {
      const visible = phoneRules.get(normalizedPhoneDigits(phone)) || phone;
      visiblePhones.set(normalizedPhoneDigits(visible), visible);
    }
  }
  const buttonRules = new Map();
  for (const rule of buttonRulesResult?.results || []) if (!buttonRules.has(rule.candidate_id)) buttonRules.set(rule.candidate_id, rule);
  return {
    ...inventory,
    phones: [...visiblePhones.values()],
    phoneCandidates: visiblePhoneCandidates,
    candidates: (inventory.candidates || []).map((candidate) => {
      const rule = buttonRules.get(candidate.candidateId);
      if (!rule) return candidate;
      const text = rule.new_text || candidate.text;
      return { ...candidate, text, label: text || candidate.label, url: rule.new_url || candidate.url };
    })
  };
}

async function assistantProposal(request, env, user, siteId) {
  const { site, account } = await siteAccess(env, user, siteId, "manager");
  await enforceActionLimit(env, `assistant:${user.user_id}:${siteId}`, 30, 300);
  const body = await requestJson(request);
  const prompt = safeText(body.prompt, 1200);
  if (!prompt) fail("Опишите, что хотите изменить.");
  const conversation = await conversationForSite(env, user, site);
  const before = await conversationSnapshot(env, conversation.conversation_id);
  const activeSupport = await openSupportRequest(env, conversation.conversation_id);
  await appendConversationMessage(env, conversation.conversation_id, {
    authorType: "client",
    authorUserId: user.user_id,
    content: prompt
  });
  if (activeSupport) {
    await forwardClientMessageToSupport(env, activeSupport);
    const updatedRequest = (await supportRequestDetails(env, activeSupport.request_id)).request;
    await notifySupportTeam(env, request, updatedRequest, { followup: true });
    return json({
      ok: true,
      type: "support",
      kind: "unknown",
      value: "",
      message: "Сообщение отправлено в поддержку.",
      supportSuggested: false,
      conversation: clientConversation(await conversationSnapshot(env, conversation.conversation_id))
    });
  }
  const [rawInventory, monitoring, incidentResult, telegramDestination] = await Promise.all([
    scanSiteInventory(site, fetch, { maxPages: site.scope === "site" ? 40 : 1 }),
    siteReport(env, siteId, 30),
    env.GATEWAY_DB.prepare(
      "SELECT kind, status, summary, opened_at, resolved_at FROM platform_incidents WHERE site_id = ? ORDER BY opened_at DESC LIMIT 12"
    ).bind(siteId).all(),
    env.GATEWAY_DB.prepare("SELECT enabled FROM telegram_destinations WHERE site_id = ?").bind(siteId).first()
  ]);
  const siteInventory = await effectiveEditorInventory(env, siteId, rawInventory);
  const today = dayKey();
  const usage = await env.GATEWAY_DB.prepare(
    "SELECT ai_requests FROM platform_usage_daily WHERE account_id = ? AND usage_day = ?"
  ).bind(site.account_id, today).first();
  const limit = PLAN_LIMITS[validatePlan(account.plan)].aiPerDay;
  const used = Number(usage?.ai_requests || 0);
  const siteContext = {
    site: {
      name: site.name,
      url: site.target_url,
      scope: site.scope === "site" ? "весь опубликованный сайт" : "одна страница"
    },
    currentStatus: {
      pageAvailable: Boolean(Number(site.page_ok)),
      tlsAvailable: Boolean(Number(site.tls_ok)),
      formsRequired: Boolean(Number(site.form_required)),
      formsWorking: Boolean(Number(site.form_ok)),
      loaderConnected: Boolean(Number(site.loader_ok)),
      webhookVerified: Boolean(site.webhook_verified_at),
      testLeadVerified: Boolean(site.form_verified_at),
      telegramConnected: Boolean(Number(telegramDestination?.enabled)),
      lastHttpStatus: Number(site.last_http_status || 0),
      lastLatencyMs: Number(site.last_latency_ms || 0),
      lastError: safeText(site.last_error, 500),
      lastCheckedAt: site.last_monitor_at || null
    },
    monitoring: {
      ...monitoring,
      recentIncidents: incidentResult?.results || []
    },
    diagnostics: rawInventory.diagnostics,
    inventory: {
      pageCount: siteInventory.pageCount || 0,
      scanTruncated: Boolean(siteInventory.truncated),
      scanErrors: siteInventory.errors || [],
      phones: siteInventory.phones || [],
      phoneLocations: (siteInventory.phoneCandidates || []).slice(0, 80).map((candidate) => ({
        phone: candidate.phone,
        page: candidate.pageTitle || candidate.pagePath,
        section: candidate.locationLabel || candidate.sectionLabel,
        context: candidate.context
      })),
      schedules: siteInventory.schedules || [],
      buttons: (siteInventory.candidates || []).slice(0, 100).map((candidate) => ({
        text: candidate.text,
        url: candidate.url,
        page: candidate.pageTitle || candidate.pagePath,
        section: candidate.locationLabel || candidate.sectionLabel
      })),
      formsFound: siteInventory.formCount || 0,
      formsReady: siteInventory.readyFormCount || 0
    }
  };
  const result = await prepareSiteChange({
    prompt,
    inventory: siteInventory,
    ai: limit > used ? env.AI : null,
    openAi: limit > used && env.OPENAI_API_KEY ? {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-5-mini"
    } : null,
    history: modelHistory(before.messages),
    siteContext,
    fetchImpl: fetch
  });
  if (result.usedAi) {
    await env.GATEWAY_DB.prepare(
      "INSERT INTO platform_usage_daily (account_id, usage_day, monitor_checks, form_signals, ai_requests) VALUES (?, ?, 0, 0, 1) ON CONFLICT(account_id, usage_day) DO UPDATE SET ai_requests = ai_requests + 1"
    ).bind(site.account_id, today).run();
  }
  await appendConversationMessage(env, conversation.conversation_id, {
    authorType: "ai",
    content: result.message,
    metadata: result
  });
  await audit(env, user, site.account_id, "assistant.prepare", "site", siteId, `${result.kind}; ${result.usedAi ? "AI" : "локально"}`);
  return json({
    ok: true,
    ...result,
    inventory: {
      pageCount: siteInventory.pageCount || 0,
      scannedAt: siteInventory.scannedAt || null,
      legacyCodeDetected: Boolean(siteInventory.legacyCodeDetected),
      truncated: Boolean(siteInventory.truncated),
      diagnostics: siteInventory.diagnostics || null
    },
    observed: { phones: siteInventory.phones || [], phoneCandidates: siteInventory.phoneCandidates || [], schedules: siteInventory.schedules || [] },
    aiRemaining: Math.max(0, limit - used - (result.usedAi ? 1 : 0)),
    conversation: clientConversation(await conversationSnapshot(env, conversation.conversation_id))
  });
}

async function assistantLocatePhone(request, env, user, siteId) {
  const { site } = await siteAccess(env, user, siteId, "manager");
  await enforceActionLimit(env, `assistant-locate:${user.user_id}:${siteId}`, 30, 300);
  const body = await requestJson(request);
  const pagePath = safeText(body.pagePath, 300) || "/";
  const blockId = safeText(body.blockId, 60);
  const source = body.source === "link" ? "link" : "text";
  const originalDigits = String(body.originalDigits || "").replace(/\D/gu, "");
  const requestedIndex = Number(body.occurrenceIndex);
  if (originalDigits.length < 10 || originalDigits.length > 15) fail("Не удалось распознать выбранный номер. Обновите страницу и попробуйте снова.");
  const siteInventory = await scanSiteInventory(site, fetch, { maxPages: site.scope === "site" ? 40 : 1 });
  const matches = (siteInventory.phoneCandidates || []).filter((item) =>
    item.originalDigits === originalDigits && item.blockId === blockId && item.source === source && item.pagePath === pagePath
  );
  const candidate = matches.find((item) => item.occurrenceIndex === requestedIndex) || matches[0];
  if (!candidate) fail("Этот номер больше не найден на опубликованной странице — возможно, сайт обновился. Попробуйте выбрать заново.", 409, "PHONE_CHANGED");
  const group = { phone: candidate.phone, digits: candidate.originalDigits, candidates: [candidate] };
  const conversation = await conversationForSite(env, user, site);
  const place = candidate.locationLabel || candidate.sectionLabel || candidate.pageTitle || pagePath;
  await appendConversationMessage(env, conversation.conversation_id, {
    authorType: "client",
    authorUserId: user.user_id,
    content: `Выбрано на сайте: ${candidate.phone} (${place})`
  });
  const result = phoneValueQuestion(group, candidate, "element");
  await appendConversationMessage(env, conversation.conversation_id, {
    authorType: "ai",
    content: result.message,
    metadata: result
  });
  await audit(env, user, site.account_id, "assistant.locate", "site", siteId, "выбор номера кликом на сайте");
  return json({
    ok: true,
    ...result,
    conversation: clientConversation(await conversationSnapshot(env, conversation.conversation_id))
  });
}

async function applyPreparedChange(request, env, user, siteId) {
  const { site } = await siteAccess(env, user, siteId, "manager");
  await requireLoaderConnection(env, site);
  const body = await requestJson(request);
  const kind = String(body.kind || "");
  const value = validatedChangeValue(kind, body.value);
  const current = await env.GATEWAY_DB.prepare("SELECT * FROM platform_site_overrides WHERE site_id = ?").bind(siteId).first();
  if (!current) fail("Настройки сайта не найдены.", 404, "NOT_FOUND");
  const now = new Date().toISOString();
  const version = Number(current.version) + 1;
  let phone = current.phone;
  let scheduleText = current.schedule_text;
  let targetLabel = "Весь сайт";
  const statements = [];

  if (kind === "phone") {
    const requestedTarget = safeText(body.targetPhone, 80);
    const phoneCandidateId = safeText(body.phoneCandidateId || body.candidateId, 120);
    // A specific location can be targeted explicitly (e.g. selected by clicking
    // it on the live site). Without an explicit choice, a business phone is
    // still treated as one setting and replaced everywhere on the site.
    const scope = new Set(["element", "page", "site"]).has(String(body.scope)) ? String(body.scope) : "site";
    if (phoneCandidateId && !phoneCandidateId.startsWith("legacy_phone_")) {
      const [siteInventory, legacyRulesResult, targetRulesResult] = await Promise.all([
        scanSiteInventory(site, fetch, { maxPages: site.scope === "site" ? 40 : 1 }),
        env.GATEWAY_DB.prepare("SELECT * FROM platform_phone_rules WHERE site_id = ? ORDER BY updated_at").bind(siteId).all(),
        env.GATEWAY_DB.prepare("SELECT * FROM platform_phone_target_rules WHERE site_id = ? ORDER BY updated_at DESC").bind(siteId).all()
      ]);
      const candidate = (siteInventory.phoneCandidates || []).find((item) => item.candidateId === phoneCandidateId);
      if (!candidate) fail("Телефон изменился или больше не найден. Обновите диалог и выберите место снова.", 409, "PHONE_CHANGED");
      const legacyRules = legacyRulesResult?.results || [];
      const targetRules = targetRulesResult?.results || [];
      const appliesToCandidate = (rule, item) => rule.original_digits === item.originalDigits && (
        rule.scope === "site" ||
        (rule.scope === "page" && rule.page_path === item.pagePath) ||
        (rule.scope === "element" && rule.candidate_id === item.candidateId)
      );
      const activeTarget = targetRules.find((rule) => Number(rule.enabled) && appliesToCandidate(rule, candidate));
      const legacyTarget = legacyRules.find((rule) => rule.original_digits === candidate.originalDigits);
      const visibleNow = activeTarget?.new_phone || legacyTarget?.new_phone || current.phone || candidate.phone;
      if (normalizedPhoneDigits(visibleNow) === normalizedPhoneDigits(value)) fail("Этот телефон уже указан в выбранном месте.", 409, "NO_CHANGE");

      const writeTarget = (item, newPhone, ruleScope = "element", existingRule = null) => {
        const ruleId = existingRule?.rule_id || newId("phone_target", item.candidateId);
        statements.push(
          env.GATEWAY_DB.prepare(
            "INSERT INTO platform_phone_target_rules (rule_id, site_id, candidate_id, page_path, block_id, source, original_phone, original_digits, occurrence_index, scope, new_phone, enabled, version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?) " +
            "ON CONFLICT(site_id, candidate_id, scope) DO UPDATE SET page_path = excluded.page_path, block_id = excluded.block_id, source = excluded.source, original_phone = excluded.original_phone, original_digits = excluded.original_digits, occurrence_index = excluded.occurrence_index, new_phone = excluded.new_phone, enabled = 1, version = excluded.version, updated_at = excluded.updated_at"
          ).bind(ruleId, siteId, item.candidateId, item.pagePath, item.blockId || "", item.source || "text", item.phone || candidate.phone, item.originalDigits, Number(item.occurrenceIndex) || 0, ruleScope, newPhone, version, user.user_id, now, now),
          env.GATEWAY_DB.prepare(
            "INSERT INTO platform_phone_target_rule_history (site_id, version, candidate_id, page_path, block_id, source, original_phone, original_digits, occurrence_index, scope, new_phone, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)"
          ).bind(siteId, version, item.candidateId, item.pagePath, item.blockId || "", item.source || "text", item.phone || candidate.phone, item.originalDigits, Number(item.occurrenceIndex) || 0, ruleScope, newPhone, user.user_id, now)
        );
      };
      const disableTarget = (rule) => {
        statements.push(env.GATEWAY_DB.prepare(
          "INSERT INTO platform_phone_target_rule_history (site_id, version, candidate_id, page_path, block_id, source, original_phone, original_digits, occurrence_index, scope, new_phone, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)"
        ).bind(siteId, version, rule.candidate_id, rule.page_path, rule.block_id, rule.source, rule.original_phone, rule.original_digits, rule.occurrence_index, rule.scope, rule.new_phone, user.user_id, now));
      };

      const legacyValue = legacyTarget?.new_phone || current.phone || "";
      if (legacyValue) {
        const legacyCandidates = (siteInventory.phoneCandidates || []).filter((item) => !legacyTarget || item.originalDigits === candidate.originalDigits);
        for (const item of legacyCandidates) {
          const coveredByNewScope = scope === "site" || (scope === "page" && item.pagePath === candidate.pagePath) || (scope === "element" && item.candidateId === candidate.candidateId);
          if (coveredByNewScope || targetRules.some((rule) => Number(rule.enabled) && appliesToCandidate(rule, item))) continue;
          writeTarget(item, legacyValue, "element");
        }
        if (legacyTarget) {
          statements.push(
            env.GATEWAY_DB.prepare(
              "INSERT INTO platform_phone_rule_history (site_id, version, original_phone, original_digits, new_phone, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)"
            ).bind(siteId, version, legacyTarget.original_phone, legacyTarget.original_digits, legacyTarget.new_phone, user.user_id, now),
            env.GATEWAY_DB.prepare("DELETE FROM platform_phone_rules WHERE site_id = ? AND original_digits = ?").bind(siteId, legacyTarget.original_digits)
          );
        }
      }

      const overriddenTargets = targetRules.filter((rule) => Number(rule.enabled) && rule.original_digits === candidate.originalDigits && (
        scope === "site" || (scope === "page" && rule.page_path === candidate.pagePath) || (scope === "element" && rule.candidate_id === candidate.candidateId)
      ));
      for (const rule of overriddenTargets) {
        if (rule.candidate_id === candidate.candidateId && rule.scope === scope) continue;
        disableTarget(rule);
      }
      if (scope === "site") statements.push(env.GATEWAY_DB.prepare("DELETE FROM platform_phone_target_rules WHERE site_id = ? AND original_digits = ?").bind(siteId, candidate.originalDigits));
      else if (scope === "page") statements.push(env.GATEWAY_DB.prepare("DELETE FROM platform_phone_target_rules WHERE site_id = ? AND original_digits = ? AND page_path = ?").bind(siteId, candidate.originalDigits, candidate.pagePath));
      writeTarget(candidate, value, scope, scope === "element" ? activeTarget : null);
      phone = "";
      targetLabel = scope === "site"
        ? `Телефон ${candidate.phone} · все места сайта`
        : `${candidate.phone} · ${candidate.locationLabel || candidate.sectionLabel || candidate.pageTitle || candidate.pagePath}`;
    } else if (!requestedTarget) {
      if (value === current.phone) fail("Этот телефон уже сохранён для сайта.", 409, "NO_CHANGE");
      phone = value;
    } else {
      const targetDigits = normalizedPhoneDigits(requestedTarget);
      if (targetDigits.length < 10 || targetDigits.length > 15) fail("Выбранный телефон больше не найден на сайте.", 409, "PHONE_CHANGED");
      const [siteInventory, currentRulesResult] = await Promise.all([
        scanSiteInventory(site, fetch, { maxPages: site.scope === "site" ? 40 : 1 }),
        env.GATEWAY_DB.prepare("SELECT * FROM platform_phone_rules WHERE site_id = ? ORDER BY updated_at").bind(siteId).all()
      ]);
      const currentRules = currentRulesResult?.results || [];
      const inventoryPhones = [...new Map((siteInventory.phones || []).map((item) => [normalizedPhoneDigits(item), item])).entries()]
        .filter(([itemDigits]) => itemDigits.length >= 10 && itemDigits.length <= 15);
      const existingTarget = currentRules.find((rule) => rule.original_digits === targetDigits || normalizedPhoneDigits(rule.new_phone) === targetDigits);
      const inventoryTarget = inventoryPhones.find(([itemDigits]) => itemDigits === targetDigits);
      const originalDigits = existingTarget?.original_digits || inventoryTarget?.[0] || "";
      const originalPhone = existingTarget?.original_phone || inventoryTarget?.[1] || requestedTarget;
      if (!originalDigits) fail("Выбранный телефон изменился или больше не найден. Обновите диалог и выберите его снова.", 409, "PHONE_CHANGED");
      const visibleNow = existingTarget?.new_phone || current.phone || originalPhone;
      if (normalizedPhoneDigits(visibleNow) === normalizedPhoneDigits(value)) fail("Этот телефон уже указан на сайте.", 409, "NO_CHANGE");

      const existingByDigits = new Map(currentRules.map((rule) => [rule.original_digits, rule]));
      const rulesToWrite = new Map();
      if (current.phone) {
        for (const [itemDigits, itemPhone] of inventoryPhones) {
          const existing = existingByDigits.get(itemDigits);
          rulesToWrite.set(itemDigits, {
            originalDigits: itemDigits,
            originalPhone: existing?.original_phone || itemPhone,
            newPhone: existing?.new_phone || current.phone,
            existing
          });
        }
      }
      const selectedExisting = existingByDigits.get(originalDigits) || existingTarget;
      rulesToWrite.set(originalDigits, { originalDigits, originalPhone, newPhone: value, existing: selectedExisting });
      for (const rule of rulesToWrite.values()) {
        const ruleId = rule.existing?.rule_id || newId("phone", rule.originalDigits);
        statements.push(
          env.GATEWAY_DB.prepare(
            "INSERT INTO platform_phone_rules (rule_id, site_id, original_phone, original_digits, new_phone, enabled, version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?) " +
            "ON CONFLICT(site_id, original_digits) DO UPDATE SET original_phone = excluded.original_phone, new_phone = excluded.new_phone, enabled = 1, version = excluded.version, updated_at = excluded.updated_at"
          ).bind(ruleId, siteId, rule.originalPhone, rule.originalDigits, rule.newPhone, version, user.user_id, now, now),
          env.GATEWAY_DB.prepare(
            "INSERT INTO platform_phone_rule_history (site_id, version, original_phone, original_digits, new_phone, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)"
          ).bind(siteId, version, rule.originalPhone, rule.originalDigits, rule.newPhone, user.user_id, now)
        );
      }
      phone = "";
      targetLabel = `Телефон ${originalPhone}`;
    }
  } else if (kind === "schedule") {
    if (value === current.schedule_text) fail("Этот график уже сохранён для сайта.", 409, "NO_CHANGE");
    scheduleText = value;
  }
  else {
    const candidateId = safeText(body.candidateId, 80);
    if (!candidateId) fail("Выберите конкретную кнопку на сайте.", 409, "BUTTON_REQUIRED");
    const scope = new Set(["element", "page", "site"]).has(String(body.scope)) ? String(body.scope) : "element";
    const siteInventory = await scanSiteInventory(site, fetch, { maxPages: site.scope === "site" ? 40 : 1 });
    const candidate = siteInventory.candidates.find((item) => item.candidateId === candidateId);
    if (!candidate) fail("Кнопка изменилась или больше не найдена. Обновите список и выберите её снова.", 409, "BUTTON_CHANGED");
    const existing = await env.GATEWAY_DB.prepare(
      "SELECT * FROM platform_button_rules WHERE site_id = ? AND candidate_id = ? AND scope = ?"
    ).bind(siteId, candidateId, scope).first();
    const newText = kind === "button_text" ? value : existing?.new_text || "";
    const newUrl = kind === "button_url" ? value : existing?.new_url || "";
    if ((kind === "button_text" && value === existing?.new_text) || (kind === "button_url" && value === existing?.new_url)) {
      fail("Такое значение уже сохранено для этой кнопки.", 409, "NO_CHANGE");
    }
    const ruleId = existing?.rule_id || newId("rule", candidateId);
    targetLabel = `${candidate.label || "Кнопка"} · ${candidate.pageTitle || candidate.pagePath}`;
    statements.push(
      env.GATEWAY_DB.prepare(
        "INSERT INTO platform_button_rules (rule_id, site_id, candidate_id, page_path, block_id, original_text, original_url, match_index, scope, new_text, new_url, enabled, version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?) " +
        "ON CONFLICT(site_id, candidate_id, scope) DO UPDATE SET page_path = excluded.page_path, block_id = excluded.block_id, original_text = excluded.original_text, original_url = excluded.original_url, match_index = excluded.match_index, new_text = excluded.new_text, new_url = excluded.new_url, enabled = 1, version = excluded.version, updated_at = excluded.updated_at"
      ).bind(ruleId, siteId, candidateId, candidate.pagePath, candidate.blockId || "", candidate.text || "", candidate.url || "", candidate.matchIndex, scope, newText, newUrl, version, user.user_id, now, now),
      env.GATEWAY_DB.prepare(
        "INSERT INTO platform_button_rule_history (site_id, version, candidate_id, page_path, block_id, original_text, original_url, match_index, scope, new_text, new_url, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)"
      ).bind(siteId, version, candidateId, candidate.pagePath, candidate.blockId || "", candidate.text || "", candidate.url || "", candidate.matchIndex, scope, newText, newUrl, user.user_id, now)
    );
  }

  const summary = `${changeLabel(kind)}: ${safeText(value, 160)}`;
  statements.push(
    env.GATEWAY_DB.prepare(
      "UPDATE platform_site_overrides SET enabled = 1, phone = ?, schedule_text = ?, version = ?, updated_at = ? WHERE site_id = ?"
    ).bind(phone, scheduleText, version, now, siteId),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_override_history (site_id, version, enabled, phone, schedule_text, button_text, button_url, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)"
    ).bind(siteId, version, phone, scheduleText, current.button_text, current.button_url, user.user_id, now),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_change_records (site_id, version, kind, summary, target_label, status, created_by, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL)"
    ).bind(siteId, version, kind, summary, targetLabel, user.user_id, now),
    env.GATEWAY_DB.prepare(
      "DELETE FROM platform_change_records WHERE site_id = ? AND id NOT IN (SELECT id FROM platform_change_records WHERE site_id = ? ORDER BY id DESC LIMIT 100)"
    ).bind(siteId, siteId),
    env.GATEWAY_DB.prepare(
      "DELETE FROM platform_override_history WHERE site_id = ? AND id NOT IN (SELECT id FROM platform_override_history WHERE site_id = ? ORDER BY version DESC LIMIT 100)"
    ).bind(siteId, siteId)
  );
  await env.GATEWAY_DB.batch(statements);
  if (user.platform_role !== "operator") {
    const conversation = await conversationForSite(env, user, site);
    await appendConversationMessage(env, conversation.conversation_id, {
      authorType: "ai",
      content: "Изменение отправлено на сайт. Я отмечу его готовым только после подтверждения с опубликованной страницы.",
      metadata: { type: "pending", kind, value, version }
    });
  }
  await audit(env, user, site.account_id, "site.change.apply", "site", siteId, `${kind}; версия ${version}`);
  return json({
    ok: true,
    version,
    status: "pending",
    message: "Изменение отправлено. Подтверждение появится после проверки опубликованной страницы."
  });
}

function optionalOverride(field, value, current) {
  if (value === undefined) return current;
  if (String(value).trim() === "") return "";
  return validateFieldValue(field, value);
}

async function siteOverrides(request, env, user, siteId) {
  const { site } = await siteAccess(env, user, siteId, request.method === "GET" ? "viewer" : "manager");
  const current = await env.GATEWAY_DB.prepare("SELECT * FROM platform_site_overrides WHERE site_id = ?").bind(siteId).first();
  if (!current) fail("Настройки сайта не найдены.", 404, "NOT_FOUND");
  if (request.method === "GET") {
    const [historyResult, changesResult, rulesResult, phoneRulesResult, phoneTargetRulesResult, runtimeResult] = await Promise.all([
      env.GATEWAY_DB.prepare(
        "SELECT version, enabled, phone, schedule_text, button_text, button_url, created_at FROM platform_override_history WHERE site_id = ? ORDER BY version DESC LIMIT 20"
      ).bind(siteId).all(),
      env.GATEWAY_DB.prepare(
        "SELECT version, kind, summary, target_label, status, created_at, confirmed_at FROM platform_change_records WHERE site_id = ? ORDER BY id DESC LIMIT 12"
      ).bind(siteId).all(),
      env.GATEWAY_DB.prepare(
        "SELECT rule_id, candidate_id, page_path, block_id, original_text, original_url, match_index, scope, new_text, new_url, enabled, version, updated_at FROM platform_button_rules WHERE site_id = ? ORDER BY updated_at DESC"
      ).bind(siteId).all(),
      env.GATEWAY_DB.prepare(
        "SELECT rule_id, original_phone, original_digits, new_phone, enabled, version, updated_at FROM platform_phone_rules WHERE site_id = ? ORDER BY updated_at DESC"
      ).bind(siteId).all(),
      env.GATEWAY_DB.prepare(
        "SELECT rule_id, candidate_id, page_path, block_id, source, original_phone, original_digits, occurrence_index, scope, new_phone, enabled, version, updated_at FROM platform_phone_target_rules WHERE site_id = ? ORDER BY updated_at DESC"
      ).bind(siteId).all(),
      env.GATEWAY_DB.prepare(
        "SELECT pathname, config_version, phone_count, schedule_count, button_count, phone_verified, schedule_verified, button_verified, error_text, reported_at FROM platform_runtime_reports WHERE site_id = ? ORDER BY reported_at DESC LIMIT 20"
      ).bind(siteId).all()
    ]);
    return json({
      ok: true,
      enabled: Boolean(current.enabled),
      phone: current.phone,
      scheduleText: current.schedule_text,
      buttonText: current.button_text,
      buttonUrl: current.button_url,
      version: Number(current.version),
      changes: changesResult?.results || [],
      buttonRules: rulesResult?.results || [],
      phoneRules: phoneRulesResult?.results || [],
      phoneTargetRules: phoneTargetRulesResult?.results || [],
      runtimeReports: runtimeResult?.results || [],
      history: (historyResult?.results || []).map((item) => ({
        version: Number(item.version),
        enabled: Boolean(item.enabled),
        phone: item.phone,
        scheduleText: item.schedule_text,
        buttonText: item.button_text,
        buttonUrl: item.button_url,
        createdAt: item.created_at
      }))
    });
  }
  await requireCompletedIntegration(env, site);
  const body = await requestJson(request);
  const enabled = body.enabled === undefined ? Number(current.enabled) : body.enabled ? 1 : 0;
  const phone = optionalOverride("phone", body.phone, current.phone);
  const scheduleText = optionalOverride("hours", body.scheduleText, current.schedule_text);
  const buttonText = optionalOverride("ctaText", body.buttonText, current.button_text);
  const buttonUrl = optionalOverride("ctaLink", body.buttonUrl, current.button_url);
  const now = new Date().toISOString();
  const version = Number(current.version) + 1;
  const statements = [
    env.GATEWAY_DB.prepare(
      "UPDATE platform_site_overrides SET enabled = ?, phone = ?, schedule_text = ?, button_text = ?, button_url = ?, version = ?, updated_at = ? WHERE site_id = ?"
    ).bind(enabled, phone, scheduleText, buttonText, buttonUrl, version, now, siteId),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_override_history (site_id, version, enabled, phone, schedule_text, button_text, button_url, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(siteId, version, enabled, phone, scheduleText, buttonText, buttonUrl, user.user_id, now)
  ];
  if (body.phone !== undefined) {
    const [phoneRules, phoneTargetRules] = await Promise.all([
      env.GATEWAY_DB.prepare("SELECT * FROM platform_phone_rules WHERE site_id = ?").bind(siteId).all(),
      env.GATEWAY_DB.prepare("SELECT * FROM platform_phone_target_rules WHERE site_id = ?").bind(siteId).all()
    ]);
    for (const rule of phoneRules?.results || []) {
      statements.push(env.GATEWAY_DB.prepare(
        "INSERT INTO platform_phone_rule_history (site_id, version, original_phone, original_digits, new_phone, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)"
      ).bind(siteId, version, rule.original_phone, rule.original_digits, rule.new_phone, user.user_id, now));
    }
    for (const rule of phoneTargetRules?.results || []) {
      statements.push(env.GATEWAY_DB.prepare(
        "INSERT INTO platform_phone_target_rule_history (site_id, version, candidate_id, page_path, block_id, source, original_phone, original_digits, occurrence_index, scope, new_phone, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)"
      ).bind(siteId, version, rule.candidate_id, rule.page_path, rule.block_id, rule.source, rule.original_phone, rule.original_digits, rule.occurrence_index, rule.scope, rule.new_phone, user.user_id, now));
    }
    statements.push(
      env.GATEWAY_DB.prepare("DELETE FROM platform_phone_rules WHERE site_id = ?").bind(siteId),
      env.GATEWAY_DB.prepare("DELETE FROM platform_phone_target_rules WHERE site_id = ?").bind(siteId)
    );
  }
  await env.GATEWAY_DB.batch(statements);
  await audit(env, user, site.account_id, "site.overrides", "site", siteId, enabled ? "Включены" : "Выключены");
  return json({ ok: true, enabled: Boolean(enabled), version });
}

// Unlike validateTargetUrl (used for the site the Worker itself fetches),
// this only ever ends up as an <iframe src> the client's browser loads, so
// the query string (widget tokens/config) must survive intact.
function reviewWidgetUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Укажите полную ссылку src из кода виджета.");
  }
  if (url.protocol !== "https:" || !url.hostname) throw new Error("Ссылка на виджет должна быть полным HTTPS-адресом.");
  return url.href;
}

async function updateReviewSources(request, env, user, siteId) {
  if (user.platform_role !== "operator") fail("Доступ запрещён.", 403, "FORBIDDEN");
  const { site } = await siteAccess(env, user, siteId, "manager");
  const body = await requestJson(request);
  const current = await env.GATEWAY_DB.prepare(
    "SELECT yandex_widget_url, dgis_widget_url FROM platform_review_sources WHERE site_id = ?"
  ).bind(siteId).first();
  const yandexWidgetUrl = body.yandexWidgetUrl === undefined ? (current?.yandex_widget_url || null) : reviewWidgetUrl(body.yandexWidgetUrl);
  const dgisWidgetUrl = body.dgisWidgetUrl === undefined ? (current?.dgis_widget_url || null) : reviewWidgetUrl(body.dgisWidgetUrl);
  const now = new Date().toISOString();
  await env.GATEWAY_DB.prepare(
    "INSERT INTO platform_review_sources (site_id, yandex_widget_url, dgis_widget_url, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(site_id) DO UPDATE SET yandex_widget_url = excluded.yandex_widget_url, dgis_widget_url = excluded.dgis_widget_url, updated_at = excluded.updated_at, updated_by = excluded.updated_by"
  ).bind(siteId, yandexWidgetUrl, dgisWidgetUrl, now, user.user_id).run();
  await audit(env, user, site.account_id, "site.reviews.update", "site", siteId, [yandexWidgetUrl && "Яндекс", dgisWidgetUrl && "2ГИС"].filter(Boolean).join(", ") || "очищено");
  return json({ ok: true, yandexWidgetUrl, dgisWidgetUrl });
}

async function rollbackOverrides(request, env, user, siteId) {
  const { site } = await siteAccess(env, user, siteId, "manager");
  await requireLoaderConnection(env, site);
  const body = await requestJson(request);
  const requestedVersion = Number(body.version);
  if (!Number.isInteger(requestedVersion) || requestedVersion < 1) fail("Выберите версию для восстановления.");
  const [current, snapshot, ruleHistory, phoneRuleHistory, phoneTargetRuleHistory] = await Promise.all([
    env.GATEWAY_DB.prepare("SELECT * FROM platform_site_overrides WHERE site_id = ?").bind(siteId).first(),
    env.GATEWAY_DB.prepare("SELECT * FROM platform_override_history WHERE site_id = ? AND version = ?").bind(siteId, requestedVersion).first(),
    env.GATEWAY_DB.prepare("SELECT * FROM platform_button_rule_history WHERE site_id = ? AND version <= ? ORDER BY version DESC, id DESC")
      .bind(siteId, requestedVersion).all(),
    env.GATEWAY_DB.prepare("SELECT * FROM platform_phone_rule_history WHERE site_id = ? AND version <= ? ORDER BY version DESC, id DESC")
      .bind(siteId, requestedVersion).all(),
    env.GATEWAY_DB.prepare("SELECT * FROM platform_phone_target_rule_history WHERE site_id = ? AND version <= ? ORDER BY version DESC, id DESC")
      .bind(siteId, requestedVersion).all()
  ]);
  if (!current || !snapshot) fail("Эта версия больше недоступна.", 404, "NOT_FOUND");
  const version = Number(current.version) + 1;
  const now = new Date().toISOString();
  const restoredRules = [];
  const seenRules = new Set();
  for (const rule of ruleHistory?.results || []) {
    const key = `${rule.candidate_id}\u0000${rule.scope}`;
    if (seenRules.has(key)) continue;
    seenRules.add(key);
    if (Number(rule.enabled)) restoredRules.push(rule);
  }
  const restoredPhoneRules = [];
  const seenPhoneRules = new Set();
  for (const rule of phoneRuleHistory?.results || []) {
    if (seenPhoneRules.has(rule.original_digits)) continue;
    seenPhoneRules.add(rule.original_digits);
    if (Number(rule.enabled)) restoredPhoneRules.push(rule);
  }
  const restoredPhoneTargetRules = [];
  const seenPhoneTargetRules = new Set();
  for (const rule of phoneTargetRuleHistory?.results || []) {
    const key = `${rule.candidate_id}\u0000${rule.scope}`;
    if (seenPhoneTargetRules.has(key)) continue;
    seenPhoneTargetRules.add(key);
    if (Number(rule.enabled)) restoredPhoneTargetRules.push(rule);
  }
  const statements = [
    env.GATEWAY_DB.prepare(
      "UPDATE platform_site_overrides SET enabled = ?, phone = ?, schedule_text = ?, button_text = ?, button_url = ?, version = ?, updated_at = ? WHERE site_id = ?"
    ).bind(snapshot.enabled, snapshot.phone, snapshot.schedule_text, snapshot.button_text, snapshot.button_url, version, now, siteId),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_override_history (site_id, version, enabled, phone, schedule_text, button_text, button_url, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(siteId, version, snapshot.enabled, snapshot.phone, snapshot.schedule_text, snapshot.button_text, snapshot.button_url, user.user_id, now),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_change_records (site_id, version, kind, summary, target_label, status, created_by, created_at, confirmed_at) VALUES (?, ?, 'rollback', ?, 'Весь сайт', 'pending', ?, ?, NULL)"
    ).bind(siteId, version, `Восстановлена версия ${requestedVersion}`, user.user_id, now),
    env.GATEWAY_DB.prepare("DELETE FROM platform_button_rules WHERE site_id = ?").bind(siteId),
    env.GATEWAY_DB.prepare("DELETE FROM platform_phone_rules WHERE site_id = ?").bind(siteId),
    env.GATEWAY_DB.prepare("DELETE FROM platform_phone_target_rules WHERE site_id = ?").bind(siteId)
  ];
  for (const rule of restoredRules) {
    const ruleId = newId("rule", rule.candidate_id);
    statements.push(
      env.GATEWAY_DB.prepare(
        "INSERT INTO platform_button_rules (rule_id, site_id, candidate_id, page_path, block_id, original_text, original_url, match_index, scope, new_text, new_url, enabled, version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)"
      ).bind(ruleId, siteId, rule.candidate_id, rule.page_path, rule.block_id, rule.original_text, rule.original_url, rule.match_index, rule.scope, rule.new_text, rule.new_url, version, user.user_id, now, now),
      env.GATEWAY_DB.prepare(
        "INSERT INTO platform_button_rule_history (site_id, version, candidate_id, page_path, block_id, original_text, original_url, match_index, scope, new_text, new_url, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)"
      ).bind(siteId, version, rule.candidate_id, rule.page_path, rule.block_id, rule.original_text, rule.original_url, rule.match_index, rule.scope, rule.new_text, rule.new_url, user.user_id, now)
    );
  }
  for (const rule of restoredPhoneRules) {
    const ruleId = newId("phone", rule.original_digits);
    statements.push(
      env.GATEWAY_DB.prepare(
        "INSERT INTO platform_phone_rules (rule_id, site_id, original_phone, original_digits, new_phone, enabled, version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)"
      ).bind(ruleId, siteId, rule.original_phone, rule.original_digits, rule.new_phone, version, user.user_id, now, now),
      env.GATEWAY_DB.prepare(
        "INSERT INTO platform_phone_rule_history (site_id, version, original_phone, original_digits, new_phone, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)"
      ).bind(siteId, version, rule.original_phone, rule.original_digits, rule.new_phone, user.user_id, now)
    );
  }
  for (const rule of restoredPhoneTargetRules) {
    const ruleId = newId("phone_target", rule.candidate_id);
    statements.push(
      env.GATEWAY_DB.prepare(
        "INSERT INTO platform_phone_target_rules (rule_id, site_id, candidate_id, page_path, block_id, source, original_phone, original_digits, occurrence_index, scope, new_phone, enabled, version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)"
      ).bind(ruleId, siteId, rule.candidate_id, rule.page_path, rule.block_id, rule.source, rule.original_phone, rule.original_digits, rule.occurrence_index, rule.scope, rule.new_phone, version, user.user_id, now, now),
      env.GATEWAY_DB.prepare(
        "INSERT INTO platform_phone_target_rule_history (site_id, version, candidate_id, page_path, block_id, source, original_phone, original_digits, occurrence_index, scope, new_phone, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)"
      ).bind(siteId, version, rule.candidate_id, rule.page_path, rule.block_id, rule.source, rule.original_phone, rule.original_digits, rule.occurrence_index, rule.scope, rule.new_phone, user.user_id, now)
    );
  }
  await env.GATEWAY_DB.batch(statements);
  await audit(env, user, site.account_id, "site.overrides.rollback", "site", siteId, `Восстановлена версия ${requestedVersion}`);
  return json({ ok: true, version, restoredVersion: requestedVersion });
}

async function operatorBilling(request, env, user, accountId) {
  if (user.platform_role !== "operator") fail("Доступ запрещён.", 403, "FORBIDDEN");
  const account = await accountAccess(env, user, accountId, "owner");
  const body = await requestJson(request);
  const existingFeaturesResult = await env.GATEWAY_DB.prepare(
    "SELECT * FROM platform_account_features WHERE account_id = ?"
  ).bind(accountId).all();
  const existingFeatures = new Map((existingFeaturesResult?.results || []).map((row) => [row.feature_key, row]));
  let status = body.status === undefined ? (account.billing_status || "trial_pending") : String(body.status);
  if (!ACCESS_STATUSES.has(status)) fail("Некорректный статус доступа.");
  const extraSiteSlots = body.extraSiteSlots === undefined
    ? Math.max(0, Number(account.extra_site_slots) || 0)
    : Number(body.extraSiteSlots);
  if (!Number.isInteger(extraSiteSlots) || extraSiteSlots < 0 || extraSiteSlots > 100) fail("Дополнительных сайтов может быть от 0 до 100.");
  let currentPeriodEnd = body.currentPeriodEnd === undefined ? (account.current_period_end || null) : body.currentPeriodEnd || null;
  if (body.trialDays !== undefined) {
    const days = Number(body.trialDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) fail("Продление должно быть от 1 до 365 дней.");
    currentPeriodEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  } else if (currentPeriodEnd && !Number.isFinite(Date.parse(currentPeriodEnd))) {
    fail("Некорректная дата окончания доступа.");
  }
  if (status === "trial" && !currentPeriodEnd) {
    currentPeriodEnd = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  }
  const checkedCheckoutUrl = (raw) => {
    let value = String(raw || "").trim();
    if (!value) return "";
    let parsed;
    try { parsed = new URL(value); } catch { fail("Укажите корректную HTTPS-ссылку оплаты."); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || value.length > 1000) fail("Укажите корректную HTTPS-ссылку оплаты.");
    return parsed.href;
  };
  let checkoutUrl = checkedCheckoutUrl(body.checkoutUrl === undefined ? account.checkout_url || "" : body.checkoutUrl);
  const provider = body.provider === undefined ? String(account.billing_provider || "manual") : safeText(body.provider, 40);
  if (!new Set(["manual", "yookassa", "stripe"]).has(provider)) fail("Платёжный провайдер не поддерживается.");
  const now = new Date().toISOString();
  const normalizeFeature = (featureKey, raw, fallback) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const featureStatus = raw.status === undefined ? fallback?.status || "canceled" : String(raw.status);
    if (!ACCESS_STATUSES.has(featureStatus)) fail("Некорректный статус модуля.");
    let end = raw.currentPeriodEnd === undefined ? fallback?.current_period_end || null : raw.currentPeriodEnd || null;
    if (raw.trialDays !== undefined) {
      const days = Number(raw.trialDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) fail("Продление модуля должно быть от 1 до 365 дней.");
      end = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    } else if (end && !Number.isFinite(Date.parse(end))) {
      fail("Некорректная дата окончания модуля.");
    }
    if (featureStatus === "trial" && !end) end = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const featureProvider = raw.provider === undefined ? fallback?.provider || provider : safeText(raw.provider, 40);
    if (!new Set(["manual", "yookassa", "stripe"]).has(featureProvider)) fail("Платёжный провайдер не поддерживается.");
    const sourceProductKey = String(raw.sourceProductKey || fallback?.source_product_key || featureKey);
    if (!new Set(["manual", "control", "reviews", "bundle"]).has(sourceProductKey)) fail("Некорректный источник подписки.");
    return {
      featureKey,
      status: featureStatus,
      sourceProductKey,
      trialStartedAt: featureStatus === "trial" ? fallback?.trial_started_at || now : fallback?.trial_started_at || null,
      currentPeriodEnd: end,
      provider: featureProvider,
      providerSubscriptionId: safeText(raw.providerSubscriptionId ?? fallback?.provider_subscription_id ?? "", 180),
      checkoutUrl: checkedCheckoutUrl(raw.checkoutUrl === undefined ? fallback?.checkout_url || "" : raw.checkoutUrl)
    };
  };
  const requestedFeatures = body.features && typeof body.features === "object" && !Array.isArray(body.features) ? body.features : {};
  const controlFallback = existingFeatures.get("control") || {
    status,
    trial_started_at: account.trial_started_at,
    current_period_end: currentPeriodEnd,
    provider,
    checkout_url: checkoutUrl,
    source_product_key: "control"
  };
  let controlFeature = normalizeFeature("control", requestedFeatures.control, controlFallback);
  if (!controlFeature) {
    controlFeature = normalizeFeature("control", {
      status,
      currentPeriodEnd,
      provider,
      checkoutUrl,
      sourceProductKey: controlFallback.source_product_key || "control",
      trialDays: body.trialDays
    }, controlFallback);
  }
  const reviewsFeature = normalizeFeature("reviews", requestedFeatures.reviews, existingFeatures.get("reviews"));
  status = controlFeature.status;
  currentPeriodEnd = controlFeature.currentPeriodEnd;
  checkoutUrl = controlFeature.checkoutUrl || checkoutUrl;
  const trialStartedAt = status === "trial" ? (controlFeature.trialStartedAt || account.trial_started_at || now) : account.trial_started_at || null;
  const plan = status === "trial" || status === "trial_pending" ? "trial" : "starter";
  const summary = safeText(body.summary || `Контроль сайта: ${status}; отзывы: ${reviewsFeature?.status || existingFeatures.get("reviews")?.status || "canceled"}; дополнительных сайтов: ${extraSiteSlots}.`, 220);
  const statements = [
    env.GATEWAY_DB.prepare(
      "UPDATE platform_billing SET status = ?, trial_started_at = ?, current_period_end = ?, extra_site_slots = ?, provider = ?, checkout_url = ?, updated_at = ? WHERE account_id = ?"
    ).bind(status, trialStartedAt, currentPeriodEnd, extraSiteSlots, controlFeature.provider, checkoutUrl, now, accountId),
    env.GATEWAY_DB.prepare("UPDATE platform_accounts SET plan = ?, trial_ends_at = ?, updated_at = ? WHERE account_id = ?")
      .bind(plan, status === "trial" ? currentPeriodEnd : null, now, accountId),
    env.GATEWAY_DB.prepare("UPDATE platform_sites SET monitor_interval_minutes = ?, updated_at = ? WHERE account_id = ? AND integration_mode = 'central'")
      .bind(PLAN_LIMITS[plan].monitorMinutes, now, accountId),
    env.GATEWAY_DB.prepare("INSERT INTO platform_billing_events (account_id, kind, summary, created_by, created_at) VALUES (?, 'access.updated', ?, ?, ?)")
      .bind(accountId, summary, user.user_id, now)
  ];
  for (const feature of [controlFeature, reviewsFeature].filter(Boolean)) {
    statements.push(env.GATEWAY_DB.prepare(
      "INSERT INTO platform_account_features (account_id, feature_key, status, source_product_key, trial_started_at, current_period_end, provider, provider_subscription_id, checkout_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(account_id, feature_key) DO UPDATE SET status = excluded.status, source_product_key = excluded.source_product_key, trial_started_at = excluded.trial_started_at, current_period_end = excluded.current_period_end, provider = excluded.provider, provider_subscription_id = excluded.provider_subscription_id, checkout_url = excluded.checkout_url, updated_at = excluded.updated_at"
    ).bind(accountId, feature.featureKey, feature.status, feature.sourceProductKey, feature.trialStartedAt, feature.currentPeriodEnd, feature.provider, feature.providerSubscriptionId, feature.checkoutUrl, now));
  }
  await env.GATEWAY_DB.batch(statements);
  await audit(env, user, accountId, "billing.update", "account", accountId, summary);
  return json({ ok: true, status, currentPeriodEnd, extraSiteSlots, checkoutConfigured: Boolean(checkoutUrl), featuresUpdated: [controlFeature, reviewsFeature].filter(Boolean).map((feature) => feature.featureKey) });
}

async function operatorSupportNote(request, env, user, accountId) {
  if (user.platform_role !== "operator") fail("Доступ запрещён.", 403, "FORBIDDEN");
  await accountAccess(env, user, accountId, "owner");
  const body = await requestJson(request);
  const note = safeText(body.note, 1000);
  if (note.length < 2) fail("Введите заметку.");
  const now = new Date().toISOString();
  await env.GATEWAY_DB.prepare("INSERT INTO platform_support_notes (account_id, author_user_id, note, created_at) VALUES (?, ?, ?, ?)")
    .bind(accountId, user.user_id, note, now).run();
  await audit(env, user, accountId, "support.note", "account", accountId, "Добавлена внутренняя заметка.");
  return json({ ok: true, createdAt: now });
}

async function operatorProducts(request, env, user) {
  if (user.platform_role !== "operator") fail("Доступ запрещён.", 403, "FORBIDDEN");
  const body = await requestJson(request);
  const products = Array.isArray(body.products) ? body.products : [];
  if (!products.length || products.length > 3) fail("Передайте от одного до трёх продуктов.");
  const now = new Date().toISOString();
  const statements = [];
  for (const product of products) {
    const productKey = String(product?.productKey || "");
    if (!new Set(["control", "reviews", "bundle"]).has(productKey)) fail("Неизвестный продукт.");
    const name = safeText(product.name, 80);
    const description = safeText(product.description, 260);
    if (name.length < 2) fail("Укажите название продукта.");
    const priceMinor = Number(product.priceMinor);
    if (!Number.isInteger(priceMinor) || priceMinor < 0 || priceMinor > 100000000) fail("Некорректная цена продукта.");
    const currency = safeText(product.currency || "RUB", 8).toUpperCase();
    if (!/^[A-Z]{3}$/u.test(currency)) fail("Некорректная валюта.");
    const checkoutUrl = (() => {
      const raw = String(product.checkoutUrl || "").trim();
      if (!raw) return "";
      let url;
      try { url = new URL(raw); } catch { fail("Укажите корректную HTTPS-ссылку оплаты."); }
      if (url.protocol !== "https:" || url.username || url.password || raw.length > 1000) fail("Укажите корректную HTTPS-ссылку оплаты.");
      return url.href;
    })();
    statements.push(env.GATEWAY_DB.prepare(
      "UPDATE platform_products SET name = ?, description = ?, price_minor = ?, currency = ?, checkout_url = ?, active = ?, updated_at = ? WHERE product_key = ?"
    ).bind(name, description, priceMinor, currency, checkoutUrl, product.active === false ? 0 : 1, now, productKey));
  }
  await env.GATEWAY_DB.batch(statements);
  await audit(env, user, null, "billing.products.update", "system", null, `Продуктов обновлено: ${products.length}`);
  return json({ ok: true, updated: products.length });
}

async function billingCheckout(request, env, user, accountId) {
  const account = await accountAccess(env, user, accountId, "admin");
  const body = await requestJson(request);
  const productKey = String(body.productKey || "control");
  if (!new Set(["control", "reviews", "bundle"]).has(productKey)) fail("Неизвестный продукт.");
  const product = await env.GATEWAY_DB.prepare(
    "SELECT product_key, name, checkout_url, active FROM platform_products WHERE product_key = ?"
  ).bind(productKey).first();
  if (!product || !Number(product.active)) fail("Этот продукт сейчас недоступен.", 409, "PRODUCT_UNAVAILABLE");
  const feature = productKey === "bundle" ? null : await featureRow(env, accountId, productKey);
  const environmentUrl = productKey === "reviews"
    ? env.SITECARE_REVIEWS_CHECKOUT_URL
    : productKey === "bundle"
      ? env.SITECARE_BUNDLE_CHECKOUT_URL
      : env.SITECARE_CONTROL_CHECKOUT_URL || env.SITECARE_CHECKOUT_URL;
  const checkoutUrl = String(feature?.checkout_url || product.checkout_url || (productKey === "control" ? account.checkout_url : "") || environmentUrl || "").trim();
  const now = new Date().toISOString();
  const configured = (() => { try { return new URL(checkoutUrl).protocol === "https:"; } catch { return false; } })();
  await env.GATEWAY_DB.prepare(
    "INSERT INTO platform_billing_events (account_id, kind, summary, created_by, created_at) VALUES (?, 'checkout.requested', ?, ?, ?)"
  ).bind(accountId, `${configured ? "Клиент открыл оплату" : "Клиент запросил подключение"}: ${product.name}.`, user.user_id, now).run();
  if (configured) return json({ ok: true, productKey, checkoutUrl });
  return json({ ok: true, productKey, requested: true, message: `Запрос на «${product.name}» отправлен в поддержку SiteCare. Мы свяжемся с вами.` }, 202);
}

async function notifyNewLead(env, site, lead) {
  if (!env.TELEGRAM_BOT_TOKEN || !lead) return;
  const destination = await env.GATEWAY_DB.prepare(
    "SELECT chat_id FROM telegram_destinations WHERE site_id = ? AND enabled = 1"
  ).bind(site.site_id).first();
  if (!destination?.chat_id) return;
  const contact = [lead.payload.name, lead.payload.phone, lead.payload.email].filter(Boolean).join(" · ") || "Контакты не указаны";
  const page = lead.pageTitle || (() => { try { return new URL(lead.pageUrl).pathname || "/"; } catch { return "Сайт"; } })();
  const lines = [
    "📩 Новая заявка",
    site.name,
    contact,
    lead.payload.message ? safeText(lead.payload.message, 500) : "",
    `${lead.formLabel} · ${page}`
  ].filter(Boolean);
  try { await telegramSendMessage(env.TELEGRAM_BOT_TOKEN, destination.chat_id, lines.join("\n")); }
  catch { /* A Telegram outage must not make Tilda repeat the webhook. */ }
}

async function formWebhook(request, env, siteId) {
  if (!SITE_ID_PATTERN.test(siteId)) fail("Адрес webhook недействителен.", 401, "UNAUTHORIZED");
  const site = await env.GATEWAY_DB.prepare(
    "SELECT s.site_id, s.account_id, s.name, s.target_url, s.form_required, s.expected_form_count, s.webhook_token_hash, s.status, a.status AS account_status, a.plan, a.trial_ends_at, b.status AS billing_status, b.current_period_end, f.status AS feature_status, f.current_period_end AS feature_period_end FROM platform_sites s JOIN platform_accounts a ON a.account_id = s.account_id LEFT JOIN platform_billing b ON b.account_id = a.account_id LEFT JOIN platform_account_features f ON f.account_id = a.account_id AND f.feature_key = 'control' WHERE s.site_id = ?"
  ).bind(siteId).first();
  const provided = new URL(request.url).searchParams.get("token") || "";
  const providedHash = await digest("platform-form-webhook", provided);
  const controlFeature = site?.feature_status ? { status: site.feature_status, current_period_end: site.feature_period_end } : null;
  if (!site || site.status === "archived" || site.account_status !== "active" || !featureAllowsChanges(controlFeature, site) || !site.webhook_token_hash || !constantTimeEqual(providedHash, site.webhook_token_hash)) {
    fail("Адрес webhook недействителен.", 401, "UNAUTHORIZED");
  }
  const entries = await parseWebhookRequest(request);
  const now = new Date().toISOString();
  const isTildaHandshake = entries.length === 1 &&
    entries[0].name.toLocaleLowerCase("en-US") === "test" &&
    entries[0].value.toLocaleLowerCase("en-US") === "test";
  if (isTildaHandshake) {
    await env.GATEWAY_DB.prepare("UPDATE platform_sites SET webhook_verified_at = ?, updated_at = ? WHERE site_id = ?")
      .bind(now, now, siteId).run();
    return json({ ok: true, verified: true });
  }
  const metadata = await submissionMetadata(entries, env.TELEGRAM_WEBHOOK_SECRET || env.LEADS_DATA_KEY || "sitecare-webhook");
  const testMarker = testMarkerFromEntries(entries);
  let testSession = null;
  if (testMarker) {
    const markerHash = await hashTestMarker(testMarker, env.TELEGRAM_WEBHOOK_SECRET || env.LEADS_DATA_KEY || "sitecare-test");
    testSession = await env.GATEWAY_DB.prepare(
      "SELECT session_id FROM platform_form_test_sessions WHERE site_id = ? AND marker_hash = ? AND status = 'pending' AND expires_at > ? LIMIT 1"
    ).bind(siteId, markerHash, now).first();
  }
  const verifiedTest = Boolean(testSession);
  if (!verifiedTest) {
    const duplicate = await env.GATEWAY_DB.prepare(
      "SELECT lead_id FROM platform_webhook_dedup WHERE site_id = ? AND payload_hash = ? AND expires_at > ?"
    ).bind(siteId, metadata.payloadHash, now).first();
    if (duplicate) return json({ ok: true, leadId: duplicate.lead_id || null, duplicate: true, test: false });
  }
  const statements = [
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_form_receipts (site_id, received_at, form_id, field_names_json, field_count, payload_hash) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(siteId, now, metadata.formId, JSON.stringify(metadata.fieldNames), metadata.fieldCount, metadata.payloadHash),
    env.GATEWAY_DB.prepare("UPDATE platform_sites SET webhook_verified_at = COALESCE(webhook_verified_at, ?), last_form_at = ?, updated_at = ? WHERE site_id = ?").bind(now, now, now, siteId),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_usage_daily (account_id, usage_day, monitor_checks, form_signals, ai_requests) VALUES (?, ?, 0, 1, 0) ON CONFLICT(account_id, usage_day) DO UPDATE SET form_signals = form_signals + 1"
    ).bind(site.account_id, dayKey()),
    env.GATEWAY_DB.prepare(
      "DELETE FROM platform_form_receipts WHERE site_id = ? AND id NOT IN (SELECT id FROM platform_form_receipts WHERE site_id = ? ORDER BY id DESC LIMIT 500)"
    ).bind(siteId, siteId)
  ];
  if (metadata.formId) {
    statements.push(env.GATEWAY_DB.prepare(
      "INSERT INTO platform_form_connections (site_id, form_id, first_received_at, last_received_at, receipt_count) VALUES (?, ?, ?, ?, 1) " +
      "ON CONFLICT(site_id, form_id) DO UPDATE SET last_received_at = excluded.last_received_at, receipt_count = platform_form_connections.receipt_count + 1"
    ).bind(siteId, metadata.formId, now, now));
  }
  if (verifiedTest) {
    statements.push(env.GATEWAY_DB.prepare(
      "UPDATE platform_form_test_sessions SET status = 'confirmed', confirmed_at = ? WHERE session_id = ? AND status = 'pending'"
    ).bind(now, testSession.session_id));
  }
  let leadId = null;
  let normalized = null;
  let leadInsertIndex = -1;
  if (!verifiedTest) {
    normalized = normalizeLeadSubmission(entries, site, {
      ...metadata,
      referer: request.headers.get("Referer") || request.headers.get("HTTP-Referer") || ""
    });
    // Use a keyed, time-bucketed id so simultaneous Tilda retries resolve to
    // one row even when both requests pass the fast duplicate lookup above.
    // The HMAC-derived prefix contains no visitor data and changes after the
    // short deduplication window, so a genuinely new identical submission can
    // still be stored later.
    normalized.leadId = `lead_${metadata.payloadHash.slice(0, 26).toLocaleLowerCase("en-US")}_${Math.floor(Date.now() / (10 * 60 * 1000)).toString(36)}`;
    const protectedPayload = await encryptProtectedJson(env, normalized.payload);
    leadId = normalized.leadId;
    statements.push(
      env.GATEWAY_DB.prepare("DELETE FROM platform_webhook_dedup WHERE expires_at <= ?").bind(now),
      env.GATEWAY_DB.prepare(
        "INSERT OR IGNORE INTO platform_webhook_dedup (site_id, payload_hash, lead_id, received_at, expires_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(siteId, metadata.payloadHash, normalized.leadId, now, new Date(Date.now() + 10 * 60 * 1000).toISOString())
    );
    leadInsertIndex = statements.length;
    statements.push(
      env.GATEWAY_DB.prepare(
        "INSERT OR IGNORE INTO platform_leads (lead_id, site_id, account_id, received_at, form_id, form_label, page_url, page_title, source_label, status, payload_ciphertext, payload_iv, note_ciphertext, note_iv, payload_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, NULL, NULL, 1, ?)"
      ).bind(
        normalized.leadId,
        siteId,
        site.account_id,
        now,
        metadata.formId || null,
        normalized.formLabel,
        normalized.pageUrl,
        normalized.pageTitle,
        normalized.sourceLabel,
        protectedPayload.ciphertext,
        protectedPayload.iv,
        now
      )
    );
  }
  const batchResults = await env.GATEWAY_DB.batch(statements);
  const insertedLead = leadInsertIndex < 0 || Number(batchResults?.[leadInsertIndex]?.meta?.changes ?? batchResults?.[leadInsertIndex]?.changes ?? 1) > 0;
  const connected = await env.GATEWAY_DB.prepare(
    "SELECT COUNT(*) AS count FROM platform_form_connections WHERE site_id = ?"
  ).bind(siteId).first();
  const connectedForms = Number(connected?.count || 0);
  const expectedForms = Math.max(1, Number(site.expected_form_count) || 1);
  if (!Number(site.form_required) || connectedForms >= expectedForms) {
    await env.GATEWAY_DB.prepare("UPDATE platform_sites SET form_verified_at = COALESCE(form_verified_at, ?), updated_at = ? WHERE site_id = ?")
      .bind(now, now, siteId).run();
  }
  if (normalized && insertedLead) await notifyNewLead(env, site, normalized);
  return json({ ok: true, leadId, duplicate: Boolean(normalized && !insertedLead), test: verifiedTest, connectedForms, expectedForms });
}

async function publicConfig(request, env, siteId) {
  if (!SITE_ID_PATTERN.test(siteId)) fail("Конфигурация не найдена.", 404, "NOT_FOUND");
  const site = await env.GATEWAY_DB.prepare(
    "SELECT s.site_id, s.target_origin, s.target_pathname, s.scope, s.status, s.loader_key, o.enabled, o.phone, o.schedule_text, o.button_text, o.button_url, o.version, a.status AS account_status FROM platform_sites s JOIN platform_site_overrides o ON o.site_id = s.site_id JOIN platform_accounts a ON a.account_id = s.account_id WHERE s.site_id = ?"
  ).bind(siteId).first();
  const key = new URL(request.url).searchParams.get("key") || "";
  if (!site || !constantTimeEqual(key, site.loader_key)) fail("Конфигурация не найдена.", 404, "NOT_FOUND");
  const origin = request.headers.get("Origin") || "";
  if (origin && origin !== site.target_origin) fail("Страница не входит в подключённый сайт.", 403, "ORIGIN_REJECTED");
  const [rules, phoneRules, phoneTargetRules] = await Promise.all([
    env.GATEWAY_DB.prepare(
      "SELECT candidate_id, page_path, block_id, original_text, original_url, match_index, scope, new_text, new_url, version FROM platform_button_rules WHERE site_id = ? AND enabled = 1 ORDER BY updated_at"
    ).bind(siteId).all(),
    env.GATEWAY_DB.prepare(
      "SELECT original_phone, original_digits, new_phone, version FROM platform_phone_rules WHERE site_id = ? AND enabled = 1 ORDER BY updated_at"
    ).bind(siteId).all(),
    env.GATEWAY_DB.prepare(
      "SELECT candidate_id, page_path, block_id, source, original_phone, original_digits, occurrence_index, scope, new_phone, version FROM platform_phone_target_rules WHERE site_id = ? AND enabled = 1 ORDER BY updated_at"
    ).bind(siteId).all()
  ]);
  return json({
    ok: true,
    siteId,
    origin: site.target_origin,
    pathname: site.target_pathname,
    scope: site.scope,
    enabled: site.status === "active" && site.account_status === "active" && Boolean(site.enabled),
    phone: site.phone,
    phoneRules: (phoneRules?.results || []).map((rule) => ({
      originalPhone: rule.original_phone,
      originalDigits: rule.original_digits,
      newPhone: rule.new_phone,
      version: Number(rule.version)
    })),
    phoneTargetRules: (phoneTargetRules?.results || []).map((rule) => ({
      candidateId: rule.candidate_id,
      pagePath: rule.page_path,
      blockId: rule.block_id,
      source: rule.source,
      originalPhone: rule.original_phone,
      originalDigits: rule.original_digits,
      occurrenceIndex: Number(rule.occurrence_index),
      scope: rule.scope,
      newPhone: rule.new_phone,
      version: Number(rule.version)
    })),
    scheduleText: site.schedule_text,
    buttonText: site.button_text,
    buttonUrl: site.button_url,
    buttonRules: (rules?.results || []).map((rule) => ({
      candidateId: rule.candidate_id,
      pagePath: rule.page_path,
      blockId: rule.block_id,
      originalText: rule.original_text,
      originalUrl: rule.original_url,
      matchIndex: Number(rule.match_index),
      scope: rule.scope,
      newText: rule.new_text,
      newUrl: rule.new_url,
      version: Number(rule.version)
    })),
    version: Number(site.version)
  }, 200, origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Cross-Origin-Resource-Policy": "cross-origin" } : {});
}

function corsForSite(origin) {
  return origin ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
    "Cross-Origin-Resource-Policy": "cross-origin"
  } : {};
}

async function runtimeApplied(request, env, siteId) {
  if (!SITE_ID_PATTERN.test(siteId)) fail("Конфигурация не найдена.", 404, "NOT_FOUND");
  const site = await env.GATEWAY_DB.prepare(
    "SELECT s.site_id, s.target_origin, s.loader_key, o.version, o.enabled, o.phone, o.schedule_text, o.button_text, o.button_url, " +
    "(SELECT COUNT(*) FROM platform_phone_rules pr WHERE pr.site_id = s.site_id AND pr.enabled = 1) AS phone_rule_count, " +
    "(SELECT COUNT(*) FROM platform_phone_target_rules ptr WHERE ptr.site_id = s.site_id AND ptr.enabled = 1) AS phone_target_count, " +
    "(SELECT COUNT(*) FROM platform_button_rules br WHERE br.site_id = s.site_id AND br.enabled = 1) AS button_rule_count " +
    "FROM platform_sites s JOIN platform_site_overrides o ON o.site_id = s.site_id WHERE s.site_id = ?"
  ).bind(siteId).first();
  const key = new URL(request.url).searchParams.get("key") || "";
  if (!site || !constantTimeEqual(key, site.loader_key)) fail("Конфигурация не найдена.", 404, "NOT_FOUND");
  const origin = request.headers.get("Origin") || "";
  if (!origin || origin !== site.target_origin) fail("Страница не входит в подключённый сайт.", 403, "ORIGIN_REJECTED");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: securityHeaders(corsForSite(origin)) });
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > 8 * 1024) fail("Отчёт слишком большой.", 413, "PAYLOAD_TOO_LARGE");
  let body;
  try { body = JSON.parse(raw); } catch { fail("Некорректный отчёт."); }
  const version = Number(body?.version);
  if (!Number.isInteger(version) || version < 1 || version > Number(site.version)) fail("Некорректная версия отчёта.");
  const pathname = String(body?.pathname || "/").startsWith("/") ? safeText(body.pathname || "/", 500) : "/";
  const count = (value) => Math.min(10000, Math.max(0, Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0));
  const phoneCount = count(body?.phoneCount);
  const scheduleCount = count(body?.scheduleCount);
  const buttonCount = count(body?.buttonCount);
  const phoneVerified = body?.phoneVerified === true ? 1 : 0;
  const scheduleVerified = body?.scheduleVerified === true ? 1 : 0;
  const buttonVerified = body?.buttonVerified === true ? 1 : 0;
  const errorText = safeText(body?.error, 300);
  const expectsPhone = Boolean(site.phone) || Number(site.phone_rule_count) > 0 || Number(site.phone_target_count) > 0;
  const expectsSchedule = Boolean(site.schedule_text);
  const expectsButton = Boolean(site.button_text) || Boolean(site.button_url) || Number(site.button_rule_count) > 0;
  const rollbackVerified = !errorText && (!Number(site.enabled) || (
    (!expectsPhone || phoneVerified === 1) &&
    (!expectsSchedule || scheduleVerified === 1) &&
    (!expectsButton || buttonVerified === 1)
  )) ? 1 : 0;
  const now = new Date().toISOString();
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_runtime_reports (site_id, pathname, config_version, phone_count, schedule_count, button_count, phone_verified, schedule_verified, button_verified, error_text, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(site_id, pathname) DO UPDATE SET config_version = excluded.config_version, phone_count = excluded.phone_count, schedule_count = excluded.schedule_count, button_count = excluded.button_count, phone_verified = excluded.phone_verified, schedule_verified = excluded.schedule_verified, button_verified = excluded.button_verified, error_text = excluded.error_text, reported_at = excluded.reported_at"
    ).bind(siteId, pathname, version, phoneCount, scheduleCount, buttonCount, phoneVerified, scheduleVerified, buttonVerified, errorText, now),
    env.GATEWAY_DB.prepare(
      "UPDATE platform_change_records SET status = CASE WHEN status = 'confirmed' THEN 'confirmed' WHEN (kind = 'rollback' AND ? = 1) OR (kind = 'phone' AND ? = 1) OR (kind = 'schedule' AND ? = 1) OR (kind IN ('button_text','button_url') AND ? = 1) THEN 'confirmed' ELSE 'not_found' END, confirmed_at = CASE WHEN (kind = 'rollback' AND ? = 1) OR (kind = 'phone' AND ? = 1) OR (kind = 'schedule' AND ? = 1) OR (kind IN ('button_text','button_url') AND ? = 1) THEN ? ELSE confirmed_at END WHERE site_id = ? AND version = ?"
    ).bind(rollbackVerified, phoneVerified, scheduleVerified, buttonVerified, rollbackVerified, phoneVerified, scheduleVerified, buttonVerified, now, siteId, version)
  ]);
  return json({ ok: true }, 200, corsForSite(origin));
}

async function reportSiteSelection(request, env, siteId) {
  if (!SITE_ID_PATTERN.test(siteId)) fail("Конфигурация не найдена.", 404, "NOT_FOUND");
  const site = await env.GATEWAY_DB.prepare("SELECT site_id, target_origin, loader_key FROM platform_sites WHERE site_id = ?").bind(siteId).first();
  const key = new URL(request.url).searchParams.get("key") || "";
  if (!site || !constantTimeEqual(key, site.loader_key)) fail("Конфигурация не найдена.", 404, "NOT_FOUND");
  const origin = request.headers.get("Origin") || "";
  if (!origin || origin !== site.target_origin) fail("Страница не входит в подключённый сайт.", 403, "ORIGIN_REJECTED");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: securityHeaders(corsForSite(origin)) });
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > 2 * 1024) fail("Слишком большой запрос.", 413, "PAYLOAD_TOO_LARGE");
  let body;
  try { body = JSON.parse(raw); } catch { fail("Некорректные данные."); }
  if (body?.kind !== "phone") fail("Неподдерживаемый тип выбора.");
  const digits = String(body?.originalDigits || "").replace(/\D/gu, "");
  if (digits.length < 10 || digits.length > 15) fail("Не удалось распознать номер.");
  const payload = {
    kind: "phone",
    pagePath: safeText(body.pagePath, 300) || "/",
    blockId: safeText(body.blockId, 60),
    source: body.source === "link" ? "link" : "text",
    occurrenceIndex: Number.isFinite(Number(body.occurrenceIndex)) ? Number(body.occurrenceIndex) : 0,
    originalDigits: digits,
    phone: safeText(body.phone, 60)
  };
  await env.GATEWAY_DB.prepare(
    "INSERT INTO platform_pending_selections (site_id, payload, created_at) VALUES (?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at"
  ).bind(siteId, JSON.stringify(payload), new Date().toISOString()).run();
  return json({ ok: true }, 200, corsForSite(origin));
}

async function siteSelectionResult(env, user, siteId) {
  const { site } = await siteAccess(env, user, siteId, "viewer");
  const row = await env.GATEWAY_DB.prepare("SELECT payload, created_at FROM platform_pending_selections WHERE site_id = ?").bind(site.site_id).first();
  if (!row) return json({ ok: true, selection: null });
  await env.GATEWAY_DB.prepare("DELETE FROM platform_pending_selections WHERE site_id = ?").bind(site.site_id).run();
  const freshEnoughMs = 10 * 60 * 1000;
  if (Date.now() - Date.parse(row.created_at) > freshEnoughMs) return json({ ok: true, selection: null });
  let payload = null;
  try { payload = JSON.parse(row.payload); } catch { payload = null; }
  return json({ ok: true, selection: payload });
}

async function telegramStatus(env, user, siteId) {
  await siteAccess(env, user, siteId, "viewer");
  const row = await env.GATEWAY_DB.prepare("SELECT chat_type, linked_at, enabled FROM telegram_destinations WHERE site_id = ?").bind(siteId).first();
  const bot = await env.GATEWAY_DB.prepare("SELECT value FROM gateway_settings WHERE key = 'bot_username'").first();
  return json({ ok: true, configured: Boolean(row?.enabled), destination: row?.enabled ? row.chat_type === "private" ? "личный чат" : "группа" : null, linkedAt: row?.linked_at || null, botUsername: bot?.value || null });
}

async function telegramConnect(request, env, user, siteId) {
  const { site } = await siteAccess(env, user, siteId, "manager");
  const bot = await env.GATEWAY_DB.prepare("SELECT value FROM gateway_settings WHERE key = 'bot_username'").first();
  if (!bot?.value) fail("Официальный SiteCareBot ещё не настроен.", 503, "BOT_NOT_CONFIGURED");
  const parameter = `sc_${randomToken(24)}`;
  const tokenHash = await digest("connect-token", parameter);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare("DELETE FROM telegram_connect_sessions WHERE site_id = ? AND used_at IS NULL").bind(siteId),
    env.GATEWAY_DB.prepare("INSERT INTO telegram_connect_sessions (token_hash, site_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)")
      .bind(tokenHash, siteId, now.toISOString(), expiresAt)
  ]);
  await audit(env, user, site.account_id, "telegram.connect.start", "site", siteId);
  return json({ ok: true, connectUrl: `https://t.me/${bot.value}?start=${parameter}`, botUsername: bot.value, expiresAt, expiresInMinutes: 15 });
}

async function telegramTest(env, user, siteId) {
  const { site } = await siteAccess(env, user, siteId, "manager");
  const destination = await env.GATEWAY_DB.prepare("SELECT chat_id, enabled FROM telegram_destinations WHERE site_id = ?").bind(siteId).first();
  if (!destination?.enabled) fail("Сначала подключите Telegram.", 409, "NOT_LINKED");
  await telegramSendMessage(env.TELEGRAM_BOT_TOKEN, destination.chat_id, `✅ SiteCare работает\n${site.name}\n${site.target_url}\nТестовое уведомление доставлено.`);
  await audit(env, user, site.account_id, "telegram.test", "site", siteId);
  return json({ ok: true, sent: true });
}

async function telegramDisconnect(env, user, siteId) {
  const { site } = await siteAccess(env, user, siteId, "admin");
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare("DELETE FROM telegram_destinations WHERE site_id = ?").bind(siteId),
    env.GATEWAY_DB.prepare("DELETE FROM telegram_connect_sessions WHERE site_id = ?").bind(siteId)
  ]);
  await audit(env, user, site.account_id, "telegram.disconnect", "site", siteId);
  return json({ ok: true });
}

async function inviteMember(request, env, user, accountId) {
  const account = await accountAccess(env, user, accountId, "admin");
  const body = await requestJson(request);
  const invite = await createInvite(env, new URL(request.url).origin, account, user, body.email, body.role);
  await audit(env, user, accountId, "member.invite", "account", accountId, `${invite.email}; ${invite.role}`);
  return json({ ok: true, inviteUrl: invite.inviteUrl, expiresAt: invite.expiresAt });
}

async function updateMember(request, env, user, accountId, memberId) {
  const account = await accountAccess(env, user, accountId, "owner");
  const body = await requestJson(request);
  const role = validateRole(body.role);
  const target = await env.GATEWAY_DB.prepare("SELECT role FROM platform_memberships WHERE account_id = ? AND user_id = ?").bind(accountId, memberId).first();
  if (!target || target.role === "owner") fail("Роль владельца нельзя изменить этим действием.", 409, "OWNER_PROTECTED");
  await env.GATEWAY_DB.prepare("UPDATE platform_memberships SET role = ?, updated_at = ? WHERE account_id = ? AND user_id = ?")
    .bind(role, new Date().toISOString(), accountId, memberId).run();
  await audit(env, user, account.account_id, "member.role", "user", memberId, role);
  return json({ ok: true });
}

async function accountLeadPage(request, env, user, accountId) {
  await accountAccess(env, user, accountId, "viewer");
  const url = new URL(request.url);
  const limit = Math.max(10, Math.min(100, Number(url.searchParams.get("limit")) || 50));
  const before = String(url.searchParams.get("before") || "");
  const beforeId = String(url.searchParams.get("beforeId") || "");
  const hasCursor = Boolean(before && !Number.isNaN(Date.parse(before)) && /^lead_[a-z0-9_-]{4,100}$/u.test(beforeId));
  const statement = hasCursor
    ? env.GATEWAY_DB.prepare(
      "SELECT l.*, s.name AS site_name FROM platform_leads l JOIN platform_sites s ON s.site_id = l.site_id " +
      "WHERE l.account_id = ? AND (l.received_at < ? OR (l.received_at = ? AND l.lead_id < ?)) " +
      "ORDER BY l.received_at DESC, l.lead_id DESC LIMIT ?"
    ).bind(accountId, before, before, beforeId, limit + 1)
    : env.GATEWAY_DB.prepare(
      "SELECT l.*, s.name AS site_name FROM platform_leads l JOIN platform_sites s ON s.site_id = l.site_id " +
      "WHERE l.account_id = ? ORDER BY l.received_at DESC, l.lead_id DESC LIMIT ?"
    ).bind(accountId, limit + 1);
  const result = await statement.all();
  const rows = result?.results || [];
  const pageRows = rows.slice(0, limit);
  const leads = await Promise.all(pageRows.map((row) => leadRowToPublic(env, row)));
  const last = leads.at(-1) || null;
  return json({
    ok: true,
    leads,
    hasMore: rows.length > limit,
    cursor: last ? { receivedAt: last.receivedAt, leadId: last.leadId } : null
  });
}

async function updateLead(request, env, user, leadId) {
  if (!/^lead_[a-z0-9_-]{4,100}$/u.test(String(leadId || ""))) fail("Некорректная заявка.");
  const lead = await env.GATEWAY_DB.prepare("SELECT * FROM platform_leads WHERE lead_id = ?").bind(leadId).first();
  if (!lead) fail("Заявка не найдена.", 404, "NOT_FOUND");
  await siteAccess(env, user, lead.site_id, "manager");
  const body = await requestJson(request);
  const status = body.status === undefined ? lead.status : String(body.status);
  if (!LEAD_STATUSES.has(status)) fail("Некорректный статус заявки.");
  let noteCiphertext = lead.note_ciphertext || null;
  let noteIv = lead.note_iv || null;
  if (body.note !== undefined) {
    const note = safeText(body.note, 2000);
    if (note) {
      const protectedNote = await encryptProtectedJson(env, { note });
      noteCiphertext = protectedNote.ciphertext;
      noteIv = protectedNote.iv;
    } else {
      noteCiphertext = null;
      noteIv = null;
    }
  }
  const now = new Date().toISOString();
  await env.GATEWAY_DB.prepare(
    "UPDATE platform_leads SET status = ?, note_ciphertext = ?, note_iv = ?, updated_at = ? WHERE lead_id = ?"
  ).bind(status, noteCiphertext, noteIv, now, leadId).run();
  await audit(env, user, lead.account_id, "lead.update", "lead", leadId, `Статус: ${status}`);
  const updated = await env.GATEWAY_DB.prepare(
    "SELECT l.*, s.name AS site_name FROM platform_leads l JOIN platform_sites s ON s.site_id = l.site_id WHERE l.lead_id = ?"
  ).bind(leadId).first();
  return json({ ok: true, lead: await leadRowToPublic(env, updated) });
}

async function operatorAccountUser(env, user, accountId, userId) {
  if (user.platform_role !== "operator") fail("Доступ запрещён.", 403, "FORBIDDEN");
  await accountAccess(env, user, accountId, "owner");
  const target = await env.GATEWAY_DB.prepare(
    "SELECT u.user_id, u.email, u.display_name, u.status, u.platform_role, m.role FROM platform_users u JOIN platform_memberships m ON m.user_id = u.user_id WHERE m.account_id = ? AND u.user_id = ?"
  ).bind(accountId, userId).first();
  if (!target) fail("Пользователь не найден.", 404, "NOT_FOUND");
  return target;
}

async function operatorAccessLink(request, env, user, accountId, userId) {
  const target = await operatorAccountUser(env, user, accountId, userId);
  const body = await requestJson(request);
  const reset = await createPasswordResetToken(env, userId);
  const resetUrl = `${new URL(request.url).origin}/reset-password?token=${encodeURIComponent(reset.token)}`;
  let emailSent = false;
  if (body.sendEmail === true && emailDeliveryConfigured(env)) {
    try {
      await sendPasswordResetEmail(env, {
        to: target.email,
        resetUrl,
        expiresInMinutes: PASSWORD_RESET_MINUTES,
        requestId: reset.tokenHash
      });
      emailSent = true;
    } catch (error) {
      console.error("SiteCare operator access email failed:", safeText(error?.code || error?.message || "unknown", 120));
    }
  }
  const now = new Date().toISOString();
  await env.GATEWAY_DB.prepare(
    "UPDATE platform_access_requests SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE user_id = ? AND account_id = ? AND status = 'pending'"
  ).bind(now, user.user_id, userId, accountId).run();
  await audit(env, user, accountId, "access.link", "user", userId, emailSent ? "Ссылка отправлена по почте." : "Одноразовая ссылка создана.");
  return json({ ok: true, resetUrl, expiresAt: reset.expiresAt, emailSent });
}

async function operatorCloseSessions(env, user, accountId, userId) {
  await operatorAccountUser(env, user, accountId, userId);
  await env.GATEWAY_DB.prepare("DELETE FROM platform_sessions WHERE user_id = ?").bind(userId).run();
  await audit(env, user, accountId, "access.sessions.close", "user", userId, "Все сеансы завершены.");
  return json({ ok: true });
}

async function operatorUserStatus(request, env, user, accountId, userId) {
  const target = await operatorAccountUser(env, user, accountId, userId);
  if (target.platform_role === "operator" || userId === user.user_id) fail("Доступ владельца платформы нельзя приостановить здесь.", 409, "OWNER_PROTECTED");
  const body = await requestJson(request);
  const status = String(body.status || "");
  if (!new Set(["active", "suspended"]).has(status)) fail("Некорректный статус доступа.");
  const storedStatus = status === "suspended" ? "blocked" : "active";
  const now = new Date().toISOString();
  const statements = [env.GATEWAY_DB.prepare("UPDATE platform_users SET status = ?, updated_at = ? WHERE user_id = ?").bind(storedStatus, now, userId)];
  if (status === "suspended") statements.push(env.GATEWAY_DB.prepare("DELETE FROM platform_sessions WHERE user_id = ?").bind(userId));
  await env.GATEWAY_DB.batch(statements);
  await audit(env, user, accountId, "access.status", "user", userId, status);
  return json({ ok: true, status });
}

async function operatorActivationLink(request, env, user, accountId) {
  if (user.platform_role !== "operator") fail("Доступ запрещён.", 403, "FORBIDDEN");
  const account = await accountAccess(env, user, accountId, "owner");
  const body = await requestJson(request);
  const email = normalizeEmail(body.email);
  const role = body.role || "owner";
  const now = new Date().toISOString();
  await env.GATEWAY_DB.prepare(
    "UPDATE platform_invites SET expires_at = ? WHERE account_id = ? AND email = ? AND accepted_at IS NULL"
  ).bind(now, accountId, email).run();
  const invite = await createInvite(env, new URL(request.url).origin, account, user, email, role);
  await audit(env, user, accountId, "access.activation", "account", accountId, `Новая ссылка для ${email}`);
  return json({ ok: true, inviteUrl: invite.inviteUrl, expiresAt: invite.expiresAt });
}

export async function handlePlatformRoute(request, env, path) {
  if (request.method === "GET" && (path === "/" || path === "/app" || path === "/admin")) {
    const nonce = randomToken(18);
    return html(platformHtml(nonce), nonce);
  }
  if (request.method === "GET" && path === "/accept") {
    const nonce = randomToken(18);
    const token = new URL(request.url).searchParams.get("token") || "";
    return html(inviteHtml(nonce, OPAQUE_PATTERN.test(token) ? token : ""), nonce);
  }
  if (request.method === "GET" && path === "/reset-password") {
    const nonce = randomToken(18);
    const token = new URL(request.url).searchParams.get("token") || "";
    return html(resetPasswordHtml(nonce, OPAQUE_PATTERN.test(token) ? token : ""), nonce);
  }
  if (request.method === "GET" && path === "/sitecare-loader.js") return javascript(loaderJavascript());

  if (request.method === "GET" && path === "/v1/admin/platform/status") {
    requireGatewayAdmin(request, env);
    return json(await platformStatus(env));
  }
  if (request.method === "POST" && path === "/v1/admin/platform/bootstrap") return bootstrapPlatform(request, env);
  if (request.method === "POST" && path === "/v1/admin/platform/email/test") return testPasswordEmail(request, env);
  if (request.method === "GET" && path === "/v1/platform/auth/password/status") return passwordResetStatus(env);
  if (request.method === "POST" && path === "/v1/platform/auth/password/request") return requestPasswordReset(request, env);
  if (request.method === "POST" && path === "/v1/platform/auth/password/reset") return resetPassword(request, env);
  if (request.method === "POST" && path === "/v1/platform/auth/trial/request") return closedRegistration(request);
  if (request.method === "POST" && path === "/v1/platform/auth/login") return login(request, env);
  if (request.method === "POST" && path === "/v1/platform/invites/accept") return acceptInvite(request, env);

  let match = /^\/v1\/platform\/forms\/([a-z0-9][a-z0-9_-]{2,79})\/webhook$/u.exec(path);
  if (request.method === "POST" && match) return formWebhook(request, env, match[1]);
  match = /^\/v1\/public\/sites\/([a-z0-9][a-z0-9_-]{2,79})\/config$/u.exec(path);
  if (request.method === "GET" && match) return publicConfig(request, env, match[1]);
  match = /^\/v1\/public\/sites\/([a-z0-9][a-z0-9_-]{2,79})\/applied$/u.exec(path);
  if ((request.method === "POST" || request.method === "OPTIONS") && match) return runtimeApplied(request, env, match[1]);
  match = /^\/v1\/public\/sites\/([a-z0-9][a-z0-9_-]{2,79})\/select$/u.exec(path);
  if ((request.method === "POST" || request.method === "OPTIONS") && match) return reportSiteSelection(request, env, match[1]);

  if (!path.startsWith("/v1/platform/")) return null;
  const csrf = request.method !== "GET" && request.method !== "HEAD";
  const user = await sessionUser(request, env, { csrf });
  if (request.method === "GET" && path === "/v1/platform/session") {
    const memberships = await env.GATEWAY_DB.prepare("SELECT account_id FROM platform_memberships WHERE user_id = ? ORDER BY created_at").bind(user.user_id).all();
    return json({ ok: true, csrf: user.csrf_token, accounts: memberships?.results || [], platformRole: user.platform_role });
  }
  if (request.method === "POST" && path === "/v1/platform/auth/logout") return logout(request, env);
  if (request.method === "POST" && path === "/v1/platform/profile/password") return changePassword(request, env, user);
  if (request.method === "GET" && path === "/v1/platform/dashboard") return dashboard(request, env, user);
  if (request.method === "POST" && path === "/v1/platform/operator/accounts") return createOperatorAccount(request, env, user);
  if (request.method === "PATCH" && path === "/v1/platform/operator/products") return operatorProducts(request, env, user);
  if (request.method === "GET" && path === "/v1/platform/support") return operatorSupportList(env, user);

  match = /^\/v1\/platform\/support\/(status|connect|test|disconnect)$/u.exec(path);
  if (match) {
    if (request.method === "GET" && match[1] === "status") return supportTelegramStatus(env, user);
    if (request.method === "POST" && match[1] === "connect") return supportTelegramConnect(env, user);
    if (request.method === "POST" && match[1] === "test") return supportTelegramTest(env, user);
    if (request.method === "POST" && match[1] === "disconnect") return supportTelegramDisconnect(env, user);
  }
  match = /^\/v1\/platform\/support\/(sup_[a-z0-9_-]{4,120})$/u.exec(path);
  if (match) {
    if (request.method === "GET") return operatorSupportDetails(env, user, match[1]);
    if (request.method === "POST") return operatorSupportUpdate(request, env, user, match[1]);
  }

  match = /^\/v1\/platform\/operator\/accounts\/(acc_[a-z0-9_-]{4,80})$/u.exec(path);
  if (request.method === "PATCH" && match) return updateOperatorAccount(request, env, user, match[1]);
  match = /^\/v1\/platform\/operator\/accounts\/(acc_[a-z0-9_-]{4,80})\/billing$/u.exec(path);
  if (request.method === "PATCH" && match) return operatorBilling(request, env, user, match[1]);
  match = /^\/v1\/platform\/operator\/accounts\/(acc_[a-z0-9_-]{4,80})\/notes$/u.exec(path);
  if (request.method === "POST" && match) return operatorSupportNote(request, env, user, match[1]);
  match = /^\/v1\/platform\/operator\/accounts\/(acc_[a-z0-9_-]{4,80})\/activation$/u.exec(path);
  if (request.method === "POST" && match) return operatorActivationLink(request, env, user, match[1]);
  match = /^\/v1\/platform\/operator\/accounts\/(acc_[a-z0-9_-]{4,80})\/users\/(usr_[a-z0-9_-]{4,100})\/(access-link|sessions|status)$/u.exec(path);
  if (match) {
    if (request.method === "POST" && match[3] === "access-link") return operatorAccessLink(request, env, user, match[1], match[2]);
    if (request.method === "POST" && match[3] === "sessions") return operatorCloseSessions(env, user, match[1], match[2]);
    if (request.method === "PATCH" && match[3] === "status") return operatorUserStatus(request, env, user, match[1], match[2]);
  }
  match = /^\/v1\/platform\/accounts\/(acc_[a-z0-9_-]{4,80})\/invites$/u.exec(path);
  if (request.method === "POST" && match) return inviteMember(request, env, user, match[1]);
  match = /^\/v1\/platform\/accounts\/(acc_[a-z0-9_-]{4,80})\/members\/(usr_[a-z0-9_-]{4,80})$/u.exec(path);
  if (request.method === "PATCH" && match) return updateMember(request, env, user, match[1], match[2]);
  match = /^\/v1\/platform\/accounts\/(acc_[a-z0-9_-]{4,80})\/leads$/u.exec(path);
  if (request.method === "GET" && match) return accountLeadPage(request, env, user, match[1]);
  match = /^\/v1\/platform\/accounts\/(acc_[a-z0-9_-]{4,80})\/sites$/u.exec(path);
  if (request.method === "POST" && match) return addSite(request, env, user, match[1]);
  match = /^\/v1\/platform\/accounts\/(acc_[a-z0-9_-]{4,80})\/check$/u.exec(path);
  if (request.method === "POST" && match) return checkAccountSites(env, user, match[1]);
  match = /^\/v1\/platform\/accounts\/(acc_[a-z0-9_-]{4,80})\/billing\/checkout$/u.exec(path);
  if (request.method === "POST" && match) return billingCheckout(request, env, user, match[1]);
  match = /^\/v1\/platform\/leads\/(lead_[a-z0-9_-]{4,100})$/u.exec(path);
  if (request.method === "PATCH" && match) return updateLead(request, env, user, match[1]);

  match = /^\/v1\/platform\/sites\/([a-z0-9][a-z0-9_-]{2,79})$/u.exec(path);
  if (request.method === "PATCH" && match) return updateSite(request, env, user, match[1]);
  match = /^\/v1\/platform\/sites\/([a-z0-9][a-z0-9_-]{2,79})\/(check|integration|report|content-changes|incidents|health-history)$/u.exec(path);
  if (match) {
    if (request.method === "POST" && match[2] === "check") return checkOneSite(env, user, match[1]);
    if (request.method === "GET" && match[2] === "integration") return integration(request, env, user, match[1]);
    if (request.method === "GET" && match[2] === "report") {
      await siteAccess(env, user, match[1], "viewer");
      return json({ ok: true, ...(await siteReport(env, match[1], Number(new URL(request.url).searchParams.get("days") || 30))) });
    }
    if (request.method === "GET" && match[2] === "content-changes") return siteContentChanges(env, user, match[1]);
    if (request.method === "GET" && match[2] === "incidents") {
      return siteIncidents(env, user, match[1], Number(new URL(request.url).searchParams.get("limit") || 10));
    }
    if (request.method === "GET" && match[2] === "health-history") {
      return siteHealthHistory(env, user, match[1], Number(new URL(request.url).searchParams.get("limit") || 10));
    }
  }
  match = /^\/v1\/platform\/sites\/([a-z0-9][a-z0-9_-]{2,79})\/webhook\/rotate$/u.exec(path);
  if (request.method === "POST" && match) return rotateWebhook(request, env, user, match[1]);
  match = /^\/v1\/platform\/sites\/([a-z0-9][a-z0-9_-]{2,79})\/forms\/test$/u.exec(path);
  if (request.method === "POST" && match) return createFormTestSession(env, user, match[1]);
  match = /^\/v1\/platform\/sites\/([a-z0-9][a-z0-9_-]{2,79})\/overrides$/u.exec(path);
  if ((request.method === "GET" || request.method === "PATCH") && match) return siteOverrides(request, env, user, match[1]);
  match = /^\/v1\/platform\/sites\/([a-z0-9][a-z0-9_-]{2,79})\/overrides\/rollback$/u.exec(path);
  if (request.method === "POST" && match) return rollbackOverrides(request, env, user, match[1]);
  match = /^\/v1\/platform\/sites\/([a-z0-9][a-z0-9_-]{2,79})\/review-sources$/u.exec(path);
  if (request.method === "POST" && match) return updateReviewSources(request, env, user, match[1]);
  match = /^\/v1\/platform\/sites\/([a-z0-9][a-z0-9_-]{2,79})\/(conversation|conversation\/quick|support)$/u.exec(path);
  if (match) {
    if (request.method === "GET" && match[2] === "conversation") return conversationState(env, user, match[1]);
    if (request.method === "POST" && match[2] === "conversation/quick") return appendQuickExchange(request, env, user, match[1]);
    if (request.method === "POST" && match[2] === "support") return siteSupportAction(request, env, user, match[1]);
  }
  match = /^\/v1\/platform\/sites\/([a-z0-9][a-z0-9_-]{2,79})\/(inventory|assistant|assistant\/locate-phone|selection|changes\/apply)$/u.exec(path);
  if (match) {
    if ((request.method === "GET" || request.method === "POST") && match[2] === "inventory") return inventory(request, env, user, match[1]);
    if (request.method === "POST" && match[2] === "assistant") return assistantProposal(request, env, user, match[1]);
    if (request.method === "POST" && match[2] === "assistant/locate-phone") return assistantLocatePhone(request, env, user, match[1]);
    if (request.method === "GET" && match[2] === "selection") return siteSelectionResult(env, user, match[1]);
    if (request.method === "POST" && match[2] === "changes/apply") return applyPreparedChange(request, env, user, match[1]);
  }
  match = /^\/v1\/platform\/sites\/([a-z0-9][a-z0-9_-]{2,79})\/telegram\/(status|connect|test|disconnect)$/u.exec(path);
  if (match) {
    if (request.method === "GET" && match[2] === "status") return telegramStatus(env, user, match[1]);
    if (request.method === "POST" && match[2] === "connect") return telegramConnect(request, env, user, match[1]);
    if (request.method === "POST" && match[2] === "test") return telegramTest(env, user, match[1]);
    if (request.method === "POST" && match[2] === "disconnect") return telegramDisconnect(env, user, match[1]);
  }
  fail("Страница не найдена.", 404, "NOT_FOUND");
}

export async function scheduledPlatformChecks(env) {
  const [monitor, health, digests, contentAudits, domainChecks, monitorRollups] = await Promise.allSettled([
    runDuePlatformChecks(env),
    runDueHealthScans(env),
    runDueDigests(env),
    runDueContentAudits(env),
    runDueDomainChecks(env),
    runDueMonitorRollups(env)
  ]);
  return {
    monitor: monitor.status === "fulfilled" ? monitor.value : { error: true },
    health: health.status === "fulfilled" ? health.value : { error: true },
    digests: digests.status === "fulfilled" ? digests.value : { error: true },
    contentAudits: contentAudits.status === "fulfilled" ? contentAudits.value : { error: true },
    domainChecks: domainChecks.status === "fulfilled" ? domainChecks.value : { error: true },
    monitorRollups: monitorRollups.status === "fulfilled" ? monitorRollups.value : { error: true }
  };
}

export const platformInternals = Object.freeze({ accountDetails, enforceActionLimit, platformStatus, requestJson, sessionUser });
