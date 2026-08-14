import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SCOPE = Object.freeze({
  workerName: "sitecare-ketedes-page169452909",
  databaseName: "sitecare-ketedes-page169452909-db",
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

export const GATEWAY_SCOPE = Object.freeze({
  workerName: "sitecare-telegram-gateway",
  databaseName: "sitecare-telegram-gateway-db"
});

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, "wrangler.jsonc");
const GATEWAY_CONFIG_PATH = path.join(ROOT, "gateway", "wrangler.jsonc");
const LOADER_PATH = path.join(ROOT, "tilda-loader.html");
const RESULT_PATH = path.join(ROOT, "DEPLOYMENT-RESULT.txt");
const READY_CODE_PATH = path.join(ROOT, "TILDA-CODE-READY.txt");
const ERROR_PATH = path.join(ROOT, "DEPLOYMENT-ERROR.txt");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const BASE_ENV = Object.freeze({
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_SEND_ERROR_REPORTS: "false",
  WRANGLER_LOG_SANITIZE: "true"
});
const OAUTH_SCOPES = Object.freeze([
  "account:read",
  "user:read",
  "workers_scripts:write",
  "d1:write",
  "ai:write"
]);

let remoteWorkStarted = false;

function stripAnsi(value) {
  return String(value || "").replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
}

export function parseJsonOutput(rawOutput) {
  const output = stripAnsi(rawOutput).trim();
  if (!output) throw new Error("Cloudflare не вернул данные для проверки.");
  try {
    return JSON.parse(output);
  } catch {
    // Wrangler occasionally prints a short notice around otherwise valid JSON.
  }

  for (let start = 0; start < output.length; start += 1) {
    const opening = output[start];
    if (opening !== "{" && opening !== "[") continue;
    const stack = [];
    let quoted = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const character = output[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") quoted = false;
        continue;
      }
      if (character === "\"") {
        quoted = true;
        continue;
      }
      if (character === "{" || character === "[") stack.push(character);
      if (character === "}" || character === "]") {
        const expected = character === "}" ? "{" : "[";
        if (stack.pop() !== expected) break;
        if (stack.length === 0) {
          try {
            return JSON.parse(output.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error("Не удалось разобрать ответ Cloudflare.");
}

export function normalizeWhoami(raw) {
  const accounts = Array.isArray(raw?.accounts)
    ? raw.accounts.map((account) => ({
        id: String(account.id || account.accountId || account.account_id || ""),
        name: String(account.name || account.accountName || account.account_name || "Без названия")
      })).filter((account) => account.id)
    : [];
  return {
    loggedIn: Boolean(raw?.loggedIn ?? raw?.logged_in ?? accounts.length),
    authType: String(raw?.authType || raw?.auth_type || ""),
    email: String(raw?.email || raw?.user?.email || ""),
    accounts,
    tokenPermissions: Array.isArray(raw?.tokenPermissions)
      ? raw.tokenPermissions.map((permission) => String(permission))
      : []
  };
}

export function missingOauthScopes(identity) {
  if (identity?.authType !== "OAuth Token") return [];
  const permissions = new Set(identity.tokenPermissions || []);
  return OAUTH_SCOPES.filter((scope) => !permissions.has(scope));
}

function databaseList(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.result)) return raw.result;
  if (Array.isArray(raw?.databases)) return raw.databases;
  return [];
}

export function findExactDatabase(raw, databaseName = SCOPE.databaseName) {
  const matches = databaseList(raw).filter((database) => database?.name === databaseName);
  if (matches.length > 1) throw new Error(`Найдено несколько баз с именем ${databaseName}. Установка остановлена.`);
  if (matches.length === 0) return null;
  const database = matches[0];
  const id = String(database.uuid || database.id || database.database_id || "");
  if (!id) throw new Error("У найденной базы отсутствует идентификатор.");
  return { id, name: databaseName };
}

export function validateProjectConfig(config) {
  const allowedTopLevelKeys = new Set([
    "$schema",
    "name",
    "main",
    "compatibility_date",
    "workers_dev",
    "preview_urls",
    "observability",
    "ai",
    "vars",
    "d1_databases",
    "triggers",
    "account_id"
  ]);
  const unexpectedKeys = Object.keys(config || {}).filter((key) => !allowedTopLevelKeys.has(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(`Обнаружены лишние возможности Cloudflare: ${unexpectedKeys.join(", ")}. Установка остановлена.`);
  }
  const expectedVars = {
    SITE_ID: SCOPE.siteId,
    ALLOWED_ORIGIN: SCOPE.origin,
    ALLOWED_HOSTNAME: SCOPE.hostname,
    ALLOWED_PATH: SCOPE.pathname,
    SESSION_HOURS: "12"
  };
  if (config?.name !== SCOPE.workerName || config?.main !== "src/index.js") {
    throw new Error("Имя Worker или главный файл были изменены. Установка остановлена.");
  }
  if (config?.compatibility_date !== "2026-08-04" || config?.preview_urls !== false) {
    throw new Error("Системные настройки Worker были изменены. Установка остановлена.");
  }
  if (config?.observability?.enabled !== true || Object.keys(config.observability || {}).length !== 1) {
    throw new Error("Настройка журналов Worker была изменена. Установка остановлена.");
  }
  if (
    config?.ai?.binding !== "AI" ||
    Object.keys(config.ai || {}).length !== 1
  ) {
    throw new Error("Настройка ИИ не совпадает с этим проектом. Установка остановлена.");
  }
  for (const [key, value] of Object.entries(expectedVars)) {
    if (config?.vars?.[key] !== value) throw new Error(`Защита проекта не прошла проверку: ${key}.`);
  }
  const gatewayUrl = String(config?.vars?.TELEGRAM_GATEWAY_URL || "");
  if (
    gatewayUrl !== "https://PUT-YOUR-GATEWAY.workers.dev" &&
    !/^https:\/\/sitecare-telegram-gateway\.[a-z0-9-]+\.workers\.dev$/u.test(gatewayUrl)
  ) {
    throw new Error("Адрес общего SiteCareBot не прошёл проверку.");
  }
  if (Object.keys(config?.vars || {}).length !== Object.keys(expectedVars).length + 1) {
    throw new Error("В Worker обнаружены лишние переменные. Установка остановлена.");
  }
  const databases = config?.d1_databases;
  if (
    !Array.isArray(databases) ||
    databases.length !== 1 ||
    databases[0]?.binding !== "DB" ||
    databases[0]?.database_name !== SCOPE.databaseName ||
    databases[0]?.migrations_dir !== "migrations"
  ) {
    throw new Error("Настройка базы не совпадает с этим проектом. Установка остановлена.");
  }
  const allowedDatabaseKeys = new Set(["binding", "database_name", "database_id", "migrations_dir"]);
  if (Object.keys(databases[0]).some((key) => !allowedDatabaseKeys.has(key))) {
    throw new Error("В настройке базы обнаружены лишние возможности. Установка остановлена.");
  }
  if (config?.workers_dev !== true) {
    throw new Error("Обнаружен домен или маршрут вне безопасной конфигурации.");
  }
  const crons = config?.triggers?.crons;
  if (!Array.isArray(crons) || crons.length !== 1 || crons[0] !== "*/30 * * * *") {
    throw new Error("Расписание проверки страницы было изменено.");
  }
  return true;
}

export function validateGatewayConfig(config) {
  const allowedTopLevelKeys = new Set([
    "$schema",
    "name",
    "main",
    "compatibility_date",
    "workers_dev",
    "preview_urls",
    "observability",
    "ai",
    "assets",
    "vars",
    "d1_databases",
    "triggers",
    "account_id"
  ]);
  const unexpectedKeys = Object.keys(config || {}).filter((key) => !allowedTopLevelKeys.has(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(`В шлюзе Telegram обнаружены лишние возможности Cloudflare: ${unexpectedKeys.join(", ")}.`);
  }
  if (config?.name !== GATEWAY_SCOPE.workerName || config?.main !== "src/index.js") {
    throw new Error("Имя или главный файл шлюза Telegram были изменены.");
  }
  if (
    config?.compatibility_date !== "2026-08-04" ||
    config?.workers_dev !== true ||
    config?.preview_urls !== false ||
    config?.observability?.enabled !== true ||
    Object.keys(config.observability || {}).length !== 1
  ) {
    throw new Error("Системные настройки шлюза Telegram были изменены.");
  }
  if (config?.ai?.binding !== "AI" || Object.keys(config.ai || {}).length !== 1) {
    throw new Error("Настройка помощника SiteCare в центральном шлюзе была изменена.");
  }
  if (config?.assets?.directory !== "./public" || Object.keys(config.assets || {}).length !== 1) {
    throw new Error("Папка изображений интерфейса SiteCare была изменена.");
  }
  if (
    Object.keys(config?.vars || {}).length !== 2 ||
    config?.vars?.CONNECT_TTL_MINUTES !== "15" ||
    config?.vars?.OPENAI_MODEL !== "gpt-5-mini"
  ) {
    throw new Error("Настройки центрального помощника были изменены.");
  }
  const crons = config?.triggers?.crons;
  if (!Array.isArray(crons) || crons.length !== 1 || crons[0] !== "*/5 * * * *") {
    throw new Error("Расписание центрального мониторинга было изменено.");
  }
  const databases = config?.d1_databases;
  if (
    !Array.isArray(databases) ||
    databases.length !== 1 ||
    databases[0]?.binding !== "GATEWAY_DB" ||
    databases[0]?.database_name !== GATEWAY_SCOPE.databaseName ||
    databases[0]?.migrations_dir !== "migrations"
  ) {
    throw new Error("База шлюза Telegram не совпадает с проектом.");
  }
  const allowedDatabaseKeys = new Set(["binding", "database_name", "database_id", "migrations_dir"]);
  if (Object.keys(databases[0]).some((key) => !allowedDatabaseKeys.has(key))) {
    throw new Error("В базе шлюза Telegram обнаружены лишние возможности.");
  }
  return true;
}

export function buildPinnedGatewayConfig(config, accountId, databaseId = null) {
  validateGatewayConfig(config);
  if (!accountId) throw new Error("Не выбран аккаунт Cloudflare для шлюза Telegram.");
  const result = structuredClone(config);
  result.account_id = accountId;
  if (databaseId) result.d1_databases[0].database_id = databaseId;
  return result;
}

export function buildPinnedConfig(config, accountId, databaseId = null, gatewayUrl = null) {
  validateProjectConfig(config);
  if (!accountId) throw new Error("Не выбран аккаунт Cloudflare.");
  const result = structuredClone(config);
  result.account_id = accountId;
  if (databaseId) result.d1_databases[0].database_id = databaseId;
  if (gatewayUrl) {
    if (!/^https:\/\/sitecare-telegram-gateway\.[a-z0-9-]+\.workers\.dev$/u.test(gatewayUrl)) {
      throw new Error("Некорректный адрес общего SiteCareBot.");
    }
    result.vars.TELEGRAM_GATEWAY_URL = gatewayUrl;
  }
  return result;
}

export function extractWorkerUrl(entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  for (const entry of [...list].reverse()) {
    if (entry?.type !== "deploy" || !Array.isArray(entry.targets)) continue;
    const target = entry.targets.find((value) => /^https:\/\/[a-z0-9.-]+\.workers\.dev\/?$/iu.test(String(value)));
    if (target) return String(target).replace(/\/$/u, "");
  }
  return "";
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function ask(question) {
  const interfaceHandle = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await interfaceHandle.question(question)).trim();
  } finally {
    interfaceHandle.close();
  }
}

async function readHidden(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Пароль можно вводить только в обычном окне запуска START-SITECARE.bat.");
  }
  process.stdout.write(question);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.setRawMode(true);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") return finish(new Error("Запуск остановлен пользователем."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\b" || character === "\u007f") {
          if (value.length > 0) {
            value = [...value].slice(0, -1).join("");
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " ") {
          value += character;
          process.stdout.write("*");
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function choosePassword() {
  section("Пароль панели SiteCare");
  console.log("Он не показывается на экране, не записывается в файлы и не передаётся в этот чат.");
  while (true) {
    const first = await readHidden("Введите новый пароль (минимум 12 символов): ");
    if (first.length < 12 || first.length > 200 || !/[A-Za-zА-Яа-яЁё]/u.test(first) || !/\d/u.test(first)) {
      console.log("Нужно от 12 до 200 символов, минимум одна буква и одна цифра. Попробуйте ещё раз.");
      continue;
    }
    const second = await readHidden("Повторите пароль: ");
    if (first !== second) {
      console.log("Пароли не совпали. Попробуйте ещё раз.");
      continue;
    }
    return first;
  }
}

async function choosePlatformEmail(defaultEmail = "") {
  section("Владелец центральной панели");
  console.log("Эта почта будет логином владельца SiteCare. Письмо на неё не отправляется.");
  while (true) {
    const suffix = defaultEmail ? ` [${defaultEmail}]` : "";
    const answer = await ask(`Электронная почта${suffix}: `);
    const email = (answer || defaultEmail).trim().toLocaleLowerCase("en-US");
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(email) && email.length <= 254) return email;
    console.log("Укажите корректную электронную почту.");
  }
}

async function chooseTelegramBotToken() {
  section("Официальный SiteCareBot");
  console.log("Введите токен уже созданного бота один раз. Он не показывается на экране и будет сохранён только как секрет центрального Worker.");
  console.log("Не отправляйте токен в чат и не записывайте его в файлы проекта.");
  while (true) {
    const token = (await readHidden("Токен бота из BotFather: ")).trim();
    if (/^\d{5,20}:[A-Za-z0-9_-]{30,100}$/u.test(token)) return token;
    console.log("Токен выглядит неполным. Скопируйте его целиком из BotFather и попробуйте ещё раз.");
  }
}

async function chooseResendApiKey({ allowSkip = true } = {}) {
  section("Восстановление пароля по почте");
  console.log("SiteCare отправляет одноразовые ссылки через Resend. Ключ хранится только в секрете центрального Worker.");
  console.log("Создать ключ: https://resend.com/api-keys");
  console.log("Не отправляйте ключ в чат и не записывайте его в файлы проекта.");
  if (allowSkip) console.log("Если почту нужно подключить позже, просто нажмите Enter.");
  while (true) {
    const key = (await readHidden("API-ключ Resend (re_...): ")).trim();
    if (!key && allowSkip) return null;
    if (/^re_[A-Za-z0-9_-]{10,200}$/u.test(key)) return key;
    console.log("Ключ выглядит неполным. Скопируйте его целиком из Resend и попробуйте ещё раз.");
  }
}

async function chooseOpenAiApiKey({ allowSkip = true } = {}) {
  section("Полноценный AI-помощник SiteCare");
  console.log("Нужен отдельный ключ OpenAI API. Подписка ChatGPT Plus не является API-ключом и здесь не используется.");
  console.log("Создать ключ: https://platform.openai.com/api-keys");
  console.log("Ключ хранится только как зашифрованный секрет центрального Worker и не попадает в браузер клиента.");
  if (allowSkip) console.log("Можно нажать Enter и подключить ключ позже командой wrangler secret put OPENAI_API_KEY --name sitecare-telegram-gateway.");
  while (true) {
    const key = (await readHidden("API-ключ OpenAI (sk-...): ")).trim();
    if (!key && allowSkip) return null;
    if (/^sk-[A-Za-z0-9_-]{16,280}$/u.test(key)) return key;
    console.log("Ключ выглядит неполным. Скопируйте его целиком из OpenAI Platform и попробуйте ещё раз.");
  }
}

async function chooseEmailFrom() {
  const fallback = "SiteCare <onboarding@resend.dev>";
  console.log("Без своего домена оставьте стандартного отправителя: он подходит для письма владельцу аккаунта Resend.");
  console.log("Для писем другим клиентам позже укажите подтверждённый домен Resend.");
  while (true) {
    const answer = await ask(`Отправитель [${fallback}]: `);
    const from = (answer || fallback).trim();
    const named = /<([^<>]+)>$/u.exec(from);
    const address = (named?.[1] || from).trim();
    if (/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]{2,}$/u.test(address) && from.length <= 254) return from;
    console.log("Укажите адрес вида support@example.com или SiteCare <support@example.com>.");
  }
}

async function run(command, args, options = {}) {
  const {
    allowFailure = false,
    echo = true,
    env = {},
    input,
    inherit = false
  } = options;
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...BASE_ENV, ...env },
    shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd"),
    stdio: inherit ? "inherit" : [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: false
  });
  if (inherit) {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0 && !allowFailure) throw new Error(`Команда ${command} завершилась с ошибкой ${code}.`);
    return { code, stdout: "", stderr: "" };
  }

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (echo) process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (echo) process.stderr.write(chunk);
  });
  if (input !== undefined) child.stdin.end(`${input}\n`);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0 && !allowFailure) {
    const detail = stripAnsi(stderr || stdout).trim().split("\n").slice(-4).join(" ");
    throw new Error(detail || `Команда ${command} завершилась с ошибкой ${code}.`);
  }
  return { code, stdout, stderr };
}

