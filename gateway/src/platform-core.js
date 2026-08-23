const encoder = new TextEncoder();

export const PLATFORM_VERSION = "7.0.0";
export const PLATFORM_COOKIE = "sitecare_platform_session";
export const PASSWORD_ITERATIONS = 100_000;
export const CLOUDFLARE_PBKDF2_MAX_ITERATIONS = 100_000;
export const SESSION_HOURS = 12;
export const SESSION_COOKIE_DAYS = 30;
export const INVITE_HOURS = 72;
export const PASSWORD_RESET_MINUTES = 30;
export const TRIAL_DAYS = 3;

export const PLAN_LIMITS = Object.freeze({
  trial: Object.freeze({ label: "Пробный период", sites: 1, users: 2, monitorMinutes: 15, aiPerDay: 10 }),
  starter: Object.freeze({ label: "SiteCare", sites: 1, users: 5, monitorMinutes: 15, aiPerDay: 20 }),
  business: Object.freeze({ label: "SiteCare", sites: 1, users: 25, monitorMinutes: 5, aiPerDay: 200 })
});

const ROLE_LEVEL = Object.freeze({ viewer: 1, manager: 2, admin: 3, owner: 4 });

export function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

export function randomToken(byteLength = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function digest(context, value) {
  const result = await crypto.subtle.digest("SHA-256", encoder.encode(`sitecare:${context}:v1:${String(value || "")}`));
  return base64url(new Uint8Array(result));
}

export function constantTimeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  let difference = a.length ^ b.length;
  const maximum = Math.max(a.length, b.length);
  for (let index = 0; index < maximum; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function safeText(value, maximum = 220) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F<>]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

// Same safety guarantees as safeText (strips control chars and <>, caps
// length) but keeps single newlines, so bulleted assistant answers
// stay bulleted after a round trip through D1 -- safeText's blanket
// \s+ -> " " collapse was flattening every multi-line chat message into
// one paragraph the moment it was persisted, no matter how carefully
// the message was built upstream.
export function safeMessageText(value, maximum = 1600) {
  return String(value || "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F<>]/gu, " ")
    .replace(/[^\S\n]+/gu, " ")
    .split("\n").map((line) => line.trim()).join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .slice(0, maximum);
}

export function normalizeEmail(value) {
  const email = String(value || "").trim().toLocaleLowerCase("en-US");
  if (email.length < 5 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(email)) {
    throw new Error("Укажите корректную электронную почту.");
  }
  return email;
}

export function validateDisplayName(value) {
  const name = safeText(value, 80);
  if (name.length < 2) throw new Error("Укажите имя длиной не менее 2 символов.");
  return name;
}

export function validateAccountName(value) {
  const name = safeText(value, 120);
  if (name.length < 2) throw new Error("Укажите название клиента.");
  return name;
}

export function validatePassword(value) {
  const password = String(value || "");
  if (password.length < 12 || password.length > 200) throw new Error("Пароль должен содержать от 12 до 200 символов.");
  if (!/[A-Za-zА-Яа-яЁё]/u.test(password) || !/\d/u.test(password)) {
    throw new Error("Добавьте в пароль хотя бы одну букву и одну цифру.");
  }
  return password;
}

export async function derivePasswordHash(password, salt, iterations = PASSWORD_ITERATIONS) {
  validatePassword(password);
  if (!/^[A-Za-z0-9_-]{20,128}$/u.test(String(salt || ""))) throw new Error("Некорректная соль пароля.");
  if (!Number.isInteger(iterations) || iterations < 50_000 || iterations > CLOUDFLARE_PBKDF2_MAX_ITERATIONS) {
    throw new Error("Число итераций пароля не поддерживается Cloudflare Workers.");
  }
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: encoder.encode(`sitecare-password:v1:${salt}`),
    iterations
  }, key, 256);
  return base64url(new Uint8Array(bits));
}

export async function createPasswordRecord(password) {
  const salt = randomToken(24);
  return {
    salt,
    hash: await derivePasswordHash(password, salt, PASSWORD_ITERATIONS),
    iterations: PASSWORD_ITERATIONS
  };
}

export async function passwordMatches(password, record) {
  try {
    const hash = await derivePasswordHash(password, record.password_salt, Number(record.password_iterations));
    return constantTimeEqual(hash, record.password_hash);
  } catch {
    return false;
  }
}

export function roleAllows(role, required) {
  return (ROLE_LEVEL[String(role || "")] || 0) >= (ROLE_LEVEL[String(required || "")] || 99);
}

export function validateRole(value, { ownerAllowed = false } = {}) {
  const role = String(value || "");
  const allowed = ownerAllowed ? new Set(["owner", "admin", "manager", "viewer"]) : new Set(["admin", "manager", "viewer"]);
  if (!allowed.has(role)) throw new Error("Некорректная роль пользователя.");
  return role;
}

export function validatePlan(value) {
  const plan = String(value || "trial");
  if (!PLAN_LIMITS[plan]) throw new Error("Некорректный тариф.");
  return plan;
}

function unsafeHostname(hostname) {
  const host = String(hostname || "").toLocaleLowerCase("en-US");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (/^\[.*\]$/u.test(host)) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) return true;
  return false;
}

export function validateTargetUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("Укажите полный HTTPS-адрес сайта.");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    unsafeHostname(url.hostname)
  ) throw new Error("Укажите публичный HTTPS-адрес сайта без логина и пароля.");
  url.search = "";
  url.hash = "";
  return url.href;
}

export function validateScope(value) {
  const scope = String(value || "page");
  if (scope !== "page" && scope !== "site") throw new Error("Некорректная область подключения.");
  return scope;
}

export function siteSlug(value) {
  const slug = String(value || "site")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 42);
  return slug || "site";
}

export function newId(prefix, hint = "") {
  return `${prefix}_${siteSlug(hint).slice(0, 36)}_${randomToken(6).toLocaleLowerCase("en-US")}`;
}

