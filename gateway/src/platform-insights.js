import { PLAN_LIMITS, dayKey, validatePlan } from "./platform-core.js";
import { requestOpenAiInsight } from "./platform-openai.js";

// AI Analyst: turns facts SiteCare already collects (health-score trend,
// leads volume, open incidents, confirmed site changes) into one short,
// honest observation - only when a code-level filter decides something
// actually changed. Never calls OpenAI on every page load; only from the
// daily health-scan job and the manual "Запустить диагностику" button.

const DEFAULT_THRESHOLDS = Object.freeze({
  scoreDelta: 5,
  leadsPercentChange: 20,
  minLeadsForPercent: 3
});

export function computeFactsDelta({
  latestHealth = null,
  priorHealth = null,
  leadsThisPeriod = 0,
  leadsPriorPeriod = 0,
  openIncidents = 0,
  recentChanges = []
} = {}) {
  const score = latestHealth ? Number(latestHealth.score) : null;
  const scoreDelta = latestHealth && priorHealth ? Number(latestHealth.score) - Number(priorHealth.score) : 0;
  const thisPeriod = Number(leadsThisPeriod) || 0;
  const priorPeriod = Number(leadsPriorPeriod) || 0;
  const leadsDelta = thisPeriod - priorPeriod;
  const leadsPercentChange = priorPeriod > 0 ? Math.round((leadsDelta / priorPeriod) * 100) : (thisPeriod > 0 ? 100 : 0);
  return {
    score,
    scoreDelta,
    high: latestHealth ? Number(latestHealth.high || 0) : 0,
    medium: latestHealth ? Number(latestHealth.medium || 0) : 0,
    low: latestHealth ? Number(latestHealth.low || 0) : 0,
    leadsThisPeriod: thisPeriod,
    leadsPriorPeriod: priorPeriod,
    leadsDelta,
    leadsPercentChange,
    openIncidents: Number(openIncidents) || 0,
    recentChanges: (Array.isArray(recentChanges) ? recentChanges : []).slice(0, 5).map((change) => ({
      summary: String(change?.summary || ""),
      targetLabel: String(change?.target_label || ""),
      kind: String(change?.kind || ""),
      createdAt: String(change?.created_at || "")
    }))
  };
}

export function shouldGenerateInsight(facts, thresholds = DEFAULT_THRESHOLDS) {
  if (!facts) return { trigger: false, reason: "no_facts" };
  if (facts.openIncidents > 0) return { trigger: true, reason: "open_incidents" };
  if (Math.abs(facts.scoreDelta) >= thresholds.scoreDelta) return { trigger: true, reason: "score_delta" };
  const enoughLeadsData = facts.leadsThisPeriod >= thresholds.minLeadsForPercent || facts.leadsPriorPeriod >= thresholds.minLeadsForPercent;
  if (enoughLeadsData && Math.abs(facts.leadsPercentChange) >= thresholds.leadsPercentChange) return { trigger: true, reason: "leads_change" };
  return { trigger: false, reason: "no_significant_change" };
}

export function insightDedupeKey(siteId, type) {
  return `${siteId}:${type}`;
}

async function underInsightRateLimit(env, siteId, maximum, windowSeconds) {
  const bucketKey = `insight:${siteId}`;
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSeconds * 1000)) * windowSeconds;
  const updatedAt = new Date(now).toISOString();
  await env.GATEWAY_DB.prepare(
    "INSERT INTO platform_action_limits (bucket_key, window_start, request_count, updated_at) VALUES (?, ?, 1, ?) " +
    "ON CONFLICT(bucket_key, window_start) DO UPDATE SET request_count = request_count + 1, updated_at = excluded.updated_at"
  ).bind(bucketKey, windowStart, updatedAt).run();
  const row = await env.GATEWAY_DB.prepare(
    "SELECT request_count FROM platform_action_limits WHERE bucket_key = ? AND window_start = ?"
  ).bind(bucketKey, windowStart).first();
  return Number(row?.request_count || 0) <= maximum;
}

async function resolveStaleInsights(env, siteId, facts) {
  const types = [];
  if (facts.score !== null && facts.scoreDelta >= 0 && facts.high === 0 && facts.openIncidents === 0) {
    types.push("site_health", "diagnostics", "connection");
  }
  if (facts.leadsPercentChange > -10) types.push("leads");
  if (!types.length) return;
  const placeholders = types.map(() => "?").join(",");
  await env.GATEWAY_DB.prepare(
    `UPDATE ai_insights SET status = 'resolved' WHERE site_id = ? AND status = 'active' AND type IN (${placeholders})`
  ).bind(siteId, ...types).run();
}

