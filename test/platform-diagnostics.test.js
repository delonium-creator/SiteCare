import test from "node:test";
import assert from "node:assert/strict";
import { buildContentFields, buildDigestSummary, categorySeverityCounts, checkDomainExpiry, computeHealthScore, detectYandexMetrikaCounter, diagnosePage, extractEditableInventory, scanSiteInventory } from "../gateway/src/platform-monitor.js";

test("diagnostics report observable SEO, accessibility and mixed-content facts", () => {
  const html = `<!doctype html><html><head><title>Коротко</title><meta name="robots" content="noindex"><link rel="canonical" href="https://example.com/"></head><body><h1>Первый</h1><h1>Второй</h1><img src="https://example.com/photo.jpg"><script src="http://old.example.com/widget.js"></script></body></html>`;
  const result = diagnosePage(html, "https://example.com/", { httpStatus: 200, latencyMs: 3200, headers: {} });
  const ids = result.issues.map((issue) => issue.issueId);
  assert.ok(ids.some((id) => id.startsWith("noindex:")));
  assert.ok(ids.some((id) => id.startsWith("description-missing:")));
  assert.ok(ids.some((id) => id.startsWith("image-alt:")));
  assert.ok(ids.some((id) => id.startsWith("mixed-content:")));
  assert.ok(ids.some((id) => id.startsWith("latency:")));
  assert.equal(result.facts.h1Count, 2);
  assert.equal(result.facts.noindex, true);
});

test("detects a Yandex Metrika counter from the standard init call or the noscript fallback", () => {
  assert.equal(detectYandexMetrikaCounter(`<script>(function(m,e,t,r,i,k,a){})(window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym"); ym(12345678, "init", {clickmap:true});</script>`), "12345678");
  assert.equal(detectYandexMetrikaCounter(`<noscript><div><img src="https://mc.yandex.ru/watch/87654321" style="position:absolute; left:-9999px;" alt=""></div></noscript>`), "87654321");
  assert.equal(detectYandexMetrikaCounter(`<html><body>No analytics here</body></html>`), null);
  assert.equal(detectYandexMetrikaCounter(""), null);
});

test("detects a Yandex Metrika counter from Tilda's own generated snippet (id assigned to a variable, not passed literally)", () => {
  const tildaSnippet = `(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();for(var j=0;j<document.scripts.length;j++){if(document.scripts[j].src===r){return}}k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})(window,document,"script","https://mc.yandex.ru/metrika/tag.js","ym");window.mainMetrikaId='111766635';ym(window.mainMetrikaId,"init",{clickmap:true,trackLinks:true,accurateTrackBounce:true,webvisor:true});`;
  assert.equal(detectYandexMetrikaCounter(tildaSnippet), "111766635");
});

test("a plain visible phone next to an email is recognized without technical ids", () => {
  const inventory = extractEditableInventory(`<!doctype html><html lang="ru"><head><title>Контакты компании</title><meta name="description" content="Контакты"><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://example.com/"></head><body><div id="rec10"><span>11111111111111</span><span>sales@example.com</span></div><div id="rec20"><span>Заказ 1620232389262</span></div></body></html>`, "https://example.com/");
  assert.ok(inventory.phones.some((phone) => phone.includes("11111111111111")));
  assert.ok(!inventory.phones.some((phone) => phone.includes("1620232389262")));
});

