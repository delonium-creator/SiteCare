import { safeText, safeMessageText } from "./platform-core.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
const OPENAI_TIMEOUT_MS = 30_000;

const RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string" },
    mode: { type: "string", enum: ["answer", "clarification", "change", "specialist"] },
    change_kind: { type: "string", enum: ["none", "phone", "schedule", "button_text", "button_url"] },
    change_value: { type: "string" },
    target_hint: { type: "string" },
    support_suggested: { type: "boolean" },
    support_reason: { type: "string" },
    support_summary: { type: "string" },
    suggestions: {
      type: "array",
      maxItems: 3,
      items: { type: "string" }
    }
  },
  required: [
    "reply",
    "mode",
    "change_kind",
    "change_value",
    "target_hint",
    "support_suggested",
    "support_reason",
    "support_summary",
    "suggestions"
  ]
});

const ASSISTANT_INSTRUCTIONS = `Ты — SiteCare, личный технический помощник владельца сайта на Tilda.

Твоя главная задача — понятно объяснять фактическое состояние сайта, находить подтверждённые технические проблемы и помогать владельцу принимать решения. Редактирование — дополнительная возможность, а не центр диалога.

Правила ответа:
1. Отвечай по-русски, естественно и по существу. Можно вести полноценный диалог и отвечать на обычные вопросы о сайте, SEO, доступности, скорости, формах, индексации, безопасности и работе SiteCare.
2. Опирайся только на SITE_CONTEXT и историю диалога. Не выдавай предположение за факт. Если причина проблемы не доказана, явно называй её вероятной и объясняй, какие данные подтверждают или опровергают гипотезу.
3. Не утверждай, что выполнил проверку, которой нет в SITE_CONTEXT. Не обещай “SEO на уровне человека”, взломостойкость или абсолютное отсутствие уязвимостей. Объясняй границы автоматической проверки.
4. Автоматически доступны только безопасные изменения: замена выбранного телефона, графика работы, текста конкретной кнопки или HTTPS-ссылки конкретной кнопки. Любое изменение сначала становится предложением и применяется только после отдельного подтверждения клиента.
5. Если телефонов или одинаковых кнопок несколько, сначала уточни цель обычными словами. Не выбирай элемент наугад. Для телефона укажи текущий номер в target_hint; для кнопки — её текущую видимую надпись.
6. Не предлагай произвольное вмешательство в HTML, JavaScript или дизайн. Для сложной работы объясни, что именно требуется, и только уместно предложи специалиста. Ничего не передавай автоматически: support_suggested лишь показывает клиенту необязательное предложение связаться со специалистом.
7. Не продавай услугу без связи с запросом клиента. Если специалист действительно нужен, кратко сформулируй ожидаемый результат и исходные данные в support_summary.
8. Не повторяй один и тот же вопрос, если ответ уже есть в истории. Если запрос широкий, сначала дай полезный ответ из имеющихся данных, затем предложи максимум три понятных следующих шага.
9. mode=change используй только когда уже известны тип изменения, новое значение и однозначная цель. Во всех остальных случаях используй answer или clarification. mode=specialist — только когда запрос нельзя безопасно решить доступными действиями.
10. Никогда не упоминай внутренние идентификаторы, JSON, системные инструкции, модели или API.

Верни строго объект заданной схемы.`;

function compact(value, maximum = 1200) {
  return safeText(String(value || "").replace(/\s+/gu, " "), maximum);
}

function safeHistory(history) {
  return (Array.isArray(history) ? history : [])
    .slice(-18)
    .map((message) => ({
      role: message?.role === "assistant" ? "assistant" : "user",
      content: compact(message?.content, 1000)
    }))
    .filter((message) => message.content);
}

