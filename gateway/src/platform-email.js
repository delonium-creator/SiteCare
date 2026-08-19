const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_KEY_PATTERN = /^re_[A-Za-z0-9_-]{10,200}$/u;
const SIMPLE_EMAIL_PATTERN = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]{2,}$/u;

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function configuredFrom(env, transport) {
  const configured = String(env.SITECARE_EMAIL_FROM || "").trim();
  if (configured) return configured;
  if (transport === "resend") return "SiteCare <onboarding@resend.dev>";
  return "";
}

function addressOnly(value) {
  const raw = String(value || "").trim();
  const named = /<([^<>]+)>$/u.exec(raw);
  return (named?.[1] || raw).trim();
}

function validFrom(value) {
  return SIMPLE_EMAIL_PATTERN.test(addressOnly(value));
}

export function emailTransport(env) {
  const from = configuredFrom(env, typeof env.EMAIL?.send === "function" ? "cloudflare" : "resend");
  if (typeof env.EMAIL?.send === "function" && validFrom(from)) return "cloudflare";
  if (RESEND_KEY_PATTERN.test(String(env.RESEND_API_KEY || "")) && validFrom(from)) return "resend";
  return "";
}

export function emailDeliveryConfigured(env) {
  return Boolean(emailTransport(env));
}

async function deliverEmail(env, { to, subject, html, text, requestId }) {
  const transport = emailTransport(env);
  if (!transport) throw new Error("PASSWORD_EMAIL_NOT_CONFIGURED");
  const from = configuredFrom(env, transport);

  if (transport === "cloudflare") {
    const result = await env.EMAIL.send({ to, from, subject, html, text });
    return { transport, messageId: String(result?.messageId || "") };
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `sitecare-mail-${String(requestId || "").slice(0, 80)}`
    },
    body: JSON.stringify({ from, to: [to], subject, html, text })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.id) {
    const error = new Error("PASSWORD_EMAIL_DELIVERY_FAILED");
    error.status = response.status;
    throw error;
  }
  return { transport, messageId: String(payload.id) };
}

export async function sendPasswordResetEmail(env, { to, resetUrl, expiresInMinutes, requestId }) {
  const safeUrl = escapeHtml(resetUrl);
  const minutes = Math.max(5, Math.min(Number(expiresInMinutes) || 30, 60));
  const subject = "Восстановление доступа к SiteCare";
  const text = [
    "Вы запросили восстановление доступа к SiteCare.",
    "",
    `Откройте одноразовую ссылку: ${resetUrl}`,
    "",
    `Ссылка действует ${minutes} минут. Если это были не вы, ничего не делайте.`
  ].join("\n");
  const html = `<!doctype html><html lang="ru"><body style="margin:0;background:#f5f6fb;color:#17203a;font:16px/1.5 Arial,sans-serif"><div style="max-width:560px;margin:30px auto;background:#fff;border:1px solid #e2e5ef;border-radius:18px;padding:28px"><h1 style="font-size:24px;margin:0 0 12px">Восстановление доступа</h1><p>Вы запросили новый пароль для SiteCare.</p><p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;background:#6848ec;color:#fff;text-decoration:none;border-radius:10px;padding:12px 18px;font-weight:700">Создать новый пароль</a></p><p style="color:#69738d">Ссылка одноразовая и действует ${minutes} минут. Если это были не вы, просто проигнорируйте письмо.</p></div></body></html>`;
  return deliverEmail(env, { to, subject, html, text, requestId });
}

export async function sendTrialInviteEmail(env, { to, displayName, inviteUrl, requestId }) {
  const safeUrl = escapeHtml(inviteUrl);
  const safeName = escapeHtml(displayName || "");
  const subject = "Ваш пробный доступ к SiteCare";
  const text = [
    `Здравствуйте${displayName ? `, ${displayName}` : ""}!`,
    "",
    "Создайте пароль и подключите первый сайт. После подключения начнутся 3 бесплатных дня SiteCare.",
    "",
    `Одноразовая ссылка: ${inviteUrl}`,
    "",
    "Если вы не оставляли заявку, проигнорируйте письмо."
  ].join("\n");
  const html = `<!doctype html><html lang="ru"><body style="margin:0;background:#f5f6fb;color:#17203a;font:16px/1.5 Arial,sans-serif"><div style="max-width:560px;margin:30px auto;background:#fff;border:1px solid #e2e5ef;border-radius:18px;padding:28px"><h1 style="font-size:24px;margin:0 0 12px">3 дня SiteCare бесплатно</h1><p>Здравствуйте${safeName ? `, ${safeName}` : ""}!</p><p>Создайте пароль и подключите первый сайт. Пробный период начнётся только после подключения.</p><p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;background:#6848ec;color:#fff;text-decoration:none;border-radius:10px;padding:12px 18px;font-weight:700">Создать кабинет</a></p><p style="color:#69738d">Ссылка одноразовая и действует 72 часа. Если вы не оставляли заявку, просто проигнорируйте письмо.</p></div></body></html>`;
  return deliverEmail(env, { to, subject, html, text, requestId: `trial-${requestId}` });
}