test("whole-site scan aggregates duplicate metadata and failed internal pages", async () => {
  const pages = new Map([
    ["https://example.com/", `<!doctype html><html lang="ru"><head><title>Один заголовок страницы</title><meta name="description" content="Одинаковое описание"><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://example.com/"></head><body><h1>Главная</h1><a href="/about">О нас</a><a href="/missing">Пропавшая</a></body></html>`],
    ["https://example.com/about", `<!doctype html><html lang="ru"><head><title>Один заголовок страницы</title><meta name="description" content="Одинаковое описание"><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://example.com/about"></head><body><h1>О нас</h1></body></html>`]
  ]);
  const fetchImpl = async (url) => pages.has(url)
    ? new Response(pages.get(url), { status: 200, headers: { "Content-Type": "text/html" } })
    : new Response("not found", { status: 404, headers: { "Content-Type": "text/html" } });
  const result = await scanSiteInventory({ target_url: "https://example.com/", scope: "site" }, fetchImpl, { maxPages: 10 });
  assert.equal(result.pageCount, 2);
  assert.equal(result.diagnostics.pagesFailed, 1);
  assert.ok(result.diagnostics.issues.some((issue) => issue.issueId.startsWith("duplicate-title:")));
  assert.ok(result.diagnostics.issues.some((issue) => issue.category === "availability"));
  const { categoryScores } = result.diagnostics.summary;
  assert.deepEqual(Object.keys(categoryScores).sort(), ["accessibility", "content", "legal", "mobile", "performance", "security", "seo", "social"]);
  for (const score of Object.values(categoryScores)) assert.ok(score >= 0 && score <= 100);
});

test("whole-site scan surfaces a Yandex Metrika counter found on any crawled page", async () => {
  const pages = new Map([
    ["https://example.com/", `<!doctype html><html lang="ru"><head><title>Главная</title></head><body><a href="/about">О нас</a></body></html>`],
    ["https://example.com/about", `<!doctype html><html lang="ru"><head><title>О нас</title></head><body><script>ym(555444, "init", {});</script></body></html>`]
  ]);
  const fetchImpl = async (url) => pages.has(url)
    ? new Response(pages.get(url), { status: 200, headers: { "Content-Type": "text/html" } })
    : new Response("not found", { status: 404, headers: { "Content-Type": "text/html" } });
  const result = await scanSiteInventory({ target_url: "https://example.com/", scope: "site" }, fetchImpl, { maxPages: 10 });
  assert.equal(result.metrikaCounterId, "555444");
});

test("a clean site scores 100 and each severity pulls the score down without going negative", () => {
  assert.equal(computeHealthScore({}), 100);
  assert.equal(computeHealthScore({ high: 0, medium: 0, low: 0 }), 100);
  assert.equal(computeHealthScore({ high: 1 }), 85);
  assert.equal(computeHealthScore({ medium: 2 }), 90);
  assert.equal(computeHealthScore({ low: 3 }), 97);
  assert.equal(computeHealthScore({ high: 10, medium: 10, low: 10 }), 0);
});

test("categorySeverityCounts isolates one category's severities for the Главная gauges", () => {
  const issues = [
    { category: "seo", severity: "high" },
    { category: "seo", severity: "low" },
    { category: "performance", severity: "medium" },
    { category: "mobile", severity: "high" }
  ];
  assert.deepEqual(categorySeverityCounts(issues, "seo"), { high: 1, medium: 0, low: 1 });
  assert.deepEqual(categorySeverityCounts(issues, "security"), { high: 0, medium: 0, low: 0 });
  assert.equal(computeHealthScore(categorySeverityCounts(issues, "seo")), 84);
  assert.equal(computeHealthScore(categorySeverityCounts(issues, "security")), 100);
});

test("a stable week reads as a positive result, not an absence of work", () => {
  const stable = buildDigestSummary({ score: 96, scoreDelta: 0, checksCount: 288, incidentsOpened: 0, incidentsResolved: 0, findingsCount: 0 });
  assert.match(stable, /проверен 288 раз/u);
  assert.match(stable, /всё стабильно/u);
  assert.doesNotMatch(stable, /работ.* не/u);
  assert.match(stable, /96 \(без изменений\)/u);
});

test("a week with incidents and findings reports what was found without hiding it", () => {
  const busy = buildDigestSummary({ score: 82, scoreDelta: -8, checksCount: 288, incidentsOpened: 1, incidentsResolved: 1, findingsCount: 3 });
  assert.match(busy, /Обнаружено проблем с доступностью: 1, устранено: 1/u);
  assert.match(busy, /нашла 3 момент/u);
  assert.match(busy, /82 \(-8\)/u);
});