function wrangler(args, options = {}) {
  return run(NPX, ["--no-install", "wrangler", ...args], options);
}

async function readConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

async function readGatewayConfig() {
  return JSON.parse(await readFile(GATEWAY_CONFIG_PATH, "utf8"));
}

async function writeConfig(config) {
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function writeGatewayConfig(config) {
  await writeFile(GATEWAY_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function preflight() {
  section("Проверка файлов без публикации");
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 19)) {
    throw new Error("Нужен актуальный Node.js LTS версии 22.19 или новее: https://nodejs.org/en/download");
  }
  validateProjectConfig(await readConfig());
  validateGatewayConfig(await readGatewayConfig());
  console.log("1/3 Устанавливаю закреплённые служебные компоненты...");
  await run(NPM, ["ci", "--no-audit", "--no-fund"]);
  console.log("2/3 Проверяю защиту и сценарии возврата...");
  await run(NPM, ["run", "check"]);
  console.log("3/3 Выполняю пробную сборку без подключения к Cloudflare...");
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "sitecare-preflight-"));
  try {
    await wrangler(["deploy", "--dry-run", "--outdir", outputDirectory]);
    await wrangler(["deploy", "--dry-run", "--config", "gateway/wrangler.jsonc", "--outdir", path.join(outputDirectory, "gateway")]);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
  console.log("Локальная проверка пройдена. В Cloudflare пока ничего не создано.");
}

