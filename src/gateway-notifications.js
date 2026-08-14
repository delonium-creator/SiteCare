const encoder = new TextEncoder();
const GATEWAY_TIMEOUT_MS = 12_000;
const SITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;
const EVENT_TYPE_PATTERN = /^(?:connection|test|page-down|page-recovered|form-down|form-recovered)$/u;

function safeGatewayError(value) {
  return String(value || "Шлюз уведомлений не ответил.")
    .replace(/[\u0000-\u001F\u007F<>]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 220);
}

export function gatewayConfig(env) {
  const rawUrl = String(env?.TELEGRAM_GATEWAY_URL || "").trim();
  const siteToken = String(env?.TELEGRAM_SITE_TOKEN || "").trim();
  if (!rawUrl && !siteToken) return null;
  if (!rawUrl || !siteToken) throw new Error("Подключение общего SiteCareBot настроено не полностью.");
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    !/^sitecare-telegram-gateway\.[a-z0-9-]+\.workers\.dev$/u.test(url.hostname) ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Некорректный адрес шлюза SiteCareBot.");
  }
  if (!SITE_TOKEN_PATTERN.test(siteToken)) throw new Error("Некорректный ключ сайта для SiteCareBot.");
  return { baseUrl: url.href.replace(/\/$/u, ""), siteToken };
}

async function gatewayRequest(env, pathname, options = {}, fetchImpl = fetch) {
  const config = gatewayConfig(env);
  if (!config) throw new Error("Общий SiteCareBot ещё не настроен.");
  const method = options.method || "GET";
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${config.siteToken}`
  };
  let body;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
    if (encoder.encode(body).byteLength > 16 * 1024) throw new Error("Запрос к SiteCareBot слишком большой.");
  }
  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}${pathname}`, {
      method,
      headers,
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS)
    });
  } catch (error) {
    const timeout = ["AbortError", "TimeoutError"].includes(String(error?.name));
    throw new Error(timeout
      ? "Общий SiteCareBot не ответил вовремя (BOT-GATEWAY-TIMEOUT)."
      : "Не удалось связаться с общим SiteCareBot (BOT-GATEWAY-NET)."
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Общий SiteCareBot вернул некорректный ответ (BOT-GATEWAY-RESPONSE).");
  }
  if (!response.ok || payload?.ok === false) {
    const rawError = String(payload?.error || `Шлюз вернул код ${response.status}.`)
      .replaceAll(config.siteToken, "[скрыто]");
    const error = new Error(safeGatewayError(rawError));
    error.status = response.status;
    error.gatewayCode = String(payload?.code || "");
    throw error;
  }
  return payload;
}

function sitePath(siteId, suffix) {
  const normalized = String(siteId || "");
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/u.test(normalized)) throw new Error("Некорректный код сайта.");
  return `/v1/sites/${encodeURIComponent(normalized)}${suffix}`;
}

export function gatewayConnectionStatus(env, siteId, fetchImpl = fetch) {
  return gatewayRequest(env, sitePath(siteId, "/status"), {}, fetchImpl);
}

export function gatewayCreateConnection(env, siteId, fetchImpl = fetch) {
  return gatewayRequest(env, sitePath(siteId, "/connect"), { method: "POST", body: {} }, fetchImpl);
}

export function gatewayDisconnect(env, siteId, fetchImpl = fetch) {
  return gatewayRequest(env, sitePath(siteId, "/destination"), { method: "DELETE" }, fetchImpl);
}

export function gatewaySendNotification(env, siteId, { eventId, eventType, text }, fetchImpl = fetch) {
  const normalizedEventId = String(eventId || "").trim();
  if (!/^[A-Za-z0-9:_-]{8,160}$/u.test(normalizedEventId)) throw new Error("Некорректный код уведомления.");
  if (!EVENT_TYPE_PATTERN.test(String(eventType || ""))) throw new Error("Некорректный тип уведомления.");
  const message = String(text || "").trim();
  if (!message || message.length > 3500) throw new Error("Некорректный текст уведомления.");
  return gatewayRequest(env, sitePath(siteId, "/notifications"), {
    method: "POST",
    body: { eventId: normalizedEventId, eventType, text: message }
  }, fetchImpl);
}