export async function generateSiteInsight(env, site, { fetchImpl = fetch, force = false } = {}) {
  const siteId = site.site_id;
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const [latestHealth, priorHealth, thisWeek, priorWeek, incidentsRow, changesResult] = await Promise.all([
    env.GATEWAY_DB.prepare(
      "SELECT score, high, medium, low, issue_count, checked_at FROM platform_health_history WHERE site_id = ? ORDER BY checked_at DESC LIMIT 1"
    ).bind(siteId).first(),
    env.GATEWAY_DB.prepare(
      "SELECT score, high, medium, low, issue_count, checked_at FROM platform_health_history WHERE site_id = ? AND checked_at <= ? ORDER BY checked_at DESC LIMIT 1"
    ).bind(siteId, weekAgo).first(),
    env.GATEWAY_DB.prepare("SELECT COUNT(*) AS count FROM platform_leads WHERE site_id = ? AND received_at >= ?").bind(siteId, weekAgo).first(),
    env.GATEWAY_DB.prepare(
      "SELECT COUNT(*) AS count FROM platform_leads WHERE site_id = ? AND received_at >= ? AND received_at < ?"
    ).bind(siteId, twoWeeksAgo, weekAgo).first(),
    env.GATEWAY_DB.prepare("SELECT COUNT(*) AS count FROM platform_incidents WHERE site_id = ? AND status = 'open'").bind(siteId).first(),
    env.GATEWAY_DB.prepare(
      "SELECT summary, target_label, kind, created_at FROM platform_change_records WHERE site_id = ? AND status = 'confirmed' AND created_at >= ? ORDER BY created_at DESC LIMIT 5"
    ).bind(siteId, weekAgo).all()
  ]);
  const facts = computeFactsDelta({
    latestHealth,
    priorHealth,
    leadsThisPeriod: thisWeek?.count || 0,
    leadsPriorPeriod: priorWeek?.count || 0,
    openIncidents: incidentsRow?.count || 0,
    recentChanges: changesResult?.results || []
  });

  await resolveStaleInsights(env, siteId, facts);

  const decision = shouldGenerateInsight(facts);
  if (!decision.trigger && !force) return null;
  if (!env.OPENAI_API_KEY) return null;

  // A forced test run (operator-only, "Проверить AI сейчас") skips the
  // per-site 12h cooldown so testing doesn't require waiting - the daily
  // ai_requests budget below still applies, that is the real cost guard.
  if (!force) {
    const withinBudget = await underInsightRateLimit(env, siteId, 1, 12 * 60 * 60);
    if (!withinBudget) return null;
  }

  const accountRow = await env.GATEWAY_DB.prepare("SELECT plan FROM platform_accounts WHERE account_id = ?").bind(site.account_id).first();
  const plan = validatePlan(accountRow?.plan);
  const today = dayKey();
  const usage = await env.GATEWAY_DB.prepare(
    "SELECT ai_requests FROM platform_usage_daily WHERE account_id = ? AND usage_day = ?"
  ).bind(site.account_id, today).first();
  if (Number(usage?.ai_requests || 0) >= PLAN_LIMITS[plan].aiPerDay) return null;

  const insight = await requestOpenAiInsight({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL || undefined,
    facts,
    fetchImpl
  });
  if (!insight) return null;

  await env.GATEWAY_DB.prepare(
    "INSERT INTO platform_usage_daily (account_id, usage_day, monitor_checks, form_signals, ai_requests) VALUES (?, ?, 0, 0, 1) " +
    "ON CONFLICT(account_id, usage_day) DO UPDATE SET ai_requests = ai_requests + 1"
  ).bind(site.account_id, today).run();

  const createdAt = now.toISOString();
  const sourceDataJson = JSON.stringify(facts);
  const existing = await env.GATEWAY_DB.prepare(
    "SELECT id FROM ai_insights WHERE site_id = ? AND type = ? AND status = 'active'"
  ).bind(siteId, insight.type).first();
  if (existing) {
    await env.GATEWAY_DB.prepare(
      "UPDATE ai_insights SET severity=?, title=?, summary=?, details=?, confidence=?, source_data_json=?, recommended_action=?, action_target=?, created_at=? WHERE id=?"
    ).bind(insight.severity, insight.title, insight.summary, insight.details, insight.confidence, sourceDataJson, insight.recommendedAction, insight.actionTarget, createdAt, existing.id).run();
  } else {
    await env.GATEWAY_DB.prepare(
      "INSERT INTO ai_insights (site_id, type, severity, title, summary, details, confidence, source_data_json, recommended_action, action_target, status, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)"
    ).bind(siteId, insight.type, insight.severity, insight.title, insight.summary, insight.details, insight.confidence, sourceDataJson, insight.recommendedAction, insight.actionTarget, createdAt).run();
  }

  return insight;
}
