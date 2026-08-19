import test from "node:test";
import assert from "node:assert/strict";
import {
  buildYandexAuthorizeUrl,
  decryptYandexToken,
  encryptYandexToken,
  exchangeYandexCode,
  fetchYandexCounters,
  fetchYandexVisitStats,
  normalizeCountersResponse,
  normalizeTokenResponse,
  normalizeVisitStats,
  refreshYandexToken
} from "../gateway/src/platform-yandex.js";

test("builds a correctly-shaped Yandex OAuth authorize URL", () => {
  const url = new URL(buildYandexAuthorizeUrl({ clientId: "abc123", state: "state-token", redirectUri: "https://gateway.example/callback" }));
  assert.equal(url.origin + url.pathname, "https://oauth.yandex.ru/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "abc123");
  assert.equal(url.searchParams.get("redirect_uri"), "https://gateway.example/callback");
  assert.equal(url.searchParams.get("state"), "state-token");
});

test("normalizes a token response and computes an absolute expiry from expires_in", () => {
  const now = Date.parse("2026-08-19T00:00:00Z");
  const result = normalizeTokenResponse({ access_token: "tok_1", refresh_token: "ref_1", expires_in: 3600 }, now);
  assert.equal(result.accessToken, "tok_1");
  assert.equal(result.refreshToken, "ref_1");
  assert.equal(result.expiresAt, "2026-08-19T01:00:00.000Z");
  assert.equal(normalizeTokenResponse({}), null);
});

test("normalizes a counters list and drops entries without an id", () => {
  const result = normalizeCountersResponse({ counters: [{ id: 111, site: "example.com", name: "Пример" }, { site: "no-id.example" }] });
  assert.deepEqual(result, [{ id: "111", domain: "example.com", name: "Пример" }]);
  assert.deepEqual(normalizeCountersResponse({}), []);
});

test("normalizes visit-stats totals into a plain visit count", () => {
  assert.deepEqual(normalizeVisitStats({ totals: [128.0] }), { visits: 128 });
  assert.deepEqual(normalizeVisitStats({}), { visits: 0 });
});

test("round-trips an access token through AES-GCM encryption", async () => {
  const env = { LEADS_DATA_KEY: "a-long-enough-test-secret-value" };
  const { ciphertext, iv } = await encryptYandexToken(env, "sk-yandex-token-value");
  assert.notEqual(ciphertext, "sk-yandex-token-value");
  const decrypted = await decryptYandexToken(env, ciphertext, iv);
  assert.equal(decrypted, "sk-yandex-token-value");
});

test("decryption fails closed on tampered ciphertext instead of throwing", async () => {
  const env = { LEADS_DATA_KEY: "a-long-enough-test-secret-value" };
  const { iv } = await encryptYandexToken(env, "sk-yandex-token-value");
  const decrypted = await decryptYandexToken(env, "not-real-ciphertext", iv);
  assert.equal(decrypted, null);
});

test("code exchange posts form-encoded credentials and never leaks the client secret on error", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ access_token: "tok_abc", refresh_token: "ref_abc", expires_in: 1000 }), { status: 200 });
  };
  const result = await exchangeYandexCode({ clientId: "cid", clientSecret: "csecret-never-leak", code: "auth-code-1", redirectUri: "https://gateway.example/callback", fetchImpl });
  assert.equal(captured.url, "https://oauth.yandex.ru/token");
  assert.equal(captured.options.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.match(captured.options.body, /client_secret=csecret-never-leak/u);
  assert.equal(result.accessToken, "tok_abc");

  await assert.rejects(
    exchangeYandexCode({ clientId: "cid", clientSecret: "csecret-never-leak", code: "bad-code", redirectUri: "https://gateway.example/callback", fetchImpl: async () => new Response(JSON.stringify({ error: "invalid_grant csecret-never-leak" }), { status: 400 }) }),
    (error) => {
      assert.equal(error.message, "YANDEX_TOKEN_EXCHANGE_FAILED");
      assert.doesNotMatch(error.message, /csecret-never-leak/u);
      return true;
    }
  );
});

test("token refresh distinguishes an invalid/revoked refresh token from a generic failure", async () => {
  await assert.rejects(
    refreshYandexToken({ clientId: "cid", clientSecret: "secret", refreshToken: "expired", fetchImpl: async () => new Response("{}", { status: 400 }) }),
    (error) => { assert.equal(error.message, "YANDEX_TOKEN_INVALID"); return true; }
  );
  const result = await refreshYandexToken({ clientId: "cid", clientSecret: "secret", refreshToken: "valid", fetchImpl: async () => new Response(JSON.stringify({ access_token: "new-tok", expires_in: 3600 }), { status: 200 }) });
  assert.equal(result.accessToken, "new-tok");
});

test("counters and stats requests send the OAuth-scheme Authorization header", async () => {
  let countersAuth, statsAuth, statsUrl;
  await fetchYandexCounters({
    accessToken: "tok-1",
    fetchImpl: async (url, options) => { countersAuth = options.headers.Authorization; return new Response(JSON.stringify({ counters: [{ id: 1, site: "a.ru" }] }), { status: 200 }); }
  });
  assert.equal(countersAuth, "OAuth tok-1");

  const stats = await fetchYandexVisitStats({
    accessToken: "tok-1",
    counterId: "999",
    dateFrom: "2026-08-01",
    dateTo: "2026-08-07",
    fetchImpl: async (url, options) => { statsAuth = options.headers.Authorization; statsUrl = url; return new Response(JSON.stringify({ totals: [42] }), { status: 200 }); }
  });
  assert.equal(statsAuth, "OAuth tok-1");
  assert.match(statsUrl, /id=999/u);
  assert.match(statsUrl, /date1=2026-08-01/u);
  assert.equal(stats.visits, 42);
});

test("an expired or revoked token surfaces as YANDEX_TOKEN_INVALID, not a generic failure", async () => {
  await assert.rejects(
    fetchYandexCounters({ accessToken: "revoked", fetchImpl: async () => new Response("{}", { status: 403 }) }),
    (error) => { assert.equal(error.message, "YANDEX_TOKEN_INVALID"); return true; }
  );
});
