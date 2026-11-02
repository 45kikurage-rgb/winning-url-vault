import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHmac,createHash} from 'node:crypto';
import worker from '../src/index.js';
import {singleWinPreview,registerSingleWin,singleWinStatus,singleWinAvailability} from '../src/single-wins.js';

function setup(t) {
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const DB={prepare(query){const s=sql.prepare(query);let args=[];return {bind(...values){args=values;return this},async first(){return s.get(...args)||null},async all(){return{results:s.all(...args)}},async run(){return{meta:{changes:s.run(...args).changes}}},execute(){return{meta:{changes:s.run(...args).changes}}}}},async batch(statements){sql.exec('BEGIN');try{const out=statements.map(s=>s.execute());sql.exec('COMMIT');return out}catch(error){sql.exec('ROLLBACK');throw error}}};
  const master=crypto.randomUUID(),card=crypto.randomUUID(),chiri=crypto.randomUUID(),other=crypto.randomUUID();
  sql.prepare("INSERT INTO product_master(id,raw_name,normalized_name,display_name,redeem_place,specification,match_key) VALUES (?,'セブンのお茶 600ml','お茶','お茶','セブンイレブン','600ml',?)").run(master,master);
  for(const [id,source,expiry] of [[card,'arunomatic','2026-11-30'],[chiri,'chiritumo','2026-11-30'],[other,'arunomatic','2026-12-31']])
    sql.prepare('INSERT INTO cards(id,product_id,expires_on,intake_source) VALUES (?,?,?,?)').run(id,master,expiry,source);
  let failAfterRemote=false,beforeRemoteReturn=null,remoteCalls=0;
  const campaigns=new Map();
  const env={DB,ALIGN_SINGLE_WIN:{async availability(){return{ok:true,contract:'vault-single-win-v1',ready:true}},async createSingleWin(body){
    remoteCalls++;
    const prior=campaigns.get(body.request_id);
    if(prior && prior.input!==JSON.stringify(body))return{ok:false,error:{code:'SINGLE_WIN_REQUEST_CONFLICT'}};
    if(!prior)campaigns.set(body.request_id,{input:JSON.stringify(body),campaign:{campaign_id:crypto.randomUUID(),campaign_name:'単発 '+body.product_label+' '+body.registration_date,
      lottery_start_date:body.registration_date,status:'active',is_archived:false,layout_enabled:false}});
    if(beforeRemoteReturn)await beforeRemoteReturn(body,campaigns.get(body.request_id).campaign);
    if(failAfterRemote){failAfterRemote=false;throw new Error('response lost after durable campaign creation');}
    return{ok:true,stored:true,request_id:body.request_id,campaign:campaigns.get(body.request_id).campaign};
  }}};
  const add=({cardId=card,source='arunomatic',status='active',date='2026-11-01 15:05:00',video=false}={})=>{
    const id=crypto.randomUUID(),value='https://example.test/'+id;
    sql.prepare('INSERT INTO items(id,value,canonical_value,value_type,status,intake_source,card_id,received_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id,value,value,'url',status,source,cardId,date);
    if(video)sql.prepare('INSERT INTO tiktok_video_links(item_id) VALUES (?)').run(id);
    return id;
  };
  const prepare=async(cardId=card,source='arunomatic')=>{
    const preview=await singleWinPreview(env,cardId,source);
    return{request_id:crypto.randomUUID(),ids:preview.ids,preview_token:preview.preview_token,confirmation:'単発当選として登録'};
  };
  return{sql,env,master,card,chiri,other,add,prepare,campaigns,remoteCalls:()=>remoteCalls,setRemoteHook:fn=>{beforeRemoteReturn=fn},loseNextRemoteResponse:()=>{failAfterRemote=true}};
}

test('preview isolates active unassigned items by card and source and provides a stable snapshot',async t=>{
  const{sql,env,card,chiri,other,add}=setup(t),a=add(),b=add();
  add({cardId:chiri,source:'chiritumo'});add({cardId:other});add({status:'used'});add({status:'sorting_deleted'});add({video:true});
  const p=await singleWinPreview(env,card,'arunomatic');
  assert.deepEqual(new Set(p.ids),new Set([a,b]));assert.equal(p.count,2);assert.equal(p.registration_date,'2026-11-02');
  assert.equal(p.product_name,'セブンのお茶 600ml');assert.equal(p.product_spec,'600ml');assert.match(p.preview_token,/^[a-f0-9]{64}$/);
  assert.equal((await singleWinPreview(env,card,'arunomatic')).preview_token,p.preview_token);
  await assert.rejects(singleWinPreview(env,card,'chiritumo'),e=>e.code==='CARD_NOT_FOUND');
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM vault_single_wins').get().n,0);
});

test('snapshot assignment leaves later arrivals and originals intact; winner/revenue outbox use actual count',async t=>{
  const{sql,env,card,add,prepare,campaigns}=setup(t),first=add(),second=add(),body=await prepare();
  const originals=sql.prepare('SELECT * FROM items ORDER BY id').all(),later=add();
  const result=await registerSingleWin(env,card,'arunomatic',body);
  assert.equal(result.state,'completed');assert.equal(result.assigned_count,2);assert.equal(campaigns.size,1);
  assert.deepEqual(sql.prepare('SELECT * FROM items WHERE id IN (?,?) ORDER BY id').all(first,second),originals);
  assert.deepEqual(new Set(sql.prepare('SELECT item_id FROM item_campaign_assignments').all().map(r=>r.item_id)),new Set([first,second]));
  assert.equal(sql.prepare('SELECT item_id FROM item_campaign_assignments WHERE item_id=?').get(later),undefined);
  assert.equal((await singleWinPreview(env,card,'arunomatic')).count,1);
  const boxes=sql.prepare('SELECT * FROM ledger_outbox ORDER BY path').all();assert.equal(boxes.length,2);
  for(const row of boxes){const payload=JSON.parse(row.payload_json);assert.equal(payload.data.current_winner_count,2);assert.equal(payload.data.campaign_id,result.campaign_id);assert.equal(payload.source_system,'winning-url-vault');assert.equal(payload.source_revision,1);assert.equal(row.status,'pending');assert.ok(!row.payload_json.includes('https://example.test'));}
  const revenue=sql.prepare('SELECT * FROM product_monthly_revenue').get();assert.equal(revenue.winner_count,2);assert.equal(revenue.unit_price,null);assert.equal(revenue.amount,null);assert.equal(revenue.sync_status,'unset');
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='single_win_registered'").get().n,1);
  assert.equal((await singleWinStatus(env,body.request_id)).product_id,result.product_id);
});

test('15 parallel duplicate submissions and different IDs for the same snapshot create one operation/product',async t=>{
  const{sql,env,card,add,prepare,campaigns}=setup(t);for(let i=0;i<5;i++)add();const body=await prepare();
  const results=await Promise.all(Array.from({length:15},(_,i)=>registerSingleWin(env,card,'arunomatic',{...body,request_id:i%2?body.request_id:crypto.randomUUID()})));
  assert.ok(results.every(r=>r.state==='completed'&&r.product_id===results[0].product_id&&r.request_id===results[0].request_id));
  assert.equal(campaigns.size,1);assert.equal(sql.prepare('SELECT COUNT(*) n FROM vault_single_wins').get().n,1);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM ledger_products').get().n,1);assert.equal(sql.prepare('SELECT COUNT(*) n FROM item_campaign_assignments').get().n,5);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM ledger_outbox').get().n,2);
  assert.equal(sql.prepare('SELECT MAX(current_revision) n FROM ledger_sync_series').get().n,1);
});

