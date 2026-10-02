import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/index.js';
import {issueSendingToken,digest,limitSending} from '../src/sending-auth.js';
import {recoverIntakes} from '../src/intake.js';

// SQLite executes real SQL and transactions; fault injection models a failed D1 batch.
function database(t) {
  const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  t.after(()=>sql.close());
  const db={sql,batches:0,failAt:0,
    prepare(query){const statement=sql.prepare(query);let args=[];return {
      bind(...values){args=values;return this;},
      async first(){return statement.get(...args)||null;},
      async all(){return {results:statement.all(...args)};},
      async run(){const result=statement.run(...args);return {meta:{changes:result.changes}};},
      execute(){return statement.run(...args);}
    };},
    async batch(statements){this.batches++;sql.exec('BEGIN');try {
      const results=statements.map((s,index)=>{if(this.batches===this.failAt&&index===Math.min(1,statements.length-1))throw Error('Injected storage failure');return s.execute();});
      sql.exec('COMMIT');return results;
    }catch(error){sql.exec('ROLLBACK');throw error;}}
  };return db;
}
async function setup(t){
  const DB=database(t),messages=[];
  const env={DB,SESSION_SECRET:'test-secret',ACCESS_PASSWORD_SHA256:await digest('test-password'),
    ANALYSIS_QUEUE:{async send(body){messages.push(body);},async sendBatch(batch){messages.push(...batch.map(x=>x.body));}}};
  const issued=await issueSendingToken(env,{deviceId:'03'});
  const login=await worker.fetch(new Request('https://vault.test/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'test-password'})}),env,{});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  async function call(body,{token=issued.token,path='/api/receive',method='POST',headers={}}={}){
    const response=await worker.fetch(new Request('https://vault.test'+path,{method,
      headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...headers},
      ...(method==='GET'?{}:{body:JSON.stringify(body)})}),env,{});
    return {status:response.status,body:await response.json()};
  }
  return {env,DB,messages,issued,cookie,call};
}
const payload=(values=['https://example.test/win','未知の共有テキスト'])=>({values,clientRequestId:crypto.randomUUID()});
const count=(DB,table)=>DB.sql.prepare('SELECT COUNT(*) n FROM '+table).get().n;

test('durable acknowledgment, exact raw input, retry and conflicting payload',async t=>{
  const {DB,call}=await setup(t),input=payload(['  未知のコード\n説明文  ','https://example.test/win']);
  const first=await call(input);assert.equal(first.status,202);assert.equal(first.body.stored,true);assert.equal(first.body.job.status,'queued');
  assert.deepEqual(JSON.parse(DB.sql.prepare('SELECT raw_json FROM intake_receipts').get().raw_json),{values:input.values,text:''});
  const retry=await call(input);assert.equal(retry.status,200);assert.equal(retry.body.job.id,first.body.job.id);assert.equal(count(DB,'intake_receipts'),1);assert.equal(count(DB,'items'),3);
  const conflict=await call({...input,values:['different']});assert.equal(conflict.status,409);assert.equal(conflict.body.code,'REQUEST_ID_CONFLICT');assert.equal(count(DB,'items'),3);
});

test('failed materialization never acknowledges and same ID resumes all batches',async t=>{
  const {DB,call}=await setup(t),input=payload(Array.from({length:85},(_,i)=>'https://example.test/'+i));
  DB.failAt=DB.batches+3; // receipt + first chunk succeed; second chunk rolls back
  const failed=await call(input);assert.equal(failed.status,503);assert.equal(failed.body.stored,false);
  assert.equal(count(DB,'items'),40);assert.equal(count(DB,'analysis_job_items'),40);
  assert.equal(DB.sql.prepare('SELECT cursor FROM intake_receipts').get().cursor,40);
  const resumed=await call(input);assert.equal(resumed.status,200);assert.equal(resumed.body.stored,true);assert.equal(resumed.body.job.accepted,85);
  assert.equal(count(DB,'items'),85);assert.equal(count(DB,'analysis_job_items'),85);
});

test('failed receipt transaction leaves no job and cron recovers persisted intake',async t=>{
  const {env,DB,call,messages}=await setup(t),input=payload();DB.failAt=DB.batches+1;
  assert.equal((await call(input)).status,503);assert.equal(count(DB,'analysis_jobs'),0);assert.equal(count(DB,'intake_receipts'),0);
  DB.failAt=DB.batches+2;assert.equal((await call(input)).status,503);assert.equal(count(DB,'items'),0);assert.equal(count(DB,'intake_receipts'),1);
  await recoverIntakes(env,()=>{throw Error('Unexpected inline analysis');});
  assert.equal(count(DB,'items'),2);assert.equal(messages.length,1);
  assert.equal(DB.sql.prepare('SELECT status,dispatched FROM intake_receipts').get().dispatched,1);
  assert.equal((await call(input)).body.stored,true);
});

