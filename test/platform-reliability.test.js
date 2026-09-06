import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { buildDigestSummary, checkPlatformSite, inspectSite, runDueDigests, siteReport } from "../gateway/src/platform-monitor.js";
import { monitorStatistics, reportingPeriod } from "../gateway/src/platform-reporting.js";
import { fetchReviews as yandexReviews } from "../gateway/src/review-sources/yandex-maps.js";
import { fetchReviews as tbankReviews } from "../gateway/src/review-sources/tbank.js";
import { fetchReviews as profiReviews } from "../gateway/src/review-sources/profi.js";
import { fetchReviews as dgisReviews } from "../gateway/src/review-sources/dgis.js";

async function migrate(database, file) {
  const sql = await readFile(new URL(`../gateway/migrations/${file}`, import.meta.url), "utf8");
  for (const statement of sql.split(/;\s*(?:\n|$)/u).map(s => s.trim()).filter(Boolean)) {
    await database.prepare(statement).run();
  }
}

async function setup(t, { beforeLatest = false } = {}) {
  const runtime = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", compatibilityDate: "2026-08-04", d1Databases: ["GATEWAY_DB"] });
  t.after(() => runtime.dispose());
  const database = await runtime.getD1Database("GATEWAY_DB");
  const files = (await readdir(new URL("../gateway/migrations/", import.meta.url))).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) if (!beforeLatest || !file.startsWith('0028')) await migrate(database, file);
  const now = new Date().toISOString();
  await database.prepare("INSERT INTO platform_accounts (account_id,name,plan,status,created_at,updated_at) VALUES ('acc_reliability','Test','business','active',?,?)").bind(now, now).run();
  await database.prepare("INSERT INTO platform_sites (site_id,account_id,name,target_url,target_origin,target_pathname,integration_mode,form_required,loader_key,created_at,updated_at) VALUES ('reliable-site','acc_reliability','Test','https://example.com/','https://example.com','/','central',0,'loader-test-key',?,?)").bind(now, now).run();
  return { database, env: { GATEWAY_DB: database } };
}

async function rawRun(db, at, { ok = 1, latency = 100 } = {}) {
  await db.prepare("INSERT INTO platform_monitor_runs (site_id,checked_at,domain_ok,tls_ok,page_ok,form_ok,http_status,latency_ms,form_count,details) VALUES ('reliable-site',?,0,0,?,1,0,?,0,'timeout')").bind(at, ok, latency).run();
}

test("empty reports and digests never assert perfect availability", async t => {
  const { env } = await setup(t);
  const report = await siteReport(env, 'reliable-site');
  assert.equal(report.checks, 0);
  assert.equal(report.uptimePercent, null);
  assert.equal(report.averageLatencyMs, null);
  const summary = buildDigestSummary({ checksCount: 0 });
  assert.match(summary, /нет данных/iu);
  assert.doesNotMatch(summary, /всё стабильно|поводов для беспокойства не найдено/iu);
});

test("reporting uses seven calendar days across month/year boundaries", () => {
  assert.deepEqual(reportingPeriod(7, new Date('2027-01-03T12:00:00Z')), {
    days: 7, start: '2026-12-28T00:00:00.000Z', end: '2027-01-03T12:00:00.000Z'
  });
});

test("reports combine retained aggregates and unrolled raw days without overlap", async t => {
  const { database, env } = await setup(t);
  await database.prepare("INSERT INTO platform_monitor_daily VALUES ('reliable-site','2026-09-01',288,280,100)").run();
  await rawRun(database, '2026-09-01T10:00:00.000Z', { ok: 0, latency: 9999 }); // Already aggregated.
  await rawRun(database, '2026-09-02T10:00:00.000Z', { ok: 1, latency: 300 }); // Rollup delayed.
  await rawRun(database, '2026-09-03T10:00:00.000Z', { ok: 0, latency: 500 }); // Current day.
  await rawRun(database, '2026-08-31T23:59:59.000Z', { ok: 0 }); // Outside period.
  const metrics = await monitorStatistics(env, 'reliable-site', reportingPeriod(3, new Date('2026-09-03T12:00:00Z')));
  assert.equal(metrics.checks, 290);
  assert.equal(metrics.uptimePercent, 96.9);
  assert.equal(metrics.averageLatencyMs, Math.round((28800 + 300 + 500) / 290));
});

test("weekly digest includes archived runs after raw retention has expired", async t => {
  const { database, env } = await setup(t);
  const period = reportingPeriod(7);
  await database.prepare("INSERT INTO platform_monitor_daily VALUES ('reliable-site',?,288,288,100)").bind(period.start.slice(0,10)).run();
  await database.prepare("UPDATE platform_sites SET next_digest_at = '2000-01-01T00:00:00.000Z' WHERE site_id = 'reliable-site'").run();
  const result = await runDueDigests(env);
  assert.equal(result.failed, 0);
  const digest = await database.prepare("SELECT checks_count, summary_text FROM platform_digests WHERE site_id = 'reliable-site'").first();
  assert.equal(digest.checks_count, 288);
  assert.match(digest.summary_text, /проверен 288 раз/u);
});

