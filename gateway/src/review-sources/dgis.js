// 2GIS review adapter. 2GIS has no public reviews-read API (confirmed
// during research for this feature), so this reads the same data their own
// site renders for anyone, unauthenticated: a business's public reviews
// page embeds a complete, structured JSON payload server-side (a React
// Query hydration blob, `var __REACT_QUERY_STATE__ = JSON.parse('...')`)
// containing every review with a stable id, rating, text, author and date
// -- no DOM/CSS-class scraping involved, which is what makes this adapter
// resilient to 2GIS's frequent front-end markup changes.
import { safeMessageText, safeText } from "../platform-core.js";
import { fetchSourcePage, unescapeJsStringLiteral } from "./util.js";

export const key = "dgis";
export const label = "2ГИС";
export const identifierHint = "Ссылка на страницу организации на 2ГИС (2gis.ru/.../firm/...)";

const FIRM_URL_PATTERN = /^\/([a-z][a-z0-9-]{1,60})\/firm\/(\d{5,25})(?:\/|$)/iu;

export function normalizeIdentifier(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) throw new Error("Укажите ссылку на организацию на 2ГИС.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Укажите полную ссылку на страницу организации на 2ГИС.");
  }
  if (url.protocol !== "https:" || !/(^|\.)2gis\.(ru|com|kz|by|uz|az|kg)$/iu.test(url.hostname)) {
    throw new Error("Ссылка должна вести на сайт 2gis.ru.");
  }
  const match = FIRM_URL_PATTERN.exec(url.pathname);
  if (!match) {
    throw new Error("В ссылке не найден адрес организации (…/firm/12345678).");
  }
  // Canonicalize away query strings and any trailing /tab/... segment so
  // the same business pasted from different tabs (reviews, photos, menu)
  // is recognized as one identifier -- this is what the site's own
  // UNIQUE(site_id, service_key, business_identifier) dedupe relies on.
  const [, city, firmId] = match;
  return `https://${url.hostname}/${city}/firm/${firmId}`;
}

function reviewsPageUrl(businessIdentifier) {
  const url = new URL(businessIdentifier);
  const match = FIRM_URL_PATTERN.exec(url.pathname);
  if (!match) throw new Error("Не удалось определить организацию 2ГИС из сохранённой ссылки.");
  const [, city, firmId] = match;
  return `${url.origin}/${city}/firm/${firmId}/tab/reviews`;
}

function extractHydratedState(html) {
  const match = /var __REACT_QUERY_STATE__ = JSON\.parse\('([\s\S]*?)'\);/u.exec(html);
  if (!match) return null;
  try {
    return JSON.parse(unescapeJsStringLiteral(match[1]));
  } catch {
    return null;
  }
}

export async function fetchReviews(businessIdentifier, fetchImpl = fetch) {
  const html = await fetchSourcePage(reviewsPageUrl(businessIdentifier), fetchImpl);
  const state = extractHydratedState(html);
  const reviewsQuery = (state?.queries || []).find((query) => query?.queryKey?.[0] === "fetchEntityReviews");
  const page = reviewsQuery?.state?.data?.pages?.[0];
  const items = Array.isArray(page?.items) ? page.items : [];
  const reviews = items.slice(0, 100).map((item) => ({
    externalId: safeText(item?.id, 60) || null,
    authorName: safeText(item?.user?.name || item?.user?.first_name, 120) || "Гость 2ГИС",
    authorAvatarUrl: /^https:\/\//u.test(item?.user?.photo_preview_urls?.url || "") ? item.user.photo_preview_urls.url : null,
    rating: Number.isInteger(item?.rating) ? Math.max(1, Math.min(5, item.rating)) : null,
    text: safeMessageText(item?.text, 4000),
    reviewedAt: /^\d{4}-\d{2}-\d{2}T/u.test(item?.date_created || "") ? item.date_created : null
  })).filter((review) => review.externalId);
  return {
    reviews,
    averageRating: Number.isFinite(page?.rating) ? page.rating : null,
    reviewCount: Number.isFinite(page?.total) ? page.total : reviews.length
  };
}
