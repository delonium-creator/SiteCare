import { scheduleValueFromCommand } from "./schedule.js";

export const LOCK = Object.freeze({
  siteId: "ketedes-page169452909",
  origin: "https://ketedes.tilda.ws",
  hostname: "ketedes.tilda.ws",
  pathname: "/page169452909.html",
  targetUrl: "https://ketedes.tilda.ws/page169452909.html",
  blockIds: Object.freeze([
    "rec2720115601",
    "rec2720131801",
    "rec2720147501",
    "rec2720212301"
  ])
});

export const FIELD_LABELS = Object.freeze({
  phone: "Телефон",
  hours: "Время работы",
  ctaText: "Текст кнопки",
  ctaLink: "Ссылка кнопки"
});

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const HOURS_CONTROL_CHARACTERS = /[\u0000-\u0009\u000B-\u001F\u007F]/u;

export function assertLockedEnvironment(env) {
  const actual = {
    siteId: env.SITE_ID,
    origin: env.ALLOWED_ORIGIN,
    hostname: env.ALLOWED_HOSTNAME,
    pathname: env.ALLOWED_PATH
  };

  for (const [key, value] of Object.entries(actual)) {
    if (value !== LOCK[key]) {
      throw new Error(`Scope lock failed: ${key}`);
    }
  }
}

export function configFromRow(row) {
  if (!row) return null;
  return {
    siteId: row.site_id,
    hostname: row.hostname,
    pathname: row.pathname,
    phone: row.phone,
    hours: row.hours,
    ctaText: row.cta_text,
    ctaLink: row.cta_link,
    enabled: Boolean(row.enabled),
    version: Number(row.version),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  };
}

