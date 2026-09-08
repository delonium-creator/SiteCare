import test from 'node:test';
import assert from 'node:assert/strict';
import {careFixture} from './helpers/care-fixture.js';
import gateway from '../gateway/src/index.js';
import {diagnosePage} from '../gateway/src/platform-monitor.js';
import {loaderJavascript} from '../gateway/src/platform-core.js';
import {Script} from 'node:vm';
import {readFile} from 'node:fs/promises';
import {actionableFindings} from '../gateway/src/platform-findings.js';

test('care requests preserve evidence, isolate accounts and enforce quote/payment/work transitions',async t=>{
  const f=await careFixture();t.after(()=>f.runtime.dispose());
  const base='/v1/platform/sites/demo-site/care';
  const call=async(role,path,body,expected=200)=>{const r=await f.request(role,path,body?'POST':'GET',body);const d=await r.json();assert.equal(r.status,expected,JSON.stringify(d));return d;};
  await call('outsider',base,null,403);
  let d=await call('client',base,{title:'Заменить номер',content:'Новый номер +7 999 000-00-01'},201);
  const id=d.request.request_id,path=base+'/'+id;
  const dashboard=await call('specialist','/v1/platform/dashboard');
  assert.equal(dashboard.support.open,1);assert.equal(dashboard.support.new,1);
  assert.equal(d.messages[0].content,'Новый номер +7 999 000-00-01');
  const stored=await f.db.prepare('SELECT * FROM platform_care_messages WHERE request_id=?').bind(id).first();
  assert.ok(stored.content_ciphertext);assert.doesNotMatch(stored.content,/999/);
  await call('outsider',path,null,403);
  await call('client',path,{action:'quote',revision:1,amountMinor:120000,scope:'Работа',due:'Завтра'},403);
  d=await call('specialist',path,{action:'quote',revision:1,amountMinor:120000,scope:'Замена номера на всех страницах',due:'1 день после оплаты'});
  await call('client',path,{action:'accept',revision:1},409);
  d=await call('client',path,{action:'accept',revision:d.request.revision});
  assert.equal(d.request.status,'approved');assert.equal(d.request.paid_at,null);
  await call('specialist',path,{action:'start',revision:d.request.revision},409);
  await call('client',path,{action:'payment',revision:d.request.revision,reference:'подделка'},403);
  await call('specialist',path,{action:'quote',revision:d.request.revision,amountMinor:99999,scope:'Новая цена',due:'Завтра'},409);
  d=await call('specialist',path,{action:'payment',revision:d.request.revision,reference:'Получен перевод, проверен специалистом'});
  assert.ok(d.request.paid_at);assert.equal(d.request.payment_reference,'manual');
  assert.match(d.messages.at(-1).content,/Получен перевод/);
  const paidRow=await f.db.prepare('SELECT payment_reference FROM platform_care_requests WHERE request_id=?').bind(id).first();
  assert.equal(paidRow.payment_reference,'manual');
  await call('client',path,{action:'cancel',revision:d.request.revision},409);
  d=await call('specialist',path,{action:'start',revision:d.request.revision});
  await call('specialist',path,{action:'complete',revision:d.request.revision,resolution:'Готово'},400);
  d=await call('specialist',path,{action:'complete',revision:d.request.revision,resolution:'Номер обновлён в Tilda',verification:'Проверены шапка, подвал и ссылка звонка на /projects'});
  assert.equal(d.request.status,'completed');assert.match(d.request.verification,/projects/);
  await call('client',path,{action:'message',revision:d.request.revision,content:'Позднее сообщение'},409);
});