async function whoami() {
  const response = await wrangler(["whoami", "--json"], { allowFailure: true, echo: false });
  if (response.code !== 0) return { loggedIn: false, authType: "", email: "", accounts: [], tokenPermissions: [] };
  return normalizeWhoami(parseJsonOutput(response.stdout));
}

async function loginIfNeeded() {
  let identity = await whoami();
  const missingScopes = missingOauthScopes(identity);
  if (!identity.loggedIn || identity.accounts.length === 0 || missingScopes.length > 0) {
    section(missingScopes.length > 0 ? "Разрешение для ИИ" : "Вход в Cloudflare");
    console.log("Сейчас откроется обычный браузер. ChatGPT и облачный браузер здесь не участвуют.");
    console.log("Запрашиваются только: имя аккаунта, Worker этого проекта, его база D1 и запуск ИИ.");
    if (missingScopes.length > 0) console.log("Это одноразовое обновление уже выполненного входа. Доступ к доменам и Tilda не добавляется.");
    await wrangler(["login", "--use-keyring", "--scopes", ...OAUTH_SCOPES], { inherit: true });
    identity = await whoami();
  }
  if (!identity.loggedIn || identity.accounts.length === 0) {
    throw new Error("Вход выполнен, но Cloudflare не показал доступный аккаунт.");
  }
  const stillMissing = missingOauthScopes(identity);
  if (stillMissing.length > 0) {
    throw new Error(`Cloudflare не выдал нужное разрешение: ${stillMissing.join(", ")}. Повторите запуск и подтвердите доступ в браузере.`);
  }
  return identity;
}

