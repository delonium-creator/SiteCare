import test from "node:test";
import assert from "node:assert/strict";
import {
  LOCK,
  assertLockedEnvironment,
  looksLikeDirectEditRequest,
  monitorResult,
  parseCommand,
  publicConfig,
  validateFieldValue
} from "../src/core.js";

const current = {
  phone: "+7 (495) 555-24-10",
  hours: "Ежедневно, 10:00–20:00",
  ctaText: "Записаться на встречу",
  ctaLink: "https://example.com/booking",
  version: 3
};

test("scope lock accepts only the exact Tilda page", () => {
  assert.doesNotThrow(() => assertLockedEnvironment({
    SITE_ID: LOCK.siteId,
    ALLOWED_ORIGIN: LOCK.origin,
    ALLOWED_HOSTNAME: LOCK.hostname,
    ALLOWED_PATH: LOCK.pathname
  }));
  assert.throws(() => assertLockedEnvironment({
    SITE_ID: LOCK.siteId,
    ALLOWED_ORIGIN: LOCK.origin,
    ALLOWED_HOSTNAME: "other.tilda.ws",
    ALLOWED_PATH: LOCK.pathname
  }), /Scope lock failed/);
});

test("parses a Russian phone command", () => {
  const change = parseCommand("Замени телефон на +7 (999) 123-45-67", current);
  assert.equal(change.field, "phone");
  assert.equal(change.before, current.phone);
  assert.equal(change.after, "+7 (999) 123-45-67");
  assert.equal(change.baseVersion, 3);
});

test("parses hours and quoted button text", () => {
  assert.equal(parseCommand("Поставь часы работы с 09:30 до 18:00", current).after, "Ежедневно с 09:30 до 18:00");
  assert.equal(parseCommand("Измени текст кнопки «Оставить заявку»", current).after, "Оставить заявку");
  assert.equal(parseCommand("Замени текст кнопки на Оставить заявку", current).after, "Оставить заявку");
});

test("accepts safe links and rejects unsafe protocols", () => {
  assert.equal(validateFieldValue("ctaLink", "https://example.com/form"), "https://example.com/form");
  assert.equal(validateFieldValue("ctaLink", "tel:+79991234567"), "tel:+79991234567");
  assert.equal(validateFieldValue("ctaLink", "mailto:owner@example.com"), "mailto:owner@example.com");
  assert.equal(validateFieldValue("ctaLink", "/booking"), "/booking");
  assert.throws(() => validateFieldValue("ctaLink", "javascript:alert(1)"), /Допустимы/);
  assert.throws(() => validateFieldValue("ctaLink", "//attacker.example/path"), /Допустимы/);
  assert.throws(() => validateFieldValue("ctaLink", "https://user:password@example.com"), /логина и пароля/iu);
  assert.throws(() => validateFieldValue("ctaLink", "tel:javascript:alert(1)"), /Допустимы/);
});

test("parses quoted links without carrying closing punctuation into the URL", () => {
  const change = parseCommand("Измени ссылку кнопки на «https://example.com/form»", current);
  assert.equal(change.field, "ctaLink");
  assert.equal(change.after, "https://example.com/form");
  assert.equal(looksLikeDirectEditRequest("Измени телефон"), true);
  assert.equal(looksLikeDirectEditRequest("Как сделать график понятнее?"), false);
});

test("covers the supported direct-edit command variants", () => {
  const cases = [
    ["Укажи номер +7 900 123 45 67", "phone", "+7 900 123 45 67"],
    ["Поставь режим работы 09.00–18.30", "hours", "Ежедневно с 09:00 до 18:30"],
    ["Текст кнопки \"Получить консультацию\"", "ctaText", "Получить консультацию"],
    ["Замени адрес кнопки на /request", "ctaLink", "/request"],
    ["Замени ссылку кнопки на mailto:owner@example.com", "ctaLink", "mailto:owner@example.com"]
  ];
  for (const [command, field, after] of cases) {
    const change = parseCommand(command, current);
    assert.equal(change.field, field);
    assert.equal(change.after, after);
  }
  assert.equal(
    parseCommand("Замени телефон +7 (111) 111-11-11 на +7 (900) 222-33-44", current).after,
    "+7 (900) 222-33-44"
  );
  assert.equal(
    parseCommand("Переименуй кнопку «Запись» в «Оставить заявку»", current).after,
    "Оставить заявку"
  );
  assert.equal(
    parseCommand("Установи ссылку кнопки на телефон +7 (999) 123-45-67", current).after,
    "tel:+79991234567"
  );
});

