import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import gateway, { gatewayInternals } from "../gateway/src/index.js";

const BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
const ADMIN_TOKEN = "gateway-admin-0123456789abcdef0123456789abcdef";
const WEBHOOK_SECRET = "gateway_webhook_0123456789abcdef0123456789";
const LEADS_DATA_KEY = "leads-data-key-0123456789abcdef0123456789abcdef";

async function createGatewayDatabase() {
  const runtime = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-08-04",
    d1Databases: ["GATEWAY_DB"]
  });
  const database = await runtime.getD1Database("GATEWAY_DB");
  const migration = await readFile("gateway/migrations/0001_initial.sql", "utf8");
  const statements = migration.split(/;\s*(?:\n|$)/u).map((statement) => statement.trim()).filter(Boolean);
  for (const statement of statements) await database.prepare(statement).run();
  return { runtime, database };
}

function environment(database) {
  return {
    GATEWAY_DB: database,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN,
    LEADS_DATA_KEY,
    CONNECT_TTL_MINUTES: "15"
  };
}

function apiRequest(path, { method = "GET", token, secret, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (secret) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`https://gateway.example.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function responseJson(response) {
  return response.json();
}

test("the shared bot provisions an isolated site, links by deep link and deduplicates notifications", async () => {
  const { runtime, database } = await createGatewayDatabase();
  const originalFetch = globalThis.fetch;
  const telegramCalls = [];
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    const method = parsed.pathname.split("/").at(-1);
    telegramCalls.push({ method, url: String(url), options });
    if (method === "getMe") {
      return Response.json({ ok: true, result: { id: 42, is_bot: true, username: "OfficialSiteCareBot" } });
    }
    if (method === "setWebhook") return Response.json({ ok: true, result: true });
    if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: telegramCalls.length } });
    return Response.json({ ok: false, description: "unexpected" }, { status: 400 });
  };
  try {
    const env = environment(database);
    const bootstrap = await gateway.fetch(apiRequest("/v1/admin/bootstrap", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {
        siteId: "client-site-one",
        siteName: "Первый сайт",
        targetUrl: "https://client.example.test/page"
      }
    }), env);
    assert.equal(bootstrap.status, 200);
    const provisioned = await responseJson(bootstrap);
    assert.match(provisioned.siteToken, /^[A-Za-z0-9_-]{40,}$/u);
    assert.equal(provisioned.botUsername, "OfficialSiteCareBot");
    const webhookCall = telegramCalls.find((call) => call.method === "setWebhook");
    assert.ok(webhookCall);
    assert.equal(webhookCall.options.method, "POST");
    assert.equal(JSON.parse(webhookCall.options.body).url, "https://gateway.example.test/v1/telegram/webhook");

    const unauthorised = await gateway.fetch(apiRequest("/v1/sites/client-site-one/status", {
      token: "wrong-site-token-0123456789abcdef0123456789"
    }), env);
    assert.equal(unauthorised.status, 401);
    const secondSite = await responseJson(await gateway.fetch(apiRequest("/v1/admin/bootstrap", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {
        siteId: "client-site-two",
        siteName: "Второй сайт",
        targetUrl: "https://second.example.test/"
      }
    }), env));
    const crossTenant = await gateway.fetch(apiRequest("/v1/sites/client-site-one/status", {
      token: secondSite.siteToken
    }), env);
    assert.equal(crossTenant.status, 401);

    const connection = await gateway.fetch(apiRequest("/v1/sites/client-site-one/connect", {
      method: "POST",
      token: provisioned.siteToken,
      body: {}
    }), env);
    assert.equal(connection.status, 200);
    const connectionBody = await responseJson(connection);
    const deepLink = new URL(connectionBody.connectUrl);
    assert.equal(deepLink.hostname, "t.me");
    assert.equal(deepLink.pathname, "/OfficialSiteCareBot");
    assert.match(deepLink.searchParams.get("start"), /^sc_[A-Za-z0-9_-]{32}$/u);

    const telegramUpdate = {
      update_id: 1001,
      message: {
        text: `/start ${deepLink.searchParams.get("start")}`,
        chat: { id: 778899, type: "private" },
        from: { id: 778899 }
      }
    };
    const linked = await gateway.fetch(apiRequest("/v1/telegram/webhook", {
      method: "POST",
      secret: WEBHOOK_SECRET,
      body: telegramUpdate
    }), env);
    assert.equal(linked.status, 200);
    assert.equal((await responseJson(linked)).linked, true);

    const replay = await gateway.fetch(apiRequest("/v1/telegram/webhook", {
      method: "POST",
      secret: WEBHOOK_SECRET,
      body: telegramUpdate
    }), env);
    assert.equal((await responseJson(replay)).duplicate, true);

    const status = await responseJson(await gateway.fetch(apiRequest("/v1/sites/client-site-one/status", {
      token: provisioned.siteToken
    }), env));
    assert.equal(status.configured, true);
    assert.equal(status.destination, "личный чат");

    const notification = {
      eventId: "client-site-one:test:0001",
      eventType: "test",
      text: "✅ Тест SiteCare"
    };
    const sent = await responseJson(await gateway.fetch(apiRequest("/v1/sites/client-site-one/notifications", {
      method: "POST",
      token: provisioned.siteToken,
      body: notification
    }), env));
    assert.equal(sent.sent, true);
    assert.equal(sent.duplicate, false);
    const duplicate = await responseJson(await gateway.fetch(apiRequest("/v1/sites/client-site-one/notifications", {
      method: "POST",
      token: provisioned.siteToken,
      body: notification
    }), env));
    assert.equal(duplicate.duplicate, true);
    assert.equal(telegramCalls.filter((call) => call.method === "sendMessage").length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.dispose();
  }
});

test("Telegram webhook rejects forged requests and one-time link parameters cannot be reused", async () => {
  const { runtime, database } = await createGatewayDatabase();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const method = new URL(url).pathname.split("/").at(-1);
    if (method === "getMe") return Response.json({ ok: true, result: { id: 42, is_bot: true, username: "OfficialSiteCareBot" } });
    return Response.json({ ok: true, result: true });
  };
  try {
    const env = environment(database);
    const provisioned = await responseJson(await gateway.fetch(apiRequest("/v1/admin/bootstrap", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { siteId: "secure-site", siteName: "Secure", targetUrl: "https://secure.example.test/" }
    }), env));
    const connection = await responseJson(await gateway.fetch(apiRequest("/v1/sites/secure-site/connect", {
      method: "POST", token: provisioned.siteToken, body: {}
    }), env));
    const parameter = new URL(connection.connectUrl).searchParams.get("start");
    const update = {
      update_id: 1,
      message: { text: `/start ${parameter}`, chat: { id: 123, type: "private" }, from: { id: 123 } }
    };
    const forged = await gateway.fetch(apiRequest("/v1/telegram/webhook", {
      method: "POST", secret: "wrong_webhook_secret_0123456789abcdef", body: update
    }), env);
    assert.equal(forged.status, 401);

    const first = await responseJson(await gateway.fetch(apiRequest("/v1/telegram/webhook", {
      method: "POST", secret: WEBHOOK_SECRET, body: update
    }), env));
    assert.equal(first.linked, true);
    const reused = await responseJson(await gateway.fetch(apiRequest("/v1/telegram/webhook", {
      method: "POST",
      secret: WEBHOOK_SECRET,
      body: { ...update, update_id: 2, message: { ...update.message, chat: { id: 999, type: "private" } } }
    }), env));
    assert.equal(reused.linked, false);
    const destination = await database.prepare("SELECT chat_id FROM telegram_destinations WHERE site_id = 'secure-site'").first();
    assert.equal(destination.chat_id, "123");
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.dispose();
  }
});

test("gateway validators keep tenant identifiers and target URLs narrowly scoped", async () => {
  assert.equal(gatewayInternals.validateSiteId("site-one"), "site-one");
  assert.throws(() => gatewayInternals.validateSiteId("../other"), /код сайта/iu);
  assert.equal(gatewayInternals.validateTargetUrl("https://example.test/page"), "https://example.test/page");
  assert.throws(() => gatewayInternals.validateTargetUrl("http://example.test/page"), /HTTPS/iu);
  assert.equal(gatewayInternals.startParameter("/start abc_def"), "abc_def");
  assert.equal(gatewayInternals.startParameter("hello"), null);
  assert.equal(gatewayInternals.isHelpCommand("/help@OfficialSiteCareBot"), true);
});
