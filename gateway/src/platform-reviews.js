import { safeText, nextCheckAt } from "./platform-core.js";
import { REVIEW_SOURCES } from "./review-sources/index.js";
import { relayFetchImpl } from "./review-sources/relay.js";

const SYNC_OK_MINUTES = 12 * 60;
const SYNC_RETRY_MINUTES = 60;
// Iframe-embed sources (see review-sources/flamp.js) have nothing to fetch
// ever again after the identifier is validated once -- the client site's
// own visitor loads the iframe directly from the source, so there is no
// server-side re-sync to schedule. A long-but-finite interval (not never)
// still lets a later `enabled` re-check or manual re-save pick it back up.
const SYNC_EMBED_MINUTES = 365 * 24 * 60;

function chunk(list, size) {
  const groups = [];
  for (let index = 0; index < list.length; index += size) groups.push(list.slice(index, index + size));
  return groups;
}

// An explicit fetchImpl (tests always pass one) wins outright. Otherwise a
// source that only works from inside Russia (see review-sources/relay.js --
// requiresRelay) is routed through the relay automatically; everything
// else uses a plain direct fetch. Adapters never make this choice
// themselves -- they just call fetchSourcePage(url, fetchImpl) either way.
function resolveFetchImpl(env, adapter, overrideFetchImpl) {
  if (overrideFetchImpl) return overrideFetchImpl;
  if (adapter?.requiresRelay) return relayFetchImpl(env);
  return fetch;
}

// One failing/blocked source must never lose the reviews it already has, so
// this always upserts fresh rows rather than deleting-then-reinserting.
export async function syncReviewWidget(env, widget, fetchImpl) {
  const adapter = REVIEW_SOURCES[widget.service_key];
  const syncedAt = new Date().toISOString();
  try {
    if (!adapter) throw new Error("Этот источник отзывов больше не поддерживается.");
    if (adapter.renderMode === "iframe") {
      await env.GATEWAY_DB.prepare(
        "UPDATE platform_review_widgets SET sync_status = 'ok', last_sync_at = ?, last_sync_error = NULL, next_sync_at = ?, review_count = 0, average_rating = NULL, updated_at = ? WHERE widget_id = ?"
      ).bind(syncedAt, nextCheckAt(SYNC_EMBED_MINUTES, new Date(syncedAt)), syncedAt, widget.widget_id).run();
      return { ok: true, reviewCount: 0 };
    }
    const effectiveFetch = resolveFetchImpl(env, adapter, fetchImpl);
    const { reviews, averageRating, reviewCount } = await adapter.fetchReviews(widget.business_identifier, effectiveFetch);
    const statements = reviews.filter((review) => review.externalId).map((review) => env.GATEWAY_DB.prepare(
      "INSERT INTO platform_reviews (widget_id, external_review_id, author_name, author_avatar_url, rating, review_text, reviewed_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(widget_id, external_review_id) DO UPDATE SET author_name = excluded.author_name, author_avatar_url = excluded.author_avatar_url, rating = excluded.rating, review_text = excluded.review_text, reviewed_at = excluded.reviewed_at, fetched_at = excluded.fetched_at"
    ).bind(
      widget.widget_id,
      review.externalId,
      review.authorName || "",
      review.authorAvatarUrl || null,
      review.rating ?? null,
      review.text || "",
      review.reviewedAt || null,
      syncedAt
    ));
    for (const group of chunk(statements, 50)) if (group.length) await env.GATEWAY_DB.batch(group);
    await env.GATEWAY_DB.prepare(
      "UPDATE platform_review_widgets SET sync_status = 'ok', last_sync_at = ?, last_sync_error = NULL, next_sync_at = ?, review_count = ?, average_rating = ?, updated_at = ? WHERE widget_id = ?"
    ).bind(syncedAt, nextCheckAt(SYNC_OK_MINUTES, new Date(syncedAt)), Number(reviewCount) || reviews.length, Number.isFinite(averageRating) ? averageRating : null, syncedAt, widget.widget_id).run();
    return { ok: true, reviewCount: reviews.length };
  } catch (error) {
    await env.GATEWAY_DB.prepare(
      "UPDATE platform_review_widgets SET sync_status = 'failed', last_sync_at = ?, last_sync_error = ?, next_sync_at = ?, updated_at = ? WHERE widget_id = ?"
    ).bind(syncedAt, safeText(error?.message || "Не удалось получить отзывы.", 200), nextCheckAt(SYNC_RETRY_MINUTES, new Date(syncedAt)), syncedAt, widget.widget_id).run();
    throw error;
  }
}

export async function runDueReviewSyncs(env, { limit = 10, fetchImpl } = {}) {
  const now = new Date().toISOString();
  const rows = await env.GATEWAY_DB.prepare(
    "SELECT * FROM platform_review_widgets WHERE enabled = 1 AND (next_sync_at IS NULL OR next_sync_at <= ?) ORDER BY COALESCE(next_sync_at, created_at) LIMIT ?"
  ).bind(now, Math.min(25, Math.max(1, Number(limit) || 10))).all();
  const widgets = rows?.results || [];
  const settled = await Promise.allSettled(widgets.map((widget) => syncReviewWidget(env, widget, fetchImpl)));
  return { synced: widgets.length, failed: settled.filter((item) => item.status === "rejected").length };
}
