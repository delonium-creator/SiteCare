import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLeadSubmission } from "../gateway/src/platform-leads.js";

test("lead normalization hides Tilda internals and presents useful owner-facing data", () => {
  const result = normalizeLeadSubmission([
    { name: "formid", value: "form316328935" },
    { name: "formname", value: "form316328935" },
    { name: "Name", value: " Анна " },
    { name: "Phone", value: "+7 999 123-45-67" },
    { name: "Email", value: "anna@example.test" },
    { name: "Message", value: "Нужна консультация" },
    { name: "3", value: "Удобно после 18:00" },
    { name: "COOKIES", value: "utm_source=telegram;utm_campaign=launch;session=secret" },
    { name: "utm_source", value: "vk" }
  ], {
    site_id: "site_demo",
    target_url: "https://example.test/"
  }, {
    referer: "https://example.test/services?utm_source=ignored#form"
  });

  assert.equal(result.formLabel, "Форма на сайте");
  assert.equal(result.pageUrl, "https://example.test/services");
  assert.equal(result.sourceLabel, "vk");
  assert.deepEqual(result.payload, {
    name: "Анна",
    phone: "+7 999 123-45-67",
    email: "anna@example.test",
    message: "Нужна консультация",
    utm: { source: "vk", campaign: "launch" },
    fields: [{ name: "Дополнительное поле 1", value: "Удобно после 18:00" }]
  });
  assert.doesNotMatch(JSON.stringify(result), /session=secret|form316328935|COOKIES/u);
});

test("a human form title stays visible while unsafe page URLs fall back to the site", () => {
  const result = normalizeLeadSubmission([
    { name: "formname", value: "Запись на консультацию" },
    { name: "pageurl", value: "javascript:alert(1)" },
    { name: "Имя", value: "Иван" }
  ], {
    site_id: "site_demo",
    target_url: "https://example.test/contacts?private=value"
  });

  assert.equal(result.formLabel, "Запись на консультацию");
  assert.equal(result.pageUrl, "https://example.test/contacts");
  assert.equal(result.payload.name, "Иван");
});
