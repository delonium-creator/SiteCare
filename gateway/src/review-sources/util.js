// Shared helpers for review-source adapters. Kept dependency-free (no DOM
// APIs -- Workers have none) so every adapter can parse a fetched page with
// plain string/regex operations only.

export function decodeHtmlText(value) {
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

// Unescapes a single-quoted JS string literal's body (the text between the
// quotes) without eval/Function -- several review sources hydrate their
// React app via `var STATE = JSON.parse('...')` inline in the page, and the
// literal needs de-escaping before it's valid JSON text.
export function unescapeJsStringLiteral(value) {
  return String(value || "")
    .replace(/\\u([0-9a-fA-F]{4})/gu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/gu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\(.)/gsu, (_, ch) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" }[ch] ?? ch));
}

const MAX_PAGE_BYTES = 4 * 1024 * 1024;

async function boundedText(response) {
  if (!response.body) return await response.text();
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
      throw new Error("Страница источника отзывов превышает безопасный размер загрузки.");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

// Real fetch failures (network error, non-2xx, blocked) throw -- adapters
// let that propagate so the sync job records it as a failed sync. Parsing
// failures after a successful fetch must NOT throw (see each adapter).
export async function fetchSourcePage(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (compatible; SiteCareReviews/1.0; +https://sitecare.example)"
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Источник вернул ошибку HTTP ${response.status}.`);
  return boundedText(response);
}