async function selectAccount() {
  while (true) {
    const identity = await loginIfNeeded();
    section("Подтверждение аккаунта");
    if (identity.email) console.log(`Вход: ${identity.email}`);
    identity.accounts.forEach((account, index) => console.log(`${index + 1}. ${account.name}`));
    if (identity.accounts.length === 1) {
      const answer = (await ask("Введите ДА, чтобы выбрать этот аккаунт, или 0 для другого входа: ")).toLocaleLowerCase("ru-RU");
      if (answer === "да") return { account: identity.accounts[0], email: identity.email };
      if (answer !== "0") throw new Error("Аккаунт не подтверждён. В Cloudflare ничего не создано.");
    } else {
      const answer = await ask("Введите номер нужного аккаунта или 0 для другого входа: ");
      const number = Number(answer);
      if (Number.isInteger(number) && number >= 1 && number <= identity.accounts.length) {
        const selected = identity.accounts[number - 1];
        const confirm = (await ask(`Выбран «${selected.name}». Для подтверждения введите ДА: `)).toLocaleLowerCase("ru-RU");
        if (confirm === "да") return { account: selected, email: identity.email };
        throw new Error("Аккаунт не подтверждён. В Cloudflare ничего не создано.");
      }
      if (answer !== "0") throw new Error("Неверный номер. В Cloudflare ничего не создано.");
    }
    console.log("Выход из текущего Cloudflare-входа...");
    await wrangler(["logout"], { inherit: true, allowFailure: true });
  }
}

function cloudflareEnv(accountId, extra = {}) {
  return { CLOUDFLARE_ACCOUNT_ID: accountId, ...extra };
}

async function listDatabases(accountId) {
  const response = await wrangler(["d1", "list", "--json"], {
    echo: false,
    env: cloudflareEnv(accountId)
  });
  return parseJsonOutput(response.stdout);
}

async function workerExists(accountId, workerName = SCOPE.workerName) {
  const response = await wrangler(["deployments", "list", "--name", workerName, "--json"], {
    allowFailure: true,
    echo: false,
    env: cloudflareEnv(accountId)
  });
  if (response.code === 0) {
    const raw = parseJsonOutput(response.stdout);
    const deployments = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.result)
        ? raw.result
        : Array.isArray(raw?.deployments)
          ? raw.deployments
          : [];
    return deployments.length > 0;
  }
  const message = stripAnsi(`${response.stdout}\n${response.stderr}`);
  if (/not found|does not exist|no deployments|10090|service_not_found/iu.test(message)) return false;
  throw new Error("Cloudflare не позволил безопасно проверить наличие Worker. Создание остановлено.");
}

export function workerSecretNames(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.result)
      ? raw.result
      : Array.isArray(raw?.secrets)
        ? raw.secrets
        : [];
  return new Set(list.map((secret) => String(secret?.name || "")).filter(Boolean));
}

async function listWorkerSecrets(accountId, workerName = SCOPE.workerName) {
  const response = await wrangler(["secret", "list", "--name", workerName, "--format", "json"], {
    echo: false,
    env: cloudflareEnv(accountId)
  });
  return workerSecretNames(parseJsonOutput(response.stdout));
}

async function inspectRemote(accountId) {
  section("Проверка точных ресурсов");
  const databases = await listDatabases(accountId);
  const database = findExactDatabase(databases);
  const gatewayDatabase = findExactDatabase(databases, GATEWAY_SCOPE.databaseName);
  const [worker, gatewayWorker] = await Promise.all([
    workerExists(accountId),
    workerExists(accountId, GATEWAY_SCOPE.workerName)
  ]);
  const [secrets, gatewaySecrets] = await Promise.all([
    worker ? listWorkerSecrets(accountId) : Promise.resolve(new Set()),
    gatewayWorker ? listWorkerSecrets(accountId, GATEWAY_SCOPE.workerName) : Promise.resolve(new Set())
  ]);
  const secretsConfigured = secrets.has("ADMIN_PASSWORD") && secrets.has("SESSION_SECRET");
  const formWebhookConfigured = secrets.has("FORM_WEBHOOK_SECRET");
  const siteGatewayConfigured = secrets.has("TELEGRAM_SITE_TOKEN");
  const gatewayBotConfigured = gatewaySecrets.has("TELEGRAM_BOT_TOKEN");
  const gatewayWebhookConfigured = gatewaySecrets.has("TELEGRAM_WEBHOOK_SECRET");
  const gatewayEmailConfigured = gatewaySecrets.has("RESEND_API_KEY");
  const gatewayEmailFromConfigured = gatewaySecrets.has("SITECARE_EMAIL_FROM");
  const gatewayLeadsKeyConfigured = gatewaySecrets.has("LEADS_DATA_KEY");
  const gatewayOpenAiConfigured = gatewaySecrets.has("OPENAI_API_KEY");
  console.log(`База ${SCOPE.databaseName}: ${database ? "уже есть — будет продолжена" : "будет создана"}.`);
  console.log(`Worker ${SCOPE.workerName}: ${worker ? "уже есть — будет обновлён" : "будет создан"}.`);
  console.log(`Общий бот ${GATEWAY_SCOPE.workerName}: ${gatewayWorker ? "уже есть — будет обновлён" : "будет создан"}.`);
  console.log(`База общего бота ${GATEWAY_SCOPE.databaseName}: ${gatewayDatabase ? "уже есть — будет продолжена" : "будет создана"}.`);
  if (worker) {
    console.log(`Пароль панели: ${secretsConfigured ? "останется прежним" : "защиту нужно будет настроить заново"}.`);
    console.log(`Защита приёма форм: ${formWebhookConfigured ? "уже есть — ключ останется прежним" : "будет добавлена"}.`);
  }
  if (gatewayWorker) {
    console.log(`Токен общего бота: ${gatewayBotConfigured ? "уже установлен — останется прежним" : "нужно будет ввести один раз"}.`);
    console.log(`Восстановление пароля по почте: ${gatewayEmailConfigured ? "настроено — будет проверено тестовым письмом" : "ещё не подключено"}.`);
    console.log(`Защита заявок: ${gatewayLeadsKeyConfigured ? "ключ уже установлен — останется прежним" : "будет создан отдельный постоянный ключ"}.`);
    console.log(`AI-помощник: ${gatewayOpenAiConfigured ? "OpenAI API подключён — ключ останется прежним" : "нужно добавить отдельный API-ключ"}.`);
  }
  return {
    database,
    worker,
    secretsConfigured,
    formWebhookConfigured,
    siteGatewayConfigured,
    gatewayDatabase,
    gatewayWorker,
    gatewayBotConfigured,
    gatewayWebhookConfigured,
    gatewayEmailConfigured,
    gatewayEmailFromConfigured,
    gatewayLeadsKeyConfigured,
    gatewayOpenAiConfigured
  };
}