test('lost remote ACK keeps the same operation; retry and completed receipt do not duplicate counts',async t=>{
  const{sql,env,card,add,prepare,campaigns,loseNextRemoteResponse,remoteCalls}=setup(t);add();const body=await prepare();loseNextRemoteResponse();
  await assert.rejects(registerSingleWin(env,card,'arunomatic',body),e=>e.code==='SINGLE_WIN_REMOTE_UNAVAILABLE'&&e.status===503);
  assert.equal(campaigns.size,1);assert.equal((await singleWinStatus(env,body.request_id)).state,'pending');
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM item_campaign_assignments').get().n,0);
  const saved=await registerSingleWin(env,card,'arunomatic',body),calls=remoteCalls();
  assert.equal(saved.assigned_count,1);assert.deepEqual(await registerSingleWin(env,card,'arunomatic',body),saved);assert.equal(remoteCalls(),calls);
  assert.equal(campaigns.size,1);assert.equal(sql.prepare('SELECT COUNT(*) n FROM ledger_outbox').get().n,2);
});

test('transaction failure rolls back product, assignment, audit and outbox then retry completes once',async t=>{
  const{sql,env,card,add,prepare,campaigns}=setup(t);add();const body=await prepare();
  sql.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON ledger_outbox BEGIN SELECT RAISE(ABORT,'projection blocked'); END");
  await assert.rejects(registerSingleWin(env,card,'arunomatic',body),/projection blocked/);
  for(const table of ['ledger_products','item_campaign_assignments','ledger_outbox','ledger_sync_series','product_monthly_revenue'])assert.equal(sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  assert.equal((await singleWinStatus(env,body.request_id)).state,'pending');
  sql.exec('DROP TRIGGER fail_projection');const result=await registerSingleWin(env,card,'arunomatic',body);
  assert.equal(result.state,'completed');assert.equal(result.assigned_count,1);assert.equal(campaigns.size,1);
});

test('changed eligibility or product metadata during remote call fails atomically and preserves data',async t=>{
  for(const change of ['item','product'])await t.test(change,async t=>{
    const{sql,env,card,master,add,prepare,setRemoteHook}=setup(t),first=add(),second=add(),body=await prepare();
    setRemoteHook(async()=>{
      if(change==='item')sql.prepare("UPDATE items SET status='sorting_deleted' WHERE id=?").run(first);
      else sql.prepare("UPDATE product_master SET raw_name='修正された商品' WHERE id=?").run(master);
    });
    await assert.rejects(registerSingleWin(env,card,'arunomatic',body),e=>e.code==='SINGLE_WIN_PREVIEW_CHANGED');
    assert.equal(sql.prepare('SELECT COUNT(*) n FROM ledger_products').get().n,0);
    assert.equal(sql.prepare('SELECT COUNT(*) n FROM item_campaign_assignments').get().n,0);
    assert.equal(sql.prepare('SELECT status FROM items WHERE id=?').get(second).status,'active');
    assert.equal(sql.prepare('SELECT COUNT(*) n FROM ledger_outbox').get().n,0);
    assert.equal((await singleWinStatus(env,body.request_id)).state,'needs_review');
  });
});

test('stale preview requires confirmation again, and a changed product can make a new operation',async t=>{
  const{sql,env,card,master,add,prepare,loseNextRemoteResponse}=setup(t);add();const old=await prepare();loseNextRemoteResponse();
  await assert.rejects(registerSingleWin(env,card,'arunomatic',old));
  sql.prepare("UPDATE product_master SET display_name='修正茶' WHERE id=?").run(master);
  await assert.rejects(registerSingleWin(env,card,'arunomatic',old),e=>e.code==='SINGLE_WIN_PREVIEW_CHANGED');
  assert.equal((await singleWinStatus(env,old.request_id)).state,'needs_review');
  const fresh=await prepare(),result=await registerSingleWin(env,card,'arunomatic',fresh);
  assert.equal(result.state,'completed');assert.equal(sql.prepare('SELECT COUNT(*) n FROM item_campaign_assignments').get().n,1);
});

test('more than five is accepted; source/new batch remains separate and duplicates do not inflate count',async t=>{
  const{sql,env,card,chiri,add,prepare,campaigns}=setup(t);for(let i=0;i<137;i++)add();const first=await prepare();
  const result=await registerSingleWin(env,card,'arunomatic',first);assert.equal(result.assigned_count,137);
  add();const next=await registerSingleWin(env,card,'arunomatic',await prepare());assert.notEqual(next.campaign_id,result.campaign_id);
  add({cardId:chiri,source:'chiritumo'});const c=await registerSingleWin(env,chiri,'chiritumo',await prepare(chiri,'chiritumo'));
  assert.notEqual(c.campaign_id,next.campaign_id);assert.equal(c.assigned_count,1);assert.equal(campaigns.size,3);
  const original=sql.prepare('SELECT value,canonical_value FROM items LIMIT 1').get();
  assert.throws(()=>sql.prepare("INSERT INTO items(id,value,canonical_value,value_type,status) VALUES (?,?,?,'url','active')").run(crypto.randomUUID(),original.value,original.canonical_value),/UNIQUE/);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM item_campaign_assignments').get().n,139);
});

test('invalidating a stale receipt blocks its delayed in-flight response even if product text is restored',async t=>{
  const{sql,env,card,master,add,prepare,setRemoteHook,campaigns}=setup(t);add();const old=await prepare();
  let release,entered;const started=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve});
  setRemoteHook(async()=>{entered();await gate});
  const inFlight=registerSingleWin(env,card,'arunomatic',old);await started;
  sql.prepare("UPDATE product_master SET display_name='変更' WHERE id=?").run(master);
  await assert.rejects(registerSingleWin(env,card,'arunomatic',old),e=>e.code==='SINGLE_WIN_PREVIEW_CHANGED');
  assert.equal((await singleWinStatus(env,old.request_id)).state,'needs_review');
  sql.prepare("UPDATE product_master SET display_name='お茶' WHERE id=?").run(master);
  release();await assert.rejects(inFlight,e=>e.code==='SINGLE_WIN_PREVIEW_CHANGED');
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM item_campaign_assignments').get().n,0);
  setRemoteHook(null);const fresh=await prepare();assert.equal(fresh.preview_token,old.preview_token);
  const result=await registerSingleWin(env,card,'arunomatic',fresh);assert.equal(result.assigned_count,1);
  assert.equal(campaigns.size,2);assert.equal(sql.prepare('SELECT COUNT(*) n FROM ledger_products').get().n,1);
  await assert.rejects(registerSingleWin(env,card,'arunomatic',old),e=>e.code==='SINGLE_WIN_PREVIEW_CHANGED');
});

