import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { Miniflare } from "miniflare";
import gateway from "../gateway/src/index.js";
import {
  CLOUDFLARE_PBKDF2_MAX_ITERATIONS,
  PASSWORD_ITERATIONS,
  PLAN_LIMITS,
  createPasswordRecord,
  derivePasswordHash,
  loaderJavascript,
  passwordMatches,
  phoneHref,
  replacePhoneNumbersInText,
  replaceScheduleInText,
  roleAllows,
  validateTargetUrl
} from "../gateway/src/platform-core.js";
import { extractEditableInventory } from "../gateway/src/platform-monitor.js";
import { parseLocalChange, prepareSiteChange, rankButtonCandidates } from "../gateway/src/platform-assistant.js";
import { platformHtml, resetPasswordHtml } from "../gateway/src/platform-ui.js";
import { platformInternals } from "../gateway/src/platform.js";

const BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
const ADMIN_TOKEN = "gateway-admin-0123456789abcdef0123456789abcdef";
const WEBHOOK_SECRET = "gateway_webhook_0123456789abcdef0123456789";
const ORIGIN = "https://gateway.example.test";

const PLATFORM_MIGRATIONS = [
  "gateway/migrations/0001_initial.sql",
  "gateway/migrations/0002_platform.sql",
  "gateway/migrations/0003_password_recovery.sql",
  "gateway/migrations/0004_billing_support.sql",
  "gateway/migrations/0005_integration_readiness.sql",
  "gateway/migrations/0006_simplified_editor.sql",
  "gateway/migrations/0007_modular_access.sql",
  "gateway/migrations/0008_closed_access_leads.sql",
  "gateway/migrations/0009_ai_support.sql",
  "gateway/migrations/0010_action_limits.sql",
  "gateway/migrations/0011_targeted_phone_rules.sql",
  "gateway/migrations/0012_precise_phone_targets.sql",
  "gateway/migrations/0013_reliability_privacy.sql",
  "gateway/migrations/0014_health_score.sql",
  "gateway/migrations/0015_digests.sql",
  "gateway/migrations/0016_review_sources.sql"
];

test("site-wide loader safely recognizes visible phone numbers", () => {
  const replacement = "8 (800) 555-35-35";
  assert.equal(replacePhoneNumbersInText("Телефон: +7 (999) 111-22-33", replacement), `Телефон: ${replacement}`);
  assert.equal(replacePhoneNumbersInText("Позвоните: 84952480352", replacement), `Позвоните: ${replacement}`);
  assert.equal(replacePhoneNumbersInText("Связаться: 8 495 248-03-52", replacement), `Связаться: ${replacement}`);
  assert.equal(replacePhoneNumbersInText("Номер в tel-ссылке: 4952480352", replacement, true), `Номер в tel-ссылке: ${replacement}`);
  assert.equal(replacePhoneNumbersInText("Заказ 123-456-789 00", replacement), "Заказ 123-456-789 00");
  assert.equal(replacePhoneNumbersInText("Отчёт 2026-08-11 10-15", replacement), "Отчёт 2026-08-11 10-15");
  assert.equal(phoneHref("+7 (999) 111-22-33"), "tel:+79991112233");
  assert.equal(phoneHref("8 800 555-35-35"), "tel:88005553535");
  assert.equal(replacePhoneNumbersInText("Телефон: +7 (999) 111-22-33", "+7 11111111"), "Телефон: +7 11111111");
  assert.equal(
    replacePhoneNumbersInText("111111111111111", "+7 999 123-45-67", false, "111111111111111"),
    "+7 999 123-45-67"
  );
  assert.equal(
    replacePhoneNumbersInText("Основной: +7 (999) 111-22-33; офис: +7 (495) 248-03-52", "+7 900 000-00-00", false, "74952480352"),
    "Основной: +7 (999) 111-22-33; офис: +7 900 000-00-00"
  );
});

test("site-wide loader supports dynamic Tilda blocks and refreshes configuration", () => {
  const loader = loaderJavascript();
  assert.doesNotThrow(() => new Script(loader));
  assert.match(loader, /const __name=/u);
  assert.match(loader, /MutationObserver/u);
  assert.match(loader, /createTreeWalker/u);
  assert.match(loader, /cache:\s*"no-store"/u);
  assert.match(loader, /setInterval\(loadConfig,\s*5000\)/u);
  assert.match(loader, /document\.currentScript\s*\|\|/u);
  assert.match(loader, /characterData:\s*true/u);
  assert.match(loader, /attributeFilter:\s*\["href"\]/u);
  assert.match(loader, /data-sitecare-ignore/u);
  assert.match(loader, /a\[href\^='tel:'\]/u);
  assert.match(loader, /buttonRules/u);
  assert.match(loader, /phoneRules/u);
  assert.match(loader, /\/applied\?key=/u);
});

test("site-wide loader changes only the selected occurrence of an identical phone", async () => {
  const firstBlock = { id: "rec101", closest(selector) { return selector === "[id^='rec']" ? this : null; } };
  const secondBlock = { id: "rec202", closest(selector) { return selector === "[id^='rec']" ? this : null; } };
  const first = { nodeType: 3, nodeValue: "Телефон: +7 (999) 111-22-33", parentElement: firstBlock, isConnected: true };
  const second = { nodeType: 3, nodeValue: "Телефон: +7 (999) 111-22-33", parentElement: secondBlock, isConnected: true };
  const nodes = [first, second];
  const attributes = new Map();
  const document = {
    nodeType: 9,
    readyState: "complete",
    currentScript: {
      dataset: { sitecareSite: "site-test", sitecareKey: "abcdefghijklmnopqrstuvwxyz123456" },
      src: "https://gateway.example.test/sitecare-loader.js"
    },
    scripts: [],
    documentElement: { setAttribute(name, value) { attributes.set(name, value); } },
    addEventListener() {},
    querySelectorAll() { return []; },
    createTreeWalker(root) {
      const available = root === document ? nodes : [];
      let index = 0;
      return { nextNode() { return available[index++] || null; } };
    }
  };
  const location = { origin: "https://example.test", pathname: "/", href: "https://example.test/" };
  const config = {
    enabled: true,
    origin: location.origin,
    scope: "site",
    version: 1,
    phoneTargetRules: [{
      candidateId: "phone_rec202",
      pagePath: "/",
      blockId: "rec202",
      source: "text",
      occurrenceIndex: 0,
      originalDigits: "79991112233",
      newPhone: "+7 (555) 555-55-55",
      scope: "element"
    }]
  };
  class MutationObserver {
    observe() {}
    disconnect() {}
  }
  const window = {
    location,
    setTimeout() { return 1; },
    setInterval() { return 1; },
    addEventListener() {}
  };
  const context = {
    document,
    window,
    location,
    NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver,
    URL,
    clearTimeout() {},
    fetch: async (url) => url.includes("/config?")
      ? { ok: true, json: async () => config }
      : { ok: true, json: async () => ({ ok: true }) }
  };

  new Script(loaderJavascript()).runInNewContext(context);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(first.nodeValue, "Телефон: +7 (999) 111-22-33");
  assert.equal(second.nodeValue, "Телефон: +7 (555) 555-55-55");
  assert.equal(attributes.get("data-sitecare-status"), "ready");
});

test("one site-wide rule replaces an unformatted long phone in every visible place", async () => {
  const makeBlock = (id) => ({ id, closest(selector) { return selector === "[id^='rec']" ? this : null; } });
  const header = { nodeType: 3, nodeValue: "111111111111111", parentElement: makeBlock("rec101"), isConnected: true };
  const contacts = { nodeType: 3, nodeValue: "Телефон: 111111111111111", parentElement: makeBlock("rec202"), isConnected: true };
  const unrelated = { nodeType: 3, nodeValue: "Заказ 222222222222222", parentElement: makeBlock("rec303"), isConnected: true };
  const nodes = [header, contacts, unrelated];
  const attributes = new Map();
  const document = {
    nodeType: 9,
    readyState: "complete",
    currentScript: {
      dataset: { sitecareSite: "site-test", sitecareKey: "abcdefghijklmnopqrstuvwxyz123456" },
      src: "https://gateway.example.test/sitecare-loader.js"
    },
    scripts: [],
    documentElement: { setAttribute(name, value) { attributes.set(name, value); } },
    addEventListener() {},
    querySelectorAll() { return []; },
    createTreeWalker(root) {
      const available = root === document ? nodes : [];
      let index = 0;
      return { nextNode() { return available[index++] || null; } };
    }
  };
  const location = { origin: "https://example.test", pathname: "/", href: "https://example.test/" };
  const config = {
    enabled: true,
    origin: location.origin,
    scope: "site",
    version: 2,
    phoneTargetRules: [{
      candidateId: "phone_rec202",
      pagePath: "/",
      blockId: "rec202",
      source: "text",
      occurrenceIndex: 0,
      originalDigits: "111111111111111",
      newPhone: "+7 999 123-45-67",
      scope: "site"
    }]
  };
  class MutationObserver {
    observe() {}
    disconnect() {}
  }
  const window = {
    location,
    setTimeout() { return 1; },
    setInterval() { return 1; },
    addEventListener() {}
  };
  const context = {
    document,
    window,
    location,
    NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver,
    URL,
    clearTimeout() {},
    fetch: async (url) => url.includes("/config?")
      ? { ok: true, json: async () => config }
      : { ok: true, json: async () => ({ ok: true }) }
  };

  new Script(loaderJavascript()).runInNewContext(context);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(header.nodeValue, "+7 999 123-45-67");
  assert.equal(contacts.nodeValue, "Телефон: +7 999 123-45-67");
  assert.equal(unrelated.nodeValue, "Заказ 222222222222222");
  assert.equal(attributes.get("data-sitecare-status"), "ready");
});

