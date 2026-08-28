import { analyzeForms } from "../../src/forms.js";
import { telegramSendMessage } from "../../src/notifications.js";
import { dayKey, newId, nextCheckAt, safeText, validateTargetUrl } from "./platform-core.js";
import { generateSiteInsight } from "./platform-insights.js";

const MAX_PAGE_BYTES = 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function boundedText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PAGE_BYTES) {
      await reader.cancel();
      throw new Error("Страница превышает безопасный размер проверки.");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

async function fetchPage(rawUrl, fetchImpl = fetch) {
  const original = new URL(validateTargetUrl(rawUrl));
  let current = original;
  const started = Date.now();
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetchImpl(current.href, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "SiteCare-Monitor/7.0"
      },
      signal: AbortSignal.timeout(15_000)
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("Location");
      if (!location) throw new Error("Сайт вернул перенаправление без адреса.");
      const next = new URL(validateTargetUrl(new URL(location, current).href));
      if (next.hostname !== original.hostname) throw new Error("Сайт перенаправляет проверку на другой домен.");
      current = next;
      continue;
    }
    const contentType = (response.headers.get("Content-Type") || "").toLocaleLowerCase("en-US");
    if (!response.ok) {
      return { ok: false, httpStatus: response.status, latencyMs: Date.now() - started, html: "", error: `HTTP ${response.status}`, finalUrl: current.href, headers: selectedResponseHeaders(response) };
    }
    if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      return { ok: false, httpStatus: response.status, latencyMs: Date.now() - started, html: "", error: "Адрес вернул не HTML-страницу.", finalUrl: current.href, headers: selectedResponseHeaders(response) };
    }
    return { ok: true, httpStatus: response.status, latencyMs: Date.now() - started, html: await boundedText(response), error: "", finalUrl: current.href, headers: selectedResponseHeaders(response) };
  }
  throw new Error("Слишком много перенаправлений.");
}

function selectedResponseHeaders(response) {
  const get = (name) => safeText(response?.headers?.get?.(name), 500);
  return {
    contentType: get("content-type"),
    cacheControl: get("cache-control"),
    contentSecurityPolicy: get("content-security-policy"),
    xContentTypeOptions: get("x-content-type-options"),
    referrerPolicy: get("referrer-policy")
  };
}