async function createDatabase(accountId, databaseName = SCOPE.databaseName) {
  console.log(`Создаю базу ${databaseName} в европейском регионе...`);
  const creation = await wrangler(["d1", "create", databaseName, "--location", "eeur"], {
    allowFailure: true,
    env: cloudflareEnv(accountId)
  });
  if (creation.code !== 0) {
    console.log("Команда создания вернула ошибку; проверяю, не успела ли база создаться...");
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const database = findExactDatabase(await listDatabases(accountId), databaseName);
    if (database) return database;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("База не появилась в списке Cloudflare. Повторный запуск безопасно продолжит проверку.");
}

async function applyMigration(accountId, databaseName = SCOPE.databaseName, configPath = null) {
  section(databaseName === GATEWAY_SCOPE.databaseName ? "Подготовка базы общего бота" : "Подготовка базы сайта");
  const args = ["d1", "migrations", "apply", databaseName, "--remote"];
  if (configPath) args.push("--config", configPath);
  await wrangler(args, {
    env: cloudflareEnv(accountId, { CI: "true" })
  });
}

async function deployWorker(accountId, workerName = SCOPE.workerName, configPath = null) {
  section(workerName === GATEWAY_SCOPE.workerName ? "Публикация общего SiteCareBot" : "Публикация Worker сайта");
  const suggestion = `sitecare-${accountId.slice(0, 8).toLowerCase()}`;
  console.log("Если Cloudflare впервые задаст три вопроса на английском:");
  console.log("1. Would you like to register... — ответьте y");
  console.log(`2. What would you like... — можно ввести ${suggestion}`);
  console.log("3. Ok to proceed? — ответьте y");
  console.log("Это создаёт бесплатный адрес workers.dev и не затрагивает Tilda или домены.");

  const outputDirectory = await mkdtemp(path.join(tmpdir(), "sitecare-wrangler-"));
  const outputPath = path.join(outputDirectory, "deploy.jsonl");
  try {
    const args = ["deploy", "--name", workerName];
    if (configPath) args.push("--config", configPath);
    await wrangler(args, {
      inherit: true,
      env: cloudflareEnv(accountId, { WRANGLER_OUTPUT_FILE_PATH: outputPath })
    });
    const lines = (await readFile(outputPath, "utf8")).split(/\r?\n/u).filter(Boolean);
    const entries = lines.map((line) => JSON.parse(line));
    const workerUrl = extractWorkerUrl(entries);
    if (!workerUrl) throw new Error("Worker опубликован, но Cloudflare не вернул его адрес. Повторите запуск.");
    return workerUrl;
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

async function putSecrets(accountId, values, workerName = SCOPE.workerName) {
  const entries = Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === "string" && value.length > 0));
  if (Object.keys(entries).length === 0) return;
  await wrangler(["secret", "bulk", "--name", workerName], {
    echo: true,
    env: cloudflareEnv(accountId, { CI: "true" }),
    input: JSON.stringify(entries)
  });
}

export function gatewaySecretEntries(current, { adminToken, botToken, webhookToken, leadsDataKey, resendApiKey, emailFrom, openAiApiKey }) {
  const entries = { GATEWAY_ADMIN_TOKEN: adminToken };
  if (!current.gatewayBotConfigured && botToken) entries.TELEGRAM_BOT_TOKEN = botToken;
  if (!current.gatewayWebhookConfigured && webhookToken) entries.TELEGRAM_WEBHOOK_SECRET = webhookToken;
  if (!current.gatewayLeadsKeyConfigured && leadsDataKey) entries.LEADS_DATA_KEY = leadsDataKey;
  if (resendApiKey) {
    entries.RESEND_API_KEY = resendApiKey;
    entries.SITECARE_EMAIL_FROM = emailFrom;
  }
  if (!current.gatewayOpenAiConfigured && openAiApiKey) entries.OPENAI_API_KEY = openAiApiKey;
  return entries;
}

async function configureGatewaySecrets(accountId, current, { botToken, resendApiKey, emailFrom, openAiApiKey }) {
  section("Защита общего SiteCareBot");
  if (!current.gatewayBotConfigured && !botToken) throw new Error("Для первого запуска общего SiteCareBot нужен токен бота.");
  const adminToken = randomBytes(48).toString("base64url");
  const entries = gatewaySecretEntries(current, {
    adminToken,
    botToken,
    webhookToken: randomBytes(48).toString("base64url"),
    leadsDataKey: randomBytes(48).toString("base64url"),
    resendApiKey,
    emailFrom,
    openAiApiKey
  });
  await putSecrets(accountId, entries, GATEWAY_SCOPE.workerName);
  console.log("Служебные ключи центрального Worker записаны одной операцией и не сохраняются в файлах.");
  return { adminToken, passwordEmailConfigured: current.gatewayEmailConfigured || Boolean(resendApiKey) };
}

async function configureSiteSecrets(accountId, current, { adminPassword, siteToken }) {
  section("Защита Worker сайта");
  const entries = { TELEGRAM_SITE_TOKEN: siteToken };
  if (adminPassword) {
    entries.SESSION_SECRET = randomBytes(48).toString("base64url");
    entries.ADMIN_PASSWORD = adminPassword;
  }
  if (!current.formWebhookConfigured) entries.FORM_WEBHOOK_SECRET = randomBytes(48).toString("base64url");
  await putSecrets(accountId, entries, SCOPE.workerName);
  console.log("Все новые секреты Worker сайта записаны одной операцией.");
}

export async function waitForGatewayAdminAccess(gatewayUrl, adminToken, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxAttempts = Number.isInteger(options.maxAttempts) ? options.maxAttempts : 30;
  let lastError = "нет ответа";
  let consecutiveSuccesses = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${gatewayUrl}/v1/admin/platform/status`, {
        headers: { Authorization: `Bearer ${adminToken}` },
        signal: AbortSignal.timeout(10_000)
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.ok === true && data?.version === "7.0.0") {
        consecutiveSuccesses += 1;
        if (consecutiveSuccesses >= 3) return data;
      } else {
        consecutiveSuccesses = 0;
      }
      lastError = String(data?.error || `HTTP ${response.status}`).replace(/[\u0000-\u001F\u007F<>]/gu, " ").slice(0, 180);
    } catch (error) {
      consecutiveSuccesses = 0;
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < maxAttempts) await sleep(Math.min(1000 + attempt * 150, 3000));
  }
  throw new Error(`Cloudflare не активировал новый служебный ключ центрального Worker: ${lastError}`);
}

export async function gatewayAdminJson(gatewayUrl, adminToken, pathName, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxAttempts = Number.isInteger(options.maxAttempts) ? options.maxAttempts : 30;
  const method = options.method || "GET";
  const body = options.body;
  const expectedVersion = options.expectedVersion || null;
  let lastError = "нет ответа";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const headers = { Authorization: `Bearer ${adminToken}` };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetchImpl(`${gatewayUrl}${pathName}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(Number(options.timeoutMs) || 70_000)
      });
      const data = await response.json().catch(() => ({}));
      const versionPending = Boolean(response.ok && expectedVersion && data?.version !== expectedVersion);
      const accessPending = new Set([401, 403, 404]).has(response.status);
      if (!versionPending && !accessPending) return { response, data };
      lastError = String(data?.error || `HTTP ${response.status}`).replace(/[\u0000-\u001F\u007F<>]/gu, " ").slice(0, 180);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < maxAttempts) await sleep(Math.min(1000 + attempt * 150, 3000));
  }
  throw new Error(`Служебный доступ Cloudflare не подтвердился для ${pathName}: ${lastError}`);
}

