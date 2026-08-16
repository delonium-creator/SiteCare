import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  GATEWAY_SCOPE,
  SCOPE,
  buildPinnedGatewayConfig,
  buildPinnedConfig,
  extractWorkerUrl,
  findExactDatabase,
  gatewayAdminJson,
  gatewaySecretEntries,
  missingOauthScopes,
  normalizeWhoami,
  parseJsonOutput,
  validateGatewayConfig,
  validateProjectConfig,
  waitForGatewayAdminAccess,
  workerSecretNames
} from "../deploy-windows.mjs";

test("parses Wrangler JSON even when a notice surrounds it", () => {
  const parsed = parseJsonOutput(`notice\n{"loggedIn":true,"accounts":[]}\ndone`);
  assert.equal(parsed.loggedIn, true);
});

test("normalizes and exposes only selectable Cloudflare accounts", () => {
  const identity = normalizeWhoami({
    loggedIn: true,
    authType: "OAuth Token",
    email: "owner@example.test",
    accounts: [{ id: "account-1", name: "SiteCare" }, { name: "broken" }],
    tokenPermissions: ["account:read", "user:read", "workers_scripts:write", "d1:write"]
  });
  assert.deepEqual(identity.accounts, [{ id: "account-1", name: "SiteCare" }]);
  assert.deepEqual(missingOauthScopes(identity), ["ai:write"]);
});

test("recognizes existing panel secrets without exposing their values", () => {
  const names = workerSecretNames([
    { name: "ADMIN_PASSWORD", type: "secret_text" },
    { name: "SESSION_SECRET", type: "secret_text" },
    { name: "FORM_WEBHOOK_SECRET", type: "secret_text" }
  ]);
  assert.equal(names.has("ADMIN_PASSWORD"), true);
  assert.equal(names.has("SESSION_SECRET"), true);
  assert.equal(names.has("FORM_WEBHOOK_SECRET"), true);
});

test("central Worker secrets are prepared as one bounded bulk update", () => {
  const fresh = gatewaySecretEntries({
    gatewayBotConfigured: false,
    gatewayWebhookConfigured: false,
    gatewayEmailConfigured: false,
    gatewayLeadsKeyConfigured: false,
    gatewayOpenAiConfigured: false
  }, {
    adminToken: "admin-token",
    botToken: "bot-token",
    webhookToken: "webhook-token",
    leadsDataKey: "leads-data-key",
    resendApiKey: "resend-key",
    emailFrom: "SiteCare <owner@example.test>",
    openAiApiKey: "sk-openai-test-key"
  });
  assert.deepEqual(fresh, {
    GATEWAY_ADMIN_TOKEN: "admin-token",
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_WEBHOOK_SECRET: "webhook-token",
    LEADS_DATA_KEY: "leads-data-key",
    RESEND_API_KEY: "resend-key",
    SITECARE_EMAIL_FROM: "SiteCare <owner@example.test>",
    OPENAI_API_KEY: "sk-openai-test-key"
  });
  const existing = gatewaySecretEntries({
    gatewayBotConfigured: true,
    gatewayWebhookConfigured: true,
    gatewayEmailConfigured: true,
    gatewayLeadsKeyConfigured: true,
    gatewayOpenAiConfigured: true
  }, {
    adminToken: "next-admin-token",
    botToken: null,
    webhookToken: "unused",
    leadsDataKey: "unused-leads-key",
    resendApiKey: null,
    emailFrom: null,
    openAiApiKey: null
  });
  assert.deepEqual(existing, { GATEWAY_ADMIN_TOKEN: "next-admin-token" });
});

test("installer waits through stale Cloudflare deployments until the new admin key answers", async () => {
  const responses = [
    Response.json({ error: "Доступ запрещён." }, { status: 403 }),
    Response.json({ ok: true, version: "4.1.2" }),
    Response.json({ ok: true, version: "7.0.0", configured: false }),
    Response.json({ ok: true, version: "7.0.0", configured: false }),
    Response.json({ ok: true, version: "7.0.0", configured: false })
  ];
  const sleeps = [];
  const status = await waitForGatewayAdminAccess("https://gateway.example.test", "admin-token", {
    maxAttempts: 5,
    fetchImpl: async () => responses.shift(),
    sleep: async (milliseconds) => { sleeps.push(milliseconds); }
  });
  assert.equal(status.version, "7.0.0");
  assert.equal(sleeps.length, 4);
});

test("every protected gateway request retries an edge still serving the old admin key", async () => {
  const calls = [];
  const responses = [
    Response.json({ error: "Доступ запрещён." }, { status: 403 }),
    Response.json({ ok: true, configured: false, version: "7.0.0" })
  ];
  const result = await gatewayAdminJson("https://gateway.example.test", "admin-token", "/v1/admin/platform/status", {
    expectedVersion: "7.0.0",
    maxAttempts: 2,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
    sleep: async () => {}
  });
  assert.equal(result.data.version, "7.0.0");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, "Bearer admin-token");
});

test("finds only the exact D1 database", () => {
  const database = findExactDatabase([
    { uuid: "other-id", name: "another-project" },
    { uuid: "right-id", name: SCOPE.databaseName }
  ]);
  assert.deepEqual(database, { id: "right-id", name: SCOPE.databaseName });
});