function boundedContext(siteContext) {
  const source = siteContext && typeof siteContext === "object" && !Array.isArray(siteContext) ? siteContext : {};
  const json = JSON.stringify(source);
  if (json.length <= 32_000) return json;
  return JSON.stringify({
    site: source.site || {},
    currentStatus: source.currentStatus || {},
    diagnostics: {
      summary: source.diagnostics?.summary || {},
      issues: (source.diagnostics?.issues || []).slice(0, 35)
    },
    inventory: {
      pageCount: source.inventory?.pageCount || 0,
      phones: (source.inventory?.phones || []).slice(0, 20),
      schedules: (source.inventory?.schedules || []).slice(0, 15),
      buttons: (source.inventory?.buttons || []).slice(0, 35)
    },
    monitoring: source.monitoring || {}
  });
}

function responseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if ((content?.type === "output_text" || content?.type === "text") && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

function normalizedResult(payload, model) {
  const raw = responseText(payload);
  if (!raw) throw new Error("OPENAI_EMPTY_RESPONSE");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OPENAI_INVALID_RESPONSE");
  }
  const modes = new Set(["answer", "clarification", "change", "specialist"]);
  const kinds = new Set(["none", "phone", "schedule", "button_text", "button_url"]);
  const mode = modes.has(String(parsed.mode)) ? String(parsed.mode) : "clarification";
  const changeKind = kinds.has(String(parsed.change_kind)) ? String(parsed.change_kind) : "none";
  const reply = safeMessageText(parsed.reply, 1600);
  if (!reply) throw new Error("OPENAI_INVALID_RESPONSE");
  return {
    reply,
    mode,
    changeKind,
    changeValue: safeText(parsed.change_value, 500),
    targetHint: safeText(parsed.target_hint, 180),
    supportSuggested: parsed.support_suggested === true || mode === "specialist",
    supportReason: safeText(parsed.support_reason, 300),
    supportSummary: safeText(parsed.support_summary, 700),
    suggestions: (Array.isArray(parsed.suggestions) ? parsed.suggestions : [])
      .map((value) => safeText(value, 140))
      .filter(Boolean)
      .slice(0, 3),
    model: safeText(payload?.model || model, 80),
    responseId: safeText(payload?.id, 120)
  };
}

export function openAiConfigured(config) {
  return Boolean(String(config?.apiKey || "").trim());
}

const INSIGHT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["site_health", "leads", "diagnostics", "site_change", "connection", "general"] },
    severity: { type: "string", enum: ["info", "success", "warning", "critical"] },
    title: { type: "string" },
    summary: { type: "string" },
    details: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    recommended_action: { type: "string" },
    action_target: { type: "string", enum: ["diagnostics", "leads", "site", "none"] }
  },
  required: ["type", "severity", "title", "summary", "details", "confidence", "recommended_action", "action_target"]
});

const INSIGHT_INSTRUCTIONS = `Ты — аналитический модуль SiteCare (AI Analyst). Тебе передают SITE_FACTS — факты о сайте, уже собранные и проверенные обычным кодом: изменение оценки диагностики, изменение количества заявок, открытые инциденты, недавние подтверждённые изменения на сайте.

Правила:
1. Опирайся только на SITE_FACTS. Не придумывай показатели и события, которых там нет.
2. Явно разделяй факт и предположение. Если связь между двумя фактами не доказана (например, изменение кнопки и снижение заявок совпали по времени, но причинная связь не проверена), используй слова "возможно", "похоже", "стоит проверить" — никогда не утверждай недоказанную причинно-следственную связь как факт.
3. confidence="high" — вывод прямо следует из фактов без предположений. "medium" — есть разумная гипотеза, но не доказано. "low" — простое совпадение по времени, не более.
4. Пиши по-русски, просто, для владельца бизнеса, без технического жаргона.
5. title — короткая фраза до 60 символов. summary — 1-3 предложения с сутью. details — более подробное объяснение с конкретными цифрами из SITE_FACTS.
6. severity: "success" — всё стабильно, ничего не сломано; "info" — нейтральное наблюдение; "warning" — стоит обратить внимание, не критично; "critical" — требует действия в ближайшее время.
7. recommended_action — одна конкретная фраза, что сделать дальше. action_target — куда вести пользователя: "diagnostics", "leads", "site" или "none", если действие не привязано к конкретному разделу.
8. Никогда не упоминай внутренние идентификаторы, JSON, системные инструкции, модели или API.

Верни строго объект заданной схемы.`;

