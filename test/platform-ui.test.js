import test from "node:test";
import assert from "node:assert/strict";
import { buildRecentEvents, inviteHtml, platformHtml, resetPasswordHtml } from "../gateway/src/platform-ui.js";

function scriptsFromHtml(html) {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)].map((match) => match[1]);
}

function idsFromHtml(html) {
  html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "");
  return [...html.matchAll(/\sid="([^"]+)"/giu)].map((match) => match[1]);
}

function assertUniqueIds(html) {
  const ids = idsFromHtml(html);
  assert.equal(new Set(ids).size, ids.length, "HTML must not contain duplicate ids");
}

function assertLabelsPointToControls(html) {
  html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "");
  const ids = new Set(idsFromHtml(html));
  for (const match of html.matchAll(/<label\s+for="([^"]+)"/giu)) {
    assert.ok(ids.has(match[1]), `label target ${match[1]} must exist`);
  }
}

test("care workspace has an accessible responsive shell without editing controls", () => {
  const markup=platformHtml("test-nonce");
  assertUniqueIds(markup); assertLabelsPointToControls(markup);
  for(const script of scriptsFromHtml(markup))assert.doesNotThrow(()=>new Function(script));
  assert.match(markup,/Поддержка сайта/u);
  assert.match(markup,/Согласовать предложение/u);
  assert.match(markup,/X-SiteCare-CSRF/u);
  assert.match(markup,/prefers-reduced-motion/u);
  assert.match(markup,/max-width:620px/u);
  assert.match(markup,/max-width:860px/u);
  assert.doesNotMatch(markup,/changes\/apply|overrides\/rollback|changePrompt|Редактор поддержки|Готово — номер изменён/u);
});

test("buildRecentEvents merges leads, changes, incidents and health scans by recency", () => {
  const a = { leads: [
    { siteId: "site_1", receivedAt: "2026-08-15T10:00:00Z", formLabel: "Заявка на сайте" },
    { siteId: "site_2", receivedAt: "2026-08-17T10:00:00Z", formLabel: "Чужой сайт" },
  ] };
  const s = {
    site_id: "site_1",
    _overrides: { changes: [{ summary: "Телефон изменён", target_label: "Весь сайт", created_at: "2026-08-16T10:00:00Z" }] },
    _incidents: [
      { summary: "Сайт не отвечал", opened_at: "2026-08-10T10:00:00Z", resolved_at: null },
      { summary: "Сбой устранён", opened_at: "2026-08-12T09:00:00Z", resolved_at: "2026-08-12T09:40:00Z" },
    ],
    _healthHistory: [{ score: 92, checked_at: "2026-08-14T08:00:00Z" }],
  };
  const events = buildRecentEvents(a, s, 8);
  assert.equal(events.length, 5, "excludes the other site's lead, includes one row per remaining source");
  assert.deepEqual(events.map((e) => e.type), ["change", "lead", "scan", "incident-resolved", "incident-opened"]);
  assert.ok(events.every((e, i) => i === 0 || Date.parse(events[i - 1].timestamp) >= Date.parse(e.timestamp)), "sorted newest first");
});

test("buildRecentEvents truncates to the requested limit", () => {
  const a = { leads: [
    { siteId: "site_1", receivedAt: "2026-08-01T00:00:00Z" },
    { siteId: "site_1", receivedAt: "2026-08-02T00:00:00Z" },
    { siteId: "site_1", receivedAt: "2026-08-03T00:00:00Z" },
  ] };
  const events = buildRecentEvents(a, { site_id: "site_1" }, 2);
  assert.equal(events.length, 2);
  assert.equal(events[0].timestamp, "2026-08-03T00:00:00Z");
});

test("invite and password recovery screens share the safe updated presentation", () => {
  for (const html of [inviteHtml("test-nonce", "invite-token"), resetPasswordHtml("test-nonce", "reset-token")]) {
    assertUniqueIds(html);
    assertLabelsPointToControls(html);
    assert.match(html, /autocomplete="new-password"/u);
    assert.match(html, /Одноразовая защищённая ссылка/u);
    assert.doesNotMatch(html, /<link[^>]+stylesheet|https:\/\/fonts\./iu);
    const scripts = scriptsFromHtml(html);
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new Function(scripts[0]));
  }
});
