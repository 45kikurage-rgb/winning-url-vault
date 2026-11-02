import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {processOutbox,processRevenueOutbox,retryOutbox,ensureCampaignTotals} from '../src/ledger.js';

function database(t) {
  const sql=new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  t.after(()=>sql.close());
  return {sql,failSentUpdate:false,prepare(query){
    const statement=sql.prepare(query);let args=[];const owner=this;
    return {
      bind(...values){args=values;return this;},
      async first(){return statement.get(...args)||null;},
      async all(){return {results:statement.all(...args)};},
      async run(){
        if(owner.failSentUpdate&&query.includes("SET status='sent'")){
          owner.failSentUpdate=false;
          const error=new TypeError('Injected local implementation failure');
          error.status=503;throw error;
        }
        const result=statement.run(...args);return {meta:{changes:result.changes}};
      }
    };
  }};
}

function add(DB,id='one',source='product:one',revision=1) {
  DB.sql.prepare(`INSERT INTO ledger_outbox
    (id,source_record_id,source_revision,path,payload_json,status,created_at,updated_at)
    VALUES (?,?,?,'/api/v1/products/sync',?,'pending','2026-11-01','2026-11-01')`)
    .run(id,source,revision,JSON.stringify({source_record_id:source,source_revision:revision,data:{product_id:source}}));
}
const row=(DB,id='one')=>DB.sql.prepare('SELECT * FROM ledger_outbox WHERE id=?').get(id);
const success=(result='applied')=>Response.json({ok:true,result});
const failure=(status,code)=>Response.json({ok:false,error:{code}},{status});

function addRevenue(DB) {
  DB.sql.prepare(`INSERT INTO vault_campaigns
    (campaign_id,campaign_name,lottery_start_date,status,last_refreshed_at)
    VALUES ('campaign','単発試験','2026-11-01','active','2026-11-01')`).run();
  DB.sql.prepare(`INSERT INTO product_master
    (id,raw_name,normalized_name,display_name,redeem_place,match_key)
    VALUES ('master','商品','商品','商品','店舗','商品')`).run();
  DB.sql.prepare("INSERT INTO cards(id,product_id) VALUES ('card','master')").run();
  DB.sql.prepare(`INSERT INTO ledger_products
    (product_id,campaign_id,card_id,product_name,identity_key,assigned_at)
    VALUES ('product','campaign','card','商品','product','2026-11-01')`).run();
  DB.sql.prepare(`INSERT INTO product_monthly_revenue
    (month,campaign_id,product_id,winner_count,unit_price,amount,source_revision,sync_status,updated_at)
    VALUES ('2026-11','campaign','product',3,100,300,1,'pending','2026-11-01')`).run();
}

test('permanent 409 stops automatic and ID-specific resend, preserves revisions, and permits unrelated sources',async t=>{
  const DB=database(t);add(DB);add(DB,'later','product:one',2);add(DB,'other','product:other');
  const payloadBefore=row(DB).payload_json;let attempts=0;
  const env={DB,LEDGER_VAULT:{async fetch(request){
    attempts++;const payload=await request.json();
    return payload.source_record_id==='product:one'?failure(409,'REVISION_CONFLICT'):success();
  }}};
  const first=await processOutbox(env);
  assert.equal(first.attempted,2);assert.equal(first.results.find(x=>x.id==='one').retryable,false);
  assert.equal(row(DB).status,'failed');assert.equal(row(DB).attempts,1);assert.equal(row(DB).next_attempt_at,null);
  assert.equal(row(DB).payload_json,payloadBefore);
  assert.equal(row(DB,'later').status,'pending');assert.equal(row(DB,'later').attempts,0);
  assert.equal(row(DB,'other').status,'sent');
  assert.equal((await processOutbox(env)).attempted,0);
  assert.equal((await processOutbox(env,{id:'one'})).attempted,0);
  assert.equal(attempts,2);assert.equal(row(DB).attempts,1);
});

test('fetch rejection is retryable after backoff and retains the identical payload',async t=>{
  const DB=database(t);add(DB);const original=row(DB).payload_json;let fail=true,calls=0;
  const env={DB,LEDGER_VAULT:{async fetch(request){calls++;assert.equal(await request.text(),original);if(fail)throw new TypeError('fetch failed');return success('duplicate');}}};
  const first=await processOutbox(env),failed=row(DB);
  assert.equal(first.results[0].retryable,true);assert.match(failed.last_error,/LEDGER_TRANSPORT_ERROR/);
  const remaining=new Date(failed.next_attempt_at).getTime()-Date.now();assert.ok(remaining>55000&&remaining<=60000);
  assert.equal((await processOutbox(env)).attempted,0);assert.equal((await processOutbox(env,{id:'one'})).attempted,0);
  DB.sql.prepare('UPDATE ledger_outbox SET next_attempt_at=? WHERE id=?').run('2020-01-01','one');fail=false;
  const recovered=await processOutbox(env);assert.equal(recovered.results[0].result,'duplicate');
  assert.equal(calls,2);assert.equal(row(DB).status,'sent');assert.equal(row(DB).attempts,2);assert.equal(row(DB).payload_json,original);
});

test('a timed-out Service Binding is aborted, bounded, and retryable',async t=>{
  const DB=database(t);add(DB);let started,aborted=false;
  const entered=new Promise(resolve=>{started=resolve;});
  t.mock.timers.enable({apis:['setTimeout']});
  const delivery=processOutbox({DB,LEDGER_VAULT:{fetch(request){
    request.signal.addEventListener('abort',()=>{aborted=true;});started();return new Promise(()=>{});
  }}});
  await entered;t.mock.timers.tick(10000);
  const result=await delivery;
  assert.equal(aborted,true);assert.equal(result.results[0].retryable,true);
  assert.match(row(DB).last_error,/LEDGER_TIMEOUT/);assert.equal(row(DB).status,'failed');
});