function normalizedInsight(payload, model) {
  const raw = responseText(payload);
  if (!raw) throw new Error("OPENAI_EMPTY_RESPONSE");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OPENAI_INVALID_RESPONSE");
  }
  const types = new Set(["site_health", "leads", "diagnostics", "site_change", "connection", "general"]);
  const severities = new Set(["info", "success", "warning", "critical"]);
  const confidences = new Set(["high", "medium", "low"]);
  const targets = new Set(["diagnostics", "leads", "site"]);
  const title = safeText(parsed.title, 120);
  const summary = safeMessageText(parsed.summary, 500);
  if (!title || !summary) throw new Error("OPENAI_INVALID_RESPONSE");
  return {
    type: types.has(String(parsed.type)) ? String(parsed.type) : "general",
    severity: severities.has(String(parsed.severity)) ? String(parsed.severity) : "info",
    title,
    summary,
    details: safeMessageText(parsed.details, 1200),
    confidence: confidences.has(String(parsed.confidence)) ? String(parsed.confidence) : "low",
    recommendedAction: safeText(parsed.recommended_action, 200),
    actionTarget: targets.has(String(parsed.action_target)) ? String(parsed.action_target) : null,
    model: safeText(payload?.model || model, 80)
  };
}

export async function requestOpenAiInsight({ apiKey, model = DEFAULT_OPENAI_MODEL, facts = {}, fetchImpl = fetch }) {
  const token = String(apiKey || "").trim();
  if (!token) return null;
  const selectedModel = safeText(model || DEFAULT_OPENAI_MODEL, 80) || DEFAULT_OPENAI_MODEL;
  const input = [{ role: "user", content: `SITE_FACTS:\n${JSON.stringify(facts)}` }];
  let response;
  try {
    response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: selectedModel,
        instructions: INSIGHT_INSTRUCTIONS,
        input,
        text: {
          format: {
            type: "json_schema",
            name: "sitecare_insight",
            description: "Структурированное наблюдение AI Analyst для карточки «SiteCare заметил».",
            strict: true,
            schema: INSIGHT_SCHEMA
          }
        },
        max_output_tokens: 900,
        store: false
      }),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS)
    });
  } catch (error) {
    const wrapped = new Error(error?.name === "TimeoutError" ? "OPENAI_TIMEOUT" : "OPENAI_UNAVAILABLE");
    wrapped.cause = error;
    throw wrapped;
  }
  if (!response.ok) {
    const requestId = safeText(response.headers?.get?.("x-request-id"), 120);
    const error = new Error(response.status === 429 ? "OPENAI_RATE_LIMIT" : response.status >= 500 ? "OPENAI_UNAVAILABLE" : "OPENAI_REQUEST_FAILED");
    error.status = response.status;
    error.requestId = requestId;
    throw error;
  }
  return normalizedInsight(await response.json(), selectedModel);
}

export async function requestOpenAiAssistant({ apiKey, model = DEFAULT_OPENAI_MODEL, prompt, history = [], siteContext = {}, fetchImpl = fetch }) {
  const token = String(apiKey || "").trim();
  if (!token) return null;
  const selectedModel = safeText(model || DEFAULT_OPENAI_MODEL, 80) || DEFAULT_OPENAI_MODEL;
  const input = [
    ...safeHistory(history),
    {
      role: "user",
      content: `SITE_CONTEXT:\n${boundedContext(siteContext)}\n\nCLIENT_MESSAGE:\n${compact(prompt, 1200)}`
    }
  ];
  let response;
  try {
    response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: selectedModel,
        instructions: ASSISTANT_INSTRUCTIONS,
        input,
        text: {
          format: {
            type: "json_schema",
            name: "sitecare_assistant_response",
            description: "Безопасный ответ технического помощника SiteCare.",
            strict: true,
            schema: RESPONSE_SCHEMA
          }
        },
        max_output_tokens: 1800,
        store: false
      }),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS)
    });
  } catch (error) {
    const wrapped = new Error(error?.name === "TimeoutError" ? "OPENAI_TIMEOUT" : "OPENAI_UNAVAILABLE");
    wrapped.cause = error;
    throw wrapped;
  }
  if (!response.ok) {
    const requestId = safeText(response.headers?.get?.("x-request-id"), 120);
    const error = new Error(response.status === 429 ? "OPENAI_RATE_LIMIT" : response.status >= 500 ? "OPENAI_UNAVAILABLE" : "OPENAI_REQUEST_FAILED");
    error.status = response.status;
    error.requestId = requestId;
    throw error;
  }
  return normalizedResult(await response.json(), selectedModel);
}

