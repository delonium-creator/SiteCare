import { PLATFORM_VERSION } from "./platform-core.js";

export function buildRecentEvents(a, s, limit = 8) {
  const events = [];
  for (const lead of (a && a.leads) || []) {
    if (s && lead.siteId !== s.site_id) continue;
    events.push({ type: "lead", title: "Получена новая заявка", detail: lead.formLabel || lead.source || "Сайт", timestamp: lead.receivedAt });
  }
  for (const change of (s && s._overrides && s._overrides.changes) || []) {
    events.push({ type: "change", title: change.summary || "Изменение на сайте", detail: change.target_label || "Весь сайт", timestamp: change.created_at });
  }
  for (const incident of (s && s._incidents) || []) {
    if (incident.resolved_at) events.push({ type: "incident-resolved", title: "Инцидент решён", detail: incident.summary || "", timestamp: incident.resolved_at });
    else events.push({ type: "incident-opened", title: "Обнаружен инцидент", detail: incident.summary || "", timestamp: incident.opened_at });
  }
  for (const scan of (s && s._healthHistory) || []) {
    events.push({ type: "scan", title: "Проверка сайта завершена", detail: "Оценка здоровья: " + scan.score, timestamp: scan.checked_at });
  }
  return events
    .filter((event) => event.timestamp)
    .sort((x, y) => Date.parse(y.timestamp) - Date.parse(x.timestamp))
    .slice(0, limit);
}

export {platformHtml} from "./service-ui.js";

