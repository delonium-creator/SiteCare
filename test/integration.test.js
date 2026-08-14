import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import siteCare from "../src/index.js";
import { AI_MODEL } from "../src/assistant.js";
import { LOCK } from "../src/core.js";
import { encryptTelegramBotToken } from "../src/notifications.js";

const ADMIN_PASSWORD = "Test-password-12345";
const SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const FORM_WEBHOOK_SECRET = "form-webhook-0123456789abcdef0123456789abcdef";

async function createWorker() {
  const worker = new Miniflare({
    modules: true,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    modulesRoot: process.cwd(),
    scriptPath: "src/index.js",
    compatibilityDate: "2026-08-04",
    d1Databases: ["DB"],
    bindings: {
      SITE_ID: "ketedes-page169452909",
      ALLOWED_ORIGIN: "https://ketedes.tilda.ws",
      ALLOWED_HOSTNAME: "ketedes.tilda.ws",
      ALLOWED_PATH: "/page169452909.html",
      SESSION_HOURS: "12",
      ADMIN_PASSWORD,
      SESSION_SECRET,
      FORM_WEBHOOK_SECRET
    }
  });
  try {
    const database = await worker.getD1Database("DB");
    const migrations = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();
    for (const name of migrations) {
      const migration = await readFile(`migrations/${name}`, "utf8");
      const statements = migration.split(/;\s*(?:\n|$)/u).map((statement) => statement.trim()).filter(Boolean);
      for (const statement of statements) await database.prepare(statement).run();
    }
    return worker;
  } catch (error) {
    await worker.dispose();
    throw error;
  }
}

async function json(response) {
  return response.json();
}

function directEnv(database, ai) {
  return {
    DB: database,
    AI: ai,
    SITE_ID: "ketedes-page169452909",
    ALLOWED_ORIGIN: "https://ketedes.tilda.ws",
    ALLOWED_HOSTNAME: "ketedes.tilda.ws",
    ALLOWED_PATH: "/page169452909.html",
    SESSION_HOURS: "12",
    ADMIN_PASSWORD,
    SESSION_SECRET,
    FORM_WEBHOOK_SECRET
  };
}

test("complete owner flow stays disabled until explicit activation", async () => {
  const worker = await createWorker();
  try {
    const publicBefore = await worker.dispatchFetch("https://worker.test/api/public/config", {
      headers: { Origin: "https://ketedes.tilda.ws" }
    });
    assert.equal(publicBefore.status, 200);
    assert.equal(publicBefore.headers.get("Access-Control-Allow-Origin"), "https://ketedes.tilda.ws");
    assert.equal((await json(publicBefore)).enabled, false);

    const login = await worker.dispatchFetch("https://worker.test/api/admin/login", {
      method: "POST",
      headers: { Origin: "https://worker.test", "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("Set-Cookie").split(";", 1)[0];

    const proposed = await worker.dispatchFetch("https://worker.test/api/admin/assistant", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Замени телефон на +7 (999) 123-45-67", history: [] })
    });
    assert.equal(proposed.status, 200);
    const proposal = await json(proposed);
    assert.equal(proposal.kind, "proposal");
    assert.equal(proposal.source, "rules");
    assert.equal(proposal.change.field, "phone");

    const applied = await worker.dispatchFetch("https://worker.test/api/admin/apply", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ token: proposal.token })
    });
    assert.equal(applied.status, 200);
    assert.equal((await json(applied)).config.phone, "+7 (999) 123-45-67");

    const stillDisabled = await worker.dispatchFetch("https://worker.test/api/public/config", {
      headers: { Origin: "https://ketedes.tilda.ws" }
    });
    const disabledBody = await json(stillDisabled);
    assert.equal(disabledBody.enabled, false);
    assert.equal("phone" in disabledBody, false);

    const stateResponse = await worker.dispatchFetch("https://worker.test/api/admin/state", {
      headers: { Cookie: cookie }
    });
    const state = await json(stateResponse);
    const enabled = await worker.dispatchFetch("https://worker.test/api/admin/toggle", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, baseVersion: state.config.version })
    });
    assert.equal(enabled.status, 200);

    const publicAfter = await worker.dispatchFetch("https://worker.test/api/public/config", {
      headers: { Origin: "https://ketedes.tilda.ws" }
    });
    const enabledBody = await json(publicAfter);
    assert.equal(enabledBody.enabled, true);
    assert.equal(enabledBody.phone, "+7 (999) 123-45-67");

    const consultation = await worker.dispatchFetch("https://worker.test/api/admin/assistant", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Что ты умеешь?", history: [] })
    });
    assert.equal(consultation.status, 200);
    const consultationBody = await json(consultation);
    assert.equal(consultationBody.kind, "advice");
    assert.equal(consultationBody.source, "local-rules");
    assert.equal(consultationBody.usesAi, false);
  } finally {
    await worker.dispose();
  }
});

test("admin writes reject requests from another origin", async () => {
  const worker = await createWorker();
  try {
    const response = await worker.dispatchFetch("https://worker.test/api/admin/login", {
      method: "POST",
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    });
    assert.equal(response.status, 400);
    assert.match((await json(response)).error, /другого сайта/);
  } finally {
    await worker.dispose();
  }
});

test("admin page and session endpoints send strict browser protections", async () => {
  const worker = await createWorker();
  try {
    const page = await worker.dispatchFetch("https://worker.test/admin");
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("Cache-Control"), "no-store");
    assert.equal(page.headers.get("X-Frame-Options"), "DENY");
    assert.match(page.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/u);
    assert.match(page.headers.get("Permissions-Policy"), /camera=\(\)/u);
    assert.match(await page.text(), /name="robots" content="noindex,nofollow"/u);

    const withoutSession = await worker.dispatchFetch("https://worker.test/api/admin/state");
    assert.equal(withoutSession.status, 401);
  } finally {
    await worker.dispose();
  }
});