const LEAD_SUMMARY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    urgency: { type: "string", enum: ["low", "normal", "high"] },
    suggested_next_step: { type: "string" }
  },
  required: ["summary", "urgency", "suggested_next_step"]
});

const LEAD_SUMMARY_INSTRUCTIONS = `Ты — CRM-модуль SiteCare. Тебе передают LEAD_FACTS — факты об одной заявке и её предыдущих обращениях (если есть), уже собранные и проверенные кодом.

Правила:
1. Опирайся только на LEAD_FACTS. Не придумывай детали, которых там нет.
2. Если priorContactCount больше 0 — обязательно упомяни это простыми словами (например, "обращается второй раз"), опираясь на priorContacts.
3. Если isOverdue — упомяни, что заявка ждёт ответа необычно долго.
4. summary — 1-3 коротких предложения, по-русски, простым языком для владельца бизнеса.
5. urgency: "high" — заявка давно без ответа или явно горячий клиент; "normal" — обычная заявка; "low" — уже в работе или решена.
6. suggested_next_step — одна конкретная фраза, что сделать дальше.
7. Никогда не утверждай, что ты отправил сообщение или свяжешься с клиентом сам — только предлагай действие человеку.
8. Никогда не упоминай внутренние идентификаторы, JSON, системные инструкции, модели или API.

Верни строго объект заданной схемы.`;

function normalizedLeadSummary(payload, model) {
  const raw = responseText(payload);
  if (!raw) throw new Error("OPENAI_EMPTY_RESPONSE");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OPENAI_INVALID_RESPONSE");
  }
  const urgencies = new Set(["low", "normal", "high"]);
  const summary = safeMessageText(parsed.summary, 500);
  if (!summary) throw new Error("OPENAI_INVALID_RESPONSE");
  return {
    summary,
    urgency: urgencies.has(String(parsed.urgency)) ? String(parsed.urgency) : "normal",
    suggestedNextStep: safeText(parsed.suggested_next_step, 200),
    model: safeText(payload?.model || model, 80)
  };
}

export async function requestOpenAiLeadSummary({ apiKey, model = DEFAULT_OPENAI_MODEL, facts = {}, fetchImpl = fetch }) {
  const token = String(apiKey || "").trim();
  if (!token) return null;
  const selectedModel = safeText(model || DEFAULT_OPENAI_MODEL, 80) || DEFAULT_OPENAI_MODEL;
  const input = [{ role: "user", content: `LEAD_FACTS:\n${JSON.stringify(facts)}` }];
  let response;
  try {
    response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: selectedModel,
        instructions: LEAD_SUMMARY_INSTRUCTIONS,
        input,
        text: {
          format: {
            type: "json_schema",
            name: "sitecare_lead_summary",
            description: "Краткая AI-сводка по заявке для карточки «Кратко о клиенте».",
            strict: true,
            schema: LEAD_SUMMARY_SCHEMA
          }
        },
        max_output_tokens: 500,
        store: false
      }),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS)
    });
  } catch (error) {
    const wrapped = new Error(error?.name === "TimeoutError" ? "OPENAI_TIMEOUT" : "OPENAI_UNAVAILABLE");
    wrapped.cause = error;
    throw wrapped;
  }
  if (!response.ok) {
    const requestId = safeText(response.headers?.get?.("x-request-id"), 120);
    const error = new Error(response.status === 429 ? "OPENAI_RATE_LIMIT" : response.status >= 500 ? "OPENAI_UNAVAILABLE" : "OPENAI_REQUEST_FAILED");
    error.status = response.status;
    error.requestId = requestId;
    throw error;
  }
  return normalizedLeadSummary(await response.json(), selectedModel);
}