test("timeout remains unknown DNS/TLS through persistence, while an HTTP error proves HTTPS was reached", async t => {
  const site = { site_id: 'reliable-site', account_id: 'acc_reliability', target_url: 'https://example.com/', form_required: 0, monitor_interval_minutes: 5 };
  const failed = await inspectSite(site, async () => { throw new Error('request timeout'); });
  assert.equal(failed.domainOk, null);
  assert.equal(failed.tlsOk, null);
  assert.equal(failed.pageOk, false);
  const httpError = await inspectSite(site, async () => new Response('Unavailable', { status: 503 }));
  assert.equal(httpError.domainOk, true);
  assert.equal(httpError.tlsOk, true);
  assert.equal(httpError.pageOk, false);
  const { database, env } = await setup(t);
  await checkPlatformSite(env, site, { notify: false, fetchImpl: async () => { throw new Error('timeout'); } });
  assert.deepEqual(await database.prepare("SELECT domain_ok,tls_ok,page_ok FROM platform_sites WHERE site_id='reliable-site'").first(), { domain_ok: null, tls_ok: null, page_ok: 0 });
  assert.deepEqual(await database.prepare("SELECT domain_ok,tls_ok,page_ok FROM platform_monitor_runs WHERE site_id='reliable-site'").first(), { domain_ok: null, tls_ok: null, page_ok: 0 });
});

test("migration preserves historical checks and last successful cached reviews", async t => {
  const { database } = await setup(t, { beforeLatest: true });
  await rawRun(database, '2026-09-01T00:00:00.000Z', { ok: 0 });
  await database.prepare("INSERT INTO platform_review_widgets (widget_id,site_id,service_key,business_identifier,sync_status,last_sync_at,created_at,updated_at) VALUES ('rw_old','reliable-site','dgis','https://2gis.ru/moscow/firm/123456','failed','2026-09-02','2026-08-01','2026-09-02')").run();
  await database.prepare("INSERT INTO platform_reviews (widget_id,external_review_id,review_text,fetched_at) VALUES ('rw_old','one','Saved','2026-09-01')").run();
  await migrate(database, '0028_reliable_observations.sql');
  const run = await database.prepare("SELECT id,domain_ok,tls_ok,page_ok,details FROM platform_monitor_runs").first();
  assert.deepEqual(run, { id: 1, domain_ok: null, tls_ok: null, page_ok: 0, details: 'timeout' });
  const widget = await database.prepare("SELECT last_success_at,source_revision,sync_status FROM platform_review_widgets WHERE widget_id='rw_old'").first();
  assert.deepEqual(widget, { last_success_at: '2026-09-01', source_revision: 1, sync_status: 'failed' });
  assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM platform_reviews").first()).n, 1);
  assert.deepEqual((await database.prepare('PRAGMA foreign_key_check').all()).results, []);
});

test("all adapters accept explicitly empty review arrays but reject missing payloads", async () => {
  const sources = [
    [yandexReviews, 'https://yandex.ru/maps/org/123456/reviews/', '<script type="application/json" class="state-view">'+JSON.stringify({stack:[{results:{items:[{reviewResults:{reviews:[]},ratingData:{reviewCount:0}}]}}]})+'</script>'],
    [tbankReviews, 'https://www.tbank.ru/reviews/company/test/123/', '<script id="__TRAMVAI_STATE__" type="application/json">'+JSON.stringify({stores:{brand:{feedbacks:{content:[]}}}})+'</script>'],
    [profiReviews, 'https://profi.ru/profile/Test/', '<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({props:{pageProps:{dehydratedState:{queries:[{queryKey:['FullProfileReviews.infinite'],state:{data:{pages:[{pxf:{profile:{reviews:{edges:[],totalCount:0}}}}]}}}]}}}})+'</script>'],
    [dgisReviews, 'https://2gis.ru/moscow/firm/123456', "var __REACT_QUERY_STATE__ = JSON.parse('"+JSON.stringify({queries:[{queryKey:['fetchEntityReviews'],state:{data:{pages:[{items:[],total:0}]}}}]})+"');"]
  ];
  for (const [fetchReviews, url, html] of sources) {
    const result = await fetchReviews(url, async () => new Response(html));
    assert.deepEqual(result.reviews, []);
    assert.equal(result.reviewCount, 0);
    await assert.rejects(() => fetchReviews(url, async () => new Response('<html>Verify you are human</html>')), /Не удалось распознать отзывы/u);
  }
});
