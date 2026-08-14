import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { adminHtml } from "../src/admin.js";
import { LOCK } from "../src/core.js";

function scriptsFromHtml(html) {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)].map((match) => match[1]);
}

function idsFromHtml(html) {
  return [...html.matchAll(/\sid="([^"]+)"/giu)].map((match) => match[1]);
}

function assertAccessibleStructure(html) {
  const ids = idsFromHtml(html);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, "HTML must not contain duplicate ids");
  for (const match of html.matchAll(/<label\s+[^>]*for="([^"]+)"/giu)) {
    assert.ok(uniqueIds.has(match[1]), `label target ${match[1]} must exist`);
  }
}

test("admin page contains syntactically valid JavaScript", () => {
  const html = adminHtml();
  const scripts = scriptsFromHtml(html);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  assertAccessibleStructure(html);
  assert.match(html, /aria-label="Разделы кабинета"/u);
  assert.match(html, /Главная/u);
  assert.match(html, /Заявки/u);
  assert.match(html, /Изменить сайт/u);
  assert.match(html, /Уведомления/u);
  assert.match(html, /Настройки/u);
  assert.match(html, /Что хотите изменить\?/u);
  assert.match(html, /Всё работает/u);
  assert.match(html, /id="leads-list"/u);
  assert.match(html, /data-go-section="edit"/u);
  assert.match(html, /<details class="technical">/u);
  assert.match(html, /@media\(max-width:820px\)/u);
  assert.match(html, /prefers-reduced-motion/u);
  assert.match(html, /\/api\/admin\/assistant/u);
  assert.match(html, /без отдельного подтверждения/iu);
  assert.match(html, /id="ai-confirm"/u);
  assert.match(html, /aiConfirmationToken:confirmationToken/u);
  assert.match(html, /ИИ пока не использован/u);
  assert.match(html, /\/api\/admin\/forms\/webhook-url/u);
  assert.match(html, /не хранит телефон, почту, имя и текст заявки/iu);
  assert.match(html, /только те Telegram, почту и CRM, которые принадлежат вам/u);
  assert.match(html, /общей шапке или подвале/iu);
  assert.match(html, /\/api\/admin\/notifications\/telegram\/start/u);
  assert.match(html, /BotFather/u);
  assert.match(html, /id="telegram-action-status"/u);
  assert.match(html, /Проверяю соединение с Telegram/u);
  assert.doesNotMatch(html, /FORM_WEBHOOK_SECRET/u);
  assert.match(html, /\.textContent\s*=/u);
  assert.doesNotMatch(html, /innerHTML\s*=\s*(?:config|result|item|command)/u);
});

