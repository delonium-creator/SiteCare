import test from "node:test";
import assert from "node:assert/strict";
import { computeFactsDelta, shouldGenerateInsight, insightDedupeKey } from "../gateway/src/platform-insights.js";
import { requestOpenAiInsight } from "../gateway/src/platform-openai.js";

test("computeFactsDelta normalizes raw D1 rows into a flat facts object", () => {
  const facts = computeFactsDelta({
    latestHealth: { score: 78, high: 1, medium: 2, low: 3, checked_at: "2026-08-18T06:00:00Z" },
    priorHealth: { score: 90, high: 0, medium: 1, low: 2, checked_at: "2026-08-11T06:00:00Z" },
    leadsThisPeriod: 19,
    leadsPriorPeriod: 28,
    openIncidents: 0,
    recentChanges: [{ summary: "Текст кнопки изменён", target_label: "Страница «Услуги»", kind: "button_text", created_at: "2026-08-15T14:00:00Z" }]
  });
  assert.equal(facts.score, 78);
  assert.equal(facts.scoreDelta, -12);
  assert.equal(facts.leadsDelta, -9);
  assert.equal(facts.leadsPercentChange, -32);
  assert.equal(facts.recentChanges.length, 1);
  assert.equal(facts.recentChanges[0].targetLabel, "Страница «Услуги»");
});

test("computeFactsDelta handles missing history gracefully (first-ever scan)", () => {
  const facts = computeFactsDelta({ latestHealth: { score: 95, high: 0, medium: 0, low: 1 }, priorHealth: null });
  assert.equal(facts.score, 95);
  assert.equal(facts.scoreDelta, 0);
  assert.equal(facts.leadsPercentChange, 0);
});

test("shouldGenerateInsight triggers on open incidents regardless of other numbers", () => {
  const facts = computeFactsDelta({ latestHealth: { score: 95 }, priorHealth: { score: 95 }, openIncidents: 1 });
  const decision = shouldGenerateInsight(facts);
  assert.equal(decision.trigger, true);
  assert.equal(decision.reason, "open_incidents");
});

test("shouldGenerateInsight triggers on a large score drop", () => {
  const facts = computeFactsDelta({ latestHealth: { score: 70 }, priorHealth: { score: 90 } });
  assert.deepEqual(shouldGenerateInsight(facts), { trigger: true, reason: "score_delta" });
});

test("shouldGenerateInsight triggers on a large leads drop with enough sample size", () => {
  const facts = computeFactsDelta({ latestHealth: { score: 90 }, priorHealth: { score: 90 }, leadsThisPeriod: 5, leadsPriorPeriod: 20 });
  assert.deepEqual(shouldGenerateInsight(facts), { trigger: true, reason: "leads_change" });
});

test("shouldGenerateInsight ignores a big percentage swing on tiny lead counts", () => {
  const facts = computeFactsDelta({ latestHealth: { score: 90 }, priorHealth: { score: 90 }, leadsThisPeriod: 0, leadsPriorPeriod: 1 });
  assert.equal(shouldGenerateInsight(facts).trigger, false);
});

test("shouldGenerateInsight stays quiet when nothing meaningfully changed", () => {
  const facts = computeFactsDelta({ latestHealth: { score: 91 }, priorHealth: { score: 89 }, leadsThisPeriod: 10, leadsPriorPeriod: 11, openIncidents: 0 });
  assert.deepEqual(shouldGenerateInsight(facts), { trigger: false, reason: "no_significant_change" });
});

test("insightDedupeKey pairs a site with an insight type", () => {
  assert.equal(insightDedupeKey("site_1", "leads"), "site_1:leads");
});

function insightPayload(overrides = {}) {
  return {
    type: "leads",
    severity: "warning",
    title: "Заявок стало меньше",
    summary: "За неделю заявок пришло заметно меньше, хотя технических проблем не найдено.",
    details: "Заявок: 19 против 28 неделей ранее (-32%). Три дня назад был изменён текст кнопки на странице «Услуги» — возможно, это повлияло на конверсию, но связь не подтверждена.",
    confidence: "medium",
    recommended_action: "Проверьте страницу «Услуги» и сравните результат после изменения кнопки.",
    action_target: "leads",
    ...overrides
  };
}

test("requestOpenAiInsight sends the facts as a strict JSON-schema request and keeps the key server-side", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return Response.json({
      id: "resp_insight_1",
      model: "gpt-5-mini-2025-08-07",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(insightPayload()) }] }]
    });
  };
  const result = await requestOpenAiInsight({
    apiKey: "sk-test-secret-value",
    facts: { score: 78, scoreDelta: -12, leadsPercentChange: -32 },
    fetchImpl
  });
  assert.equal(captured.url, "https://api.openai.com/v1/responses");
  assert.equal(captured.options.headers.Authorization, "Bearer sk-test-secret-value");
  assert.doesNotMatch(captured.options.body, /sk-test-secret-value/u);
  assert.equal(captured.body.text.format.type, "json_schema");
  assert.equal(captured.body.text.format.strict, true);
  assert.match(captured.body.input[0].content, /SITE_FACTS/u);
  assert.equal(result.type, "leads");
  assert.equal(result.severity, "warning");
  assert.equal(result.actionTarget, "leads");
  assert.equal(result.confidence, "medium");
});

test("requestOpenAiInsight falls back to safe defaults on an out-of-enum value instead of throwing", async () => {
  const fetchImpl = async () => Response.json({
    output_text: JSON.stringify(insightPayload({ severity: "catastrophic", confidence: "definitely", action_target: "delete_everything" }))
  });
  const result = await requestOpenAiInsight({ apiKey: "sk-test", facts: {}, fetchImpl });
  assert.equal(result.severity, "info");
  assert.equal(result.confidence, "low");
  assert.equal(result.actionTarget, null);
});

test("requestOpenAiInsight errors never expose the API key", async () => {
  await assert.rejects(
    requestOpenAiInsight({
      apiKey: "sk-never-leak-this",
      facts: {},
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "bad key sk-never-leak-this" } }), { status: 401 })
    }),
    (error) => {
      assert.equal(error.message, "OPENAI_REQUEST_FAILED");
      assert.doesNotMatch(String(error.stack), /sk-never-leak-this/u);
      return true;
    }
  );
});

test("requestOpenAiInsight returns null without a key instead of throwing", async () => {
  const result = await requestOpenAiInsight({ apiKey: "", facts: {}, fetchImpl: async () => { throw new Error("should not be called"); } });
  assert.equal(result, null);
});
