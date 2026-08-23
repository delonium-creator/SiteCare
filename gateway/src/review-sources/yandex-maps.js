// Yandex Maps review adapter. No public reviews-read API for third parties
// (Yandex staff have confirmed this directly, and the Maps API ToS
// explicitly forbids persistent storage of reviews beyond a temporary
// cache and forbids reordering/filtering them -- a decision the team
// already weighed and chose to proceed past, same as every other scraped
// source here). The organization's public reviews page is server-rendered
// with a full page of real reviews embedded as plain JSON in
// `<script type="application/json" class="state-view">` -- verified live
// against a real business page, structured data again, not DOM scraping.
import { safeMessageText, safeText } from "../platform-core.js";
import { fetchSourcePage } from "./util.js";

export const key = "yandex_maps";
export const label = "Яндекс Карты";
export const identifierHint = "Ссылка на страницу организации на Яндекс Картах (yandex.ru/maps/org/...)";

const ORG_URL_PATTERN = /^\/maps\/org\/(?:[a-z0-9_-]+\/)?(\d{3,20})(?:\/|$)/iu;

export function normalizeIdentifier(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) throw new Error("Укажите ссылку на организацию на Яндекс Картах.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Укажите полную ссылку на страницу организации на Яндекс Картах.");
  }
  if (url.protocol !== "https:" || !/(^|\.)yandex\.(ru|com)$/iu.test(url.hostname)) {
    throw new Error("Ссылка должна вести на сайт yandex.ru.");
  }
  const match = ORG_URL_PATTERN.exec(url.pathname);
  if (!match) throw new Error("В ссылке не найден адрес организации (…/maps/org/12345678).");
  return `https://yandex.ru/maps/org/${match[1]}/reviews/`;
}

function extractStateView(html) {
  const match = /<script type="application\/json" class="state-view">([\s\S]*?)<\/script>/u.exec(html);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// Author avatars are served as a URL template with a literal `{size}`
// placeholder the client is expected to fill in -- there is no bare/default
// size, so this substitutes a fixed, always-valid preset rather than
// leaving the placeholder in place (which would just be a broken image).
function resolveAvatarUrl(template) {
  if (!/^https:\/\/.+\{size\}/u.test(template || "")) return null;
  return template.replace("{size}", "islands-100");
}

export async function fetchReviews(businessIdentifier, fetchImpl = fetch) {
  const html = await fetchSourcePage(businessIdentifier, fetchImpl);
  const state = extractStateView(html);
  const item = state?.stack?.[0]?.results?.items?.[0];
  const items = Array.isArray(item?.reviewResults?.reviews) ? item.reviewResults.reviews : [];
  const reviews = items.slice(0, 100).map((review) => ({
    externalId: safeText(review?.reviewId, 80) || null,
    authorName: safeText(review?.author?.name, 120) || "Гость Яндекс Карт",
    authorAvatarUrl: resolveAvatarUrl(review?.author?.avatarUrl),
    rating: Number.isInteger(review?.rating) ? Math.max(1, Math.min(5, review.rating)) : null,
    text: safeMessageText(review?.text, 4000),
    reviewedAt: /^\d{4}-\d{2}-\d{2}T/u.test(review?.updatedTime || "") ? review.updatedTime : null
  })).filter((review) => review.externalId);
  const ratingData = item?.ratingData;
  return {
    reviews,
    averageRating: Number.isFinite(ratingData?.ratingValue) ? ratingData.ratingValue : null,
    reviewCount: Number.isFinite(ratingData?.reviewCount) ? ratingData.reviewCount : reviews.length
  };
}