export function validateFieldValue(field, rawValue) {
  const value = String(rawValue ?? "").trim();

  if (field === "phone") {
    const digits = value.replace(/\D/gu, "");
    if (value.length < 7 || value.length > 40 || digits.length < 7 || digits.length > 15) {
      throw new Error("Укажите номер: от 7 до 15 цифр.");
    }
    if (!/^[+\d\s().-]+$/.test(value) || !/\d/.test(value)) {
      throw new Error("В телефоне допустимы только цифры, пробелы, +, скобки, точки и дефисы.");
    }
    return value;
  }

  if (field === "hours") {
    if (value.length < 2 || value.length > 300) {
      throw new Error("Время работы должно содержать от 2 до 300 символов.");
    }
    if (/[<>]/.test(value) || HOURS_CONTROL_CHARACTERS.test(value)) {
      throw new Error("Время работы содержит недопустимые символы.");
    }
    return value;
  }

  if (field === "ctaText") {
    if (value.length < 1 || value.length > 60) {
      throw new Error("Текст кнопки должен содержать от 1 до 60 символов.");
    }
    if (/[<>]/.test(value) || CONTROL_CHARACTERS.test(value)) {
      throw new Error("Текст кнопки содержит недопустимые символы.");
    }
    return value;
  }

  if (field === "ctaLink") {
    if (!value || value.length > 500 || CONTROL_CHARACTERS.test(value)) {
      throw new Error("Ссылка слишком длинная.");
    }
    if (/^https:\/\//i.test(value)) {
      const url = new URL(value);
      if (!url.hostname || url.username || url.password) {
        throw new Error("Укажите полную HTTPS-ссылку без логина и пароля.");
      }
      return url.href;
    }
    if (/^tel:\+?[\d\s().-]{5,40}$/iu.test(value) && /\d/u.test(value)) return value;
    if (/^mailto:[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+(?:\?[^\s<>]*)?$/iu.test(value)) return value;
    if (/^\/(?!\/)[a-zA-Z0-9_/?#&=.%+-]*$/u.test(value) || /^#[a-zA-Z0-9_-]+$/u.test(value)) {
      return value;
    }
    throw new Error("Допустимы HTTPS-ссылка, tel:, mailto:, якорь #... или путь /....");
  }

  if (field === "imageAlt") {
    if (value.length < 1 || value.length > 300) {
      throw new Error("Alt-текст должен содержать от 1 до 300 символов.");
    }
    if (/[<>]/.test(value) || CONTROL_CHARACTERS.test(value)) {
      throw new Error("Alt-текст содержит недопустимые символы.");
    }
    return value;
  }

  throw new Error("Это поле нельзя менять.");
}

function quotedValue(command) {
  const matches = [...command.matchAll(/[«“"](.+?)[»”"]/gu)];
  const match = matches.at(-1);
  return match ? match[1].trim() : null;
}

const EDIT_ACTION_PATTERN = /замен|измен|поменя|постав|укаж|обнов|исправ|установ|добав|сдела|переимен|назов|зада|выстав|напиш/iu;
const HOURS_TARGET_PATTERN = /граф+ик|режим|время\s+работ|час(?:ы|ов)?\s+работ|расписани|будни|выходн|ежедневно|кажд(?:ый|ого)\s+день|все\s+дни|всю\s+недел|понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресенье|(?:^|[^а-яё])(?:пн|вт|ср|чт|пт|сб|вс|вск)(?=$|[^а-яё])/iu;
const PHONE_TARGET_PATTERN = /тел+ефон|контактн.{0,12}(?:номер|телефон)|номер(?:\s+телефона|\s+для\s+связи)?|позвон|звонк/iu;
const LINK_TARGET_PATTERN = /ссылк|линк|\burl\b|адрес\s+(?:для\s+)?кнопк|куда.{0,20}кнопк|кнопк.{0,25}(?:вед|переход)|переход.{0,25}кнопк/iu;
const BUTTON_TEXT_TARGET_PATTERN = /(?:текст|надпис|назван|подпис).{0,20}кнопк|кнопк.{0,20}(?:текст|надпис|назван|подпис)|переимен.{0,15}кнопк|назов.{0,15}кнопк/iu;

function normalizedIntentText(rawCommand) {
  return String(rawCommand || "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/\u00a0/gu, " ")
    .replace(/[«“"](.+?)[»”"]/gu, " «значение» ")
    .replace(/\s+/gu, " ")
    .trim();
}

function commandTargets(rawCommand) {
  const text = normalizedIntentText(rawCommand);
  const targets = new Set();
  const hasLink = LINK_TARGET_PATTERN.test(text);
  const hasLinkValue = /https:\/\/|(?:mailto:|tel:)|\/(?!\/)[a-z0-9_/?#&=.%+-]+/iu.test(String(rawCommand || ""));
  const hasQuotedValue = /[«“"][^»”"]+[»”"]/u.test(String(rawCommand || ""));
  const phoneIsLinkDestination = hasLink && !hasLinkValue && !/(?:\s|^)(?:и|а\s+также)(?:\s|$)/iu.test(text) &&
    /(?:ссылк|адрес|кнопк|вед).{0,35}(?:телефон|позвон|звон)|(?:телефон|позвон|звон).{0,20}(?:ссылк|адрес|кнопк)/iu.test(text);

  if (HOURS_TARGET_PATTERN.test(text)) targets.add("hours");
  if (hasLink) targets.add("ctaLink");
  if (PHONE_TARGET_PATTERN.test(text) && !phoneIsLinkDestination) targets.add("phone");
  if (BUTTON_TEXT_TARGET_PATTERN.test(text) || (!hasLink && /кнопк/iu.test(text) && EDIT_ACTION_PATTERN.test(text) && hasQuotedValue)) {
    targets.add("ctaText");
  }
  return [...targets];
}

function missingValueMessage(field) {
  if (field === "phone") return "Укажите новый телефон — например, «+7 (999) 123-45-67». Значение лучше взять в кавычки «…».";
  if (field === "hours") return "Укажите начало и конец работы — например, «с 10 до 20», либо опишите график по дням.";
  if (field === "ctaText") return "Укажите новую надпись кнопки — лучше в кавычках «…».";
  if (field === "ctaLink") return "Укажите новую HTTPS-ссылку, телефон, почту, якорь или путь для кнопки.";
  return "Пока можно менять телефон, время работы, текст и ссылку кнопки. Значение лучше взять в кавычки «…».";
}

function unquotedButtonText(command) {
  const patterns = [
    /(?:текст|надпис(?:ь|и)|назван(?:ие|ия)|подпис(?:ь|и))\s+(?:на\s+)?кнопк(?:е|и|у|а)?\s*(?:на|в|:|[-—])?\s*(.+)$/iu,
    /(?:замени|измени|поменяй|поставь|укажи|обнови|исправь|установи|сделай|переименуй|назови|задай|напиши)\s+(?:текст\s+|надпись\s+|название\s+)?кнопк(?:и|у|е)?\s*(?:на|в|:|[-—])?\s*(.+)$/iu
  ];
  for (const pattern of patterns) {
    const match = command.match(pattern);
    const value = match?.[1]?.trim().replace(/^[\s:—-]*(?:на\s+)?/iu, "").replace(/[.!?]+$/u, "");
    if (value) return value;
  }
  return null;
}

export function parseCommand(rawCommand, current) {
  const command = String(rawCommand ?? "").trim();
  if (!command) throw new Error("Напишите, что нужно изменить.");
  if (command.length > 500) throw new Error("Команда слишком длинная.");

  const targets = commandTargets(command);
  if (targets.length > 1) {
    throw new Error("В одной команде найдено несколько разных правок. Отправьте телефон, график, текст и ссылку кнопки отдельными сообщениями.");
  }
  let field = null;
  let value = null;

  const intendedField = targets[0] || null;
  const scheduleValue = intendedField === "hours" || intendedField === null
    ? scheduleValueFromCommand(command, current.hours)
    : null;
  if (scheduleValue) {
    field = "hours";
    value = scheduleValue;
  }

  if (!field && intendedField === "ctaLink") {
    field = "ctaLink";
    const matches = [...command.matchAll(/https:\/\/[^\s«»“”"]+|(?:tel:|mailto:)[^\s«»“”"]+|#[a-zA-Z0-9_-]+|\/(?!\/)[a-zA-Z0-9_/?#&=.%+-]+/giu)];
    const match = matches.at(-1);
    value = match ? match[0].replace(/[.,;!?]+$/u, "") : quotedValue(command);
    if (!value && /телефон|позвон|звон/iu.test(command)) {
      const phones = [...command.matchAll(/(?:\+?\d)(?:[\s\-().]*\d){4,18}/gu)];
      const phone = phones.at(-1)?.[0] || "";
      if (phone) value = `tel:${phone.replace(/(?!^)\D/gu, "")}`;
    }
  } else if (!field && intendedField === "phone") {
    field = "phone";
    const matches = [...command.matchAll(/(?:\+?\d)(?:[\s\-().]*\d){4,18}/gu)];
    const match = matches.at(-1);
    value = match ? match[0].trim() : quotedValue(command);
  } else if (!field && intendedField === "hours") {
    field = "hours";
    value = quotedValue(command);
    if (!value) {
      const matches = [...command.matchAll(/(\d{1,2}[:.]\d{2})\s*(?:до|[-–—])\s*(\d{1,2}[:.]\d{2})/giu)];
      const match = matches.at(-1);
      if (match) {
        value = `Ежедневно с ${match[1].replace(".", ":")} до ${match[2].replace(".", ":")}`;
      }
    }
  } else if (!field && intendedField === "ctaText") {
    field = "ctaText";
    value = quotedValue(command);
    if (!value) value = unquotedButtonText(command);
  }

  if (!field || !value) {
    throw new Error(missingValueMessage(field || intendedField));
  }

  const after = validateFieldValue(field, value);
  const before = String(current[field] ?? "");
  if (before === after) throw new Error("Это значение уже установлено.");

  return {
    field,
    label: FIELD_LABELS[field],
    before,
    after,
    baseVersion: current.version
  };
}

export function looksLikeDirectEditRequest(rawCommand) {
  const command = String(rawCommand ?? "").trim();
  if (!command || command.length > 1000) return false;
  if (/^как(?:\s|$)/iu.test(command)) return false;
  const targets = commandTargets(command);
  const hasField = targets.length > 0;
  const hasEditVerb = EDIT_ACTION_PATTERN.test(command);
  const hasScheduleFormatting = /(?:график|расписани).{0,30}(?:по\s+дням|в\s+столбик|по\s+строк|компакт|объедин|сгрупп|одну\s+строк)|(?:разбей|оформи|покажи).{0,25}(?:график|расписани)/iu.test(command);
  const hasConcreteValue = /[«“"][^»”"]+[»”"]|https?:\/\/|(?:tel:|mailto:)|(?:\+?\d)(?:[\s\-().]*\d){4,18}|\d{1,2}(?:[.:]\d{2})?\s*(?:до|[-–—])\s*\d{1,2}(?:[.:]\d{2})?|(?:выходн|закрыт|круглосуточно|24\s*\/\s*7)/iu.test(command);
  const hasWordTimeRange = HOURS_TARGET_PATTERN.test(command) && /(?:с\s+)?[а-яё]+\s+(?:до|[-–—])\s*[а-яё]+/iu.test(command);
  const looseHours = HOURS_TARGET_PATTERN.test(command)
    ? [...command.matchAll(/(?<![\d:.])(\d{1,2})(?![\d:.])/gu)].length === 2
    : false;
  const hasNaturalAssignment = /(?:пусть|будет|должн|нужно|хочу).{0,30}(?:телефон|номер|график|время|кнопк|ссылк)|(?:текст|надпис|назван|подпис).{0,20}кнопк.{0,8}(?:[-—:]|\s+на\s+)/iu.test(command);
  return hasField && (hasEditVerb || hasConcreteValue || hasWordTimeRange || looseHours || hasScheduleFormatting || hasNaturalAssignment);
}

export function publicConfig(config) {
  if (!config || config.siteId !== LOCK.siteId || config.hostname !== LOCK.hostname || config.pathname !== LOCK.pathname) {
    throw new Error("Stored scope does not match the locked page.");
  }
  if (!config.enabled) {
    return {
      enabled: false,
      siteId: LOCK.siteId,
      hostname: LOCK.hostname,
      pathname: LOCK.pathname,
      version: config.version
    };
  }
  return {
    enabled: true,
    siteId: LOCK.siteId,
    hostname: LOCK.hostname,
    pathname: LOCK.pathname,
    phone: config.phone,
    hours: config.hours,
    ctaText: config.ctaText,
    ctaLink: config.ctaLink,
    version: config.version,
    updatedAt: config.updatedAt
  };
}

export function monitorResult(httpStatus, html, errorMessage = "") {
  const missingBlocks = LOCK.blockIds.filter((id) => !String(html || "").includes(`id=\"${id}\"`) && !String(html || "").includes(`id='${id}'`));
  const statusOk = Number(httpStatus) >= 200 && Number(httpStatus) < 400;
  const ok = statusOk && missingBlocks.length === 0 && !errorMessage;
  return {
    ok,
    httpStatus: Number(httpStatus) || null,
    missingBlocks,
    details: errorMessage
      ? `Ошибка запроса: ${errorMessage}`
      : !statusOk
        ? `Страница вернула код ${httpStatus}.`
        : missingBlocks.length
          ? `Не найдены блоки: ${missingBlocks.join(", ")}.`
          : "Страница открывается, все четыре закреплённых блока найдены."
  };
}