test("classifies varied owner wording by action, target and value", () => {
  const cases = [
    ["Поменяй контактный номер на +7 900 555 44 33", "phone", "+7 900 555 44 33"],
    ["Надпись на кнопке — Оставить заявку", "ctaText", "Оставить заявку"],
    ["Назови кнопку Получить консультацию", "ctaText", "Получить консультацию"],
    ["Пусть кнопка ведёт на https://example.com/form", "ctaLink", "https://example.com/form"],
    ["Сделай переход по кнопке на /request", "ctaLink", "/request"],
    ["Поставь режим работы с девяти до восемнадцати", "hours", "Ежедневно с 09:00 до 18:00"]
  ];
  for (const [command, field, after] of cases) {
    const change = parseCommand(command, current);
    assert.equal(change.field, field, command);
    assert.equal(change.after, after, command);
  }
  assert.equal(looksLikeDirectEditRequest("Режим работы с девяти до восемнадцати"), true);
  assert.equal(looksLikeDirectEditRequest("График 9 18"), true);
  assert.equal(looksLikeDirectEditRequest("Надпись на кнопке — Оставить заявку"), true);
});

test("does not let keywords inside a new value change the selected field", () => {
  const text = parseCommand("Текст кнопки «График работы 10–20»", current);
  assert.equal(text.field, "ctaText");
  assert.equal(text.after, "График работы 10–20");
  const link = parseCommand("Замени ссылку кнопки на «https://example.com/phone»", current);
  assert.equal(link.field, "ctaLink");
  assert.equal(link.after, "https://example.com/phone");
});

test("asks for one clear supported change instead of guessing", () => {
  assert.throws(
    () => parseCommand("Измени телефон на +7 900 000 00 00 и график с 9 до 18", current),
    /несколько разных правок/iu
  );
  assert.throws(() => parseCommand("Измени текст на Новый текст", current), /Пока можно менять/iu);
  assert.throws(() => parseCommand("Сделай кнопку синей", current), /Пока можно менять/iu);
  assert.equal(looksLikeDirectEditRequest("Сделай кнопку синей"), false);
  assert.throws(
    () => parseCommand("Сделай график на даты с 10 по 20 августа", current),
    /диапазон дат/iu
  );
});

test("rejects empty, oversized and control-character field values", () => {
  assert.equal(validateFieldValue("phone", "+7 11111111"), "+7 11111111");
  assert.throws(() => validateFieldValue("phone", "123456"), /от 7 до 15/iu);
  assert.equal(validateFieldValue("hours", "Пн: 10:00–20:00\nВт: 10:00–20:00"), "Пн: 10:00–20:00\nВт: 10:00–20:00");
  assert.throws(() => validateFieldValue("hours", `Пн\u000bВт`), /недопустимые/iu);
  assert.throws(() => validateFieldValue("ctaText", "x".repeat(61)), /от 1 до 60/iu);
  assert.throws(() => parseCommand("Измени телефон", current), /лучше взять в кавычки/iu);
});

test("validates image alt text length and control characters", () => {
  assert.throws(() => validateFieldValue("imageAlt", ""), /от 1 до 300/iu);
  assert.equal(validateFieldValue("imageAlt", "A"), "A");
  assert.equal(validateFieldValue("imageAlt", "x".repeat(300)), "x".repeat(300));
  assert.throws(() => validateFieldValue("imageAlt", "x".repeat(301)), /от 1 до 300/iu);
  assert.throws(() => validateFieldValue("imageAlt", "Фото <script>"), /недопустимые/iu);
});

test("public config omits editable values while disabled", () => {
  const result = publicConfig({
    ...current,
    siteId: LOCK.siteId,
    hostname: LOCK.hostname,
    pathname: LOCK.pathname,
    enabled: false
  });
  assert.deepEqual(Object.keys(result).sort(), ["enabled", "hostname", "pathname", "siteId", "version"].sort());
});

test("monitor is scoped to all four exact block ids", () => {
  const html = LOCK.blockIds.map((id) => `<div id="${id}"></div>`).join("");
  assert.equal(monitorResult(200, html).ok, true);
  const failed = monitorResult(200, html.replace(LOCK.blockIds[2], "missing"));
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.missingBlocks, [LOCK.blockIds[2]]);
});
