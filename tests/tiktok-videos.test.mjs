import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { isTikTokLongVideo } from '../public/tiktok-video.js';
import { attentionReasons } from '../public/winning-view.js';
import { recoverTikTokVideos } from '../src/tiktok-videos.js';
import { issueSendingToken, digest } from '../src/sending-auth.js';

const samples = ['ZSgbn9NaF','ZSgbnCxDU','ZSgbnmLwv'].map(id=>'https://lite.tiktok.com/t/'+id+'/');
function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  t.after(()=>sqlite.close());
  return {sqlite,prepare(sql){const statement=sqlite.prepare(sql);let args=[];return {
    bind(...values){args=values;return this;},
    async first(){return statement.get(...args) || null;},
    async all(){return {results:statement.all(...args)};},
    async run(){return {meta:{changes:statement.run(...args).changes}};},
    exec(){return {meta:{changes:statement.run(...args).changes}};}
  };},async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(s=>s.exec());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
}
async function setup(t) {
  const DB=database(t),messages=[],analyzed=[];
  const env={DB,SESSION_SECRET:'fixture',ACCESS_PASSWORD_SHA256:await digest('fixture'),
    COUPON_ANALYZER:{async fetch(req){analyzed.push(await req.json());return Response.json({results:[]});}},
    ANALYSIS_QUEUE:{async send(body){messages.push(body);},async sendBatch(rows){messages.push(...rows.map(x=>x.body));}}};
  const login=await worker.fetch(new Request('https://vault.test/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'fixture'})}),env,{});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const token=(await issueSendingToken(env,{deviceId:'03'})).token;
  async function call(path,method='GET',body,headers={}) {
    const response=await worker.fetch(new Request('https://vault.test'+path,{method,headers:{cookie,origin:'https://vault.test','content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})}),env,{});
    return {status:response.status,...await response.json()};
  }
  async function drain() {
    while(messages.length){const body=messages.shift();await worker.queue({messages:[{body,ack(){},retry(){throw Error('queue retry');}}]},env,{});}
  }
  return {DB,env,analyzed,call,drain,token};
}

test('URL rule retains case/query and rejects other hosts, missing tokens, HTTP and credentials',()=>{
  for(const url of [...samples,samples[0]+'?x=AbC']) assert.equal(isTikTokLongVideo(url),true);
  for(const url of ['https://lite.tiktok.com/t/','http://lite.tiktok.com/t/AbC/','https://lite.tiktok.com.evil.test/t/AbC/','https://www.tiktok.com/t/AbC/','https://lite.tiktok.com/t/Ab-C/','https://user@lite.tiktok.com/t/AbC/','https://lite.tiktok.com:444/t/AbC/','https://lite.tiktok.com/t/AbC/extra']) assert.equal(isTikTokLongVideo(url),false,url);
});

test('sub-device receipt -> no external analysis -> winning card without unit price -> frozen copy, cancel, complete and undo',async t=>{
  const {DB,analyzed,call,drain,token}=await setup(t);
  const input={clientRequestId:crypto.randomUUID(),text:samples.join('\n')};
  const received=await call('/api/receive','POST',input,{authorization:'Bearer '+token});
  assert.equal(received.status,202);assert.equal(received.stored,true);
  await drain();assert.equal(analyzed.length,0);
  const products=(await call('/api/winning-lists')).products;
  assert.equal(products.length,1);const card=products[0];
  assert.equal(card.product_name,'Tiktoklite長時間動画');assert.equal(card.unexported_count,3);
  assert.deepEqual((await call('/api/usage')).ids,[],'videos must not enter coupon usage rechecks');
  assert.equal(card.unit_price,null);assert.equal(card.price_required,false);assert.deepEqual(attentionReasons(card),[]);
  for(const table of ['ledger_products','product_monthly_revenue','ledger_outbox','item_campaign_assignments','product_master']) assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);
  assert.equal((await call('/api/receive','POST',input,{authorization:'Bearer '+token})).received,3);
  const first=await call('/api/tiktok-videos/export-batches','POST');assert.equal(first.batch.count,3);
  assert.deepEqual(first.batch.items.map(i=>i.value),samples);
  assert.equal((await call('/api/tiktok-videos/export-batches','POST')).batch.id,first.batch.id);
  await call('/api/receive','POST',{values:['https://lite.tiktok.com/t/LaterAbC/']});await drain();
  assert.equal((await call('/api/tiktok-videos/export-batches/pending')).batch.count,3,'later arrivals do not enter copied snapshot');
  await call('/api/tiktok-videos/export-batches/'+first.batch.id,'DELETE');
  assert.equal((await call('/api/winning-lists')).products[0].unexported_count,4,'failed/cancelled copy does not export');
  const next=(await call('/api/tiktok-videos/export-batches','POST')).batch;
  assert.equal((await call('/api/tiktok-videos/export-batches/'+next.id+'/complete','POST')).changed_count,4);
  assert.equal((await call('/api/winning-lists')).products[0].unexported_count,0);
  assert.equal((await call('/api/tiktok-videos/export-batches/'+next.id+'/complete','POST')).status,409);
  assert.equal((await call('/api/tiktok-videos/export-batches/'+next.id+'/undo','POST')).changed_count,4);
  assert.equal((await call('/api/winning-lists')).products[0].unexported_count,4);
  assert.equal((await call('/api/tiktok-videos/export-batches','POST',null,{origin:'https://evil.test'})).status,403);
  assert.equal((await call('/api/tiktok-videos/export-batches/pending','GET',null,{cookie:''})).status,401);
  assert.equal((await call('/api/tiktok-videos/export-batches/pending','GET',null,{authorization:'Bearer '+token})).status,403);
});

test('old unresolved links recover without changing values, dates, used/deleted/provisional records or normal URLs',async t=>{
  const {DB,env,call}=await setup(t);
  for(const [i,status] of ['unresolved','queued','used','provisional','provisional_deleted'].entries()){
    const value='https://lite.tiktok.com/t/Old'+i+'/';
    DB.sqlite.prepare('INSERT INTO items(id,value,canonical_value,value_type,status,received_at) VALUES (?,?,?,?,?,?)').run('old'+i,value,value,'url',status,'2026-10-01 10:00:00');
    if(status==='unresolved') DB.sqlite.prepare("INSERT INTO unresolved_items(item_id,reason,pattern_key) VALUES (?,'unknown','lite.tiktok.com')").run('old'+i);
  }
  DB.sqlite.prepare("INSERT INTO items(id,value,canonical_value,value_type,status) VALUES ('normal','https://example.test/win','https://example.test/win','url','unresolved')").run();
  assert.equal(await recoverTikTokVideos(env),2);assert.equal(await recoverTikTokVideos(env),0);
  assert.equal((await call('/api/winning-lists')).products[0].total_count,2);
  assert.equal(DB.sqlite.prepare("SELECT status FROM items WHERE id='old2'").get().status,'used');
  assert.equal(DB.sqlite.prepare("SELECT status FROM items WHERE id='old3'").get().status,'provisional');
  assert.equal(DB.sqlite.prepare("SELECT status FROM items WHERE id='old4'").get().status,'provisional_deleted');
  assert.equal(DB.sqlite.prepare("SELECT status FROM items WHERE id='normal'").get().status,'unresolved');
  assert.equal(DB.sqlite.prepare("SELECT received_at FROM items WHERE id='old0'").get().received_at,'2026-10-01 10:00:00');
});
