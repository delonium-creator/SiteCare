import test from "node:test";
import assert from "node:assert/strict";
import {
  gatewayConfig,
  gatewayConnectionStatus,
  gatewayCreateConnection,
  gatewaySendNotification
} from "../src/gateway-notifications.js";

const SITE_TOKEN = "site-token-0123456789abcdef0123456789abcdef";
const ENV = {
  TELEGRAM_GATEWAY_URL: "https://sitecare-telegram-gateway.example.workers.dev",
  TELEGRAM_SITE_TOKEN: SITE_TOKEN
};

test("site notification client keeps its credential server-side and scopes every request to one site", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/connect")) return Response.json({ ok: true, connectUrl: "https://t.me/SiteCareBot?start=sc_abc" });
    if (url.endsWith("/status")) return Response.json({ ok: true, configured: false });
    return Response.json({ ok: true, sent: true });
  };
  await gatewayConnectionStatus(ENV, "client-site", fetchImpl);
  await gatewayCreateConnection(ENV, "client-site", fetchImpl);
  await gatewaySendNotification(ENV, "client-site", {
    eventId: "client-site:test:001",
    eventType: "test",
    text: "Тест"
  }, fetchImpl);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call.url, /^https:\/\/sitecare-telegram-gateway\.example\.workers\.dev\/v1\/sites\/client-site\//u);
    assert.equal(call.options.headers.Authorization, `Bearer ${SITE_TOKEN}`);
    assert.equal(String(call.options.body || "").includes(SITE_TOKEN), false);
  }
});

test("gateway configuration rejects partial, non-HTTPS and credentialed endpoints", () => {
  assert.equal(gatewayConfig({}), null);
  assert.throws(() => gatewayConfig({ TELEGRAM_GATEWAY_URL: ENV.TELEGRAM_GATEWAY_URL }), /не полностью/iu);
  assert.throws(() => gatewayConfig({ ...ENV, TELEGRAM_GATEWAY_URL: "http://gateway.example.test" }), /адрес/iu);
  assert.throws(() => gatewayConfig({ ...ENV, TELEGRAM_GATEWAY_URL: "https://user:pass@gateway.example.test" }), /адрес/iu);
});

test("gateway errors are bounded and never expose the site token", async () => {
  await assert.rejects(
    gatewayConnectionStatus(ENV, "client-site", async () => Response.json({
      ok: false,
      error: `bad ${SITE_TOKEN}`.repeat(20)
    }, { status: 502 })),
    (error) => {
      assert.ok(error.message.length <= 220);
      assert.equal(error.message.includes(SITE_TOKEN), false);
      return true;
    }
  );
});