async function bootstrapGateway(gatewayUrl, adminToken) {
  section("Регистрация сайта в общем SiteCareBot");
  const { response, data } = await gatewayAdminJson(gatewayUrl, adminToken, "/v1/admin/bootstrap", {
    method: "POST",
    body: {
      siteId: SCOPE.siteId,
      siteName: "ketedes.tilda.ws/page169452909.html",
      targetUrl: SCOPE.targetUrl
    }
  });
  if (
    response.ok &&
    data?.ok === true &&
    data?.siteId === SCOPE.siteId &&
    /^[A-Za-z0-9_-]{32,128}$/u.test(String(data.siteToken || "")) &&
    /^[A-Za-z0-9_]{5,64}$/u.test(String(data.botUsername || ""))
  ) {
    console.log(`Официальный бот @${data.botUsername} подтверждён. Сайт зарегистрирован отдельным ключом.`);
    return { siteToken: String(data.siteToken), botUsername: String(data.botUsername) };
  }
  const message = String(data?.error || `код ${response.status}`).replace(/[\u0000-\u001F\u007F<>]/gu, " ").slice(0, 180);
  throw new Error(`Общий SiteCareBot опубликован, но регистрация сайта не завершилась: ${message}`);
}

async function getPlatformStatus(gatewayUrl, adminToken) {
  const { response, data } = await gatewayAdminJson(gatewayUrl, adminToken, "/v1/admin/platform/status", {
    expectedVersion: "7.0.0",
    timeoutMs: 10_000
  });
  if (!response.ok || data?.ok !== true || data?.version !== "7.0.0") {
    throw new Error(String(data?.error || "Центральная панель не ответила после обновления.").slice(0, 180));
  }
  return data;
}

async function verifyPasswordEmail(gatewayUrl, adminToken) {
  const { response, data } = await gatewayAdminJson(gatewayUrl, adminToken, "/v1/admin/platform/email/test", {
    method: "POST",
    timeoutMs: 30_000
  });
  if (!response.ok || data?.ok !== true || !data?.deliveredTo) {
    throw new Error(String(data?.error || "Почтовый сервис не принял тестовое письмо.").slice(0, 180));
  }
  console.log(`Тестовое письмо принято почтовым сервисом для ${data.deliveredTo}.`);
  return { configured: true, deliveredTo: String(data.deliveredTo), transport: String(data.transport || "email") };
}