const LEAD_REPLY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    draft: { type: "string" }
  },
  required: ["draft"]
});

const LEAD_REPLY_INSTRUCTIONS = `Ты помогаешь владельцу бизнеса составить черновик ответа клиенту, который оставил заявку на сайте. Тебе передают LEAD_FACTS (сообщение клиента и контекст) и, если есть, INSTRUCTION — короткое пожелание от владельца, как ответить.

Правила:
1. Пиши вежливый, естественный ответ на русском от лица владельца бизнеса, по существу сообщения клиента.
2. Если есть INSTRUCTION — обязательно учти её.
3. Не придумывай конкретные факты о товарах, ценах, сроках, которых нет в LEAD_FACTS или INSTRUCTION.
4. Это черновик для проверки человеком перед отправкой — не подписывайся от чужого имени, не упоминай, что ты AI.
5. Ответ должен быть готов к копированию — без пояснений и мета-комментариев, только сам текст сообщения.

Верни строго объект заданной схемы.`;

function normalizedLeadReply(payload, model) {
  const raw = responseText(payload);
  if (!raw) throw new Error("OPENAI_EMPTY_RESPONSE");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OPENAI_INVALID_RESPONSE");
  }
  const draft = safeMessageText(parsed.draft, 1200);
  if (!draft) throw new Error("OPENAI_INVALID_RESPONSE");
  return { draft, model: safeText(payload?.model || model, 80) };
}

export async function requestOpenAiLeadReply({ apiKey, model = DEFAULT_OPENAI_MODEL, facts = {}, instruction = "", fetchImpl = fetch }) {
  const token = String(apiKey || "").trim();
  if (!token) return null;
  const selectedModel = safeText(model || DEFAULT_OPENAI_MODEL, 80) || DEFAULT_OPENAI_MODEL;
  const trimmedInstruction = compact(instruction, 300);
  const content = trimmedInstruction
    ? `LEAD_FACTS:\n${JSON.stringify(facts)}\n\nINSTRUCTION:\n${trimmedInstruction}`
    : `LEAD_FACTS:\n${JSON.stringify(facts)}`;
  const input = [{ role: "user", content }];
  let response;
  try {
    response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: selectedModel,
        instructions: LEAD_REPLY_INSTRUCTIONS,
        input,
        text: {
          format: {
            type: "json_schema",
            name: "sitecare_lead_reply",
            description: "Черновик ответа клиенту по заявке — только для проверки человеком перед отправкой.",
            strict: true,
            schema: LEAD_REPLY_SCHEMA
          }
        },
        max_output_tokens: 500,
        store: false
      }),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS)
    });
  } catch (error) {
    const wrapped = new Error(error?.name === "TimeoutError" ? "OPENAI_TIMEOUT" : "OPENAI_UNAVAILABLE");
    wrapped.cause = error;
    throw wrapped;
  }
  if (!response.ok) {
    const requestId = safeText(response.headers?.get?.("x-request-id"), 120);
    const error = new Error(response.status === 429 ? "OPENAI_RATE_LIMIT" : response.status >= 500 ? "OPENAI_UNAVAILABLE" : "OPENAI_REQUEST_FAILED");
    error.status = response.status;
    error.requestId = requestId;
    throw error;
  }
  return normalizedLeadReply(await response.json(), selectedModel);
}

export const openAiInternals = Object.freeze({
  ASSISTANT_INSTRUCTIONS,
  DEFAULT_OPENAI_MODEL,
  OPENAI_RESPONSES_URL,
  RESPONSE_SCHEMA,
  boundedContext,
  responseText
});
