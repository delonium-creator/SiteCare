const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
export const MAX_WEBHOOK_FIELDS = 80;
export const TEST_MARKER_TTL_MINUTES = 20;

const TEXT_TEST_MARKER_PATTERN = /SITECARE-TEST-[A-Z2-9]{16}/iu;
const PHONE_TEST_MARKER_PATTERN = /000\d{12}$/u;
const NON_EDITABLE_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

function parseAttributes(raw) {
  const attributes = Object.create(null);
  const pattern = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of String(raw || "").matchAll(pattern)) {
    const name = match[1].toLocaleLowerCase("en-US");
    if (!(name in attributes)) attributes[name] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function safeMetadata(value, maximum = 120) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F<>]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function nearestBlockId(html, position, blockIds) {
  let nearest = null;
  let nearestPosition = -1;
  for (const blockId of blockIds || []) {
    const doubleQuoted = html.lastIndexOf(`id="${blockId}"`, position);
    const singleQuoted = html.lastIndexOf(`id='${blockId}'`, position);
    const foundAt = Math.max(doubleQuoted, singleQuoted);
    if (foundAt > nearestPosition) {
      nearest = blockId;
      nearestPosition = foundAt;
    }
  }
  return nearest;
}

function fieldFromTag(tagName, rawAttributes) {
  const attributes = parseAttributes(rawAttributes);
  let type = tagName === "input"
    ? safeMetadata(attributes.type || "text", 30).toLocaleLowerCase("en-US")
    : tagName;
  if (tagName === "input" && /(?:^|[-_])phone(?:$|[-_])/iu.test(String(attributes["data-tilda-rule"] || ""))) {
    type = "tel";
  }
  if (tagName === "input" && NON_EDITABLE_INPUT_TYPES.has(type)) return null;
  const name = safeMetadata(attributes.name || attributes.id || "", 120);
  return {
    name: name || "без названия",
    type,
    required: "required" in attributes || attributes["aria-required"] === "true"
  };
}

function formFromMatch(html, match, blockIds) {
  const formAttributes = parseAttributes(match[1]);
  const body = match[2];
  const fields = [];
  const fieldPattern = /<(input|textarea|select)\b([^>]*)>/giu;
  let receiverDetected = Boolean(formAttributes["data-formactiontype"] || formAttributes["data-formaction"]);
  let submitDetected = false;

  for (const fieldMatch of body.matchAll(fieldPattern)) {
    const tagName = fieldMatch[1].toLocaleLowerCase("en-US");
    const attributes = parseAttributes(fieldMatch[2]);
    const type = safeMetadata(attributes.type || (tagName === "input" ? "text" : tagName), 30).toLocaleLowerCase("en-US");
    const name = String(attributes.name || "").toLocaleLowerCase("en-US");
    if (tagName === "input" && type === "hidden" && /formservices?(?:\[\])?|receivers?/u.test(name) && attributes.value) {
      receiverDetected = true;
    }
    if (tagName === "input" && type === "submit") submitDetected = true;
    const field = fieldFromTag(tagName, fieldMatch[2]);
    if (field && fields.length < 30) fields.push(field);
  }

  for (const buttonMatch of body.matchAll(/<button\b([^>]*)>/giu)) {
    const attributes = parseAttributes(buttonMatch[1]);
    const type = String(attributes.type || "submit").toLocaleLowerCase("en-US");
    if (type === "submit" || /(?:^|\s)t-submit(?:\s|$)/u.test(String(attributes.class || ""))) submitDetected = true;
  }

  const formId = safeMetadata(formAttributes.id || formAttributes.name || "", 120);
  const structuralReady = fields.length > 0 && submitDetected;
  return {
    formId: formId || "без id",
    blockId: nearestBlockId(html, match.index, blockIds),
    fieldCount: fields.length,
    requiredCount: fields.filter((field) => field.required).length,
    submitDetected,
    receiverDetected,
    structuralReady,
    fields
  };
}

export function analyzeForms(rawHtml, blockIds = []) {
  const html = String(rawHtml || "");
  const markup = html.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/giu, (value) => " ".repeat(value.length));
  const forms = [];
  for (const match of markup.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form\s*>/giu)) {
    if (forms.length >= 20) break;
    forms.push(formFromMatch(markup, match, blockIds));
  }
  const readyCount = forms.filter((form) => form.structuralReady).length;
  const receiverCount = forms.filter((form) => form.receiverDetected).length;
  return {
    ok: forms.length > 0 && readyCount === forms.length,
    formCount: forms.length,
    readyCount,
    receiverCount,
    forms
  };
}

export function formMonitorResult(httpStatus, html, networkError = "", blockIds = []) {
  if (networkError) {
    return {
      ok: false,
      httpStatus: Number(httpStatus) || 0,
      formCount: 0,
      readyCount: 0,
      receiverCount: 0,
      forms: [],
      details: `Не удалось проверить формы: ${networkError}`
    };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      ok: false,
      httpStatus,
      formCount: 0,
      readyCount: 0,
      receiverCount: 0,
      forms: [],
      details: `Формы не проверены: страница ответила кодом ${httpStatus}.`
    };
  }
  const analysis = analyzeForms(html, blockIds);
  let details;
  if (analysis.formCount === 0) {
    details = "На закреплённой странице формы не найдены.";
  } else if (analysis.readyCount !== analysis.formCount) {
    details = `Найдено форм: ${analysis.formCount}. Структурно готовы: ${analysis.readyCount}. У одной или нескольких форм нет поля либо кнопки отправки.`;
  } else {
    details = `Найдено форм: ${analysis.formCount}. У всех есть поля и кнопка отправки.`;
  }
  if (analysis.formCount > 0) {
    details += analysis.receiverCount > 0
      ? ` Признак подключённого получателя найден у ${analysis.receiverCount}.`
      : " Получателя нельзя надёжно подтвердить только по HTML; доставку проверяет webhook.";
  }
  return { ...analysis, httpStatus, details };
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

