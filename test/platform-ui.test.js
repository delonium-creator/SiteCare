import test from "node:test";
import assert from "node:assert/strict";
import { inviteHtml, platformHtml, resetPasswordHtml } from "../gateway/src/platform-ui.js";

function scriptsFromHtml(html) {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)].map((match) => match[1]);
}

function idsFromHtml(html) {
  return [...html.matchAll(/\sid="([^"]+)"/giu)].map((match) => match[1]);
}

function assertUniqueIds(html) {
  const ids = idsFromHtml(html);
  assert.equal(new Set(ids).size, ids.length, "HTML must not contain duplicate ids");
}

function assertLabelsPointToControls(html) {
  const ids = new Set(idsFromHtml(html));
  for (const match of html.matchAll(/<label\s+for="([^"]+)"/giu)) {
    assert.ok(ids.has(match[1]), `label target ${match[1]} must exist`);
  }
}

test("combined client workspace and support shell keep one accessible control structure", () => {
  const html = platformHtml("test-nonce");
  assertUniqueIds(html);
  assertLabelsPointToControls(html);
  assert.match(html, /aria-label="Навигация клиента"/u);
  assert.match(html, /aria-label="Навигация поддержки"/u);
  assert.match(html, /Главная/u);
  assert.match(html, /Заявки/u);
  assert.match(html, /Изменить сайт/u);
  assert.doesNotMatch(html, /data-view="client-edit"/u);
  assert.match(html, /Отзывы/u);
  assert.match(html, /Telegram-уведомления/u);
  assert.match(html, /Настройки/u);
  assert.match(html, /Клиенты/u);
  assert.match(html, /data-view="operator-support"/u);
  assert.match(html, /Связаться с поддержкой/u);
  assert.match(html, /supportReplyForm/u);
  assert.match(html, /data-action="support-edit"/u);
  assert.match(html, /view=edit&amp;site=|view=edit&site=/u);
  assert.doesNotMatch(html, /\+manualMarkup\(\)/u);
  assert.match(html, /Редактор поддержки/u);
  assert.match(html, /selected&&details/u);
  assert.match(html, /AI-помощник/iu);
  assert.doesNotMatch(html, /оператор/iu);
  assert.match(html, /Подключения/u);
  assert.match(html, /Оплата/u);
  assert.match(html, /Система/u);
  assert.match(html, /Сайт требует проверки/u);
  assert.match(html, /@media\(max-width:860px\)/u);
  assert.match(html, /@media\(max-width:620px\)/u);
  assert.match(html, /prefers-reduced-motion/u);
  assert.match(html, /input:not\(\[type="checkbox"\]\)/u);
  assert.match(html, /sitecare-assistant\.png/u);
  assert.match(html, /wordmark-care">CARE/u);
  assert.match(html, /changePromptV45/u);
  assert.match(html, /Найдено несколько совпадений/u);
  assert.match(html, /Готово — номер изменён на сайте/u);
  assert.match(html, />Применить<\/button>/u);
  assert.match(html, /Ожидает подтверждения сайта/u);
  assert.match(html, /Контроль сайта/u);
  assert.match(html, /compact-status\.problem/u);
  assert.match(html, /data-action="telegram-dialog"/u);
  assert.doesNotMatch(html, /data-view="client-notifications"/u);
  assert.doesNotMatch(html, /Последние события|Быстрые действия/u);
  assert.match(html, /Проверки и понятные причины — открытые вопросы решает помощник в чате справа/u);
  assert.match(html, /data-feature="reviews"/u);
  assert.match(html, /Посмотреть как клиент/u);
  assert.match(html, /прокрутите <b>в самый конец<\/b>/u);
  assert.match(html, /Один код будет работать на всех опубликованных страницах/u);
  assert.match(html, /Настройки сайта → Формы → Webhook/u);
  assert.match(html, /Вставка кода в HEAD/u);
  assert.match(html, /Проверить подключение/u);
  assert.match(html, /Заявки с форм ещё не подключены/u);
  assert.doesNotMatch(html, /id="backButton"/u);
  assert.match(html, /id="sidebarToggle"/u);
  assert.match(html, /class="editor-stack diagnostics-only"/u);
  assert.match(html, /class="card editor-chat-panel"/u);
  assert.match(html, /id="chatBubble"/u);
  assert.match(html, /id="chatWidget"/u);
  assert.match(html, /Состояние сайта/u);
  assert.match(html, /HTTPS-сертификат не подтверждён/u);
  assert.match(html, /Код SiteCare не найден/u);
  assert.match(html, /Проверьте перед применением/u);
  assert.match(html, /class="phone-scope-note"/u);
  assert.match(html, /Чем помочь с сайтом/u);
  assert.match(html, /role="log" aria-live="polite"/u);
  assert.match(html, /Помощник анализирует сайт/u);
  assert.match(html, /Shift\+Enter — новая строка/u);
  assert.match(html, /Передать задачу специалисту/u);
  assert.match(html, /Никакая платная работа не начнётся/u);
  assert.match(html, /Проведи SEO-диагностику/u);
  assert.match(html, /class="chat-widget-head"/u);
  assert.match(html, /Индекс здоровья:/u);
  assert.ok(html.indexOf('id="sidebarToggle"') < html.indexOf('id="clientNav"'));
  assert.doesNotMatch(html, /side-foot"><button id="sidebarToggle"/u);
  assert.match(html, /slice\(0,6\)/u);
  assert.match(html, /Поддержка SiteCare/u);
  assert.match(html, /filter\(row=>row\.role!==['"]system['"]\)/u);
  assert.match(html, /Профиль и вход/u);
  assert.match(html, /Оставаться в системе/u);
  assert.match(html, /remember=\$\('rememberMe'\)\.checked/u);
  assert.doesNotMatch(html, /id="passwordButton"|id="logoutButton"/u);
  assert.match(html, /panelVersion/u);
  assert.match(html, /classList\.toggle\('hidden',!operator\)/u);
  assert.doesNotMatch(html, /перед закрывающим тегом body/iu);
  assert.doesNotMatch(html, /data-action="overrides"|>Правки</u);
  assert.doesNotMatch(html, /Не удалось уверенно определить поле/u);
  assert.doesNotMatch(html, /Сохранено; ждём проверки опубликованной страницы/u);
  assert.doesNotMatch(html, /Применить и проверить/u);
  assert.doesNotMatch(html, /Я не буду угадывать/u);
  assert.doesNotMatch(html, /Правка отправлена на проверку/u);
  assert.doesNotMatch(html, /Выбрать вручную/u);
  assert.doesNotMatch(html, /Только эту страницу/u);
  assert.doesNotMatch(html, /· блок rec/iu);
  assert.match(html, /<input id="rememberMe" type="checkbox" checked>/u);
  assert.doesNotMatch(html, /editForm|editPhone|overrideEnabled/u);
  assert.doesNotMatch(html, /<link[^>]+stylesheet|https:\/\/fonts\./iu);
  const scripts = scriptsFromHtml(html);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
});

test("invite and password recovery screens share the safe updated presentation", () => {
  for (const html of [inviteHtml("test-nonce", "invite-token"), resetPasswordHtml("test-nonce", "reset-token")]) {
    assertUniqueIds(html);
    assertLabelsPointToControls(html);
    assert.match(html, /autocomplete="new-password"/u);
    assert.match(html, /Одноразовая защищённая ссылка/u);
    assert.doesNotMatch(html, /<link[^>]+stylesheet|https:\/\/fonts\./iu);
    const scripts = scriptsFromHtml(html);
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new Function(scripts[0]));
  }
});
