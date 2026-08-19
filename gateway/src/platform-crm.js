import { requestOpenAiLeadReply, requestOpenAiLeadSummary } from "./platform-openai.js";

// CRM Assistant: on-demand (never batch/background) AI help for one lead at
// a time - "Кратко о клиенте" and "Составить ответ". Repeat-visitor
// detection cannot be done in SQL (payload_ciphertext uses a random IV per
// row, so identical phone numbers encrypt to different ciphertext) - the
// caller decrypts a bounded window of the site's other leads and passes
// them in already plaintext; this module only compares/normalizes and
// talks to OpenAI, it never touches D1 itself.

export const OVERDUE_THRESHOLD_MINUTES = 60;

export function normalizePhoneDigits(value) {
  const digits = String(value || "").replace(/\D/gu, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

export function isOverdueLead(lead, thresholdMinutes = OVERDUE_THRESHOLD_MINUTES, now = Date.now()) {
  if (!lead || lead.status !== "new") return false;
  const receivedAt = Date.parse(lead.receivedAt || lead.received_at || "");
  if (!Number.isFinite(receivedAt)) return false;
  return (now - receivedAt) / 60000 >= thresholdMinutes;
}

export function computeLeadFacts({ lead, relatedLeads = [], thresholdMinutes = OVERDUE_THRESHOLD_MINUTES, now = Date.now() } = {}) {
  const targetPhone = normalizePhoneDigits(lead?.phone);
  const targetEmail = String(lead?.email || "").trim().toLowerCase();
  const priorMatches = (Array.isArray(relatedLeads) ? relatedLeads : []).filter((other) => {
    if (!other || other.leadId === lead?.leadId) return false;
    const otherPhone = normalizePhoneDigits(other.phone);
    const otherEmail = String(other.email || "").trim().toLowerCase();
    return (targetPhone && otherPhone && targetPhone === otherPhone) || (targetEmail && otherEmail && targetEmail === otherEmail);
  });
  const receivedAt = Date.parse(lead?.receivedAt || "");
  const overdueMinutes = lead?.status === "new" && Number.isFinite(receivedAt) ? Math.max(0, Math.round((now - receivedAt) / 60000)) : 0;
  return {
    message: String(lead?.message || ""),
    status: lead?.status || "new",
    formLabel: String(lead?.formLabel || ""),
    pageTitle: String(lead?.pageTitle || ""),
    receivedAt: lead?.receivedAt || "",
    overdueMinutes,
    isOverdue: overdueMinutes >= thresholdMinutes,
    priorContactCount: priorMatches.length,
    isRepeatVisitor: priorMatches.length > 0,
    priorContacts: priorMatches.slice(0, 5).map((match) => ({
      receivedAt: match.receivedAt || "",
      status: match.status || "new",
      message: String(match.message || "").slice(0, 200)
    }))
  };
}

export async function generateLeadSummary(env, lead, relatedLeads = [], { fetchImpl = fetch } = {}) {
  if (!env.OPENAI_API_KEY) return null;
  const facts = computeLeadFacts({ lead, relatedLeads });
  return requestOpenAiLeadSummary({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL || undefined, facts, fetchImpl });
}

export async function generateLeadReplyDraft(env, lead, instruction = "", { fetchImpl = fetch } = {}) {
  if (!env.OPENAI_API_KEY) return null;
  const facts = computeLeadFacts({ lead, relatedLeads: [] });
  return requestOpenAiLeadReply({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL || undefined, facts, instruction, fetchImpl });
}