async function ensurePasswordEmail(accountId, gatewayUrl, adminToken, configured) {
  if (!configured) return { configured: false, deliveredTo: null, transport: null };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await verifyPasswordEmail(gatewayUrl, adminToken);
    } catch (error) {
      console.log(`Проверка почты не пройдена: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt >= 3) throw new Error("Почта не прошла три проверки. Установка остановлена без изменения сайтов и Tilda.");
      console.log("Обычно причина — неполный API-ключ или стандартный отправитель используется для чужого адреса Resend.");
      const replacementKey = await chooseResendApiKey({ allowSkip: false });
      const replacementFrom = await chooseEmailFrom();
      await putSecrets(accountId, {
        GATEWAY_ADMIN_TOKEN: adminToken,
        RESEND_API_KEY: replacementKey,
        SITECARE_EMAIL_FROM: replacementFrom
      }, GATEWAY_SCOPE.workerName);
      await waitForGatewayAdminAccess(gatewayUrl, adminToken);
    }
  }
  throw new Error("Проверка почты не завершена.");
}

async function bootstrapPlatform(gatewayUrl, adminToken, { email, displayName, password }) {
  section("Создание центральной панели");
  const { response, data } = await gatewayAdminJson(gatewayUrl, adminToken, "/v1/admin/platform/bootstrap", {
    method: "POST",
    body: { email, displayName, password }
  });
  if (!response.ok || data?.ok !== true || data?.configured !== true) {
    throw new Error(String(data?.error || "Не удалось создать центральную панель.").slice(0, 180));
  }
  console.log("Центральная панель владельца создана. Пароль не записан в файлы.");
  return data;
}

async function verifyGatewayHealth(gatewayUrl, expectedBotUsername) {
  let lastError = "нет ответа";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(8000) });
      const data = await response.json();
      if (
        response.ok &&
        data?.ok === true &&
        data?.service === "sitecare-telegram-gateway" &&
        data?.platformVersion === "7.0.0" &&
        data?.botUsername === expectedBotUsername
      ) return true;
      lastError = `код ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Общий SiteCareBot опубликован, но проверка не прошла: ${lastError}`);
}

async function verifyHealth(workerUrl) {
  section("Финальная проверка");
  let lastError = "нет ответа";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(`${workerUrl}/api/health`, { signal: AbortSignal.timeout(8000) });
      const data = await response.json();
      if (response.ok && data?.ok === true && data?.siteId === SCOPE.siteId && data?.scope === `${SCOPE.hostname}${SCOPE.pathname}`) {
        console.log("Worker отвечает и закреплён за нужной страницей.");
        return true;
      }
      lastError = `код ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Worker опубликован, но финальная проверка пока не прошла: ${lastError}`);
}

async function writeResult(account, workerUrl, gatewayUrl, botUsername, platformEmail, wasUpdate, passwordPreserved, formWebhookPreserved, passwordEmail) {
  const loader = await readFile(LOADER_PATH, "utf8");
  const readyLoader = loader.replace("https://PUT-YOUR-WORKER.workers.dev", workerUrl);
  if (readyLoader === loader || readyLoader.includes("PUT-YOUR-WORKER")) {
    throw new Error("Не удалось безопасно подготовить код Tilda.");
  }
  await writeFile(READY_CODE_PATH, `\uFEFF${readyLoader}`, "utf8");
  const formInstructions = wasUpdate && formWebhookPreserved
    ? [
        "ФОРМЫ И ЗАЯВКИ",
        "Webhook SiteCare и текущие получатели формы сохранены. В Tilda ничего менять и повторно публиковать не нужно."
      ]
    : [
        "ФОРМЫ И ЗАЯВКИ",
        "1. Откройте панель владельца и раздел «Формы и заявки».",
        "2. Нажмите «Показать адрес подключения».",
        "3. В Tilda откройте Настройки сайта → Формы → Webhook и добавьте этот HTTPS-адрес.",
        "4. В форме отметьте WEBHOOK. Оставьте включёнными только те Telegram, почту и CRM, которые принадлежат вам.",
        "5. Если форма находится в общей шапке или подвале, опубликуйте все страницы сайта; иначе опубликуйте страницу с формой.",
        "6. В панели создайте тестовый код. Для формы только с телефоном SiteCare выдаст безопасный цифровой тестовый номер."
      ];
  const result = [
    "S I T E C A R E — РЕЗУЛЬТАТ УСТАНОВКИ",
    "",
    `Дата: ${new Date().toISOString()}`,
    `Подтверждённый аккаунт Cloudflare: ${account.name}`,
    `Worker: ${SCOPE.workerName}`,
    `База D1: ${SCOPE.databaseName}`,
    `Адрес Worker: ${workerUrl}`,
    `Старый одностраничный кабинет (временно): ${workerUrl}/admin`,
    `Проверка: ${workerUrl}/api/health`,
    `Центральная панель SiteCare (основная): ${gatewayUrl}/app`,
    `Логин центральной панели: ${platformEmail || "создан ранее"}`,
    `Восстановление пароля по почте: ${passwordEmail.configured ? `подключено; тест принят для ${passwordEmail.deliveredTo}` : "не подключено; в окне входа будет показана понятная подсказка"}`,
    `Общий SiteCareBot: @${botUsername}`,
    `Шлюз уведомлений: ${gatewayUrl}`,
    `Страница проекта: ${SCOPE.targetUrl}`,
    "Статус проверки: успешно",
    "",
    "Tilda, тариф, домены и другие проекты этим запуском не изменялись.",
    wasUpdate
      ? `Обновлён тот же пилотный Worker. Адрес и текущее состояние старых правок сохранены. ${passwordPreserved ? "Пароль панели остался прежним." : "Защита панели настроена новым паролем."} Установщик не менял Tilda.`
      : "Показ серверных правок остаётся выключенным.",
    `Защита приёма форм: ${formWebhookPreserved ? "прежний ключ сохранён" : "отдельный ключ создан"}. Сам ключ в этот файл не записан.`,
    "",
    ...formInstructions,
    "",
    "УВЕДОМЛЕНИЯ SITECARE В TELEGRAM",
    `1. Откройте в панели раздел «Уведомления в Telegram» и нажмите «Подключить Telegram».`,
    `2. Нажмите «Открыть @${botUsername}», затем в Telegram нажмите Start.`,
    "3. Вернитесь в панель, нажмите «Проверить подключение», затем «Отправить тест».",
    "Создавать отдельного бота, открывать BotFather или вводить токен клиенту не нужно.",
    "Официальный бот сообщает только о сбое и восстановлении страницы или формы. Получатель Telegram в Tilda для самих заявок не меняется.",
    "",
    "AI-ПОМОЩНИК И ПОДДЕРЖКА",
    `1. Откройте ${gatewayUrl}/app → Поддержка.`,
    "2. Подключите свой Telegram к очереди поддержки, чтобы получать новые обращения клиентов.",
    "3. Клиент пишет помощнику обычными словами. Если AI не может безопасно решить задачу, клиент нажимает «Передать в поддержку».",
    "4. Возьмите обращение, ответьте в том же диалоге и после решения нажмите «Завершить обращение».",
    "История диалога хранится в SiteCare. Клиенту не нужно переходить в Telegram или создавать отдельного бота.",
    "",
    "ПЕРЕХОД ТЕКУЩЕГО САЙТА НА НОВЫЙ РЕДАКТОР",
    `1. Откройте ${gatewayUrl}/app → Настройки → нужный сайт → Инструкция подключения.`,
    "2. Убедитесь, что общий код SiteCare найден в HEAD всего сайта.",
    "3. Только после этого удалите старый ручной блок T123 SiteCare, если он ещё есть, и опубликуйте все страницы.",
    "4. Проверьте один вопрос и одну безопасную правку на экране «Состояние сайта».",
    "Не вставляйте файл TILDA-CODE-READY.txt поверх нового кода центральной панели: он оставлен только для совместимости со старым одностраничным кабинетом.",
    "",
    "",
    "НОВЫЕ КЛИЕНТЫ И САЙТЫ",
    `Откройте ${gatewayUrl}/app. В разделе «Клиенты» создайте кабинет, а затем передайте владельцу одноразовую ссылку приглашения.`,
    "Клиент добавляет HTTPS-адрес сайта, получает webhook Tilda и подключает общий Telegram-бот. Cloudflare, BotFather и архивы клиенту не нужны."
  ].join("\r\n");
  await writeFile(RESULT_PATH, `\uFEFF${result}\r\n`, "utf8");
}

async function writeSafeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const lines = [
    "SiteCare — установка остановлена",
    `Дата: ${new Date().toISOString()}`,
    `Причина: ${message}`,
    remoteWorkStarted
      ? "В Cloudflare могла сохраниться часть ресурсов с точными именами проекта. Их не нужно удалять: повторный запуск продолжит установку."
      : "Этим запуском в Cloudflare ничего не создавалось.",
    "Tilda, тариф и домены не изменялись."
  ];
  await writeFile(ERROR_PATH, `\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

export async function main() {
  console.log("SiteCare — обновление центральной панели и безопасного пилота");
  console.log("Пилотный Worker остаётся ограничен страницей ketedes.tilda.ws/page169452909.html.");
  console.log("ChatGPT Plus не подключается: полноценный помощник использует отдельный серверный OpenAI API.");
  await preflight();

  const { account, email: cloudflareEmail } = await selectAccount();
  const originalConfig = await readConfig();
  const originalGatewayConfig = await readGatewayConfig();
  await writeConfig(buildPinnedConfig(originalConfig, account.id));
  await writeGatewayConfig(buildPinnedGatewayConfig(originalGatewayConfig, account.id));
  const current = await inspectRemote(account.id);

  section("Последнее подтверждение");
  console.log(`Аккаунт: ${account.name}`);
  console.log(`Страница: ${SCOPE.targetUrl}`);
  console.log(`Будет ${current.database ? "использована" : "создана"} база сайта: ${SCOPE.databaseName}`);
  console.log(`Будет ${current.worker ? "обновлён" : "создан"} Worker сайта: ${SCOPE.workerName}`);
  console.log(`Будет ${current.gatewayDatabase ? "использована" : "создана"} база общего бота: ${GATEWAY_SCOPE.databaseName}`);
  console.log(`Будет ${current.gatewayWorker ? "обновлён" : "создан"} центральный Worker: ${GATEWAY_SCOPE.workerName}`);
  console.log("Оплата, тариф, домены и Tilda не меняются.");
  if (current.worker && current.secretsConfigured) console.log("Существующий пароль панели останется прежним.");
  if (current.worker && current.formWebhookConfigured) console.log("Существующий ключ приёма форм останется прежним.");
  const finalAnswer = (await ask("Для начала введите ДА: ")).toLocaleLowerCase("ru-RU");
  if (finalAnswer !== "да") throw new Error("Создание отменено. Удалённые ресурсы не изменялись.");

  const adminPassword = current.secretsConfigured ? null : await choosePassword();
  const botToken = current.gatewayBotConfigured ? null : await chooseTelegramBotToken();
  const resendApiKey = current.gatewayEmailConfigured ? null : await chooseResendApiKey();
  const emailFrom = resendApiKey ? await chooseEmailFrom() : null;
  const openAiApiKey = current.gatewayOpenAiConfigured ? null : await chooseOpenAiApiKey();
  remoteWorkStarted = true;

  const gatewayDatabase = current.gatewayDatabase || await createDatabase(account.id, GATEWAY_SCOPE.databaseName);
  await writeGatewayConfig(buildPinnedGatewayConfig(await readGatewayConfig(), account.id, gatewayDatabase.id));
  await applyMigration(account.id, GATEWAY_SCOPE.databaseName, "gateway/wrangler.jsonc");
  let gatewaySecrets = null;
  if (current.gatewayWorker) {
    gatewaySecrets = await configureGatewaySecrets(account.id, current, { botToken, resendApiKey, emailFrom, openAiApiKey });
  }
  let gatewayUrl = await deployWorker(account.id, GATEWAY_SCOPE.workerName, "gateway/wrangler.jsonc");
  if (!current.gatewayWorker) {
    gatewaySecrets = await configureGatewaySecrets(account.id, current, { botToken, resendApiKey, emailFrom, openAiApiKey });
    gatewayUrl = await deployWorker(account.id, GATEWAY_SCOPE.workerName, "gateway/wrangler.jsonc");
  }
  const gatewayAdminToken = gatewaySecrets.adminToken;
  const passwordEmailConfigured = gatewaySecrets.passwordEmailConfigured;
  section("Активация служебного доступа");
  await waitForGatewayAdminAccess(gatewayUrl, gatewayAdminToken);
  console.log("Центральный Worker подтвердил новый служебный ключ.");
  let gatewayRegistration;
  try {
    gatewayRegistration = await bootstrapGateway(gatewayUrl, gatewayAdminToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rejectedSavedToken = current.gatewayBotConfigured && /Unauthorized|Not Found|токен|не подтвердил/iu.test(message);
    if (!rejectedSavedToken) throw error;
    console.log("Telegram больше не принимает сохранённый токен официального бота. Его можно безопасно заменить сейчас.");
    const replacementToken = await chooseTelegramBotToken();
    await putSecrets(account.id, {
      GATEWAY_ADMIN_TOKEN: gatewayAdminToken,
      TELEGRAM_BOT_TOKEN: replacementToken
    }, GATEWAY_SCOPE.workerName);
    await waitForGatewayAdminAccess(gatewayUrl, gatewayAdminToken);
    gatewayRegistration = await bootstrapGateway(gatewayUrl, gatewayAdminToken);
  }

  const currentPlatform = await getPlatformStatus(gatewayUrl, gatewayAdminToken);
  let platformEmail = null;
  if (!currentPlatform.configured) {
    platformEmail = await choosePlatformEmail(cloudflareEmail);
    const platformPassword = await choosePassword();
    await bootstrapPlatform(gatewayUrl, gatewayAdminToken, {
      email: platformEmail,
      displayName: "Владелец SiteCare",
      password: platformPassword
    });
  }
  const passwordEmail = await ensurePasswordEmail(account.id, gatewayUrl, gatewayAdminToken, passwordEmailConfigured);

  const database = current.database || await createDatabase(account.id);
  await writeConfig(buildPinnedConfig(await readConfig(), account.id, database.id, gatewayUrl));
  await applyMigration(account.id);
  if (current.worker) {
    await configureSiteSecrets(account.id, current, { adminPassword, siteToken: gatewayRegistration.siteToken });
  }
  let workerUrl = await deployWorker(account.id);
  if (!current.worker) {
    await configureSiteSecrets(account.id, current, { adminPassword, siteToken: gatewayRegistration.siteToken });
    workerUrl = await deployWorker(account.id);
  }
  await verifyGatewayHealth(gatewayUrl, gatewayRegistration.botUsername);
  await verifyHealth(workerUrl);
  await writeResult(
    account,
    workerUrl,
    gatewayUrl,
    gatewayRegistration.botUsername,
    platformEmail,
    current.worker,
    current.secretsConfigured,
    current.formWebhookConfigured,
    passwordEmail
  );
  await rm(ERROR_PATH, { force: true });

  section("Готово");
  console.log(`Центральная панель (основная): ${gatewayUrl}/app`);
  console.log(`Старый одностраничный кабинет (временно): ${workerUrl}/admin`);
  console.log(`Общий бот: @${gatewayRegistration.botUsername}`);
  if (current.worker) {
    console.log(`Обновлён тот же Worker. ${current.secretsConfigured ? "Пароль панели остался прежним." : "Установлен новый пароль панели."} Установщик не менял Tilda.`);
    console.log("Откройте прежнюю панель. В Telegram теперь доступно подключение через одну кнопку без BotFather и токена.");
    console.log("Для нового редактора откройте центральную панель и проверьте общий код в HEAD. Старый T123 удаляйте только после подтверждения нового кода.");
  } else {
    console.log("Tilda пока не изменялась и серверные правки выключены.");
    console.log("Откройте панель и следуйте инструкции в разделе «Формы и заявки».");
  }
}

const launchedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (launchedDirectly) {
  main().catch(async (error) => {
    try {
      await writeSafeError(error);
    } catch {
      // The terminal still shows the original error if an error file cannot be written.
    }
    console.error(`\nОСТАНОВЛЕНО: ${error instanceof Error ? error.message : String(error)}`);
    if (remoteWorkStarted) {
      console.error("Часть точных ресурсов могла сохраниться. Не удаляйте их: повторный запуск безопасно продолжит установку.");
    } else {
      console.error("Этим запуском в Cloudflare ничего не создавалось.");
    }
    console.error("Tilda, её тариф и домены не менялись.");
    process.exitCode = 1;
  });
}
