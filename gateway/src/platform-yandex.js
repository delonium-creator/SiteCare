// Yandex Metrica read-only integration: one SiteCare-wide OAuth app
// (client_id/client_secret configured once by the operator) authorizes
// access to many different clients' own counters, mirroring the
// Telegram bot pattern - one bot, many linked chats.

const YANDEX_TIMEOUT_MS = 15_000;
const YANDEX_OAUTH_AUTHORIZE_URL = "https://oauth.yandex.ru/authorize";
const YANDEX_OAUTH_TOKEN_URL = "https://oauth.yandex.ru/token";
const YANDEX_METRIKA_COUNTERS_URL = "https://api-metrika.yandex.net/management/v1/counters";
const YANDEX_METRIKA_STATS_URL = "https://api-metrika.yandex.net/stat/v1/data";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function fromBase64url(value) {
  const raw = String(value || "").replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(raw + "=".repeat((4 - raw.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function tokenEncryptionKey(env) {
  const secret = String(env.LEADS_DATA_KEY || "");
  if (secret.length < 20) throw new Error("YANDEX_ENCRYPTION_NOT_CONFIGURED");
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`sitecare:yandex-metrica-token:v1:${secret}`));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptYandexToken(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode("sitecare-yandex-token:v1") },
    await tokenEncryptionKey(env),
    encoder.encode(String(value || ""))
  );
  return { ciphertext: base64url(new Uint8Array(ciphertext)), iv: base64url(iv) };
}

export async function decryptYandexToken(env, ciphertext, iv) {
  if (!ciphertext || !iv) return null;
  try {
    const cleartext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(iv), additionalData: encoder.encode("sitecare-yandex-token:v1") },
      await tokenEncryptionKey(env),
      fromBase64url(ciphertext)
    );
    return decoder.decode(cleartext);
  } catch {
    return null;
  }
}

export function buildYandexAuthorizeUrl({ clientId, state, redirectUri }) {
  const url = new URL(YANDEX_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", String(clientId || ""));
  url.searchParams.set("redirect_uri", String(redirectUri || ""));
  url.searchParams.set("state", String(state || ""));
  url.searchParams.set("force_confirm", "yes");
  return url.href;
}

export function normalizeTokenResponse(json, now = Date.now()) {
  const accessToken = String(json?.access_token || "").trim();
  if (!accessToken) return null;
  const refreshToken = String(json?.refresh_token || "").trim() || null;
  const expiresIn = Number(json?.expires_in) || 0;
  const expiresAt = expiresIn > 0 ? new Date(now + expiresIn * 1000).toISOString() : null;
  return { accessToken, refreshToken, expiresAt };
}

export function normalizeCountersResponse(json) {
  const list = Array.isArray(json?.counters) ? json.counters : [];
  return list.map((counter) => ({
    id: String(counter?.id || ""),
    domain: String(counter?.site || counter?.domain || ""),
    name: String(counter?.name || "")
  })).filter((counter) => counter.id);
}

export function normalizeVisitStats(json) {
  const totals = Array.isArray(json?.totals) ? json.totals : [];
  const visits = Number(totals[0]);
  return { visits: Number.isFinite(visits) ? Math.round(visits) : 0 };
}

function timeoutOrUnavailable(error) {
  const wrapped = new Error(error?.name === "TimeoutError" ? "YANDEX_TIMEOUT" : "YANDEX_UNAVAILABLE");
  wrapped.cause = error;
  return wrapped;
}

export async function exchangeYandexCode({ clientId, clientSecret, code, redirectUri, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(YANDEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code || ""),
        client_id: String(clientId || ""),
        client_secret: String(clientSecret || ""),
        redirect_uri: String(redirectUri || "")
      }).toString(),
      signal: AbortSignal.timeout(YANDEX_TIMEOUT_MS)
    });
  } catch (error) {
    throw timeoutOrUnavailable(error);
  }
  if (!response.ok) {
    const error = new Error(response.status >= 500 ? "YANDEX_UNAVAILABLE" : "YANDEX_TOKEN_EXCHANGE_FAILED");
    error.status = response.status;
    throw error;
  }
  return normalizeTokenResponse(await response.json());
}

export async function refreshYandexToken({ clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(YANDEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: String(refreshToken || ""),
        client_id: String(clientId || ""),
        client_secret: String(clientSecret || "")
      }).toString(),
      signal: AbortSignal.timeout(YANDEX_TIMEOUT_MS)
    });
  } catch (error) {
    throw timeoutOrUnavailable(error);
  }
  if (!response.ok) {
    const error = new Error(response.status === 400 || response.status === 401 ? "YANDEX_TOKEN_INVALID" : response.status >= 500 ? "YANDEX_UNAVAILABLE" : "YANDEX_REQUEST_FAILED");
    error.status = response.status;
    throw error;
  }
  return normalizeTokenResponse(await response.json());
}

export async function fetchYandexCounters({ accessToken, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(YANDEX_METRIKA_COUNTERS_URL, {
      headers: { Authorization: `OAuth ${accessToken}` },
      signal: AbortSignal.timeout(YANDEX_TIMEOUT_MS)
    });
  } catch (error) {
    throw timeoutOrUnavailable(error);
  }
  if (!response.ok) {
    const error = new Error(response.status === 401 || response.status === 403 ? "YANDEX_TOKEN_INVALID" : response.status >= 500 ? "YANDEX_UNAVAILABLE" : "YANDEX_REQUEST_FAILED");
    error.status = response.status;
    throw error;
  }
  return normalizeCountersResponse(await response.json());
}

export async function fetchYandexVisitStats({ accessToken, counterId, dateFrom, dateTo, fetchImpl = fetch }) {
  const url = new URL(YANDEX_METRIKA_STATS_URL);
  url.searchParams.set("id", String(counterId || ""));
  url.searchParams.set("metrics", "ym:s:visits");
  url.searchParams.set("date1", String(dateFrom || ""));
  url.searchParams.set("date2", String(dateTo || ""));
  let response;
  try {
    response = await fetchImpl(url.href, {
      headers: { Authorization: `OAuth ${accessToken}` },
      signal: AbortSignal.timeout(YANDEX_TIMEOUT_MS)
    });
  } catch (error) {
    throw timeoutOrUnavailable(error);
  }
  if (!response.ok) {
    const error = new Error(response.status === 401 || response.status === 403 ? "YANDEX_TOKEN_INVALID" : response.status >= 500 ? "YANDEX_UNAVAILABLE" : "YANDEX_REQUEST_FAILED");
    error.status = response.status;
    throw error;
  }
  return normalizeVisitStats(await response.json());
}

export const yandexInternals = Object.freeze({ base64url, fromBase64url });