test('included work still requires agreement, concurrent updates cannot double-accept',async t=>{
  const f=await careFixture();t.after(()=>f.runtime.dispose());const base='/v1/platform/sites/demo-site/care';
  let d=await(await f.request('client',base,'POST',{title:'Проверить форму',content:'Нужна тестовая отправка'})).json();const path=base+'/'+d.request.request_id;
  d=await(await f.request('specialist',path,'POST',{action:'quote',revision:1,amountMinor:0,scope:'Тест формы',due:'Сегодня'})).json();
  const responses=await Promise.all([1,2].map(()=>f.request('client',path,'POST',{action:'accept',revision:d.request.revision})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  d=await(await f.request('client',path)).json();
  const started=await f.request('specialist',path,'POST',{action:'start',revision:d.request.revision});assert.equal(started.status,200);
});

test('diagnostics separate uncertain observations and reject invented facts',()=>{
  const site={target_origin:'https://example.test'},now=Date.now(),base={page:'https://example.test/',evidence:'HTML содержит факт',recommendation:'Проверить настройку',title:'Наблюдение'};
  const diagnostics={checkedAt:new Date(now).toISOString(),issues:[{...base,issueId:'image-alt:/'},{...base,issueId:'ai-structured-data:/'},{...base,issueId:'legal-cookie-banner:/'},{...base,issueId:'title-missing:/',evidence:''},{...base,issueId:'title-missing:/other',page:'https://other.test/'}]};
  const rows=actionableFindings(diagnostics,site,now);assert.equal(rows.length,1);assert.equal(rows[0].kind,'review');assert.equal(rows[0].causeStatus,'hypothesis');
  assert.equal(actionableFindings({...diagnostics,checkedAt:'2020-01-01'},site,now)[0].kind,'outdated');
  assert.deepEqual(actionableFindings(null,site),[]);
});

test('removed editor endpoints cannot mutate even for a specialist; public config is inert',async t=>{
  const f=await careFixture();t.after(()=>f.runtime.dispose());
  for(const tail of ['assistant','assistant/locate-phone','changes/apply','overrides/rollback']){
    assert.equal((await f.request('specialist','/v1/platform/sites/demo-site/'+tail,'POST',{})).status,410);
  }
  assert.equal((await f.request('specialist','/v1/platform/sites/demo-site/overrides','PATCH',{enabled:true})).status,410);
  const response=await f.request('client','/v1/public/sites/demo-site/config?key=preview-loader-key-0123456789');
  // Public request Origin must match the connected site; an unrelated origin stays rejected.
  assert.equal(response.status,403);
  const valid=await gateway.fetch(new Request('https://preview.test/v1/public/sites/demo-site/config?key=preview-loader-key-0123456789',{headers:{Origin:'https://example.test'}}),f.env);
  assert.equal(valid.status,200);const config=await valid.json();assert.equal(config.enabled,false);assert.equal(config.phone,'');assert.deepEqual(config.phoneRules,[]);
  assert.equal((await f.request('client','/v1/platform/sites/demo-site/support','POST',{})).status,410);
  const row=await f.db.prepare("SELECT phone FROM platform_site_overrides WHERE site_id='demo-site'").first();assert.equal(row.phone,'+7 999 123-45-67');
});

test('consultations close with an answer but cannot bypass an accepted paid proposal',async t=>{
  const f=await careFixture();t.after(()=>f.runtime.dispose());const base='/v1/platform/sites/demo-site/care';
  let d=await(await f.request('client',base,'POST',{title:'Как передать материалы?',content:'Куда отправить фотографии?'})).json();const path=base+'/'+d.request.request_id;
  assert.equal((await f.request('client',path,'POST',{action:'answer',revision:1,resolution:'Сам закрыл'})).status,403);
  d=await(await f.request('specialist',path,'POST',{action:'answer',revision:1,resolution:'Пришлите ссылку на папку в этом обращении.'})).json();
  assert.equal(d.request.status,'completed');assert.equal(d.request.quote_minor,null);assert.match(d.request.verification,/не выполнялись/);
  d=await(await f.request('client',base,'POST',{title:'Новая задача',content:'Нужно изменить страницу'})).json();const paidPath=base+'/'+d.request.request_id;
  assert.equal((await f.request('specialist',paidPath,'POST',{action:'quote',revision:1,amountMinor:null,scope:'Работа',due:'Завтра'})).status,400);
  await f.request('specialist',paidPath,'POST',{action:'quote',revision:1,amountMinor:10000,scope:'Работа',due:'Завтра'});
  assert.equal((await f.request('specialist',paidPath,'POST',{action:'answer',revision:2,resolution:'Попытка обхода'})).status,409);
});

test('finding requests use server evidence, deduplicate and reject viewer writes',async t=>{
  const f=await careFixture();t.after(()=>f.runtime.dispose());const base='/v1/platform/sites/demo-site/care';
  const report={checkedAt:new Date().toISOString(),issues:[{issueId:'title-missing:/',title:'Нет title',page:'https://example.test/',evidence:'Тег title отсутствует.',recommendation:'Указать title.'}]};
  await f.db.prepare('INSERT INTO platform_diagnostics_cache(site_id,diagnostics_json,checked_at) VALUES(?,?,?)').bind('demo-site',JSON.stringify(report),report.checkedAt).run();
  const body={title:'Проверить заголовок',content:'Проверьте',findingId:'title-missing:/',evidence:{evidence:'Подделка'}};
  const first=await f.request('client',base,'POST',body);assert.equal(first.status,201);const created=await first.json();
  assert.equal(JSON.parse(created.request.evidence_json).evidence,'Тег title отсутствует.');
  const again=await f.request('client',base,'POST',body);assert.equal(again.status,200);assert.equal((await again.json()).request.request_id,created.request.request_id);
  assert.equal((await f.request('client',base,'POST',{...body,findingId:'invented:/'})).status,409);
  await f.db.prepare("UPDATE platform_memberships SET role='viewer' WHERE user_id=?").bind(f.users.client.user_id).run();
  assert.equal((await f.request('client',base)).status,200);
  assert.equal((await f.request('client',base,'POST',{title:'Нет прав',content:'Создать'})).status,403);
});

test('finding coverage reports scanned and failed pages without inventing completeness',async t=>{
  const f=await careFixture();t.after(()=>f.runtime.dispose());const checkedAt=new Date().toISOString();
  const diagnostics={checkedAt,pagesAnalyzed:7,pagesFailed:2,truncated:true,issues:[]};
  await f.db.prepare('INSERT INTO platform_diagnostics_cache(site_id,diagnostics_json,checked_at) VALUES(?,?,?)').bind('demo-site',JSON.stringify(diagnostics),checkedAt).run();
  const response=await f.request('client','/v1/platform/sites/demo-site/care');const data=await response.json();
  assert.deepEqual(data.coverage,{pages:7,failedPages:2,truncated:true,method:'HTTP и опубликованный HTML',limitations:'Проверка не выполняет JavaScript и не проверяет внешний вид, юридическое соответствие или получение заявки отделом продаж.'});
});

test('loader ignores even stale editing instructions and mixed content excludes ordinary links',async()=>{
  const attributes=new Map();const document={currentScript:{src:'https://preview.test/sitecare-loader.js',dataset:{sitecareSite:'demo-site',sitecareKey:'key'}},documentElement:{setAttribute:(k,v)=>attributes.set(k,v)}};
  Object.defineProperty(document,'body',{get(){throw new Error('Loader must not access page content');}});
  new Script(loaderJavascript()).runInNewContext({document,location:{origin:'https://example.test'},URL,encodeURIComponent,fetch:async()=>({ok:true,json:async()=>({siteId:'demo-site',origin:'https://example.test',enabled:true,phone:'999',rules:[{newValue:'bad'}]})})});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(attributes.get('data-sitecare-status'),'connected');assert.equal(attributes.size,2);
  const html='<html><a href="http://example.org">Обычная ссылка</a><img src="http://example.org/photo.jpg"><script src="http://example.org/widget.js"></script></html>';
  const issue=diagnosePage(html,'https://example.test/').issues.find(i=>i.issueId.startsWith('mixed-content:'));
  assert.match(issue.evidence,/photo.jpg/);assert.match(issue.evidence,/widget.js/);
  assert.equal(diagnosePage('<a href="http://example.org">Ссылка</a>','https://example.test/').issues.some(i=>i.issueId.startsWith('mixed-content:')),false);
});

test('legacy support migration keeps consecutive conversations inside their request boundaries',async t=>{
  const f=await careFixture();t.after(()=>f.runtime.dispose());const user=f.users.client.user_id;
  await f.db.prepare("INSERT INTO platform_conversations(conversation_id,account_id,site_id,user_id,created_at,updated_at) VALUES('conv_old','acc_demo','demo-site',?,'2026-01-01T00:00:00Z','2026-01-01T00:12:00Z')").bind(user).run();
  for(const [id,type,content,at] of [
    ['msg_trigger_1','client','Первый вопрос','2026-01-01T00:00:00Z'],
    ['msg_answer_1','support','Первый ответ','2026-01-01T00:02:00Z'],
    ['msg_trigger_2','client','Второй вопрос','2026-01-01T00:09:00Z'],
    ['msg_answer_2','support','Второй ответ','2026-01-01T00:11:00Z']
  ])await f.db.prepare("INSERT INTO platform_conversation_messages(message_id,conversation_id,author_type,author_user_id,content,metadata_json,created_at) VALUES(?,'conv_old',?,?,?,'{}',?)").bind(id,type,type==='client'?user:null,content,at).run();
  await f.db.prepare("INSERT INTO platform_support_requests(request_id,conversation_id,account_id,site_id,requested_by,status,summary,created_at,updated_at,resolved_at) VALUES('sup_first','conv_old','acc_demo','demo-site',?,'resolved','Первое','2026-01-01T00:01:00Z','2026-01-01T00:05:00Z','2026-01-01T00:05:00Z')").bind(user).run();
  await f.db.prepare("INSERT INTO platform_support_requests(request_id,conversation_id,account_id,site_id,requested_by,status,summary,created_at,updated_at) VALUES('sup_second','conv_old','acc_demo','demo-site',?,'active','Второе','2026-01-01T00:10:00Z','2026-01-01T00:12:00Z')").bind(user).run();
  const sql=await readFile(new URL('../gateway/migrations/0029_care_requests.sql',import.meta.url),'utf8');
  for(const chunk of sql.split(/;\s*(?:\n|$)/u)){
    const start=chunk.indexOf('INSERT INTO platform_care');if(start<0)continue;
    await f.db.prepare(chunk.slice(start).trim()).run();
  }
  const first=await f.db.prepare("SELECT content FROM platform_care_messages WHERE request_id='sup_first' ORDER BY created_at").all();
  const second=await f.db.prepare("SELECT content FROM platform_care_messages WHERE request_id='sup_second' ORDER BY created_at").all();
  assert.deepEqual(first.results.map(r=>r.content),['Первый вопрос','Первый ответ']);
  assert.deepEqual(second.results.map(r=>r.content),['Второй вопрос','Второй ответ']);
});