test("all four supported fields follow proposal, confirmation, history and rollback", async () => {
  const worker = await createWorker();
  try {
    const login = await worker.dispatchFetch("https://worker.test/api/admin/login", {
      method: "POST",
      headers: { Origin: "https://worker.test", "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    });
    const cookie = login.headers.get("Set-Cookie").split(";", 1)[0];
    const commands = [
      ["Замени телефон на +7 (900) 111-22-33", "phone", "+7 (900) 111-22-33"],
      ["Поставь график с 08:30 до 17:30", "hours", "Ежедневно с 08:30 до 17:30"],
      ["Текст кнопки «Получить консультацию»", "ctaText", "Получить консультацию"],
      ["Замени ссылку кнопки на https://example.com/request", "ctaLink", "https://example.com/request"]
    ];
    for (const [message, field, expected] of commands) {
      const proposed = await worker.dispatchFetch("https://worker.test/api/admin/assistant", {
        method: "POST",
        headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ message, history: [] })
      });
      const proposal = await json(proposed);
      assert.equal(proposal.kind, "proposal");
      assert.equal(proposal.usesAi, false);
      assert.equal(proposal.change.field, field);
      const applied = await worker.dispatchFetch("https://worker.test/api/admin/apply", {
        method: "POST",
        headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ token: proposal.token })
      });
      assert.equal(applied.status, 200);
      assert.equal((await json(applied)).config[field], expected);
    }

    const stateResponse = await worker.dispatchFetch("https://worker.test/api/admin/state", {
      headers: { Cookie: cookie }
    });
    const state = await json(stateResponse);
    assert.deepEqual(state.history.slice(0, 4).map((item) => item.version), [5, 4, 3, 2]);
    const linkHistory = state.history.find((item) => item.field === "ctaLink");
    const rollback = await worker.dispatchFetch("https://worker.test/api/admin/rollback", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ historyId: linkHistory.id })
    });
    assert.equal(rollback.status, 200);
    assert.equal((await json(rollback)).config.ctaLink, "https://example.com/booking");
  } finally {
    await worker.dispose();
  }
});

test("schedule, visibility, rollback and page check all work locally through the assistant", async () => {
  const worker = await createWorker();
  const originalFetch = globalThis.fetch;
  let aiCalls = 0;
  try {
    const database = await worker.getD1Database("DB");
    const env = directEnv(database, { async run() { aiCalls += 1; throw new Error("AI must stay off"); } });
    const login = await siteCare.fetch(new Request("https://worker.test/api/admin/login", {
      method: "POST",
      headers: { Origin: "https://worker.test", "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    }), env);
    const cookie = login.headers.get("Set-Cookie").split(";", 1)[0];
    const ask = (message) => siteCare.fetch(new Request("https://worker.test/api/admin/assistant", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message, history: [] })
    }), env);
    const apply = (token) => siteCare.fetch(new Request("https://worker.test/api/admin/apply", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    }), env);

    const schedule = await json(await ask("Сделай общий график дней с 10 до 20"));
    assert.equal(schedule.kind, "proposal");
    assert.equal(schedule.usesAi, false);
    assert.equal(schedule.change.field, "hours");
    assert.equal(schedule.change.after.split("\n").length, 7);
    const scheduleApplied = await json(await apply(schedule.token));
    assert.equal(scheduleApplied.config.hours.split("\n").length, 7);

    const repeatedSchedule = await json(await ask("Сделай общий график дней с 10 до 20"));
    assert.equal(repeatedSchedule.kind, "advice");
    assert.equal(repeatedSchedule.source, "rules");
    assert.equal(repeatedSchedule.usesAi, false);
    assert.match(repeatedSchedule.message, /уже установлено/iu);

    const enable = await json(await ask("Включи изменения на странице"));
    assert.equal(enable.kind, "proposal");
    assert.equal(enable.change.field, "enabled");
    assert.equal(enable.change.before, false);
    assert.equal(enable.change.after, true);
    assert.equal((await json(await apply(enable.token))).config.enabled, true);

    const undo = await json(await ask("Верни последний график"));
    assert.equal(undo.kind, "proposal");
    assert.equal(undo.change.field, "hours");
    assert.equal(undo.change.after, "Ежедневно, 10:00–20:00");
    assert.equal((await json(await apply(undo.token))).config.hours, "Ежедневно, 10:00–20:00");

    globalThis.fetch = async () => new Response(
      LOCK.blockIds.map((id) => `<div id="${id}"></div>`).join(""),
      { status: 200 }
    );
    const check = await json(await ask("Проверь страницу сейчас"));
    assert.equal(check.kind, "advice");
    assert.equal(check.source, "local-action");
    assert.equal(check.usesAi, false);
    assert.match(check.message, /все четыре закреплённых блока найдены/iu);

    assert.equal(aiCalls, 0);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(await database.prepare("SELECT request_count FROM ai_daily_usage WHERE day = ?").bind(today).first(), null);
  } finally {
    globalThis.fetch = originalFetch;
    await worker.dispose();
  }
});