test("schedule replacement changes only recognizable working-hours text", () => {
  assert.equal(
    replaceScheduleInText("Работаем Пн–Пт 09:00–18:00 без перерыва", "Пн–Сб 10:00–20:00"),
    "Работаем Пн–Сб 10:00–20:00 без перерыва"
  );
  assert.equal(replaceScheduleInText("Встреча 11.08.2026 в 10:00", "Пн–Пт 10:00–19:00"), "Встреча 11.08.2026 в 10:00");
});

test("site inventory gives every visible button a stable, understandable target", () => {
  const inventory = extractEditableInventory(`<!doctype html><html><head><title>Запись</title></head><body>
    <div id="rec101"><a class="t-btn" href="/book">Записаться</a></div>
    <div id="rec202"><button class="t-btn">Позвоните мне</button></div>
    <p>Телефон: +7 (999) 111-22-33</p><p>Пн–Пт 09:00–18:00</p>
  </body></html>`, "https://example.test/services");
  assert.equal(inventory.buttons.length, 2);
  assert.equal(inventory.buttons[0].pageTitle, "Запись");
  assert.equal(inventory.buttons[0].blockId, "rec101");
  assert.equal(inventory.buttons[0].url, "https://example.test/book");
  assert.notEqual(inventory.buttons[0].candidateId, inventory.buttons[1].candidateId);
  assert.deepEqual(inventory.phones, ["+7 (999) 111-22-33"]);
  assert.deepEqual(inventory.schedules, ["Пн–Пт 09:00–18:00"]);
});

test("site inventory distinguishes identical phone locations and ignores technical numeric ids", () => {
  const inventory = extractEditableInventory(`<!doctype html><html><head><title>Контакты</title></head><body>
    <section id="rec101"><h2>Шапка</h2><a href="tel:+79991112233">+7 (999) 111-22-33</a></section>
    <section id="rec202"><h2>Подвал</h2><p>Телефон: +7 (999) 111-22-33</p></section>
    <div data-record-id="1531306243545">Служебный блок 1531306243545</div>
  </body></html>`, "https://example.test/");

  assert.deepEqual(inventory.phones, ["+7 (999) 111-22-33"]);
  assert.equal(inventory.phoneCandidates.length, 2);
  assert.notEqual(inventory.phoneCandidates[0].candidateId, inventory.phoneCandidates[1].candidateId);
  assert.deepEqual(inventory.phoneCandidates.map((item) => item.blockId), ["rec101", "rec202"]);
  assert.equal(inventory.phoneCandidates.some((item) => item.originalDigits === "1531306243545"), false);
});

test("site inventory finds a long Tilda phone split between nested elements", () => {
  const inventory = extractEditableInventory(`<!doctype html><html><head><title>Контакты</title></head><body>
    <section id="rec404"><span>Телефон:</span><strong>111111111111111</strong></section>
    <section id="rec405"><span>Номер заказа:</span><strong>222222222222222</strong></section>
  </body></html>`, "https://example.test/contacts");

  assert.equal(inventory.phoneCandidates.some((item) => item.originalDigits === "111111111111111"), true);
  assert.equal(inventory.phoneCandidates.some((item) => item.originalDigits === "222222222222222"), false);
});

test("the assistant parses common Russian requests locally and asks instead of guessing", async () => {
  assert.deepEqual(parseLocalChange("Заменить телефон на +7 999 123-45-67"), {
    kind: "phone",
    value: "+7 999 123-45-67",
    targetHint: "",
    message: "Подготовил замену телефона на +7 999 123-45-67."
  });
  assert.equal(parseLocalChange("Изменить график на Пн–Пт 10:00–19:00").kind, "schedule");
  const button = parseLocalChange("Заменить текст кнопки «Записаться» на «Оставить заявку»");
  assert.equal(button.kind, "button_text");
  assert.equal(button.value, "Оставить заявку");
  assert.equal(button.targetHint, "Записаться");
  const ranked = rankButtonCandidates([
    { candidateId: "one", text: "Подробнее", url: "", pageTitle: "Главная", pagePath: "/", matchIndex: 0 },
    { candidateId: "two", text: "Записаться", url: "/book", pageTitle: "Услуги", pagePath: "/services", matchIndex: 1 }
  ], button.targetHint);
  assert.equal(ranked[0].candidateId, "two");
  const unknown = await prepareSiteChange({ prompt: "Сделай красиво", inventory: { candidates: [] }, ai: null });
  assert.equal(unknown.type, "advice");
  assert.equal(unknown.supportSuggested, false);
  assert.match(unknown.message, /AI/iu);
  const phoneInventory = { candidates: [], phones: ["+7 (999) 111-22-33", "+7 (495) 248-03-52"] };
  const phoneQuestion = await prepareSiteChange({ prompt: "Замени номер", inventory: phoneInventory, ai: null });
  assert.equal(phoneQuestion.type, "clarification");
  assert.match(phoneQuestion.message, /какой телефон.*изменить/iu);
  const phoneTarget = await prepareSiteChange({
    prompt: "второй",
    inventory: phoneInventory,
    ai: null,
    history: [{ role: "assistant", content: phoneQuestion.message, metadata: { dialog: phoneQuestion.dialog } }]
  });
  assert.equal(phoneTarget.type, "clarification");
  assert.equal(phoneTarget.targetPhone, "+7 (495) 248-03-52");
  const phoneFollowup = await prepareSiteChange({
    prompt: "+7 999 555-44-33",
    inventory: phoneInventory,
    ai: null,
    history: [{ role: "assistant", content: phoneTarget.message, metadata: { dialog: phoneTarget.dialog } }]
  });
  assert.equal(phoneFollowup.type, "change");
  assert.equal(phoneFollowup.kind, "phone");
  assert.equal(phoneFollowup.value, "+7 999 555-44-33");
  assert.equal(phoneFollowup.targetPhone, "+7 (495) 248-03-52");
  const shortPhone = await prepareSiteChange({ prompt: "Замени телефон на +7 11111111", inventory: { candidates: [], phones: ["+7 (999) 111-22-33"] }, ai: null });
  assert.equal(shortPhone.type, "change");
  assert.equal(shortPhone.value, "+7 11111111");
  assert.equal(shortPhone.targetPhone, "+7 (999) 111-22-33");

  const buttonInventory = { candidates: [{ candidateId: "book", text: "Записаться", url: "/book", pageTitle: "Главная", pagePath: "/", matchIndex: 0 }] };
  const switchedTask = await prepareSiteChange({
    prompt: "Хочу поменять кнопку",
    inventory: buttonInventory,
    ai: null,
    history: [{ role: "assistant", content: phoneQuestion.message, metadata: { dialog: phoneQuestion.dialog } }]
  });
  assert.match(switchedTask.message, /какую кнопку/iu);
  const buttonQuestion = await prepareSiteChange({ prompt: "Хочу поменять кнопку", inventory: buttonInventory, ai: null });
  assert.match(buttonQuestion.message, /какую кнопку/iu);
  const buttonTarget = await prepareSiteChange({
    prompt: "кнопку Записаться",
    inventory: buttonInventory,
    ai: null,
    history: [{ role: "assistant", content: buttonQuestion.message, metadata: { dialog: buttonQuestion.dialog } }]
  });
  assert.match(buttonTarget.message, /текст или ссылку/iu);
  const buttonAttribute = await prepareSiteChange({
    prompt: "текст",
    inventory: buttonInventory,
    ai: null,
    history: [{ role: "assistant", content: buttonTarget.message, metadata: { dialog: buttonTarget.dialog } }]
  });
  assert.match(buttonAttribute.message, /какой новый текст/iu);
  const buttonChange = await prepareSiteChange({
    prompt: "Получить консультацию",
    inventory: buttonInventory,
    ai: null,
    history: [{ role: "assistant", content: buttonAttribute.message, metadata: { dialog: buttonAttribute.dialog } }]
  });
  assert.equal(buttonChange.type, "change");
  assert.equal(buttonChange.kind, "button_text");
  assert.equal(buttonChange.value, "Получить консультацию");
  assert.equal(buttonChange.suggestedCandidateId, "book");
});