function blockIds(html) {
  return [...new Set([...String(html || "").matchAll(/\bid=["'](rec\d+)["']/giu)].map((match) => match[1]))].slice(0, 500);
}

function scriptAttribute(rawAttributes, expectedName) {
  const pattern = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of String(rawAttributes || "").matchAll(pattern)) {
    if (match[1].toLocaleLowerCase("en-US") === expectedName) return match[2] ?? match[3] ?? match[4] ?? "";
  }
  return "";
}

function decodeHtmlText(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Math.min(0x10ffff, Number(code) || 32)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(code, 16) || 32)));
}

function visibleText(value) {
  return decodeHtmlText(String(value || "")
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replace(/<br\s*\/?>/giu, " ")
    .replace(/<[^>]+>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
}

function htmlAttribute(rawAttributes, expectedName) {
  const pattern = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of String(rawAttributes || "").matchAll(pattern)) {
    if (match[1].toLocaleLowerCase("en-US") === expectedName) return decodeHtmlText(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return "";
}

function stableCandidateId(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `btn_${hash.toString(36).padStart(7, "0")}`;
}

function stablePhoneCandidateId(value) {
  return stableCandidateId(value).replace(/^btn_/u, "phone_");
}

function stableImageCandidateId(value) {
  return stableCandidateId(value).replace(/^btn_/u, "img_");
}

function pageBlockRanges(html) {
  return [...String(html || "").matchAll(/\bid=["'](rec\d+)["']/giu)]
    .map((match) => ({ index: match.index || 0, id: match[1] }))
    .slice(0, 1000);
}

function blockAt(ranges, index) {
  let result = "";
  for (const range of ranges) {
    if (range.index > index) break;
    result = range.id;
  }
  return result;
}

function blockBounds(ranges, index, sourceLength) {
  let start = 0;
  let end = sourceLength;
  for (let cursor = 0; cursor < ranges.length; cursor += 1) {
    if (ranges[cursor].index > index) {
      end = ranges[cursor].index;
      break;
    }
    start = ranges[cursor].index;
  }
  return { start, end };
}

function sectionDetails(source, ranges, index) {
  const bounds = blockBounds(ranges, index, source.length);
  const blockStart = Math.max(0, source.lastIndexOf("<", bounds.start));
  const blockEndCandidate = source.lastIndexOf("<", bounds.end);
  const blockEnd = blockEndCandidate > blockStart ? blockEndCandidate : bounds.end;
  const localIndex = Math.max(0, index - blockStart);
  const block = source.slice(blockStart, blockEnd);
  let heading = "";
  for (const match of block.slice(0, Math.min(block.length, localIndex + 1)).matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/giu)) {
    heading = safeText(visibleText(match[1]), 90);
  }
  if (!heading) {
    const allHeadings = [...block.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/giu)];
    heading = safeText(visibleText(allHeadings[0]?.[1]), 90);
  }
  const blockText = visibleText(block);
  const context = safeText(blockText, 150);
  return {
    sectionLabel: heading ? `Раздел «${heading}»` : "Блок на странице",
    context
  };
}

function phoneLooksPublic(value, context = "") {
  const raw = String(value || "").trim();
  const normalized = raw.replace(/\D/gu, "");
  if (normalized.length < 10 || normalized.length > 15) return false;
  const formatted = raw.startsWith("+") || /[()\s\u00a0.–—-]/u.test(raw);
  const cue = /телефон|тел\.?\s*:|phone|позвон|звоните|контакт/iu.test(context);
  const nearbyEmail = /[\p{L}a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/iu.test(context);
  if (!formatted && !cue && !nearbyEmail) return false;
  if (/^\d{10,15}$/u.test(raw)) {
    const position = String(context).indexOf(raw);
    const left = position >= 0 ? String(context).slice(Math.max(0, position - 42), position) : "";
    const right = position >= 0 ? String(context).slice(position + raw.length, position + raw.length + 24) : "";
    const adjacentCue = /(?:телефон|тел\.?|phone|номер|позвон(?:ить|ите)?|контакт)\s*(?::|№)?\s*$/iu.test(left) ||
      /^\s*(?:—|-|:)?\s*(?:телефон|тел\.?|phone|номер)\b/iu.test(right);
    if (!adjacentCue && !nearbyEmail) return false;
  }
  return true;
}

function phoneCandidates(source, url, ranges, title) {
  const candidates = [];
  const occurrenceCounts = new Map();
  const seen = new Set();
  const add = ({ phone, rawIndex, sourceType, blockId }) => {
    const originalDigits = String(phone || "").replace(/\D/gu, "");
    if (!originalDigits) return;
    const duplicateKey = `${blockId}|${sourceType}|${originalDigits}|${rawIndex}`;
    if (seen.has(duplicateKey)) return;
    seen.add(duplicateKey);
    const occurrenceKey = `${blockId}|${sourceType}|${originalDigits}`;
    const occurrenceIndex = occurrenceCounts.get(occurrenceKey) || 0;
    occurrenceCounts.set(occurrenceKey, occurrenceIndex + 1);
    const details = sectionDetails(source, ranges, rawIndex);
    const identity = `${url.pathname}|${blockId}|${sourceType}|${occurrenceIndex}|${originalDigits}`;
    candidates.push({
      candidateId: stablePhoneCandidateId(identity),
      pagePath: url.pathname || "/",
      pageUrl: url.href,
      pageTitle: title,
      blockId,
      source: sourceType,
      occurrenceIndex,
      matchIndex: candidates.length,
      phone: safeText(phone, 60),
      originalDigits,
      sectionLabel: details.sectionLabel,
      context: details.context
    });
  };

  const telRanges = [];
  for (const match of source.matchAll(/<a\b([^>]*)\bhref\s*=\s*(?:"tel:([^"]*)"|'tel:([^']*)'|tel:([^\s>]+))([^>]*)>([\s\S]*?)<\/a>/giu)) {
    const hrefValue = decodeHtmlText(match[2] ?? match[3] ?? match[4] ?? "");
    const visible = safeText(visibleText(match[6]), 60);
    const phone = visible && phoneLooksPublic(visible, visible) ? visible : hrefValue;
    const rawIndex = match.index || 0;
    if (phoneLooksPublic(phone, `телефон ${visible}`)) {
      add({ phone, rawIndex, sourceType: "link", blockId: blockAt(ranges, rawIndex) });
      telRanges.push([rawIndex, rawIndex + match[0].length]);
    }
  }

  const textSource = [...source];
  for (const [start, end] of telRanges) for (let index = start; index < end; index += 1) textSource[index] = " ";
  const withoutTelLinks = textSource.join("");
  for (const chunk of withoutTelLinks.matchAll(/>([^<>]{1,1200})</gu)) {
    const decoded = decodeHtmlText(chunk[1]);
    for (const match of decoded.matchAll(/\+?\d(?:[\d ()\u00a0.–—-]*\d){9,14}/gu)) {
      const contextStart = Math.max(0, (match.index || 0) - 80);
      const contextEnd = Math.min(decoded.length, (match.index || 0) + match[0].length + 80);
      if (!phoneLooksPublic(match[0], decoded.slice(contextStart, contextEnd))) continue;
      const rawIndex = (chunk.index || 0) + 1 + (match.index || 0);
      add({ phone: match[0], rawIndex, sourceType: "text", blockId: blockAt(ranges, rawIndex) });
      if (candidates.length >= 120) return candidates;
    }
  }

  // Tilda sometimes splits one visible phone between nested spans. Scanning
  // individual text chunks then misses it even though a visitor sees a normal
  // number. A second, block-level pass joins the visible text and catches such
  // numbers. Plain long digit strings are accepted only next to an explicit
  // phone cue, which keeps counters and analytics identifiers out of results.
  const sections = ranges.length
    ? ranges.map((range, index) => ({
      blockId: range.id,
      start: range.index,
      end: ranges[index + 1]?.index || source.length
    }))
    : [{ blockId: "", start: 0, end: source.length }];
  for (const section of sections) {
    const text = visibleText(source.slice(section.start, section.end));
    for (const match of text.matchAll(/\+?\d(?:[\d ()\u00a0.–—-]*\d){9,14}/gu)) {
      const contextStart = Math.max(0, (match.index || 0) - 90);
      const contextEnd = Math.min(text.length, (match.index || 0) + match[0].length + 90);
      if (!phoneLooksPublic(match[0], text.slice(contextStart, contextEnd))) continue;
      const digits = match[0].replace(/\D/gu, "");
      const alreadyFound = candidates.some((candidate) =>
        candidate.blockId === section.blockId && candidate.originalDigits === digits
      );
      if (alreadyFound) continue;
      add({ phone: match[0], rawIndex: section.start, sourceType: "text", blockId: section.blockId });
      if (candidates.length >= 160) return candidates;
    }
  }
  return candidates;
}

function pageTitle(html, pageUrl) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(String(html || ""));
  return safeText(visibleText(match?.[1]) || new URL(pageUrl).pathname || "Главная", 120);
}

function metaContent(source, name, attribute = "name") {
  const expectedName = String(name || "").toLocaleLowerCase("en-US");
  for (const match of String(source || "").matchAll(/<meta\b([^>]*)>/giu)) {
    const attributes = match[1] || "";
    if (htmlAttribute(attributes, attribute).toLocaleLowerCase("en-US") === expectedName) {
      return safeText(htmlAttribute(attributes, "content"), 500);
    }
  }
  return "";
}

function linkHref(source, relation) {
  const expected = String(relation || "").toLocaleLowerCase("en-US");
  for (const match of String(source || "").matchAll(/<link\b([^>]*)>/giu)) {
    const attributes = match[1] || "";
    const rel = htmlAttribute(attributes, "rel").toLocaleLowerCase("en-US").split(/\s+/u);
    if (rel.includes(expected)) return safeText(htmlAttribute(attributes, "href"), 500);
  }
  return "";
}

function diagnosticIssue({ id, category, severity = "medium", title, page, evidence, recommendation, probableCause, confidence = "high" }) {
  return {
    issueId: safeText(id, 120),
    category: safeText(category, 40),
    severity: new Set(["high", "medium", "low"]).has(severity) ? severity : "medium",
    title: safeText(title, 180),
    page: safeText(page, 500),
    evidence: safeText(evidence, 500),
    recommendation: safeText(recommendation, 500),
    probableCause: safeText(probableCause, 400),
    confidence: confidence === "medium" ? "medium" : "high"
  };
}

export function computeHealthScore({ high = 0, medium = 0, low = 0 } = {}) {
  const score = 100 - 15 * Number(high || 0) - 5 * Number(medium || 0) - 1 * Number(low || 0);
  return Math.max(0, Math.min(100, Math.round(score)));
}

// Same severity tally computeHealthScore already uses for the site-wide score,
// scoped to one diagnostics category -- so a per-category gauge and the
// overall health score stay two views of the same formula, not two different
// scoring philosophies.
export function categorySeverityCounts(issues, category) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const issue of issues || []) {
    if (issue?.category === category && counts[issue.severity] !== undefined) counts[issue.severity] += 1;
  }
  return counts;
}

export function diagnosePage(html, pageUrl, observation = {}) {
  const source = String(html || "");
  const url = new URL(validateTargetUrl(pageUrl));
  const path = url.pathname || "/";
  const title = pageTitle(source, url.href);
  const rawTitle = safeText(visibleText(/<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(source)?.[1]), 300);
  const description = metaContent(source, "description");
  const robots = `${metaContent(source, "robots")} ${metaContent(source, "googlebot")}`.toLocaleLowerCase("en-US");
  const canonical = linkHref(source, "canonical");
  const lang = safeText(htmlAttribute(/<html\b([^>]*)>/iu.exec(source)?.[1] || "", "lang"), 30);
  const headings = [...source.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/giu)].map((match) => safeText(visibleText(match[1]), 220)).filter(Boolean);
  const images = [...source.matchAll(/<img\b([^>]*)>/giu)].map((match) => ({
    src: safeText(htmlAttribute(match[1], "src"), 500),
    alt: htmlAttribute(match[1], "alt").trim()
  }));
  const meaningfulImages = images.filter((image) => image.src && !/(?:pixel|counter|spacer|blank|\.svg(?:[?#]|$))/iu.test(image.src));
  const imagesWithoutAlt = meaningfulImages.filter((image) => !image.alt).length;
  const mixedContent = [...source.matchAll(/(?:src|href)\s*=\s*["'](http:\/\/[^"']+)/giu)].map((match) => safeText(match[1], 300)).slice(0, 10);
  const viewport = metaContent(source, "viewport");
  const wordCount = (visibleText(source).match(/[\p{L}\p{N}]+/gu) || []).length;
  const structuredDataCount = (source.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["']/giu) || []).length;
  const issues = [];
  const add = (issue) => issues.push(diagnosticIssue({ ...issue, page: url.href }));

  if (!rawTitle) add({ id: `title-missing:${path}`, category: "seo", severity: "high", title: "Не задан заголовок страницы", evidence: "В опубликованном HTML отсутствует тег title.", recommendation: "Задайте понятный заголовок страницы в настройках SEO Tilda.", probableCause: "SEO-настройки страницы не заполнены или изменения не опубликованы." });
  else if (rawTitle.length < 15 || rawTitle.length > 65) add({ id: `title-length:${path}`, category: "seo", severity: "low", title: "Заголовок страницы нетипичной длины", evidence: `Длина title: ${rawTitle.length} символов.`, recommendation: "Проверьте, понятно ли заголовок описывает страницу в поисковой выдаче.", probableCause: "Заголовок мог быть перенесён из шаблона или заполнен без учёта поискового сниппета.", confidence: "medium" });
  if (!description) add({ id: `description-missing:${path}`, category: "seo", severity: "medium", title: "Не заполнено описание для поиска", evidence: "В HTML отсутствует meta description.", recommendation: "Добавьте уникальное описание страницы в настройках SEO.", probableCause: "Поле description не заполнено в настройках страницы." });
  if (/\bnoindex\b/u.test(robots)) add({ id: `noindex:${path}`, category: "seo", severity: "high", title: "Страница закрыта от индексации", evidence: `Robots: ${robots.trim()}.`, recommendation: "Если страница должна находиться в поиске, снимите запрет индексации и переопубликуйте её.", probableCause: "В настройках страницы или проекта включён запрет индексации.", confidence: "high" });
  if (!headings.length) add({ id: `h1-missing:${path}`, category: "content", severity: "medium", title: "На странице не найден главный заголовок", evidence: "В опубликованном HTML отсутствует видимый H1.", recommendation: "Добавьте один понятный главный заголовок, соответствующий теме страницы.", probableCause: "Заголовок оформлен обычным текстом или скрыт настройками блока." });
  if (headings.length > 1) add({ id: `h1-multiple:${path}`, category: "content", severity: "low", title: "На странице несколько главных заголовков", evidence: `Найдено H1: ${headings.length}.`, recommendation: "Проверьте структуру: основной смысл страницы обычно лучше выделять одним H1.", probableCause: "Несколько блоков Tilda могли быть настроены как заголовок H1.", confidence: "medium" });
  if (!lang) add({ id: `lang-missing:${path}`, category: "accessibility", severity: "low", title: "Не указан язык страницы", evidence: "У тега html отсутствует атрибут lang.", recommendation: "Укажите язык проекта, чтобы браузеры и экранные дикторы корректно обрабатывали текст.", probableCause: "Язык проекта не выбран или шаблон не вывел атрибут." });
  if (!viewport) add({ id: `viewport-missing:${path}`, category: "mobile", severity: "high", title: "Не задан мобильный viewport", evidence: "В HTML отсутствует meta viewport.", recommendation: "Проверьте мобильные настройки и публикацию страницы.", probableCause: "Код шаблона или пользовательский HTML мог удалить стандартный viewport." });
  if (imagesWithoutAlt > 0) add({ id: `image-alt:${path}`, category: "accessibility", severity: imagesWithoutAlt >= 5 ? "medium" : "low", title: "У изображений нет текстового описания", evidence: `Изображений без alt: ${imagesWithoutAlt} из ${meaningfulImages.length}.`, recommendation: "Добавьте осмысленные alt-описания содержательным изображениям; декоративные можно оставить пустыми.", probableCause: "Описание изображений не заполнено в контенте блоков Tilda." });
  if (mixedContent.length) add({ id: `mixed-content:${path}`, category: "security", severity: "high", title: "На HTTPS-странице есть небезопасные ресурсы", evidence: `Найдено HTTP-ссылок на ресурсы: ${mixedContent.length}.`, recommendation: "Замените адреса ресурсов на HTTPS и перепроверьте страницу.", probableCause: "В пользовательском блоке или старом виджете остались ссылки http://." });
  if (!canonical) add({ id: `canonical-missing:${path}`, category: "seo", severity: "low", title: "Не найден канонический адрес", evidence: "В HTML отсутствует link rel=canonical.", recommendation: "Проверьте основной адрес страницы, особенно если она доступна по нескольким URL.", probableCause: "Канонический URL не задан или не выведен настройками проекта.", confidence: "medium" });
  const ogTitle = metaContent(source, "og:title", "property");
  const ogImage = metaContent(source, "og:image", "property");
  if (!ogTitle || !ogImage) add({ id: `og-tags:${path}`, category: "social", severity: "low", title: "Не заполнены данные для превью в соцсетях", evidence: `Отсутствует ${!ogTitle && !ogImage ? "og:title и og:image" : !ogTitle ? "og:title" : "og:image"}.`, recommendation: "Заполните заголовок и картинку для шеринга в настройках SEO страницы.", probableCause: "Поля Open Graph не заполнены в настройках страницы.", confidence: "medium" });
  if (!linkHref(source, "icon")) add({ id: `favicon-missing:${path}`, category: "content", severity: "low", title: "Не найден favicon", evidence: "В HTML отсутствует link rel=icon.", recommendation: "Добавьте иконку сайта в настройках проекта Tilda.", probableCause: "Иконка проекта не загружена или не опубликована.", confidence: "medium" });
  if (!/<meta\b[^>]*\bcharset\s*=/iu.test(source)) add({ id: `charset-missing:${path}`, category: "content", severity: "medium", title: "Не указана кодировка страницы", evidence: "В HTML отсутствует meta charset.", recommendation: "Обычно это ставится автоматически; проверьте, не повреждён ли пользовательский код в HEAD.", probableCause: "Тег meta charset мог быть удалён пользовательским кодом в HEAD." });
  if (Number(observation.latencyMs || 0) > 2500) add({ id: `latency:${path}`, category: "performance", severity: Number(observation.latencyMs) > 5000 ? "high" : "medium", title: "Страница отвечает медленно", evidence: `Время получения HTML: ${Number(observation.latencyMs)} мс.`, recommendation: "Повторите замер в другое время; если задержка сохраняется, проверьте тяжёлые скрипты, внешние сервисы и публикацию.", probableCause: "Вероятны задержка сети, перегруженный внешний сервис или тяжёлый пользовательский код; одного замера недостаточно для точной причины.", confidence: "medium" });
  if (source.length > 700_000) add({ id: `html-size:${path}`, category: "performance", severity: "medium", title: "HTML страницы слишком большой", evidence: `Размер HTML: ${Math.round(source.length / 1024)} КБ.`, recommendation: "Проверьте дублирующиеся блоки, встроенный код и объём контента.", probableCause: "На странице много блоков, встроенных данных или повторяющегося пользовательского кода." });
  if (structuredDataCount === 0) add({ id: `ai-structured-data:${path}`, category: "ai", severity: "medium", title: "Нет микроразметки для ИИ-поиска и умных ответов", evidence: "На странице не найдено ни одного блока structured data (JSON-LD).", recommendation: "Добавьте разметку schema.org (LocalBusiness/Organization) с адресом, часами работы и контактами — так ИИ-сервисы и поисковики точнее берут данные с сайта, а не додумывают их.", probableCause: "Микроразметка не была добавлена при создании сайта.", confidence: "medium" });

  // Heuristic static-HTML checks, not a legal audit: a cookie banner injected
  // purely by a third-party script, or a policy page linked in a way this
  // regex doesn't recognize, can produce a false "not found". The site-wide
  // privacy-link issue below is filtered per-page in scanSiteInventory so it
  // reports once, not once per crawled page.
  const hasPrivacyLink = /<a\b[^>]*href\s*=\s*["'][^"']*(?:privacy|policy|confidencial|конфиденц)[^"']*["'][^>]*>/iu.test(source)
    || /политик[аи]\s+конфиденциальности|обработк[аи]\s+персональных\s+данных/iu.test(visibleText(source));
  const hasForm = /<form\b/iu.test(source);
  const consentNearForm = hasForm && /соглаша(?:юсь|ется)|согласи[ея]\s+на\s+обработку|обработку\s+(?:своих\s+)?персональных\s+данных|я\s+согласен/iu.test(visibleText(source));
  const cookieBannerFound = /cookie[-\s]?(?:consent|banner|notice|indicator)|используем\s+файлы\s+cookie|согласны?\s+с\s+использованием\s+cookie/iu.test(source);
  if (!hasPrivacyLink) add({ id: `legal-privacy-link:${path}`, category: "legal", severity: "medium", title: "Не найдена ссылка на политику конфиденциальности", evidence: "На странице не обнаружена ссылка или упоминание политики обработки персональных данных.", recommendation: "Добавьте в подвал сайта ссылку на страницу с политикой конфиденциальности.", probableCause: "Страница политики не создана или ссылка на неё не добавлена в футер.", confidence: "medium" });
  if (hasForm && !consentNearForm) add({ id: `legal-consent-form:${path}`, category: "legal", severity: "high", title: "У формы нет текста согласия на обработку данных", evidence: "На странице есть форма, но рядом не найден текст о согласии на обработку персональных данных.", recommendation: "Добавьте рядом с формой чекбокс или текст о согласии на обработку персональных данных (152-ФЗ).", probableCause: "Форма настроена без блока согласия на обработку данных.", confidence: "medium" });
  if (!cookieBannerFound) add({ id: `legal-cookie-banner:${path}`, category: "legal", severity: "low", title: "Не обнаружено уведомление об использовании cookie", evidence: "В HTML не найдены признаки баннера согласия на использование cookie.", recommendation: "Включите уведомление об использовании cookie в настройках сайта.", probableCause: "Баннер cookie не включён, либо подключается сторонним скриптом, который не виден в HTML.", confidence: "medium" });

  return {
    facts: {
      url: url.href,
      path,
      title,
      titleLength: rawTitle.length,
      description,
      descriptionLength: description.length,
      noindex: /\bnoindex\b/u.test(robots),
      canonical,
      lang,
      h1Count: headings.length,
      h1: headings.slice(0, 4),
      imageCount: meaningfulImages.length,
      imagesWithoutAlt,
      mixedContentCount: mixedContent.length,
      wordCount,
      structuredDataCount,
      latencyMs: Number(observation.latencyMs || 0),
      httpStatus: Number(observation.httpStatus || 0),
      htmlBytes: source.length,
      securityHeaders: observation.headers || {},
      hasPrivacyLink
    },
    issues
  };
}

export function extractEditableInventory(html, pageUrl, observation = {}) {
  const url = new URL(validateTargetUrl(pageUrl));
  const source = String(html || "");
  const ranges = pageBlockRanges(source);
  const formAnalysis = analyzeForms(source, blockIds(source));
  const title = pageTitle(source, url.href);
  const buttons = [];
  let index = 0;
  for (const match of source.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/giu)) {
    const tagName = match[1].toLocaleLowerCase("en-US");
    const attributes = match[2] || "";
    const text = safeText(visibleText(match[3]), 180);
    const rawHref = tagName === "a" ? htmlAttribute(attributes, "href").trim() : "";
    if (!text && !rawHref) continue;
    if (/^(?:javascript:|mailto:|tel:|#)/iu.test(rawHref)) {
      if (!text || !/btn|button|кноп/u.test(attributes)) continue;
    }
    let absoluteUrl = rawHref;
    if (rawHref && !/^(?:tel:|mailto:|javascript:|#)/iu.test(rawHref)) {
      try { absoluteUrl = new URL(rawHref, url).href; } catch { absoluteUrl = rawHref; }
    }
    const blockId = blockAt(ranges, match.index || 0);
    const identity = `${url.pathname}|${blockId}|${index}|${tagName}|${text}|${absoluteUrl}`;
    const details = sectionDetails(source, ranges, match.index || 0);
    buttons.push({
      candidateId: stableCandidateId(identity),
      pagePath: url.pathname || "/",
      pageUrl: url.href,
      pageTitle: title,
      blockId,
      tagName,
      matchIndex: index,
      text,
      url: absoluteUrl,
      label: safeText(text || absoluteUrl || `Кнопка ${index + 1}`, 180),
      sectionLabel: details.sectionLabel,
      context: details.context
    });
    index += 1;
    if (buttons.length >= 250) break;
  }

  const images = [];
  let imgIndex = 0;
  for (const match of source.matchAll(/<img\b([^>]*)>/giu)) {
    const attributes = match[1] || "";
    const rawSrc = htmlAttribute(attributes, "src").trim();
    if (!rawSrc) continue;
    const currentAlt = htmlAttribute(attributes, "alt").trim();
    let absoluteSrc = rawSrc;
    try { absoluteSrc = new URL(rawSrc, url).href; } catch { absoluteSrc = rawSrc; }
    const blockId = blockAt(ranges, match.index || 0);
    const identity = `${url.pathname}|${blockId}|${imgIndex}|img|${absoluteSrc}|${currentAlt}`;
    const details = sectionDetails(source, ranges, match.index || 0);
    images.push({
      candidateId: stableImageCandidateId(identity),
      pagePath: url.pathname || "/",
      pageUrl: url.href,
      pageTitle: title,
      blockId,
      matchIndex: imgIndex,
      src: safeText(absoluteSrc, 500),
      currentAlt,
      label: safeText(currentAlt || `Изображение ${imgIndex + 1}`, 180),
      sectionLabel: details.sectionLabel,
      context: details.context
    });
    imgIndex += 1;
    if (images.length >= 250) break;
  }

  const schedules = [...new Set((visibleText(source).match(/(?:пн|вт|ср|чт|пт|сб|вс|ежедневно|будн)[^.!?\n]{0,45}\d{1,2}[:.]\d{2}\s*[–—-]\s*\d{1,2}[:.]\d{2}/giu) || [])
    .map((value) => safeText(value, 120)))].slice(0, 20);
  const phonesFound = phoneCandidates(source, url, ranges, title);
  const phones = [...new Map(phonesFound.map((candidate) => [candidate.originalDigits, candidate.phone])).values()].slice(0, 30);

  const diagnostics = diagnosePage(source, url.href, observation);
  return {
    page: { url: url.href, path: url.pathname || "/", title },
    buttons,
    images,
    phoneCandidates: phonesFound,
    schedules,
    phones,
    forms: formAnalysis.forms.map((form, index) => ({
      key: form.formId && form.formId !== "без id"
        ? `id:${form.formId}`
        : `page:${url.pathname || "/"}:block:${form.blockId || index}`,
      ready: Boolean(form.structuralReady)
    })),
    formCount: formAnalysis.formCount,
    readyFormCount: formAnalysis.readyCount,
    legacyCodeDetected: /t123[^<]{0,80}(?:sitecare|loader)|sitecare[^<]{0,80}t123/iu.test(source),
    metrikaCounterId: detectYandexMetrikaCounter(source),
    diagnostics
  };
}

function internalPageLinks(html, pageUrl) {
  const current = new URL(pageUrl);
  const links = [];
  for (const match of String(html || "").matchAll(/<a\b([^>]*)>/giu)) {
    const raw = htmlAttribute(match[1], "href").trim();
    if (!raw || /^(?:#|mailto:|tel:|javascript:)/iu.test(raw)) continue;
    try {
      const url = new URL(raw, current);
      if (url.origin !== current.origin || url.username || url.password) continue;
      if (/\.(?:jpe?g|png|gif|webp|svg|pdf|zip|rar|docx?|xlsx?|mp4|mp3)(?:$|[?#])/iu.test(url.pathname)) continue;
      url.search = "";
      url.hash = "";
      links.push(url.href);
    } catch {
      // Broken public links are ignored while the rest of the site is scanned.
    }
    if (links.length >= 80) break;
  }
  return [...new Set(links)];
}

export async function scanSiteInventory(site, fetchImpl = fetch, { maxPages = 40 } = {}) {
  const target = new URL(validateTargetUrl(site.target_url));
  const boundedLimit = Math.min(80, Math.max(1, Number(maxPages) || 40));
  const queue = [target.href];
  if (site.scope === "site") {
    const root = new URL("/", target.origin).href;
    if (root !== target.href) queue.push(root);
  }
  const visited = new Set();
  const pages = [];
  const errors = [];
  while (queue.length && visited.size < boundedLimit) {
    const next = queue.shift();
    if (!next || visited.has(next)) continue;
    visited.add(next);
    try {
      const fetched = await fetchPage(next, fetchImpl);
      if (!fetched.ok) {
        errors.push({ url: next, error: safeText(fetched.error, 160) });
        continue;
      }
      pages.push(extractEditableInventory(fetched.html, fetched.finalUrl || next, fetched));
      if (site.scope === "site") {
        for (const link of internalPageLinks(fetched.html, next)) {
          if (!visited.has(link) && !queue.includes(link) && queue.length < boundedLimit * 4) queue.push(link);
        }
      }
    } catch (error) {
      errors.push({ url: next, error: safeText(error instanceof Error ? error.message : "Страница недоступна.", 160) });
    }
  }
  const candidates = pages.flatMap((page) => page.buttons).slice(0, 500);
  const images = pages.flatMap((page) => page.images || []).slice(0, 500);
  const foundPhones = pages.flatMap((page) => page.phoneCandidates || []).slice(0, 500);
  const duplicateLocations = new Map();
  for (const candidate of foundPhones) {
    const key = `${candidate.pagePath}|${candidate.sectionLabel}|${candidate.originalDigits}`;
    duplicateLocations.set(key, (duplicateLocations.get(key) || 0) + 1);
  }
  const locationCounters = new Map();
  const precisePhones = foundPhones.map((candidate) => {
    const key = `${candidate.pagePath}|${candidate.sectionLabel}|${candidate.originalDigits}`;
    const ordinal = (locationCounters.get(key) || 0) + 1;
    locationCounters.set(key, ordinal);
    return {
      ...candidate,
      locationOrdinal: ordinal,
      locationLabel: duplicateLocations.get(key) > 1 ? `${candidate.sectionLabel} · вхождение ${ordinal}` : candidate.sectionLabel
    };
  });
  const uniqueForms = new Map();
  for (const page of pages) {
    for (const form of page.forms || []) {
      const previous = uniqueForms.get(form.key);
      uniqueForms.set(form.key, { key: form.key, ready: Boolean(previous?.ready || form.ready) });
    }
  }
  const diagnosticIssues = pages.flatMap((page) => page.diagnostics?.issues || []);
  for (const error of errors) {
    diagnosticIssues.push(diagnosticIssue({
      id: `page-unavailable:${error.url}`,
      category: "availability",
      severity: "high",
      title: "Страница недоступна для проверки",
      page: error.url,
      evidence: error.error,
      recommendation: "Откройте страницу вручную и проверьте адрес, публикацию и ограничения доступа.",
      probableCause: "Возможны удалённая страница, ошибка публикации, блокировка автоматической проверки или временный сетевой сбой.",
      confidence: "medium"
    }));
  }
  const duplicateFacts = (key, label) => {
    const grouped = new Map();
    for (const page of pages) {
      const value = safeText(page.diagnostics?.facts?.[key], 500).toLocaleLowerCase("ru-RU");
      if (!value) continue;
      if (!grouped.has(value)) grouped.set(value, []);
      grouped.get(value).push(page.page);
    }
    for (const group of grouped.values()) {
      if (group.length < 2) continue;
      diagnosticIssues.push(diagnosticIssue({
        id: `duplicate-${key}:${group[0].path}`,
        category: "seo",
        severity: "medium",
        title: `Одинаковый ${label} у нескольких страниц`,
        page: group[0].url,
        evidence: `Совпадение найдено на страницах: ${group.slice(0, 6).map((page) => page.path).join(", ")}.`,
        recommendation: `Сделайте ${label} уникальным для смысла каждой страницы.`,
        probableCause: "SEO-настройки могли быть скопированы вместе со страницей или оставлены от шаблона."
      }));
    }
  };
  duplicateFacts("title", "заголовок");
  duplicateFacts("description", "description");
  // A privacy-policy link usually lives once in a global footer, not on every
  // crawled page -- judging it per-page would spam one issue per page even
  // when the site genuinely has the link. Collapse to a single site-level
  // issue only if it's missing everywhere.
  const siteHasPrivacyLink = pages.some((page) => page.diagnostics?.facts?.hasPrivacyLink);
  const diagnosticIssuesFiltered = diagnosticIssues.filter((issue) => !issue.issueId.startsWith("legal-privacy-link:"));
  diagnosticIssues.length = 0;
  diagnosticIssues.push(...diagnosticIssuesFiltered);
  if (!siteHasPrivacyLink && pages.length) {
    diagnosticIssues.push(diagnosticIssue({
      id: `legal-privacy-link:site`,
      category: "legal",
      severity: "medium",
      title: "Не найдена ссылка на политику конфиденциальности",
      page: pages[0].page.url,
      evidence: "Ни на одной проверенной странице не обнаружена ссылка или упоминание политики обработки персональных данных.",
      recommendation: "Добавьте в подвал сайта ссылку на страницу с политикой конфиденциальности.",
      probableCause: "Страница политики не создана или ссылка на неё не добавлена в футер.",
      confidence: "medium"
    }));
  }
  const severityCounts = { high: 0, medium: 0, low: 0 };
  const categoryCounts = {};
  for (const issue of diagnosticIssues) {
    severityCounts[issue.severity] = (severityCounts[issue.severity] || 0) + 1;
    categoryCounts[issue.category] = (categoryCounts[issue.category] || 0) + 1;
  }
  return {
    scannedAt: new Date().toISOString(),
    pageCount: pages.length,
    pages: pages.map((item) => ({ ...item.page, schedules: item.schedules })),
    candidates,
    images,
    phoneCandidates: precisePhones,
    formCount: uniqueForms.size,
    readyFormCount: [...uniqueForms.values()].filter((form) => form.ready).length,
    phones: [...new Map(precisePhones.map((item) => [item.originalDigits, item.phone])).values()].slice(0, 50),
    schedules: [...new Set(pages.flatMap((item) => item.schedules))].slice(0, 30),
    legacyCodeDetected: pages.some((item) => item.legacyCodeDetected),
    metrikaCounterId: pages.map((item) => item.metrikaCounterId).find(Boolean) || null,
    truncated: queue.length > 0,
    errors,
    diagnostics: {
      checkedAt: new Date().toISOString(),
      pagesAnalyzed: pages.length,
      pagesFailed: errors.length,
      truncated: queue.length > 0,
      summary: {
        total: diagnosticIssues.length,
        high: severityCounts.high,
        medium: severityCounts.medium,
        low: severityCounts.low,
        categories: categoryCounts,
        categoryScores: Object.fromEntries(
          ["seo", "content", "accessibility", "mobile", "security", "performance", "social", "legal", "ai"].map((category) => [
            category,
            computeHealthScore(categorySeverityCounts(diagnosticIssues, category))
          ])
        )
      },
      issues: diagnosticIssues.slice(0, 120),
      pageFacts: pages.map((page) => page.diagnostics?.facts).filter(Boolean).slice(0, 80),
      methodology: "Автоматическая проверка опубликованного HTML и ответа сервера. Она не заменяет ручной аудит аналитики, контента, юзабилити и защищённости серверной инфраструктуры."
    }
  };
}

export function detectYandexMetrikaCounter(html) {
  const source = String(html || "");
  const initMatch = /\bym\(\s*(\d{5,10})\s*,\s*["']init["']/u.exec(source);
  if (initMatch) return initMatch[1];
  // Tilda's own generated snippet doesn't pass the id straight into ym() -
  // it assigns it to a variable first (window.mainMetrikaId='NNN'; ym(window.mainMetrikaId, "init", ...)).
  // Confirmed against a real published Tilda page, not just the generic docs example.
  const variableMatch = /mainMetrikaId\s*=\s*["'](\d{5,10})["']/u.exec(source);
  if (variableMatch) return variableMatch[1];
  const watchMatch = /mc\.yandex\.ru\/watch\/(\d{5,10})/u.exec(source);
  if (watchMatch) return watchMatch[1];
  return null;
}

export function sitecareLoaderPresent(html, site) {
  if (!site?.site_id || !site?.loader_key) return null;
  for (const match of String(html || "").matchAll(/<script\b([^>]*)>/giu)) {
    const attributes = match[1];
    const src = scriptAttribute(attributes, "src");
    if (
      scriptAttribute(attributes, "data-sitecare-site") === site.site_id &&
      scriptAttribute(attributes, "data-sitecare-key") === site.loader_key &&
      /\/sitecare-loader\.js(?:[?#]|$)/u.test(src)
    ) return true;
  }
  return false;
}

export async function inspectSite(site, fetchImpl = fetch) {
  const started = Date.now();
  try {
    const page = await fetchPage(site.target_url, fetchImpl);
    if (!page.ok) {
      return {
        domainOk: page.httpStatus > 0,
        tlsOk: page.httpStatus > 0,
        pageOk: false,
        formOk: false,
        httpStatus: page.httpStatus,
        latencyMs: page.latencyMs,
        formCount: 0,
        forms: [],
        loaderOk: site?.loader_key ? false : null,
        metrikaCounterId: null,
        details: safeText(page.error || "Страница недоступна.")
      };
    }
    const analysis = analyzeForms(page.html, blockIds(page.html));
    const expected = Math.max(0, Number(site.expected_form_count) || 0);
    const formRequired = Boolean(Number(site.form_required));
    let discoveredFormCount = analysis.formCount;
    let readyFormCount = analysis.readyCount;
    if (formRequired && site.scope === "site" && readyFormCount < Math.max(1, expected)) {
      const inventory = await scanSiteInventory(site, fetchImpl, { maxPages: 40 });
      discoveredFormCount = Math.max(discoveredFormCount, Number(inventory.formCount || 0));
      readyFormCount = Math.max(readyFormCount, Number(inventory.readyFormCount || 0));
    }
    const formOk = !formRequired || (readyFormCount >= Math.max(1, expected));
    return {
      domainOk: true,
      tlsOk: true,
      pageOk: true,
      formOk,
      httpStatus: page.httpStatus,
      latencyMs: page.latencyMs,
      formCount: discoveredFormCount,
      forms: analysis.forms,
      loaderOk: sitecareLoaderPresent(page.html, site),
      metrikaCounterId: detectYandexMetrikaCounter(page.html),
      details: formOk
        ? discoveredFormCount > 0 ? `Найдено форм: ${discoveredFormCount}. Структура готова.` : "Сайт открывается. Формы не обнаружены."
        : `Ожидалось форм: ${Math.max(1, expected)}, исправных: ${analysis.readyCount}.`
    };
  } catch (error) {
    return {
      domainOk: false,
      tlsOk: false,
      pageOk: false,
      formOk: false,
      httpStatus: 0,
      latencyMs: Date.now() - started,
      formCount: 0,
      forms: [],
      loaderOk: site?.loader_key ? false : null,
      metrikaCounterId: null,
      details: safeText(error instanceof Error ? error.message : "Страница недоступна.")
    };
  }
}

export async function sendNotification(env, site, eventId, eventType, text) {
  const destination = await env.GATEWAY_DB.prepare(
    "SELECT chat_id, enabled FROM telegram_destinations WHERE site_id = ?"
  ).bind(site.site_id).first();
  if (!destination?.enabled) return { sent: false, reason: "not-linked" };
  const existing = await env.GATEWAY_DB.prepare(
    "SELECT status FROM gateway_deliveries WHERE site_id = ? AND event_id = ?"
  ).bind(site.site_id, eventId).first();
  if (existing?.status === "sent" || existing?.status === "pending") return { sent: false, reason: "duplicate" };
  const now = new Date().toISOString();
  if (existing) {
    await env.GATEWAY_DB.prepare(
      "UPDATE gateway_deliveries SET status = 'pending', updated_at = ?, details = 'Повторная отправка.' WHERE site_id = ? AND event_id = ?"
    ).bind(now, site.site_id, eventId).run();
  } else {
    await env.GATEWAY_DB.prepare(
      "INSERT OR IGNORE INTO gateway_deliveries (site_id, event_id, event_type, status, created_at, updated_at, details) VALUES (?, ?, ?, 'pending', ?, ?, 'Отправка начата.')"
    ).bind(site.site_id, eventId, eventType, now, now).run();
  }
  try {
    await telegramSendMessage(env.TELEGRAM_BOT_TOKEN, destination.chat_id, text);
    await env.GATEWAY_DB.prepare(
      "UPDATE gateway_deliveries SET status = 'sent', updated_at = ?, details = 'Уведомление отправлено.' WHERE site_id = ? AND event_id = ?"
    ).bind(new Date().toISOString(), site.site_id, eventId).run();
    return { sent: true };
  } catch (error) {
    await env.GATEWAY_DB.prepare(
      "UPDATE gateway_deliveries SET status = 'failed', updated_at = ?, details = ? WHERE site_id = ? AND event_id = ?"
    ).bind(new Date().toISOString(), safeText(error instanceof Error ? error.message : "Telegram недоступен."), site.site_id, eventId).run();
    return { sent: false, reason: "telegram-failed" };
  }
}

async function openIncident(env, site, kind, summary, checkedAt, notify) {
  const incidentId = newId("inc", `${site.site_id}-${kind}`);
  await env.GATEWAY_DB.prepare(
    "INSERT OR IGNORE INTO platform_incidents (incident_id, site_id, kind, status, summary, opened_at, resolved_at, last_notified_at) VALUES (?, ?, ?, 'open', ?, ?, NULL, NULL)"
  ).bind(incidentId, site.site_id, kind, safeText(summary, 220), checkedAt).run();
  const incident = await env.GATEWAY_DB.prepare(
    "SELECT incident_id, last_notified_at FROM platform_incidents WHERE site_id = ? AND kind = ? AND status = 'open'"
  ).bind(site.site_id, kind).first();
  if (notify && incident && !incident.last_notified_at) {
    const eventType = kind === "page" ? "page-down" : "form-down";
    const label = kind === "page" ? "сайт недоступен" : "форма требует внимания";
    const sent = await sendNotification(
      env,
      site,
      `${site.site_id}:${eventType}:${incident.incident_id}`,
      eventType,
      `⚠️ SiteCare: ${label}\n${site.name}\n${site.target_url}\n${safeText(summary, 180)}`
    );
    if (sent.sent) {
      await env.GATEWAY_DB.prepare("UPDATE platform_incidents SET last_notified_at = ? WHERE incident_id = ?")
        .bind(checkedAt, incident.incident_id).run();
    }
  }
}

async function resolveIncident(env, site, kind, checkedAt, notify) {
  const incident = await env.GATEWAY_DB.prepare(
    "SELECT incident_id, last_notified_at FROM platform_incidents WHERE site_id = ? AND kind = ? AND status = 'open'"
  ).bind(site.site_id, kind).first();
  if (!incident) return;
  await env.GATEWAY_DB.prepare(
    "UPDATE platform_incidents SET status = 'resolved', resolved_at = ? WHERE incident_id = ? AND status = 'open'"
  ).bind(checkedAt, incident.incident_id).run();
  if (notify && incident.last_notified_at) {
    const eventType = kind === "page" ? "page-recovered" : "form-recovered";
    const label = kind === "page" ? "сайт снова работает" : "форма снова исправна";
    await sendNotification(
      env,
      site,
      `${site.site_id}:${eventType}:${incident.incident_id}`,
      eventType,
      `✅ SiteCare: ${label}\n${site.name}\n${site.target_url}`
    );
  }
}

export async function checkPlatformSite(env, site, { notify = true, fetchImpl = fetch } = {}) {
  const inspected = await inspectSite(site, fetchImpl);
  const checkedAt = new Date().toISOString();
  const [previousRun, formConnections] = await Promise.all([
    env.GATEWAY_DB.prepare(
      "SELECT page_ok, form_ok FROM platform_monitor_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1"
    ).bind(site.site_id).first(),
    Number(site.form_required)
      ? env.GATEWAY_DB.prepare("SELECT COUNT(*) AS count FROM platform_form_connections WHERE site_id = ?").bind(site.site_id).first()
      : Promise.resolve({ count: 0 })
  ]);
  const expectedForms = Number(site.form_required) ? Math.max(1, Number(site.expected_form_count) || 1) : 0;
  const connectedForms = Number(formConnections?.count || 0);
  const deliveryReady = !Number(site.form_required) || connectedForms >= expectedForms;
  const result = {
    ...inspected,
    formStructureOk: inspected.formOk,
    formOk: inspected.formOk && deliveryReady,
    connectedFormCount: connectedForms,
    expectedFormCount: expectedForms,
    details: inspected.formOk && !deliveryReady
      ? `Формы опубликованы, но заявки подтверждены для ${connectedForms} из ${expectedForms}.`
      : inspected.details
  };

  if (!result.pageOk && previousRun && Number(previousRun.page_ok) === 0) {
    await openIncident(env, site, "page", result.details, checkedAt, notify);
  } else if (result.pageOk) {
    await resolveIncident(env, site, "page", checkedAt, notify);
  }

  if (result.pageOk && Number(site.form_required)) {
    if (!result.formOk && previousRun && Number(previousRun.form_ok) === 0) {
      await openIncident(env, site, "form", result.details, checkedAt, notify);
    } else if (result.formOk) {
      await resolveIncident(env, site, "form", checkedAt, notify);
    }
  }

  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare(
      "UPDATE platform_sites SET last_monitor_at = ?, next_monitor_at = ?, domain_ok = ?, tls_ok = ?, page_ok = ?, form_ok = ?, loader_ok = ?, loader_checked_at = ?, last_http_status = ?, last_latency_ms = ?, last_error = ?, metrika_counter_id = COALESCE(metrika_counter_id, ?), updated_at = ? WHERE site_id = ?"
    ).bind(
      checkedAt,
      nextCheckAt(site.monitor_interval_minutes),
      result.domainOk ? 1 : 0,
      result.tlsOk ? 1 : 0,
      result.pageOk ? 1 : 0,
      result.formOk ? 1 : 0,
      result.loaderOk === null ? null : result.loaderOk ? 1 : 0,
      checkedAt,
      result.httpStatus,
      result.latencyMs,
      result.pageOk && result.formOk ? null : result.details,
      result.metrikaCounterId || null,
      checkedAt,
      site.site_id
    ),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_monitor_runs (site_id, checked_at, domain_ok, tls_ok, page_ok, form_ok, http_status, latency_ms, form_count, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(site.site_id, checkedAt, result.domainOk ? 1 : 0, result.tlsOk ? 1 : 0, result.pageOk ? 1 : 0, result.formOk ? 1 : 0, result.httpStatus, result.latencyMs, result.formCount, safeText(result.details, 300)),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_usage_daily (account_id, usage_day, monitor_checks, form_signals, ai_requests) VALUES (?, ?, 1, 0, 0) ON CONFLICT(account_id, usage_day) DO UPDATE SET monitor_checks = monitor_checks + 1"
    ).bind(site.account_id, dayKey()),
    env.GATEWAY_DB.prepare(
      "DELETE FROM platform_monitor_runs WHERE site_id = ? AND id NOT IN (SELECT id FROM platform_monitor_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1000)"
    ).bind(site.site_id, site.site_id)
  ]);
  return result;
}

// Shared by every "which sites currently pay for Site Control" scheduled job
// (uptime monitor, health score scan, weekly digest) so the trial/billing
// eligibility rules live in exactly one place.
const ACTIVE_CONTROL_SITES_FROM_WHERE =
  "FROM platform_sites s JOIN platform_accounts a ON a.account_id = s.account_id " +
  "LEFT JOIN platform_billing b ON b.account_id = a.account_id " +
  "LEFT JOIN platform_account_features f ON f.account_id = a.account_id AND f.feature_key = 'control' " +
  "WHERE s.status = 'active' AND s.integration_mode = 'central' AND a.status = 'active' " +
  "AND ((f.status IN ('trial_pending', 'active', 'complimentary')) OR (f.status = 'trial' AND (f.current_period_end IS NULL OR f.current_period_end > ?)) " +
  "OR (f.status IS NULL AND ((b.status IS NULL AND (a.plan != 'trial' OR a.trial_ends_at IS NULL OR a.trial_ends_at > ?)) " +
  "OR b.status IN ('trial_pending', 'active', 'complimentary') OR (b.status = 'trial' AND (b.current_period_end IS NULL OR b.current_period_end > ?)))))";

export async function runDuePlatformChecks(env, { limit = 25 } = {}) {
  const now = new Date().toISOString();
  const rows = await env.GATEWAY_DB.prepare(
    `SELECT s.* ${ACTIVE_CONTROL_SITES_FROM_WHERE} AND (s.next_monitor_at IS NULL OR s.next_monitor_at <= ?) ORDER BY COALESCE(s.next_monitor_at, s.created_at) LIMIT ?`
  ).bind(now, now, now, now, Math.min(25, Math.max(1, Number(limit) || 10))).all();
  const sites = rows?.results || [];
  const settled = await Promise.allSettled(sites.map((site) => checkPlatformSite(env, site, { notify: true })));
  return { checked: sites.length, failed: settled.filter((item) => item.status === "rejected").length };
}

// Full diagnostics (SEO, accessibility, mixed content, etc.) are heavier than
// the uptime/form check, so the health score runs once a day per site rather
// than on every 5-minute monitor tick.
// Shared by the daily cron scan and the manual "Запустить диагностику" button
// so both contribute the same data point to the health-score trend the AI
// Analyst reads - a diagnostics run only the user triggers is just as real
// a signal as the scheduled one.
export async function recordHealthCheck(env, site, inventory) {
  const summary = inventory.diagnostics?.summary || { high: 0, medium: 0, low: 0, total: 0 };
  const score = computeHealthScore(summary);
  const checkedAt = new Date().toISOString();
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare(
      "UPDATE platform_sites SET last_health_check_at = ?, next_health_check_at = ?, health_score = ?, updated_at = ? WHERE site_id = ?"
    ).bind(checkedAt, nextCheckAt(24 * 60, new Date(checkedAt)), score, checkedAt, site.site_id),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_health_history (site_id, checked_at, score, high, medium, low, issue_count) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(site.site_id, checkedAt, score, summary.high || 0, summary.medium || 0, summary.low || 0, summary.total || 0),
    env.GATEWAY_DB.prepare(
      "DELETE FROM platform_health_history WHERE site_id = ? AND id NOT IN (SELECT id FROM platform_health_history WHERE site_id = ? ORDER BY id DESC LIMIT 60)"
    ).bind(site.site_id, site.site_id),
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_diagnostics_cache (site_id, diagnostics_json, checked_at) VALUES (?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET diagnostics_json = excluded.diagnostics_json, checked_at = excluded.checked_at"
    ).bind(site.site_id, JSON.stringify(inventory.diagnostics || {}), checkedAt)
  ]);
  return { score, ...summary };
}

async function runSiteHealthScan(env, site, fetchImpl = fetch) {
  const inventory = await scanSiteInventory(site, fetchImpl, { maxPages: site.scope === "site" ? 40 : 1 });
  const result = await recordHealthCheck(env, site, inventory);
  try {
    await generateSiteInsight(env, site, { fetchImpl });
  } catch (err) {
    console.error("ai_insight_failed", err?.message);
  }
  return result;
}

export async function runDueHealthScans(env, { limit = 10, fetchImpl = fetch } = {}) {
  const now = new Date().toISOString();
  const rows = await env.GATEWAY_DB.prepare(
    `SELECT s.* ${ACTIVE_CONTROL_SITES_FROM_WHERE} AND (s.next_health_check_at IS NULL OR s.next_health_check_at <= ?) ORDER BY COALESCE(s.next_health_check_at, s.created_at) LIMIT ?`
  ).bind(now, now, now, now, Math.min(10, Math.max(1, Number(limit) || 5))).all();
  const sites = rows?.results || [];
  const settled = await Promise.allSettled(sites.map((site) => runSiteHealthScan(env, site, fetchImpl)));
  return { scanned: sites.length, failed: settled.filter((item) => item.status === "rejected").length };
}

function chunkArray(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

// Content that survives an edit through Tilda itself (not through SiteCare)
// has to be diffed against something content-independent, or the "identity"
// changes along with the content and old/new look like two unrelated
// candidates. blockId (Tilda's stable id="recNNN") + matchIndex (page-local
// discovery order) is the closest thing to a stable slot key static HTML
// analysis can offer — it can drift if a block is reordered or a new match
// is inserted earlier in the same block, an accepted approximation.
export function buildContentFields(inventory) {
  const fields = new Map();
  const set = (pagePath, pageTitle, field, slotKey, slotLabel, value) => {
    if (value === undefined || value === null) return;
    const key = `${pagePath}|${field}|${slotKey}`;
    fields.set(key, { pagePath, pageTitle: safeText(pageTitle, 200), field, slotKey, slotLabel: safeText(slotLabel, 120), value: safeText(value, 400) });
  };
  const pageFacts = inventory?.diagnostics?.pageFacts || [];
  for (const page of inventory?.pages || []) {
    const facts = pageFacts.find((item) => item.path === page.path);
    if (facts) {
      set(page.path, page.title, "title", "", "", facts.title);
      set(page.path, page.title, "description", "", "", facts.description);
      set(page.path, page.title, "h1", "", "", (facts.h1 || []).join(" / "));
    }
    (page.schedules || []).forEach((schedule, index) => set(page.path, page.title, "schedule", String(index), "", schedule));
  }
  for (const candidate of inventory?.phoneCandidates || []) {
    set(candidate.pagePath, candidate.pageTitle, "phone", `${candidate.blockId}|${candidate.matchIndex}`, candidate.sectionLabel, candidate.phone);
  }
  for (const candidate of inventory?.candidates || []) {
    if (candidate.text) set(candidate.pagePath, candidate.pageTitle, "button_text", `${candidate.blockId}|${candidate.matchIndex}`, candidate.sectionLabel, candidate.text);
    if (candidate.url) set(candidate.pagePath, candidate.pageTitle, "button_url", `${candidate.blockId}|${candidate.matchIndex}`, candidate.sectionLabel, candidate.url);
  }
  return fields;
}

export async function runSiteContentAudit(env, site, fetchImpl = fetch) {
  const inventory = await scanSiteInventory(site, fetchImpl, { maxPages: site.scope === "site" ? 40 : 1 });
  const fields = buildContentFields(inventory);
  const existingRows = await env.GATEWAY_DB.prepare(
    "SELECT page_path, field, slot_key, value FROM platform_content_snapshots WHERE site_id = ?"
  ).bind(site.site_id).all();
  const existing = new Map((existingRows?.results || []).map((row) => [`${row.page_path}|${row.field}|${row.slot_key}`, row.value]));
  const checkedAt = new Date().toISOString();
  const statements = [];
  let changesLogged = 0;
  for (const field of fields.values()) {
    const key = `${field.pagePath}|${field.field}|${field.slotKey}`;
    const previous = existing.get(key);
    statements.push(env.GATEWAY_DB.prepare(
      "INSERT INTO platform_content_snapshots (site_id, page_path, field, slot_key, value, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(site_id, page_path, field, slot_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).bind(site.site_id, field.pagePath, field.field, field.slotKey, field.value, checkedAt));
    // A slot seen for the first time only seeds the snapshot -- logging a
    // "changed from nothing" entry on every site's first-ever audit would
    // flood the log with noise instead of real edits.
    if (previous !== undefined && previous !== field.value) {
      statements.push(env.GATEWAY_DB.prepare(
        "INSERT INTO platform_content_changes (site_id, page_path, page_title, field, slot_label, old_value, new_value, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(site.site_id, field.pagePath, field.pageTitle, field.field, field.slotLabel, previous, field.value, checkedAt));
      changesLogged += 1;
    }
  }
  for (const group of chunkArray(statements, 50)) await env.GATEWAY_DB.batch(group);
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare(
      "DELETE FROM platform_content_changes WHERE site_id = ? AND id NOT IN (SELECT id FROM platform_content_changes WHERE site_id = ? ORDER BY id DESC LIMIT 200)"
    ).bind(site.site_id, site.site_id),
    env.GATEWAY_DB.prepare(
      "UPDATE platform_sites SET last_content_audit_at = ?, next_content_audit_at = ? WHERE site_id = ?"
    ).bind(checkedAt, nextCheckAt(24 * 60, new Date(checkedAt)), site.site_id)
  ]);
  return { fieldsTracked: fields.size, changesLogged };
}

export async function runDueContentAudits(env, { limit = 10, fetchImpl = fetch } = {}) {
  const now = new Date().toISOString();
  const rows = await env.GATEWAY_DB.prepare(
    `SELECT s.* ${ACTIVE_CONTROL_SITES_FROM_WHERE} AND (s.next_content_audit_at IS NULL OR s.next_content_audit_at <= ?) ORDER BY COALESCE(s.next_content_audit_at, s.created_at) LIMIT ?`
  ).bind(now, now, now, now, Math.min(10, Math.max(1, Number(limit) || 5))).all();
  const sites = rows?.results || [];
  const settled = await Promise.allSettled(sites.map((site) => runSiteContentAudit(env, site, fetchImpl)));
  return { audited: sites.length, failed: settled.filter((item) => item.status === "rejected").length };
}

function daysWord(count) {
  const mod10 = count % 10, mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return "дней";
  if (mod10 === 1) return "день";
  if (mod10 >= 2 && mod10 <= 4) return "дня";
  return "дней";
}

// RDAP (the modern, standardized successor to WHOIS) is free, needs no API
// key, and rdap.org bootstraps to the correct registry for most TLDs -- a
// meaningfully better option than a paid WHOIS API for a feature this
// low-frequency. Registrar-name extraction across registries is
// inconsistent (jCard parsing, not always present); the expiry date is the
// feature's real value, so the registrar name is kept best-effort only.
export async function checkDomainExpiry(hostname, fetchImpl = fetch) {
  const response = await fetchImpl(`https://rdap.org/domain/${encodeURIComponent(hostname)}`, { headers: { Accept: "application/rdap+json" } });
  if (!response.ok) throw new Error(`RDAP HTTP ${response.status}`);
  const data = await response.json();
  const expiration = (Array.isArray(data.events) ? data.events : []).find((event) => event.eventAction === "expiration");
  return {
    expiresAt: expiration?.eventDate ? new Date(expiration.eventDate).toISOString() : null,
    registrar: safeText(data.ldhName || "", 200)
  };
}

async function runSiteDomainCheck(env, site, fetchImpl = fetch) {
  const checkedAt = new Date().toISOString();
  let expiresAt = null, registrar = "", errorText = "";
  try {
    const result = await checkDomainExpiry(new URL(site.target_origin).hostname, fetchImpl);
    expiresAt = result.expiresAt;
    registrar = result.registrar;
  } catch (error) {
    errorText = safeText(error instanceof Error ? error.message : "RDAP недоступен.", 200);
  }
  await env.GATEWAY_DB.prepare(
    "UPDATE platform_sites SET domain_expires_at = ?, domain_registrar = ?, last_domain_check_at = ?, next_domain_check_at = ?, domain_check_error = ?, updated_at = ? WHERE site_id = ?"
  ).bind(expiresAt, registrar || null, checkedAt, nextCheckAt(7 * 24 * 60, new Date(checkedAt)), errorText || null, checkedAt, site.site_id).run();
  if (expiresAt) {
    const daysLeft = Math.floor((Date.parse(expiresAt) - Date.now()) / (24 * 60 * 60 * 1000));
    // eventId is stable per site+expiry-date, so sendNotification's own
    // dedup naturally sends this once per unresolved expiry rather than
    // needing a separate notified-at column here.
    if (daysLeft >= 0 && daysLeft <= 30) {
      await sendNotification(
        env, site, `${site.site_id}:domain-expiring:${expiresAt.slice(0, 10)}`, "domain-expiring",
        `⚠️ Домен сайта «${site.name}» истекает через ${daysLeft} ${daysWord(daysLeft)} (${expiresAt.slice(0, 10)}). Продлите регистрацию домена, чтобы сайт не перестал открываться.`
      );
    }
  }
  return { expiresAt, error: Boolean(errorText) };
}

export async function runDueDomainChecks(env, { limit = 10, fetchImpl = fetch } = {}) {
  const now = new Date().toISOString();
  const rows = await env.GATEWAY_DB.prepare(
    `SELECT s.* ${ACTIVE_CONTROL_SITES_FROM_WHERE} AND (s.next_domain_check_at IS NULL OR s.next_domain_check_at <= ?) ORDER BY COALESCE(s.next_domain_check_at, s.created_at) LIMIT ?`
  ).bind(now, now, now, now, Math.min(10, Math.max(1, Number(limit) || 5))).all();
  const sites = rows?.results || [];
  const settled = await Promise.allSettled(sites.map((site) => runSiteDomainCheck(env, site, fetchImpl)));
  return { checked: sites.length, failed: settled.filter((item) => item.status === "rejected").length };
}

// Always frames the week as a result, never as an absence of work — "checked
// N times, steady" is the honest positive version of "nothing broke".
export function buildDigestSummary({
  score = null,
  scoreDelta = 0,
  checksCount = 0,
  incidentsOpened = 0,
  incidentsResolved = 0,
  findingsCount = 0
} = {}) {
  const scoreLine = score === null
    ? ""
    : ` Индекс здоровья: ${score}${scoreDelta > 0 ? ` (+${scoreDelta})` : scoreDelta < 0 ? ` (${scoreDelta})` : " (без изменений)"}.`;
  if (incidentsOpened === 0 && findingsCount === 0) {
    return `За неделю сайт проверен ${checksCount} раз — всё стабильно, поводов для беспокойства не найдено.${scoreLine}`;
  }
  const parts = [`За неделю сайт проверен ${checksCount} раз.`];
  if (incidentsOpened > 0) {
    parts.push(`Обнаружено проблем с доступностью: ${incidentsOpened}, устранено: ${incidentsResolved}.`);
  }
  if (findingsCount > 0) {
    parts.push(`Диагностика нашла ${findingsCount} момент${findingsCount === 1 ? "" : "ов"}, которые стоит поправить.`);
  }
  return `${parts.join(" ")}${scoreLine}`;
}

async function sendDigest(env, site, digest) {
  const text = `📋 SiteCare: итоги недели\n${site.name}\n${digest.summaryText}`;
  return sendNotification(env, site, `${site.site_id}:digest:${digest.periodEnd}`, "digest", text);
}

async function runSiteDigest(env, site) {
  const now = new Date();
  const periodEnd = now.toISOString();
  const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [checksRow, incidentsRow, latestHealth, priorHealth] = await Promise.all([
    env.GATEWAY_DB.prepare(
      "SELECT COUNT(*) AS count FROM platform_monitor_runs WHERE site_id = ? AND checked_at >= ?"
    ).bind(site.site_id, periodStart).first(),
    env.GATEWAY_DB.prepare(
      "SELECT SUM(CASE WHEN opened_at >= ? THEN 1 ELSE 0 END) AS opened, SUM(CASE WHEN resolved_at >= ? THEN 1 ELSE 0 END) AS resolved FROM platform_incidents WHERE site_id = ? AND (opened_at >= ? OR resolved_at >= ?)"
    ).bind(periodStart, periodStart, site.site_id, periodStart, periodStart).first(),
    env.GATEWAY_DB.prepare(
      "SELECT score, issue_count FROM platform_health_history WHERE site_id = ? ORDER BY checked_at DESC LIMIT 1"
    ).bind(site.site_id).first(),
    env.GATEWAY_DB.prepare(
      "SELECT score FROM platform_health_history WHERE site_id = ? AND checked_at <= ? ORDER BY checked_at DESC LIMIT 1"
    ).bind(site.site_id, periodStart).first()
  ]);
  const score = latestHealth ? Number(latestHealth.score) : null;
  const scoreDelta = latestHealth && priorHealth ? Number(latestHealth.score) - Number(priorHealth.score) : 0;
  const summaryText = buildDigestSummary({
    score,
    scoreDelta,
    checksCount: Number(checksRow?.count || 0),
    incidentsOpened: Number(incidentsRow?.opened || 0),
    incidentsResolved: Number(incidentsRow?.resolved || 0),
    findingsCount: Number(latestHealth?.issue_count || 0)
  });
  const digestId = newId("dig", `${site.site_id}-${periodEnd}`);
  const digest = {
    digestId,
    periodStart,
    periodEnd,
    score,
    scoreDelta,
    checksCount: Number(checksRow?.count || 0),
    incidentsOpened: Number(incidentsRow?.opened || 0),
    incidentsResolved: Number(incidentsRow?.resolved || 0),
    findingsCount: Number(latestHealth?.issue_count || 0),
    summaryText
  };
  const delivery = await sendDigest(env, site, digest);
  const sentAt = delivery.sent ? new Date().toISOString() : null;
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_digests (digest_id, site_id, period_start, period_end, score, score_delta, checks_count, incidents_opened, incidents_resolved, findings_count, summary_text, sent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(digestId, site.site_id, periodStart, periodEnd, digest.score, digest.scoreDelta, digest.checksCount, digest.incidentsOpened, digest.incidentsResolved, digest.findingsCount, summaryText, sentAt, periodEnd),
    env.GATEWAY_DB.prepare(
      "UPDATE platform_sites SET next_digest_at = ? WHERE site_id = ?"
    ).bind(nextCheckAt(7 * 24 * 60, now), site.site_id),
    env.GATEWAY_DB.prepare(
      "DELETE FROM platform_digests WHERE site_id = ? AND digest_id NOT IN (SELECT digest_id FROM platform_digests WHERE site_id = ? ORDER BY created_at DESC LIMIT 26)"
    ).bind(site.site_id, site.site_id)
  ]);
  return digest;
}

export async function runDueDigests(env, { limit = 10 } = {}) {
  const now = new Date().toISOString();
  const rows = await env.GATEWAY_DB.prepare(
    `SELECT s.* ${ACTIVE_CONTROL_SITES_FROM_WHERE} AND s.next_digest_at IS NOT NULL AND s.next_digest_at <= ? ORDER BY s.next_digest_at LIMIT ?`
  ).bind(now, now, now, now, Math.min(10, Math.max(1, Number(limit) || 5))).all();
  const sites = rows?.results || [];
  const settled = await Promise.allSettled(sites.map((site) => runSiteDigest(env, site)));
  return { sent: sites.length, failed: settled.filter((item) => item.status === "rejected").length };
}

async function runSiteMonitorRollup(env, site) {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const day = dayStart.toISOString().slice(0, 10);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const stats = await env.GATEWAY_DB.prepare(
    "SELECT COUNT(*) AS checks, SUM(page_ok) AS page_ok_count, AVG(latency_ms) AS avg_latency FROM platform_monitor_runs WHERE site_id = ? AND checked_at >= ? AND checked_at < ?"
  ).bind(site.site_id, dayStart.toISOString(), dayEnd.toISOString()).first();
  await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare(
      "INSERT INTO platform_monitor_daily (site_id, day, checks, page_ok_count, avg_latency_ms) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(site_id, day) DO UPDATE SET checks = excluded.checks, page_ok_count = excluded.page_ok_count, avg_latency_ms = excluded.avg_latency_ms"
    ).bind(site.site_id, day, Number(stats?.checks || 0), Number(stats?.page_ok_count || 0), Math.round(Number(stats?.avg_latency || 0))),
    env.GATEWAY_DB.prepare("UPDATE platform_sites SET next_rollup_at = ? WHERE site_id = ?").bind(nextCheckAt(24 * 60, now), site.site_id)
  ]);
}

export async function runDueMonitorRollups(env, { limit = 25 } = {}) {
  const now = new Date().toISOString();
  const rows = await env.GATEWAY_DB.prepare(
    `SELECT s.* ${ACTIVE_CONTROL_SITES_FROM_WHERE} AND (s.next_rollup_at IS NULL OR s.next_rollup_at <= ?) ORDER BY COALESCE(s.next_rollup_at, s.created_at) LIMIT ?`
  ).bind(now, now, now, now, Math.min(25, Math.max(1, Number(limit) || 10))).all();
  const sites = rows?.results || [];
  const settled = await Promise.allSettled(sites.map((site) => runSiteMonitorRollup(env, site)));
  return { rolled: sites.length, failed: settled.filter((item) => item.status === "rejected").length };
}

// platform_monitor_runs is capped at the last 1000 rows/site (~3.5 days at
// the 5-minute cron cadence), so any report window beyond that would
// silently under-count without the daily rollup. Combine rolled-up history
// (accurate, unbounded) with today's still-unrolled raw runs (freshness) --
// the rollup only ever covers up to yesterday, so there's no overlap to
// double-count.
export async function siteReport(env, siteId, days = 30) {
  const boundedDays = Math.min(90, Math.max(1, Number(days) || 30));
  const since = new Date(Date.now() - boundedDays * 24 * 60 * 60 * 1000);
  const sinceDay = since.toISOString().slice(0, 10);
  const todayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const [rollup, todayRuns, receipts, incidents, site] = await Promise.all([
    env.GATEWAY_DB.prepare(
      "SELECT SUM(checks) AS checks, SUM(page_ok_count) AS page_ok_count, SUM(checks * avg_latency_ms) AS latency_weighted FROM platform_monitor_daily WHERE site_id = ? AND day >= ?"
    ).bind(siteId, sinceDay).first(),
    env.GATEWAY_DB.prepare(
      "SELECT COUNT(*) AS checks, SUM(page_ok) AS page_ok_count, AVG(latency_ms) AS average_latency FROM platform_monitor_runs WHERE site_id = ? AND checked_at >= ?"
    ).bind(siteId, todayStart).first(),
    env.GATEWAY_DB.prepare(
      "SELECT COUNT(*) AS count FROM platform_form_receipts WHERE site_id = ? AND received_at >= ?"
    ).bind(siteId, since.toISOString()).first(),
    env.GATEWAY_DB.prepare(
      "SELECT COUNT(*) AS count FROM platform_incidents WHERE site_id = ? AND opened_at >= ?"
    ).bind(siteId, since.toISOString()).first(),
    env.GATEWAY_DB.prepare("SELECT domain_expires_at, domain_registrar, domain_check_error FROM platform_sites WHERE site_id = ?").bind(siteId).first()
  ]);
  const checks = Number(rollup?.checks || 0) + Number(todayRuns?.checks || 0);
  const ok = Number(rollup?.page_ok_count || 0) + Number(todayRuns?.page_ok_count || 0);
  const latencySum = Number(rollup?.latency_weighted || 0) + Number(todayRuns?.checks || 0) * Number(todayRuns?.average_latency || 0);
  return {
    days: boundedDays,
    checks,
    uptimePercent: checks ? Number(((ok / checks) * 100).toFixed(2)) : 100,
    averageLatencyMs: checks ? Math.round(latencySum / checks) : 0,
    formSignals: Number(receipts?.count || 0),
    incidents: Number(incidents?.count || 0),
    domainExpiresAt: site?.domain_expires_at || null,
    domainRegistrar: site?.domain_registrar || null,
    domainCheckError: site?.domain_check_error || null
  };
}

export const monitorInternals = Object.freeze({ blockIds, fetchPage, internalPageLinks, selectedResponseHeaders, stableCandidateId, visibleText });