test("pins the chosen account and exact database without widening scope", async () => {
  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  assert.equal(validateProjectConfig(config), true);
  const pinned = buildPinnedConfig(config, "chosen-account", "chosen-database");
  assert.equal(pinned.account_id, "chosen-account");
  assert.equal(pinned.d1_databases[0].database_id, "chosen-database");
  assert.equal(pinned.vars.ALLOWED_HOSTNAME, SCOPE.hostname);
  assert.equal(pinned.vars.ALLOWED_PATH, SCOPE.pathname);
  assert.match(pinned.vars.TELEGRAM_GATEWAY_URL, /^https:\/\/sitecare-telegram-gateway\.[a-z0-9-]+\.workers\.dev$/u);
  assert.deepEqual(pinned.ai, { binding: "AI" });
  assert.equal(pinned.routes, undefined);
});

test("pins only the dedicated shared-bot gateway address", async () => {
  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  const gatewayUrl = "https://sitecare-telegram-gateway.sitecare-test.workers.dev";
  assert.equal(buildPinnedConfig(config, "chosen-account", "chosen-database", gatewayUrl).vars.TELEGRAM_GATEWAY_URL, gatewayUrl);
  assert.throws(
    () => buildPinnedConfig(config, "chosen-account", "chosen-database", "https://attacker.example.test"),
    /SiteCareBot/iu
  );
});

test("central Telegram gateway is pinned to one Worker and one D1 database", async () => {
  const config = JSON.parse(await readFile("gateway/wrangler.jsonc", "utf8"));
  assert.equal(validateGatewayConfig(config), true);
  const pinned = buildPinnedGatewayConfig(config, "chosen-account", "gateway-database");
  assert.equal(pinned.name, GATEWAY_SCOPE.workerName);
  assert.equal(pinned.d1_databases[0].database_name, GATEWAY_SCOPE.databaseName);
  assert.equal(pinned.d1_databases[0].database_id, "gateway-database");
  assert.equal(pinned.vars.CONNECT_TTL_MINUTES, "15");
  assert.equal(pinned.vars.OPENAI_MODEL, "gpt-5-mini");
  assert.deepEqual(pinned.assets, { directory: "./public" });
  assert.deepEqual(pinned.ai, { binding: "AI" });
  const mascot = await readFile("gateway/public/sitecare-assistant.png");
  assert.deepEqual([...mascot.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(pinned.triggers.crons, ["*/5 * * * *"]);
  assert.equal(pinned.routes, undefined);

  const widened = structuredClone(config);
  widened.services = [{ binding: "UNRELATED", service: "another-worker" }];
  assert.throws(() => validateGatewayConfig(widened), /лишние возможности/iu);
});

test("rejects a config redirected to another Tilda project", async () => {
  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  config.vars.ALLOWED_PATH = "/another-page.html";
  assert.throws(() => validateProjectConfig(config), /защита проекта/iu);
});

test("rejects unexpected Cloudflare resources", async () => {
  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  config.r2_buckets = [{ binding: "OTHER", bucket_name: "another-project" }];
  assert.throws(() => validateProjectConfig(config), /лишние возможности Cloudflare/iu);
});

test("rejects a widened or renamed AI binding", async () => {
  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  config.ai = { binding: "OTHER", remote: true };
  assert.throws(() => validateProjectConfig(config), /Настройка ИИ/iu);
});

test("rejects hidden variables and widened database settings", async () => {
  const configWithVariable = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  configWithVariable.vars.UNRELATED_PROJECT = "true";
  assert.throws(() => validateProjectConfig(configWithVariable), /лишние переменные/iu);

  const configWithDatabaseFeature = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  configWithDatabaseFeature.d1_databases[0].remote = true;
  assert.throws(() => validateProjectConfig(configWithDatabaseFeature), /лишние возможности/iu);
});

test("rejects changed preview and observability settings", async () => {
  const preview = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  preview.preview_urls = true;
  assert.throws(() => validateProjectConfig(preview), /Системные настройки/iu);

  const logs = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  logs.observability = { enabled: true, logs: { enabled: true } };
  assert.throws(() => validateProjectConfig(logs), /журналов/iu);
});

test("free-plan config contains no paid CPU limit setting", async () => {
  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  assert.equal(config.limits, undefined);
  const paidConfig = { ...config, limits: { cpu_ms: 10 } };
  assert.throws(() => validateProjectConfig(paidConfig), /лишние возможности Cloudflare/iu);
});

test("extracts the production workers.dev target from Wrangler output", () => {
  const workerUrl = extractWorkerUrl([
    { type: "deploy", targets: ["schedule: */30 * * * *", `https://${SCOPE.workerName}.sitecare-test.workers.dev`] }
  ]);
  assert.equal(workerUrl, `https://${SCOPE.workerName}.sitecare-test.workers.dev`);
});

test("installer source requests no OAuth access to domains, routes, Pages, or unrelated services", async () => {
  const source = await readFile("deploy-windows.mjs", "utf8");
  assert.match(source, /"account:read"/u);
  assert.match(source, /"user:read"/u);
  assert.match(source, /"workers_scripts:write"/u);
  assert.match(source, /"d1:write"/u);
  assert.match(source, /"ai:write"/u);
  assert.doesNotMatch(source, /"workers_routes:write"|"pages:write"|"zone:read"/u);
  assert.match(source, /\/v1\/admin\/platform\/bootstrap/u);
  assert.match(source, /RESEND_API_KEY/u);
  assert.match(source, /OPENAI_API_KEY/u);
  assert.match(source, /\/v1\/admin\/platform\/email\/test/u);
  assert.match(source, /"secret", "bulk"/u);
  assert.equal(source.includes('"secret", "put"'), false);
  assert.ok(source.indexOf("waitForGatewayAdminAccess(gatewayUrl, gatewayAdminToken)") < source.indexOf("gatewayRegistration = await bootstrapGateway"));
  assert.match(source, /Центральная панель/u);
});