test("AI can only create a confirmed allowlisted proposal and stops at the local daily limit", async () => {
  const worker = await createWorker();
  const originalFetch = globalThis.fetch;
  let aiCalls = 0;
  let receivedModel = "";
  let receivedMessages = [];
  let receivedFormat = null;
  try {
    const database = await worker.getD1Database("DB");
    globalThis.fetch = async () => new Response("<h1>Тестовая страница</h1><p>Запишитесь на консультацию</p>", { status: 200 });
    const env = directEnv(database, {
      async run(model, options) {
        aiCalls += 1;
        receivedModel = model;
        receivedMessages = options.messages;
        receivedFormat = options.response_format;
        return {
          response: {
            type: "edit",
            field: "hours",
            value: "По будням, 09:00–18:00",
            message: "Предлагаю уточнить часы. Применение потребует подтверждения."
          }
        };
      }
    });

    const login = await siteCare.fetch(new Request("https://worker.test/api/admin/login", {
      method: "POST",
      headers: { Origin: "https://worker.test", "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    }), env);
    assert.equal(login.status, 200);
    const cookie = login.headers.get("Set-Cookie").split(";", 1)[0];

    const confirmationResponse = await siteCare.fetch(new Request("https://worker.test/api/admin/assistant", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Предложи более понятный подзаголовок для страницы", history: [] })
    }), env);
    assert.equal(confirmationResponse.status, 200);
    const confirmation = await json(confirmationResponse);
    assert.equal(confirmation.kind, "ai-confirmation");
    assert.equal(confirmation.usesAi, false);
    assert.equal(confirmation.remaining, 20);
    assert.ok(confirmation.confirmationToken);
    assert.equal(aiCalls, 0);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(await database.prepare("SELECT request_count FROM ai_daily_usage WHERE day = ?").bind(today).first(), null);

    const booleanBypass = await siteCare.fetch(new Request("https://worker.test/api/admin/assistant", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Предложи более понятный подзаголовок для страницы",
        history: [],
        confirmAi: true
      })
    }), env);
    assert.equal((await json(booleanBypass)).kind, "ai-confirmation");
    assert.equal(aiCalls, 0);

    const mismatched = await siteCare.fetch(new Request("https://worker.test/api/admin/assistant", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Другой вопрос",
        history: [],
        aiConfirmationToken: confirmation.confirmationToken
      })
    }), env);
    assert.equal(mismatched.status, 401);
    assert.match((await json(mismatched)).error, /другому вопросу/iu);
    assert.equal(aiCalls, 0);

    const proposalResponse = await siteCare.fetch(new Request("https://worker.test/api/admin/assistant", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Предложи более понятный подзаголовок для страницы",
        history: [],
        aiConfirmationToken: confirmation.confirmationToken
      })
    }), env);
    assert.equal(proposalResponse.status, 200);
    const proposal = await json(proposalResponse);
    assert.equal(proposal.kind, "proposal");
    assert.equal(proposal.source, "ai");
    assert.equal(proposal.change.field, "hours");
    assert.equal(aiCalls, 1);
    assert.equal(receivedModel, AI_MODEL);
    assert.equal(receivedFormat.type, "json_schema");
    assert.match(receivedMessages.map((item) => item.content).join("\n"), /Тестовая страница/u);

    const beforeApply = await database.prepare("SELECT hours FROM site_config WHERE site_id = ?")
      .bind("ketedes-page169452909").first();
    assert.equal(beforeApply.hours, "Ежедневно, 10:00–20:00");

    const applied = await siteCare.fetch(new Request("https://worker.test/api/admin/apply", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ token: proposal.token })
    }), env);
    assert.equal(applied.status, 200);
    assert.equal((await json(applied)).config.hours, "По будням, 09:00–18:00");

    await database.prepare(
      "INSERT INTO ai_daily_usage (day, request_count, updated_at) VALUES (?, 20, ?) " +
        "ON CONFLICT(day) DO UPDATE SET request_count = 20, updated_at = excluded.updated_at"
    ).bind(today, new Date().toISOString()).run();
    const limited = await siteCare.fetch(new Request("https://worker.test/api/admin/assistant", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Что ещё улучшить?", history: [] })
    }), env);
    const limitedBody = await json(limited);
    assert.equal(limitedBody.limitReached, true);
    assert.equal(limitedBody.remaining, 0);
    assert.equal(aiCalls, 1);

    const direct = await siteCare.fetch(new Request("https://worker.test/api/admin/assistant", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Текст кнопки «Оставить заявку»", history: [] })
    }), env);
    const directBody = await json(direct);
    assert.equal(directBody.kind, "proposal");
    assert.equal(directBody.source, "rules");
    assert.equal(aiCalls, 1);

    const incomplete = await siteCare.fetch(new Request("https://worker.test/api/admin/assistant", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Измени телефон", history: [] })
    }), env);
    const incompleteBody = await json(incomplete);
    assert.equal(incompleteBody.kind, "advice");
    assert.equal(incompleteBody.source, "rules");
    assert.equal(incompleteBody.usesAi, false);
    assert.equal(aiCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await worker.dispose();
  }
});