export function sessionCookie(token, maxAgeSeconds = SESSION_COOKIE_DAYS * 24 * 60 * 60) {
  const persistence = Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0 ? `; Max-Age=${Math.round(maxAgeSeconds)}` : "";
  return `${PLATFORM_COOKIE}=${token}; Path=/${persistence}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie() {
  return `${PLATFORM_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export function readCookie(request, name = PLATFORM_COOKIE) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}

export function integrationUrls(origin, site) {
  const base = String(origin || "").replace(/\/$/u, "");
  return {
    webhookBase: `${base}/v1/platform/forms/${encodeURIComponent(site.site_id)}/webhook`,
    loaderCode: `<script src="${base}/sitecare-loader.js" data-sitecare-site="${site.site_id}" data-sitecare-key="${site.loader_key}" defer></script>`,
    reviewsWidgetCode: site.reviews_widget_key
      ? `<div data-sitecare-reviews></div>\n<script src="${base}/sitecare-reviews-widget.js" data-sitecare-site="${site.site_id}" data-sitecare-key="${site.reviews_widget_key}" defer></script>`
      : null
  };
}

export function replacePhoneNumbersInText(value, replacement, force = false, targetDigits = "") {
  const source = String(value ?? "");
  const phone = String(replacement ?? "").trim();
  const target = String(targetDigits || "").replace(/\D/gu, "");
  if (!source || !phone) return source;
  return source.replace(/\+?\d[\d ()\u00A0.\u2013\u2014-]{7,}\d/gu, (candidate, offset, complete) => {
    const digits = candidate.replace(/\D/gu, "");
    if (digits.length < 10 || digits.length > 15) return candidate;
    if (target && digits !== target) return candidate;
    const context = complete.slice(Math.max(0, offset - 32), offset).toLocaleLowerCase("ru-RU");
    const hasPhoneCue = /(?:тел(?:ефон)?|phone|позвон|звоните|call)\s*[:\u2014-]?\s*$/u.test(context);
    const trimmed = candidate.trim();
    const looksLikePhone = trimmed.startsWith("+") || /[()]/u.test(trimmed) || /^[78][\s\u00A0.-]/u.test(trimmed);
    // Once the owner selected an exact existing number, an exact digit match
    // is safe to replace even when a compact header omits the word
    // “Телефон”. This is what lets one site-wide rule update the header,
    // footer, mobile menu and contact block together.
    return force || Boolean(target) || hasPhoneCue || looksLikePhone ? phone : candidate;
  });
}

export function phoneHref(value) {
  const source = String(value ?? "").trim();
  const digits = source.replace(/\D/gu, "");
  if (!digits) return "";
  return `tel:${source.startsWith("+") ? "+" : ""}${digits}`;
}

export function replaceScheduleInText(value, replacement) {
  const source = String(value ?? "");
  const schedule = String(replacement ?? "").trim();
  if (!source || !schedule) return source;
  const pattern = /(?:пн|вт|ср|чт|пт|сб|вс|понедельник|вторник|среда|четверг|пятница|суббота|воскресенье|ежедневно|будни)(?:\s*[–—-]\s*(?:пн|вт|ср|чт|пт|сб|вс|понедельник|вторник|среда|четверг|пятница|суббота|воскресенье))?[^.!?\n]{0,45}\d{1,2}[:.]\d{2}\s*[–—-]\s*\d{1,2}[:.]\d{2}/giu;
  return source.replace(pattern, schedule);
}

function sitecareLoaderRuntime(replacePhoneText, makePhoneHref, replaceScheduleText) {
  "use strict";
  const script = document.currentScript || [...(document.scripts || [])].reverse().find((item) =>
    item?.dataset?.sitecareSite && item?.dataset?.sitecareKey && /\/sitecare-loader\.js(?:[?#]|$)/u.test(item.src || "")
  );
  if (!script) return;
  const id = script.dataset.sitecareSite || "";
  const key = script.dataset.sitecareKey || "";
  if (!/^[a-z0-9_-]{3,80}$/i.test(id) || !/^[A-Za-z0-9_-]{20,128}$/.test(key)) return;

  const base = new URL(script.src).origin;
  const originalTextNodes = new Map();
  const originalElementText = new Map();
  const originalHrefs = new Map();
  const originalAttributes = new Map();
  let currentConfig = null;
  let lastVersion = null;
  let applying = false;
  let refreshTimer = 0;
  let lastReport = "";
  let currentCounts = {
    phoneCount: 0,
    phoneTextCount: 0,
    phoneLinkCount: 0,
    scheduleCount: 0,
    buttonCount: 0,
    contentCount: 0,
    phoneVerified: false,
    scheduleVerified: false,
    buttonVerified: false,
    contentVerified: false
  };
  let observer = null;

  function elementsWithin(root, selector) {
    const result = [];
    if (root?.nodeType === 1 && root.matches(selector)) result.push(root);
    if (typeof root?.querySelectorAll === "function") result.push(...root.querySelectorAll(selector));
    return result;
  }

  function ignoredTextNode(node) {
    const parent = node?.parentElement;
    return !parent || Boolean(parent.closest("script,style,noscript,textarea,option,code,pre,svg,[contenteditable='true'],[data-sitecare-ignore]"));
  }

  function updateTextNode(node, phone, schedule, phoneRules = []) {
    if (!node || node.nodeType !== 3 || ignoredTextNode(node)) return;
    const inPhoneLink = Boolean(node.parentElement.closest("a[href^='tel:']"));
    let next = node.nodeValue || "";
    const beforePhone = next;
    if (phoneRules.length) {
      for (const rule of phoneRules) next = replacePhoneText(next, rule.newPhone, inPhoneLink, rule.originalDigits);
    } else if (phone) next = replacePhoneText(next, phone, inPhoneLink);
    if (schedule) next = replaceScheduleText(next, schedule);
    if (next === node.nodeValue) return;
    if (!originalTextNodes.has(node)) originalTextNodes.set(node, node.nodeValue || "");
    node.nodeValue = next;
    return { phone: next !== beforePhone, schedule: schedule && replaceScheduleText(originalTextNodes.get(node), schedule) !== originalTextNodes.get(node) };
  }

  function updateVisibleText(root, phone, schedule, phoneRules, counts) {
    if (root?.nodeType === 3) {
      const changed = updateTextNode(root, phone, schedule, phoneRules);
      if (changed?.phone) {
        counts.phoneCount += 1;
        counts.phoneTextCount += 1;
      }
      if (changed?.schedule) counts.scheduleCount += 1;
      return;
    }
    if (!root || typeof document.createTreeWalker !== "function") return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const changed = updateTextNode(node, phone, schedule, phoneRules);
      if (changed?.phone) {
        counts.phoneCount += 1;
        counts.phoneTextCount += 1;
      }
      if (changed?.schedule) counts.scheduleCount += 1;
      node = walker.nextNode();
    }
  }

  function updatePhoneLinks(root, phone, phoneRules, counts) {
    for (const element of elementsWithin(root, "a[href^='tel:']")) {
      if (!originalHrefs.has(element)) originalHrefs.set(element, element.getAttribute("href"));
      const original = originalHrefs.get(element) || "";
      const originalDigits = String(original).replace(/\D/gu, "");
      const rule = phoneRules.find((item) => item.originalDigits === originalDigits);
      const replacement = rule?.newPhone || (!phoneRules.length ? phone : "");
      const href = makePhoneHref(replacement);
      if (!href) continue;
      if (element.getAttribute("href") !== href) element.setAttribute("href", href);
      if (element.getAttribute("href") === href) {
        counts.phoneCount += 1;
        counts.phoneLinkCount += 1;
      }
    }
  }

  function originalText(node) {
    return originalTextNodes.has(node) ? originalTextNodes.get(node) : node?.nodeValue || "";
  }

  function originalHref(element) {
    return originalHrefs.has(element) ? originalHrefs.get(element) : element?.getAttribute?.("href") || "";
  }

  function phoneTextMatches(node, originalDigits, includePhoneLinks = false) {
    if (!node || node.nodeType !== 3 || ignoredTextNode(node)) return false;
    const inPhoneLink = Boolean(node.parentElement?.closest("a[href^='tel:']"));
    if (inPhoneLink && !includePhoneLinks) return false;
    const before = originalText(node);
    return replacePhoneText(before, "000-000-000-000", inPhoneLink, originalDigits) !== before;
  }

  function targetTextNodes(rule, includePhoneLinks = false) {
    if (typeof document.createTreeWalker !== "function") return [];
    const result = [];
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (phoneTextMatches(node, rule.originalDigits, includePhoneLinks)) result.push(node);
      node = walker.nextNode();
    }
    return result;
  }

  function targetLinks(rule) {
    return [...document.querySelectorAll("a[href^='tel:']")].filter((element) => String(originalHref(element)).replace(/\D/gu, "") === rule.originalDigits);
  }

  function targetBlock(element) {
    return element?.closest?.("[id^='rec']")?.id || "";
  }

  function setTargetText(node, rule, counts) {
    const inPhoneLink = Boolean(node.parentElement?.closest("a[href^='tel:']"));
    const before = originalText(node);
    const next = replacePhoneText(before, rule.newPhone, inPhoneLink, rule.originalDigits);
    if (next === before) return false;
    if (!originalTextNodes.has(node)) originalTextNodes.set(node, node.nodeValue || "");
    if (node.nodeValue !== next) node.nodeValue = next;
    if (node.nodeValue === next) {
      counts.phoneCount += 1;
      counts.phoneTextCount += 1;
      return true;
    }
    return false;
  }

  function setTargetLink(element, rule, counts) {
    if (!originalHrefs.has(element)) originalHrefs.set(element, element.getAttribute("href"));
    const href = makePhoneHref(rule.newPhone);
    if (!href) return false;
    if (element.getAttribute("href") !== href) element.setAttribute("href", href);
    const verified = element.getAttribute("href") === href;
    if (verified) {
      counts.phoneCount += 1;
      counts.phoneLinkCount += 1;
    }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      setTargetText(node, rule, counts);
      node = walker.nextNode();
    }
    return verified;
  }

  function updatePhoneTargetRules(config, counts) {
    for (const rule of Array.isArray(config.phoneTargetRules) ? config.phoneTargetRules : []) {
      if (rule.scope !== "site" && rule.pagePath !== (location.pathname || "/")) continue;
      if (rule.scope === "element" && rule.source === "link") {
        const links = targetLinks(rule).filter((element) => !rule.blockId || targetBlock(element) === rule.blockId);
        const link = links[Number(rule.occurrenceIndex) || 0];
        if (link) setTargetLink(link, rule, counts);
        continue;
      }
      if (rule.scope === "element") {
        const nodes = targetTextNodes(rule).filter((node) => !rule.blockId || targetBlock(node.parentElement) === rule.blockId);
        const node = nodes[Number(rule.occurrenceIndex) || 0];
        if (node) setTargetText(node, rule, counts);
        continue;
      }
      for (const link of targetLinks(rule)) setTargetLink(link, rule, counts);
      for (const node of targetTextNodes(rule)) setTargetText(node, rule, counts);
    }
  }

  function setElementText(element, value) {
    if (!element || !value) return false;
    if (!originalElementText.has(element)) originalElementText.set(element, element.textContent || "");
    if (element.textContent !== value) element.textContent = value;
    return element.textContent === value;
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase("ru-RU");
  }

  function sourceText(element) {
    return originalElementText.has(element) ? originalElementText.get(element) : element?.textContent || "";
  }

  function sourceHref(element) {
    const raw = originalHrefs.has(element) ? originalHrefs.get(element) : element?.getAttribute?.("href");
    if (!raw) return "";
    try { return new URL(raw, location.href).href; } catch { return String(raw); }
  }

  function candidateElements() {
    return [...document.querySelectorAll("a,button")].filter((element) => {
      const text = normalizeText(sourceText(element));
      const href = String(element.getAttribute?.("href") || "");
      if (!text && !href) return false;
      if (/^(?:javascript:|mailto:|tel:|#)/i.test(href) && !/(?:btn|button|кноп)/i.test(String(element.className || ""))) return false;
      return true;
    });
  }

  function buttonRuleMatches(rule, element, index) {
    const pathname = location.pathname || "/";
    if (rule.scope !== "site" && rule.pagePath !== pathname) return false;
    const blockId = element.closest?.("[id^='rec']")?.id || "";
    const text = normalizeText(sourceText(element));
    const href = sourceHref(element);
    const textMatches = !rule.originalText || text === normalizeText(rule.originalText);
    const urlMatches = !rule.originalUrl || href === rule.originalUrl;
    if (rule.scope === "element") {
      if (Number(rule.matchIndex) !== index) return false;
      if (rule.blockId && rule.blockId !== blockId) return false;
      return textMatches && urlMatches;
    }
    return textMatches && urlMatches && Boolean(rule.originalText || rule.originalUrl);
  }

  function updateButtonRules(config, counts) {
    const elements = candidateElements();
    for (const rule of Array.isArray(config.buttonRules) ? config.buttonRules : []) {
      for (let index = 0; index < elements.length; index += 1) {
        const element = elements[index];
        if (!buttonRuleMatches(rule, element, index)) continue;
        const textTarget = element.querySelector?.("[data-sitecare-button-text],.t-btnflex__text,.t-btn__text") || element;
        let verified = true;
        if (rule.newText) verified = setElementText(textTarget, rule.newText) && verified;
        if (rule.newUrl && element.tagName === "A") {
          if (!originalHrefs.has(element)) originalHrefs.set(element, element.getAttribute("href"));
          if (element.getAttribute("href") !== rule.newUrl) element.setAttribute("href", rule.newUrl);
          try {
            verified = new URL(element.getAttribute("href") || "", location.href).href === new URL(rule.newUrl, location.href).href && verified;
          } catch {
            verified = false;
          }
        } else if (rule.newUrl) {
          verified = false;
        }
        if (verified) counts.buttonCount += 1;
        if (rule.scope === "element") break;
      }
    }
  }

  function setElementAttribute(element, name, value) {
    if (!element) return false;
    if (!originalAttributes.has(element)) originalAttributes.set(element, new Map());
    const attrMap = originalAttributes.get(element);
    if (!attrMap.has(name)) attrMap.set(name, element.getAttribute(name));
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    return element.getAttribute(name) === value;
  }

  function imageCandidateElements() {
    return [...document.querySelectorAll("img")].filter((element) => Boolean(element.getAttribute("src")));
  }

  function contentRuleMatches(rule, element, index) {
    const pathname = location.pathname || "/";
    if (rule.pagePath && rule.pagePath !== pathname) return false;
    const blockId = element.closest?.("[id^='rec']")?.id || "";
    if (Number(rule.matchIndex) !== index) return false;
    if (rule.blockId && rule.blockId !== blockId) return false;
    const currentAlt = (element.getAttribute("alt") || "").trim();
    return !rule.originalValue || currentAlt === rule.originalValue;
  }

  function updateContentRules(config, counts) {
    const elements = imageCandidateElements();
    for (const rule of Array.isArray(config.contentRules) ? config.contentRules : []) {
      if (rule.field !== "image_alt") continue;
      for (let index = 0; index < elements.length; index += 1) {
        if (!contentRuleMatches(rule, elements[index], index)) continue;
        if (setElementAttribute(elements[index], "alt", rule.newValue)) counts.contentCount += 1;
        break;
      }
    }
  }

  function updateExplicitTargets(root, config, counts) {
    if (config.scheduleText) {
      for (const element of elementsWithin(root, "[data-sitecare-schedule]")) {
        if (setElementText(element, config.scheduleText)) counts.scheduleCount += 1;
      }
    }
    for (const element of elementsWithin(root, "[data-sitecare-button]")) {
      let verified = true;
      if (config.buttonText) {
        const textTarget = element.querySelector?.("[data-sitecare-button-text],.t-btnflex__text,.t-btn__text") || element;
        verified = setElementText(textTarget, config.buttonText) && verified;
      }
      if (config.buttonUrl && element.tagName === "A") {
        if (!originalHrefs.has(element)) originalHrefs.set(element, element.getAttribute("href"));
        if (element.getAttribute("href") !== config.buttonUrl) element.setAttribute("href", config.buttonUrl);
        try {
          verified = new URL(element.getAttribute("href") || "", location.href).href === new URL(config.buttonUrl, location.href).href && verified;
        } catch {
          verified = false;
        }
      } else if (config.buttonUrl) {
        verified = false;
      }
      if ((config.buttonText || config.buttonUrl) && verified) counts.buttonCount += 1;
    }
  }

  function applyWithin(root, config, counts) {
    if (!config?.enabled || !root) return counts;
    const phoneRules = Array.isArray(config.phoneRules) ? config.phoneRules : [];
    if (config.phone || phoneRules.length) updatePhoneLinks(root, config.phone, phoneRules, counts);
    updateVisibleText(root, config.phone, config.scheduleText, phoneRules, counts);
    updateExplicitTargets(root, config, counts);
    return counts;
  }

  function restore() {
    for (const [node, value] of originalTextNodes) {
      if (node.isConnected) node.nodeValue = value;
    }
    for (const [element, value] of originalElementText) {
      if (element.isConnected) element.textContent = value;
    }
    for (const [element, value] of originalHrefs) {
      if (!element.isConnected) continue;
      if (value === null) element.removeAttribute("href");
      else element.setAttribute("href", value);
    }
    for (const [element, attrs] of originalAttributes) {
      if (!element.isConnected) continue;
      for (const [name, value] of attrs) {
        if (value === null) element.removeAttribute(name);
        else element.setAttribute(name, value);
      }
    }
    originalTextNodes.clear();
    originalElementText.clear();
    originalHrefs.clear();
    originalAttributes.clear();
  }

  function validConfig(config) {
    if (!config || config.origin !== location.origin) return false;
    return config.scope !== "page" || config.pathname === location.pathname;
  }

  async function reportApplied(config, counts, error = "") {
    const report = JSON.stringify({ version: config.version, pathname: location.pathname || "/", ...counts, error });
    if (report === lastReport) return;
    try {
      const response = await fetch(`${base}/v1/public/sites/${encodeURIComponent(id)}/applied?key=${encodeURIComponent(key)}`, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: report
      });
      if (response.ok) lastReport = report;
    } catch {
      // Reporting must never break the public site.
    }
  }

  function applyConfig(config) {
    applying = true;
    observer?.disconnect();
    const counts = {
      phoneCount: 0,
      phoneTextCount: 0,
      phoneLinkCount: 0,
      scheduleCount: 0,
      buttonCount: 0,
      contentCount: 0,
      phoneVerified: false,
      scheduleVerified: false,
      buttonVerified: false,
      contentVerified: false
    };
    try {
      restore();
      currentConfig = config;
      if (config.enabled) {
        applyWithin(document, config, counts);
        updatePhoneTargetRules(config, counts);
        updateButtonRules(config, counts);
        updateContentRules(config, counts);
      }
      // A visible number is required for phone confirmation. A changed tel:
      // link is reported separately, but never presented to the user as a
      // successfully replaced visible phone number.
      counts.phoneVerified = Boolean(config.phone || config.phoneRules?.length || config.phoneTargetRules?.length) && counts.phoneTextCount > 0;
      counts.scheduleVerified = Boolean(config.scheduleText) && counts.scheduleCount > 0;
      counts.buttonVerified = counts.buttonCount > 0;
      counts.contentVerified = Boolean(config.contentRules?.length) && counts.contentCount > 0;
      currentCounts = counts;
      document.documentElement?.setAttribute("data-sitecare-loader", "6");
      document.documentElement?.setAttribute("data-sitecare-status", counts.phoneVerified || counts.scheduleVerified || counts.buttonVerified || counts.contentVerified || !config.enabled ? "ready" : "connected");
      reportApplied(config, counts);
    } catch (error) {
      document.documentElement?.setAttribute("data-sitecare-status", "apply-error");
      reportApplied(config, counts, String(error?.message || "Не удалось применить изменение.").slice(0, 240));
    } finally {
      applying = false;
      observer?.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href"] });
    }
  }

  async function loadConfig() {
    try {
      const response = await fetch(`${base}/v1/public/sites/${encodeURIComponent(id)}/config?key=${encodeURIComponent(key)}`, {
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer"
      });
      if (!response.ok) {
        document.documentElement?.setAttribute("data-sitecare-status", `config-${response.status}`);
        return;
      }
      const config = await response.json();
      if (!validConfig(config)) {
        document.documentElement?.setAttribute("data-sitecare-status", "config-rejected");
        return;
      }
      if (config.version !== lastVersion || config.enabled !== currentConfig?.enabled) {
        lastVersion = config.version;
        applyConfig(config);
      } else if (!lastReport) reportApplied(config, currentCounts);
    } catch {
      document.documentElement?.setAttribute("data-sitecare-status", "config-unavailable");
      // The original Tilda content stays visible while SiteCare is unavailable.
    }
  }

  function selectionModeKind() {
    try {
      const value = new URLSearchParams(location.search).get("sitecare_select") || "";
      return value === "phone" ? value : "";
    } catch {
      return "";
    }
  }

  function findPhoneSelectionCandidates() {
    const results = [];
    const counters = new Map();
    const record = (element, source, rawPhone) => {
      const digitsValue = String(rawPhone || "").replace(/\D/gu, "");
      if (digitsValue.length < 10 || digitsValue.length > 15 || !element) return;
      const blockId = targetBlock(element);
      const key = `${blockId}|${source}|${digitsValue}`;
      const occurrenceIndex = counters.get(key) || 0;
      counters.set(key, occurrenceIndex + 1);
      results.push({
        element,
        payload: {
          kind: "phone",
          pagePath: location.pathname || "/",
          blockId,
          source,
          occurrenceIndex,
          originalDigits: digitsValue,
          phone: String(rawPhone || "").trim()
        }
      });
    };
    for (const link of document.querySelectorAll("a[href^='tel:']")) {
      record(link, "link", (link.getAttribute("href") || "").replace(/^tel:/iu, ""));
    }
    if (typeof document.createTreeWalker === "function") {
      const walker = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const parent = node.parentElement;
        if (parent && !parent.closest("a[href^='tel:']") && phoneTextMatches(node, "", false)) {
          const match = /\+?\d[\d () .–—-]{7,}\d/u.exec(node.nodeValue || "");
          if (match) record(parent, "text", match[0]);
        }
        node = walker.nextNode();
      }
    }
    return results;
  }

  function startSelectionMode(kind) {
    const candidates = kind === "phone" ? findPhoneSelectionCandidates() : [];
    const style = document.createElement("style");
    style.setAttribute("data-sitecare-ignore", "");
    style.textContent = ".sitecare-select-target{outline:3px solid #6753e6!important;outline-offset:2px!important;cursor:pointer!important;background:rgba(103,83,230,.08)!important;transition:outline-color .15s}.sitecare-select-target:hover{outline-color:#39c07a!important;background:rgba(57,192,122,.1)!important}";
    document.head?.appendChild(style);
    const banner = document.createElement("div");
    banner.setAttribute("data-sitecare-ignore", "");
    // Anchored at the bottom, not top:0 -- a full-width bar at the top would
    // otherwise sit directly over the site's own header/nav on most layouts.
    banner.style.cssText = "position:fixed;left:50%;bottom:20px;transform:translateX(-50%);max-width:calc(100vw - 32px);z-index:2147483647;background:#171b25;color:#fff;padding:12px 20px;border-radius:999px;font:600 14px/1.4 -apple-system,'Segoe UI',sans-serif;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    banner.textContent = candidates.length
      ? "SiteCare: кликните по нужному номеру телефона"
      : "SiteCare: на этой странице не нашлось номеров для выбора";
    document.body?.appendChild(banner);
    if (!candidates.length) return;
    for (const item of candidates) item.element.classList.add("sitecare-select-target");
    const finish = (payload) => {
      for (const item of candidates) item.element.classList.remove("sitecare-select-target");
      banner.textContent = "Готово — вернитесь во вкладку SiteCare.";
      // window.opener/postMessage is a best-effort extra: many sites' own
      // Cross-Origin-Opener-Policy silently severs window.opener for
      // cross-origin popups, so the click is also reported to the gateway
      // itself; the panel picks it up on its own when the tab regains focus.
      try {
        window.opener?.postMessage({ channel: "sitecare-select", ...payload }, base);
      } catch {
        // Ignored -- the server-reported copy below is the reliable path.
      }
      fetch(`${base}/v1/public/sites/${encodeURIComponent(id)}/select?key=${encodeURIComponent(key)}`, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(payload)
      }).catch(() => {
        // The banner stays visible if this fails, which is the honest state.
      }).finally(() => {
        window.setTimeout(() => {
          try { window.close(); } catch {}
        }, 900);
      });
    };
    document.addEventListener("click", (event) => {
      const match = candidates.find((item) => item.element === event.target || item.element.contains(event.target));
      if (!match) return;
      event.preventDefault();
      event.stopPropagation();
      finish(match.payload);
    }, true);
  }

  function start() {
    const selectKind = selectionModeKind();
    if (selectKind) {
      startSelectionMode(selectKind);
      document.documentElement?.setAttribute("data-sitecare-loader", "6");
      return;
    }
    observer = new MutationObserver((records) => {
      if (applying || !currentConfig?.enabled) return;
      for (const record of records) {
        if (record.type === "childList" && !record.addedNodes.length && !record.removedNodes.length) continue;
        clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => applyConfig(currentConfig), 120);
        break;
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href"] });
    document.documentElement?.setAttribute("data-sitecare-loader", "6");
    document.documentElement?.setAttribute("data-sitecare-status", "loading");
    loadConfig();
    window.setInterval(loadConfig, 5000);
    window.addEventListener("load", loadConfig, { once: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

export function loaderJavascript() {
  // Wrangler/esbuild may add __name(...) calls inside Function#toString output.
  // The public loader is a separate script, so it needs the same tiny helper
  // in its own scope instead of relying on the gateway bundle scope.
  return `(()=>{"use strict";const __name=(target,value)=>Object.defineProperty(target,"name",{value,configurable:true});const replacePhoneText=${replacePhoneNumbersInText.toString()};const makePhoneHref=${phoneHref.toString()};const replaceScheduleText=${replaceScheduleInText.toString()};(${sitecareLoaderRuntime.toString()})(replacePhoneText,makePhoneHref,replaceScheduleText)})();`;
}

// One generator function per design_template_key. Pure string-in/string-out
// so the SAME function can be `.toString()`-inlined into the public widget
// script (below) and imported directly by the dashboard's own preview --
// the dashboard preview and the live site can never visually diverge
// because there is only one implementation of "what a widget looks like".
function escapeReviewsHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function reviewsStars(rating) {
  const value = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  return "★★★★★☆☆☆☆☆".slice(5 - value, 10 - value);
}

function renderClassicReviewsTemplate(widget) {
  const reviews = Array.isArray(widget?.reviews) ? widget.reviews.slice(0, 20) : [];
  const cards = reviews.map((review) => (
    "<article class='sc-reviews-card'>" +
    "<header class='sc-reviews-card-head'>" +
    (review.authorAvatarUrl ? "<img class='sc-reviews-avatar' src='" + escapeReviewsHtml(review.authorAvatarUrl) + "' alt='' loading='lazy' referrerpolicy='no-referrer'>" : "<span class='sc-reviews-avatar sc-reviews-avatar-placeholder'></span>") +
    "<div><b class='sc-reviews-author'>" + escapeReviewsHtml(review.authorName || "Гость") + "</b>" +
    (review.rating ? "<span class='sc-reviews-stars'>" + reviewsStars(review.rating) + "</span>" : "") +
    "</div></header>" +
    (review.text ? "<p class='sc-reviews-text'>" + escapeReviewsHtml(review.text) + "</p>" : "") +
    "</article>"
  )).join("");
  return { html: "<div class='sc-reviews-classic'>" + (cards || "<p class='sc-reviews-empty'>Отзывов пока нет.</p>") + "</div>", styleKey: "classic" };
}

// "Один отзыв" -- one review in focus with prev/next navigation. The
// renderer only emits the container + a JSON payload of the (already
// truncated) review list in a data attribute; sitecareReviewsRuntime fills
// in the first slide and wires the nav buttons after mount (see
// initSpotlights below) -- a template renderer stays a pure string
// function, but this one kind of widget needs a little client-side state
// (which slide is showing) that a static string can't carry by itself.
function renderSpotlightReviewsTemplate(widget) {
  const reviews = Array.isArray(widget?.reviews) ? widget.reviews.slice(0, 20) : [];
  if (!reviews.length) return { html: "<div class='sc-reviews-spotlight'><p class='sc-reviews-empty'>Отзывов пока нет.</p></div>", styleKey: "spotlight" };
  const slides = reviews.map((review) => ({
    authorName: review.authorName || "Гость",
    rating: Number(review.rating) || 0,
    text: review.text || ""
  }));
  const source = widget?.serviceLabel || "";
  const summary = (widget?.averageRating != null ? "<b class='sc-reviews-spotlight-score'>" + Number(widget.averageRating).toFixed(1) + "</b><span class='sc-reviews-stars'>" + reviewsStars(widget.averageRating) + "</span>" : "") +
    (widget?.reviewCount ? "<span class='sc-reviews-spotlight-count'>" + widget.reviewCount + " отзывов</span>" : "");
  const dataAttr = JSON.stringify(slides).replace(/"/gu, "&quot;");
  return {
    html: "<div class='sc-reviews-spotlight' data-sc-spotlight data-sc-source=\"" + escapeReviewsHtml(source) + "\" data-sc-reviews=\"" + dataAttr + "\">" +
      "<div class='sc-reviews-spotlight-head'>" + summary + "</div>" +
      "<blockquote class='sc-reviews-spotlight-quote'></blockquote>" +
      "<div class='sc-reviews-spotlight-byline'><b class='sc-reviews-spotlight-author'></b><span class='sc-reviews-stars sc-reviews-spotlight-stars'></span></div>" +
      "<div class='sc-reviews-spotlight-nav'>" +
      "<button type='button' class='sc-reviews-spotlight-prev' aria-label='Предыдущий отзыв'>‹</button>" +
      "<span class='sc-reviews-spotlight-pos'></span>" +
      "<button type='button' class='sc-reviews-spotlight-next' aria-label='Следующий отзыв'>›</button>" +
      "</div></div>",
    styleKey: "spotlight"
  };
}

// "Строки" -- a dense list, one line-clamped row per review. Built for
// scanning many reviews in a small footprint (narrow columns, sidebars).
function renderRowsReviewsTemplate(widget) {
  const reviews = Array.isArray(widget?.reviews) ? widget.reviews.slice(0, 20) : [];
  const rows = reviews.map((review) => (
    "<div class='sc-reviews-row'>" +
    "<div class='sc-reviews-row-head'><b>" + escapeReviewsHtml(review.authorName || "Гость") + "</b>" +
    (review.rating ? "<span class='sc-reviews-stars'>" + reviewsStars(review.rating) + "</span>" : "") +
    "</div>" +
    (review.text ? "<p class='sc-reviews-row-text'>" + escapeReviewsHtml(review.text) + "</p>" : "") +
    "</div>"
  )).join("");
  return { html: "<div class='sc-reviews-rows'>" + (rows || "<p class='sc-reviews-empty'>Отзывов пока нет.</p>") + "</div>", styleKey: "rows" };
}

// "Источники на первом плане" -- every review carries a visible badge
// naming the exact service it came from, foregrounding the fact that
// reviews come from independent third-party platforms rather than one
// unverifiable in-house list.
function renderSourcesReviewsTemplate(widget) {
  const reviews = Array.isArray(widget?.reviews) ? widget.reviews.slice(0, 20) : [];
  const source = escapeReviewsHtml(widget?.serviceLabel || "");
  const rows = reviews.map((review) => (
    "<div class='sc-reviews-source-row'>" +
    (review.rating ? "<span class='sc-reviews-stars sc-reviews-source-rating'>" + reviewsStars(review.rating) + "</span>" : "") +
    (review.text ? "<p class='sc-reviews-source-text'>" + escapeReviewsHtml(review.text) + "</p>" : "") +
    "<div class='sc-reviews-source-meta'><b>" + escapeReviewsHtml(review.authorName || "Гость") + "</b>" +
    (source ? "<span class='sc-reviews-source-badge'>" + source + "</span>" : "") +
    "</div></div>"
  )).join("");
  return { html: "<div class='sc-reviews-sources'>" + (rows || "<p class='sc-reviews-empty'>Отзывов пока нет.</p>") + "</div>", styleKey: "sources" };
}

const TEMPLATE_RENDERERS = Object.freeze({
  classic: renderClassicReviewsTemplate,
  spotlight: renderSpotlightReviewsTemplate,
  rows: renderRowsReviewsTemplate,
  sources: renderSourcesReviewsTemplate
});
const TEMPLATE_STYLES = Object.freeze({
  classic: ".sc-reviews-classic{display:grid;gap:14px;font:14px/1.5 -apple-system,'Segoe UI',sans-serif;color:#171b25}" +
    ".sc-reviews-card{border:1px solid #e4e6ef;border-radius:14px;padding:14px 16px;background:#fff}" +
    ".sc-reviews-card-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}" +
    ".sc-reviews-avatar{width:36px;height:36px;border-radius:50%;object-fit:cover;flex:0 0 auto}" +
    ".sc-reviews-avatar-placeholder{background:#e4e6ef;display:inline-block}" +
    ".sc-reviews-author{display:block}.sc-reviews-stars{color:#ffb81c;font-size:13px;letter-spacing:1px}" +
    ".sc-reviews-text{margin:0;white-space:pre-wrap;word-break:break-word}" +
    ".sc-reviews-empty{color:#6b7280;margin:0}",
  spotlight: ".sc-reviews-spotlight{font:14px/1.6 -apple-system,'Segoe UI',sans-serif;color:#171b25;text-align:center;background:#fff;border:1px solid #e4e6ef;border-radius:14px;padding:24px 20px}" +
    ".sc-reviews-spotlight-head{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:18px}" +
    ".sc-reviews-spotlight-score{font-size:22px;font-weight:800}" +
    ".sc-reviews-spotlight-count{color:#6b7280;font-size:13px}" +
    ".sc-reviews-spotlight-quote{margin:0 auto;max-width:520px;font-size:19px;line-height:1.55;font-style:normal;quotes:'\\00AB' '\\00BB'}" +
    ".sc-reviews-spotlight-quote:before{content:open-quote}.sc-reviews-spotlight-quote:after{content:close-quote}" +
    ".sc-reviews-spotlight-byline{margin-top:16px;display:flex;align-items:center;justify-content:center;gap:8px;font-size:13px;color:#6b7280}" +
    ".sc-reviews-spotlight-byline b{color:#171b25;font-weight:600}" +
    ".sc-reviews-spotlight-nav{margin-top:16px;display:flex;align-items:center;justify-content:center;gap:14px}" +
    ".sc-reviews-spotlight-prev,.sc-reviews-spotlight-next{width:32px;height:32px;border-radius:50%;border:1px solid #e4e6ef;background:#fff;font-size:16px;line-height:1;cursor:pointer;color:#171b25}" +
    ".sc-reviews-spotlight-prev:hover,.sc-reviews-spotlight-next:hover{background:#f5f5f8}" +
    ".sc-reviews-spotlight-pos{font-size:13px;color:#6b7280;min-width:56px}",
  rows: ".sc-reviews-rows{font:14px/1.5 -apple-system,'Segoe UI',sans-serif;color:#171b25;background:#fff;border:1px solid #e4e6ef;border-radius:14px;overflow:hidden}" +
    ".sc-reviews-row{padding:13px 16px;border-bottom:1px solid #e4e6ef}.sc-reviews-row:last-child{border-bottom:0}" +
    ".sc-reviews-row-head{display:flex;align-items:center;gap:10px}" +
    ".sc-reviews-row-text{margin:4px 0 0;color:#4b5160;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
  sources: ".sc-reviews-sources{display:grid;gap:12px;font:14px/1.5 -apple-system,'Segoe UI',sans-serif;color:#171b25}" +
    ".sc-reviews-source-row{padding:14px 16px;border:1px solid #e4e6ef;border-radius:14px;background:#fff}" +
    ".sc-reviews-source-text{margin:6px 0 10px;white-space:pre-wrap;word-break:break-word}" +
    ".sc-reviews-source-meta{display:flex;align-items:center;justify-content:space-between;gap:10px}" +
    ".sc-reviews-source-badge{flex:0 0 auto;font-size:12px;font-weight:600;color:#5140bd;background:#f0edff;padding:3px 10px;border-radius:999px}"
});

export function renderReviewsTemplate(templateKey, widget) {
  const renderer = TEMPLATE_RENDERERS[templateKey] || TEMPLATE_RENDERERS.classic;
  return renderer(widget);
}

export const REVIEW_TEMPLATE_KEYS = Object.freeze(Object.keys(TEMPLATE_RENDERERS));

// Deliberately narrower than sitecareLoaderRuntime in three ways (all
// decided during planning): a single fetch on load instead of 5s polling
// (review data changes on the order of days, not seconds); an explicit
// `[data-sitecare-reviews]` mount point the client places themselves
// instead of auto-appending new UI to an unpredictable spot on the page;
// and scoped, once-injected <style> per template instead of relying on the
// host page's CSS.
function sitecareReviewsRuntime(renderTemplate, templateStyles) {
  "use strict";
  const script = document.currentScript || [...(document.scripts || [])].reverse().find((item) =>
    item?.dataset?.sitecareSite && item?.dataset?.sitecareKey && /\/sitecare-reviews-widget\.js(?:[?#]|$)/u.test(item.src || "")
  );
  if (!script) return;
  const id = script.dataset.sitecareSite || "";
  const key = script.dataset.sitecareKey || "";
  if (!/^[a-z0-9_-]{3,80}$/i.test(id) || !/^[A-Za-z0-9_-]{20,128}$/.test(key)) return;
  const base = new URL(script.src).origin;
  const injectedStyles = new Set();

  function ensureStyle(styleKey) {
    if (!styleKey || injectedStyles.has(styleKey) || document.querySelector("style[data-sitecare-reviews-style='" + styleKey + "']")) return;
    const css = templateStyles[styleKey];
    if (!css) return;
    const style = document.createElement("style");
    style.setAttribute("data-sitecare-ignore", "");
    style.setAttribute("data-sitecare-reviews-style", styleKey);
    style.textContent = css;
    document.head?.appendChild(style);
    injectedStyles.add(styleKey);
  }

  function render(config) {
    const targets = document.querySelectorAll("[data-sitecare-reviews]");
    if (!targets.length) {
      document.documentElement?.setAttribute("data-sitecare-reviews-status", "no-target");
      return;
    }
    const widgets = Array.isArray(config?.widgets) ? config.widgets : [];
    // Iframe-embed widgets (e.g. Flamp -- see review-sources/flamp.js) have
    // no review data to template; the visitor's own browser loads the
    // iframe straight from the source, same as the client site's own
    // browser would load any other embedded widget.
    const escapeAttr = (value) => String(value ?? "").replace(/"/g, "&quot;");
    const parts = widgets.map((widget) => {
      if (widget.renderMode === "iframe" && widget.embedUrl) {
        return "<iframe class='sc-reviews-embed' src=\"" + escapeAttr(widget.embedUrl) + "\" loading='lazy' referrerpolicy='no-referrer-when-downgrade' style='width:100%;min-height:400px;border:0'></iframe>";
      }
      const rendered = renderTemplate(widget.designTemplateKey, widget);
      ensureStyle(rendered.styleKey);
      return rendered.html;
    });
    const html = parts.length ? parts.join("") : "";
    for (const target of targets) {
      target.innerHTML = html;
      for (const spotlight of target.querySelectorAll("[data-sc-spotlight]")) initSpotlight(spotlight);
    }
    document.documentElement?.setAttribute("data-sitecare-reviews-status", widgets.length ? "ready" : "empty");
  }

  // "Один отзыв" needs a little client-side state (which slide is active)
  // that the template renderer -- a pure string function -- can't carry by
  // itself; this reads the JSON payload the renderer left in a data
  // attribute and wires the prev/next buttons once, after mount.
  function initSpotlight(container) {
    let slides = [];
    try {
      slides = JSON.parse(container.dataset.scReviews || "[]");
    } catch {
      return;
    }
    if (!slides.length) return;
    const source = container.dataset.scSource || "";
    const quote = container.querySelector(".sc-reviews-spotlight-quote");
    const author = container.querySelector(".sc-reviews-spotlight-author");
    const stars = container.querySelector(".sc-reviews-spotlight-stars");
    const pos = container.querySelector(".sc-reviews-spotlight-pos");
    let index = 0;
    const starGlyphs = (rating) => "★★★★★☆☆☆☆☆".slice(5 - Math.max(0, Math.min(5, rating)), 10 - Math.max(0, Math.min(5, rating)));
    function paint() {
      const slide = slides[index];
      if (quote) quote.textContent = slide.text;
      if (author) author.textContent = slide.authorName + (source ? " — " + source : "");
      if (stars) stars.textContent = starGlyphs(slide.rating);
      if (pos) pos.textContent = (index + 1) + " / " + slides.length;
    }
    container.querySelector(".sc-reviews-spotlight-prev")?.addEventListener("click", () => {
      index = (index - 1 + slides.length) % slides.length;
      paint();
    });
    container.querySelector(".sc-reviews-spotlight-next")?.addEventListener("click", () => {
      index = (index + 1) % slides.length;
      paint();
    });
    paint();
  }

  async function load() {
    try {
      const response = await fetch(base + "/v1/public/sites/" + encodeURIComponent(id) + "/reviews?key=" + encodeURIComponent(key), {
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer"
      });
      if (!response.ok) {
        document.documentElement?.setAttribute("data-sitecare-reviews-status", "config-rejected");
        return;
      }
      const config = await response.json();
      if (!config?.ok || !config.enabled) {
        document.documentElement?.setAttribute("data-sitecare-reviews-status", "disabled");
        return;
      }
      render(config);
    } catch {
      document.documentElement?.setAttribute("data-sitecare-reviews-status", "config-unavailable");
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load, { once: true });
  else load();
  window.addEventListener("load", load, { once: true });
}

export function reviewsWidgetJavascript() {
  return `(()=>{"use strict";const __name=(target,value)=>Object.defineProperty(target,"name",{value,configurable:true});const escapeReviewsHtml=${escapeReviewsHtml.toString()};const reviewsStars=${reviewsStars.toString()};const renderClassicReviewsTemplate=${renderClassicReviewsTemplate.toString()};const renderSpotlightReviewsTemplate=${renderSpotlightReviewsTemplate.toString()};const renderRowsReviewsTemplate=${renderRowsReviewsTemplate.toString()};const renderSourcesReviewsTemplate=${renderSourcesReviewsTemplate.toString()};const TEMPLATE_RENDERERS={classic:renderClassicReviewsTemplate,spotlight:renderSpotlightReviewsTemplate,rows:renderRowsReviewsTemplate,sources:renderSourcesReviewsTemplate};const templateStyles=${JSON.stringify(TEMPLATE_STYLES)};const renderTemplate=(templateKey,widget)=>(TEMPLATE_RENDERERS[templateKey]||TEMPLATE_RENDERERS.classic)(widget);(${sitecareReviewsRuntime.toString()})(renderTemplate,templateStyles)})();`;
}

export function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function nextCheckAt(minutes, from = new Date()) {
  return new Date(from.getTime() + Math.max(5, Number(minutes) || 30) * 60 * 1000).toISOString();
}