async function keyedDigest(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

export async function webhookToken(secret, siteId) {
  return keyedDigest(`sitecare-webhook:v1:${siteId}`, secret);
}

export async function hashTestMarker(marker, secret) {
  return keyedDigest(`sitecare-test-marker:v1:${String(marker || "").toLocaleUpperCase("en-US")}`, secret);
}

function randomDecimalDigits(length) {
  let result = "";
  while (result.length < length) {
    const random = crypto.getRandomValues(new Uint8Array(Math.max(16, (length - result.length) * 2)));
    for (const byte of random) {
      if (byte >= 250) continue;
      result += String(byte % 10);
      if (result.length === length) break;
    }
  }
  return result;
}

export function testMarkerKindForForms(forms) {
  const fields = (Array.isArray(forms) ? forms : [])
    .flatMap((form) => Array.isArray(form?.fields) ? form.fields : []);
  const hasOrdinaryTextField = fields.some((field) => {
    const name = String(field?.name || "");
    const type = String(field?.type || "").toLocaleLowerCase("en-US");
    const phoneLike = type === "tel" || type === "phone" || /(?:^|[-_\s])(phone|tel|телефон)(?:$|[-_\s])/iu.test(name);
    return !phoneLike && (type === "text" || type === "textarea" || type === "search");
  });
  return hasOrdinaryTextField ? "text" : "phone";
}

export function createTestMarker(kind = "text") {
  if (kind === "phone") return `000${randomDecimalDigits(12)}`;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random = crypto.getRandomValues(new Uint8Array(16));
  let suffix = "";
  for (const byte of random) suffix += alphabet[byte % alphabet.length];
  return `SITECARE-TEST-${suffix}`;
}

async function readBoundedBytes(request, maximum) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    const error = new Error("Данные формы слишком большие.");
    error.status = 413;
    throw error;
  }
  if (!request.body || typeof request.body.getReader !== "function") {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > maximum) {
      const error = new Error("Данные формы слишком большие.");
      error.status = 413;
      throw error;
    }
    return bytes;
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      const error = new Error("Данные формы слишком большие.");
      error.status = 413;
      throw error;
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function parseWebhookRequest(request) {
  const contentType = request.headers.get("Content-Type") || "";
  const bytes = await readBoundedBytes(request, MAX_WEBHOOK_BODY_BYTES);
  let rawEntries;
  if (/^application\/x-www-form-urlencoded(?:\s*;|$)/iu.test(contentType)) {
    rawEntries = [...new URLSearchParams(decoder.decode(bytes)).entries()];
  } else if (/^multipart\/form-data(?:\s*;|$)/iu.test(contentType)) {
    const data = await new Response(bytes, { headers: { "Content-Type": contentType } }).formData();
    rawEntries = [...data.entries()].map(([name, value]) => [name, typeof value === "string" ? value : ""]);
  } else {
    const error = new Error("Формат данных формы не поддерживается.");
    error.status = 415;
    throw error;
  }
  if (rawEntries.length === 0 || rawEntries.length > MAX_WEBHOOK_FIELDS) {
    const error = new Error(rawEntries.length === 0 ? "Форма не содержит полей." : "В форме слишком много полей.");
    error.status = rawEntries.length === 0 ? 400 : 413;
    throw error;
  }
  return rawEntries.map(([rawName, rawValue], index) => ({
    name: safeMetadata(rawName, 120) || `field-${index + 1}`,
    value: String(rawValue || "").slice(0, MAX_WEBHOOK_BODY_BYTES)
  }));
}

export function testMarkerFromEntries(entries) {
  for (const entry of entries || []) {
    const match = String(entry.value || "").match(TEXT_TEST_MARKER_PATTERN);
    if (match) return match[0].toLocaleUpperCase("en-US");
  }
  for (const entry of entries || []) {
    const digits = String(entry.value || "").replace(/\D/gu, "");
    const match = digits.match(PHONE_TEST_MARKER_PATTERN);
    if (match) return match[0];
  }
  return null;
}

function strictFormId(value) {
  const candidate = String(value || "").trim();
  return /^[a-zA-Z0-9_.:-]{1,120}$/u.test(candidate) ? candidate : null;
}

export async function submissionMetadata(entries, secret) {
  const fieldNames = [...new Set((entries || []).map((entry) => safeMetadata(entry.name, 120)).filter(Boolean))].slice(0, MAX_WEBHOOK_FIELDS);
  const formIdEntry = (entries || []).find((entry) => /^(?:formid|form-id|form_id)$/iu.test(entry.name));
  const fingerprintSource = JSON.stringify((entries || []).map((entry) => [entry.name, entry.value]));
  return {
    fieldNames,
    fieldCount: entries.length,
    formId: strictFormId(formIdEntry?.value),
    payloadHash: await keyedDigest(`sitecare-form-payload:v1:${fingerprintSource}`, secret)
  };
}
