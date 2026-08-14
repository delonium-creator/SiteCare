import test from "node:test";
import assert from "node:assert/strict";
import {
  formatWeeklySchedule,
  isCompleteSchedule,
  mergeWeeklySchedule,
  parseWeeklySchedule,
  scheduleValueFromCommand
} from "../src/schedule.js";
import { parseCommand } from "../src/core.js";

const defaultHours = "Ежедневно, 10:00–20:00";

test("parses the seven-day line produced by the previous version", () => {
  const input = "Пн: 10:00-20:00, Вт: 10:00-20:00, Ср: 10:00-20:00, Чт: 10:00-20:00, Пт: 10:00-20:00, Сб: 10:00-20:00, Вск: 10:00-20:00";
  const schedule = parseWeeklySchedule(input);
  assert.equal(isCompleteSchedule(schedule), true);
  assert.deepEqual(schedule, Array(7).fill("10:00–20:00"));
});

test("formats a complete schedule as rows, grouped rows or one line", () => {
  const schedule = [
    "09:00–18:00", "09:00–18:00", "09:00–18:00", "09:00–18:00", "09:00–18:00",
    "10:00–15:00", "выходной"
  ];
  assert.equal(formatWeeklySchedule(schedule, "expanded").split("\n").length, 7);
  assert.equal(formatWeeklySchedule(schedule, "grouped"), "Пн–Пт: 09:00–18:00\nСб: 10:00–15:00\nВс: выходной");
  assert.equal(formatWeeklySchedule(schedule, "single-line"), "Пн–Пт: 09:00–18:00; Сб: 10:00–15:00; Вс: выходной");
});

test("turns a general current schedule into seven local rows without AI", () => {
  const expanded = scheduleValueFromCommand("Добавь график по дням", defaultHours);
  assert.equal(expanded, ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => `${day}: 10:00–20:00`).join("\n"));
  assert.equal(scheduleValueFromCommand("Сделай график более понятным", defaultHours), expanded);
});

test("understands natural hour-only, word and compact time ranges", () => {
  const expanded = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => `${day}: 10:00–20:00`).join("\n");
  assert.equal(scheduleValueFromCommand("Сделай общий график дней с 10 до 20", defaultHours), expanded);
  assert.equal(scheduleValueFromCommand("Режим работы с десяти до двадцати", defaultHours), "Ежедневно с 10:00 до 20:00");
  assert.equal(scheduleValueFromCommand("График 9 18", defaultHours), "Ежедневно с 09:00 до 18:00");
  assert.equal(scheduleValueFromCommand("Всю неделю 9–18", defaultHours), "Ежедневно: 09:00–18:00");
});

test("understands spoken weekday ranges and fills the whole week", () => {
  assert.equal(
    scheduleValueFromCommand("С понедельника по пятницу с 9 до 18, в выходные с 10 до 16", defaultHours),
    "Пн–Пт: 09:00–18:00\nСб–Вс: 10:00–16:00"
  );
  assert.equal(
    scheduleValueFromCommand("Понедельник–пятница 09:30–18:30, суббота–воскресенье выходной", defaultHours),
    "Пн–Пт: 09:30–18:30\nСб–Вс: выходной"
  );
});

test("does not confuse date ranges or incomplete number lists with working hours", () => {
  assert.throws(
    () => scheduleValueFromCommand("Сделай график на даты с 10 по 20 августа", defaultHours),
    /диапазон дат/iu
  );
  assert.equal(scheduleValueFromCommand("График 10 20 30", defaultHours), null);
  assert.equal(scheduleValueFromCommand("График начинается с 10", defaultHours), null);
  assert.throws(() => scheduleValueFromCommand("График с 25 до 18", defaultHours), /невозможное время/iu);
});

test("updates selected days locally and preserves the rest", () => {
  assert.equal(
    scheduleValueFromCommand("В воскресенье выходной", defaultHours),
    "Пн–Сб: 10:00–20:00\nВс: выходной"
  );
  assert.equal(
    scheduleValueFromCommand("По будням 09:00–18:00, в субботу 10:00–14:00, в воскресенье выходной", defaultHours),
    "Пн–Пт: 09:00–18:00\nСб: 10:00–14:00\nВс: выходной"
  );
});

test("rejects impossible or incomplete schedules instead of guessing", () => {
  assert.throws(() => parseWeeklySchedule("Пн: 25:00–18:00"), /невозможное время/iu);
  const partial = parseWeeklySchedule("Пн: 09:00–18:00");
  assert.equal(isCompleteSchedule(partial), false);
  assert.equal(isCompleteSchedule(mergeWeeklySchedule(null, partial)), false);
  assert.throws(() => scheduleValueFromCommand("Пн: 09:00–18:00", "По записи"), /остальных дней/iu);
});

test("the assistant command parser creates a multiline hours proposal", () => {
  const change = parseCommand("Добавь график по дням", {
    phone: "+7 (495) 555-24-10",
    hours: defaultHours,
    ctaText: "Записаться",
    ctaLink: "https://example.com",
    version: 7
  });
  assert.equal(change.field, "hours");
  assert.equal(change.after.split("\n").length, 7);
  assert.equal(change.baseVersion, 7);
});
