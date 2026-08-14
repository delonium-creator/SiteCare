export const SCHEDULE_DAYS = Object.freeze(["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]);

const DAY_TOKEN = "(?:пн|понедельник(?:а)?|вт|вторник(?:а)?|ср|сред(?:а|у|ы)|чт|четверг(?:а)?|пт|пятниц(?:а|у|ы)|сб|суббот(?:а|у|ы)|вс|вск|воскресень(?:е|я))";
const DAY_RANGE = `(?:с\\s+${DAY_TOKEN}\\s+(?:до|по)\\s+${DAY_TOKEN}|${DAY_TOKEN}\\s*[-–—]\\s*${DAY_TOKEN})`;
const SELECTOR_PATTERN = `(?:(?:в|во|по)\\s+)?(?:ежедневно|кажд(?:ый|ого)\\s+день|все\\s+дни|всю\\s+неделю|целую\\s+неделю|будни|будням|выходные|выходным|${DAY_RANGE}|${DAY_TOKEN})`;
const WORD_HOUR_PATTERN = "(?:двадцати\\s+(?:одного|двух|тр[её]х)|нол(?:ь|я)|один|одного|час|часа|два|двух|три|тр[её]х|четыре|четыр[её]х|пять|пяти|шесть|шести|семь|семи|восемь|восьми|девять|девяти|десять|десяти|одиннадцать|одиннадцати|двенадцать|двенадцати|тринадцать|тринадцати|четырнадцать|четырнадцати|пятнадцать|пятнадцати|шестнадцать|шестнадцати|семнадцать|семнадцати|восемнадцать|восемнадцати|девятнадцать|девятнадцати|двадцать|двадцати)";
const TIME_TOKEN_PATTERN = `(?:\\d{1,2}(?:[.:]\\d{2})?|${WORD_HOUR_PATTERN})`;
const TIME_RANGE_PATTERN = `(?:с\\s*)?${TIME_TOKEN_PATTERN}\\s*(?:до|[-–—])\\s*${TIME_TOKEN_PATTERN}`;
const STATE_PATTERN = `(?:выходн(?:ой|ым)|закрыт(?:о|ы)?|круглосуточно|24\\s*\\/\\s*7|${TIME_RANGE_PATTERN})`;
const SCHEDULE_CONTEXT = /график|режим|время\s+работ|час(?:ы|ов)?\s+работ|расписани|будни|выходн|ежедневно|кажд(?:ый|ого)\s+день|все\s+дни|всю\s+недел|понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресенье|(?:^|[^а-яё])(?:пн|вт|ср|чт|пт|сб|вс|вск)(?=$|[^а-яё])/iu;
const DATE_CONTEXT = /дат[аы]?|числ[оа]?|месяц|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр|с\s+\d{1,2}\s+по\s+\d{1,2}/iu;

const WORD_HOURS = new Map([
  ["ноль", 0], ["ноля", 0],
  ["один", 1], ["одного", 1], ["час", 1], ["часа", 1],
  ["два", 2], ["двух", 2],
  ["три", 3], ["трех", 3],
  ["четыре", 4], ["четырех", 4],
  ["пять", 5], ["пяти", 5],
  ["шесть", 6], ["шести", 6],
  ["семь", 7], ["семи", 7],
  ["восемь", 8], ["восьми", 8],
  ["девять", 9], ["девяти", 9],
  ["десять", 10], ["десяти", 10],
  ["одиннадцать", 11], ["одиннадцати", 11],
  ["двенадцать", 12], ["двенадцати", 12],
  ["тринадцать", 13], ["тринадцати", 13],
  ["четырнадцать", 14], ["четырнадцати", 14],
  ["пятнадцать", 15], ["пятнадцати", 15],
  ["шестнадцать", 16], ["шестнадцати", 16],
  ["семнадцать", 17], ["семнадцати", 17],
  ["восемнадцать", 18], ["восемнадцати", 18],
  ["девятнадцать", 19], ["девятнадцати", 19],
  ["двадцать", 20], ["двадцати", 20],
  ["двадцати одного", 21], ["двадцати двух", 22], ["двадцати трех", 23]
]);

function dayIndex(rawDay) {
  const day = String(rawDay || "").toLocaleLowerCase("ru-RU");
  if (/^(?:пн|понедельник|понедельника)$/u.test(day)) return 0;
  if (/^(?:вт|вторник|вторника)$/u.test(day)) return 1;
  if (/^(?:ср|среда|среду|среды)$/u.test(day)) return 2;
  if (/^(?:чт|четверг|четверга)$/u.test(day)) return 3;
  if (/^(?:пт|пятница|пятницу|пятницы)$/u.test(day)) return 4;
  if (/^(?:сб|суббота|субботу|субботы)$/u.test(day)) return 5;
  if (/^(?:вс|вск|воскресенье|воскресенья)$/u.test(day)) return 6;
  return -1;
}

function selectedDays(rawSelector) {
  const selector = String(rawSelector || "")
    .toLocaleLowerCase("ru-RU")
    .replace(/^(?:в|во|по)\s+/u, "")
    .trim();
  if (/^(?:ежедневно|кажд(?:ый|ого)\s+день|все\s+дни|всю\s+неделю|целую\s+неделю)$/u.test(selector)) return [0, 1, 2, 3, 4, 5, 6];
  if (/^(?:будни|будням)$/u.test(selector)) return [0, 1, 2, 3, 4];
  if (/^(?:выходные|выходным)$/u.test(selector)) return [5, 6];
  const verbalRange = selector.match(/^с\s+(.+?)\s+(?:до|по)\s+(.+)$/u);
  const parts = verbalRange ? [verbalRange[1], verbalRange[2]] : selector.split(/\s*[-–—]\s*/u);
  const first = dayIndex(parts[0]);
  if (first < 0) return [];
  if (parts.length === 1) return [first];
  const last = dayIndex(parts[1]);
  if (last < first) return [];
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function normalizedTime(hours, minutes, allow24 = false) {
  const hour = Number(hours);
  const minute = Number(minutes);
  const validHour = Number.isInteger(hour) && hour >= 0 && (hour <= 23 || (allow24 && hour === 24 && minute === 0));
  if (!validHour || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("В графике указано невозможное время.");
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizedTimeToken(rawToken, allow24 = false) {
  const token = String(rawToken || "")
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/\s+/gu, " ");
  const numeric = token.match(/^(\d{1,2})(?:[.:](\d{2}))?$/u);
  if (numeric) return normalizedTime(numeric[1], numeric[2] || "0", allow24);
  const hour = WORD_HOURS.get(token);
  if (hour === undefined) throw new Error("Не удалось разобрать время в графике.");
  return normalizedTime(hour, 0, allow24);
}

function timeRangeFromText(rawText) {
  const expression = new RegExp(`(?:с\\s*)?(${TIME_TOKEN_PATTERN})\\s*(?:до|[-–—])\\s*(${TIME_TOKEN_PATTERN})(?=$|[\\s,.;!?])`, "iu");
  const match = String(rawText || "").match(expression);
  if (!match) return null;
  const start = normalizedTimeToken(match[1]);
  const end = normalizedTimeToken(match[2], true);
  if (start === end) throw new Error("Начало и конец работы совпадают. Для круглосуточного режима напишите «круглосуточно».");
  return { start, end, state: `${start}–${end}` };
}

function looseTimeRange(rawText) {
  const text = String(rawText || "");
  if (DATE_CONTEXT.test(text)) return null;
  const values = [...text.matchAll(/(?<![\d:.])(\d{1,2})(?![\d:.])/gu)].map((match) => match[1]);
  if (values.length !== 2) return null;
  const start = normalizedTimeToken(values[0]);
  const end = normalizedTimeToken(values[1], true);
  if (start === end) throw new Error("Начало и конец работы совпадают. Для круглосуточного режима напишите «круглосуточно».");
  return { start, end, state: `${start}–${end}` };
}

function normalizedState(rawState) {
  const state = String(rawState || "").trim().toLocaleLowerCase("ru-RU");
  if (/выходн|закрыт/u.test(state)) return "выходной";
  if (/круглосуточно|24\s*\/\s*7/u.test(state)) return "круглосуточно";
  const range = timeRangeFromText(state);
  if (!range) throw new Error("Не удалось разобрать время в графике.");
  return range.state;
}

export function parseWeeklySchedule(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;
  const expression = new RegExp(`(${SELECTOR_PATTERN})\\s*[:,]?\\s*(${STATE_PATTERN})`, "giu");
  const schedule = Array(7).fill(null);
  let matches = 0;
  for (const match of text.matchAll(expression)) {
    const days = selectedDays(match[1]);
    if (days.length === 0) continue;
    const state = normalizedState(match[2]);
    for (const day of days) schedule[day] = state;
    matches += 1;
  }
  return matches > 0 ? schedule : null;
}

export function isCompleteSchedule(schedule) {
  return Array.isArray(schedule) && schedule.length === 7 && schedule.every((value) => typeof value === "string" && value.length > 0);
}

export function mergeWeeklySchedule(base, partial) {
  if (!Array.isArray(partial) || partial.length !== 7) return null;
  const result = Array.isArray(base) && base.length === 7 ? [...base] : Array(7).fill(null);
  partial.forEach((value, index) => {
    if (value) result[index] = value;
  });
  return result;
}

export function formatWeeklySchedule(schedule, mode = "grouped") {
  if (!isCompleteSchedule(schedule)) throw new Error("Для форматирования нужен график на все семь дней.");
  if (mode === "expanded") {
    return schedule.map((value, index) => `${SCHEDULE_DAYS[index]}: ${value}`).join("\n");
  }
  const groups = [];
  for (let start = 0; start < schedule.length;) {
    let end = start;
    while (end + 1 < schedule.length && schedule[end + 1] === schedule[start]) end += 1;
    groups.push({ start, end, value: schedule[start] });
    start = end + 1;
  }
  if (groups.length === 1) return `Ежедневно: ${groups[0].value}`;
  const rows = groups.map((group) => {
    const days = group.start === group.end
      ? SCHEDULE_DAYS[group.start]
      : `${SCHEDULE_DAYS[group.start]}–${SCHEDULE_DAYS[group.end]}`;
    return `${days}: ${group.value}`;
  });
  return rows.join(mode === "single-line" ? "; " : "\n");
}

export function scheduleValueFromCommand(rawCommand, currentValue) {
  const command = String(rawCommand || "").trim().replace(/\u00a0/gu, " ");
  if (!SCHEDULE_CONTEXT.test(command)) return null;
  const wantsExpanded = /по\s+дням|все\s+дни|график.{0,15}(?:по\s+)?дн(?:ям|и|ей)|дн(?:ям|и|ей).{0,15}график|в\s+столбик|по\s+строк|новой\s+строк/iu.test(command);
  const wantsSingleLine = /в\s+одну\s+строк/iu.test(command);
  const wantsGrouped = /компакт|объедин|сгрупп|сократи/iu.test(command);
  const wantsReadable = /(?:понятн|аккуратн|удобн|красив|нормальн).{0,20}(?:график|расписани)|(?:график|расписани).{0,20}(?:понятн|аккуратн|удобн|красив|нормальн)/iu.test(command);
  const current = parseWeeklySchedule(currentValue);
  let requested = parseWeeklySchedule(command);
  let generalRange = null;

  if (!requested) {
    if (DATE_CONTEXT.test(command) && /\d{1,2}\s*(?:до|по|[-–—])\s*\d{1,2}/u.test(command)) {
      throw new Error("Похоже, указан диапазон дат, а не часы работы. Для графика напишите, например: «с 10 до 20 часов».");
    }
    generalRange = timeRangeFromText(command) || looseTimeRange(command);
    if (generalRange) requested = Array(7).fill(generalRange.state);
  }

  if (requested) {
    const merged = isCompleteSchedule(requested) ? requested : mergeWeeklySchedule(current, requested);
    if (!isCompleteSchedule(merged)) {
      throw new Error("Укажите график для остальных дней или сначала задайте общий график на всю неделю.");
    }
    if (generalRange && !wantsExpanded && !wantsSingleLine && !wantsGrouped && !wantsReadable) {
      return `Ежедневно с ${generalRange.start} до ${generalRange.end}`;
    }
    return formatWeeklySchedule(merged, wantsExpanded || wantsReadable ? "expanded" : wantsSingleLine ? "single-line" : "grouped");
  }

  if (wantsExpanded || wantsSingleLine || wantsGrouped || wantsReadable) {
    if (!isCompleteSchedule(current)) {
      throw new Error("Текущий график нельзя надёжно разделить по дням. Укажите время для будней, субботы и воскресенья.");
    }
    return formatWeeklySchedule(current, wantsExpanded || wantsReadable ? "expanded" : wantsSingleLine ? "single-line" : "grouped");
  }
  return null;
}
