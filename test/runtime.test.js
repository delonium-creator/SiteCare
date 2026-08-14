import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

function scriptFromHtml(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/iu);
  if (!match) throw new Error("Runtime script not found.");
  return match[1];
}

function element(text = "", attributes = {}) {
  return {
    textContent: text,
    style: { whiteSpace: "" },
    attributes: { ...attributes },
    getAttribute(name) { return this.attributes[name] ?? null; },
    setAttribute(name, value) { this.attributes[name] = String(value); }
  };
}

async function runRuntime({ hostname = "ketedes.tilda.ws", pathname = "/page169452909.html", duplicates = false, config }) {
  const html = await readFile("tilda-loader.html", "utf8");
  const script = scriptFromHtml(html);
  const phone = element("Телефон: +7 (111) 111-11-11");
  const hours = element("Пн–Пт, 09:00–18:00");
  const cta = element("", { href: "https://original.example/booking" });
  const ctaText = element("Исходная кнопка");
  const selectors = new Map([
    ["#rec2720115601 .t-text", duplicates ? [phone, element("duplicate")] : [phone]],
    ["#rec2720131801 .t-text", [hours]],
    ["#rec2720147501 a.t-btnflex", [cta]],
    ["#rec2720147501 .t-btnflex__text", [ctaText]]
  ]);
  const intervals = [];
  let fetchCalls = 0;
  let currentConfig = config;
  const window = {
    location: { hostname, pathname },
    setTimeout() {},
    setInterval(callback) { intervals.push(callback); return intervals.length; }
  };
  const document = {
    readyState: "complete",
    querySelectorAll(selector) { return selectors.get(selector) || []; },
    addEventListener() {}
  };
  const context = {
    window,
    document,
    URL,
    fetch: async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => currentConfig };
    }
  };
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    phone,
    hours,
    cta,
    ctaText,
    intervals,
    get fetchCalls() { return fetchCalls; },
    async setConfig(nextConfig) {
      currentConfig = nextConfig;
      intervals[0]();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

const enabledConfig = {
  enabled: true,
  siteId: "ketedes-page169452909",
  hostname: "ketedes.tilda.ws",
  pathname: "/page169452909.html",
  phone: "+7 (999) 123-45-67",
  hours: "Ежедневно, 10:00–20:00",
  ctaText: "Оставить заявку",
  ctaLink: "https://example.com/form",
  version: 2
};

test("Tilda runtime applies all four allowed values and restores the originals", async () => {
  const runtime = await runRuntime({ config: enabledConfig });
  assert.equal(runtime.fetchCalls, 1);
  assert.equal(runtime.phone.textContent, "Телефон: +7 (999) 123-45-67");
  assert.equal(runtime.hours.textContent, "Ежедневно, 10:00–20:00");
  assert.equal(runtime.ctaText.textContent, "Оставить заявку");
  assert.equal(runtime.cta.getAttribute("href"), "https://example.com/form");

  await runtime.setConfig({
    enabled: false,
    siteId: enabledConfig.siteId,
    hostname: enabledConfig.hostname,
    pathname: enabledConfig.pathname,
    version: 3
  });
  assert.equal(runtime.phone.textContent, "Телефон: +7 (111) 111-11-11");
  assert.equal(runtime.hours.textContent, "Пн–Пт, 09:00–18:00");
  assert.equal(runtime.ctaText.textContent, "Исходная кнопка");
  assert.equal(runtime.cta.getAttribute("href"), "https://original.example/booking");
});

test("Tilda runtime refuses another page, duplicate targets and unsafe links", async () => {
  const wrongPage = await runRuntime({ pathname: "/another-page.html", config: enabledConfig });
  assert.equal(wrongPage.fetchCalls, 0);

  const duplicate = await runRuntime({ duplicates: true, config: enabledConfig });
  assert.equal(duplicate.fetchCalls, 0);
  assert.equal(duplicate.phone.textContent, "Телефон: +7 (111) 111-11-11");

  const unsafe = await runRuntime({ config: { ...enabledConfig, ctaLink: "//attacker.example/path" } });
  assert.equal(unsafe.fetchCalls, 1);
  assert.equal(unsafe.phone.textContent, "Телефон: +7 (111) 111-11-11");
  assert.equal(unsafe.cta.getAttribute("href"), "https://original.example/booking");
});

test("Tilda runtime shows a weekly schedule as rows and restores original styling", async () => {
  const weekly = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => `${day}: 10:00–20:00`).join("\n");
  const runtime = await runRuntime({ config: { ...enabledConfig, hours: weekly } });
  assert.equal(runtime.hours.textContent, weekly);
  assert.equal(runtime.hours.style.whiteSpace, "pre-line");
  await runtime.setConfig({
    enabled: false,
    siteId: enabledConfig.siteId,
    hostname: enabledConfig.hostname,
    pathname: enabledConfig.pathname,
    version: 3
  });
  assert.equal(runtime.hours.textContent, "Пн–Пт, 09:00–18:00");
  assert.equal(runtime.hours.style.whiteSpace, "");
});