test('5xx and dependency/concurrency failures retry, while an unrelated 409 stays blocked',async t=>{
  for(const [status,code,expected] of [[503,'STORAGE_UNAVAILABLE',true],[409,'DEPENDENCY_NOT_READY',true],[409,'CONCURRENT_MODIFICATION',true],[409,'OTHER_CONFLICT',false]]){
    const DB=database(t);add(DB);
    const result=await processOutbox({DB,LEDGER_VAULT:{async fetch(){return failure(status,code);}}});
    assert.equal(result.results[0].retryable,expected,code);
    assert.equal(Boolean(row(DB).next_attempt_at),expected,code);
  }
});

test('bad JSON and local TypeError are not mistaken for a network failure or marked sent',async t=>{
  for(const mode of ['saved-json','response-json','local-typeerror']){
    const DB=database(t);add(DB);let fetched=0;
    if(mode==='saved-json'){
      DB.sql.exec('PRAGMA ignore_check_constraints=ON');
      DB.sql.prepare('UPDATE ledger_outbox SET payload_json=?').run('{broken');
      DB.sql.exec('PRAGMA ignore_check_constraints=OFF');
    }
    if(mode==='local-typeerror')DB.failSentUpdate=true;
    const result=await processOutbox({DB,LEDGER_VAULT:{async fetch(){fetched++;return mode==='response-json'?new Response('{broken',{status:200}):success();}}});
    assert.equal(result.results[0].retryable,false,mode);assert.equal(row(DB).status,'failed');
    assert.equal(row(DB).next_attempt_at,null);assert.doesNotMatch(row(DB).last_error,/LEDGER_TRANSPORT_ERROR/);
    assert.equal((await processOutbox({DB})).attempted,0);
    assert.equal(fetched,mode==='saved-json'?0:1);
  }
});

test('a non-JSON HTTP 503 is a retryable server failure',async t=>{
  const DB=database(t);add(DB);
  const result=await processOutbox({DB,LEDGER_VAULT:{async fetch(){return new Response('Unavailable',{status:503});}}});
  assert.equal(result.results[0].retryable,true);assert.match(row(DB).last_error,/LEDGER_HTTP_503/);
});

test('explicit administrator retry reattempts a permanent failure and unblocks the next revision',async t=>{
  const DB=database(t);add(DB);add(DB,'later','product:one',2);let fail=true;
  const env={DB,LEDGER_VAULT:{async fetch(){return fail?failure(409,'REVISION_CONFLICT'):success();}}};
  await processOutbox(env);fail=false;
  assert.equal((await processOutbox(env)).attempted,0);
  const retried=await retryOutbox(env);
  assert.equal(retried.attempted,2);assert.ok(retried.results.every(x=>x.ok));
  assert.equal(row(DB).status,'sent');assert.equal(row(DB,'later').status,'sent');
});

test('duplicate and stale remain successful deliveries without changing the source payload',async t=>{
  for(const result of ['duplicate','stale']){
    const DB=database(t);add(DB);const payload=row(DB).payload_json;
    const delivered=await processOutbox({DB,LEDGER_VAULT:{async fetch(){return success(result);}}});
    assert.equal(delivered.results[0].result,result);assert.equal(row(DB).status,'sent');
    assert.equal(row(DB).payload_json,payload);
  }
});

test('revenue delivery uses the same transport/permanent distinction and preserves amounts',async t=>{
  const DB=database(t);addRevenue(DB);let mode='network',calls=0;
  const env={DB,LEDGER_VAULT:{async fetch(){calls++;if(mode==='network')throw new TypeError('fetch failed');if(mode==='conflict')return failure(409,'REVISION_CONFLICT');return success();}}};
  let result=await processRevenueOutbox(env);assert.equal(result.results[0].retryable,true);
  assert.equal((await processRevenueOutbox(env)).attempted,0);
  DB.sql.prepare('UPDATE product_monthly_revenue SET next_attempt_at=?').run('2020-01-01');mode='conflict';
  result=await processRevenueOutbox(env);assert.equal(result.results[0].retryable,false);
  assert.equal((await processRevenueOutbox(env)).attempted,0);assert.equal(calls,2);
  const revenue=DB.sql.prepare('SELECT * FROM product_monthly_revenue').get();
  assert.equal(revenue.amount,300);assert.equal(revenue.winner_count,3);assert.equal(revenue.source_revision,1);
  assert.equal(revenue.next_attempt_at,null);assert.equal(revenue.sync_status,'failed');
});

test('campaign totals errors describe retryable and permanent outcomes truthfully',async t=>{
  for(const retryable of [false,true]){
    const DB=database(t);
    DB.sql.prepare(`INSERT INTO vault_campaigns
      (campaign_id,campaign_name,lottery_start_date,status,last_refreshed_at)
      VALUES ('campaign','単発試験','2026-11-01','active','2026-11-01')`).run();
    add(DB,'one','totals:campaign');
    const env={DB,LEDGER_VAULT:{async fetch(){return retryable?failure(503,'UNAVAILABLE'):failure(409,'REVISION_CONFLICT');}}};
    await assert.rejects(ensureCampaignTotals(env,'campaign'),error=>{
      assert.equal(error.code,'TOTALS_SYNC_PENDING');assert.equal(error.status,503);
      assert.equal(error.details.delivery.retryable,retryable);
      assert.match(error.message,retryable?/自動再送します/:/自動再送しません/);return true;
    });
  }
});