test('invalid/mismatched requests never overwrite a receipt and availability is read-only',async t=>{
  const{sql,env,card,add,prepare,remoteCalls}=setup(t);add();const body=await prepare();
  assert.deepEqual(await singleWinAvailability(env),{ok:true,contract:'vault-single-win-v1',ready:true});
  assert.equal(remoteCalls(),0);
  for(const patch of [{request_id:'bad'},{ids:[]},{ids:[body.ids[0],body.ids[0]]},{confirmation:'OK'},{preview_token:'bad'}])
    await assert.rejects(registerSingleWin(env,card,'arunomatic',{...body,...patch}),e=>e.code==='INVALID_SINGLE_WIN_REQUEST');
  assert.equal(remoteCalls(),0);const saved=await registerSingleWin(env,card,'arunomatic',body);
  await assert.rejects(registerSingleWin(env,card,'arunomatic',{...body,ids:[crypto.randomUUID()]}),e=>e.code==='SINGLE_WIN_REQUEST_CONFLICT');
  assert.deepEqual(await singleWinStatus(env,body.request_id),saved);
  await assert.rejects(singleWinStatus(env,crypto.randomUUID()),e=>e.code==='SINGLE_WIN_NOT_FOUND');
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM ledger_products').get().n,1);
});

test('remote capability or durable acknowledgement missing keeps local data without a product',async t=>{
  const{sql,env,card,add,prepare}=setup(t);add();const body=await prepare();
  env.ALIGN_SINGLE_WIN={async createSingleWin(){return{ok:true,stored:false}}};
  await assert.rejects(registerSingleWin(env,card,'arunomatic',body),e=>e.code==='SINGLE_WIN_REMOTE_UNAVAILABLE');
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM items').get().n,1);assert.equal(sql.prepare('SELECT COUNT(*) n FROM ledger_products').get().n,0);
  assert.equal((await singleWinStatus(env,body.request_id)).state,'pending');assert.equal((await singleWinAvailability(env)).ready,false);
});

