import test from "node:test";
import assert from "node:assert/strict";
import { requestOpenAiAssistant } from "../gateway/src/platform-openai.js";
import { prepareSiteChange } from "../gateway/src/platform-assistant.js";

function openAiPayload(overrides = {}) {
  return {
    reply: "Сайт открывается. В автоматической проверке найдено две SEO-рекомендации.",
    mode: "answer",
    change_kind: "none",
    change_value: "",
    target_hint: "",
    support_suggested: false,
    support_reason: "",
    support_summary: "",
    suggestions: ["Показать SEO-проблемы"],
    ...overrides
  };
}

test("OpenAI Responses request keeps the key server-side and returns structured assistant data", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return Response.json({
      id: "resp_sitecare_1",
      model: "gpt-5-mini-2025-08-07",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(openAiPayload()) }] }]
    }, { headers: { "x-request-id": "req_1" } });
  };
  const result = await requestOpenAiAssistant({
    apiKey: "sk-test-secret-value",
    prompt: "В каком состоянии сайт?",
    history: [{ role: "user", content: "Привет" }],
    siteContext: { site: { name: "Тест" }, diagnostics: { summary: { total: 2 } } },
    fetchImpl
  });

  assert.equal(captured.url, "https://api.openai.com/v1/responses");
  assert.equal(captured.options.headers.Authorization, "Bearer sk-test-secret-value");
  assert.doesNotMatch(captured.options.body, /sk-test-secret-value/u);
  assert.equal(captured.body.store, false);
  assert.equal(captured.body.text.format.type, "json_schema");
  assert.equal(captured.body.text.format.strict, true);
  assert.equal(result.mode, "answer");
  assert.equal(result.reply, openAiPayload().reply);
  assert.deepEqual(result.suggestions, ["Показать SEO-проблемы"]);
});

test("a general website question uses OpenAI while an exact phone workflow stays deterministic", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json({ output_text: JSON.stringify(openAiPayload({ reply: "Проверил доступные факты и объяснил состояние." })) });
  };
  const inventory = {
    phones: ["+7 (999) 111-22-33"],
    phoneCandidates: [{ candidateId: "phone_1", phone: "+7 (999) 111-22-33", originalDigits: "79991112233", pageTitle: "Главная", pagePath: "/", sectionLabel: "Шапка" }],
    candidates: []
  };
  const answer = await prepareSiteChange({
    prompt: "Стоит ли обновить дизайн сайта под текущие тренды?",
    inventory,
    openAi: { apiKey: "sk-test", model: "gpt-5-mini" },
    siteContext: { diagnostics: { summary: { total: 0 } } },
    fetchImpl
  });
  assert.equal(answer.type, "advice");
  assert.equal(answer.usedAi, true);
  assert.equal(calls, 1);

  const local = await prepareSiteChange({
    prompt: "Замени телефон на +7 900 000-00-00",
    inventory,
    openAi: { apiKey: "sk-test", model: "gpt-5-mini" },
    fetchImpl
  });
  assert.equal(local.kind, "phone");
  assert.equal(calls, 1);
});

test("provider errors do not expose the API key", async () => {
  await assert.rejects(
    requestOpenAiAssistant({
      apiKey: "sk-never-leak-this",
      prompt: "Привет",
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "bad key sk-never-leak-this" } }), { status: 401 })
    }),
    (error) => {
      assert.equal(error.message, "OPENAI_REQUEST_FAILED");
      assert.doesNotMatch(String(error.stack), /sk-never-leak-this/u);
      return true;
    }
  );
});
