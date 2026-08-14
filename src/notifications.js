const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const TELEGRAM_CONNECT_TTL_MINUTES = 15;

const BOT_TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{30,100}$/u;
const CONNECT_CODE_PATTERN = /^\/sitecare_[a-z2-9]{10}$/u;
const ENCRYPTION_CONTEXT = "sitecare:telegram-token:v1";
const TELEGRAM_REQUEST_TIMEOUT_MS = 15_000;

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function fromBase64url(value) {
  const normalized = String(value || "").replace(/-/gu, "+").replace(/_/gu, "/");
  const padding = "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
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

function normalizeConnectCode(value) {
  return String(value || "")
    .trim()
    .replace(/@[A-Za-z0-9_]+$/u, "")
    .toLocaleLowerCase("en-US");
}

async function encryptionKey(secret) {
  if (!secret || String(secret).length < 32) throw new Error("Защита Telegram не настроена.");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${ENCRYPTION_CONTEXT}:${secret}`)
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function keyedDigest(value, secret) {
  if (!secret || String(secret).length < 32) throw new Error("Защита Telegram не настроена.");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`sitecare:telegram-connect:v1:${value}`)
  );
  return base64url(new Uint8Array(signature));
}

export function validateTelegramBotToken(rawToken) {
  const token = String(rawToken || "").trim();
  if (!BOT_TOKEN_PATTERN.test(token)) {
    throw new Error("Некорректный токен Telegram-бота. Скопируйте его целиком из BotFather.");
  }
  return token;
}

export async function encryptTelegramBotToken(rawToken, secret) {
  const token = validateTelegramBotToken(rawToken);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(ENCRYPTION_CONTEXT) },
    await encryptionKey(secret),
    encoder.encode(token)
  );
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}

export async function decryptTelegramBotToken(value, secret) {
  const [version, encodedIv, encodedCiphertext, extra] = String(value || "").split(".");
  if (version !== "v1" || !encodedIv || !encodedCiphertext || extra) {
    throw new Error("Сохранённое подключение Telegram повреждено. Подключите его заново.");
  }
  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64url(encodedIv),
        additionalData: encoder.encode(ENCRYPTION_CONTEXT)
      },
      await encryptionKey(secret),
      fromBase64url(encodedCiphertext)
    );
    return validateTelegramBotToken(decoder.decode(decrypted));
  } catch {
    throw new Error("Не удалось открыть защищённое подключение Telegram. Подключите его заново.");
  }
}

export function createTelegramConnectCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let suffix = "";
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `/sitecare_${suffix}`;
}

export async function hashTelegramConnectCode(rawCode, secret) {
  const code = normalizeConnectCode(rawCode);
  if (!CONNECT_CODE_PATTERN.test(code)) return null;
  return keyedDigest(code, secret);
}

export async function findTelegramChatByCode(updates, expectedHash, secret) {
  const items = Array.isArray(updates) ? updates.slice().reverse() : [];
  for (const update of items) {
    const message = update?.message;
    const chatType = String(message?.chat?.type || "");
    if (!message?.text || !message?.chat?.id || !["private", "group", "supergroup"].includes(chatType)) continue;
    const candidateHash = await hashTelegramConnectCode(message.text, secret);
    if (candidateHash && constantTimeEqual(candidateHash, expectedHash)) {
      return { chatId: String(message.chat.id), chatType };
    }
  }
  return null;
}

function safeTelegramError(value) {
  return String(value || "Telegram не ответил.")
    .replace(/[\u0000-\u001F\u007F<>]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180);
}

function telegramQuery(body) {
  const query = new URLSearchParams();
  for (const [name, rawValue] of Object.entries(body || {})) {
    if (rawValue === null || rawValue === undefined) continue;
    const value = typeof rawValue === "object" ? JSON.stringify(rawValue) : String(rawValue);
    query.set(name, value);
  }
  return query.toString();
}

function telegramTransport(endpoint, body, mode) {
  const common = {
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS)
  };
  if (mode === "GET") {
    const query = telegramQuery(body);
    return {
      url: query ? `${endpoint}?${query}` : endpoint,
      options: { ...common, method: "GET", headers: { Accept: "application/json" } }
    };
  }
  return {
    url: endpoint,
    options: {
      ...common,
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }
  };
}

async function telegramRequest(rawToken, method, body, fetchImpl = fetch, modes = ["GET", "POST"]) {
  const token = validateTelegramBotToken(rawToken);
  const endpoint = `https://api.telegram.org/bot${token}/${method}`;
  let lastFailure = "network";

  for (const mode of modes) {
    const transport = telegramTransport(endpoint, body, mode);
    let response;
    try {
      response = await fetchImpl(transport.url, transport.options);
    } catch (error) {
      lastFailure = ["AbortError", "TimeoutError"].includes(String(error?.name)) ? "timeout" : "network";
      continue;
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      lastFailure = "invalid";
      continue;
    }

    if (response.ok && payload?.ok === true) return payload.result;
    if (Number(response.status) >= 500) {
      lastFailure = "server";
      continue;
    }
    throw new Error(`Telegram отклонил запрос: ${safeTelegramError(payload?.description)}`);
  }

  if (lastFailure === "timeout") {
    throw new Error("Telegram не ответил после двух попыток. Повторите позже (TG-TIMEOUT-01).");
  }
  if (lastFailure === "server") {
    throw new Error("Сервер Telegram временно недоступен. Повторите позже (TG-SERVER-01).");
  }
  if (lastFailure === "invalid") {
    throw new Error("Telegram вернул некорректный ответ после двух попыток (TG-RESPONSE-01).");
  }
  throw new Error("Cloudflare не смог установить соединение с Telegram после двух попыток (TG-NET-01).");
}

export function telegramGetMe(token, fetchImpl = fetch) {
  return telegramRequest(token, "getMe", {}, fetchImpl);
}

export function telegramGetUpdates(token, fetchImpl = fetch) {
  return telegramRequest(token, "getUpdates", {
    offset: -100,
    limit: 100,
    timeout: 0,
    allowed_updates: ["message"]
  }, fetchImpl);
}

export function telegramSendMessage(token, chatId, rawText, fetchImpl = fetch) {
  const text = String(rawText || "").trim().slice(0, 3500);
  if (!text) throw new Error("Пустое уведомление Telegram.");
  if (!/^-?\d{1,24}$/u.test(String(chatId || ""))) throw new Error("Некорректный чат Telegram.");
  return telegramRequest(token, "sendMessage", {
    chat_id: String(chatId),
    text,
    disable_web_page_preview: true
  }, fetchImpl);
}

export function telegramSetWebhook(token, rawUrl, rawSecret, fetchImpl = fetch) {
  const url = new URL(String(rawUrl || ""));
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
    throw new Error("Некорректный HTTPS-адрес webhook Telegram.");
  }
  const secret = String(rawSecret || "").trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(secret)) {
    throw new Error("Некорректный ключ webhook Telegram.");
  }
  return telegramRequest(token, "setWebhook", {
    url: url.href,
    allowed_updates: ["message"],
    drop_pending_updates: false,
    secret_token: secret
  }, fetchImpl, ["POST"]);
}
