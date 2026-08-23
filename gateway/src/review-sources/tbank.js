// Т-Банк Отзывы review adapter (tbank.ru/reviews -- T-Bank's own public
// review platform for businesses, distinct from reviews of the bank
// itself; relevant here because many small RF businesses already use
// T-Bank acquiring/merchant services). No public reviews-read API, but the
// company page is server-rendered with the full review list embedded as
// plain JSON in `<script id="__TRAMVAI_STATE__" type="application/json">`
// (Tramvai is T-Bank's own open-source frontend framework's SSR hydration
// convention) -- verified live against a real company page. This is the
// cleanest of the sources built so far: no JS-string-literal unescaping
// needed, ratings are plain 1-5 integers, not "5+"-style annotated marks.
import { safeMessageText, safeText } from "../platform-core.js";
import { fetchSourcePage } from "./util.js";

export const key = "tbank";
export const label = "Т-Банк Отзывы";
export const identifierHint = "Ссылка на страницу компании на Т-Банк Отзывы (tbank.ru/reviews/company/...)";

const COMPANY_URL_PATTERN = /^\/reviews\/company\/([a-z0-9-]{1,80})\/(\d{1,15})(?:\/|$)/iu;

export function normalizeIdentifier(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) throw new Error("Укажите ссылку на страницу компании на Т-Банк Отзывы.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Укажите полную ссылку на страницу компании на Т-Банк Отзывы.");
  }
  if (url.protocol !== "https:" || !/(^|\.)tbank\.ru$/iu.test(url.hostname)) {
    throw new Error("Ссылка должна вести на сайт tbank.ru.");
  }
  const match = COMPANY_URL_PATTERN.exec(url.pathname);
  if (!match) throw new Error("В ссылке не найдена страница компании (…/reviews/company/название/id).");
  const [, seoName, brandId] = match;
  return `https://www.tbank.ru/reviews/company/${seoName}/${brandId}/`;
}

function extractTramvaiState(html) {
  const match = /<script id="__TRAMVAI_STATE__" type="application\/json">([\s\S]*?)<\/script>/u.exec(html);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export async function fetchReviews(businessIdentifier, fetchImpl = fetch) {
  const html = await fetchSourcePage(businessIdentifier, fetchImpl);
  const state = extractTramvaiState(html);
  const brandStore = state?.stores?.brand;
  const items = Array.isArray(brandStore?.feedbacks?.content) ? brandStore.feedbacks.content : [];
  const reviews = items.slice(0, 100).map((item) => ({
    externalId: safeText(item?.id, 60) || null,
    authorName: safeText(item?.clientName || item?.clientProfile?.publicName, 120) || "Гость Т-Банк",
    authorAvatarUrl: /^https:\/\//u.test(item?.clientProfile?.avatarUrl || "") ? item.clientProfile.avatarUrl : null,
    rating: Number.isInteger(item?.rating) ? Math.max(1, Math.min(5, item.rating)) : null,
    text: safeMessageText(item?.text, 4000),
    reviewedAt: /^\d{4}-\d{2}-\d{2}T/u.test(item?.createdDate || "") ? item.createdDate : null
  })).filter((review) => review.externalId);
  const rating = brandStore?.brand?.brandRating;
  return {
    reviews,
    averageRating: Number.isFinite(rating?.rating) ? rating.rating : null,
    reviewCount: Number.isFinite(rating?.totalTextRatings) ? rating.totalTextRatings : reviews.length
  };
}
