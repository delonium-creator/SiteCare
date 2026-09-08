// Isolated, disposable demo for browser QA. Never imported by either Worker.
import http from 'node:http';
import {careFixture} from '../test/helpers/care-fixture.js';
import {createCare,updateCare} from '../gateway/src/platform-care.js';
const f=await careFixture();
const now=new Date().toISOString();
await f.db.prepare("UPDATE platform_sites SET page_ok=1,tls_ok=1,domain_ok=1,last_http_status=200,last_monitor_at=?,loader_ok=1 WHERE site_id='demo-site'").bind(now).run();
const diagnostics={checkedAt:now,summary:{pages:4},issues:[
  {issueId:'title-missing:/projects',category:'seo',title:'У страницы проектов нет заголовка для поиска',page:'https://example.test/projects',evidence:'В опубликованном HTML страницы /projects отсутствует тег title.',recommendation:'Задать название страницы в SEO-настройках Tilda и перепубликовать страницу.',probableCause:'Название страницы не заполнено или изменения ещё не опубликованы.'},
  {issueId:'image-alt:/',category:'accessibility',title:'У фотографий проектов не указаны описания',page:'https://example.test/',evidence:'На главной странице 6 изображений с пустым alt. Декоративные это изображения или содержательные, нужно уточнить.',recommendation:'Проверить назначение изображений и добавить описания содержательным.',probableCause:'Описания не заполнены при загрузке фотографий.'},
  {issueId:'noindex:/projects/house',category:'seo',title:'Карточка дома закрыта от индексации',page:'https://example.test/projects/house',evidence:'В meta robots указан noindex.',recommendation:'Уточнить, должна ли эта карточка появляться в поиске.',probableCause:'После подготовки страницы мог остаться запрет индексации.'}
]};
await f.db.prepare("INSERT INTO platform_diagnostics_cache(site_id,diagnostics_json,checked_at) VALUES('demo-site',?,?)").bind(JSON.stringify(diagnostics),now).run();
await f.db.prepare("INSERT INTO platform_monitor_runs(site_id,checked_at,domain_ok,tls_ok,page_ok,form_ok,http_status,latency_ms,form_count,details) VALUES('demo-site',?,1,1,1,1,200,284,1,'Демонстрационный замер')").bind(new Date(Date.now()-60000).toISOString()).run();
const r=await createCare(f.env,f.site,f.users.client,{title:'Заменить номер телефона на всех страницах',content:'Новый номер офиса: +7 999 123-45-68. Пожалуйста, обновите его в шапке, подвале и мобильном меню.'});
await updateCare(f.env,f.site,f.users.specialist,r.request.request_id,{action:'quote',revision:1,amountMinor:120000,scope:'Заменю указанный номер в шапке, подвале и мобильном меню. Проверю текст, ссылки для звонка и все опубликованные страницы.',due:'1 рабочий день после оплаты'});
await createCare(f.env,f.site,f.users.client,{title:'Проверить заголовок страницы проектов',findingId:'title-missing:/projects',content:'Прошу проверить замечание и предложить исправление.'});
const args=process.argv.slice(2),port=Number(args[args.indexOf('--port')+1])||4173;
const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://terminal.local:'+port);
    if(u.pathname.startsWith('/__qa/')){const role=u.pathname.endsWith('/specialist')?'specialist':'client';res.writeHead(302,{'Set-Cookie':'preview_role='+role+'; Path=/; SameSite=Lax',Location:'/app#'+(role==='specialist'?'work':'overview')});res.end();return;}
    const role=String(req.headers.cookie||'').includes('preview_role=specialist')?'specialist':'client';
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;
    const response=await f.request(role,u.pathname+u.search,req.method,body);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(err){res.writeHead(500,{'Content-Type':'text/plain'});res.end(err.message);}
});
server.listen(port,'0.0.0.0',()=>console.log('Disposable SiteCare demo ready on '+port));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(async()=>{await f.runtime.dispose();process.exit(0);}));
