import { newId, safeText } from "./platform-core.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_FIELDS = 50;
const MAX_VALUE = 4000;

const TECHNICAL_FIELD = /^(?:formid|form[-_]?id|formname|form[-_]?name|formservices?(?:\[\])?|receivers?|tranid|transfer|test|_+.*|tilda.*id|projectid|pageid|blockid|payment|checksum|token|api[-_]?key|password|cookies?)$/iu;
const NAME_FIELD = /^(?:name|firstname|first[-_\s]?name|fullname|full[-_\s]?name|fio|фио|имя)$/iu;
const PHONE_FIELD = /(?:^|[-_\s])(?:phone|tel|telephone|mobile|телефон|номер)(?:$|[-_\s])/iu;
const EMAIL_FIELD = /(?:^|[-_\s])(?:e-?mail|почта)(?:$|[-_\s])/iu;
const MESSAGE_FIELD = /(?:message|comment|question|details|note|text|сообщ|коммент|вопрос|пожелан|описан)/iu;
const PAGE_URL_FIELD = /^(?:formurl|pageurl|page[-_]?url|url|referer|referrer|http[-_]?referer)$/iu;
const PAGE_TITLE_FIELD = /^(?:pagetitle|page[-_]?title|title)$/iu;
const FORM_LABEL_FIELD = /^(?:formname|form[-_]?name|tildaspec[-_]?formname|formtitle|form[-_]?title)$/iu;
const UTM_FIELD = /^utm_(source|medium|campaign|term|content)$/iu;

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

async function encryptionKey(env) {
  const secret = String(env.LEADS_DATA_KEY || "");
  if (secret.length < 20) throw new Error("LEADS_ENCRYPTION_NOT_CONFIGURED");
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`sitecare:protected-leads:v1:${secret}`));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptProtectedJson(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode("sitecare-lead:v1") },
    await encryptionKey(env),
    encoder.encode(JSON.stringify(value))
  );
  return { ciphertext: base64url(new Uint8Array(ciphertext)), iv: base64url(iv) };
}

export async function decryptProtectedJson(env, ciphertext, iv) {
  if (!ciphertext || !iv) return null;
  try {
    const cleartext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(iv), additionalData: encoder.encode("sitecare-lead:v1") },
      await encryptionKey(env),
      fromBase64url(ciphertext)
    );
    return JSON.parse(decoder.decode(cleartext));
  } catch {
    return null;
  }
}

function cleanValue(value, maximum = MAX_VALUE) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .trim()
    .slice(0, maximum);
}

function cleanName(value) {
  return safeText(value, 120) || "Поле";
}

function readableFormLabel(value) {
  const label = safeText(value, 120);
  if (!label) return "";
  // Tilda often submits an internal id such as `form316328935` through the
  // form-name field. It is useful for diagnostics, but meaningless to an
  // owner and must not become the visible source name of a lead.
  if (/^(?:form|форма)[\s_-]*\d{4,}$/iu.test(label)) return "";
  return label;
}

function readableExtraFieldName(value, index) {
  const name = cleanName(value);
  if (/^(?:field[-_\s]*)?\d+$/iu.test(name)) return `Дополнительное поле ${index + 1}`;
  return name;
}

function safePageUrl(value, fallback = "") {
  for (const candidate of [value, fallback]) {
    try {
      const url = new URL(String(candidate || ""));
      if (url.protocol !== "https:") continue;
      url.search = "";
      url.hash = "";
      url.username = "";
      url.password = "";
      return url.href;
    } catch {
      // Try the fallback URL.
    }
  }
  return "";
}

function firstEntry(entries, pattern) {
  return (entries || []).find((entry) => pattern.test(String(entry.name || "")) && cleanValue(entry.value, 400));
}

