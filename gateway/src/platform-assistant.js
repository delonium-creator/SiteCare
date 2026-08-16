import { safeText } from "./platform-core.js";
import { requestOpenAiAssistant } from "./platform-openai.js";

const MAX_PROMPT = 1200;
const AI_MODELS = ["@cf/zai-org/glm-4.7-flash", "@cf/google/gemma-4-26b-a4b-it"];
const KINDS = new Set(["phone", "schedule", "button_text", "button_url", "advice", "unknown"]);

function compact(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function digits(value) {
  return String(value || "").replace(/\D/gu, "");
}

export function normalizeChangePrompt(value) {
  const prompt = compact(value);
  if (!prompt) throw new Error("Опишите, что хотите изменить.");
  if (prompt.length > MAX_PROMPT) throw new Error("Описание слишком длинное. Оставьте одну правку в одном сообщении.");
  return prompt;
}

function quotedValues(message) {
  return [...message.matchAll(/[«"]([^»"]{1,180})[»"]/gu)].map((match) => compact(match[1]));
}

function phoneValues(message) {
  return (message.match(/\+?\d[\d ()\u00a0.–—-]{5,}\d/gu) || [])
    .map((candidate) => candidate.trim())
    .filter((candidate) => {
      const value = digits(candidate);
      return value.length >= 7 && value.length <= 15;
    });
}

function phoneValue(message) {
  return phoneValues(message)[0] || "";
}

function absoluteUrl(message) {
  const value = /https:\/\/[^\s<>{}\[\]"'»]+/iu.exec(message)?.[0] || "";
  return value.replace(/[.,!?;:)]+$/gu, "");
}

function scheduleValue(message) {
  const after = /(?:график(?:\s+работы)?|режим(?:\s+работы)?|время(?:\s+работы)?|работаем)\s*(?:будет|сделай|замени|измени)?\s*(?:на|:|—|-)?\s*(.+)$/iu.exec(message)?.[1];
  const candidate = compact(after || "");
  if (candidate && /\d{1,2}(?::|\.)\d{2}/u.test(candidate)) return candidate;
  const direct = /(?:пн|вт|ср|чт|пт|сб|вс|ежедневно|будн)[^.!?]{0,90}\d{1,2}(?::|\.)\d{2}(?:\s*[–—-]\s*\d{1,2}(?::|\.)\d{2})?/iu.exec(message)?.[0];
  return compact(direct || "");
}

function buttonTargetHint(message, value = "") {
  const quotes = quotedValues(message);
  if (quotes.length > 1) return quotes[0];
  if (quotes.length === 1 && (!value || quotes[0] !== value)) return quotes[0];
  const before = message.split(/\s+на\s+/iu).slice(0, -1).join(" на ") || message;
  const hint = /кнопк\S*\s+(?:с\s+(?:текстом|надписью)\s+)?(.+)$/iu.exec(before)?.[1] || "";
  const cleaned = compact(hint).replace(/[«»".!?]+/gu, "");
  if (!cleaned || /^(?:поменять|изменить|заменить|редактировать|на сайте)$/iu.test(cleaned)) return "";
  return cleaned !== value ? cleaned.slice(0, 120) : "";
}

function buttonTextValue(message) {
  const quotes = quotedValues(message);
  if (quotes.length > 1) return quotes.at(-1);
  const parts = message.split(/\s+на\s+/iu);
  if (parts.length > 1) return compact(parts.at(-1)).replace(/[.!?]+$/gu, "").slice(0, 180);
  const assignment = /(?:текст|надпис[ьи]|название)\s+кнопк\S*\s*(?:будет|:|—|-)\s*(.+)$/iu.exec(message)?.[1] || "";
  return compact(assignment).replace(/[.!?]+$/gu, "").slice(0, 180);
}

export function parseLocalChange(rawPrompt) {
  const prompt = normalizeChangePrompt(rawPrompt);
  const hasPhone = /телефон|номер|позвон|контакт/iu.test(prompt);
  const hasSchedule = /график|режим\s+работы|время\s+работы|работаем|расписан/iu.test(prompt);
  const hasButton = /кнопк|cta|призыв/iu.test(prompt);
  const hasLink = /ссылк|адрес|вед[её]т|переход/iu.test(prompt);
  const intents = [hasPhone, hasSchedule, hasButton || hasLink].filter(Boolean).length;
  if (intents > 1) return { kind: "unknown", value: "", targetHint: "", message: "Давайте сделаем по одной правке. Что меняем сначала?" };
  if (hasPhone) {
    const values = phoneValues(prompt);
    return values.length
      ? { kind: "phone", value: values.at(-1), targetHint: values.length > 1 ? values[0] : "", message: `Подготовил замену телефона на ${values.at(-1)}.` }
      : { kind: "unknown", value: "", targetHint: "", message: "Какой телефон на сайте вы хотите изменить?" };
  }
  if (hasSchedule) {
    const value = scheduleValue(prompt);
    return value
      ? { kind: "schedule", value, targetHint: "", message: `Подготовил новый график: ${value}.` }
      : { kind: "unknown", value: "", targetHint: "", message: "Какой график должен быть? Укажите дни и время." };
  }
  if ((hasButton || hasLink) && (hasLink || absoluteUrl(prompt))) {
    const value = absoluteUrl(prompt);
    return value
      ? { kind: "button_url", value, targetHint: buttonTargetHint(prompt, value), message: "Проверьте новую ссылку перед применением." }
      : { kind: "unknown", value: "", targetHint: buttonTargetHint(prompt), message: "Какую ссылку поставить? Нужен полный адрес, начинающийся с https://." };
  }
  if (hasButton) {
    const value = buttonTextValue(prompt);
    const targetHint = buttonTargetHint(prompt, value);
    return value
      ? { kind: "button_text", value, targetHint, message: "Проверьте новый текст перед применением." }
      : { kind: "unknown", value: "", targetHint, message: targetHint ? `Что изменить у кнопки «${targetHint}»: текст или ссылку?` : "Какую кнопку вы хотите изменить?" };
  }
  return null;
}

function normalizedWords(value) {
  return new Set(compact(value).toLocaleLowerCase("ru-RU").match(/[а-яёa-z0-9]{2,}/giu) || []);
}

export function rankButtonCandidates(candidates, targetHint = "") {
  const hint = compact(targetHint);
  if (!hint) return [];
  const normalizedHint = hint.toLocaleLowerCase("ru-RU");
  const hintWords = normalizedWords(hint);
  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => {
      const text = compact(candidate.text).toLocaleLowerCase("ru-RU");
      const haystack = `${candidate.text || ""} ${candidate.url || ""} ${candidate.pageTitle || ""}`.toLocaleLowerCase("ru-RU");
      let score = 0;
      if (text === normalizedHint) score += 30;
      else if (haystack.includes(normalizedHint)) score += 12;
      for (const word of hintWords) if (haystack.includes(word)) score += 2;
      if (candidate.text) score += 0.5;
      return { ...candidate, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.pagePath.localeCompare(right.pagePath) || left.matchIndex - right.matchIndex)
    .slice(0, 6);
}

function assistantResult({ type = "clarification", kind = "unknown", value = "", targetHint = "", targetPhone = "", message, dialog = null, candidates = [], selectedCandidateId = "", scope = "element", allowAll = false, supportSuggested = false, supportReason = "", supportSummary = "", suggestions = [], usedAi = false, model = "local" }) {
  return {
    type,
    kind,
    value,
    targetHint,
    targetPhone,
    message,
    dialog,
    needsTarget: false,
    suggestedCandidateId: selectedCandidateId,
    candidates,
    scope,
    allowAll,
    usedAi,
    model,
    assistantMode: usedAi ? "ai" : "local",
    supportSuggested,
    supportReason,
    supportSummary,
    suggestions: (Array.isArray(suggestions) ? suggestions : []).slice(0, 3)
  };
}

function lastDialog(history) {
  const row = [...(Array.isArray(history) ? history : [])].reverse().find((item) => item?.role === "assistant");
  const dialog = row?.metadata?.dialog;
  return dialog && typeof dialog === "object" && !Array.isArray(dialog) ? dialog : null;
}

function ordinalIndex(prompt) {
  const lower = prompt.toLocaleLowerCase("ru-RU");
  const words = [[/(?:^|\s)(?:перв(?:ый|ую|ая)|1)(?:\s|$)/u, 0], [/(?:^|\s)(?:втор(?:ой|ую|ая)|2)(?:\s|$)/u, 1], [/(?:^|\s)(?:трет(?:ий|ью|ья)|3)(?:\s|$)/u, 2], [/(?:^|\s)(?:четв[её]рт(?:ый|ую|ая)|4)(?:\s|$)/u, 3], [/(?:^|\s)(?:пят(?:ый|ую|ая)|5)(?:\s|$)/u, 4]];
  for (const [pattern, index] of words) if (pattern.test(lower)) return index;
  return -1;
}

function inventoryPhoneCandidates(inventory) {
  const precise = Array.isArray(inventory?.phoneCandidates) ? inventory.phoneCandidates.filter((item) => item?.candidateId && digits(item.phone).length >= 10) : [];
  if (precise.length) return precise;
  return (Array.isArray(inventory?.phones) ? inventory.phones : []).map((phone, index) => ({
    candidateId: `legacy_phone_${index}`,
    phone,
    originalDigits: digits(phone),
    pageTitle: "Сайт",
    pagePath: "/",
    sectionLabel: "Найденный телефон",
    locationLabel: "Найденный телефон",
    context: ""
  }));
}

function phoneGroups(inventory) {
  const groups = new Map();
  for (const candidate of inventoryPhoneCandidates(inventory)) {
    const key = digits(candidate.phone);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { phone: candidate.phone, digits: key, candidates: [] });
    groups.get(key).candidates.push(candidate);
  }
  return [...groups.values()];
}

function choosePhoneGroup(prompt, groups) {
  const index = ordinalIndex(prompt);
  if (index >= 0 && groups[index]) return groups[index];
  const values = phoneValues(prompt).map(digits);
  return groups.find((group) => values.includes(group.digits) || values.some((value) => value && group.digits.includes(value))) || null;
}

function choosePhoneLocation(prompt, candidates) {
  const index = ordinalIndex(prompt);
  if (index >= 0 && candidates[index]) return candidates[index];
  const lower = compact(prompt).toLocaleLowerCase("ru-RU");
  const matches = candidates.filter((candidate) => [candidate.pageTitle, candidate.pagePath, candidate.sectionLabel, candidate.locationLabel]
    .map((value) => compact(value).toLocaleLowerCase("ru-RU"))
    .some((value) => value && lower.includes(value)));
  return matches.length === 1 ? matches[0] : null;
}

function phoneChange(group, candidate, value, scope = "element") {
  const selected = candidate || group.candidates[0];
  const occurrences = Math.max(1, Number(group.candidates?.length) || 1);
  const place = scope === "site"
    ? `во всех найденных местах сайта (${occurrences})`
    : selected?.locationLabel || selected?.sectionLabel || selected?.pageTitle || "в выбранном месте";
  return assistantResult({
    type: "change",
    kind: "phone",
    value,
    targetPhone: group.phone,
    targetHint: group.phone,
    message: `Заменить ${group.phone} на ${value} ${place}?`,
    candidates: selected ? [selected] : [],
    selectedCandidateId: selected?.candidateId || "",
    scope
  });
}

export function phoneValueQuestion(group, candidate, scope = "element") {
  const place = scope === "site" ? "во всех местах сайта" : candidate?.locationLabel || candidate?.sectionLabel || candidate?.pageTitle || "в выбранном месте";
  return assistantResult({
    message: `На какой новый номер заменить ${group.phone} ${place}?`,
    targetPhone: group.phone,
    candidates: candidate ? [candidate] : [],
    selectedCandidateId: candidate?.candidateId || "",
    scope,
    dialog: { intent: "phone", stage: "value", targetPhone: group.phone, candidateId: candidate?.candidateId || "", scope }
  });
}

function phoneLocationQuestion(group, pendingValue = "") {
  // A phone is a single business setting. Asking a non-technical client to
  // choose every header, footer and mobile duplicate makes the task harder and
  // leaves old numbers behind. SiteCare therefore replaces the selected number
  // everywhere on the connected site by default.
  const candidate = group.candidates[0];
  return pendingValue
    ? phoneChange(group, candidate, pendingValue, "site")
    : phoneValueQuestion(group, candidate, "site");
}

function phoneQuestion(inventory, pendingValue = "") {
  const groups = phoneGroups(inventory);
  if (!groups.length) return assistantResult({ message: "Напишите текущий телефон, который нужно найти на сайте.", dialog: { intent: "phone", stage: "target", pendingValue } });
  if (groups.length === 1) return phoneLocationQuestion(groups[0], pendingValue);
  return assistantResult({
    message: "Какой телефон вы хотите изменить?",
    candidates: groups.slice(0, 8).map((group) => ({ ...group.candidates[0], occurrenceCount: group.candidates.length })),
    dialog: { intent: "phone", stage: "target", pendingValue }
  });
}

function plausibleButtons(inventory, hint) {
  const ranked = rankButtonCandidates(inventory?.candidates, hint);
  if (ranked.length < 2) return ranked;
  const exact = ranked.filter((candidate) => compact(candidate.text).toLocaleLowerCase("ru-RU") === compact(hint).toLocaleLowerCase("ru-RU"));
  if (exact.length) return exact;
  return ranked.filter((candidate) => candidate.score >= ranked[0].score - 1);
}

function buttonDescription(candidate) {
  const place = candidate.locationLabel || candidate.sectionLabel || candidate.pageTitle || candidate.pagePath || "сайт";
  return `«${candidate.text || "кнопка без текста"}» — ${place}, страница «${candidate.pageTitle || candidate.pagePath || "сайт"}»`;
}

function chooseButton(prompt, inventory, targetHint) {
  const options = plausibleButtons(inventory, targetHint);
  const index = ordinalIndex(prompt);
  if (index >= 0 && options[index]) return options[index];
  const lower = prompt.toLocaleLowerCase("ru-RU");
  const byPage = options.filter((candidate) => lower.includes(compact(candidate.pageTitle).toLocaleLowerCase("ru-RU")) || lower.includes(compact(candidate.pagePath).toLocaleLowerCase("ru-RU")));
  return byPage.length === 1 ? byPage[0] : options.length === 1 ? options[0] : null;
}

function askButtonTarget() {
  return assistantResult({ message: "Какую кнопку вы хотите изменить? Напишите её текущий текст — например, «Записаться».", dialog: { intent: "button", stage: "target" } });
}

function resolveButtonTarget(targetHint, inventory, pending = {}) {
  const options = plausibleButtons(inventory, targetHint);
  if (!options.length) return assistantResult({ targetHint, message: `На опубликованном сайте не нашлась кнопка «${targetHint}». Напишите её текущий текст точнее.`, dialog: { intent: "button", stage: "target", attempts: 1 } });
  if (options.length > 1) {
    return assistantResult({ targetHint, message: "Нашёл несколько таких кнопок. Выберите нужное место:", candidates: options, dialog: { intent: "button", stage: "candidate", targetHint, kind: pending.kind || "", pendingValue: pending.value || "" } });
  }
  const candidate = options[0];
  if (pending.kind && pending.value) return assistantResult({ type: "change", kind: pending.kind, value: pending.value, targetHint, message: `Изменить ${buttonDescription(candidate)}?`, candidates: [candidate], selectedCandidateId: candidate.candidateId });
  return assistantResult({ targetHint, message: `Нашёл ${buttonDescription(candidate)}. Что изменить: текст или ссылку?`, dialog: { intent: "button", stage: "attribute", targetHint, candidateId: candidate.candidateId } });
}

function buttonValueQuestion(kind, targetHint, candidateId) {
  return assistantResult({ targetHint, message: kind === "button_url" ? `Какую новую ссылку поставить для кнопки «${targetHint}»?` : `Какой новый текст поставить на кнопку «${targetHint}»?`, dialog: { intent: "button", stage: "value", targetHint, candidateId, kind } });
}

function continueDialog(prompt, inventory, dialog) {
  if (!dialog) return null;
  if (dialog.intent === "phone") {
    const groups = phoneGroups(inventory);
    if (dialog.stage === "target") {
      const group = choosePhoneGroup(prompt, groups);
      // An unparsed reply here almost always means the client moved on to a
      // different question rather than mistyped a phone selection -- forcing
      // the same clarification back at them is how the assistant gets stuck.
      // Falling through (null) lets the fresh-request pipeline answer what
      // was actually asked instead.
      if (!group) return null;
      return phoneLocationQuestion(group, dialog.pendingValue || "");
    }
    if (dialog.stage === "location") {
      const group = groups.find((item) => item.digits === digits(dialog.targetPhone));
      if (!group) return null;
      return dialog.pendingValue
        ? phoneChange(group, group.candidates[0], dialog.pendingValue, "site")
        : phoneValueQuestion(group, group.candidates[0], "site");
    }
    if (dialog.stage === "value") {
      const value = phoneValue(prompt);
      if (!value) return null;
      const group = groups.find((item) => item.digits === digits(dialog.targetPhone)) || { phone: dialog.targetPhone, candidates: [] };
      const matched = group.candidates.find((item) => item.candidateId === dialog.candidateId);
      const candidate = matched || group.candidates[0];
      // A precisely selected location (e.g. clicked on the live site) keeps its
      // exact scope; if the original candidate can no longer be matched (the
      // page changed), fall back to the safe site-wide replacement.
      return phoneChange(group, candidate, value, matched ? (dialog.scope || "element") : "site");
    }
  }
  if (dialog.intent === "button") {
    if (dialog.stage === "target") {
      const reply = compact(prompt).replace(/^кнопк\S*\s+/iu, "");
      const targetHint = buttonTargetHint(`кнопка ${reply}`) || reply.replace(/[«»".!?]+/gu, "");
      return targetHint ? resolveButtonTarget(targetHint, inventory) : askButtonTarget();
    }
    if (dialog.stage === "candidate") {
      const candidate = chooseButton(prompt, inventory, dialog.targetHint);
      if (!candidate) return resolveButtonTarget(dialog.targetHint, inventory, { kind: dialog.kind, value: dialog.pendingValue });
      if (dialog.kind && dialog.pendingValue) return assistantResult({ type: "change", kind: dialog.kind, value: dialog.pendingValue, targetHint: dialog.targetHint, message: `Изменить ${buttonDescription(candidate)}?`, candidates: [candidate], selectedCandidateId: candidate.candidateId });
      return assistantResult({ message: `Выбрана ${buttonDescription(candidate)}. Что изменить: текст или ссылку?`, targetHint: dialog.targetHint, dialog: { intent: "button", stage: "attribute", targetHint: dialog.targetHint, candidateId: candidate.candidateId } });
    }
    if (dialog.stage === "attribute") {
      const wantsUrl = /ссылк|адрес|переход|куда\s+вед/iu.test(prompt);
      const wantsText = /текст|надпис|назван|слово/iu.test(prompt);
      if (!wantsUrl && !wantsText) return null;
      return buttonValueQuestion(wantsUrl ? "button_url" : "button_text", dialog.targetHint, dialog.candidateId);
    }
    if (dialog.stage === "value") {
      const candidate = (inventory?.candidates || []).find((item) => item.candidateId === dialog.candidateId);
      if (!candidate) return null;
      const value = dialog.kind === "button_url" ? absoluteUrl(prompt) : compact(prompt).replace(/^(?:поставь|замени|измени)(?:\s+на)?\s+/iu, "").replace(/[«»"]+/gu, "").slice(0, 180);
      if (!value) return null;
      return assistantResult({ type: "change", kind: dialog.kind, value, targetHint: dialog.targetHint, message: `Изменить ${buttonDescription(candidate)}?`, candidates: [candidate], selectedCandidateId: candidate.candidateId });
    }
  }
  return null;
}

function aiPayload(raw) {
  if (raw?.response && typeof raw.response === "object") return raw.response;
  const value = raw?.response ?? raw?.result?.response ?? raw?.choices?.[0]?.message?.content ?? raw;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const text = String(value || "").replace(/```(?:json)?/giu, "").replace(/<think>[\s\S]*?<\/think>/giu, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI_FORMAT");
  return JSON.parse(text.slice(start, end + 1));
}

function normalizeAiProposal(raw) {
  const payload = aiPayload(raw);
  const kind = String(payload.kind || "unknown");
  if (!KINDS.has(kind)) throw new Error("AI_KIND");
  return { kind, value: safeText(payload.value, 500), targetHint: safeText(payload.targetHint, 180), message: safeText(payload.message || "Уточните, пожалуйста, что нужно изменить.", 700), supportSuggested: payload.supportSuggested === true, supportReason: safeText(payload.supportReason, 300) };
}

function conversationContext(history) {
  return (Array.isArray(history) ? history : []).slice(-16).map((item) => ({ role: item?.role === "assistant" ? "assistant" : "user", content: safeText(item?.content, 700) })).filter((item) => item.content);
}

function localConversation(prompt, inventory) {
  if (/^(?:отмена|отмени|начн[её]м заново|забудь|другая задача)$/iu.test(prompt)) return assistantResult({ type: "advice", kind: "advice", message: "Хорошо, предыдущую задачу отменил. Что хотите изменить?" });
  if (/^(?:привет|здравствуй|добрый\s+(?:день|вечер|утро)|hello)\b/iu.test(prompt)) return assistantResult({ type: "advice", kind: "advice", message: "Здравствуйте! Опишите желаемый результат обычными словами. Я сам найду нужный элемент, задам недостающие вопросы и покажу изменение перед применением." });
  if (/(?:что\s+ты\s+(?:умеешь|можешь(?:\s+сделать)?)|как\s+это\s+работает|чем\s+поможешь)/iu.test(prompt)) return assistantResult({ type: "advice", kind: "advice", message: "Я могу изменить конкретный телефон, график работы, текст или ссылку кнопки. Сначала найду элемент на опубликованном сайте, затем уточню детали и попрошу одно подтверждение." });
  if (/(?:сколько|какие|найд|покаж).*(?:кноп|страниц|телефон)/iu.test(prompt)) {
    const pages = Number(inventory?.pageCount || 0), buttons = Number(inventory?.candidates?.length || 0), phones = Number(inventory?.phones?.length || 0);
    return assistantResult({ type: "advice", kind: "advice", message: `На опубликованном сайте вижу страниц: ${pages}, кнопок: ${buttons}, телефонов: ${phones}. Напишите, какой элемент хотите изменить.` });
  }
  return null;
}

function explicitDialogIntent(prompt) {
  const phone = /телефон|номер|позвон|контакт/iu.test(prompt);
  const button = /кнопк|cta|призыв|ссылк|куда\s+вед/iu.test(prompt);
  const schedule = /график|режим\s+работы|время\s+работы|работаем|расписан/iu.test(prompt);
  if ([phone, button, schedule].filter(Boolean).length !== 1) return "";
  return phone ? "phone" : button ? "button" : "schedule";
}

function explicitEditRequest(prompt) {
  return /(?:^|[.!?]\s*|(?:хочу|нужно|надо|можешь)\s+)(?:заменить|изменить|поменять|исправить|обновить|поставить|скрыть|убрать|удалить|отредактировать)(?:\s|$|[,.!?])/iu.test(prompt) ||
    /(?:^|[.!?]\s*)(?:замени|измени|поменяй|исправь|обнови|поставь|скрой|убери|удали|отредактируй|сделай)(?:\s|$|[,.!?])/iu.test(prompt) ||
    /^(?:телефон|номер|график|кнопка)(?:\s|$)/iu.test(prompt);
}

async function askAi(ai, prompt, inventory, history = []) {
  if (!ai || typeof ai.run !== "function") return null;
  const buttonContext = (inventory?.candidates || []).slice(0, 40).map((item) => ({ text: item.text, url: item.url, page: item.pagePath }));
  const messages = [{ role: "system", content: `Ты полноценный AI-помощник SiteCare для владельца сайта. Пойми смысл сообщения и отвечай коротко, ясно и по-русски. Можно отвечать на любые вопросы о сайте, объяснять найденные элементы и предлагать улучшения — для этого используй kind=advice. Автоматически доступны только четыре безопасных действия: заменить выбранный телефон сразу во всех местах сайта, изменить график, текст или HTTPS-ссылку конкретной кнопки. Не выдумывай элементы и не обещай недоступное: используй данные опубликованного сайта. Если не хватает ровно одного значения, задай один естественный вопрос. Если нужна сложная правка кода, дизайна или остаётся неоднозначность, объясни это и предложи специалиста: supportSuggested=true. Верни только JSON {"kind":"phone|schedule|button_text|button_url|advice|unknown","value":"новое значение","targetHint":"текущий элемент","message":"ответ или вопрос","supportSuggested":false,"supportReason":""}. Никогда не утверждай, что изменение уже применено. Сайт: ${JSON.stringify({ pages: inventory?.pageCount || 0, phones: inventory?.phones || [], schedules: inventory?.schedules || [], buttons: buttonContext })}` }, ...conversationContext(history), { role: "user", content: prompt }];
  for (const model of AI_MODELS) {
    try {
      const raw = await ai.run(model, { messages, max_completion_tokens: 450, temperature: 0.1, top_p: 0.8 });
      return { ...normalizeAiProposal(raw), model };
    } catch {
      // Try the second configured model before offering a specialist.
    }
  }
  return null;
}

function initialLocalFlow(prompt, inventory) {
  const hasPhone = /телефон|номер|позвон|контакт/iu.test(prompt);
  const hasButton = /кнопк|cta|призыв/iu.test(prompt);
  if (hasPhone) {
    const values = phoneValues(prompt), groups = phoneGroups(inventory);
    if (values.length >= 2) {
      const group = choosePhoneGroup(values[0], groups);
      if (group) return phoneLocationQuestion(group, values.at(-1));
    }
    return phoneQuestion(inventory, values[0] || "");
  }
  if (hasButton) {
    const parsed = parseLocalChange(prompt), targetHint = parsed?.targetHint || buttonTargetHint(prompt);
    if (!targetHint) return askButtonTarget();
    if (parsed?.kind?.startsWith("button_") && parsed.value) return resolveButtonTarget(targetHint, inventory, { kind: parsed.kind, value: parsed.value });
    return resolveButtonTarget(targetHint, inventory);
  }
  return null;
}

function finalizeProposal(proposal, inventory, usedAi = false, model = "local") {
  if (!proposal) return null;
  if (proposal.type) return { ...proposal, usedAi, model, assistantMode: usedAi ? "ai" : proposal.assistantMode || "local" };
  if (proposal.kind === "phone") {
    const groups = phoneGroups(inventory), selected = proposal.targetHint ? choosePhoneGroup(proposal.targetHint, groups) : groups.length === 1 ? groups[0] : null;
    if (!selected) return { ...phoneQuestion(inventory, proposal.value), usedAi, model, assistantMode: usedAi ? "ai" : "local" };
    return { ...phoneLocationQuestion(selected, proposal.value), usedAi, model, assistantMode: usedAi ? "ai" : "local" };
  }
  if (proposal.kind.startsWith("button_")) {
    if (!proposal.targetHint) return { ...askButtonTarget(), usedAi, model, assistantMode: usedAi ? "ai" : "local" };
    return { ...resolveButtonTarget(proposal.targetHint, inventory, { kind: proposal.kind, value: proposal.value }), usedAi, model, assistantMode: usedAi ? "ai" : "local" };
  }
  return assistantResult({ type: proposal.kind === "unknown" ? "clarification" : proposal.kind === "advice" ? "advice" : "change", ...proposal, usedAi, model });
}

function fromOpenAi(proposal) {
  if (!proposal) return null;
  const common = {
    message: proposal.reply,
    supportSuggested: proposal.supportSuggested,
    supportReason: proposal.supportReason,
    supportSummary: proposal.supportSummary,
    suggestions: proposal.suggestions,
    usedAi: true,
    model: proposal.model
  };
  if (proposal.mode === "change" && proposal.changeKind !== "none") {
    return {
      kind: proposal.changeKind,
      value: proposal.changeValue,
      targetHint: proposal.targetHint,
      ...common
    };
  }
  return assistantResult({
    type: proposal.mode === "clarification" ? "clarification" : "advice",
    kind: "advice",
    targetHint: proposal.targetHint,
    ...common
  });
}

export async function prepareSiteChange({ prompt: rawPrompt, inventory, ai, openAi = null, history = [], siteContext = {}, fetchImpl = fetch }) {
  const prompt = normalizeChangePrompt(rawPrompt);
  const dialog = lastDialog(history);
  const explicitIntent = explicitDialogIntent(prompt);
  const continued = dialog && (!explicitIntent || explicitIntent === dialog.intent) ? continueDialog(prompt, inventory, dialog) : null;
  if (continued) return continued;
  if (explicitEditRequest(prompt)) {
    const localFlow = initialLocalFlow(prompt, inventory);
    if (localFlow) return localFlow;
    const deterministic = parseLocalChange(prompt);
    if (deterministic && deterministic.kind !== "unknown") return finalizeProposal(deterministic, inventory);
  }
  if (openAi?.apiKey) {
    try {
      const proposal = fromOpenAi(await requestOpenAiAssistant({
        ...openAi,
        prompt,
        history: conversationContext(history),
        siteContext,
        fetchImpl
      }));
      if (proposal?.kind && proposal.kind !== "advice") {
        const finalized = finalizeProposal(proposal, inventory, true, proposal.model);
        return {
          ...finalized,
          message: proposal.message || finalized.message,
          supportSuggested: proposal.supportSuggested,
          supportReason: proposal.supportReason,
          supportSummary: proposal.supportSummary,
          suggestions: proposal.suggestions
        };
      }
      if (proposal) return proposal;
    } catch {
      // The deterministic layer and the optional Workers AI binding keep the
      // cabinet useful during a temporary provider outage.
    }
  }
  if (ai && typeof ai.run === "function") {
    const aiProposal = await askAi(ai, prompt, inventory, history);
    if (aiProposal) return finalizeProposal(aiProposal, inventory, true, aiProposal.model);
  }
  const conversational = localConversation(prompt, inventory);
  if (conversational) return conversational;
  return assistantResult({
    type: "advice",
    kind: "advice",
    message: "Сейчас не удалось получить развёрнутый ответ от AI. Проверка сайта и точные правки телефона, графика и кнопок продолжают работать. Попробуйте повторить вопрос чуть позже.",
    suggestions: ["Проверить состояние сайта", "Какие проблемы уже найдены?"]
  });
}

export const assistantInternals = Object.freeze({ absoluteUrl, buttonTextValue, phoneValue, phoneValues, scheduleValue });