test("shared-bot panel offers one-click Telegram linking without visible BotFather or token fields", () => {
  const html = adminHtml({ sharedBot: true });
  const visibleMarkup = html.split("<script>", 1)[0];
  assertAccessibleStructure(html);
  assert.match(visibleMarkup, /один официальный SiteCareBot/iu);
  assert.match(visibleMarkup, /Подключить Telegram/u);
  assert.match(visibleMarkup, /id="telegram-open"/u);
  assert.doesNotMatch(visibleMarkup, /t\.me\/BotFather|id="telegram-token"|placeholder="Токен бота/iu);
  const scripts = scriptsFromHtml(html);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
});

test("every client-panel JavaScript id reference exists in one supported Telegram variant", () => {
  const direct = adminHtml();
  const shared = adminHtml({ sharedBot: true });
  const ids = new Set([...idsFromHtml(direct), ...idsFromHtml(shared)]);
  const scripts = scriptsFromHtml(direct);
  assert.equal(scripts.length, 1);
  const referenced = [...scripts[0].matchAll(/\$\('([^']+)'\)/gu)].map((match) => match[1]);
  for (const id of referenced) assert.ok(ids.has(id), `JavaScript id ${id} must exist in a supported panel variant`);
});

test("Tilda loader is syntactically valid and locked to the exact page and blocks", async () => {
  const html = await readFile("tilda-loader.html", "utf8");
  const scripts = scriptsFromHtml(html);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  assert.match(html, new RegExp(LOCK.hostname.replaceAll(".", "\\.")));
  assert.match(html, new RegExp(LOCK.pathname.replaceAll(".", "\\.")));
  for (const blockId of LOCK.blockIds) assert.match(html, new RegExp(blockId));
  assert.doesNotMatch(html, /ADMIN_PASSWORD|SESSION_SECRET/);
  assert.match(html, /querySelectorAll/u);
  assert.match(html, /items\.length === 1/u);
});

test("Windows launcher stays ASCII with CRLF and contains no fragile localized commands", async () => {
  const launcher = await readFile("START-SITECARE.bat");
  const text = launcher.toString("ascii");
  assert.equal(launcher.some((byte) => byte > 127), false);
  assert.match(text, /\r\n/u);
  assert.equal(text.replace(/\r\n/gu, "").includes("\n"), false);
  assert.match(text, /npm ci --no-audit --no-fund/u);
  assert.match(text, /node deploy-windows\.mjs/u);
  assert.doesNotMatch(text, /[А-Яа-яЁё]/u);
});

test("database migrations preserve one ordered history record per configuration version", async () => {
  const migration = await readFile("migrations/0003_history_version_guard.sql", "utf8");
  assert.match(migration, /UNIQUE INDEX/iu);
  assert.match(migration, /change_history\(site_id, version\)/u);
});

test("form migration stores only metadata, hashes and bounded monitoring history", async () => {
  const migration = await readFile("migrations/0004_form_monitoring.sql", "utf8");
  assert.match(migration, /form_monitor_runs/u);
  assert.match(migration, /form_test_sessions/u);
  assert.match(migration, /marker_hash/u);
  assert.match(migration, /form_receipts/u);
  assert.doesNotMatch(migration, /phone|email|message|comment|raw_value/iu);
});

test("notification migration stores encrypted connection state without lead contents", async () => {
  const migration = await readFile("migrations/0005_notifications.sql", "utf8");
  assert.match(migration, /encrypted_bot_token/u);
  assert.match(migration, /connect_code_hash/u);
  assert.match(migration, /notification_events/u);
  assert.doesNotMatch(migration, /phone|email|lead_value|raw_token/iu);
});

test("password recovery migration stores only token hashes and bounded rate-limit hashes", async () => {
  const migration = await readFile("gateway/migrations/0003_password_recovery.sql", "utf8");
  assert.match(migration, /platform_password_resets/u);
  assert.match(migration, /token_hash TEXT PRIMARY KEY/u);
  assert.match(migration, /platform_password_reset_limits/u);
  assert.match(migration, /key_hash TEXT PRIMARY KEY/u);
  assert.doesNotMatch(migration, /plaintext|raw_token|ip_address|email TEXT/iu);
});

test("billing migration keeps access, support notes and reversible site versions separate", async () => {
  const migration = await readFile("gateway/migrations/0004_billing_support.sql", "utf8");
  assert.match(migration, /platform_billing/u);
  assert.match(migration, /trial_pending/u);
  assert.match(migration, /extra_site_slots/u);
  assert.match(migration, /platform_support_notes/u);
  assert.match(migration, /platform_override_history/u);
  assert.match(migration, /UNIQUE \(site_id, version\)/u);
  assert.doesNotMatch(migration, /card_number|cvv|lead_value|raw_payload/iu);
});

test("AI support migration keeps conversations, handoff state and Telegram destinations separate", async () => {
  const migration = await readFile("gateway/migrations/0009_ai_support.sql", "utf8");
  assert.match(migration, /platform_conversations/u);
  assert.match(migration, /platform_conversation_messages/u);
  assert.match(migration, /platform_support_requests/u);
  assert.match(migration, /platform_support_destinations/u);
  assert.match(migration, /idx_platform_support_one_open_request/u);
  assert.doesNotMatch(migration, /bot_token|password_hash|raw_payload/iu);
});

test("action limits bound chat writes without storing message or credential data", async () => {
  const migration = await readFile("gateway/migrations/0010_action_limits.sql", "utf8");
  assert.match(migration, /platform_action_limits/u);
  assert.match(migration, /PRIMARY KEY \(bucket_key, window_start\)/u);
  assert.match(migration, /request_count/u);
  assert.doesNotMatch(migration, /message|content|password|token|email/iu);
});

test("targeted phone migration keeps exact-number rules and reversible history separate", async () => {
  const migration = await readFile("gateway/migrations/0011_targeted_phone_rules.sql", "utf8");
  assert.match(migration, /platform_phone_rules/u);
  assert.match(migration, /platform_phone_rule_history/u);
  assert.match(migration, /original_digits/u);
  assert.match(migration, /UNIQUE \(site_id, original_digits\)/u);
  assert.match(migration, /UNIQUE \(site_id, version, original_digits\)/u);
  assert.doesNotMatch(migration, /visitor|lead_value|raw_payload|password|token/iu);
});

test("precise phone targets distinguish identical numbers without storing visitor data", async () => {
  const migration = await readFile("gateway/migrations/0012_precise_phone_targets.sql", "utf8");
  assert.match(migration, /platform_phone_target_rules/u);
  assert.match(migration, /platform_phone_target_rule_history/u);
  assert.match(migration, /candidate_id/u);
  assert.match(migration, /occurrence_index/u);
  assert.match(migration, /scope IN \('element', 'page', 'site'\)/u);
  assert.doesNotMatch(migration, /visitor|lead_value|raw_payload|password|token/iu);
});

test("simplified editor migration stores addressable buttons and runtime confirmation without visitor data", async () => {
  const migration = await readFile("gateway/migrations/0006_simplified_editor.sql", "utf8");
  assert.match(migration, /platform_button_rules/u);
  assert.match(migration, /platform_button_rule_history/u);
  assert.match(migration, /platform_runtime_reports/u);
  assert.match(migration, /platform_change_records/u);
  assert.match(migration, /SET scope = 'site'[\s\S]*WHERE scope = 'page'/u);
  assert.match(migration, /scope IN \('element', 'page', 'site'\)/u);
  assert.doesNotMatch(migration, /visitor|lead_value|raw_payload|card_number|cvv/iu);
});

test("modular access migration separates products, features and verified runtime fields", async () => {
  const migration = await readFile("gateway/migrations/0007_modular_access.sql", "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS platform_products/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS platform_account_features/u);
  assert.match(migration, /'control'.*'reviews'.*'bundle'/su);
  assert.match(migration, /phone_verified/u);
  assert.match(migration, /schedule_verified/u);
  assert.match(migration, /button_verified/u);
});

test("closed access and lead migration stores only encrypted lead payloads", async () => {
  const migration = await readFile("gateway/migrations/0008_closed_access_leads.sql", "utf8");
  assert.match(migration, /platform_leads/u);
  assert.match(migration, /payload_ciphertext/u);
  assert.match(migration, /payload_iv/u);
  assert.match(migration, /platform_access_requests/u);
  assert.doesNotMatch(migration, /phone TEXT|email TEXT|message TEXT|password TEXT/iu);
});

test("reliability migration tracks every form, one-time tests and encrypted support messages", async () => {
  const migration = await readFile("gateway/migrations/0013_reliability_privacy.sql", "utf8");
  assert.match(migration, /platform_form_connections/u);
  assert.match(migration, /PRIMARY KEY \(site_id, form_id\)/u);
  assert.match(migration, /platform_form_test_sessions/u);
  assert.match(migration, /marker_hash/u);
  assert.match(migration, /platform_webhook_dedup/u);
  assert.match(migration, /PRIMARY KEY \(site_id, payload_hash\)/u);
  assert.match(migration, /content_ciphertext/u);
  assert.match(migration, /content_iv/u);
  assert.doesNotMatch(migration, /raw_payload|raw_marker|plain_password|card_number|cvv/iu);
});
