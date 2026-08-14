import test from "node:test";
import assert from "node:assert/strict";
import { diagnosePage, extractEditableInventory, scanSiteInventory } from "../gateway/src/platform-monitor.js";

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
});