test('rotation preserves owner receipts; revoked token and privileged API access fail',async t=>{
  const {env,DB,call,issued,cookie}=await setup(t),input=payload();const first=await call(input);
  for(const [path,method] of [['/api/cards','GET'],['/api/trial/reset','POST'],['/api/sending-tokens','GET'],['/api/receive','GET']]){
    const denied=await call({}, {path,method,headers:{cookie}});assert.equal(denied.status,403);assert.equal(denied.body.code,'SCOPE_DENIED');
  }
  const rotated=await issueSendingToken(env,{deviceId:'03'});
  assert.equal((await call(input)).status,401);
  const retry=await call(input,{token:rotated.token});assert.equal(retry.status,200);assert.equal(retry.body.job.id,first.body.job.id);
  const other=await issueSendingToken(env,{deviceId:'04'});const independent=await call(input,{token:other.token});
  assert.equal(independent.status,202);assert.notEqual(independent.body.job.id,first.body.job.id);assert.equal(independent.body.job.accepted,0);assert.equal(independent.body.job.status,'completed');
  const listed=await call(null,{token:null,path:'/api/sending-tokens',method:'GET',headers:{cookie}});
  assert.equal(listed.status,200);assert.equal(JSON.stringify(listed).includes(issued.token),false);assert.equal(JSON.stringify(listed).includes('token_hash'),false);
  const forbidden=await call({deviceId:'05'},{token:null,path:'/api/sending-tokens',headers:{cookie,origin:'https://untrusted.test'}});assert.equal(forbidden.status,403);
  const created=await call({deviceId:'05'},{token:null,path:'/api/sending-tokens',headers:{cookie,origin:'https://vault.test'}});assert.equal(created.status,201);
  assert.equal((await call({}, {token:null,path:'/api/sending-tokens/'+created.body.id+'/revoke',headers:{cookie,origin:'https://vault.test'}})).status,200);
  assert.equal((await call(payload(),{token:created.body.token})).status,401);
  assert.equal(count(DB,'items'),2);
});

test('parallel retries converge and duplicate gaps still dispatch the later batch',async t=>{
  const {DB,call,messages}=await setup(t),input=payload(Array.from({length:40},(_,i)=>'https://example.test/'+i));
  const results=await Promise.all([call(input),call(input)]);assert.ok(results.every(r=>r.body.stored));assert.equal(results[0].body.job.id,results[1].body.job.id);assert.equal(count(DB,'items'),40);
  messages.length=0;const second=await call(payload([...input.values,'https://example.test/new']));
  assert.equal(second.body.job.accepted,1);assert.equal(second.body.job.existing,40);assert.equal(messages.length,1);assert.equal(messages[0].batchNo,1);
  const [a,b]=await Promise.all([call(payload(['https://example.test/shared'])),call(payload(['https://example.test/shared']))]);
  assert.equal(a.body.job.accepted+b.body.job.accepted,1);assert.equal(count(DB,'items'),42);
});

test('validation, request bounds and rate limit retain explicit failure codes',async t=>{
  const {env,DB,call}=await setup(t);
  for(const input of [{values:[]},payload([1]),{...payload(),clientRequestId:'bad'},payload(['   '])]){
    const result=await call(input);assert.equal(result.status,400);assert.equal(result.body.code,'INVALID_REQUEST');
  }
  const large=await call(payload(['x'.repeat(512*1024)]));assert.equal(large.status,413);assert.equal(large.body.code,'PAYLOAD_TOO_LARGE');assert.equal(count(DB,'items'),0);
  DB.sql.exec('DELETE FROM sending_rate_limits');for(let i=0;i<120;i++)await limitSending(env,'03');
  const limited=await call(payload());assert.equal(limited.status,429);assert.equal(limited.body.code,'RATE_LIMITED');
});

test('queue outage preserves saved input and cron retries dispatch',async t=>{
  const {env,DB,call}=await setup(t);env.ANALYSIS_QUEUE.sendBatch=async()=>{throw Error('Queue unavailable');};
  const accepted=await call(payload());assert.equal(accepted.status,202);assert.equal(accepted.body.stored,true);
  assert.equal(DB.sql.prepare('SELECT dispatched FROM intake_receipts').get().dispatched,0);
  const messages=[];env.ANALYSIS_QUEUE.sendBatch=async batch=>messages.push(...batch);
  await recoverIntakes(env,()=>{});assert.equal(messages.length,1);assert.equal(DB.sql.prepare('SELECT dispatched FROM intake_receipts').get().dispatched,1);
});