test("a page with no privacy link, form without consent and no cookie banner fails all three legal checks", () => {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Главная страница сайта</title><meta name="description" content="Описание страницы длиной более двадцати символов"><meta property="og:title" content="x"><meta property="og:image" content="y"><link rel="icon" href="/favicon.ico"></head><body><h1>Привет</h1><form><input name="phone"><button>Отправить</button></form></body></html>`;
  const result = diagnosePage(html, "https://example.com/");
  const legalIds = result.issues.filter((issue) => issue.category === "legal").map((issue) => issue.issueId);
  assert.ok(legalIds.some((id) => id.startsWith("legal-privacy-link:")));
  assert.ok(legalIds.some((id) => id.startsWith("legal-consent-form:")));
  assert.ok(legalIds.some((id) => id.startsWith("legal-cookie-banner:")));
  assert.equal(result.facts.hasPrivacyLink, false);
});

test("a page with a privacy link, consent text and a cookie banner passes all three legal checks", () => {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Главная страница сайта</title><meta name="description" content="Описание страницы длиной более двадцати символов"><meta property="og:title" content="x"><meta property="og:image" content="y"><link rel="icon" href="/favicon.ico"></head><body><h1>Привет</h1><a href="/privacy">Политика конфиденциальности</a><form><input name="phone"><label>Я согласен на обработку персональных данных</label><button>Отправить</button></form><div class="cookie-consent">Мы используем файлы cookie</div></body></html>`;
  const result = diagnosePage(html, "https://example.com/");
  const legalIds = result.issues.filter((issue) => issue.category === "legal").map((issue) => issue.issueId);
  assert.deepEqual(legalIds, []);
  assert.equal(result.facts.hasPrivacyLink, true);
});

test("buildContentFields extracts stable, content-independent slot keys for phones and buttons", () => {
  const inventory = {
    pages: [{ url: "https://x.test/", path: "/", title: "Главная", schedules: ["Пн-Пт 9:00-18:00"] }],
    diagnostics: { pageFacts: [{ url: "https://x.test/", path: "/", title: "Главная", description: "Описание", h1: ["Заголовок"] }] },
    phoneCandidates: [{ pagePath: "/", pageTitle: "Главная", blockId: "rec100", matchIndex: 0, phone: "+7 (495) 000-00-00", sectionLabel: "Шапка" }],
    candidates: [{ pagePath: "/", pageTitle: "Главная", blockId: "rec200", matchIndex: 0, text: "Заказать звонок", url: "https://x.test/#form", sectionLabel: "Главный экран" }]
  };
  const fields = buildContentFields(inventory);
  assert.equal(fields.size, 7);
  assert.equal(fields.get("/|phone|rec100|0").value, "+7 (495) 000-00-00");
  assert.equal(fields.get("/|button_text|rec200|0").value, "Заказать звонок");
  assert.equal(fields.get("/|schedule|0").value, "Пн-Пт 9:00-18:00");
  // The slot key must survive a value change so a diff sees "same slot,
  // different value" instead of two unrelated candidates.
  inventory.phoneCandidates[0].phone = "+7 (495) 111-11-11";
  const updated = buildContentFields(inventory);
  assert.equal(updated.get("/|phone|rec100|0").value, "+7 (495) 111-11-11");
});

test("checkDomainExpiry parses the RDAP expiration event and treats a non-2xx response as failure", async () => {
  const ok = await checkDomainExpiry("example.com", async () => ({
    ok: true,
    json: async () => ({ ldhName: "EXAMPLE.COM", events: [{ eventAction: "registration", eventDate: "2010-01-01T00:00:00Z" }, { eventAction: "expiration", eventDate: "2027-01-01T00:00:00Z" }] })
  }));
  assert.equal(ok.expiresAt, "2027-01-01T00:00:00.000Z");
  assert.equal(ok.registrar, "EXAMPLE.COM");
  await assert.rejects(() => checkDomainExpiry("nonexistent.test", async () => ({ ok: false, status: 404 })));
});