test("a completed assistant response closes the previous editing dialog", async () => {
  const inventory = { candidates: [], phones: ["+7 (999) 111-22-33"], schedules: [] };
  const oldQuestion = await prepareSiteChange({ prompt: "Замени номер", inventory, ai: null });
  const result = await prepareSiteChange({
    prompt: "Что ты можешь сделать?",
    inventory,
    ai: null,
    history: [
      { role: "assistant", content: oldQuestion.message, metadata: { dialog: oldQuestion.dialog } },
      { role: "assistant", content: "Готово. Изменение применено.", metadata: {} }
    ]
  });

  assert.equal(result.type, "advice");
  assert.match(result.message, /могу изменить конкретный телефон/iu);
});

test("exact commands stay deterministic while the AI handles genuinely ambiguous wording", async () => {
  const calls = [];
  const ai = {
    async run(model, input) {
      calls.push({ model, input });
      return {
        response: JSON.stringify({
          kind: "schedule",
          value: "Ежедневно 10:00–12:00",
          targetHint: "",
          message: "Подготовил новый график работы.",
          supportSuggested: false,
          supportReason: ""
        })
      };
    }
  };
  const exact = await prepareSiteChange({
    prompt: "Измени телефон на +7 999 123-45-67",
    inventory: { pageCount: 1, candidates: [], phones: ["+7 111 111-11-11"], schedules: [] },
    ai
  });
  assert.equal(calls.length, 0);
  assert.equal(exact.usedAi, false);
  assert.equal(exact.kind, "phone");
  assert.equal(exact.value, "+7 999 123-45-67");
  const result = await prepareSiteChange({
    prompt: "Поставь обычный режим как у офиса",
    inventory: { pageCount: 1, candidates: [], phones: [], schedules: [] },
    ai
  });
  assert.equal(calls.length, 1);
  assert.equal(result.usedAi, true);
  assert.equal(result.assistantMode, "ai");
  assert.equal(result.kind, "schedule");
  assert.equal(result.value, "Ежедневно 10:00–12:00");
});

async function databaseWithMigrations(files = PLATFORM_MIGRATIONS) {
  const runtime = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-08-04",
    d1Databases: ["GATEWAY_DB"]
  });
  const database = await runtime.getD1Database("GATEWAY_DB");
  for (const file of files) {
    const migration = await readFile(file, "utf8");
    const statements = migration.split(/;\s*(?:\n|$)/u).map((statement) => statement.trim()).filter(Boolean);
    for (const statement of statements) await database.prepare(statement).run();
  }
  return { runtime, database };
}

test("chat rate limits stop repeated writes inside one bounded window", async () => {
  const { runtime, database } = await databaseWithMigrations();
  try {
    const env = { GATEWAY_DB: database };
    await platformInternals.enforceActionLimit(env, "test-chat", 2, 300);
    await platformInternals.enforceActionLimit(env, "test-chat", 2, 300);
    await assert.rejects(
      () => platformInternals.enforceActionLimit(env, "test-chat", 2, 300),
      (error) => error?.status === 429 && error?.code === "RATE_LIMITED"
    );
  } finally {
    await runtime.dispose();
  }
});

test("the 5.0 migration preserves existing data and widens old page records to the whole site", async () => {
  const { runtime, database } = await databaseWithMigrations(PLATFORM_MIGRATIONS.slice(0, 3));
  try {
    const now = new Date().toISOString();
    await database.prepare(
      "INSERT INTO platform_accounts (account_id, name, plan, status, trial_ends_at, created_at, updated_at) VALUES ('acc_existing', 'Existing', 'business', 'active', NULL, ?, ?)"
    ).bind(now, now).run();
    await database.prepare(
      "INSERT INTO platform_sites (site_id, account_id, name, target_url, target_origin, target_pathname, loader_key, created_at, updated_at) VALUES ('existing-site', 'acc_existing', 'Existing site', 'https://example.test/page', 'https://example.test', '/page', 'loader_key_01234567890123456789', ?, ?)"
    ).bind(now, now).run();
    await database.prepare(
      "INSERT INTO platform_site_overrides (site_id, enabled, phone, schedule_text, button_text, button_url, version, updated_at) VALUES ('existing-site', 1, '+7 999 123-45-67', '', '', '', 7, ?)"
    ).bind(now).run();
    for (const file of PLATFORM_MIGRATIONS.slice(3)) {
      const migration = await readFile(file, "utf8");
      for (const statement of migration.split(/;\s*(?:\n|$)/u).map((item) => item.trim()).filter(Boolean)) {
        await database.prepare(statement).run();
      }
    }
    const billing = await database.prepare("SELECT status, extra_site_slots FROM platform_billing WHERE account_id = 'acc_existing'").first();
    assert.deepEqual(billing, { status: "active", extra_site_slots: 19 });
    const history = await database.prepare("SELECT version, enabled, phone FROM platform_override_history WHERE site_id = 'existing-site'").first();
    assert.deepEqual(history, { version: 7, enabled: 1, phone: "+7 999 123-45-67" });
    const migratedSite = await database.prepare("SELECT scope FROM platform_sites WHERE site_id = 'existing-site'").first();
    assert.deepEqual(migratedSite, { scope: "site" });
    const products = await database.prepare("SELECT product_key, price_minor FROM platform_products ORDER BY sort_order").all();
    assert.deepEqual(products.results.map((product) => product.product_key), ["control", "reviews", "bundle"]);
    assert.deepEqual(products.results.map((product) => product.price_minor), [149000, 99000, 199000]);
    const controlFeature = await database.prepare(
      "SELECT feature_key, status, source_product_key FROM platform_account_features WHERE account_id = 'acc_existing' AND feature_key = 'control'"
    ).first();
    assert.deepEqual(controlFeature, { feature_key: "control", status: "active", source_product_key: "control" });
  } finally {
    await runtime.dispose();
  }
});

function env(database) {
  return {
    GATEWAY_DB: database,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN,
    LEADS_DATA_KEY: "leads-data-key-0123456789abcdef0123456789abcdef",
    CONNECT_TTL_MINUTES: "15"
  };
}

function request(path, { method = "GET", token, cookie, csrf, body, origin = ORIGIN, contentType = "application/json" } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers["X-SiteCare-CSRF"] = csrf;
  if (origin) headers.Origin = origin;
  if (body !== undefined && contentType) headers["Content-Type"] = contentType;
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : contentType === "application/json" ? JSON.stringify(body) : body
  });
}

async function body(response) {
  return response.json();
}

test("platform password, URL, plan and role rules are bounded", async () => {
  const record = await createPasswordRecord("Strong password 123");
  assert.equal(PASSWORD_ITERATIONS, 100_000);
  assert.equal(PASSWORD_ITERATIONS, CLOUDFLARE_PBKDF2_MAX_ITERATIONS);
  assert.equal(record.iterations, 100_000);
  await assert.rejects(
    derivePasswordHash("Strong password 123", record.salt, 100_001),
    /Cloudflare Workers/iu
  );
  assert.equal(await passwordMatches("Strong password 123", {
    password_salt: record.salt,
    password_hash: record.hash,
    password_iterations: record.iterations
  }), true);
  assert.equal(await passwordMatches("Wrong password 123", {
    password_salt: record.salt,
    password_hash: record.hash,
    password_iterations: record.iterations
  }), false);
  assert.equal(roleAllows("admin", "manager"), true);
  assert.equal(roleAllows("viewer", "manager"), false);
  assert.equal(PLAN_LIMITS.trial.sites, 1);
  assert.equal(validateTargetUrl("https://example.test/page?tracking=1#part"), "https://example.test/page");
  assert.throws(() => validateTargetUrl("https://127.0.0.1/private"), /публичный/iu);
});

