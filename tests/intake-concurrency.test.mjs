import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import worker from '../src/index.js';
import {digest,issueSendingToken} from '../src/sending-auth.js';
import {recoverIntakes} from '../src/intake.js';

// Real uniqueness constraints and transactional SQL, with a controllable Queue
// boundary. No production URLs, credentials, Queue or database are used.
function database(t) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  t.after(() => sql.close());
  return {
    sql,batches:0,failAt:0,
    prepare(query) {
      const statement=sql.prepare(query);let args=[];
      return {
        bind(...values){args=values;return this;},
        async first(){return statement.get(...args)||null;},
        async all(){return {results:statement.all(...args)};},
        async run(){const result=statement.run(...args);return {meta:{changes:result.changes}};},
        execute(){return statement.run(...args);}
      };
    },
    async batch(statements) {
      this.batches++;sql.exec('BEGIN');
      try {
        const results=statements.map((s,i) => {
          if(this.batches===this.failAt&&i===Math.min(1,statements.length-1))throw Error('Injected storage failure');
          return s.execute();
        });
        sql.exec('COMMIT');return results;
      } catch(error) {sql.exec('ROLLBACK');throw error;}
    }
  };
}

function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

async function beforeQueueCompletes(responsePromise) {
  let timeout;
  try {
    return await Promise.race([
      responsePromise,
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Durable ACK waited for the blocked Queue')),1500);})
    ]);
  } finally {clearTimeout(timeout);}
}

async function setup(t) {
  const DB=database(t),background=[],messages=[];
  const env={DB,SESSION_SECRET:'test-only-secret',ACCESS_PASSWORD_SHA256:await digest('test-only-password'),
    ANALYSIS_QUEUE:{
      async send(body){messages.push(body);},
      async sendBatch(batch){messages.push(...batch.map(x=>x.body));}
    }};
  const tokens=[];
  for(let n=1;n<=15;n++)tokens.push((await issueSendingToken(env,{deviceId:String(n).padStart(2,'0')})).token);
  const ctx={waitUntil(promise){background.push(promise);}};
  const login=await worker.fetch(new Request('https://vault.test/api/auth/login',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'test-only-password'})
  }),env,ctx);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  async function call(input,{token=tokens[0],path='/api/receive',admin=false,context=ctx}={}) {
    const response=await worker.fetch(new Request('https://vault.test'+path,{
      method:'POST',headers:{'content-type':'application/json',...(admin?{cookie}:token?{authorization:'Bearer '+token}:{})},
      body:JSON.stringify(input)
    }),env,context);
    return {status:response.status,body:await response.json()};
  }
  return {DB,env,ctx,tokens,cookie,background,messages,call};
}

const input=(values)=>({values,clientRequestId:crypto.randomUUID()});
const rows=(DB,table)=>DB.sql.prepare('SELECT * FROM '+table).all();

