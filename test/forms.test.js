import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_WEBHOOK_BODY_BYTES,
  analyzeForms,
  createTestMarker,
  formMonitorResult,
  hashTestMarker,
  parseWebhookRequest,
  submissionMetadata,
  testMarkerKindForForms,
  testMarkerFromEntries,
  webhookToken
} from "../src/forms.js";

const SECRET = "form-secret-0123456789abcdef0123456789abcdef";

test("form analysis keeps structure but never field values", () => {
  const html = `
    <div id="rec2720115601">
      <script><form id="fake"><input name="leak" value="script-secret"><button>Go</button></form></script>
      <form id="form-main" data-formactiontype="2">
        <input type="hidden" name="formservices[]" value="receiver-secret">
        <input name="Name" value="Иван Иванов" required>
        <input type="tel" name="Phone" value="+7 999 111-22-33">
        <textarea name="Comment">Тайный текст</textarea>
        <button type="submit">Отправить</button>
      </form>
    </div>`;
  const result = analyzeForms(html, ["rec2720115601"]);
  assert.equal(result.ok, true);
  assert.equal(result.formCount, 1);
  assert.equal(result.readyCount, 1);
  assert.equal(result.receiverCount, 1);
  assert.equal(result.forms[0].blockId, "rec2720115601");
  assert.deepEqual(result.forms[0].fields.map((field) => field.name), ["Name", "Phone", "Comment"]);
  const stored = JSON.stringify(result);
  assert.doesNotMatch(stored, /Иван Иванов|999 111|Тайный текст|receiver-secret|script-secret/u);
});

test("form monitoring distinguishes absent and incomplete forms", () => {
  const absent = formMonitorResult(200, "<main>Без формы</main>");
  assert.equal(absent.ok, false);
  assert.match(absent.details, /не найдены/iu);

  const incomplete = formMonitorResult(200, '<form id="lead"><input name="phone"></form>');
  assert.equal(incomplete.formCount, 1);
  assert.equal(incomplete.readyCount, 0);
  assert.match(incomplete.details, /нет поля либо кнопки/iu);

  const failed = formMonitorResult(503, "");
  assert.equal(failed.ok, false);
  assert.match(failed.details, /503/u);
});

test("webhook parser accepts Tilda form encodings within strict limits", async () => {
  const encoded = await parseWebhookRequest(new Request("https://worker.test/hook", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "formid=form123&Name=Test&Phone=%2B79990000000"
  }));
  assert.deepEqual(encoded.map((entry) => entry.name), ["formid", "Name", "Phone"]);

  const multipartData = new FormData();
  multipartData.set("formid", "form456");
  multipartData.set("Comment", "hello");
  const multipart = await parseWebhookRequest(new Request("https://worker.test/hook", {
    method: "POST",
    body: multipartData
  }));
  assert.deepEqual(multipart.map((entry) => entry.name), ["formid", "Comment"]);

  await assert.rejects(
    parseWebhookRequest(new Request("https://worker.test/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    })),
    /не поддерживается/iu
  );
  await assert.rejects(
    parseWebhookRequest(new Request("https://worker.test/hook", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": String(MAX_WEBHOOK_BODY_BYTES + 1)
      },
      body: "a=b"
    })),
    /слишком большие/iu
  );
});

test("test markers and submission fingerprints are keyed and contain no raw data", async () => {
  const marker = createTestMarker();
  assert.match(marker, /^SITECARE-TEST-[A-Z2-9]{16}$/u);
  const entries = [
    { name: "formid", value: "form123" },
    { name: "Name", value: marker },
    { name: "Phone", value: "+79991112233" }
  ];
  assert.equal(testMarkerFromEntries(entries), marker);
  const [hash, token, metadata] = await Promise.all([
    hashTestMarker(marker, SECRET),
    webhookToken(SECRET, "site-id"),
    submissionMetadata(entries, SECRET)
  ]);
  assert.notEqual(hash, marker);
  assert.notEqual(token, SECRET);
  assert.equal(metadata.formId, "form123");
  assert.deepEqual(metadata.fieldNames, ["formid", "Name", "Phone"]);
  assert.doesNotMatch(JSON.stringify(metadata), /79991112233|SITECARE-TEST/u);
});

test("phone-only Tilda forms receive a numeric one-time marker", () => {
  const analysis = analyzeForms(`
    <form id="phone-only">
      <input name="phone" data-tilda-rule="phone" required>
      <button type="submit">Отправить</button>
    </form>`);
  assert.equal(analysis.forms[0].fields[0].type, "tel");
  assert.equal(testMarkerKindForForms(analysis.forms), "phone");
  assert.equal(testMarkerKindForForms([{ fields: [{ name: "Name", type: "text" }] }]), "text");

  const marker = createTestMarker("phone");
  assert.match(marker, /^000\d{12}$/u);
  assert.equal(testMarkerFromEntries([{ name: "phone", value: `+7 ${marker}` }]), marker);
  assert.equal(testMarkerFromEntries([{ name: "phone", value: "+7 999 111-22-33" }]), null);
});
