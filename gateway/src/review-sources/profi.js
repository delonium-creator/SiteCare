// Профи.ру review adapter. Same shape of discovery as the 2GIS adapter:
// no public reviews-read API, but the specialist's public profile page is a
// Next.js app that server-renders a React Query "dehydrated state" blob
// (`<script id="__NEXT_DATA__" type="application/json">`) containing a
// full page of real reviews (author, mark, date, HTML text) -- verified
// live against a real profile page while building this adapter. Structured
// JSON again, not DOM-class scraping.
import { safeMessageText, safeText } from "../platform-core.js";
import { decodeHtmlText, fetchSourcePage } from "./util.js";

export const key = "profi";
export const label = "Профи.ру";
export const identifierHint = "Ссылка на анкету специалиста на Профи.ру (profi.ru/profile/...)";

const PROFILE_URL_PATTERN = /^\/profile\/([A-Za-z0-9_-]{2,60})\/?$/u;

export function normalizeIdentifier(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) throw new Error("Укажите ссылку на анкету специалиста на Профи.ру.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Укажите полную ссылку на анкету специалиста на Профи.ру.");
  }
  if (url.protocol !== "https:" || !/(^|\.)profi\.ru$/iu.test(url.hostname)) {
    throw new Error("Ссылка должна вести на сайт profi.ru.");
  }
  const match = PROFILE_URL_PATTERN.exec(url.pathname);
  if (!match) throw new Error("В ссылке не найдена анкета специалиста (…/profile/имя-анкеты).");
  return `https://profi.ru/profile/${match[1]}/`;
}

function extractNextData(html) {
  const match = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/u.exec(html);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// textHTML only ever uses <br> for line breaks in practice (verified across
// a real profile's full review set) -- strip any other tag defensively
// rather than trusting that stays true forever.
function reviewTextFromHtml(value) {
  return decodeHtmlText(String(value || "").replace(/<br\s*\/?>/giu, "\n").replace(/<[^>]+>/gu, " "));
}

function averageFromHistogram(histogram) {
  if (!Array.isArray(histogram) || !histogram.length) return null;
  let total = 0;
  let sum = 0;
  for (const bucket of histogram) {
    const value = Number(bucket?.value);
    const count = Number(bucket?.count);
    if (!Number.isFinite(value) || !Number.isFinite(count) || count <= 0) continue;
    total += count;
    sum += value * count;
  }
  return total ? sum / total : null;
}

export async function fetchReviews(businessIdentifier, fetchImpl = fetch) {
  const html = await fetchSourcePage(businessIdentifier, fetchImpl);
  const data = extractNextData(html);
  const pageProps = data?.props?.pageProps;
  const queries = pageProps?.dehydratedState?.queries || [];
  const reviewsQuery = queries.find((query) => query?.queryKey?.[0] === "FullProfileReviews.infinite");
  const edges = reviewsQuery?.state?.data?.pages?.[0]?.pxf?.profile?.reviews?.edges;
  const items = Array.isArray(edges) ? edges : [];
  const reviews = items.slice(0, 100).map(({ node }) => ({
    externalId: safeText(node?.id, 60) || null,
    authorName: safeText(node?.author, 120) || "Гость Профи.ру",
    authorAvatarUrl: null,
    rating: Number.isFinite(Number.parseInt(node?.mark, 10)) ? Math.max(1, Math.min(5, Number.parseInt(node.mark, 10))) : null,
    text: safeMessageText(reviewTextFromHtml(node?.textHTML), 4000),
    reviewedAt: Number.isFinite(node?.date?.timestamp) ? new Date(node.date.timestamp * 1000).toISOString() : null
  })).filter((review) => review.externalId);
  const totalCount = reviewsQuery?.state?.data?.pages?.[0]?.pxf?.profile?.reviews?.totalCount;
  return {
    reviews,
    averageRating: averageFromHistogram(pageProps?.profile?.reviewsMarksHistogram),
    reviewCount: Number.isFinite(totalCount) ? totalCount : reviews.length
  };
}