test("the daily AI allowance cannot be exceeded by simultaneous requests", async () => {
  const worker = await createWorker();
  const originalFetch = globalThis.fetch;
  let aiCalls = 0;
  try {
    const database = await worker.getD1Database("DB");
    globalThis.fetch = async () => new Response("<h1>Тестовая страница</h1>", { status: 200 });
    const env = directEnv(database, {
      async run() {
        aiCalls += 1;
        return { response: { type: "advice", field: "none", value: "", message: "Проверенный совет." } };
      }
    });
    const login = await siteCare.fetch(new Request("https://worker.test/api/admin/login", {
      method: "POST",
      headers: { Origin: "https://worker.test", "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    }), env);
    const cookie = login.headers.get("Set-Cookie").split(";", 1)[0];
    const responses = await Promise.all(Array.from({ length: 25 }, (_, index) => siteCare.fetch(new Request(
      "https://worker.test/api/admin/assistant",
      {
        method: "POST",
        headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ message: `ИИ: Дай нестандартный совет номер ${index}`, history: [] })
      }
    ), env)));
    const bodies = await Promise.all(responses.map(json));
    assert.equal(bodies.filter((body) => body.usesAi === true).length, 20);
    assert.equal(bodies.filter((body) => body.limitReached === true).length, 5);
    assert.equal(aiCalls, 20);
    const today = new Date().toISOString().slice(0, 10);
    const usage = await database.prepare("SELECT request_count FROM ai_daily_usage WHERE day = ?").bind(today).first();
    assert.equal(usage.request_count, 20);
  } finally {
    globalThis.fetch = originalFetch;
    await worker.dispose();
  }
});

test("a site audit uses concrete local facts and spends no AI allowance", async () => {
  const worker = await createWorker();
  const originalFetch = globalThis.fetch;
  let aiCalls = 0;
  try {
    const database = await worker.getD1Database("DB");
    globalThis.fetch = async () => new Response("<h1>Тестовая страница</h1>", { status: 200 });
    const env = directEnv(database, {
      async run() {
        aiCalls += 1;
        return {
          response: {
            type: "advice",
            field: "none",
            value: "",
            message: "Добавьте информацию о компании, её услугах, изображения и видео."
          }
        };
      }
    });
    const login = await siteCare.fetch(new Request("https://worker.test/api/admin/login", {
      method: "POST",
      headers: { Origin: "https://worker.test", "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    }), env);
    const cookie = login.headers.get("Set-Cookie").split(";", 1)[0];
    const response = await siteCare.fetch(new Request("https://worker.test/api/admin/assistant", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Что можно улучшить на этой странице?", history: [] })
    }), env);
    const body = await json(response);
    assert.equal(response.status, 200);
    assert.equal(aiCalls, 0);
    assert.equal(body.source, "local-rules");
    assert.equal(body.usesAi, false);
    assert.equal(body.remaining, 20);
    assert.match(body.message, /Записаться на встречу/u);
    assert.match(body.message, /https:\/\/example\.com\/booking/u);
    assert.match(body.message, /\+7 \(495\) 555-24-10/u);
    assert.doesNotMatch(body.message, /изображен|видео/iu);
    const today = new Date().toISOString().slice(0, 10);
    const usage = await database.prepare("SELECT request_count FROM ai_daily_usage WHERE day = ?").bind(today).first();
    assert.equal(usage, null);
  } finally {
    globalThis.fetch = originalFetch;
    await worker.dispose();
  }
});

test("common owner questions stay local even when the AI quota already has usage", async () => {
  const worker = await createWorker();
  let aiCalls = 0;
  try {
    const database = await worker.getD1Database("DB");
    const env = directEnv(database, { async run() { aiCalls += 1; throw new Error("must not run"); } });
    const login = await siteCare.fetch(new Request("https://worker.test/api/admin/login", {
      method: "POST",
      headers: { Origin: "https://worker.test", "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    }), env);
    const cookie = login.headers.get("Set-Cookie").split(";", 1)[0];
    const today = new Date().toISOString().slice(0, 10);
    await database.prepare("INSERT INTO ai_daily_usage (day, request_count, updated_at) VALUES (?, 5, ?)")
      .bind(today, new Date().toISOString()).run();

    for (const message of [
      "Сайт сейчас работает?",
      "Что ты умеешь?",
      "Покажи текущие значения",
      "Какие изменения были внесены?",
      "Сколько осталось ИИ-запросов?",
      "Привет"
    ]) {
      const response = await siteCare.fetch(new Request("https://worker.test/api/admin/assistant", {
        method: "POST",
        headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ message, history: [] })
      }), env);
      const body = await json(response);
      assert.equal(response.status, 200);
      assert.equal(body.source, "local-rules");
      assert.equal(body.usesAi, false);
      assert.equal(body.remaining, 15);
    }
    assert.equal(aiCalls, 0);
    const usage = await database.prepare("SELECT request_count FROM ai_daily_usage WHERE day = ?").bind(today).first();
    assert.equal(usage.request_count, 5);
  } finally {
    await worker.dispose();
  }
});

test("login throttling, request limits and proposal protection reject unsafe requests", async () => {
  const worker = await createWorker();
  try {
    const wrongType = await worker.dispatchFetch("https://worker.test/api/admin/login", {
      method: "POST",
      headers: { Origin: "https://worker.test", "Content-Type": "text/plain" },
      body: "{}"
    });
    assert.equal(wrongType.status, 415);

    const oversized = await worker.dispatchFetch("https://worker.test/api/admin/login", {
      method: "POST",
      headers: { Origin: "https://worker.test", "Content-Type": "application/json" },
      body: JSON.stringify({ password: "x".repeat(17_000) })
    });
    assert.equal(oversized.status, 413);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await worker.dispatchFetch("https://worker.test/api/admin/login", {
        method: "POST",
        headers: {
          Origin: "https://worker.test",
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.10"
        },
        body: JSON.stringify({ password: "wrong-password" })
      });
      assert.equal(failed.status, 401);
    }
    const blocked = await worker.dispatchFetch("https://worker.test/api/admin/login", {
      method: "POST",
      headers: {
        Origin: "https://worker.test",
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.10"
      },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    });
    assert.equal(blocked.status, 429);

    const login = await worker.dispatchFetch("https://worker.test/api/admin/login", {
      method: "POST",
      headers: {
        Origin: "https://worker.test",
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.11"
      },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    });
    const cookie = login.headers.get("Set-Cookie").split(";", 1)[0];
    const proposalResponse = await worker.dispatchFetch("https://worker.test/api/admin/assistant", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Замени телефон на +7 (999) 000-11-22", history: [] })
    });
    const proposal = await json(proposalResponse);
    const [encodedProposal, proposalSignature] = proposal.token.split(".");
    const base64urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const finalSignatureIndex = base64urlAlphabet.indexOf(proposalSignature.at(-1));
    assert.equal(finalSignatureIndex % 4, 0);
    const nonCanonicalSignature = `${proposalSignature.slice(0, -1)}${base64urlAlphabet[finalSignatureIndex + 1]}`;
    const tamperedToken = `${encodedProposal}.${nonCanonicalSignature}`;
    const tampered = await worker.dispatchFetch("https://worker.test/api/admin/apply", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ token: tamperedToken })
    });
    assert.equal(tampered.status, 401);

    const applied = await worker.dispatchFetch("https://worker.test/api/admin/apply", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ token: proposal.token })
    });
    assert.equal(applied.status, 200);
    const replay = await worker.dispatchFetch("https://worker.test/api/admin/apply", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ token: proposal.token })
    });
    assert.equal(replay.status, 409);
  } finally {
    await worker.dispose();
  }
});