function utmFromCookies(value) {
  const result = {};
  const raw = cleanValue(value, 8000);
  if (!raw) return result;
  for (const key of ["source", "medium", "campaign", "term", "content"]) {
    const patterns = [
      new RegExp(`(?:^|[;&,{\\s\"])(?:utm_)?${key}[\"']?\\s*[:=]\\s*[\"']?([^;,&}\"']{1,500})`, "iu"),
      new RegExp(`(?:^|[;&])utm_${key}=([^;&]{1,500})`, "iu")
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(raw);
      if (!match) continue;
      try { result[key] = decodeURIComponent(match[1].replace(/\+/gu, " ")).trim().slice(0, 500); }
      catch { result[key] = match[1].trim().slice(0, 500); }
      break;
    }
  }
  return result;
}

export function normalizeLeadSubmission(entries, site, metadata = {}) {
  const values = (entries || []).slice(0, MAX_FIELDS).map((entry) => ({
    name: cleanName(entry.name),
    value: cleanValue(entry.value)
  })).filter((entry) => entry.value);
  const used = new Set();
  const take = (pattern) => {
    const index = values.findIndex((entry, position) => !used.has(position) && pattern.test(entry.name));
    if (index < 0) return "";
    used.add(index);
    return values[index].value;
  };
  const name = take(NAME_FIELD);
  const phone = take(PHONE_FIELD);
  const email = take(EMAIL_FIELD);
  const message = take(MESSAGE_FIELD);
  const utm = {};
  values.forEach((entry, index) => {
    const match = UTM_FIELD.exec(entry.name);
    if (!match) return;
    utm[match[1].toLocaleLowerCase("en-US")] = entry.value.slice(0, 500);
    used.add(index);
  });
  const cookiesEntry = values.find((entry) => /^cookies?$/iu.test(entry.name));
  const explicitUtm = { ...utm };
  Object.assign(utm, utmFromCookies(cookiesEntry?.value), explicitUtm);
  const pageEntry = firstEntry(values, PAGE_URL_FIELD);
  const pageTitleEntry = firstEntry(values, PAGE_TITLE_FIELD);
  const formLabelEntry = firstEntry(values, FORM_LABEL_FIELD);
  const formLabel = readableFormLabel(formLabelEntry?.value) || "Форма на сайте";
  const pageUrl = safePageUrl(pageEntry?.value || metadata.referer, site?.target_url);
  const pageTitle = safeText(pageTitleEntry?.value || "", 160);
  const sourceLabel = safeText(utm.source || "Сайт", 80) || "Сайт";
  const fields = values
    .filter((entry, index) => !used.has(index) && !TECHNICAL_FIELD.test(entry.name) && !PAGE_URL_FIELD.test(entry.name) && !PAGE_TITLE_FIELD.test(entry.name) && !FORM_LABEL_FIELD.test(entry.name) && !UTM_FIELD.test(entry.name))
    .slice(0, MAX_FIELDS)
    .map((entry, index) => ({ name: readableExtraFieldName(entry.name, index), value: entry.value }));
  return {
    leadId: newId("lead", site?.site_id || "site"),
    formLabel,
    pageUrl,
    pageTitle,
    sourceLabel,
    payload: { name, phone, email, message, utm, fields }
  };
}

export async function leadRowToPublic(env, row) {
  const payload = await decryptProtectedJson(env, row.payload_ciphertext, row.payload_iv) || {};
  const notePayload = await decryptProtectedJson(env, row.note_ciphertext, row.note_iv) || {};
  return {
    leadId: row.lead_id,
    siteId: row.site_id,
    siteName: row.site_name || "",
    receivedAt: row.received_at,
    formId: row.form_id || "",
    formLabel: row.form_label || "Форма на сайте",
    pageUrl: row.page_url || "",
    pageTitle: row.page_title || "",
    source: row.source_label || "Сайт",
    status: row.status || "new",
    name: payload.name || "",
    phone: payload.phone || "",
    email: payload.email || "",
    message: payload.message || "",
    utm: payload.utm || {},
    fields: Array.isArray(payload.fields) ? payload.fields : [],
    note: notePayload.note || ""
  };
}

export const leadInternals = Object.freeze({ readableFormLabel, safePageUrl, utmFromCookies });
