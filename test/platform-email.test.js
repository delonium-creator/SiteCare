import test from "node:test";
import assert from "node:assert/strict";
import {
  emailDeliveryConfigured,
  emailTransport,
  sendEmailSetupTest,
  sendPasswordResetEmail,
  sendTrialInviteEmail
} from "../gateway/src/platform-email.js";

test("email delivery stays disabled without an explicit provider", () => {
  assert.equal(emailTransport({}), "");
  assert.equal(emailDeliveryConfigured({}), false);
  assert.equal(emailTransport({ RESEND_API_KEY: "incomplete" }), "");
});

test("Cloudflare email binding is preferred and receives structured content", async () => {
  const calls = [];
  const environment = {
    EMAIL: { send: async (message) => { calls.push(message); return { messageId: "cf-1" }; } },
    SITECARE_EMAIL_FROM: "SiteCare <support@example.test>",
    RESEND_API_KEY: "re_test_0123456789abcdefghijklmnopqrstuvwxyz"
  };
  const result = await sendPasswordResetEmail(environment, {
    to: "owner@example.test",
    resetUrl: "https://sitecare.example.test/reset-password?token=opaque",
    expiresInMinutes: 30,
    requestId: "request-1"
  });
  assert.deepEqual(result, { transport: "cloudflare", messageId: "cf-1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].from, "SiteCare <support@example.test>");
  assert.equal(calls[0].to, "owner@example.test");
  assert.match(calls[0].text, /opaque/u);
});

test("Resend delivery uses a secret bearer and never puts it in the message", async () => {
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url: String(url), options, body: JSON.parse(options.body) };
    return Response.json({ id: "resend-1" });
  };
  try {
    const key = "re_test_0123456789abcdefghijklmnopqrstuvwxyz";
    const result = await sendEmailSetupTest({ RESEND_API_KEY: key }, {
      to: "owner@example.test",
      requestId: "request-2"
    });
    assert.deepEqual(result, { transport: "resend", messageId: "resend-1" });
    assert.equal(call.url, "https://api.resend.com/emails");
    assert.equal(call.options.headers.Authorization, `Bearer ${key}`);
    assert.equal(JSON.stringify(call.body).includes(key), false);
    assert.equal(call.body.from, "SiteCare <onboarding@resend.dev>");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("trial email explains the delayed three-day start and contains only an invite link", async () => {
  const calls = [];
  const environment = {
    EMAIL: { send: async (message) => { calls.push(message); return { messageId: "trial-1" }; } },
    SITECARE_EMAIL_FROM: "SiteCare <support@example.test>"
  };
  const result = await sendTrialInviteEmail(environment, {
    to: "client@example.test",
    displayName: "Client",
    inviteUrl: "https://gateway.example.test/accept?token=opaque",
    requestId: "trial-request"
  });
  assert.deepEqual(result, { transport: "cloudflare", messageId: "trial-1" });
  assert.match(calls[0].text, /3 бесплатных дня/iu);
  assert.match(calls[0].text, /после подключения/iu);
  assert.match(calls[0].text, /token=opaque/u);
  assert.doesNotMatch(JSON.stringify(calls[0]), /пароль клиента|card_number|cvv/iu);
});