test('HTTP entry requires existing admin session, same origin and explicit confirmation; send-only token is refused',async t=>{
  const{sql,env,card,add,prepare,remoteCalls}=setup(t);add();const body=await prepare();
  env.SESSION_SECRET='single-win-test-session';env.ACCESS_PASSWORD_SHA256='configured';
  const expiry=String(Math.floor(Date.now()/1000)+3600),signature=createHmac('sha256',env.SESSION_SECRET).update(expiry).digest('base64url');
  const cookie=`wuv_session=${expiry}.${signature}`;
  const call=async(path,method='GET',payload,extra={})=>{
    const response=await worker.fetch(new Request('https://vault.test'+path,{method,headers:{cookie,origin:'https://vault.test','content-type':'application/json',...extra},...(payload?{body:JSON.stringify(payload)}:{})}),env,{});
    return{status:response.status,data:await response.json()};
  };
  const path=`/api/cards/${card}/single-win?intake_source=arunomatic`;
  assert.equal((await call('/api/single-wins/availability','GET',null,{cookie:''})).status,401);
  assert.equal((await call(path,'POST',body,{cookie:''})).status,401);
  assert.equal((await call(path,'POST',body,{origin:'https://other.test'})).status,403);
  assert.equal((await call(path,'POST',{...body,confirmation:''})).status,400);
  const token='wuv_'+'A'.repeat(43),hash=createHash('sha256').update(token).digest('hex');
  sql.prepare("INSERT INTO sending_tokens(id,device_id,token_hash,created_at) VALUES ('test-token','01',?,'now')").run(hash);
  assert.equal((await call(path,'POST',body,{authorization:'Bearer '+token})).status,403);
  assert.equal(remoteCalls(),0);
  assert.equal((await call('/api/single-wins/availability')).data.ready,true);
  const preview=await call(`/api/cards/${card}/single-win-preview?intake_source=arunomatic`);assert.equal(preview.status,200);assert.equal(preview.data.count,1);
  const success=await call(path,'POST',body);assert.equal(success.status,200);assert.equal(success.data.state,'completed');
  const receipt=await call('/api/single-wins/'+success.data.request_id);assert.equal(receipt.status,200);assert.equal(receipt.data.assigned_count,1);
});