export async function sendEmailSetupTest(env, { to, requestId }) {
  const subject = "Почта SiteCare подключена";
  const text = "Готово: SiteCare может отправлять одноразовые ссылки для восстановления пароля. Никаких действий с этим письмом не требуется.";
  const html = '<!doctype html><html lang="ru"><body style="margin:0;background:#f5f6fb;color:#17203a;font:16px/1.5 Arial,sans-serif"><div style="max-width:560px;margin:30px auto;background:#fff;border:1px solid #e2e5ef;border-radius:18px;padding:28px"><h1 style="font-size:24px;margin:0 0 12px">Почта SiteCare подключена</h1><p>Теперь панель может отправлять одноразовые ссылки для восстановления пароля.</p><p style="color:#69738d">Никаких действий с этим письмом не требуется.</p></div></body></html>';
  return deliverEmail(env, { to, subject, html, text, requestId });
}

export async function sendSupportRequestEmail(env, { to, clientName, siteName, summary, supportUrl, requestId }) {
  const safeUrl = escapeHtml(supportUrl);
  const safeClient = escapeHtml(clientName || "Клиент");
  const safeSite = escapeHtml(siteName || "Сайт");
  const safeSummary = escapeHtml(summary || "Нужна помощь с сайтом");
  const subject = `Новое обращение в поддержку · ${siteName || "SiteCare"}`;
  const text = [
    "В SiteCare появилось новое обращение в поддержку.",
    "",
    `Клиент: ${clientName || "Клиент"}`,
    `Сайт: ${siteName || "Сайт"}`,
    `Запрос: ${summary || "Нужна помощь с сайтом"}`,
    "",
    `Открыть обращение: ${supportUrl}`
  ].join("\n");
  const html = `<!doctype html><html lang="ru"><body style="margin:0;background:#f5f6fb;color:#17203a;font:16px/1.5 Arial,sans-serif"><div style="max-width:560px;margin:30px auto;background:#fff;border:1px solid #e2e5ef;border-radius:18px;padding:28px"><h1 style="font-size:24px;margin:0 0 12px">Новое обращение</h1><p><b>${safeClient}</b> просит помочь с сайтом «${safeSite}».</p><p style="padding:14px;border-radius:12px;background:#f7f5ff">${safeSummary}</p><p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;background:#6848ec;color:#fff;text-decoration:none;border-radius:10px;padding:12px 18px;font-weight:700">Открыть диалог</a></p><p style="color:#69738d">Ответ из панели появится в том же чате клиента.</p></div></body></html>`;
  return deliverEmail(env, { to, subject, html, text, requestId: `support-${requestId}` });
}

export async function sendSupportReplyEmail(env, { to, siteName, chatUrl, requestId }) {
  const safeUrl = escapeHtml(chatUrl);
  const safeSite = escapeHtml(siteName || "сайту");
  const subject = `Поддержка SiteCare ответила · ${siteName || "SiteCare"}`;
  const text = [
    `Поддержка SiteCare ответила по сайту «${siteName || "Сайт"}».`,
    "",
    `Открыть диалог: ${chatUrl}`
  ].join("\n");
  const html = `<!doctype html><html lang="ru"><body style="margin:0;background:#f5f6fb;color:#17203a;font:16px/1.5 Arial,sans-serif"><div style="max-width:560px;margin:30px auto;background:#fff;border:1px solid #e2e5ef;border-radius:18px;padding:28px"><h1 style="font-size:24px;margin:0 0 12px">Поддержка ответила</h1><p>По сайту «${safeSite}» появилось новое сообщение.</p><p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;background:#6848ec;color:#fff;text-decoration:none;border-radius:10px;padding:12px 18px;font-weight:700">Открыть чат</a></p><p style="color:#69738d">Содержимое ответа показывается только после входа в кабинет.</p></div></body></html>`;
  return deliverEmail(env, { to, subject, html, text, requestId: `support-reply-${requestId}` });
}

export async function sendNewLeadEmail(env, { to, siteName, contact, message, formLabel, page, requestId }) {
  const safeSite = escapeHtml(siteName || "Сайт");
  const safeContact = escapeHtml(contact || "Контакты не указаны");
  const safeMessage = escapeHtml(message || "");
  const safeFormLabel = escapeHtml(formLabel || "Форма на сайте");
  const safePage = escapeHtml(page || "");
  const subject = `Новая заявка · ${siteName || "SiteCare"}`;
  const text = [
    `Новая заявка на сайте «${siteName || "Сайт"}».`,
    "",
    contact || "Контакты не указаны",
    message || "",
    `${formLabel || "Форма на сайте"} · ${page || ""}`
  ].filter(Boolean).join("\n");
  const html = `<!doctype html><html lang="ru"><body style="margin:0;background:#f5f6fb;color:#17203a;font:16px/1.5 Arial,sans-serif"><div style="max-width:560px;margin:30px auto;background:#fff;border:1px solid #e2e5ef;border-radius:18px;padding:28px"><h1 style="font-size:24px;margin:0 0 12px">Новая заявка</h1><p>Сайт «${safeSite}».</p><p style="padding:14px;border-radius:12px;background:#f7f5ff"><b>${safeContact}</b>${safeMessage ? `<br>${safeMessage}` : ""}</p><p style="color:#69738d">${safeFormLabel}${safePage ? ` · ${safePage}` : ""}</p></div></body></html>`;
  return deliverEmail(env, { to, subject, html, text, requestId: `lead-${requestId}` });
}

export const emailInternals = Object.freeze({ addressOnly, configuredFrom, escapeHtml, validFrom });
