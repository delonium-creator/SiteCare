// Only deterministic, actionable observations enter the client workspace.
// Static HTML absence is an observation, never proof of lost leads or revenue.
const RULES = {
  'title-missing': ['improvement', 'В поиске может появиться неподходящий заголовок страницы.'],
  'description-missing': ['improvement', 'Поисковая система сама выберет фрагмент описания; он может не отражать предложение.'],
  'noindex': ['review', 'Если страницу нужно продвигать, этот запрет мешает её индексации. Для служебной страницы он может быть правильным.'],
  'h1-missing': ['review', 'Нужно проверить смысловую структуру страницы. Визуально заголовок может присутствовать в другом элементе.'],
  'h1-multiple': ['review', 'Несколько H1 не доказывают ошибку. Специалист проверит иерархию заголовков.'],
  'lang-missing': ['improvement', 'Экранному диктору сложнее выбрать правильное произношение.'],
  'viewport-missing': ['review', 'Мобильное отображение может масштабироваться неправильно; нужна проверка в браузере.'],
  'image-alt': ['review', 'Содержательным изображениям может не хватать описаний для экранного диктора. Декоративным изображениям пустой alt подходит.'],
  'mixed-content': ['review', 'Браузер может обновить адрес до HTTPS или заблокировать загрузку ресурса. Нужно проверить конкретный ресурс.'],
  'og-tags': ['improvement', 'При отправке ссылки превью может оказаться неполным.'],
  'latency': ['review', 'Зафиксирована задержка ответа из точки проверки SiteCare. Она не равна скорости загрузки у всех посетителей.'],
  'duplicate-title': ['improvement', 'Одинаковые заголовки затрудняют различение страниц в поиске.'],
  'duplicate-description': ['improvement', 'Описание не объясняет отличие этой страницы от других.'],
  'page-unavailable': ['review', 'SiteCare не смог получить страницу. Это может быть сбой сайта, сети или ограничение автоматических запросов.']
};

export function actionableFindings(diagnostics, site, now = Date.now()) {
  const checkedAt = diagnostics?.checkedAt;
  const fresh = Number.isFinite(Date.parse(checkedAt)) && now-Date.parse(checkedAt)<48*3600000;
  const seen = new Set();
  const result = [];
  for (const item of diagnostics?.issues || []) {
    const code = String(item.issueId || '').split(':')[0];
    const rule = RULES[code];
    if (!rule || !item.evidence || !item.recommendation || seen.has(item.issueId)) continue;
    let page;
    try { page=new URL(item.page); if(page.origin!==site.target_origin || !['http:','https:'].includes(page.protocol)) continue; } catch { continue; }
    seen.add(item.issueId);
    result.push({id:item.issueId,category:item.category,title:item.title,page:page.href,
      evidence:item.evidence,cause:item.probableCause || 'Причина пока не установлена.',
      causeStatus:'hypothesis',impact:rule[1],action:item.recommendation,
      kind:fresh?rule[0]:'outdated',checkedAt,source:'Опубликованный HTML'});
  }
  if (site.last_monitor_at && site.page_ok!=null && Number(site.page_ok)===0) {
    const http=Number(site.last_http_status || 0),freshMonitor=now-Date.parse(site.last_monitor_at)<Math.max(30,Number(site.monitor_interval_minutes||5)*3)*60000;
    result.unshift({id:'monitor:availability',category:'availability',title:http?'Страница вернула HTTP '+http:'Не удалось получить ответ сайта',page:site.target_url||site.target_origin+site.target_pathname,
      evidence:http?'Ответ на запрос SiteCare: HTTP '+http+'.':String(site.last_error||'Запрос завершился без ответа.'),
      cause:'Причина не установлена. Нужно повторить запрос и проверить сайт из браузера.',causeStatus:'hypothesis',
      impact:'Посетители могут не открыть страницу. Единичная проверка не доказывает недоступность для всех.',
      action:'Повторить проверку; если ошибка сохраняется, проверить публикацию и доступность сайта.',
      kind:freshMonitor?(http>=500?'problem':'review'):'outdated',checkedAt:site.last_monitor_at,source:'HTTP-проверка'});
  }
  return result;
}

export async function siteFindings(env,site) {
  const cache=await env.GATEWAY_DB.prepare('SELECT diagnostics_json,checked_at FROM platform_diagnostics_cache WHERE site_id=?').bind(site.site_id).first();
  let diagnostics=null;
  try { diagnostics=cache?JSON.parse(cache.diagnostics_json):null; } catch {}
  return {findings:actionableFindings(diagnostics,site),checkedAt:cache?.checked_at||null,
    coverage:{pages:Number(diagnostics?.pagesAnalyzed||0),failedPages:Number(diagnostics?.pagesFailed||0),truncated:Boolean(diagnostics?.truncated),method:'HTTP и опубликованный HTML',limitations:'Проверка не выполняет JavaScript и не проверяет внешний вид, юридическое соответствие или получение заявки отделом продаж.'}};
}
