import test from "node:test";
import assert from "node:assert/strict";
import { computeLeadFacts, isOverdueLead, normalizePhoneDigits } from "../gateway/src/platform-crm.js";
import { requestOpenAiLeadReply, requestOpenAiLeadSummary } from "../gateway/src/platform-openai.js";

test("normalizePhoneDigits compares numbers regardless of formatting", () => {
  assert.equal(normalizePhoneDigits("+7 (900) 111-22-33"), "9001112233");
  assert.equal(normalizePhoneDigits("8 900 111 22 33"), "9001112233");
  assert.equal(normalizePhoneDigits(""), "");
});

test("isOverdueLead only fires for status=new past the threshold", () => {
  const now = Date.parse("2026-08-19T12:00:00Z");
  assert.equal(isOverdueLead({ status: "new", receivedAt: "2026-08-19T10:30:00Z" }, 60, now), true);
  assert.equal(isOverdueLead({ status: "new", receivedAt: "2026-08-19T11:30:00Z" }, 60, now), false);
  assert.equal(isOverdueLead({ status: "completed", receivedAt: "2026-08-19T08:00:00Z" }, 60, now), false);
  assert.equal(isOverdueLead(null), false);
});

test("computeLeadFacts detects a repeat visitor by matching phone across leads on the same site", () => {
  const facts = computeLeadFacts({
    lead: { leadId: "lead_2", phone: "+7 900 111-22-33", email: "", message: "Снова интересует стрижка", status: "new", receivedAt: "2026-08-19T11:00:00Z" },
    relatedLeads: [
      { leadId: "lead_1", phone: "8 900 111 22 33", email: "", message: "В мае интересовалась услугой", status: "completed", receivedAt: "2026-05-10T09:00:00Z" },
      { leadId: "lead_3", phone: "+7 900 999-99-99", email: "", message: "Другой человек", status: "new", receivedAt: "2026-08-01T09:00:00Z" }
    ],
    now: Date.parse("2026-08-19T11:05:00Z")
  });
  assert.equal(facts.isRepeatVisitor, true);
  assert.equal(facts.priorContactCount, 1);
  assert.equal(facts.priorContacts[0].message, "В мае интересовалась услугой");
});

test("computeLeadFacts matches by email when phone is absent, and never matches itself", () => {
  const facts = computeLeadFacts({
    lead: { leadId: "lead_9", phone: "", email: "maria@example.com", message: "Ещё раз про цены", status: "new", receivedAt: "2026-08-19T11:00:00Z" },
    relatedLeads: [
      { leadId: "lead_9", phone: "", email: "maria@example.com", message: "не должен совпасть сам с собой", status: "new", receivedAt: "2026-08-19T11:00:00Z" },
      { leadId: "lead_8", phone: "", email: "MARIA@example.com", message: "Про цены на прошлой неделе", status: "in_progress", receivedAt: "2026-08-12T09:00:00Z" }
    ]
  });
  assert.equal(facts.priorContactCount, 1);
  assert.equal(facts.priorContacts[0].message, "Про цены на прошлой неделе");
});

test("computeLeadFacts flags overdue new leads and carries the minutes waited", () => {
  const facts = computeLeadFacts({
    lead: { leadId: "lead_1", status: "new", receivedAt: "2026-08-19T10:00:00Z", message: "Здравствуйте" },
    relatedLeads: [],
    thresholdMinutes: 60,
    now: Date.parse("2026-08-19T12:00:00Z")
  });
  assert.equal(facts.isOverdue, true);
  assert.equal(facts.overdueMinutes, 120);
});

test("computeLeadFacts leaves overdue false for leads already worked on", () => {
  const facts = computeLeadFacts({ lead: { status: "in_progress", receivedAt: "2026-08-01T00:00:00Z" }, now: Date.parse("2026-08-19T00:00:00Z") });
  assert.equal(facts.isOverdue, false);
  assert.equal(facts.overdueMinutes, 0);
});

function summaryPayload(overrides = {}) {
  return { summary: "Мария обращается второй раз. Заявка ждёт ответа необычно долго.", urgency: "high", suggested_next_step: "Перезвоните в первую очередь.", ...overrides };
}

test("requestOpenAiLeadSummary sends LEAD_FACTS as a strict schema request and keeps the key server-side", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return Response.json({ output_text: JSON.stringify(summaryPayload()) });
  };
  const result = await requestOpenAiLeadSummary({ apiKey: "sk-test-secret-value", facts: { isRepeatVisitor: true, isOverdue: true }, fetchImpl });
  assert.equal(captured.url, "https://api.openai.com/v1/responses");
  assert.equal(captured.options.headers.Authorization, "Bearer sk-test-secret-value");
  assert.doesNotMatch(captured.options.body, /sk-test-secret-value/u);
  assert.equal(captured.body.text.format.strict, true);
  assert.match(captured.body.input[0].content, /LEAD_FACTS/u);
  assert.equal(result.urgency, "high");
  assert.equal(result.summary, summaryPayload().summary);
});

test("requestOpenAiLeadSummary falls back to a safe urgency on an out-of-enum value", async () => {
  const fetchImpl = async () => Response.json({ output_text: JSON.stringify(summaryPayload({ urgency: "ultra-mega" })) });
  const result = await requestOpenAiLeadSummary({ apiKey: "sk-test", facts: {}, fetchImpl });
  assert.equal(result.urgency, "normal");
});

test("requestOpenAiLeadReply includes the owner's instruction in the request and never auto-sends anything", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = JSON.parse(options.body);
    return Response.json({ output_text: JSON.stringify({ draft: "Добрый день! Перезвоним вам завтра утром." }) });
  };
  const result = await requestOpenAiLeadReply({ apiKey: "sk-test", facts: { message: "Когда перезвоните?" }, instruction: "предложи перезвонить завтра утром", fetchImpl });
  assert.match(captured.input[0].content, /INSTRUCTION/u);
  assert.match(captured.input[0].content, /предложи перезвонить завтра утром/u);
  assert.equal(result.draft, "Добрый день! Перезвоним вам завтра утром.");
});

test("requestOpenAiLeadReply omits the INSTRUCTION block when none was given", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = JSON.parse(options.body);
    return Response.json({ output_text: JSON.stringify({ draft: "Спасибо за обращение!" }) });
  };
  await requestOpenAiLeadReply({ apiKey: "sk-test", facts: { message: "Привет" }, fetchImpl });
  assert.doesNotMatch(captured.input[0].content, /INSTRUCTION/u);
});

test("requestOpenAiLeadSummary and requestOpenAiLeadReply errors never expose the API key", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: "bad key sk-never-leak-this" } }), { status: 401 });
  await assert.rejects(
    requestOpenAiLeadSummary({ apiKey: "sk-never-leak-this", facts: {}, fetchImpl }),
    (error) => { assert.equal(error.message, "OPENAI_REQUEST_FAILED"); assert.doesNotMatch(String(error.stack), /sk-never-leak-this/u); return true; }
  );
  await assert.rejects(
    requestOpenAiLeadReply({ apiKey: "sk-never-leak-this", facts: {}, fetchImpl }),
    (error) => { assert.equal(error.message, "OPENAI_REQUEST_FAILED"); assert.doesNotMatch(String(error.stack), /sk-never-leak-this/u); return true; }
  );
});
