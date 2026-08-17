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

export const openAiInternals = Object.freeze({
  ASSISTANT_INSTRUCTIONS,
  DEFAULT_OPENAI_MODEL,
  OPENAI_RESPONSES_URL,
  RESPONSE_SCHEMA,
  boundedContext,
  responseText
});
