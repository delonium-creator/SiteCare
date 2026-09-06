// Reporting periods use UTC calendar days, including the current partial day.
// Prefer complete daily aggregates; raw runs fill days not yet rolled up.
// This avoids both the 1000-run retention cap and double-counting.
export function reportingPeriod(days, now = new Date()) {
  const boundedDays = Math.min(90, Math.max(1, Math.floor(Number(days) || 30)));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - boundedDays + 1));
  return { days: boundedDays, start: start.toISOString(), end: now.toISOString() };
}

export async function monitorStatistics(env, siteId, period) {
  const fromDay = period.start.slice(0, 10);
  const today = period.end.slice(0, 10);
  const row = await env.GATEWAY_DB.prepare(`
    WITH complete_days AS (
      SELECT day, checks, page_ok_count, checks * avg_latency_ms AS latency_weighted
      FROM platform_monitor_daily WHERE site_id = ? AND day >= ? AND day < ?
    ), observations AS (
      SELECT checks, page_ok_count, latency_weighted FROM complete_days
      UNION ALL
      SELECT COUNT(*) AS checks, COALESCE(SUM(page_ok), 0) AS page_ok_count,
        COALESCE(SUM(latency_ms), 0) AS latency_weighted
      FROM platform_monitor_runs r
      WHERE r.site_id = ? AND r.checked_at >= ? AND r.checked_at < ?
        AND NOT EXISTS (SELECT 1 FROM complete_days d WHERE d.day = substr(r.checked_at, 1, 10))
    )
    SELECT COALESCE(SUM(checks), 0) AS checks, COALESCE(SUM(page_ok_count), 0) AS page_ok_count,
      COALESCE(SUM(latency_weighted), 0) AS latency_weighted FROM observations
  `).bind(siteId, fromDay, today, siteId, period.start, period.end).first();
  const checks = Number(row?.checks || 0);
  return {
    checks,
    uptimePercent: checks ? Number((Number(row.page_ok_count) / checks * 100).toFixed(2)) : null,
    averageLatencyMs: checks ? Math.round(Number(row.latency_weighted) / checks) : null
  };
}
