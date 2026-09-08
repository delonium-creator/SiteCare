import {newId,safeText,safeMessageText} from './platform-core.js';
import {encryptProtectedJson,decryptProtectedJson} from './platform-leads.js';
import {siteFindings} from './platform-findings.js';

function fail(message,status=400,code='CARE_ERROR'){throw Object.assign(new Error(message),{status,code});}
const closed=new Set(['completed','canceled']);
function content(value,max=4000){const text=safeMessageText(value,max);if(!text)fail('Заполните сообщение.');return text;}
export async function careList(env,siteId){
  const rows=await env.GATEWAY_DB.prepare('SELECT * FROM platform_care_requests WHERE site_id=? ORDER BY updated_at DESC LIMIT 200').bind(siteId).all();
  return rows.results||[];
}
export async function careQueue(env){
  const rows=await env.GATEWAY_DB.prepare('SELECT r.*,s.name AS site_name,a.name AS account_name FROM platform_care_requests r JOIN platform_sites s ON s.site_id=r.site_id JOIN platform_accounts a ON a.account_id=r.account_id ORDER BY CASE WHEN r.status IN (\'completed\',\'canceled\') THEN 1 ELSE 0 END,r.updated_at DESC LIMIT 300').all();
  return rows.results||[];
}
export async function careDetails(env,siteId,requestId){
  const row=await env.GATEWAY_DB.prepare('SELECT * FROM platform_care_requests WHERE request_id=? AND site_id=?').bind(requestId,siteId).first();
  if(!row)fail('Обращение не найдено.',404,'NOT_FOUND');
  const messages=await env.GATEWAY_DB.prepare('SELECT * FROM platform_care_messages WHERE request_id=? ORDER BY created_at,message_id LIMIT 500').bind(requestId).all();
  const publicMessages=await Promise.all((messages.results||[]).filter(m=>m.author_type!=='system').map(async m=>({id:m.message_id,role:m.author_type,createdAt:m.created_at,
    content:m.content_ciphertext?(await decryptProtectedJson(env,m.content_ciphertext,m.content_iv))?.content||'Сообщение недоступно':m.content})));
  return {request:row,messages:publicMessages};
}
export async function createCare(env,site,user,body){
  const title=safeText(body.title,180);if(!title)fail('Кратко назовите задачу.');
  const message=content(body.content);
  let finding=null;
  if(body.findingId){
    finding=(await siteFindings(env,site)).findings.find(f=>f.id===body.findingId);
    if(!finding)fail('Результат проверки изменился. Обновите страницу.',409,'FINDING_CHANGED');
    const existing=await env.GATEWAY_DB.prepare("SELECT request_id FROM platform_care_requests WHERE site_id=? AND finding_id=? AND status NOT IN ('completed','canceled')").bind(site.site_id,finding.id).first();
    if(existing)return {created:false,...await careDetails(env,site.site_id,existing.request_id)};
  }
  const id=newId('care',site.site_id),now=new Date().toISOString();
  const encrypted=await encryptProtectedJson(env,{content:message});
  try{
    await env.GATEWAY_DB.batch([
      env.GATEWAY_DB.prepare('INSERT INTO platform_care_requests(request_id,site_id,account_id,created_by,title,finding_id,evidence_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,site.site_id,site.account_id,user.user_id,title,finding?.id||null,JSON.stringify(finding||{}),now,now),
      env.GATEWAY_DB.prepare("INSERT INTO platform_care_messages(message_id,request_id,author_type,author_user_id,content_ciphertext,content_iv,created_at) VALUES(?,?,'client',?,?,?,?)").bind(newId('msg','care'),id,user.user_id,encrypted.ciphertext,encrypted.iv,now)
    ]);
  }catch(error){
    if(finding){const existing=await env.GATEWAY_DB.prepare("SELECT request_id FROM platform_care_requests WHERE site_id=? AND finding_id=? AND status NOT IN ('completed','canceled')").bind(site.site_id,finding.id).first();if(existing)return {created:false,...await careDetails(env,site.site_id,existing.request_id)};}
    throw error;
  }
  return {created:true,...await careDetails(env,site.site_id,id)};
}
export async function updateCare(env,site,user,id,body){
  const {request:row}=await careDetails(env,site.site_id,id);
  if(Number(body.revision)!==row.revision)fail('Обращение изменилось. Обновите его перед действием.',409,'STALE_REQUEST');
  const specialist=user.platform_role==='operator',action=body.action;
  const now=new Date().toISOString();
  let status=row.status,quote=row.quote_minor,scope=row.quote_scope,due=row.quote_due,accepted=row.accepted_at,payment=row.payment_reference,paid=row.paid_at,resolution=row.resolution,verification=row.verification,message='';
  if(closed.has(status))fail('Обращение закрыто. Создайте новое, если требуется продолжение.',409,'REQUEST_CLOSED');
  if(action==='message'){
    message=content(body.content);
    if(!specialist && status==='waiting_client')status='in_progress';
  }else if(action==='answer'){
    if(!specialist)fail('Консультацию завершает специалист.',403,'FORBIDDEN');
    if(status!=='new'||quote!==null)fail('Ответ без работ возможен до предложения по задаче.',409);
    resolution=content(body.resolution,1600);verification='Предоставлена консультация. Изменения на сайте не выполнялись.';
    status='completed';message='Ответ специалиста: '+resolution+'\n'+verification;
  }else if(action==='quote'){
    if(!specialist)fail('Предложение готовит специалист.',403,'FORBIDDEN');
    if(!['new','quoted'].includes(status))fail('Уже согласованное предложение нельзя менять.',409);
    quote=body.amountMinor;if(!Number.isSafeInteger(quote)||quote<0||quote>100000000)fail('Укажите корректную стоимость в копейках.');
    scope=content(body.scope,1600);due=safeText(body.due,180);if(!due)fail('Укажите срок и от какого события он считается.');
    status='quoted';message='Предложение: '+scope+'\nСтоимость: '+(quote/100)+' ₽.\nСрок: '+due;
  }else if(action==='accept'){
    if(specialist)fail('Предложение принимает клиент.',403,'FORBIDDEN');
    if(status!=='quoted')fail('Нет предложения для согласования.',409);
    status='approved';accepted=now;message='Клиент согласовал объём, стоимость и срок. '+(quote===0?'Работа включена в сопровождение.':'Оплата пока не подтверждена.');
  }else if(action==='payment'){
    if(!specialist)fail('Оплату подтверждает специалист после получения средств.',403,'FORBIDDEN');
    if(status!=='approved'||!quote||paid)fail('Оплату нельзя отметить в этом состоянии.',409);
    const reference=content(body.reference,300);payment='manual';paid=now;message='Специалист вручную подтвердил получение '+(quote/100)+' ₽. Основание: '+reference;
  }else if(action==='start'){
    if(!specialist)fail('Работу начинает специалист.',403,'FORBIDDEN');
    if(status!=='approved'||quote===null||(quote>0&&!paid))fail('Сначала нужны согласие клиента и подтверждение оплаты; включённая работа стоит 0 ₽.',409);
    status='in_progress';message='Специалист начал работу.';
  }else if(action==='wait'){
    if(!specialist||status!=='in_progress')fail('Уточнение доступно специалисту по задаче в работе.',409);
    status='waiting_client';message=content(body.content);
  }else if(action==='complete'){
    if(!specialist||!['in_progress','waiting_client'].includes(status))fail('Завершить можно задачу в работе.',409);
    resolution=content(body.resolution,1600);verification=content(body.verification,1600);
    status='completed';message='Результат работы: '+resolution+'\nКак проверено специалистом: '+verification;
  }else if(action==='cancel'){
    if(paid||!['new','quoted','approved'].includes(status))fail('Для отмены оплаченной или начатой работы напишите специалисту: сначала нужно согласовать расчёт.',409);
    status='canceled';message='Задача отменена.';
  }else fail('Неизвестное действие.');
  const encrypted=await encryptProtectedJson(env,{content:message});
  const results=await env.GATEWAY_DB.batch([
    env.GATEWAY_DB.prepare('INSERT INTO platform_care_messages(message_id,request_id,author_type,author_user_id,content_ciphertext,content_iv,created_at) SELECT ?,request_id,?,?,?,?,? FROM platform_care_requests WHERE request_id=? AND revision=?').bind(newId('msg','care'),specialist?'support':'client',user.user_id,encrypted.ciphertext,encrypted.iv,now,id,row.revision),
    env.GATEWAY_DB.prepare('UPDATE platform_care_requests SET status=?,revision=revision+1,quote_minor=?,quote_scope=?,quote_due=?,accepted_at=?,payment_reference=?,paid_at=?,resolution=?,verification=?,updated_at=? WHERE request_id=? AND revision=?').bind(status,quote,scope,due,accepted,payment,paid,resolution,verification,now,id,row.revision)
  ]);
  if(!results.at(-1)?.meta?.changes)fail('Обращение изменилось. Обновите страницу.',409,'STALE_REQUEST');
  return careDetails(env,site.site_id,id);
}
