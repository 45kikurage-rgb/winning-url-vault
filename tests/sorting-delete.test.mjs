import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import vm from 'node:vm';
import worker from '../src/index.js';
import {sortingDeletePreview,deleteSortingItems} from '../src/sorting-delete.js';

function setup(t) {
  const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>sql.close());
  const DB={prepare(query){const s=sql.prepare(query);let args=[];return {bind(...v){args=v;return this},async first(){return s.get(...args)||null},async all(){return {results:s.all(...args)}},async run(){return {meta:{changes:s.run(...args).changes}}},execute(){return {meta:{changes:s.run(...args).changes}}}}},async batch(statements){sql.exec('BEGIN');try{const result=statements.map(s=>s.execute());sql.exec('COMMIT');return result}catch(e){sql.exec('ROLLBACK');throw e}}};
  const env={DB,SESSION_SECRET:'sorting-test-secret',ACCESS_PASSWORD_SHA256:'configured'};
  const product=crypto.randomUUID(),card=crypto.randomUUID(),otherCard=crypto.randomUUID();
  sql.prepare("INSERT INTO product_master(id,raw_name,normalized_name,display_name,redeem_place,specification,match_key) VALUES (?,'茶','茶','茶','店舗','350ml',?)").run(product,product);
  for(const id of [card,otherCard])sql.prepare("INSERT INTO cards(id,product_id,expires_on) VALUES (?,?,?)").run(id,product,id===card?'2026-11-30':'2026-12-01');
  sql.prepare("INSERT INTO vault_campaigns(campaign_id,campaign_name,lottery_start_date,status,last_refreshed_at) VALUES ('campaign','CP','2026-11-01','active','now')").run();
  sql.prepare("INSERT INTO ledger_products(product_id,campaign_id,card_id,product_name,identity_key,assigned_at) VALUES ('assigned','campaign',?,'茶','tea','now')").run(card);
  function add({source='arunomatic',status='active',cardId=card,assigned=false,video=false}={}) {
    const id=crypto.randomUUID(),value='https://example.test/'+id;
    sql.prepare('INSERT INTO items(id,value,canonical_value,value_type,status,intake_source,card_id,analysis_json) VALUES (?,?,?,?,?,?,?,?)').run(id,value,value,'url',status,source,cardId,'{"status":"ok"}');
    if(assigned)sql.prepare("INSERT INTO item_campaign_assignments(item_id,campaign_id,product_id,assigned_at) VALUES (?,'campaign','assigned','now')").run(id);
    if(video)sql.prepare('INSERT INTO tiktok_video_links(item_id) VALUES (?)').run(id);
    return id;
  }
  async function call(method='GET',body,{auth=true,origin='https://vault.test',source='arunomatic'}={}) {
    const expiry=String(Math.floor(Date.now()/1000)+3600),sig=createHmac('sha256',env.SESSION_SECRET).update(expiry).digest('base64url');
    const request=new Request(`https://vault.test/api/cards/${card}/delete-unassigned?intake_source=${source}`,{method,headers:{'content-type':'application/json',origin,...(auth?{cookie:`wuv_session=${expiry}.${sig}`}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const response=await worker.fetch(request,env,{});return {response,data:await response.json()};
  }
  return {sql,env,card,otherCard,add,call};
}

test('only previewed active, unassigned items in the selected card/source are removed; identity and audit survive',async t=>{
  const {sql,env,card,otherCard,add}=setup(t);
  const first=add(),second=add(),assigned=add({assigned:true}),other=add({cardId:otherCard}),chiri=add({source:'chiritumo'}),used=add({status:'used'}),video=add({video:true});
  const originals=new Map(sql.prepare('SELECT * FROM items').all().map(r=>[r.id,r]));
  const preview=await sortingDeletePreview(env,card,'arunomatic');assert.deepEqual(new Set(preview.ids),new Set([first,second]));
  const later=add();
  const result=await deleteSortingItems(env,card,'arunomatic',[...preview.ids,assigned,other,chiri,used,video]);assert.deepEqual(result,{ok:true,deleted:2,skipped:5});
  for(const id of [assigned,other,chiri,used,video])assert.deepEqual(sql.prepare('SELECT * FROM items WHERE id=?').get(id),originals.get(id));
  for(const id of [first,second]){const row=sql.prepare('SELECT * FROM items WHERE id=?').get(id);assert.equal(row.status,'sorting_deleted');for(const key of ['id','value','canonical_value','card_id','analysis_json','received_at'])assert.equal(row[key],originals.get(id)[key]);}
  assert.equal(sql.prepare('SELECT status FROM items WHERE id=?').get(later).status,'active');
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='sorting_deleted'").get().n,2);
  assert.equal((await deleteSortingItems(env,card,'arunomatic',preview.ids)).deleted,0);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='sorting_deleted'").get().n,2);
  assert.throws(()=>sql.prepare('INSERT INTO items(id,value,canonical_value,value_type) SELECT ?,value,canonical_value,value_type FROM items WHERE id=?').run(crypto.randomUUID(),first),/UNIQUE/);
});

test('assignment between preview and confirmation is protected; multi-chunk deletion is atomic',async t=>{
  const {sql,env,card,add}=setup(t);const id=add(),preview=await sortingDeletePreview(env,card,'arunomatic');
  sql.prepare("INSERT INTO item_campaign_assignments(item_id,campaign_id,product_id,assigned_at) VALUES (?,'campaign','assigned','now')").run(id);
  assert.equal((await deleteSortingItems(env,card,'arunomatic',preview.ids)).deleted,0);
  const ids=Array.from({length:85},()=>add());
  sql.exec(`CREATE TRIGGER block_delete BEFORE UPDATE OF status ON items WHEN old.id='${ids[84]}' BEGIN SELECT RAISE(ABORT,'blocked'); END`);
  await assert.rejects(deleteSortingItems(env,card,'arunomatic',ids),/blocked/);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM items WHERE status='sorting_deleted'").get().n,0);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM audit_log').get().n,0);
  sql.exec('DROP TRIGGER block_delete');assert.equal((await deleteSortingItems(env,card,'arunomatic',ids)).deleted,85);
});

test('authenticated same-origin explicit confirmation is required; source is enforced',async t=>{
  const {sql,call,add}=setup(t);const id=add(),body={ids:[id],confirmation:'未仕分けを削除'};
  assert.equal((await call('GET',undefined,{auth:false})).response.status,401);
  assert.equal((await call('POST',body,{origin:'https://evil.test'})).response.status,403);
  assert.equal((await call('POST',{ids:[id]})).response.status,400);
  for(const ids of [null,[],['bad'],[null],Array(5001).fill(id)])assert.equal((await call('POST',{...body,ids})).response.status,400);
  assert.equal((await call('GET',undefined,{source:'bad'})).response.status,400);
  const preview=await call();assert.equal(preview.response.status,200);assert.deepEqual(preview.data.ids,[id]);
  assert.equal((await call('POST',body,{source:'chiritumo'})).data.deleted,0);
  assert.equal((await call('POST',body)).data.deleted,1);
  assert.equal((await call()).data.count,0);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM items').get().n,1);
});

test('cancel makes no deletion call, explicit source survives tab switch, and duplicate clicks are ignored',async()=>{
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('const sortingDeletes = new Set();'),source.indexOf('function bindDynamic()'));
  const calls=[],button={dataset:{deleteSorting:'card'},disabled:false};let confirmResult=false;
  const currentButton={dataset:{deleteSorting:'card'},disabled:true};
  const context={document:{querySelectorAll:()=>[currentButton]},state:{sortingSource:'arunomatic',cards:new Map([['card',{display_name:'茶'}]])},displayLabel:(s,id,f)=>f,confirm:()=>confirmResult,alert(){},load:async()=>{},api:async(path,options)=>{calls.push({path,options});return options?{deleted:1,skipped:0}:{count:1,ids:['id']}}};
  vm.createContext(context);vm.runInContext(code,context);
  await context.deleteSortingCard(button);assert.equal(calls.length,1);assert.equal(calls[0].options,undefined);assert.equal(button.disabled,false);
  calls.length=0;confirmResult=true;context.api=async(path,options)=>{calls.push({path,options});if(!options){await Promise.resolve();return {count:1,ids:['id']}}return {deleted:1,skipped:0}};
  await Promise.all([context.deleteSortingCard(button),context.deleteSortingCard(button)]);assert.equal(currentButton.disabled,false);assert.equal(calls.length,2);assert.match(calls[1].path,/intake_source=arunomatic$/);assert.equal(JSON.parse(calls[1].options.body).confirmation,'未仕分けを削除');
  calls.length=0;context.api=async(path,options)=>{calls.push({path,options});context.state.sortingSource='chiritumo';return {count:1,ids:['id']}};
  await context.deleteSortingCard(button);assert.equal(calls.length,1);
});
