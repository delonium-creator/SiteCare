// Flamp review "adapter" -- deliberately NOT a scraper. Flamp's review
// pages return HTTP 451 ("возможно, у вас включен VPN") to any request
// from outside Russian IP ranges, confirmed even through a real rendered
// browser session (Cloudflare Browser Rendering) -- this is an IP-origin
// block at their infrastructure level, not a bot-behavior check a more
// convincing request could pass. Routing around it (proxies, IP masking)
// would be evading a deliberate access control, which is out of scope.
//
// Flamp offers its own official embeddable widget for businesses
// (flamp.ru/biz/widgets) -- the same "paste the src from your own account"
// pattern this codebase already used for Yandex Maps/2GIS before this
// feature existed. For a source we cannot fetch server-side, this is the
// correct integration, not a workaround: the client site VISITOR's own
// browser loads the iframe directly from Flamp, so the server-side block
// never applies. No review data is stored or synced for this kind of
// source -- there is nothing to fetch.
export const key = "flamp";
export const label = "Флап";
export const identifierHint = "Ссылка src из официального виджета Flamp (flamp.ru/biz/widgets)";
export const renderMode = "iframe";

export function normalizeIdentifier(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) throw new Error("Укажите ссылку src из официального виджета Flamp.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Укажите полную ссылку src из кода виджета Flamp.");
  }
  if (url.protocol !== "https:" || !url.hostname) {
    throw new Error("Ссылка на виджет должна быть полным HTTPS-адресом.");
  }
  return url.href;
}