test("central dashboard contains syntactically valid browser JavaScript", () => {
  const markup = platformHtml("test-nonce");
  const scripts = [...markup.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Script(scripts[0][1]));
  assert.match(markup, /Новый клиент/u);
  assert.match(markup, /Не получается войти\?/u);
  assert.doesNotMatch(markup, /id="trialForm"|самостоятельн.+регистрац/iu);
  assert.doesNotMatch(markup, /BotFather|токен бота/iu);
  const resetMarkup = resetPasswordHtml("test-nonce", "reset_token_0123456789abcdef0123456789");
  const resetScripts = [...resetMarkup.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)];
  assert.equal(resetScripts.length, 1);
  assert.doesNotThrow(() => new Script(resetScripts[0][1]));
});

test("password recovery emails a single-use token, replaces the password and closes old sessions", async () => {
  const { runtime, database } = await databaseWithMigrations();
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) !== "https://api.resend.com/emails") throw new Error(`Unexpected URL: ${url}`);
    sent.push({ headers: options.headers, body: JSON.parse(options.body) });
    return Response.json({ id: `email-${sent.length}` });
  };
  try {
    const environment = {
      ...env(database),
      RESEND_API_KEY: "re_test_0123456789abcdefghijklmnopqrstuvwxyz"
    };
    const disabled = await gateway.fetch(request("/v1/platform/auth/password/status", { origin: null }), env(database));
    assert.deepEqual(await body(disabled), { ok: true, enabled: true, emailEnabled: false, mode: "operator", expiresInMinutes: 30 });
    const status = await gateway.fetch(request("/v1/platform/auth/password/status", { origin: null }), environment);
    assert.deepEqual(await body(status), { ok: true, enabled: true, emailEnabled: true, mode: "email", expiresInMinutes: 30 });

    const bootstrap = await gateway.fetch(request("/v1/admin/platform/bootstrap", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { email: "owner@example.test", displayName: "Owner", password: "Original password 123" },
      origin: null
    }), environment);
    assert.equal(bootstrap.status, 200);

    const emailTest = await gateway.fetch(request("/v1/admin/platform/email/test", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {},
      origin: null
    }), environment);
    assert.equal(emailTest.status, 200);
    assert.deepEqual(await body(emailTest), {
      ok: true,
      deliveredTo: "owner@example.test",
      transport: "resend"
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.subject, "Почта SiteCare подключена");

    const originalLogin = await gateway.fetch(request("/v1/platform/auth/login", {
      method: "POST",
      body: { email: "owner@example.test", password: "Original password 123" }
    }), environment);
    assert.equal(originalLogin.status, 200);
    const oldCookie = originalLogin.headers.get("Set-Cookie").split(";", 1)[0];

    const requested = await gateway.fetch(request("/v1/platform/auth/password/request", {
      method: "POST",
      body: { email: "owner@example.test" }
    }), environment);
    assert.equal(requested.status, 202);
    const acceptedBody = await body(requested);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].body.to[0], "owner@example.test");
    assert.equal(sent[1].body.from, "SiteCare <onboarding@resend.dev>");
    assert.doesNotMatch(sent[1].body.text, /Original password 123/u);
    const resetUrl = /https:\/\/gateway\.example\.test\/reset-password\?token=([^\s]+)/u.exec(sent[1].body.text)?.[0];
    assert.ok(resetUrl);
    const token = new URL(resetUrl).searchParams.get("token");
    assert.match(token, /^[A-Za-z0-9_-]{40,60}$/u);
    const stored = await database.prepare("SELECT token_hash, used_at FROM platform_password_resets").first();
    assert.notEqual(stored.token_hash, token);
    assert.equal(stored.used_at, null);

    const unknown = await gateway.fetch(request("/v1/platform/auth/password/request", {
      method: "POST",
      body: { email: "missing@example.test" }
    }), environment);
    assert.equal(unknown.status, 202);
    assert.deepEqual(await body(unknown), acceptedBody);
    assert.equal(sent.length, 2);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const repeated = await gateway.fetch(request("/v1/platform/auth/password/request", {
        method: "POST",
        body: { email: "missing@example.test" }
      }), environment);
      assert.equal(repeated.status, 202);
    }
    const limited = await gateway.fetch(request("/v1/platform/auth/password/request", {
      method: "POST",
      body: { email: "missing@example.test" }
    }), environment);
    assert.equal(limited.status, 429);
    assert.equal((await body(limited)).code, "RATE_LIMITED");

    const page = await gateway.fetch(request(`/reset-password?token=${encodeURIComponent(token)}`, { origin: null }), environment);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Создайте новый пароль/u);

    const changed = await gateway.fetch(request("/v1/platform/auth/password/reset", {
      method: "POST",
      body: { token, password: "Replacement password 456" }
    }), environment);
    assert.equal(changed.status, 200);
    const oldSession = await gateway.fetch(request("/v1/platform/session", { cookie: oldCookie }), environment);
    assert.equal(oldSession.status, 401);
    const oldLogin = await gateway.fetch(request("/v1/platform/auth/login", {
      method: "POST",
      body: { email: "owner@example.test", password: "Original password 123" }
    }), environment);
    assert.equal(oldLogin.status, 401);
    const newLogin = await gateway.fetch(request("/v1/platform/auth/login", {
      method: "POST",
      body: { email: "owner@example.test", password: "Replacement password 456" }
    }), environment);
    assert.equal(newLogin.status, 200);
    const reused = await gateway.fetch(request("/v1/platform/auth/password/reset", {
      method: "POST",
      body: { token, password: "Another replacement 789" }
    }), environment);
    assert.equal(reused.status, 400);
    assert.equal((await body(reused)).code, "RESET_TOKEN_INVALID");

    const expiringRequest = await gateway.fetch(request("/v1/platform/auth/password/request", {
      method: "POST",
      body: { email: "owner@example.test" }
    }), environment);
    assert.equal(expiringRequest.status, 202);
    const expiringUrl = /https:\/\/gateway\.example\.test\/reset-password\?token=([^\s]+)/u.exec(sent.at(-1).body.text)?.[0];
    const expiringToken = new URL(expiringUrl).searchParams.get("token");
    await database.prepare("UPDATE platform_password_resets SET expires_at = ? WHERE used_at IS NULL")
      .bind("2020-01-01T00:00:00.000Z").run();
    const expired = await gateway.fetch(request("/v1/platform/auth/password/reset", {
      method: "POST",
      body: { token: expiringToken, password: "Expired replacement 012" }
    }), environment);
    assert.equal(expired.status, 400);
    assert.equal((await body(expired)).code, "RESET_TOKEN_INVALID");
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.dispose();
  }
});

test("operator can resolve a login request without seeing or assigning a permanent password", async () => {
  const { runtime, database } = await databaseWithMigrations();
  try {
    const environment = env(database);
    await gateway.fetch(request("/v1/admin/platform/bootstrap", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { email: "operator@example.test", displayName: "Operator", password: "Operator password 123" },
      origin: null
    }), environment);
    const loginResponse = await gateway.fetch(request("/v1/platform/auth/login", {
      method: "POST",
      body: { email: "operator@example.test", password: "Operator password 123" }
    }), environment);
    const operator = await body(loginResponse);
    const operatorCookie = loginResponse.headers.get("Set-Cookie").split(";", 1)[0];
    const createdResponse = await gateway.fetch(request("/v1/platform/operator/accounts", {
      method: "POST",
      cookie: operatorCookie,
      csrf: operator.csrf,
      body: { name: "Closed Client", ownerEmail: "client@example.test", ownerName: "Client" }
    }), environment);
    const created = await body(createdResponse);
    const acceptedResponse = await gateway.fetch(request("/v1/platform/invites/accept", {
      method: "POST",
      body: {
        token: new URL(created.inviteUrl).searchParams.get("token"),
        email: "client@example.test",
        displayName: "Client",
        password: "Client password 123"
      }
    }), environment);
    assert.equal(acceptedResponse.status, 200);
    const clientCookie = acceptedResponse.headers.get("Set-Cookie").split(";", 1)[0];

    const help = await gateway.fetch(request("/v1/platform/auth/password/request", {
      method: "POST",
      body: { email: "client@example.test" }
    }), environment);
    assert.equal(help.status, 202);
    const dashboard = await body(await gateway.fetch(request(`/v1/platform/dashboard?account=${created.accountId}`, {
      cookie: operatorCookie
    }), environment));
    const clientAccount = dashboard.accounts.find((account) => account.account_id === created.accountId);
    assert.equal(clientAccount.accessRequests.length, 1);
    const target = clientAccount.members[0];
    const accessLinkResponse = await gateway.fetch(request(`/v1/platform/operator/accounts/${created.accountId}/users/${target.user_id}/access-link`, {
      method: "POST",
      cookie: operatorCookie,
      csrf: operator.csrf,
      body: { sendEmail: false }
    }), environment);
    const accessLink = await body(accessLinkResponse);
    assert.equal(accessLinkResponse.status, 200);
    assert.match(accessLink.resetUrl, /\/reset-password\?token=/u);
    assert.equal(JSON.stringify(accessLink).includes("Client password 123"), false);

    const closed = await gateway.fetch(request(`/v1/platform/operator/accounts/${created.accountId}/users/${target.user_id}/sessions`, {
      method: "POST",
      cookie: operatorCookie,
      csrf: operator.csrf,
      body: {}
    }), environment);
    assert.equal(closed.status, 200);
    assert.equal((await gateway.fetch(request("/v1/platform/session", { cookie: clientCookie }), environment)).status, 401);
    const suspended = await gateway.fetch(request(`/v1/platform/operator/accounts/${created.accountId}/users/${target.user_id}/status`, {
      method: "PATCH",
      cookie: operatorCookie,
      csrf: operator.csrf,
      body: { status: "suspended" }
    }), environment);
    assert.equal(suspended.status, 200);
    const denied = await gateway.fetch(request("/v1/platform/auth/login", {
      method: "POST",
      body: { email: "client@example.test", password: "Client password 123" }
    }), environment);
    assert.equal(denied.status, 401);
  } finally {
    await runtime.dispose();
  }
});

