import test from "node:test";
import assert from "node:assert/strict";
import {
  createTelegramConnectCode,
  decryptTelegramBotToken,
  encryptTelegramBotToken,
  findTelegramChatByCode,
  hashTelegramConnectCode,
  telegramGetMe,
  telegramSendMessage,
  telegramSetWebhook,
  validateTelegramBotToken
} from "../src/notifications.js";

const SECRET = "notification-secret-0123456789abcdef0123456789abcdef";
const BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";

test("Telegram bot tokens are validated and encrypted before storage", async () => {
  assert.equal(validateTelegramBotToken(` ${BOT_TOKEN} `), BOT_TOKEN);
  assert.throws(() => validateTelegramBotToken("@my_bot"), /токен/iu);
  const encrypted = await encryptTelegramBotToken(BOT_TOKEN, SECRET);
  assert.match(encrypted, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.equal(encrypted.includes(BOT_TOKEN), false);
  assert.equal(await decryptTelegramBotToken(encrypted, SECRET), BOT_TOKEN);
  await assert.rejects(decryptTelegramBotToken(encrypted, `${SECRET}-wrong`), /заново/iu);
});

test("one-time Telegram commands bind only the matching chat", async () => {
  const code = createTelegramConnectCode();
  assert.match(code, /^\/sitecare_[a-z2-9]{10}$/u);
  const hash = await hashTelegramConnectCode(code, SECRET);
  const chat = await findTelegramChatByCode([
    { update_id: 1, message: { text: "/sitecare_wrong2222", chat: { id: 10, type: "private" } } },
    { update_id: 2, message: { text: `${code}@SiteCareBot`, chat: { id: -100123456, type: "supergroup" } } }
  ], hash, SECRET);
  assert.deepEqual(chat, { chatId: "-100123456", chatType: "supergroup" });
  assert.equal(await findTelegramChatByCode([], hash, SECRET), null);
});

test("Telegram API helpers send bounded requests and never expose the token in errors", async () => {
  const calls = [];
  const bot = await telegramGetMe(BOT_TOKEN, async (url, options) => {
    calls.push({ url, options });
    return Response.json({ ok: true, result: { id: 123, is_bot: true, username: "SiteCareBot" } });
  });
  assert.equal(bot.username, "SiteCareBot");
  assert.match(calls[0].url, /\/getMe(?:\?|$)/u);
  assert.equal(calls[0].options.method, "GET");

  await telegramSendMessage(BOT_TOKEN, "123456", "Тест", async (url, options) => {
    const requestUrl = new URL(url);
    assert.equal(options.method, "GET");
    assert.equal(requestUrl.searchParams.get("chat_id"), "123456");
    assert.equal(requestUrl.searchParams.get("text"), "Тест");
    assert.equal(requestUrl.searchParams.get("disable_web_page_preview"), "true");
    return Response.json({ ok: true, result: { message_id: 1 } });
  });

  await assert.rejects(
    telegramSendMessage(BOT_TOKEN, "123456", "Тест", async () => Response.json(
      { ok: false, description: "Forbidden: bot was blocked" },
      { status: 403 }
    )),
    (error) => {
      assert.match(error.message, /Forbidden/iu);
      assert.equal(error.message.includes(BOT_TOKEN), false);
      return true;
    }
  );
});

test("Telegram API retries a failed connection with an independent transport", async () => {
  const calls = [];
  const result = await telegramGetMe(BOT_TOKEN, async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) throw new TypeError("network route unavailable");
    return Response.json({ ok: true, result: { id: 123, is_bot: true, username: "SiteCareBot" } });
  });
  assert.equal(result.username, "SiteCareBot");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[0].url.includes(BOT_TOKEN), true);
  assert.equal(calls[1].url.includes(BOT_TOKEN), true);
});

test("Telegram webhook setup uses an HTTPS URL and a secret verification header token", async () => {
  let body;
  await telegramSetWebhook(
    BOT_TOKEN,
    "https://gateway.example.test/v1/telegram/webhook",
    "webhook_secret_0123456789abcdef0123456789",
    async (_url, options) => {
      assert.equal(options.method, "POST");
      body = JSON.parse(options.body);
      return Response.json({ ok: true, result: true });
    }
  );
  assert.equal(body.url, "https://gateway.example.test/v1/telegram/webhook");
  assert.equal(body.secret_token, "webhook_secret_0123456789abcdef0123456789");
  assert.deepEqual(body.allowed_updates, ["message"]);
  assert.throws(
    () => telegramSetWebhook(BOT_TOKEN, "http://gateway.example.test/hook", "x".repeat(40)),
    /HTTPS/iu
  );
});