test("public configuration is cacheable only for the exact Tilda origin", async () => {
  const worker = await createWorker();
  try {
    const allowed = await worker.dispatchFetch("https://worker.test/api/public/config", {
      headers: { Origin: "https://ketedes.tilda.ws" }
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://ketedes.tilda.ws");
    const etag = allowed.headers.get("ETag");
    assert.ok(etag);

    const cached = await worker.dispatchFetch("https://worker.test/api/public/config", {
      headers: { Origin: "https://ketedes.tilda.ws", "If-None-Match": etag }
    });
    assert.equal(cached.status, 304);

    const denied = await worker.dispatchFetch("https://worker.test/api/public/config", {
      headers: { Origin: "https://attacker.example" }
    });
    assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);

    const preflight = await worker.dispatchFetch("https://worker.test/api/public/config", {
      method: "OPTIONS",
      headers: { Origin: "https://ketedes.tilda.ws" }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Methods"), "GET, OPTIONS");
  } finally {
    await worker.dispose();
  }
});

test("monitoring records health failures, blocks redirects and trims old results", async () => {
  const worker = await createWorker();
  const originalFetch = globalThis.fetch;
  try {
    const database = await worker.getD1Database("DB");
    const env = directEnv(database, null);
    const login = await siteCare.fetch(new Request("https://worker.test/api/admin/login", {
      method: "POST",
      headers: { Origin: "https://worker.test", "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    }), env);
    const cookie = login.headers.get("Set-Cookie").split(";", 1)[0];
    globalThis.fetch = async () => new Response(
      LOCK.blockIds.map((id) => `<div id="${id}"></div>`).join(""),
      { status: 200 }
    );
    const healthy = await siteCare.fetch(new Request("https://worker.test/api/admin/check", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    assert.equal((await json(healthy)).monitor.ok, true);

    globalThis.fetch = async () => new Response("temporary error", { status: 503 });
    const failed = await siteCare.fetch(new Request("https://worker.test/api/admin/check", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    const failedBody = await json(failed);
    assert.equal(failedBody.monitor.ok, false);
    assert.match(failedBody.monitor.details, /503/u);

    globalThis.fetch = async () => ({
      url: "https://attacker.example/redirected",
      status: 200,
      headers: new Headers(),
      body: null,
      async text() { return "redirected"; }
    });
    const redirected = await siteCare.fetch(new Request("https://worker.test/api/admin/check", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    assert.match((await json(redirected)).monitor.details, /за пределы разрешённого адреса/iu);

    globalThis.fetch = async () => new Response("small", {
      status: 200,
      headers: { "Content-Length": "1500001" }
    });
    const oversized = await siteCare.fetch(new Request("https://worker.test/api/admin/check", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    assert.match((await json(oversized)).monitor.details, /слишком большой/iu);

    const rows = await database.prepare("SELECT ok FROM monitor_runs WHERE site_id = ? ORDER BY id").bind(LOCK.siteId).all();
    assert.deepEqual(rows.results.map((row) => row.ok), [1, 0, 0, 0]);

    const now = new Date().toISOString();
    await database.batch(Array.from({ length: 205 }, (_, index) => database.prepare(
      "INSERT INTO monitor_runs (site_id, checked_at, ok, http_status, details) VALUES (?, ?, 1, 200, ?)"
    ).bind(LOCK.siteId, now, `old-${index}`)));
    globalThis.fetch = async () => new Response(
      LOCK.blockIds.map((id) => `<div id="${id}"></div>`).join(""),
      { status: 200 }
    );
    await siteCare.fetch(new Request("https://worker.test/api/admin/check", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    const count = await database.prepare("SELECT COUNT(*) AS total FROM monitor_runs WHERE site_id = ?").bind(LOCK.siteId).first();
    assert.equal(count.total, 200);
  } finally {
    globalThis.fetch = originalFetch;
    await worker.dispose();
  }
});

test("Telegram notifications connect without exposing the token and report failure plus recovery", async () => {
  const worker = await createWorker();
  const originalFetch = globalThis.fetch;
  const botToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
  try {
    const database = await worker.getD1Database("DB");
    const env = directEnv(database, null);
    const login = await siteCare.fetch(new Request("https://worker.test/api/admin/login", {
      method: "POST",
      headers: { Origin: "https://worker.test", "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    }), env);
    const cookie = login.headers.get("Set-Cookie").split(";", 1)[0];
    let connectCode = null;
    let pageHealthy = true;
    const telegramMessages = [];
    const healthyHtml = `${LOCK.blockIds.map((id) => `<div id="${id}"></div>`).join("")}
      <form id="lead" data-formactiontype="2"><input name="phone" data-tilda-rule="phone"><button type="submit">Отправить</button></form>`;

    globalThis.fetch = async (input, options = {}) => {
      const url = String(input);
      const parsedUrl = new URL(url);
      if (url === LOCK.targetUrl) {
        return pageHealthy
          ? new Response(healthyHtml, { status: 200 })
          : new Response("temporary error", { status: 503 });
      }
      if (parsedUrl.origin === "https://api.telegram.org" && parsedUrl.pathname === `/bot${botToken}/getMe`) {
        return Response.json({ ok: true, result: { id: 123456789, is_bot: true, username: "SiteCareOwnerBot" } });
      }
      if (parsedUrl.origin === "https://api.telegram.org" && parsedUrl.pathname === `/bot${botToken}/getUpdates`) {
        return Response.json({
          ok: true,
          result: connectCode
            ? [{ update_id: 1, message: { text: connectCode, chat: { id: 987654321, type: "private" } } }]
            : []
        });
      }
      if (parsedUrl.origin === "https://api.telegram.org" && parsedUrl.pathname === `/bot${botToken}/sendMessage`) {
        telegramMessages.push(options.body ? JSON.parse(options.body) : Object.fromEntries(parsedUrl.searchParams));
        return Response.json({ ok: true, result: { message_id: telegramMessages.length } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const started = await siteCare.fetch(new Request("https://worker.test/api/admin/notifications/telegram/start", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ botToken })
    }), env);
    const startedBody = await json(started);
    assert.equal(started.status, 200);
    assert.match(startedBody.code, /^\/sitecare_[a-z2-9]{10}$/u);
    connectCode = startedBody.code;

    const pendingState = await json(await siteCare.fetch(new Request("https://worker.test/api/admin/state", {
      headers: { Cookie: cookie }
    }), env));
    assert.equal(pendingState.notifications.configured, false);
    assert.equal(pendingState.notifications.connectionPending, true);
    assert.equal(JSON.stringify(pendingState).includes(botToken), false);
    assert.equal(JSON.stringify(pendingState).includes(connectCode), false);

    const confirmed = await siteCare.fetch(new Request("https://worker.test/api/admin/notifications/telegram/confirm", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    assert.equal(confirmed.status, 200);
    assert.equal(telegramMessages.length, 1);
    assert.match(telegramMessages[0].text, /SiteCare подключён/u);

    const stored = await database.prepare(
      "SELECT encrypted_bot_token, chat_id, connect_code_hash, enabled FROM notification_settings WHERE site_id = ?"
    ).bind(LOCK.siteId).first();
    assert.equal(stored.encrypted_bot_token.includes(botToken), false);
    assert.equal(stored.chat_id, "987654321");
    assert.equal(stored.connect_code_hash, null);
    assert.equal(stored.enabled, 1);

    await siteCare.fetch(new Request("https://worker.test/api/admin/check", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    assert.equal(telegramMessages.length, 1);

    pageHealthy = false;
    await siteCare.fetch(new Request("https://worker.test/api/admin/check", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    assert.equal(telegramMessages.length, 2);
    assert.match(telegramMessages[1].text, /страница недоступна/iu);

    pageHealthy = true;
    await siteCare.fetch(new Request("https://worker.test/api/admin/check", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    assert.equal(telegramMessages.length, 3);
    assert.match(telegramMessages[2].text, /снова работает/iu);

    const tested = await siteCare.fetch(new Request("https://worker.test/api/admin/notifications/telegram/test", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    assert.equal(tested.status, 200);
    assert.equal(telegramMessages.length, 4);

    const connectedState = await json(await siteCare.fetch(new Request("https://worker.test/api/admin/state", {
      headers: { Cookie: cookie }
    }), env));
    assert.equal(connectedState.notifications.configured, true);
    assert.equal(connectedState.notifications.destination, "личный чат");
    assert.equal(connectedState.notifications.lastDeliveryOk, true);
    assert.equal(connectedState.notifications.events.some((event) => event.eventType === "page-down"), true);
    assert.equal(JSON.stringify(connectedState).includes(botToken), false);

    const disconnected = await siteCare.fetch(new Request("https://worker.test/api/admin/notifications/telegram/disconnect", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    assert.equal(disconnected.status, 200);
    const disconnectedState = await json(await siteCare.fetch(new Request("https://worker.test/api/admin/state", {
      headers: { Cookie: cookie }
    }), env));
    assert.equal(disconnectedState.notifications.configured, false);
    assert.equal((await database.prepare("SELECT encrypted_bot_token FROM notification_settings WHERE site_id = ?").bind(LOCK.siteId).first()).encrypted_bot_token, null);
  } finally {
    globalThis.fetch = originalFetch;
    await worker.dispose();
  }
});

test("a site migrates to the shared SiteCareBot by deep link without receiving the bot token", async () => {
  const worker = await createWorker();
  const originalFetch = globalThis.fetch;
  const gatewayUrl = "https://sitecare-telegram-gateway.sitecare-test.workers.dev";
  const siteToken = "site-token-0123456789abcdef0123456789abcdef";
  const legacyBotToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
  try {
    const database = await worker.getD1Database("DB");
    const env = {
      ...directEnv(database, null),
      TELEGRAM_GATEWAY_URL: gatewayUrl,
      TELEGRAM_SITE_TOKEN: siteToken
    };
    const now = new Date().toISOString();
    const encryptedLegacyToken = await encryptTelegramBotToken(legacyBotToken, SESSION_SECRET);
    await database.prepare(
      "INSERT INTO notification_settings (site_id, encrypted_bot_token, chat_id, chat_type, enabled, updated_at) VALUES (?, ?, '123', 'private', 1, ?)"
    ).bind(LOCK.siteId, encryptedLegacyToken, now).run();
    const login = await siteCare.fetch(new Request("https://worker.test/api/admin/login", {
      method: "POST",
      headers: { Origin: "https://worker.test", "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    }), env);
    const cookie = login.headers.get("Set-Cookie").split(";", 1)[0];
    let linked = false;
    let gatewayUnavailable = false;
    let notificationNetworkFailures = 0;
    const gatewayCalls = [];
    const legacyMessages = [];
    globalThis.fetch = async (input, options = {}) => {
      const url = String(input);
      const parsed = new URL(url);
      if (parsed.origin === "https://api.telegram.org" && parsed.pathname === `/bot${legacyBotToken}/sendMessage`) {
        legacyMessages.push(options.body ? JSON.parse(options.body) : Object.fromEntries(parsed.searchParams));
        return Response.json({ ok: true, result: { message_id: legacyMessages.length } });
      }
      if (!url.startsWith(gatewayUrl)) throw new Error(`Unexpected fetch: ${url}`);
      if (gatewayUnavailable) throw new TypeError("temporary gateway outage");
      gatewayCalls.push({ url, options });
      assert.equal(options.headers.Authorization, `Bearer ${siteToken}`);
      assert.equal(String(options.body || "").includes(siteToken), false);
      if (url.endsWith("/status")) {
        return Response.json({
          ok: true,
          configured: linked,
          enabled: linked,
          destination: linked ? "личный чат" : null,
          botUsername: "OfficialSiteCareBot"
        });
      }
      if (url.endsWith("/connect")) {
        return Response.json({
          ok: true,
          connectUrl: "https://t.me/OfficialSiteCareBot?start=sc_abcdefghijklmnopqrstuvwxyz123456",
          botUsername: "OfficialSiteCareBot",
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
        });
      }
      if (url.endsWith("/notifications")) {
        if (notificationNetworkFailures > 0) {
          notificationNetworkFailures -= 1;
          throw new TypeError("response route interrupted");
        }
        return linked
          ? Response.json({ ok: true, sent: true })
          : Response.json({ ok: false, error: "Telegram для этого сайта ещё не подключён.", code: "NOT_LINKED" }, { status: 409 });
      }
      if (url.endsWith("/destination") && options.method === "DELETE") {
        linked = false;
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected gateway path: ${url}`);
    };

    const initialState = await json(await siteCare.fetch(new Request("https://worker.test/api/admin/state", {
      headers: { Cookie: cookie }
    }), env));
    assert.equal(initialState.notifications.connectionMode, "shared");
    assert.equal(initialState.notifications.configured, false);
    assert.equal(initialState.notifications.legacyConfigured, true);

    const fallbackTest = await siteCare.fetch(new Request("https://worker.test/api/admin/notifications/telegram/test", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    assert.equal(fallbackTest.status, 200);
    assert.equal(legacyMessages.length, 1);
    assert.match(legacyMessages[0].text, /Тест SiteCare/u);

    const started = await json(await siteCare.fetch(new Request("https://worker.test/api/admin/notifications/telegram/start", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env));
    assert.match(started.connectUrl, /^https:\/\/t\.me\/OfficialSiteCareBot\?start=/u);
    assert.equal(JSON.stringify(started).includes(siteToken), false);

    linked = true;
    const confirmed = await siteCare.fetch(new Request("https://worker.test/api/admin/notifications/telegram/confirm", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    assert.equal(confirmed.status, 200);
    const local = await database.prepare(
      "SELECT encrypted_bot_token, chat_id, enabled FROM notification_settings WHERE site_id = ?"
    ).bind(LOCK.siteId).first();
    assert.equal(local.encrypted_bot_token, null);
    assert.equal(local.chat_id, null);
    assert.equal(local.enabled, 1);

    notificationNetworkFailures = 1;
    const tested = await siteCare.fetch(new Request("https://worker.test/api/admin/notifications/telegram/test", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    assert.equal(tested.status, 200);
    const notificationCalls = gatewayCalls.filter((call) => call.url.endsWith("/notifications"));
    assert.equal(notificationCalls.length, 3);
    const notificationBody = JSON.parse(notificationCalls.at(-1).options.body);
    assert.equal(notificationBody.eventType, "test");
    assert.match(notificationBody.text, /Тест SiteCare/u);
    assert.equal(
      JSON.parse(notificationCalls.at(-2).options.body).eventId,
      notificationBody.eventId
    );
    assert.equal(legacyMessages.length, 1);

    const connectedState = await json(await siteCare.fetch(new Request("https://worker.test/api/admin/state", {
      headers: { Cookie: cookie }
    }), env));
    assert.equal(connectedState.notifications.configured, true);
    assert.equal(connectedState.notifications.destination, "личный чат");
    assert.equal(connectedState.notifications.botUsername, "OfficialSiteCareBot");
    assert.equal(JSON.stringify(connectedState).includes(siteToken), false);

    gatewayUnavailable = true;
    const outageState = await json(await siteCare.fetch(new Request("https://worker.test/api/admin/state", {
      headers: { Cookie: cookie }
    }), env));
    assert.equal(outageState.notifications.configured, true);
    assert.match(outageState.notifications.gatewayError, /SiteCareBot/iu);
    gatewayUnavailable = false;
  } finally {
    globalThis.fetch = originalFetch;
    await worker.dispose();
  }
});

test("form structure and a protected test delivery are verified without storing lead contents", async () => {
  const worker = await createWorker();
  const originalFetch = globalThis.fetch;
  try {
    const database = await worker.getD1Database("DB");
    const env = directEnv(database, null);
    const login = await siteCare.fetch(new Request("https://worker.test/api/admin/login", {
      method: "POST",
      headers: { Origin: "https://worker.test", "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    }), env);
    const cookie = login.headers.get("Set-Cookie").split(";", 1)[0];

    globalThis.fetch = async () => new Response(
      `${LOCK.blockIds.map((id) => `<div id="${id}"></div>`).join("")}
       <form id="lead-form"><input name="Name" required><input type="tel" name="Phone"><button type="submit">Отправить</button></form>`,
      { status: 200 }
    );
    const checked = await siteCare.fetch(new Request("https://worker.test/api/admin/forms/check", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    const checkedBody = await json(checked);
    assert.equal(checkedBody.monitor.ok, true);
    assert.equal(checkedBody.formMonitor.ok, true);
    assert.equal(checkedBody.formMonitor.formCount, 1);

    const addressResponse = await siteCare.fetch(new Request("https://worker.test/api/admin/forms/webhook-url", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    const address = (await json(addressResponse)).webhookUrl;
    assert.match(address, /^https:\/\/worker\.test\/api\/forms\/webhook\?token=/u);
    assert.doesNotMatch(address, new RegExp(FORM_WEBHOOK_SECRET));

    const unauthorized = await siteCare.fetch(new Request("https://worker.test/api/forms/webhook?token=wrong", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "Name=Someone"
    }), env);
    assert.equal(unauthorized.status, 401);

    const testResponse = await siteCare.fetch(new Request("https://worker.test/api/admin/forms/test", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    const testBody = await json(testResponse);
    assert.equal(testBody.markerKind, "text");
    const marker = testBody.marker;
    const privatePhone = "+79991112233";
    const privateEmail = "visitor-private@example.test";
    const delivered = await siteCare.fetch(new Request(address, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ formid: "lead-form", Name: marker, Phone: privatePhone, Email: privateEmail })
    }), env);
    assert.equal(delivered.status, 200);
    assert.deepEqual(await json(delivered), { ok: true });

    const stateResponse = await siteCare.fetch(new Request("https://worker.test/api/admin/state", {
      headers: { Cookie: cookie }
    }), env);
    const state = await json(stateResponse);
    assert.equal(state.forms.monitor.formCount, 1);
    assert.equal(state.forms.lastReceipt.matchedTest, true);
    assert.equal(state.forms.lastReceipt.formId, "lead-form");
    assert.equal(state.forms.recentReceipts.length, 1);
    assert.equal(state.forms.recentReceipts[0].formId, "lead-form");
    assert.equal(state.forms.testSession.status, "confirmed");
    assert.deepEqual(state.forms.lastReceipt.fieldNames, ["formid", "Name", "Phone", "Email"]);
    assert.doesNotMatch(JSON.stringify(state.forms), /79991112233|visitor-private|SITECARE-TEST/u);

    const receipt = await database.prepare("SELECT * FROM form_receipts ORDER BY id DESC LIMIT 1").first();
    const session = await database.prepare("SELECT * FROM form_test_sessions ORDER BY created_at DESC LIMIT 1").first();
    assert.doesNotMatch(JSON.stringify(receipt), /79991112233|visitor-private|SITECARE-TEST/u);
    assert.doesNotMatch(JSON.stringify(session), /SITECARE-TEST/u);

    globalThis.fetch = async () => new Response(
      `${LOCK.blockIds.map((id) => `<div id="${id}"></div>`).join("")}
       <form id="phone-only"><input name="phone" data-tilda-rule="phone" required><button type="submit">Отправить</button></form>`,
      { status: 200 }
    );
    await siteCare.fetch(new Request("https://worker.test/api/admin/forms/check", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    const phoneTestResponse = await siteCare.fetch(new Request("https://worker.test/api/admin/forms/test", {
      method: "POST",
      headers: { Origin: "https://worker.test", Cookie: cookie, "Content-Type": "application/json" },
      body: "{}"
    }), env);
    const phoneTest = await json(phoneTestResponse);
    assert.equal(phoneTest.markerKind, "phone");
    assert.match(phoneTest.marker, /^000\d{12}$/u);
    assert.match(phoneTest.instruction, /поле телефона/iu);

    const phoneDelivered = await siteCare.fetch(new Request(address, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ formid: "phone-only", phone: `+7 ${phoneTest.marker}` })
    }), env);
    assert.equal(phoneDelivered.status, 200);

    const phoneStateResponse = await siteCare.fetch(new Request("https://worker.test/api/admin/state", {
      headers: { Cookie: cookie }
    }), env);
    const phoneState = await json(phoneStateResponse);
    assert.equal(phoneState.forms.lastReceipt.formId, "phone-only");
    assert.equal(phoneState.forms.lastReceipt.matchedTest, true);
    assert.equal(phoneState.forms.recentReceipts.length, 2);
    assert.deepEqual(phoneState.forms.recentReceipts.map((item) => item.formId), ["phone-only", "lead-form"]);
    assert.equal(phoneState.forms.testSession.status, "confirmed");
    assert.equal(JSON.stringify(phoneState.forms).includes(phoneTest.marker), false);

    const phoneReceipt = await database.prepare("SELECT * FROM form_receipts ORDER BY id DESC LIMIT 1").first();
    const phoneSession = await database.prepare("SELECT * FROM form_test_sessions ORDER BY created_at DESC LIMIT 1").first();
    assert.equal(JSON.stringify(phoneReceipt).includes(phoneTest.marker), false);
    assert.equal(JSON.stringify(phoneSession).includes(phoneTest.marker), false);
  } finally {
    globalThis.fetch = originalFetch;
    await worker.dispose();
  }
});

test("database refuses two history records for the same configuration version", async () => {
  const worker = await createWorker();
  try {
    const database = await worker.getD1Database("DB");
    const insert = () => database.prepare(
      "INSERT INTO change_history (site_id, version, action, field, old_value, new_value, changed_at, changed_by) VALUES (?, 99, 'update', 'phone', '1', '2', ?, 'test')"
    ).bind(LOCK.siteId, new Date().toISOString()).run();
    await insert();
    await assert.rejects(insert());
  } finally {
    await worker.dispose();
  }
});