test("public signup is closed while an operator invite creates an active sliding session", async () => {
  const { runtime, database } = await databaseWithMigrations();
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) !== "https://api.resend.com/emails") throw new Error(`Unexpected URL: ${url}`);
    sent.push(JSON.parse(options.body));
    return Response.json({ id: `trial-email-${sent.length}` });
  };
  try {
    const environment = { ...env(database), RESEND_API_KEY: "re_test_0123456789abcdefghijklmnopqrstuvwxyz" };
    const bootstrap = await gateway.fetch(request("/v1/admin/platform/bootstrap", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { email: "operator@example.test", displayName: "Operator", password: "Operator password 123" },
      origin: null
    }), environment);
    assert.equal(bootstrap.status, 200);

    const trialResponse = await gateway.fetch(request("/v1/platform/auth/trial/request", {
      method: "POST",
      body: { email: "trial@example.test", displayName: "Trial Client", accountName: "Trial Company" }
    }), environment);
    assert.equal(trialResponse.status, 403);
    assert.equal((await body(trialResponse)).code, "REGISTRATION_CLOSED");
    assert.equal(sent.length, 0);

    const operatorLogin = await gateway.fetch(request("/v1/platform/auth/login", {
      method: "POST",
      body: { email: "operator@example.test", password: "Operator password 123" }
    }), environment);
    const operatorSession = await body(operatorLogin);
    const operatorCookie = operatorLogin.headers.get("Set-Cookie").split(";", 1)[0];
    const created = await gateway.fetch(request("/v1/platform/operator/accounts", {
      method: "POST",
      cookie: operatorCookie,
      csrf: operatorSession.csrf,
      body: { name: "Trial Company", ownerEmail: "trial@example.test", ownerName: "Trial Client" }
    }), environment);
    assert.equal(created.status, 200);
    const inviteUrl = (await body(created)).inviteUrl;

    const acceptedResponse = await gateway.fetch(request("/v1/platform/invites/accept", {
      method: "POST",
      body: { token: new URL(inviteUrl).searchParams.get("token"), email: "trial@example.test", displayName: "Trial Client", password: "Trial client password 123" }
    }), environment);
    assert.equal(acceptedResponse.status, 200);
    const cookie = acceptedResponse.headers.get("Set-Cookie").split(";")[0];
    const oldSeen = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const nearExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await database.prepare("DELETE FROM platform_sessions WHERE user_id = (SELECT user_id FROM platform_users WHERE email = 'operator@example.test')").run();
    await database.prepare("UPDATE platform_sessions SET last_seen_at = ?, expires_at = ?").bind(oldSeen, nearExpiry).run();
    const sessionResponse = await gateway.fetch(request("/v1/platform/session", { cookie }), environment);
    assert.equal(sessionResponse.status, 200);
    const extended = await database.prepare("SELECT last_seen_at, expires_at FROM platform_sessions LIMIT 1").first();
    assert.ok(Date.parse(extended.expires_at) > Date.now() + 11 * 60 * 60 * 1000);
    assert.ok(Date.parse(extended.last_seen_at) > Date.parse(oldSeen));

    const duplicate = await gateway.fetch(request("/v1/platform/auth/trial/request", {
      method: "POST",
      body: { email: "trial@example.test", displayName: "Trial Client", accountName: "Trial Company" }
    }), environment);
    assert.equal(duplicate.status, 403);
    assert.equal(sent.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.dispose();
  }
});