export function inviteHtml(nonce, token = "") {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Приглашение SiteCare</title>
  <style nonce="${nonce}">
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f3f5f7;color:#151927;font:16px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}.wrap{width:min(500px,100%)}.brand{display:flex;align-items:center;justify-content:center;margin-bottom:23px;color:#171b25;font-size:21px;font-weight:950;letter-spacing:-.055em}.card{padding:32px;border:1px solid #e7e8ef;border-radius:14px;background:#fff;box-shadow:0 22px 60px #1e223612}.eyebrow{color:#176a80;font-size:12px;font-weight:850;letter-spacing:.12em;text-transform:uppercase}h1{margin:7px 0 9px;color:#151927;font-size:31px;line-height:1.2;letter-spacing:-.04em}.sub{margin:0 0 24px;color:#71778a}.field{display:grid;gap:8px;margin:16px 0}.field label{color:#3f4555;font-size:14px;font-weight:780}.field input{width:100%;min-height:49px;border:1px solid #d9dbe5;border-radius:11px;padding:12px 13px;color:#151927;font:inherit;outline:none}.field input:focus{border-color:#176a80;box-shadow:0 0 0 4px #176a801a}button{width:100%;min-height:49px;margin-top:9px;border:0;border-radius:10px;padding:12px;background:#176a80;color:#fff;font:inherit;font-weight:800;cursor:pointer;box-shadow:0 6px 17px #176a8033}button:disabled{opacity:.55;cursor:wait}.hint{margin:7px 0 0;color:#838899;font-size:13px}.msg{padding:12px 13px;border:1px solid #ffc9c5;border-radius:10px;margin-top:15px;background:#fff1f0;color:#b42318}.ok{border-color:#b7ebcf;background:#ecfdf3;color:#067647}.secure{text-align:center;margin-top:17px;color:#838899;font-size:12px}.secure:before{content:"";display:inline-block;width:6px;height:6px;margin-right:7px;border-radius:50%;background:#27ae60}@media(max-width:540px){body{padding:16px}.card{padding:24px 20px}h1{font-size:28px}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand" aria-label="SiteCare" style="font-size:46px;letter-spacing:-.075em">SITE<span style="color:#176a80">CARE</span></div>
    <form class="card" id="form">
      <span class="eyebrow">Приглашение</span>
      <h1>Добро пожаловать</h1>
      <p class="sub">Заполните данные и создайте пароль для своего кабинета SiteCare.</p>
      <div class="field"><label for="email">Электронная почта</label><input id="email" type="email" autocomplete="email" placeholder="name@company.ru" required></div>
      <div class="field"><label for="name">Ваше имя</label><input id="name" autocomplete="name" placeholder="Как к вам обращаться" required minlength="2"></div>
      <div class="field"><label for="password">Пароль</label><input id="password" type="password" autocomplete="new-password" required minlength="12" maxlength="200" placeholder="Придумайте надёжный пароль"><p class="hint">Не менее 12 символов, обязательно буква и цифра</p></div>
      <button>Создать кабинет</button>
      <div id="msg" class="msg" hidden></div>
      <div class="secure">Одноразовая защищённая ссылка</div>
    </form>
  </div>
  <script nonce="${nonce}">(()=>{'use strict';const token=${JSON.stringify(token)};const msg=document.getElementById('msg');document.getElementById('form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;msg.hidden=true;try{const r=await fetch('/v1/platform/invites/accept',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,email:document.getElementById('email').value,displayName:document.getElementById('name').value,password:document.getElementById('password').value})});const data=await r.json();if(!r.ok)throw new Error(data.error||'Не удалось принять приглашение.');msg.textContent='Готово. Сейчас откроется панель.';msg.className='msg ok';msg.hidden=false;setTimeout(()=>location.href='/app',700)}catch(err){msg.textContent=err.message;msg.className='msg';msg.hidden=false}finally{b.disabled=false}}})();</script>
</body>
</html>`;
}

export function resetPasswordHtml(nonce, token = "") {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Новый пароль SiteCare</title>
  <style nonce="${nonce}">
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f3f5f7;color:#151927;font:16px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}.wrap{width:min(500px,100%)}.brand{display:flex;align-items:center;justify-content:center;margin-bottom:23px;color:#171b25;font-size:21px;font-weight:950;letter-spacing:-.055em}.card{padding:32px;border:1px solid #e7e8ef;border-radius:14px;background:#fff;box-shadow:0 22px 60px #1e223612}.eyebrow{color:#176a80;font-size:12px;font-weight:850;letter-spacing:.12em;text-transform:uppercase}h1{margin:7px 0 9px;color:#151927;font-size:31px;line-height:1.2;letter-spacing:-.04em}.sub{margin:0 0 24px;color:#71778a}.field{display:grid;gap:8px;margin:16px 0}.field label{color:#3f4555;font-size:14px;font-weight:780}.field input{width:100%;min-height:49px;border:1px solid #d9dbe5;border-radius:11px;padding:12px 13px;color:#151927;font:inherit;outline:none}.field input:focus{border-color:#176a80;box-shadow:0 0 0 4px #176a801a}button{width:100%;min-height:49px;margin-top:9px;border:0;border-radius:10px;padding:12px;background:#176a80;color:#fff;font:inherit;font-weight:800;cursor:pointer;box-shadow:0 6px 17px #176a8033}button:disabled{opacity:.55;cursor:wait}.hint{margin:7px 0 0;color:#838899;font-size:13px}.msg{padding:12px 13px;border:1px solid #ffc9c5;border-radius:10px;margin-top:15px;background:#fff1f0;color:#b42318}.ok{border-color:#b7ebcf;background:#ecfdf3;color:#067647}.back{display:block;margin-top:18px;text-align:center;color:#176a80;font-size:14px;font-weight:750;text-decoration:none}.secure{text-align:center;margin-top:17px;color:#838899;font-size:12px}.secure:before{content:"";display:inline-block;width:6px;height:6px;margin-right:7px;border-radius:50%;background:#27ae60}@media(max-width:540px){body{padding:16px}.card{padding:24px 20px}h1{font-size:28px}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand" aria-label="SiteCare" style="font-size:46px;letter-spacing:-.075em">SITE<span style="color:#176a80">CARE</span></div>
    <form class="card" id="form">
      <span class="eyebrow">Безопасность</span>
      <h1>Создайте новый пароль</h1>
      <p class="sub">Ссылка одноразовая. После сохранения все старые сеансы будут завершены.</p>
      <div class="field"><label for="password">Новый пароль</label><input id="password" type="password" autocomplete="new-password" required minlength="12" maxlength="200" placeholder="Введите новый пароль"><p class="hint">Не менее 12 символов, обязательно буква и цифра</p></div>
      <div class="field"><label for="confirmation">Повторите пароль</label><input id="confirmation" type="password" autocomplete="new-password" required minlength="12" maxlength="200" placeholder="Повторите новый пароль"></div>
      <button id="submit">Сохранить новый пароль</button>
      <div id="msg" class="msg" hidden></div>
      <a class="back" href="/app">Вернуться ко входу</a>
      <div class="secure">Одноразовая защищённая ссылка</div>
    </form>
  </div>
  <script nonce="${nonce}">(()=>{'use strict';const token=${JSON.stringify(token)};const form=document.getElementById('form');const submit=document.getElementById('submit');const msg=document.getElementById('msg');if(!token){submit.disabled=true;msg.textContent='Ссылка неполная или повреждена. Запросите новое письмо.';msg.hidden=false}form.onsubmit=async e=>{e.preventDefault();msg.hidden=true;const password=document.getElementById('password').value;if(password!==document.getElementById('confirmation').value){msg.textContent='Пароли не совпали.';msg.className='msg';msg.hidden=false;return}submit.disabled=true;try{const response=await fetch('/v1/platform/auth/password/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,password})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Не удалось изменить пароль.');msg.textContent='Пароль изменён. Сейчас откроется вход.';msg.className='msg ok';msg.hidden=false;setTimeout(()=>location.href='/app',900)}catch(error){msg.textContent=error.message;msg.className='msg';msg.hidden=false;submit.disabled=false}}})();</script>
</body>
</html>`;
}