test('15 devices receive durable ACKs while analysis dispatch remains blocked',async t=>{
  const {DB,env,tokens,background,messages,call}=await setup(t),queue=deferred();
  const normal=env.ANALYSIS_QUEUE.sendBatch;
  let waiting=0;
  env.ANALYSIS_QUEUE.sendBatch=async batch=>{waiting++;await queue.promise;await normal(batch);};
  const started=performance.now();
  const requests=tokens.map((token,n)=>call(input([
    'https://example.test/shared',`https://example.test/device-${n}`,`https://example.test/device-${n}`
  ]),{token}));
  let accepted;
  try {
    accepted=await beforeQueueCompletes(Promise.all(requests));
    t.diagnostic(JSON.stringify({scenario:'15 devices / blocked queue',ackMs:Number((performance.now()-started).toFixed(2)),requests:15}));
    assert.equal(waiting,15);
    assert.equal(messages.length,0);
    assert.equal(background.length,15);
    assert.ok(accepted.every(x=>x.status===202&&x.body.stored===true));
    assert.ok(accepted.every(x=>x.body.received+x.body.duplicate===3&&x.body.job.inputTotal===3));
    assert.equal(accepted.reduce((n,x)=>n+x.body.received,0),16);
    assert.equal(accepted.reduce((n,x)=>n+x.body.duplicate,0),29);
    assert.equal(rows(DB,'items').length,16);
    assert.equal(rows(DB,'analysis_job_items').length,16);
    assert.ok(rows(DB,'intake_receipts').every(x=>x.status==='stored'&&x.dispatched===0));
    assert.ok(rows(DB,'analysis_jobs').every(x=>x.status!=='receiving'));
    assert.equal(DB.sql.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.deepEqual(DB.sql.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {
    queue.resolve();await Promise.all(background);await Promise.all(requests);
  }
  assert.equal(messages.length,15);
  assert.ok(rows(DB,'intake_receipts').every(x=>x.dispatched===1));
});

test('15 devices sending only the same URL create one item and report exact duplicates',async t=>{
  const {DB,tokens,background,call}=await setup(t);
  const request=input(['https://example.test/one']);
  const accepted=await Promise.all(tokens.map(token=>call(request,{token})));
  await Promise.all(background);
  assert.ok(accepted.every(x=>x.body.stored===true&&x.body.received+x.body.duplicate===1));
  assert.equal(accepted.reduce((n,x)=>n+x.body.received,0),1);
  assert.equal(accepted.reduce((n,x)=>n+x.body.duplicate,0),14);
  assert.equal(new Set(accepted.map(x=>x.body.job.id)).size,15);
  assert.equal(rows(DB,'items').length,1);
  assert.equal(rows(DB,'intake_receipts').length,15);
});

test('same device and request ID converge; changed content stays a conflict during pending dispatch',async t=>{
  const {DB,env,background,call}=await setup(t),queue=deferred();
  env.ANALYSIS_QUEUE.sendBatch=async()=>queue.promise;
  const request=input(['https://example.test/replay']);
  const calls=[call(request),call(request)];
  try {
    const [a,b]=await beforeQueueCompletes(Promise.all(calls));
    assert.equal(a.body.stored,true);assert.equal(b.body.stored,true);
    assert.equal(a.body.job.id,b.body.job.id);
    const conflict=await call({...request,values:['https://example.test/different']});
    assert.equal(conflict.status,409);assert.equal(conflict.body.stored,false);
    assert.equal(conflict.body.code,'REQUEST_ID_CONFLICT');
    assert.equal(rows(DB,'items').length,1);assert.equal(rows(DB,'intake_receipts').length,1);
  } finally {queue.resolve();await Promise.all(background);await Promise.all(calls);}
});

test('queue rejection after the ACK leaves a recoverable receipt without losing input',async t=>{
  const {DB,env,background,call,messages}=await setup(t),queue=deferred();
  const normal=env.ANALYSIS_QUEUE.sendBatch;
  env.ANALYSIS_QUEUE.sendBatch=async()=>queue.promise;
  const request=input(['  https://example.test/recover  ']);
  const attempt=call(request);
  let accepted;
  try {
    accepted=await beforeQueueCompletes(attempt);
    assert.equal(accepted.body.stored,true);assert.equal(accepted.body.received,1);
  } finally {queue.reject(Error('Injected queue outage'));await Promise.all(background);await attempt;}
  const receipt=rows(DB,'intake_receipts')[0];
  assert.equal(receipt.dispatched,0);assert.equal(receipt.status,'stored');
  assert.deepEqual(JSON.parse(receipt.raw_json),{values:request.values,text:''});
  env.ANALYSIS_QUEUE.sendBatch=normal;
  await recoverIntakes(env,()=>{throw Error('Queue runtime must not analyze inline');});
  assert.equal(messages.length,1);assert.equal(rows(DB,'intake_receipts')[0].dispatched,1);
  const replay=await call(request);await Promise.all(background);
  assert.equal(replay.body.job.id,accepted.body.job.id);assert.equal(replay.status,200);
  assert.equal(rows(DB,'items').length,1);
});

test('failed materialization cannot schedule analysis or claim success; replay completes all chunks',async t=>{
  const {DB,background,call,messages}=await setup(t);
  const request=input(Array.from({length:85},(_,n)=>`https://example.test/batch-${n}`));
  DB.failAt=DB.batches+3;
  const failed=await call(request);
  assert.equal(failed.status,503);assert.equal(failed.body.stored,false);
  assert.equal(background.length,0);assert.equal(messages.length,0);
  assert.equal(rows(DB,'items').length,40);
  assert.equal(rows(DB,'intake_receipts')[0].status,'receiving');
  const retried=await call(request);await Promise.all(background);
  assert.equal(retried.body.stored,true);assert.equal(retried.body.received,85);
  assert.equal(rows(DB,'items').length,85);assert.equal(messages.length,3);
});

test('admin and Chiritumo routes also ACK before Queue completion and retain their source',async t=>{
  const {DB,env,background,call}=await setup(t),queue=deferred();
  env.ANALYSIS_QUEUE.sendBatch=async()=>queue.promise;
  const requests=[
    call(input(['https://example.test/admin']),{admin:true}),
    call(input(['https://example.test/chiritumo']),{token:null,path:'/api/chiritumo/receive'})
  ];
  try {
    const accepted=await beforeQueueCompletes(Promise.all(requests));
    assert.ok(accepted.every(x=>x.body.stored===true));
    assert.equal(background.length,2);
    const items=rows(DB,'items');
    assert.equal(items.find(x=>x.value.endsWith('/admin')).intake_source,'arunomatic');
    assert.equal(items.find(x=>x.value.endsWith('/chiritumo')).intake_source,'chiritumo');
  } finally {queue.resolve();await Promise.all(background);await Promise.all(requests);}
});

test('provisional receipts stay durably held and never enter the analysis Queue',async t=>{
  const {DB,env,ctx,tokens,cookie,background,call}=await setup(t);
  const changed=await worker.fetch(new Request('https://vault.test/api/receive-mode',{
    method:'POST',headers:{cookie,origin:'https://vault.test','content-type':'application/json'},body:JSON.stringify({mode:'A'})
  }),env,ctx);
  assert.equal(changed.status,200);
  const request=input(['https://example.test/provisional']);
  const accepted=await call(request,{token:tokens[1]});
  const replay=await call(request,{token:tokens[1]});
  assert.equal(accepted.body.stored,true);assert.equal(replay.body.stored,true);
  assert.equal(background.length,0);assert.equal(rows(DB,'intake_receipts').length,0);
  assert.equal(rows(DB,'items').length,1);
  assert.equal(rows(DB,'items')[0].status,'provisional');
});

test('the existing no-context and queue-less fallback remains synchronous',async t=>{
  const {env,background,call}=await setup(t);
  let dispatched=false;
  env.ANALYSIS_QUEUE.sendBatch=async()=>{await new Promise(resolve=>setTimeout(resolve,10));dispatched=true;};
  assert.equal((await call(input(['https://example.test/no-context']),{context:{}})).body.stored,true);
  assert.equal(dispatched,true);assert.equal(background.length,0);
  delete env.ANALYSIS_QUEUE;
  const result=await call(input(['unknown-text']));
  assert.equal(result.body.stored,true);assert.equal(result.body.job.status,'completed');
  assert.equal(result.body.job.unresolved,1);assert.equal(background.length,0);
});