test("one central platform provisions a client, isolates access and receives form metadata", async () => {
  const { runtime, database } = await databaseWithMigrations();
  const originalFetch = globalThis.fetch;
  const telegramCalls = [];
  let targetUp = true;
  let publishedLoaderCode = "";
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.telegram.org") {
      const method = parsed.pathname.split("/").at(-1);
      telegramCalls.push(method);
      if (method === "getMe") return Response.json({ ok: true, result: { id: 42, is_bot: true, username: "OfficialSiteCareBot" } });
      return Response.json({ ok: true, result: true });
    }
    if (parsed.hostname === "client.example.test") {
      if (!targetUp) return new Response("down", { status: 503, headers: { "Content-Type": "text/plain" } });
      return new Response(`<!doctype html><html><head>${publishedLoaderCode}</head><body><p>Телефон: +7 (999) 111-22-33</p><div id="rec1"><form id="lead" data-formaction="webhook"><input name="phone"><button type="submit">Send</button></form></div></body></html>`, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const environment = env(database);
    const botBootstrap = await gateway.fetch(request("/v1/admin/bootstrap", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { siteId: "legacy-site", siteName: "Пилот", targetUrl: "https://client.example.test/legacy" },
      origin: null
    }), environment);
    assert.equal(botBootstrap.status, 200);

    const platformBootstrap = await gateway.fetch(request("/v1/admin/platform/bootstrap", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { email: "owner@example.test", displayName: "Owner", password: "Owner password 123" },
      origin: null
    }), environment);
    assert.equal(platformBootstrap.status, 200);
    assert.equal((await body(platformBootstrap)).version, "7.0.0");

    const loginResponse = await gateway.fetch(request("/v1/platform/auth/login", {
      method: "POST",
      body: { email: "owner@example.test", password: "Owner password 123", remember: true }
    }), environment);
    assert.equal(loginResponse.status, 200);
    assert.match(loginResponse.headers.get("Set-Cookie"), /Max-Age=2592000/u);
    const rememberedSession = await database.prepare(
      "SELECT s.expires_at FROM platform_sessions s JOIN platform_users u ON u.user_id = s.user_id WHERE u.email = 'owner@example.test' LIMIT 1"
    ).first();
    assert.ok(Date.parse(rememberedSession.expires_at) > Date.now() + 29 * 24 * 60 * 60 * 1000);
    const login = await body(loginResponse);
    const operatorCookie = loginResponse.headers.get("Set-Cookie").split(";")[0];

    const operatorDashboard = await body(await gateway.fetch(request("/v1/platform/dashboard", {
      cookie: operatorCookie
    }), environment));
    assert.equal(operatorDashboard.user.platform_role, "operator");
    assert.equal(operatorDashboard.accounts[0].sites[0].site_id, "legacy-site");
    assert.equal(operatorDashboard.accounts[0].sites[0].scope, "site");
    assert.deepEqual(operatorDashboard.products.map((product) => product.productKey), ["control", "reviews", "bundle"]);
    assert.equal(operatorDashboard.accounts[0].features.control.enabled, true);
    assert.equal(operatorDashboard.accounts[0].features.reviews.enabled, true);

    const clientResponse = await gateway.fetch(request("/v1/platform/operator/accounts", {
      method: "POST",
      cookie: operatorCookie,
      csrf: login.csrf,
      body: { name: "Клиент", ownerEmail: "client@example.test", ownerName: "Client" }
    }), environment);
    assert.equal(clientResponse.status, 200);
    const client = await body(clientResponse);
    const invite = new URL(client.inviteUrl).searchParams.get("token");

    const acceptedResponse = await gateway.fetch(request("/v1/platform/invites/accept", {
      method: "POST",
      body: { token: invite, email: "client@example.test", displayName: "Client", password: "Client password 123" }
    }), environment);
    assert.equal(acceptedResponse.status, 200);
    const accepted = await body(acceptedResponse);
    const clientCookie = acceptedResponse.headers.get("Set-Cookie").split(";")[0];
    const clientDashboard = await body(await gateway.fetch(request("/v1/platform/dashboard", { cookie: clientCookie }), environment));
    assert.equal(clientDashboard.accounts.length, 1);
    assert.equal(clientDashboard.accounts[0].name, "Клиент");
    assert.equal(clientDashboard.accounts[0].features.control.enabled, true);
    assert.equal(clientDashboard.accounts[0].features.reviews.enabled, false);

    const productUpdate = await gateway.fetch(request("/v1/platform/operator/products", {
      method: "PATCH",
      cookie: operatorCookie,
      csrf: login.csrf,
      body: {
        products: [{
          productKey: "reviews",
          name: "Отзывы",
          description: "Отзывы и виджет",
          priceMinor: 109000,
          currency: "RUB",
          checkoutUrl: "https://pay.example.test/reviews"
        }]
      }
    }), environment);
    assert.equal(productUpdate.status, 200);
    const reviewCheckout = await gateway.fetch(request(`/v1/platform/accounts/${client.accountId}/billing/checkout`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { productKey: "reviews" }
    }), environment);
    assert.deepEqual(await body(reviewCheckout), {
      ok: true,
      productKey: "reviews",
      checkoutUrl: "https://pay.example.test/reviews"
    });

    const createSiteResponse = await gateway.fetch(request(`/v1/platform/accounts/${client.accountId}/sites`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { name: "Лендинг", url: "https://client.example.test/page?utm=1", scope: "site" }
    }), environment);
    assert.equal(createSiteResponse.status, 201);
    const createdSite = await body(createSiteResponse);
    assert.equal(createdSite.scope, "site");
    assert.match(createdSite.webhookUrl, /\/v1\/platform\/forms\/.+\/webhook\?token=/u);
    assert.equal(createdSite.formRequired, true);
    assert.equal(createdSite.initialCheck.pageOk, true);
    assert.equal(createdSite.initialCheck.formStructureOk, true);
    assert.equal(createdSite.initialCheck.formOk, false);
    assert.equal(createdSite.initialCheck.loaderOk, false);
    const startedTrial = await database.prepare("SELECT status, trial_started_at, current_period_end FROM platform_billing WHERE account_id = ?").bind(client.accountId).first();
    assert.equal(startedTrial.status, "trial");
    assert.ok(startedTrial.trial_started_at);
    assert.ok(Date.parse(startedTrial.current_period_end) - Date.parse(startedTrial.trial_started_at) <= 3 * 24 * 60 * 60 * 1000 + 1000);

    const loaderKey = /data-sitecare-key="([A-Za-z0-9_-]+)"/u.exec(createdSite.loaderCode)?.[1];
    assert.ok(loaderKey);
    const blockedBeforeSetup = await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/overrides`, {
      method: "PATCH",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { enabled: true, phone: "+7 (999) 123-45-67" }
    }), environment);
    assert.equal(blockedBeforeSetup.status, 409);
    assert.equal((await body(blockedBeforeSetup)).code, "SETUP_INCOMPLETE");

    publishedLoaderCode = createdSite.loaderCode;
    const loaderCheck = await body(await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/check`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: {}
    }), environment));
    assert.equal(loaderCheck.loaderOk, true);

    const phoneProposalResponse = await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/assistant`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { prompt: "Замени телефон на +7 11111111" }
    }), environment);
    assert.equal(phoneProposalResponse.status, 200);
    const phoneProposal = await body(phoneProposalResponse);
    assert.equal(phoneProposal.type, "change");
    assert.equal(phoneProposal.kind, "phone");
    assert.equal(phoneProposal.value, "+7 11111111");
    assert.equal(phoneProposal.scope, "site");
    assert.equal(phoneProposal.candidates.length, 1);
    assert.equal(phoneProposal.usedAi, false);
    const phoneAppliedResponse = await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/changes/apply`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { kind: phoneProposal.kind, value: phoneProposal.value, targetPhone: phoneProposal.targetPhone, phoneCandidateId: phoneProposal.suggestedCandidateId, scope: phoneProposal.scope }
    }), environment);
    assert.equal(phoneAppliedResponse.status, 200);
    const phoneApplied = await body(phoneAppliedResponse);
    assert.equal(phoneApplied.version, 2);
    assert.equal(phoneApplied.status, "pending");
    const targetedPhoneConfig = await body(await gateway.fetch(request(`/v1/public/sites/${createdSite.siteId}/config?key=${loaderKey}`, {
      origin: "https://client.example.test"
    }), environment));
    assert.equal(targetedPhoneConfig.phone, "");
    assert.equal(targetedPhoneConfig.phoneRules.length, 0);
    assert.equal(targetedPhoneConfig.phoneTargetRules.length, 1);
    assert.equal(targetedPhoneConfig.phoneTargetRules[0].originalDigits, "79991112233");
    assert.equal(targetedPhoneConfig.phoneTargetRules[0].newPhone, "+7 11111111");
    assert.equal(targetedPhoneConfig.phoneTargetRules[0].scope, "site");
    const phoneAck = await gateway.fetch(request(`/v1/public/sites/${createdSite.siteId}/applied?key=${loaderKey}`, {
      method: "POST",
      body: JSON.stringify({ version: 2, pathname: "/page", phoneCount: 2, scheduleCount: 0, buttonCount: 0, phoneVerified: false, scheduleVerified: false, buttonVerified: false }),
      contentType: "text/plain;charset=UTF-8",
      origin: "https://client.example.test"
    }), environment);
    assert.equal(phoneAck.status, 200);
    assert.equal((await database.prepare("SELECT status FROM platform_change_records WHERE site_id = ? AND version = 2").bind(createdSite.siteId).first()).status, "not_found");
    const verifiedPhoneAck = await gateway.fetch(request(`/v1/public/sites/${createdSite.siteId}/applied?key=${loaderKey}`, {
      method: "POST",
      body: JSON.stringify({ version: 2, pathname: "/page", phoneCount: 2, scheduleCount: 0, buttonCount: 0, phoneVerified: true, scheduleVerified: false, buttonVerified: false }),
      contentType: "text/plain;charset=UTF-8",
      origin: "https://client.example.test"
    }), environment);
    assert.equal(verifiedPhoneAck.status, 200);
    assert.equal((await database.prepare("SELECT status FROM platform_change_records WHERE site_id = ? AND version = 2").bind(createdSite.siteId).first()).status, "confirmed");

    const visiblePhoneQuestion = await body(await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/assistant`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { prompt: "Замени номер" }
    }), environment));
    assert.equal(visiblePhoneQuestion.type, "clarification");
    assert.deepEqual(visiblePhoneQuestion.observed.phones, ["+7 11111111"]);
    assert.match(visiblePhoneQuestion.message, /\+7 11111111/u);

    const conversationBeforeSupport = await body(await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/conversation`, {
      cookie: clientCookie
    }), environment));
    assert.equal(conversationBeforeSupport.conversation.messages.at(-1).role, "ai");
    const operatorCannotRequestSupport = await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/support`, {
      method: "POST",
      cookie: operatorCookie,
      csrf: login.csrf,
      body: { action: "request", reason: "Сам себе поддержка" }
    }), environment);
    assert.equal(operatorCannotRequestSupport.status, 403);
    const supportCreatedResponse = await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/support`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { action: "request", reason: "Нужна помощь с нестандартным блоком." }
    }), environment);
    assert.equal(supportCreatedResponse.status, 201);
    const supportCreated = await body(supportCreatedResponse);
    assert.equal(supportCreated.request.status, "new");
    assert.equal(supportCreated.conversation.supportRequest.requestId, supportCreated.request.requestId);
    assert.equal(supportCreated.conversation.messages.some((message) => message.role === "system"), false);
    const supportQueueResponse = await gateway.fetch(request("/v1/platform/support", {
      cookie: operatorCookie
    }), environment);
    assert.equal(supportQueueResponse.status, 200);
    const supportQueue = await body(supportQueueResponse);
    assert.equal(supportQueue.counts.open, 1);
    assert.equal(supportQueue.requests[0].accountName, "Клиент");
    const clientSupportQueue = await gateway.fetch(request("/v1/platform/support", {
      cookie: clientCookie
    }), environment);
    assert.equal(clientSupportQueue.status, 403);
    const supportTakenResponse = await gateway.fetch(request(`/v1/platform/support/${supportCreated.request.requestId}`, {
      method: "POST",
      cookie: operatorCookie,
      csrf: login.csrf,
      body: { action: "take" }
    }), environment);
    assert.equal(supportTakenResponse.status, 200);
    assert.equal((await body(supportTakenResponse)).request.status, "active");
    const supportTakenAgainResponse = await gateway.fetch(request(`/v1/platform/support/${supportCreated.request.requestId}`, {
      method: "POST",
      cookie: operatorCookie,
      csrf: login.csrf,
      body: { action: "take" }
    }), environment);
    assert.equal(supportTakenAgainResponse.status, 200);
    assert.equal((await body(supportTakenAgainResponse)).request.status, "active");
    const takeMessages = await database.prepare(
      "SELECT COUNT(*) AS count FROM platform_conversation_messages WHERE conversation_id = ? AND content = 'Поддержка подключилась к диалогу.'"
    ).bind(supportCreated.conversation.conversationId).first();
    assert.equal(Number(takeMessages.count), 1);
    const supportReplyResponse = await gateway.fetch(request(`/v1/platform/support/${supportCreated.request.requestId}`, {
      method: "POST",
      cookie: operatorCookie,
      csrf: login.csrf,
      body: { action: "reply", content: "Вижу задачу. Проверю блок и напишу результат здесь." }
    }), environment);
    assert.equal(supportReplyResponse.status, 200);
    assert.equal((await body(supportReplyResponse)).request.status, "waiting_client");
    const conversationWithReply = await body(await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/conversation`, {
      cookie: clientCookie
    }), environment));
    assert.equal(conversationWithReply.conversation.messages.at(-1).role, "support");
    assert.equal(conversationWithReply.conversation.messages.at(-1).authorName, "Поддержка SiteCare");
    assert.match(conversationWithReply.conversation.messages.at(-1).content, /Проверю блок/u);
    assert.equal(conversationWithReply.conversation.messages.some((message) => message.role === "system"), false);
    const supportResolvedResponse = await gateway.fetch(request(`/v1/platform/support/${supportCreated.request.requestId}`, {
      method: "POST",
      cookie: operatorCookie,
      csrf: login.csrf,
      body: { action: "resolve" }
    }), environment);
    assert.equal(supportResolvedResponse.status, 200);
    assert.equal((await body(supportResolvedResponse)).request.status, "resolved");
    const emptySupportQueue = await body(await gateway.fetch(request("/v1/platform/support", {
      cookie: operatorCookie
    }), environment));
    assert.equal(emptySupportQueue.counts.open, 0);
    assert.equal(emptySupportQueue.requests.length, 0);

    const buttonProposalResponse = await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/assistant`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { prompt: "Заменить текст кнопки Send на Отправить" }
    }), environment);
    assert.equal(buttonProposalResponse.status, 200);
    const buttonProposal = await body(buttonProposalResponse);
    assert.equal(buttonProposal.type, "clarification");
    assert.match(buttonProposal.message, /нашёл несколько/iu);
    const selectedButtonResponse = await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/assistant`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { prompt: "первую" }
    }), environment);
    assert.equal(selectedButtonResponse.status, 200);
    const selectedButton = await body(selectedButtonResponse);
    assert.equal(selectedButton.type, "change");
    assert.equal(selectedButton.kind, "button_text");
    assert.equal(selectedButton.value, "Отправить");
    assert.equal(selectedButton.candidates.length, 1);
    assert.ok(selectedButton.suggestedCandidateId);
    const buttonAppliedResponse = await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/changes/apply`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { kind: selectedButton.kind, value: selectedButton.value, candidateId: selectedButton.suggestedCandidateId, scope: "element" }
    }), environment);
    assert.equal(buttonAppliedResponse.status, 200);
    assert.equal((await body(buttonAppliedResponse)).version, 3);
    const earlyConfig = await body(await gateway.fetch(request(`/v1/public/sites/${createdSite.siteId}/config?key=${loaderKey}`, {
      origin: "https://client.example.test"
    }), environment));
    assert.equal(earlyConfig.buttonRules.length, 1);
    assert.equal(earlyConfig.buttonRules[0].newText, "Отправить");

    const webhook = new URL(createdSite.webhookUrl);
    const handshakeResponse = await gateway.fetch(request(`${webhook.pathname}${webhook.search}`, {
      method: "POST",
      body: "test=test",
      contentType: "application/x-www-form-urlencoded",
      origin: null
    }), environment);
    assert.deepEqual(await body(handshakeResponse), { ok: true, verified: true });
    const handshakeState = await database.prepare("SELECT webhook_verified_at, form_verified_at, last_form_at FROM platform_sites WHERE site_id = ?").bind(createdSite.siteId).first();
    assert.ok(handshakeState.webhook_verified_at);
    assert.equal(handshakeState.form_verified_at, null);
    assert.equal(handshakeState.last_form_at, null);
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM platform_form_receipts WHERE site_id = ?").bind(createdSite.siteId).first().then((row) => Number(row.count)), 0);

    const blockedWithoutTestLead = await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/overrides`, {
      method: "PATCH",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { enabled: true, phone: "+7 (999) 123-45-67" }
    }), environment);
    assert.equal(blockedWithoutTestLead.status, 409);
    assert.equal((await body(blockedWithoutTestLead)).code, "SETUP_INCOMPLETE");

    const setupReceiptResponse = await gateway.fetch(request(`${webhook.pathname}${webhook.search}`, {
      method: "POST",
      body: "phone=70000000000&formid=setup-check",
      contentType: "application/x-www-form-urlencoded",
      origin: null
    }), environment);
    assert.equal(setupReceiptResponse.status, 200);
    const readyState = await database.prepare("SELECT webhook_verified_at, form_verified_at, last_form_at FROM platform_sites WHERE site_id = ?").bind(createdSite.siteId).first();
    assert.ok(readyState.webhook_verified_at);
    assert.ok(readyState.form_verified_at);
    assert.ok(readyState.last_form_at);

    const overrideResponse = await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/overrides`, {
      method: "PATCH",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { enabled: true, phone: "+7 (999) 123-45-67", scheduleText: "Пн–Пт 10:00–19:00", buttonText: "Оставить заявку", buttonUrl: "/form" }
    }), environment);
    assert.equal(overrideResponse.status, 200);
    const historyResponse = await body(await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/overrides`, {
      cookie: clientCookie
    }), environment));
    assert.deepEqual(historyResponse.history.map((item) => item.version), [4, 3, 2, 1]);
    const changedAgain = await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/overrides`, {
      method: "PATCH",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { phone: "+7 (999) 000-00-00" }
    }), environment);
    assert.equal((await body(changedAgain)).version, 5);
    const rolledBack = await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/overrides/rollback`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { version: 4 }
    }), environment);
    assert.deepEqual(await body(rolledBack), { ok: true, version: 6, restoredVersion: 4 });
    const publicConfiguration = await gateway.fetch(request(`/v1/public/sites/${createdSite.siteId}/config?key=${loaderKey}`, {
      origin: "https://client.example.test"
    }), environment);
    assert.equal(publicConfiguration.status, 200);
    const config = await body(publicConfiguration);
    assert.equal(config.phone, "+7 (999) 123-45-67");
    assert.equal(config.enabled, true);
    assert.equal(config.buttonRules.length, 1);
    const forgedConfiguration = await gateway.fetch(request(`/v1/public/sites/${createdSite.siteId}/config?key=${loaderKey}`, {
      origin: "https://attacker.example.test"
    }), environment);
    assert.equal(forgedConfiguration.status, 403);

    const connectResponse = await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/telegram/connect`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: {}
    }), environment);
    const connection = await body(connectResponse);
    const start = new URL(connection.connectUrl).searchParams.get("start");
    const telegramWebhook = await gateway.fetch(new Request(`${ORIGIN}/v1/telegram/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET
      },
      body: JSON.stringify({
        update_id: 909,
        message: { text: `/start ${start}`, chat: { id: 555, type: "private" }, from: { id: 555 } }
      })
    }), environment);
    assert.equal((await body(telegramWebhook)).linked, true);

    const supportTelegramConnect = await body(await gateway.fetch(request("/v1/platform/support/connect", {
      method: "POST",
      cookie: operatorCookie,
      csrf: login.csrf,
      body: {}
    }), environment));
    const supportStart = new URL(supportTelegramConnect.connectUrl).searchParams.get("start");
    assert.match(supportStart, /^sup_/u);
    const supportTelegramWebhook = await gateway.fetch(new Request(`${ORIGIN}/v1/telegram/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET
      },
      body: JSON.stringify({
        update_id: 910,
        message: { text: `/start ${supportStart}`, chat: { id: 777, type: "private" }, from: { id: 777 } }
      })
    }), environment);
    assert.deepEqual(await body(supportTelegramWebhook), { ok: true, linked: true, support: true });
    const supportTelegramStatus = await body(await gateway.fetch(request("/v1/platform/support/status", {
      cookie: operatorCookie
    }), environment));
    assert.equal(supportTelegramStatus.configured, true);
    const supportTelegramTest = await gateway.fetch(request("/v1/platform/support/test", {
      method: "POST",
      cookie: operatorCookie,
      csrf: login.csrf,
      body: {}
    }), environment);
    assert.equal(supportTelegramTest.status, 200);

    targetUp = false;
    const firstFailedCheck = await body(await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/check`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: {}
    }), environment));
    assert.equal(firstFailedCheck.pageOk, false);
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM platform_incidents WHERE site_id = ? AND kind = 'page'").bind(createdSite.siteId).first().then((row) => Number(row.count)), 0);
    const secondFailedCheck = await body(await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/check`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: {}
    }), environment));
    assert.equal(secondFailedCheck.pageOk, false);
    targetUp = true;
    const recoveredCheck = await body(await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/check`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: {}
    }), environment));
    assert.equal(recoveredCheck.pageOk, true);
    const incident = await database.prepare("SELECT status, resolved_at FROM platform_incidents WHERE site_id = ? AND kind = 'page'").bind(createdSite.siteId).first();
    assert.equal(incident.status, "resolved");
    assert.ok(incident.resolved_at);
    assert.ok(telegramCalls.filter((method) => method === "sendMessage").length >= 3);

    const receiptResponse = await gateway.fetch(request(`${webhook.pathname}${webhook.search}`, {
      method: "POST",
      body: "phone=79991234567&formid=lead",
      contentType: "application/x-www-form-urlencoded",
      origin: null
    }), environment);
    assert.equal(receiptResponse.status, 200);
    const receipt = await database.prepare("SELECT field_names_json, field_count FROM platform_form_receipts WHERE site_id = ?").bind(createdSite.siteId).first();
    assert.deepEqual(JSON.parse(receipt.field_names_json), ["phone", "formid"]);
    assert.equal(JSON.stringify(receipt).includes("79991234567"), false);
    const protectedLead = await database.prepare(
      "SELECT payload_ciphertext, payload_iv FROM platform_leads WHERE site_id = ? ORDER BY received_at DESC LIMIT 1"
    ).bind(createdSite.siteId).first();
    assert.ok(protectedLead.payload_ciphertext);
    assert.ok(protectedLead.payload_iv);
    assert.equal(JSON.stringify(protectedLead).includes("79991234567"), false);
    const leadDashboard = await body(await gateway.fetch(request("/v1/platform/dashboard", { cookie: clientCookie }), environment));
    const readableLead = leadDashboard.accounts[0].leads.find((lead) => lead.phone === "79991234567");
    assert.ok(readableLead);
    assert.equal(readableLead.status, "new");
    const updatedLead = await gateway.fetch(request(`/v1/platform/leads/${readableLead.leadId}`, {
      method: "PATCH",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { status: "in_progress", note: "Перезвонить после 18:00" }
    }), environment);
    assert.equal(updatedLead.status, 200);
    assert.equal((await body(updatedLead)).lead.note, "Перезвонить после 18:00");

    const blocked = await gateway.fetch(request(`/v1/platform/accounts/${operatorDashboard.accounts[0].account_id}/sites`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { name: "Чужой", url: "https://client.example.test/other", scope: "site" }
    }), environment);
    assert.equal(blocked.status, 403);

    const initialPlanLimit = await gateway.fetch(request(`/v1/platform/accounts/${client.accountId}/sites`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { name: "Второй сайт", url: "https://client.example.test/page-2", scope: "site" }
    }), environment);
    assert.equal(initialPlanLimit.status, 409);
    assert.equal((await body(initialPlanLimit)).code, "PLAN_LIMIT");

    const paidAccess = await gateway.fetch(request(`/v1/platform/operator/accounts/${client.accountId}/billing`, {
      method: "PATCH",
      cookie: operatorCookie,
      csrf: login.csrf,
      body: { status: "active", extraSiteSlots: 2 }
    }), environment);
    assert.equal(paidAccess.status, 200);

    const secondSupport = await body(await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/support`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { action: "request", reason: "Поддержка должна изменить номер вместо меня." }
    }), environment));
    const operatorApplied = await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/changes/apply`, {
      method: "POST",
      cookie: operatorCookie,
      csrf: login.csrf,
      body: { kind: "phone", value: "+7 22222222", targetPhone: "+7 11111111", phoneCandidateId: targetedPhoneConfig.phoneTargetRules[0].candidateId, scope: "site" }
    }), environment);
    assert.equal(operatorApplied.status, 200);
    assert.equal((await body(operatorApplied)).version, 7);
    const operatorConfig = await body(await gateway.fetch(request(`/v1/public/sites/${createdSite.siteId}/config?key=${loaderKey}`, {
      origin: "https://client.example.test"
    }), environment));
    assert.equal(operatorConfig.phone, "");
    assert.equal(operatorConfig.phoneTargetRules.find((rule) => rule.originalDigits === "79991112233")?.newPhone, "+7 22222222");
    const operatorResultReply = await gateway.fetch(request(`/v1/platform/support/${secondSupport.request.requestId}`, {
      method: "POST",
      cookie: operatorCookie,
      csrf: login.csrf,
      body: { action: "reply", content: "Готово: изменение «Телефон» применено. Новое значение: «+7 22222222»." }
    }), environment);
    assert.equal(operatorResultReply.status, 200);
    const resolvedBySupport = await gateway.fetch(request(`/v1/platform/support/${secondSupport.request.requestId}`, {
      method: "POST",
      cookie: operatorCookie,
      csrf: login.csrf,
      body: { action: "resolve" }
    }), environment);
    assert.equal(resolvedBySupport.status, 200);

    for (const number of [2, 3]) {
      const extra = await gateway.fetch(request(`/v1/platform/accounts/${client.accountId}/sites`, {
        method: "POST",
        cookie: clientCookie,
        csrf: accepted.csrf,
        body: { name: `Лендинг ${number}`, url: `https://client.example.test/page-${number}`, scope: "site" }
      }), environment);
      assert.equal(extra.status, 201);
    }
    const planLimit = await gateway.fetch(request(`/v1/platform/accounts/${client.accountId}/sites`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: { name: "Лишний сайт", url: "https://client.example.test/page-4", scope: "site" }
    }), environment);
    assert.equal(planLimit.status, 409);
    assert.equal((await body(planLimit)).code, "PLAN_LIMIT");

    const interval = await database.prepare("SELECT MIN(monitor_interval_minutes) AS minimum, MAX(monitor_interval_minutes) AS maximum FROM platform_sites WHERE account_id = ?").bind(client.accountId).first();
    assert.deepEqual({ minimum: interval.minimum, maximum: interval.maximum }, { minimum: 15, maximum: 15 });

    const pausedAccess = await gateway.fetch(request(`/v1/platform/operator/accounts/${client.accountId}/billing`, {
      method: "PATCH",
      cookie: operatorCookie,
      csrf: login.csrf,
      body: { status: "past_due", extraSiteSlots: 2 }
    }), environment);
    assert.equal(pausedAccess.status, 200);
    const reviewsOnly = await gateway.fetch(request(`/v1/platform/operator/accounts/${client.accountId}/billing`, {
      method: "PATCH",
      cookie: operatorCookie,
      csrf: login.csrf,
      body: { features: { reviews: { status: "active", sourceProductKey: "reviews" } } }
    }), environment);
    assert.equal(reviewsOnly.status, 200);
    const modularDashboard = await body(await gateway.fetch(request("/v1/platform/dashboard", { cookie: clientCookie }), environment));
    assert.equal(modularDashboard.accounts[0].features.control.enabled, false);
    assert.equal(modularDashboard.accounts[0].features.reviews.enabled, true);
    const expiredTrial = await gateway.fetch(request(`/v1/platform/sites/${createdSite.siteId}/check`, {
      method: "POST",
      cookie: clientCookie,
      csrf: accepted.csrf,
      body: {}
    }), environment);
    assert.equal(expiredTrial.status, 409);
    assert.equal((await body(expiredTrial)).code, "PAYMENT_REQUIRED");
    const stillApplied = await body(await gateway.fetch(request(`/v1/public/sites/${createdSite.siteId}/config?key=${loaderKey}`, {
      origin: "https://client.example.test"
    }), environment));
    assert.equal(stillApplied.enabled, true);

    const page = await gateway.fetch(request("/app", { origin: null }), environment);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Всё важное о сайте/iu);
    assert.match(page.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/u);
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.dispose();
  }
});
