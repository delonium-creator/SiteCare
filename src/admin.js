import { LOCK } from "./core.js";

export function adminHtml({ sharedBot = false } = {}) {
  const telegramDescription = sharedBot
    ? "Официальный SiteCareBot присылает только сообщения о состоянии SiteCare. Ваш получатель Telegram в Tilda продолжит принимать сами заявки и не изменится."
    : "Это отдельный служебный бот только для сообщений о состоянии SiteCare. Ваш получатель Telegram в Tilda продолжит принимать сами заявки и не изменится.";
  const telegramSetup = sharedBot
    ? `<div id="telegram-setup" class="setup-box">
          <p class="muted small">Для всех сайтов используется один официальный SiteCareBot. Создавать бота, открывать BotFather или вводить токен не нужно.</p>
          <button id="telegram-start" class="primary" type="button">Подключить Telegram</button>
        </div>`
    : `<div id="telegram-setup" class="setup-box">
          <ol class="steps small">
            <li>Создайте отдельного бота через <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> и скопируйте выданный токен.</li>
            <li>Вставьте токен ниже. SiteCare проверит бота и выдаст одноразовую команду.</li>
            <li>Отправьте эту команду своему боту и нажмите «Завершить подключение».</li>
          </ol>
          <form id="telegram-start-form" class="inline-form">
            <label class="sr-only" for="telegram-token">Токен бота из BotFather</label>
            <input id="telegram-token" type="password" autocomplete="new-password" placeholder="Токен бота из BotFather" required>
            <button id="telegram-start" class="primary" type="submit">Начать подключение</button>
          </form>
          <p class="muted small" style="margin-top:10px">Токен сохраняется только в зашифрованном виде и никогда не показывается в панели.</p>
        </div>`;
  const telegramConnect = sharedBot
    ? `<div id="telegram-connect" class="proposal hidden">
          <b>Откройте официальный SiteCareBot</b>
          <p class="muted small" style="margin:8px 0">Нажмите кнопку ниже, затем в Telegram нажмите Start. Одноразовая ссылка не даёт доступа к панели или сайту.</p>
          <p id="telegram-expiry" class="muted small" style="margin:8px 0"></p>
          <div class="row"><a id="telegram-open" class="button-link primary" target="_blank" rel="noreferrer">Открыть SiteCareBot</a><button id="telegram-confirm" class="secondary">Проверить подключение</button></div>
        </div>`
    : `<div id="telegram-connect" class="proposal hidden">
          <b>Команда для вашего бота</b>
          <p class="muted small" style="margin:8px 0">Отправьте её в чат с созданным ботом. Для группы добавьте бота в группу и отправьте команду там.</p>
          <code id="telegram-code"></code>
          <p id="telegram-expiry" class="muted small" style="margin:8px 0"></p>
          <div class="row"><button id="telegram-copy" class="secondary">Скопировать команду</button><button id="telegram-confirm" class="primary">Завершить подключение</button></div>
        </div>`;
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>SiteCare — кабинет сайта</title>
  <style>
    :root{
      color-scheme:light;
      --bg:#f5f4f1;
      --surface:#fff;
      --surface-soft:#faf9f7;
      --ink:#222326;
      --muted:#74716d;
      --muted-2:#9b9791;
      --line:#e8e4df;
      --line-strong:#d9d3cc;
      --sidebar:#1e2025;
      --sidebar-soft:#2a2d34;
      --violet:#6957d8;
      --violet-dark:#5745c4;
      --violet-soft:#f1effd;
      --green:#19734b;
      --green-soft:#eaf7f0;
      --amber:#96630d;
      --amber-soft:#fff5df;
      --red:#a33a33;
      --red-soft:#fff0ee;
      --shadow:0 12px 34px rgba(43,39,35,.07);
      --radius:20px;
      font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
      background:var(--bg);
      color:var(--ink)
    }
    *{box-sizing:border-box}
    html{background:var(--bg)}
    body{margin:0;background:var(--bg);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
    button,input{font:inherit}
    button,.button-link{min-height:42px;border:1px solid transparent;border-radius:12px;padding:10px 15px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font-weight:750;text-decoration:none;cursor:pointer;transition:transform .15s,background .15s,border-color .15s,box-shadow .15s}
    button:focus-visible,input:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid rgba(105,87,216,.22);outline-offset:2px}
    button:disabled{opacity:.52;cursor:wait}
    .primary{background:var(--violet);color:#fff;box-shadow:0 5px 16px rgba(105,87,216,.18)}
    .primary:hover{background:var(--violet-dark);transform:translateY(-1px)}
    .secondary{border-color:var(--line-strong);background:#fff;color:#3d3b38}
    .secondary:hover{border-color:#bcb4aa;background:#fcfbfa}
    .ghost{background:#f1efec;color:#494642}
    .ghost:hover{background:#e8e4df}
    .danger{border-color:#f0cbc7;background:var(--red-soft);color:var(--red)}
    .danger:hover{background:#ffe5e2}
    .hidden{display:none!important}
    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    .muted{color:var(--muted)}
    .small{font-size:12px}
    .error{color:var(--red)}
    .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .spread{justify-content:space-between}
    .stack{display:grid;gap:12px}

    .login-shell{min-height:100vh;display:grid;grid-template-columns:minmax(360px,1.05fr) minmax(430px,.95fr);background:#fff}
    .login-story{position:relative;overflow:hidden;display:flex;flex-direction:column;justify-content:space-between;padding:48px clamp(38px,6vw,82px);background:radial-gradient(circle at 18% 18%,rgba(113,92,230,.34),transparent 34%),radial-gradient(circle at 86% 82%,rgba(55,174,116,.16),transparent 31%),linear-gradient(145deg,#17191e,#252832);color:#fff}
    .login-story:after{content:"";position:absolute;width:430px;height:430px;right:-230px;top:-170px;border:1px solid rgba(255,255,255,.1);border-radius:50%}
    .brand{position:relative;z-index:1;display:flex;align-items:center;gap:11px;color:inherit;font-size:19px;font-weight:850;letter-spacing:-.025em}
    .mark{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(145deg,#806ee8,#5e4aca);color:#fff;font-size:15px;font-weight:900;box-shadow:0 10px 28px rgba(105,87,216,.28)}
    .login-copy{position:relative;z-index:1;max-width:600px;margin:auto 0}
    .eyebrow{display:inline-flex;color:var(--violet);font-size:10px;font-weight:850;letter-spacing:.14em;text-transform:uppercase}
    .login-story .eyebrow{color:#b9abff}
    .login-copy h1{max-width:650px;margin:17px 0 17px;font-size:clamp(38px,5vw,66px);line-height:1.04;letter-spacing:-.055em}
    .login-copy>p{max-width:530px;margin:0;color:#c4c7d0;font-size:16px;line-height:1.7}
    .login-points{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:36px}
    .login-point{padding:14px;border:1px solid rgba(255,255,255,.1);border-radius:14px;background:rgba(255,255,255,.055)}
    .login-point strong,.login-point span{display:block}
    .login-point span{margin-top:3px;color:#999eaa;font-size:11px}
    .login-foot{position:relative;z-index:1;color:#777c88;font-size:11px}
    .login-main{display:grid;place-items:center;padding:40px;background:linear-gradient(180deg,#fff,#fbfaf8)}
    .login-card{width:min(430px,100%)}
    .login-mobile-brand{display:none;margin-bottom:34px;color:var(--ink)}
    .login-card h1{margin:7px 0 9px;font-size:31px;line-height:1.2;letter-spacing:-.04em}
    .login-card>p{margin:0 0 27px}
    .field-label{display:block;margin:0 0 7px;color:#4c4945;font-size:12px;font-weight:750}
    input{width:100%;min-height:48px;border:1px solid var(--line-strong);border-radius:12px;padding:12px 14px;background:#fff;color:var(--ink);outline:none}
    input:hover{border-color:#bdb5ab}
    input:focus{border-color:var(--violet);box-shadow:0 0 0 4px rgba(105,87,216,.11)}
    .login-form{display:grid;gap:15px}
    .login-form .primary{width:100%;margin-top:2px}
    .login-error{min-height:20px;margin:13px 0 0!important;color:var(--red);font-size:12px}
    .security-note{display:flex;align-items:center;gap:7px;margin-top:20px;color:var(--muted-2);font-size:11px}
    .security-note:before{content:"";width:7px;height:7px;border-radius:50%;background:#2fa26b;box-shadow:0 0 0 4px var(--green-soft)}

    .app-shell{min-height:100vh;display:grid;grid-template-columns:252px minmax(0,1fr)}
    .sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:24px 17px 17px;background:var(--sidebar);color:#e8e7eb;overflow:hidden}
    .sidebar:after{content:"";position:absolute;width:250px;height:250px;left:-130px;bottom:-155px;border-radius:50%;background:#705ee1;filter:blur(85px);opacity:.16;pointer-events:none}
    .sidebar .brand{padding:0 8px}
    .sidebar-site{position:relative;z-index:1;margin:28px 4px 22px;padding:14px;border:1px solid #363941;border-radius:15px;background:#25282f}
    .sidebar-site span,.sidebar-site strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .sidebar-site span{color:#878b96;font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
    .sidebar-site strong{margin-top:5px;color:#fff;font-size:13px}
    .sidebar-site small{display:block;margin-top:3px;color:#9296a1;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .nav{position:relative;z-index:1;display:grid;gap:4px}
    .nav button{width:100%;justify-content:flex-start;min-height:43px;border:1px solid transparent;background:transparent;color:#a4a6ae;padding:10px 11px;font-weight:680}
    .nav button:hover{background:#292c34;color:#f7f6f8}
    .nav button.active{border-color:#3b3e48;background:#30333c;color:#fff;box-shadow:inset 3px 0 0 #806ee8}
    .nav-icon{width:20px;height:20px;display:grid;place-items:center;flex:0 0 20px}
    .nav-icon svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    .sidebar-foot{position:relative;z-index:1;margin-top:auto;display:grid;gap:9px;padding:14px 5px 2px;border-top:1px solid #32353e}
    .sidebar-foot a{justify-content:flex-start;color:#aaaeb8;background:transparent;padding:8px 6px;min-height:34px}
    .sidebar-foot a:hover{color:#fff}

    .workspace{min-width:0;padding:28px clamp(22px,4vw,54px) 70px}
    .workspace-bar{max-width:1280px;margin:0 auto 25px;display:flex;align-items:center;justify-content:space-between;gap:18px}
    .workspace-name strong,.workspace-name span{display:block}
    .workspace-name strong{font-size:13px}
    .workspace-name span{margin-top:2px;color:var(--muted);font-size:11px}
    .page{display:none;max-width:1280px;margin:0 auto}
    .page.active{display:block;animation:page-in .18s ease-out}
    @keyframes page-in{from{opacity:.45;transform:translateY(3px)}to{opacity:1;transform:none}}
    .page-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:22px}
    .page-header h1{margin:5px 0 5px;font-size:30px;line-height:1.18;letter-spacing:-.045em}
    .page-header p{max-width:700px;margin:0;color:var(--muted)}
    .header-actions{display:flex;gap:9px;flex-wrap:wrap}
    .card{border:1px solid var(--line);border-radius:var(--radius);padding:22px;background:var(--surface);box-shadow:0 1px 2px rgba(43,39,35,.03)}
    .card+.card{margin-top:15px}
    .card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:17px}
    .card-head h2{margin:0;font-size:17px;letter-spacing:-.02em}
    .card-head p{margin:4px 0 0;color:var(--muted);font-size:12px}
    .hero{position:relative;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:22px;margin-bottom:14px;padding:28px;border:1px solid #dbe9e1;border-radius:24px;background:linear-gradient(135deg,#f5fbf7,#fff)}
    .hero:after{content:"";position:absolute;width:180px;height:180px;right:-80px;top:-96px;border-radius:50%;background:#77c99f;opacity:.12}
    .hero.attention{border-color:#f0dfbd;background:linear-gradient(135deg,#fffaf0,#fff)}
    .hero.attention:after{background:#e6b65f}
    .hero.bad{border-color:#eccdca;background:linear-gradient(135deg,#fff5f3,#fff)}
    .hero.bad:after{background:#d67a71}
    .hero-copy{position:relative;z-index:1}
    .hero-kicker{display:flex;align-items:center;gap:8px;color:var(--green);font-size:11px;font-weight:800}
    .hero-kicker:before{content:"";width:9px;height:9px;border-radius:50%;background:currentColor;box-shadow:0 0 0 5px rgba(25,115,75,.1)}
    .hero.attention .hero-kicker{color:var(--amber)}
    .hero.bad .hero-kicker{color:var(--red)}
    .hero h2{margin:13px 0 7px;font-size:30px;line-height:1.16;letter-spacing:-.045em}
    .hero p{max-width:680px;margin:0;color:var(--muted)}
    .hero-icon{position:relative;z-index:1;width:72px;height:72px;border-radius:22px;display:grid;place-items:center;background:var(--green-soft);color:var(--green);font-size:30px;font-weight:900}
    .hero.attention .hero-icon{background:var(--amber-soft);color:var(--amber)}
    .hero.bad .hero-icon{background:var(--red-soft);color:var(--red)}
    .status-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px;margin-bottom:14px}
    .status-card{min-height:158px;border:1px solid var(--line);border-radius:18px;padding:19px;background:#fff}
    .status-top{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .status-icon{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;background:#f1efec;color:#69655f}
    .status-icon svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    .status-dot{width:8px;height:8px;border-radius:50%;background:#b4afa8;box-shadow:0 0 0 5px #f2f0ed}
    .status-card.good .status-icon{background:var(--green-soft);color:var(--green)}
    .status-card.good .status-dot{background:#35a26f;box-shadow:0 0 0 5px var(--green-soft)}
    .status-card.attention .status-icon{background:var(--amber-soft);color:var(--amber)}
    .status-card.attention .status-dot{background:#d39a36;box-shadow:0 0 0 5px var(--amber-soft)}
    .status-card.bad .status-icon{background:var(--red-soft);color:var(--red)}
    .status-card.bad .status-dot{background:#c96058;box-shadow:0 0 0 5px var(--red-soft)}
    .status-card span{display:block;margin-top:16px;color:var(--muted);font-size:11px;font-weight:750}
    .status-card strong{display:block;margin-top:3px;font-size:17px;letter-spacing:-.02em}
    .status-card small{display:block;margin-top:6px;color:var(--muted-2);font-size:11px}
    .home-grid{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr);gap:14px}
    .lead-summary{display:grid;grid-template-columns:auto minmax(0,1fr);gap:20px;align-items:center}
    .lead-number{min-width:95px;padding:20px 18px;border-radius:17px;background:var(--violet-soft);text-align:center}
    .lead-number strong{display:block;color:var(--violet);font-size:42px;line-height:1;letter-spacing:-.06em}
    .lead-number span{display:block;margin-top:7px;color:#6c63a3;font-size:11px;font-weight:750}
    .lead-copy h3{margin:0 0 5px;font-size:16px}
    .lead-copy p{margin:0;color:var(--muted);font-size:12px}
    .recent-list,.history{display:grid;gap:9px}
    .history-item,.recent-item{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 13px;border:1px solid var(--line);border-radius:13px;background:var(--surface-soft)}
    .history-main{min-width:0;overflow-wrap:anywhere}
    .history-main b{display:block;font-size:12px}
    .history-main .small{margin-top:3px;white-space:pre-wrap}
    .empty{padding:28px 18px;border:1px dashed var(--line-strong);border-radius:14px;background:var(--surface-soft);color:var(--muted);text-align:center}

    .metric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px;margin-bottom:14px}
    .metric{min-height:128px;padding:20px;border:1px solid var(--line);border-radius:18px;background:#fff}
    .metric span{display:block;color:var(--muted);font-size:11px;font-weight:750}
    .metric strong{display:block;margin-top:13px;font-size:29px;line-height:1;letter-spacing:-.045em}
    .metric small{display:block;margin-top:9px;color:var(--muted-2);font-size:10px}
    .value-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
    .value{padding:14px;border:1px solid var(--line);border-radius:13px;background:var(--surface-soft);overflow-wrap:anywhere}
    .value b{display:block;margin-bottom:4px;color:var(--muted);font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}
    .value span,.proposal dd{white-space:pre-wrap}
    .badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:6px 9px;background:#efedea;color:#65615b;font-size:10px;font-weight:800;white-space:nowrap}
    .badge:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.72}
    .badge.ok{background:var(--green-soft);color:var(--green)}
    .badge.bad{background:var(--red-soft);color:var(--red)}
    .badge.off{background:var(--amber-soft);color:var(--amber)}
    .value span.ok{color:var(--green)}
    .action-row{display:flex;gap:9px;flex-wrap:wrap;margin-top:15px}
    .privacy-note{margin:14px 0 0;padding:12px 13px;border:1px solid var(--line);border-radius:12px;background:var(--surface-soft);color:var(--muted);font-size:11px}

    .assistant-layout{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(280px,.65fr);gap:14px;align-items:start}
    .assistant-card{padding:0;overflow:hidden}
    .assistant-intro{padding:24px 24px 16px}
    .assistant-intro h2{margin:0;font-size:24px;letter-spacing:-.035em}
    .assistant-intro p{margin:6px 0 0;color:var(--muted)}
    .quick-actions{display:flex;gap:7px;flex-wrap:wrap;padding:0 24px 16px}
    .quick-command{min-height:34px;padding:7px 10px;border-color:#ddd7f6;background:#f7f5ff;color:#5d50b4;font-size:11px}
    .messages{min-height:260px;max-height:430px;overflow:auto;padding:18px 24px;background:#f8f7f5;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
    .msg{max-width:84%;width:max-content;padding:11px 13px;border-radius:14px;margin:8px 0;white-space:pre-wrap}
    .assistant{border:1px solid var(--line);border-radius:14px 14px 14px 4px;background:#fff}
    .user{margin-left:auto;border-radius:14px 14px 4px 14px;background:var(--violet);color:#fff}
    .msg-note{display:block;margin-top:6px;color:var(--muted-2);font-size:10px}
    .user .msg-note{color:#dcd6ff}
    .proposal{margin:14px 24px;border:1px solid #d9d2f7;border-radius:14px;padding:14px;background:var(--violet-soft)}
    .proposal dl{display:grid;grid-template-columns:86px 1fr;gap:7px;margin:11px 0}
    .proposal dt{color:var(--muted);font-size:12px}
    .proposal dd{margin:0;overflow-wrap:anywhere}
    .command-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px;padding:16px 24px 22px}
    .side-card{position:sticky;top:24px}
    .side-card h2{margin:0 0 5px;font-size:16px}
    .side-card>p{margin:0 0 15px;color:var(--muted);font-size:12px}

    .notification-hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:start}
    .setup-box{margin-top:15px;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--surface-soft)}
    .inline-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px}
    .steps{margin:10px 0;padding-left:21px}
    .steps li{margin:6px 0}
    code{display:block;padding:12px 13px;border-radius:11px;background:#25272d;color:#f4f1ff;overflow-wrap:anywhere;white-space:pre-wrap;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}

    details.technical{margin-top:15px;border:1px solid var(--line);border-radius:14px;background:var(--surface-soft)}
    details.technical summary{padding:14px 16px;cursor:pointer;color:#55514b;font-size:12px;font-weight:800;list-style:none}
    details.technical summary::-webkit-details-marker{display:none}
    details.technical summary:after{content:"+";float:right;color:var(--muted);font-size:18px;line-height:1}
    details.technical[open] summary:after{content:"−"}
    .technical-body{padding:0 16px 16px;border-top:1px solid var(--line)}
    .technical-body>p:first-child{margin-top:14px}
    .settings-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(280px,.85fr);gap:14px;align-items:start}
    .settings-url{display:block;margin:9px 0 0;color:var(--muted);font-size:11px;overflow-wrap:anywhere}

    @media(max-width:1040px){
      .assistant-layout,.settings-grid{grid-template-columns:1fr}
      .side-card{position:static}
      .home-grid{grid-template-columns:1fr}
    }
    @media(max-width:820px){
      .login-shell{grid-template-columns:1fr}
      .login-story{display:none}
      .login-main{padding:30px 21px}
      .login-mobile-brand{display:flex}
      .app-shell{display:block;padding-bottom:78px}
      .sidebar{position:fixed;z-index:30;top:auto;right:0;bottom:0;left:0;width:100%;height:72px;padding:8px 10px calc(8px + env(safe-area-inset-bottom));overflow:visible;box-shadow:0 -8px 28px rgba(25,25,29,.16)}
      .sidebar:after,.sidebar>.brand,.sidebar-site,.sidebar-foot{display:none}
      .nav{height:100%;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:3px}
      .nav button{min-width:0;min-height:54px;justify-content:center;flex-direction:column;gap:2px;padding:4px 2px;border-radius:10px;font-size:10px;line-height:1.15}
      .nav button.active{box-shadow:inset 0 -3px 0 #8c7af0}
      .nav-icon{height:20px}
      .workspace{padding:20px 16px 38px}
      .workspace-bar{margin-bottom:19px}
      .workspace-name strong:before{content:"SiteCare · ";color:var(--violet)}
      .page-header h1{font-size:27px}
      .status-grid{grid-template-columns:1fr}
      .status-card{min-height:126px}
      .status-card span{margin-top:11px}
      .metric-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}
      .metric{min-height:112px;padding:16px}
      .metric strong{font-size:25px}
    }
    @media(max-width:560px){
      .workspace{padding:16px 12px 30px}
      .workspace-bar{align-items:flex-start}
      .workspace-bar .secondary{min-height:34px;padding:7px 10px;font-size:10px}
      .page-header{display:block}
      .page-header p{font-size:12px}
      .header-actions{margin-top:15px}
      .header-actions>*{flex:1}
      .hero{grid-template-columns:1fr;padding:22px}
      .hero-icon{display:none}
      .hero h2{font-size:27px}
      .metric-grid{grid-template-columns:1fr}
      .metric{min-height:98px}
      .card{padding:16px;border-radius:17px}
      .card-head{display:block}
      .card-head .row{margin-top:13px}
      .lead-summary{grid-template-columns:1fr}
      .lead-number{text-align:left}
      .value-grid{grid-template-columns:1fr}
      .assistant-card{padding:0}
      .assistant-intro{padding:19px 17px 13px}
      .quick-actions{padding:0 17px 13px}
      .messages{min-height:300px;padding:14px 15px}
      .proposal{margin:12px 15px}
      .command-form{grid-template-columns:1fr;padding:13px 15px 17px}
      .inline-form{grid-template-columns:1fr}
      .notification-hero{grid-template-columns:1fr}
      .history-item,.recent-item{align-items:flex-start;flex-direction:column}
      .nav button{font-size:9px}
      .nav-icon svg{width:17px;height:17px}
    }
    @media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
  </style>
</head>
<body>
  <section id="login-card" class="login-shell">
    <aside class="login-story" aria-label="Возможности SiteCare">
      <div class="brand"><span class="mark">S</span>SiteCare</div>
      <div class="login-copy">
        <span class="eyebrow">Личный кабинет сайта</span>
        <h1>Всё важное о сайте — без технических настроек.</h1>
        <p>Проверяйте работу страницы, следите за заявками, меняйте телефон и график обычными словами.</p>
        <div class="login-points">
          <div class="login-point"><strong>Сайт</strong><span>Проверяется автоматически</span></div>
          <div class="login-point"><strong>Заявки</strong><span>Видно время получения</span></div>
          <div class="login-point"><strong>Telegram</strong><span>Сообщит о проблеме</span></div>
        </div>
      </div>
      <div class="login-foot">SiteCare · Салон Verme</div>
    </aside>
    <div class="login-main">
      <form id="login-form" class="login-card login-form">
        <div class="login-mobile-brand brand"><span class="mark">S</span>SiteCare</div>
        <div><span class="eyebrow">Личный кабинет</span><h1>С возвращением</h1><p class="muted">Войдите, чтобы открыть сайт «Салон Verme».</p></div>
        <div><label class="field-label" for="password">Пароль</label><input id="password" type="password" autocomplete="current-password" placeholder="Введите пароль" required></div>
        <button class="primary" type="submit">Войти в SiteCare</button>
        <p id="login-error" class="login-error" role="alert"></p>
        <div class="security-note">Защищённое соединение</div>
      </form>
    </div>
  </section>

  <div id="app" class="app-shell hidden">
    <aside class="sidebar">
      <div class="brand"><span class="mark">S</span>SiteCare</div>
      <div class="sidebar-site"><span>Ваш сайт</span><strong>Салон Verme</strong><small>${LOCK.hostname}</small></div>
      <nav id="nav" class="nav" aria-label="Разделы кабинета">
        <button data-section="overview" class="active"><span class="nav-icon"><svg viewBox="0 0 24 24"><path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z"/></svg></span><span>Главная</span></button>
        <button data-section="leads"><span class="nav-icon"><svg viewBox="0 0 24 24"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/></svg></span><span>Заявки</span></button>
        <button data-section="edit"><span class="nav-icon"><svg viewBox="0 0 24 24"><path d="m4 20 4.2-1 10.7-10.7a2.1 2.1 0 0 0-3-3L5.2 16zM14.5 6.7l2.8 2.8"/></svg></span><span>Изменить сайт</span></button>
        <button data-section="notifications"><span class="nav-icon"><svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg></span><span>Уведомления</span></button>
        <button data-section="settings"><span class="nav-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/></svg></span><span>Настройки</span></button>
      </nav>
      <div class="sidebar-foot"><a href="${LOCK.targetUrl}" target="_blank" rel="noreferrer"><span class="nav-icon"><svg viewBox="0 0 24 24"><path d="M14 3h7v7M10 14 21 3M21 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h6"/></svg></span>Открыть сайт</a></div>
    </aside>

    <main class="workspace">
      <div class="workspace-bar">
        <div class="workspace-name"><strong>Салон Verme</strong><span>Личный кабинет сайта</span></div>
        <a class="button-link secondary" href="${LOCK.targetUrl}" target="_blank" rel="noreferrer">Открыть сайт ↗</a>
      </div>

      <section id="section-overview" class="page active">
        <div class="page-header"><div><span class="eyebrow">Главная</span><h1>Состояние сайта</h1><p>Самое важное видно сразу. Подробности понадобятся только если что-то требует внимания.</p></div><div class="header-actions"><button class="secondary" data-go-section="edit">Изменить сайт</button><button id="check" class="primary">Проверить сайт</button></div></div>
        <div id="health-hero" class="hero">
          <div class="hero-copy"><span id="health-kicker" class="hero-kicker">Сайт под контролем</span><h2 id="overview-title">Проверяем состояние</h2><p id="overview-copy">SiteCare собирает последние результаты проверки.</p><p id="monitor" class="muted small" style="margin-top:9px">Проверка ещё не выполнялась.</p></div>
          <div id="health-icon" class="hero-icon" aria-hidden="true">✓</div>
        </div>
        <div class="status-grid">
          <article id="page-status-card" class="status-card"><div class="status-top"><span class="status-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 4 5.5 4 9s-1.5 6.5-4 9c-2.5-2.5-4-5.5-4-9s1.5-6.5 4-9z"/></svg></span><i class="status-dot"></i></div><span>Сайт</span><strong id="page-status-value">Нет данных</strong><small id="page-status-note">Проверка ещё не выполнялась</small></article>
          <article id="lead-status-card" class="status-card"><div class="status-top"><span class="status-icon"><svg viewBox="0 0 24 24"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/></svg></span><i class="status-dot"></i></div><span>Заявки</span><strong id="lead-status-value">Нет данных</strong><small id="lead-status-note">Ждём первую проверку</small></article>
          <article id="notification-status-card" class="status-card"><div class="status-top"><span class="status-icon"><svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg></span><i class="status-dot"></i></div><span>Уведомления</span><strong id="notification-status-value">Не подключены</strong><small id="notification-status-note">Можно подключить Telegram</small></article>
        </div>
        <div class="home-grid">
          <article class="card"><div class="card-head"><div><h2>Заявки сегодня</h2><p>SiteCare показывает только время получения</p></div><button class="ghost" data-go-section="leads">Посмотреть</button></div><div class="lead-summary"><div class="lead-number"><strong id="overview-lead-count">0</strong><span>сегодня</span></div><div class="lead-copy"><h3 id="overview-lead-title">Заявок пока нет</h3><p id="overview-lead-latest">Последняя заявка ещё не получена.</p></div></div></article>
          <article class="card"><div class="card-head"><div><h2>Последние изменения</h2><p>Что менялось на сайте</p></div><button class="ghost" data-go-section="edit">История</button></div><div id="overview-history" class="recent-list"><div class="empty">Изменений пока нет.</div></div></article>
        </div>
      </section>

      <section id="section-leads" class="page">
        <div class="page-header"><div><span class="eyebrow">Заявки</span><h1>Обращения с сайта</h1><p>Здесь видно, когда посетитель отправил данные. Содержимое заявки SiteCare не хранит.</p></div><div class="header-actions"><button id="form-refresh" class="secondary">Обновить</button><button id="form-check" class="primary">Проверить отправку с сайта</button></div></div>
        <div class="metric-grid">
          <div class="metric"><span>Сегодня</span><strong id="lead-today">0</strong><small>получено заявок</small></div>
          <div class="metric"><span>За 7 дней</span><strong id="lead-week">0</strong><small>последние семь дней</small></div>
          <div class="metric"><span>Последняя</span><strong id="lead-last">—</strong><small id="lead-last-date">пока не получена</small></div>
        </div>
        <article class="card"><div class="card-head"><div><h2>Последние заявки</h2><p>Без имени, телефона и текста</p></div><span id="lead-health-badge" class="badge">Нет данных</span></div><div id="leads-list" class="recent-list"><div class="empty">Заявок пока нет.</div></div><p class="privacy-note">SiteCare не хранит телефон, почту, имя и текст заявки. В кабинете остаются только время получения и технический номер формы.</p></article>
        <article class="card"><div class="card-head"><div><h2>Проверка получения</h2><p id="form-monitor">Структура отправки ещё не проверялась.</p></div><div class="row"><button id="form-test" class="secondary">Создать безопасный тест</button></div></div><div class="value-grid"><div class="value"><b>Последняя отправка</b><span id="form-receipt">Пока не получена.</span></div><div class="value"><b>Тест доставки</b><span id="form-test-status">Не запускался.</span></div></div><div id="form-test-panel" class="proposal hidden"><b id="form-test-title">Одноразовый тестовый код</b><p id="form-test-instruction" class="muted small" style="margin:8px 0">Вставьте код в подходящее поле публичной формы и отправьте её.</p><code id="form-test-marker"></code><p id="form-test-expiry" class="muted small" style="margin:8px 0 0"></p></div>
          <details class="technical"><summary>Техническое подключение Tilda</summary><div class="technical-body"><p class="muted small">Этот блок нужен только при первом подключении или если адрес был заменён.</p><div id="form-list" class="history"></div><div class="action-row"><button id="webhook-show" class="secondary">Показать адрес подключения</button></div><div id="webhook-setup" class="proposal hidden"><b>Адрес для Tilda Webhook</b><p class="muted small" style="margin:8px 0">Адрес даёт право передавать сигналы формы в SiteCare. Не публикуйте его и не отправляйте посторонним.</p><code id="webhook-value"></code><div class="row" style="margin-top:10px"><button id="webhook-copy" class="secondary">Скопировать</button></div><ol class="steps small"><li>В Tilda откройте «Настройки сайта → Формы → Webhook» и добавьте этот HTTPS-адрес.</li><li>В форме отметьте WEBHOOK. Оставьте включёнными только те Telegram, почту и CRM, которые принадлежат вам.</li><li>Если форма находится в общей шапке или подвале, опубликуйте все страницы сайта; иначе опубликуйте страницу с формой.</li></ol></div><p class="muted small">Подтверждение относится к пути «форма → SiteCare» и не доказывает доставку в другую CRM или почту.</p></div></details>
        </article>
      </section>

      <section id="section-edit" class="page">
        <div class="page-header"><div><span class="eyebrow">Изменить сайт</span><h1>Что хотите изменить?</h1><p>Опишите задачу обычными словами. Перед любым изменением SiteCare покажет результат и попросит подтверждение.</p></div></div>
        <div class="assistant-layout">
          <article class="card assistant-card">
            <div class="assistant-intro"><h2>Помощник SiteCare</h2><p>Например: «замени номер телефона» или «сделай график с 10 до 20».</p><p id="ai-limit" class="muted small" style="margin-top:9px">Простые команды работают без ИИ. Для нестандартного вопроса ассистент сначала спросит разрешение; без него ИИ не запустится.</p></div>
            <div class="quick-actions"><button class="quick-command" data-command="Замени телефон на ">Изменить телефон</button><button class="quick-command" data-command="Сделай график работы ">Обновить график</button><button class="quick-command" data-command="Измени текст кнопки на ">Текст кнопки</button><button class="quick-command" data-command="Проверь страницу сейчас">Проверить страницу</button></div>
            <div id="messages" class="messages"><div class="msg assistant">Напишите, что нужно изменить. Я ничего не применю без отдельного подтверждения.</div></div>
            <div id="ai-confirm" class="proposal hidden"><b>Использовать ИИ для этого вопроса?</b><p class="muted small" style="margin:8px 0 12px">До вашего согласия нейросеть не запускается и лимит не расходуется.</p><div class="row"><button id="ai-yes" class="primary">Да, использовать ИИ</button><button id="ai-no" class="secondary">Нет</button></div></div>
            <div id="proposal" class="proposal hidden"><b id="proposal-title"></b><dl><dt>Было</dt><dd id="before"></dd><dt>Станет</dt><dd id="after"></dd></dl><div class="row"><button id="apply" class="primary">Подтвердить</button><button id="cancel" class="secondary">Отменить</button></div></div>
            <form id="command-form" class="command-form"><label class="sr-only" for="command">Что изменить на сайте</label><input id="command" maxlength="1000" placeholder="Например: замените номер телефона…" required><button id="send" class="primary" type="submit">Отправить</button></form>
          </article>
          <aside class="stack">
            <article class="card side-card"><h2>Сейчас на сайте</h2><p>Текущие значения управляемых элементов.</p><div id="edit-values" class="value-grid"></div></article>
            <article class="card"><div class="card-head"><div><h2>История изменений</h2><p>Любую поддерживаемую правку можно вернуть</p></div></div><div id="history" class="history"><span class="muted">Изменений пока нет.</span></div></article>
          </aside>
        </div>
      </section>

      <section id="section-notifications" class="page">
        <div class="page-header"><div><span class="eyebrow">Уведомления</span><h1>Telegram</h1><p>SiteCare сообщит, если сайт или отправка заявок перестанут работать, и подтвердит восстановление.</p></div></div>
        <article class="card"><div class="notification-hero"><div><div class="card-head"><div><h2>Состояние уведомлений</h2><p id="telegram-status">Telegram ещё не подключён.</p></div></div><p class="muted small">${telegramDescription}</p></div><span id="telegram-badge" class="badge off">Не подключены</span></div>${telegramSetup}<p id="telegram-action-status" class="muted small" role="status" aria-live="polite" style="margin-top:11px"></p>${telegramConnect}<div id="telegram-actions" class="row hidden" style="margin-top:14px"><button id="telegram-test" class="secondary">Отправить тест</button><button id="telegram-disconnect" class="danger">Отключить Telegram</button></div></article>
        <article class="card"><div class="card-head"><div><h2>Последние уведомления</h2><p>Подключение, тесты, проблемы и восстановления</p></div></div><div id="telegram-events" class="history"><div class="empty">Событий пока нет.</div></div></article>
      </section>

      <section id="section-settings" class="page">
        <div class="page-header"><div><span class="eyebrow">Настройки</span><h1>Сайт и доступ</h1><p>Основные параметры кабинета. Технические детали скрыты и не нужны для ежедневной работы.</p></div></div>
        <div class="settings-grid">
          <article class="card"><div class="card-head"><div><h2>Салон Verme</h2><a class="settings-url" href="${LOCK.targetUrl}" target="_blank" rel="noreferrer">${LOCK.targetUrl}</a></div><span id="health-badge" class="badge">Нет данных</span></div><h3 style="margin:20px 0 10px;font-size:13px">Значения на сайте</h3><div id="values" class="value-grid"></div><div class="action-row"><span id="enabled-badge" class="badge"></span><button id="toggle" class="secondary"></button></div><p class="privacy-note">Изменения применяются только к закреплённой странице. До включения новые значения не показываются посетителям.</p></article>
          <article class="card"><div class="card-head"><div><h2>Безопасность</h2><p>Завершение текущего сеанса</p></div></div><p class="muted small">Пароль, адрес подключения и внутренние ключи не показываются другим посетителям сайта.</p><button id="logout" class="danger">Выйти из кабинета</button><details class="technical"><summary>О границах управления</summary><div class="technical-body"><p class="muted small">SiteCare меняет только телефон, график, текст и ссылку подготовленной кнопки на странице ${LOCK.pathname}. Другие сайты и страницы не затрагиваются.</p></div></details></article>
        </div>
      </section>
    </main>
  </div>
  <script>
  (() => {
    const $ = (id) => document.getElementById(id);
    const sharedBot = ${sharedBot ? "true" : "false"};
    let state = null;
    let proposalToken = null;
    let pendingAi = null;
    let chatHistory = [];
    let activeTestMarker = null;
    let telegramConnectUrl = '';
    let currentSection = 'overview';

    async function api(path, options = {}) {
      const response = await fetch(path, {
        credentials: 'same-origin',
        headers: {'Content-Type':'application/json', ...(options.headers || {})},
        ...options
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос.');
      return data;
    }

    function message(text, role = 'assistant', note = '') {
      const el = document.createElement('div');
      el.className = 'msg ' + role;
      el.textContent = text;
      if (note) {
        const label = document.createElement('span');
        label.className = 'msg-note';
        label.textContent = note;
        el.appendChild(label);
      }
      $('messages').appendChild(el);
      $('messages').scrollTop = $('messages').scrollHeight;
    }

    function telegramActionStatus(text, isError = false) {
      $('telegram-action-status').textContent = text || '';
      $('telegram-action-status').className = isError ? 'error small' : 'muted small';
    }

    function remember(role, content) {
      chatHistory.push({role, content});
      chatHistory = chatHistory.slice(-6);
    }

    function setAssistantLocked(locked) {
      $('command').disabled = locked;
      $('send').disabled = locked;
    }

    function displayValue(value) {
      if (typeof value === 'boolean') return value ? 'Включено' : 'Выключено';
      return String(value ?? '');
    }

    function showAiRemaining(remaining) {
      if (!Number.isFinite(Number(remaining))) return;
      $('ai-limit').textContent = 'Осталось ИИ-запросов сегодня: ' + Math.max(0, Number(remaining)) + '. Проверка, история, основные советы и простые правки работают без ИИ.';
    }

    function selectSection(section) {
      if (!$('section-' + section)) return;
      currentSection = section;
      document.querySelectorAll('#nav button[data-section]').forEach((button) => {
        const active = button.dataset.section === section;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active', page.id === 'section-' + section));
      window.scrollTo({top:0, behavior:'smooth'});
    }

    function emptyBlock(text) {
      const el = document.createElement('div');
      el.className = 'empty';
      el.textContent = text;
      return el;
    }

    function valueCards(config) {
      const labels = {phone:'Телефон',hours:'Время работы',ctaText:'Текст кнопки',ctaLink:'Ссылка кнопки'};
      return Object.keys(labels).map((key) => {
        const el = document.createElement('div');
        el.className = 'value';
        const title = document.createElement('b');
        title.textContent = labels[key];
        const value = document.createElement('span');
        value.textContent = config[key];
        el.append(title, value);
        return el;
      });
    }

    function validDate(value) {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date : null;
    }

    function relativeTime(value) {
      const date = validDate(value);
      if (!date) return '—';
      const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
      if (seconds < 60) return 'только что';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + ' мин назад';
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + ' ч назад';
      const days = Math.floor(hours / 24);
      if (days < 7) return days + ' дн назад';
      return date.toLocaleDateString('ru-RU', {day:'2-digit', month:'short'});
    }

    function setStatusCard(cardId, valueId, noteId, kind, value, note) {
      const card = $(cardId);
      card.className = 'status-card' + (kind ? ' ' + kind : '');
      $(valueId).textContent = value;
      $(noteId).textContent = note;
    }

    function historyRows(items, withUndo = true) {
      return items.map((item) => {
        const row = document.createElement('div');
        row.className = 'history-item';
        const main = document.createElement('div');
        main.className = 'history-main';
        const title = document.createElement('b');
        title.textContent = item.field_label;
        const detail = document.createElement('div');
        detail.className = 'muted small';
        detail.textContent = item.old_value + ' → ' + item.new_value + ' · ' + new Date(item.changed_at).toLocaleString('ru-RU');
        main.append(title, detail);
        row.append(main);
        if (withUndo && ['phone','hours','ctaText','ctaLink'].includes(item.field)) {
          const undo = document.createElement('button');
          undo.className = 'secondary';
          undo.textContent = 'Вернуть';
          undo.addEventListener('click', () => rollback(item.id));
          row.append(undo);
        }
        return row;
      });
    }

    function renderAssistantResult(result, originalRequest) {
      if (result.message) {
        const note = result.kind === 'ai-confirmation'
          ? 'ИИ пока не использован'
          : result.usesAi === false
            ? 'Без расхода ИИ'
            : result.usesAi === true
              ? 'ИИ использован для этого вопроса'
              : '';
        message(result.message, 'assistant', note);
        remember('assistant', result.message);
      }
      showAiRemaining(result.remaining);
      if (result.kind === 'advice') {
        setAssistantLocked(false);
        return;
      }
      if (result.kind === 'ai-confirmation') {
        if (!result.confirmationToken) throw new Error('Сервер не выдал безопасное подтверждение ИИ. ИИ не запущен.');
        pendingAi = {request:originalRequest, token:result.confirmationToken};
        $('ai-confirm').classList.remove('hidden');
        setAssistantLocked(true);
        return;
      }
      if (result.kind !== 'proposal' || !result.token || !result.change) {
        throw new Error('Ассистент вернул неполный ответ. Ничего не изменено.');
      }
      pendingAi = null;
      $('ai-confirm').classList.add('hidden');
      proposalToken = result.token;
      $('proposal-title').textContent = result.change.label;
      $('before').textContent = displayValue(result.change.before);
      $('after').textContent = displayValue(result.change.after);
      $('proposal').classList.remove('hidden');
      setAssistantLocked(true);
    }

    function renderOverview() {
      const pageKnown = Boolean(state.monitor);
      const pageOk = Boolean(state.monitor && state.monitor.ok);
      const forms = state.forms || {};
      const formKnown = Boolean(forms.monitor);
      const formOk = Boolean(forms.monitor && forms.monitor.ok);
      const receipt = forms.lastReceipt;
      const notifications = state.notifications || {};
      const notificationsOk = Boolean(notifications.configured && notifications.enabled && notifications.lastDeliveryOk !== false && !notifications.gatewayError);

      setStatusCard(
        'page-status-card', 'page-status-value', 'page-status-note',
        !pageKnown ? '' : pageOk ? 'good' : 'bad',
        !pageKnown ? 'Нет данных' : pageOk ? 'Открывается' : 'Не открывается',
        !pageKnown ? 'Проверка ещё не выполнялась' : pageOk ? 'Последняя проверка ' + relativeTime(state.monitor.checked_at) : state.monitor.details
      );

      const leadKind = !formKnown && !receipt ? '' : formKnown && !formOk ? 'bad' : receipt ? 'good' : 'attention';
      setStatusCard(
        'lead-status-card', 'lead-status-value', 'lead-status-note', leadKind,
        !formKnown && !receipt ? 'Нет данных' : formKnown && !formOk ? 'Нужна проверка' : receipt ? 'Приходят' : 'Готовы к приёму',
        receipt ? 'Последняя ' + relativeTime(receipt.receivedAt) : formKnown && formOk ? 'Заявок пока не было' : 'Ждём первую проверку'
      );

      setStatusCard(
        'notification-status-card', 'notification-status-value', 'notification-status-note',
        notificationsOk ? 'good' : notifications.configured ? 'bad' : 'attention',
        notificationsOk ? 'Подключены' : notifications.configured ? 'Ошибка отправки' : 'Не подключены',
        notificationsOk ? 'Сообщения придут в Telegram' : notifications.configured ? 'Откройте раздел уведомлений' : 'Можно подключить Telegram'
      );

      const hero = $('health-hero');
      const hasFailure = pageKnown && !pageOk || formKnown && !formOk;
      const allReady = pageOk && formOk && notificationsOk;
      hero.className = 'hero' + (hasFailure ? ' bad' : allReady ? '' : ' attention');
      $('health-kicker').textContent = hasFailure ? 'Нужно внимание' : allReady ? 'Сайт под контролем' : 'SiteCare работает';
      $('overview-title').textContent = hasFailure ? 'Есть проблема' : allReady ? 'Всё работает' : pageOk ? 'Сайт работает' : 'Проверяем состояние';
      $('overview-copy').textContent = hasFailure
        ? 'Откройте подробный статус ниже и повторите проверку.'
        : allReady
          ? 'Сайт открывается, заявки принимаются, уведомления подключены.'
          : pageOk
            ? 'Страница открывается. Осталось проверить заявки или настроить уведомления.'
            : 'Запустите первую проверку, чтобы увидеть состояние сайта.';
      $('health-icon').textContent = hasFailure ? '!' : allReady ? '✓' : '•';
      $('monitor').textContent = state.monitor
        ? state.monitor.details + ' Последняя проверка: ' + new Date(state.monitor.checked_at).toLocaleString('ru-RU')
        : 'Проверка ещё не выполнялась.';
      $('monitor').className = state.monitor && !state.monitor.ok ? 'error small' : 'muted small';

      const healthKnown = pageKnown && formKnown;
      const healthy = healthKnown && pageOk && formOk;
      $('health-badge').className = 'badge ' + (healthKnown ? healthy ? 'ok' : 'bad' : '');
      $('health-badge').textContent = healthKnown ? healthy ? 'Сайт работает' : 'Нужно внимание' : 'Нет данных';
      $('lead-health-badge').className = 'badge ' + (formKnown ? formOk ? 'ok' : 'bad' : '');
      $('lead-health-badge').textContent = formKnown ? formOk ? 'Приём работает' : 'Нужна проверка' : 'Нет данных';
    }

    function renderReceipts() {
      const forms = state.forms || {};
      const receipts = Array.isArray(forms.recentReceipts)
        ? forms.recentReceipts
        : forms.lastReceipt ? [forms.lastReceipt] : [];
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const weekStart = now.getTime() - 7 * 24 * 60 * 60 * 1000;
      const today = receipts.filter((item) => (validDate(item.receivedAt)?.getTime() || 0) >= todayStart).length;
      const week = receipts.filter((item) => (validDate(item.receivedAt)?.getTime() || 0) >= weekStart).length;
      const latest = receipts[0] || null;
      $('lead-today').textContent = String(today);
      $('lead-week').textContent = String(week);
      $('lead-last').textContent = latest ? relativeTime(latest.receivedAt) : '—';
      $('lead-last-date').textContent = latest ? new Date(latest.receivedAt).toLocaleString('ru-RU') : 'пока не получена';
      $('overview-lead-count').textContent = String(today);
      $('overview-lead-title').textContent = today ? today === 1 ? 'Новая заявка сегодня' : 'Новые заявки сегодня' : 'Заявок сегодня пока нет';
      $('overview-lead-latest').textContent = latest ? 'Последняя — ' + relativeTime(latest.receivedAt) : 'Последняя заявка ещё не получена.';

      const rows = receipts.slice(0, 12).map((item) => {
        const row = document.createElement('div');
        row.className = 'recent-item';
        const main = document.createElement('div');
        main.className = 'history-main';
        const title = document.createElement('b');
        title.textContent = item.matchedTest ? 'Тестовая заявка' : 'Заявка с сайта';
        const detail = document.createElement('div');
        detail.className = 'muted small';
        detail.textContent = new Date(item.receivedAt).toLocaleString('ru-RU') + (item.formId ? ' · форма ' + item.formId : '');
        main.append(title, detail);
        const badge = document.createElement('span');
        badge.className = 'badge ok';
        badge.textContent = item.matchedTest ? 'тест подтверждён' : 'получена';
        row.append(main, badge);
        return row;
      });
      $('leads-list').replaceChildren(...(rows.length ? rows : [emptyBlock('Заявок пока нет.') ]));
    }

    function render() {
      const config = state.config;
      $('enabled-badge').className = 'badge ' + (config.enabled ? 'ok' : 'off');
      $('enabled-badge').textContent = config.enabled ? 'Изменения показываются' : 'Изменения выключены';
      $('toggle').textContent = config.enabled ? 'Выключить изменения' : 'Включить изменения';
      $('toggle').className = config.enabled ? 'danger' : 'primary';
      $('values').replaceChildren(...valueCards(config));
      $('edit-values').replaceChildren(...valueCards(config));
      if (state.ai) showAiRemaining(state.ai.remaining);
      renderForms();
      renderNotifications();
      renderOverview();
      renderReceipts();

      const history = state.history || [];
      $('history').replaceChildren(...(history.length ? historyRows(history) : [emptyBlock('Изменений пока нет.') ]));
      $('overview-history').replaceChildren(...(history.length ? historyRows(history.slice(0, 4), false) : [emptyBlock('Изменений пока нет.') ]));
      selectSection(currentSection);
    }

    function renderForms() {
      const forms = state.forms || {};
      const monitor = forms.monitor;
      $('form-monitor').textContent = monitor
        ? (monitor.ok ? 'Отправка с сайта настроена. ' : monitor.details + ' ') + 'Последняя проверка: ' + new Date(monitor.checked_at).toLocaleString('ru-RU')
        : 'Отправка с сайта ещё не проверялась.';
      $('form-monitor').className = monitor && !monitor.ok ? 'error' : 'muted';

      const receipt = forms.lastReceipt;
      $('form-receipt').textContent = receipt
        ? 'Получена ' + new Date(receipt.receivedAt).toLocaleString('ru-RU') +
          (receipt.formId ? ' · форма ' + receipt.formId : '') +
          (receipt.matchedTest ? ' · тест подтверждён' : '')
        : 'Пока не получена.';

      const session = forms.testSession;
      $('form-test-status').textContent = !session
        ? 'Не запускался.'
        : session.status === 'confirmed'
          ? 'Подтверждён ' + new Date(session.confirmedAt).toLocaleString('ru-RU')
          : session.status === 'pending'
            ? 'Ожидается до ' + new Date(session.expiresAt).toLocaleString('ru-RU')
            : 'Срок последнего теста истёк.';
      $('form-test-status').className = session && session.status === 'confirmed' ? 'ok' : '';

      const list = monitor && Array.isArray(monitor.forms) ? monitor.forms : [];
      const formRows = list.map((form, index) => {
        const row = document.createElement('div');
        row.className = 'history-item';
        const main = document.createElement('div');
        main.className = 'history-main';
        const title = document.createElement('b');
        title.textContent = 'Форма ' + (index + 1) + (form.formId && form.formId !== 'без id' ? ' · ' + form.formId : '');
        const detail = document.createElement('div');
        detail.className = 'muted small';
        detail.textContent = 'Полей: ' + form.fieldCount + ' · кнопка отправки: ' + (form.submitDetected ? 'есть' : 'не найдена') + (form.blockId ? ' · блок ' + form.blockId : '');
        main.append(title, detail);
        const badge = document.createElement('span');
        badge.className = 'badge ' + (form.structuralReady ? 'ok' : 'bad');
        badge.textContent = form.structuralReady ? 'структура готова' : 'нужна проверка';
        row.append(main, badge);
        return row;
      });
      $('form-list').replaceChildren(...(formRows.length ? formRows : [emptyBlock('Данные подключения появятся после проверки.') ]));

      $('webhook-show').disabled = !forms.webhookReady;
      $('form-test').disabled = !forms.webhookReady;
      if (!forms.webhookReady) {
        $('form-monitor').textContent += ' Адрес подключения ещё не создан — повторно запустите установщик.';
        $('form-monitor').className = 'error';
      }
      if (activeTestMarker && session && session.status === 'confirmed') {
        $('form-test-panel').classList.remove('hidden');
        $('form-test-expiry').textContent = 'Доставка подтверждена. Код больше не нужен.';
      }
    }

    function renderNotifications() {
      const notifications = state.notifications || {};
      const configured = Boolean(notifications.configured && notifications.enabled);
      $('telegram-badge').className = 'badge ' + (configured ? 'ok' : 'off');
      $('telegram-badge').textContent = configured ? 'Подключены' : 'Не подключены';
      $('telegram-setup').classList.toggle('hidden', configured);
      $('telegram-actions').classList.toggle('hidden', !configured);
      if (configured) $('telegram-connect').classList.add('hidden');

      if (configured) {
        let status = 'Уведомления включены · ' + (notifications.destination || 'Telegram');
        if (notifications.lastDeliveryAt) {
          status += ' · последняя отправка ' + new Date(notifications.lastDeliveryAt).toLocaleString('ru-RU');
          status += notifications.lastDeliveryOk === false ? ' — ошибка' : ' — успешно';
        }
        if (notifications.lastError) status += '. ' + notifications.lastError;
        if (notifications.gatewayError) status += '. ' + notifications.gatewayError;
        $('telegram-status').textContent = status;
        $('telegram-status').className = notifications.lastDeliveryOk === false || notifications.gatewayError ? 'error' : 'muted';
      } else {
        let status = sharedBot
          ? 'Нажмите «Подключить Telegram», откройте официальный SiteCareBot и нажмите Start.'
          : notifications.connectionPending
            ? 'Подключение начато. Отправьте выданную команду боту и завершите подключение.'
            : 'Telegram ещё не подключён. Это можно сделать один раз прямо здесь — новая установка не потребуется.';
        if (notifications.legacyConfigured) status += ' До перехода прежнее подключение продолжает отправлять уведомления.';
        if (notifications.gatewayError) status += ' ' + notifications.gatewayError;
        $('telegram-status').textContent = status;
        $('telegram-status').className = notifications.gatewayError ? 'error' : 'muted';
        if (sharedBot ? !telegramConnectUrl : !$('telegram-code').textContent) $('telegram-connect').classList.add('hidden');
      }

      const labels = {
        connection:'Подключение',
        test:'Тест',
        'page-down':'Сайт не открывается',
        'page-recovered':'Сайт снова работает',
        'form-down':'Заявки не отправляются',
        'form-recovered':'Отправка заявок восстановлена'
      };
      const events = Array.isArray(notifications.events) ? notifications.events : [];
      const rows = events.map((event) => {
        const row = document.createElement('div');
        row.className = 'history-item';
        const main = document.createElement('div');
        main.className = 'history-main';
        const title = document.createElement('b');
        title.textContent = labels[event.eventType] || event.eventType;
        const detail = document.createElement('div');
        detail.className = 'muted small';
        detail.textContent = event.details + ' · ' + new Date(event.createdAt).toLocaleString('ru-RU');
        main.append(title, detail);
        const badge = document.createElement('span');
        badge.className = 'badge ' + (event.status === 'sent' ? 'ok' : 'bad');
        badge.textContent = event.status === 'sent' ? 'отправлено' : 'ошибка';
        row.append(main, badge);
        return row;
      });
      $('telegram-events').replaceChildren(...(rows.length ? rows : [emptyBlock('Уведомлений пока нет.') ]));
    }

    async function load() {
      state = await api('/api/admin/state');
      render();
    }

    async function rollback(id) {
      if (!confirm('Вернуть прежнее значение этой правки?')) return;
      try {
        await api('/api/admin/rollback', {method:'POST', body:JSON.stringify({historyId:id})});
        message('Прежнее значение возвращено.');
        await load();
      } catch (error) { message(error.message); }
    }

    $('login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      $('login-error').textContent = '';
      try {
        await api('/api/admin/login', {method:'POST', body:JSON.stringify({password:$('password').value})});
        $('password').value = '';
        $('login-card').classList.add('hidden');
        $('app').classList.remove('hidden');
        await load();
      } catch (error) { $('login-error').textContent = error.message; }
    });

    $('logout').addEventListener('click', async () => {
      await api('/api/admin/logout', {method:'POST', body:'{}'}).catch(() => {});
      location.reload();
    });

    $('nav').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-section]');
      if (button) selectSection(button.dataset.section);
    });

    document.querySelectorAll('[data-go-section]').forEach((button) => {
      button.addEventListener('click', () => selectSection(button.dataset.goSection));
    });

    document.querySelectorAll('.quick-command').forEach((button) => {
      button.addEventListener('click', () => {
        $('command').value = button.dataset.command || '';
        $('command').focus();
        $('command').setSelectionRange($('command').value.length, $('command').value.length);
      });
    });

    $('command-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const command = $('command').value.trim();
      if (!command) return;
      const previousHistory = chatHistory.slice(-6);
      message(command, 'user');
      remember('user', command);
      $('command').value = '';
      setAssistantLocked(true);
      try {
        const originalRequest = {message:command, history:previousHistory};
        const result = await api('/api/admin/assistant', {method:'POST', body:JSON.stringify(originalRequest)});
        renderAssistantResult(result, originalRequest);
      } catch (error) {
        message(error.message);
        remember('assistant', error.message);
        setAssistantLocked(false);
      }
    });

    $('ai-no').addEventListener('click', () => {
      pendingAi = null;
      $('ai-confirm').classList.add('hidden');
      setAssistantLocked(false);
      message('Хорошо. ИИ не использован, лимит не потрачен. Ничего не изменилось.', 'assistant', 'Без расхода ИИ');
    });

    $('ai-yes').addEventListener('click', async () => {
      if (!pendingAi) return;
      const originalRequest = pendingAi.request;
      const confirmationToken = pendingAi.token;
      pendingAi = null;
      $('ai-yes').disabled = true;
      $('ai-confirm').classList.add('hidden');
      try {
        const result = await api('/api/admin/assistant', {
          method:'POST',
          body:JSON.stringify({...originalRequest, aiConfirmationToken:confirmationToken})
        });
        renderAssistantResult(result, originalRequest);
      } catch (error) {
        message(error.message);
        remember('assistant', error.message);
        setAssistantLocked(false);
      } finally {
        $('ai-yes').disabled = false;
      }
    });

    $('cancel').addEventListener('click', () => {
      proposalToken = null;
      $('proposal').classList.add('hidden');
      setAssistantLocked(false);
      message('Правка отменена. Ничего не изменилось.');
    });

    $('apply').addEventListener('click', async () => {
      if (!proposalToken) return;
      $('apply').disabled = true;
      try {
        const result = await api('/api/admin/apply', {method:'POST', body:JSON.stringify({token:proposalToken})});
        proposalToken = null;
        $('proposal').classList.add('hidden');
        setAssistantLocked(false);
        message('Готово. Изменение сохранено' + (result.config.enabled ? ' и появится на странице не позднее чем через минуту.' : ', но показ на странице сейчас выключен.'));
        await load();
      } catch (error) { message(error.message); }
      finally { $('apply').disabled = false; }
    });

    $('toggle').addEventListener('click', async () => {
      const enabled = !state.config.enabled;
      const question = enabled
        ? 'Показать указанные значения на закреплённой странице? Сначала проверьте их выше.'
        : 'Выключить серверные правки и вернуть исходные значения Tilda?';
      if (!confirm(question)) return;
      try {
        await api('/api/admin/toggle', {method:'POST', body:JSON.stringify({enabled, baseVersion:state.config.version})});
        await load();
        message(enabled ? 'Показ серверных значений включён.' : 'Правки выключены: страница вернётся к исходным значениям Tilda.');
      } catch (error) { message(error.message); }
    });

    $('check').addEventListener('click', async () => {
      $('check').disabled = true;
      try {
        const result = await api('/api/admin/check', {method:'POST', body:'{}'});
        message(result.monitor.details);
        await load();
      } catch (error) { message(error.message); }
      finally { $('check').disabled = false; }
    });

    $('form-check').addEventListener('click', async () => {
      $('form-check').disabled = true;
      try {
        const result = await api('/api/admin/forms/check', {method:'POST', body:'{}'});
        message(result.formMonitor.details + ' Тестовая заявка не отправлялась.');
        await load();
      } catch (error) { message(error.message); }
      finally { $('form-check').disabled = false; }
    });

    $('webhook-show').addEventListener('click', async () => {
      $('webhook-show').disabled = true;
      try {
        const result = await api('/api/admin/forms/webhook-url', {method:'POST', body:'{}'});
        $('webhook-value').textContent = result.webhookUrl;
        $('webhook-setup').classList.remove('hidden');
      } catch (error) { message(error.message); }
      finally { $('webhook-show').disabled = false; }
    });

    $('webhook-copy').addEventListener('click', async () => {
      const value = $('webhook-value').textContent;
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        message('Адрес webhook скопирован.');
      } catch { message('Не удалось скопировать автоматически. Выделите адрес и скопируйте его вручную.'); }
    });

    $('form-test').addEventListener('click', async () => {
      $('form-test').disabled = true;
      try {
        const result = await api('/api/admin/forms/test', {method:'POST', body:'{}'});
        activeTestMarker = result.marker;
        $('form-test-title').textContent = result.markerKind === 'phone' ? 'Одноразовый тестовый номер' : 'Одноразовый тестовый код';
        $('form-test-instruction').textContent = result.instruction;
        $('form-test-marker').textContent = result.marker;
        $('form-test-expiry').textContent = 'Действует до ' + new Date(result.expiresAt).toLocaleString('ru-RU') + '. После отправки нажмите «Обновить статус».';
        $('form-test-panel').classList.remove('hidden');
        await load();
      } catch (error) { message(error.message); }
      finally { $('form-test').disabled = false; }
    });

    $('form-refresh').addEventListener('click', async () => {
      $('form-refresh').disabled = true;
      try {
        await load();
        const session = state.forms && state.forms.testSession;
        message(session && session.status === 'confirmed' ? 'Тестовая доставка подтверждена.' : 'Нового подтверждённого теста пока нет.');
      } catch (error) { message(error.message); }
      finally { $('form-refresh').disabled = false; }
    });

    if (sharedBot) {
      $('telegram-start').addEventListener('click', async () => {
        const botWindow = window.open('about:blank', '_blank');
        if (botWindow) botWindow.opener = null;
        $('telegram-start').disabled = true;
        telegramActionStatus('Создаю одноразовую ссылку подключения…');
        try {
          const result = await api('/api/admin/notifications/telegram/start', {method:'POST', body:'{}'});
          telegramConnectUrl = result.connectUrl;
          $('telegram-open').href = result.connectUrl;
          $('telegram-open').textContent = result.botUsername ? 'Открыть @' + result.botUsername : 'Открыть SiteCareBot';
          $('telegram-expiry').textContent = 'Ссылка действует до ' + new Date(result.expiresAt).toLocaleString('ru-RU') + '.';
          $('telegram-connect').classList.remove('hidden');
          if (botWindow) botWindow.location.replace(result.connectUrl);
          telegramActionStatus(botWindow ? 'SiteCareBot открыт. Нажмите Start, затем вернитесь сюда.' : 'Ссылка готова. Откройте бота и нажмите Start.');
        } catch (error) {
          if (botWindow) botWindow.close();
          telegramActionStatus(error.message, true);
          message(error.message);
        }
        finally { $('telegram-start').disabled = false; }
      });
    } else {
      $('telegram-start-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const token = $('telegram-token').value.trim();
        if (!token) return;
        $('telegram-start').disabled = true;
        telegramActionStatus('Проверяю соединение с Telegram. Обычно это занимает несколько секунд…');
        try {
          const result = await api('/api/admin/notifications/telegram/start', {
            method:'POST',
            body:JSON.stringify({botToken:token})
          });
          $('telegram-token').value = '';
          $('telegram-code').textContent = result.code;
          $('telegram-expiry').textContent = 'Команда действует до ' + new Date(result.expiresAt).toLocaleString('ru-RU') + '.';
          $('telegram-connect').classList.remove('hidden');
          telegramActionStatus('Бот проверен. Отправьте команду ниже своему боту.');
          message('Бот проверен. Отправьте показанную команду в Telegram и завершите подключение.');
          await load();
        } catch (error) { telegramActionStatus(error.message, true); message(error.message); }
        finally { $('telegram-start').disabled = false; }
      });

      $('telegram-copy').addEventListener('click', async () => {
        const code = $('telegram-code').textContent;
        if (!code) return;
        try {
          await navigator.clipboard.writeText(code);
          message('Команда Telegram скопирована.');
        } catch { message('Не удалось скопировать автоматически. Выделите команду и скопируйте её вручную.'); }
      });
    }

    $('telegram-confirm').addEventListener('click', async () => {
      $('telegram-confirm').disabled = true;
      telegramActionStatus('Проверяю полученную команду…');
      try {
        await api('/api/admin/notifications/telegram/confirm', {method:'POST', body:'{}'});
        if (!sharedBot) $('telegram-code').textContent = '';
        telegramConnectUrl = '';
        $('telegram-connect').classList.add('hidden');
        telegramActionStatus(sharedBot ? 'Официальный SiteCareBot подключён.' : 'Telegram подключён. Проверочное сообщение отправлено.');
        message(sharedBot ? 'Официальный SiteCareBot подключён. Теперь можно отправить тест.' : 'Telegram подключён. Тестовое сообщение уже отправлено.');
        await load();
      } catch (error) { telegramActionStatus(error.message, true); message(error.message); }
      finally { $('telegram-confirm').disabled = false; }
    });

    $('telegram-test').addEventListener('click', async () => {
      $('telegram-test').disabled = true;
      telegramActionStatus('Отправляю тестовое уведомление…');
      try {
        await api('/api/admin/notifications/telegram/test', {method:'POST', body:'{}'});
        telegramActionStatus('Тестовое уведомление успешно отправлено.');
        message('Тестовое уведомление отправлено в Telegram.');
        await load();
      } catch (error) { telegramActionStatus(error.message, true); message(error.message); }
      finally { $('telegram-test').disabled = false; }
    });

    $('telegram-disconnect').addEventListener('click', async () => {
      if (!confirm(sharedBot ? 'Отключить уведомления SiteCare для этого сайта?' : 'Отключить уведомления SiteCare и удалить сохранённый токен бота?')) return;
      $('telegram-disconnect').disabled = true;
      try {
        await api('/api/admin/notifications/telegram/disconnect', {method:'POST', body:'{}'});
        if (!sharedBot) $('telegram-code').textContent = '';
        telegramConnectUrl = '';
        telegramActionStatus('Telegram отключён.');
        message(sharedBot ? 'Telegram отключён для этого сайта.' : 'Telegram отключён. Сохранённый токен удалён.');
        await load();
      } catch (error) { telegramActionStatus(error.message, true); message(error.message); }
      finally { $('telegram-disconnect').disabled = false; }
    });

    api('/api/admin/session').then(async () => {
      $('login-card').classList.add('hidden');
      $('app').classList.remove('hidden');
      await load();
    }).catch(() => {});
  })();
  </script>
</body>
</html>`;
}
