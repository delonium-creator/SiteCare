import {Miniflare} from 'miniflare';
import {readFile,readdir} from 'node:fs/promises';
import {createPasswordRecord,newId} from '../../gateway/src/platform-core.js';
import gateway from '../../gateway/src/index.js';

export async function careFixture(onStep=()=>{}){
  const runtime=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",compatibilityDate:'2026-08-04',d1Databases:['GATEWAY_DB']});
  const db=await runtime.getD1Database('GATEWAY_DB');onStep('database ready');
  for(const name of (await readdir(new URL('../../gateway/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort()){
    onStep(name);const sql=await readFile(new URL('../../gateway/migrations/'+name,import.meta.url),'utf8');
    for(const statement of sql.split(/;\s*(?:\n|$)/u).map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  }
  const env={TELEGRAM_BOT_TOKEN:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi',TELEGRAM_WEBHOOK_SECRET:'preview_webhook_01234567890123456789',GATEWAY_DB:db,LEADS_DATA_KEY:'local-preview-encryption-key-never-production-123456789',GATEWAY_ADMIN_TOKEN:'local-preview-admin-never-production-123456789'};
  const now=new Date().toISOString();
  onStep('password');const record=await createPasswordRecord('Local fixture password 123');
  const users={};
  for(const [key,role,name] of [['client','user','Алексей'],['specialist','operator','Специалист SiteCare'],['outsider','user','Другой клиент']]){
    const id=newId('usr',key);users[key]={user_id:id,platform_role:role,email:key+'@example.test'};
    await db.prepare("INSERT INTO platform_users(user_id,email,display_name,password_salt,password_hash,password_iterations,platform_role,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'active',?,?)").bind(id,users[key].email,name,record.salt,record.hash,record.iterations,role,now,now).run();
  }
  await db.prepare("INSERT INTO platform_accounts(account_id,name,plan,status,created_at,updated_at) VALUES('acc_demo','Бюро Север','business','active',?,?)").bind(now,now).run();
  await db.prepare("INSERT INTO platform_memberships(account_id,user_id,role,created_at,updated_at) VALUES('acc_demo',?,'owner',?,?)").bind(users.client.user_id,now,now).run();
  await db.prepare("INSERT INTO platform_sites(site_id,account_id,name,target_url,target_origin,target_pathname,scope,status,integration_mode,form_required,loader_key,created_at,updated_at) VALUES('demo-site','acc_demo','Бюро Север','https://example.test/','https://example.test','/','site','active','central',1,'preview-loader-key-0123456789',?,?)").bind(now,now).run();
  await db.prepare("INSERT INTO platform_site_overrides(site_id,enabled,phone,schedule_text,button_text,button_url,version,updated_at) VALUES('demo-site',1,'+7 999 123-45-67','','','',1,?)").bind(now).run();
  for(const key of ['control','reviews'])await db.prepare("INSERT INTO platform_account_features(account_id,feature_key,status,updated_at) VALUES('acc_demo',?,'complimentary',?)").bind(key,now).run();
  const site=await db.prepare("SELECT * FROM platform_sites WHERE site_id='demo-site'").first();
  async function request(role,path,method='GET',body){
    if(!users[role].cookie){
      const r=await gateway.fetch(new Request('https://preview.test/v1/platform/auth/login',{method:'POST',headers:{Origin:'https://preview.test','Content-Type':'application/json'},body:JSON.stringify({email:users[role].email,password:'Local fixture password 123'})}),env);
      const d=await r.json();if(!r.ok)throw new Error(JSON.stringify(d));users[role].cookie=r.headers.get('set-cookie').split(';')[0];users[role].csrf=d.csrf;
    }
    return gateway.fetch(new Request('https://preview.test'+path,{method,headers:{Origin:'https://preview.test',Cookie:users[role].cookie,'X-SiteCare-CSRF':users[role].csrf,'Content-Type':'application/json'},...(['GET','HEAD'].includes(method)||body===undefined?{}:{body:JSON.stringify(body)})}),env);
  }
  onStep('ready');return {runtime,db,env,users,site,request};
}
