import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareDevicePairing,finishDevicePairing,loginWithDeviceKey} from '../public/device-login.js';

// Transactions are serialized and writes become visible only on completion.
// Abort injection verifies that a successful IDB request is not a durable ACK.
function database(initial){
 const records=new Map(initial),jobs=[];let running=false,abortWrite=false;
 const run=()=>{if(running||!jobs.length)return;running=true;const start=jobs.shift();start();};
 const db={close(){},transaction(_store,mode){
  const tx={},operations=[];let working,started=false,scheduled=false;
  const schedule=()=>{if(started&&!scheduled){scheduled=true;setImmediate(process);}};
  const process=()=>{scheduled=false;
   if(operations.length){const {kind,key,value,q}=operations.shift();
    if(kind==='get')q.result=working.get(key);
    if(kind==='put')working.set(key,value);
    if(kind==='delete')working.delete(key);
    q.onsuccess?.();schedule();return;
   }
   if(mode==='readwrite'&&abortWrite){abortWrite=false;tx.error=new Error('transaction aborted');tx.onabort?.();}
   else{if(mode==='readwrite'){records.clear();for(const pair of working)records.set(...pair);}tx.oncomplete?.();}
   running=false;run();
  };
  const op=(kind,key,value)=>{const q={};operations.push({kind,key,value,q});schedule();return q;};
  tx.objectStore=()=>({get:key=>op('get',key),put:(value,key)=>op('put',key,value),delete:key=>op('delete',key)});
  jobs.push(()=>{working=new Map(records);started=true;schedule();});queueMicrotask(run);return tx;
 }};
 return {records,abortNextWrite(){abortWrite=true;},open(){const q={};queueMicrotask(()=>{q.result=db;q.onsuccess?.();});return q;}};
}
async function keys(){const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);return{privateKey:pair.privateKey,publicJwk:await crypto.subtle.exportKey('jwk',pair.publicKey)};}
function environment(t,old){
 const originals={indexedDB:globalThis.indexedDB,sessionStorage:globalThis.sessionStorage,fetch:globalThis.fetch};
 const db=database(old?[['primary',old]]:[]);globalThis.indexedDB=db;
 globalThis.sessionStorage={getItem(){return null;},removeItem(){}};
 let server=old?.publicJwk,mode='',enrollments=0;
 const response=(body,status=200)=>new Response(JSON.stringify(body),{status});
 globalThis.fetch=async(path,options)=>{
  const body=JSON.parse(options.body);
  if(path.endsWith('/challenge')){
   if(!server)return response({ok:false,error:'not registered'},404);
   return response({ok:true,challenge:'fresh',message:'test login'});
  }
  if(path.endsWith('/enroll')){
   enrollments++;
   if(mode==='enroll-rejected')return response({ok:false,error:'pairing denied'},403);
   server=body.publicJwk;
   if(mode==='enroll-response-lost'){mode='';throw new TypeError('response lost');}
   return response({ok:true});
  }
  if(path.endsWith('/verify')){
   if(mode==='verify-failed-after-enroll'&&enrollments)return response({ok:false,error:'temporary server failure'},503);
   const publicKey=await crypto.subtle.importKey('jwk',server,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
   const sig=Buffer.from(body.signature,'base64url');
   const valid=await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},publicKey,sig,new TextEncoder().encode('test login'));
   return response({ok:valid},valid?200:401);
  }
  throw Error('unexpected path');
 };
 t.after(()=>Object.assign(globalThis,originals));
 return {db,setMode(value){mode=value;},get enrollments(){return enrollments;}};
}
test('準備・中止・再押下で既存鍵を保持し未確定候補を再利用する',async t=>{
 const old=await keys(),e=environment(t,old);
 const [a,b]=await Promise.all([prepareDevicePairing(),prepareDevicePairing()]);
 assert.equal(a.hash,b.hash);assert.equal(e.db.records.get('primary'),old);
 assert.equal(await loginWithDeviceKey(),true);assert.equal(e.db.records.get('primary'),old);
});
test('登録拒否では旧鍵と候補を保持する',async t=>{
 const old=await keys(),e=environment(t,old);await prepareDevicePairing();e.setMode('enroll-rejected');
 await assert.rejects(finishDevicePairing(),/pairing denied/);assert.equal(e.db.records.get('primary'),old);assert.ok(e.db.records.get('pairing'));
});
test('登録ACK消失は候補認証で回復し登録要求を二重消費しない',async t=>{
 const old=await keys(),e=environment(t,old);await prepareDevicePairing();const pending=e.db.records.get('pairing');e.setMode('enroll-response-lost');
 await assert.rejects(finishDevicePairing(),/response lost/);assert.equal(e.db.records.get('primary'),old);assert.equal(e.db.records.get('pairing'),pending);
 assert.equal(await finishDevicePairing(),true);assert.equal(e.enrollments,1);assert.equal(e.db.records.get('primary').privateKey,pending.privateKey);assert.equal(e.db.records.has('pairing'),false);
});
test('登録後ログイン失敗では鍵を残し通常ログインで候補から回復する',async t=>{
 const old=await keys(),e=environment(t,old);await prepareDevicePairing();const pending=e.db.records.get('pairing');e.setMode('verify-failed-after-enroll');
 await assert.rejects(finishDevicePairing(),/temporary server failure/);assert.equal(e.db.records.get('primary'),old);assert.equal(e.db.records.get('pairing'),pending);
 e.setMode('');assert.equal(await loginWithDeviceKey(),true);assert.equal(e.db.records.get('primary').privateKey,pending.privateKey);
});
test('候補保存transaction失敗を成功扱いせず旧鍵を保持する',async t=>{
 const old=await keys(),e=environment(t,old);e.db.abortNextWrite();
 await assert.rejects(prepareDevicePairing(),/transaction aborted/);assert.equal(e.db.records.get('primary'),old);assert.equal(e.db.records.has('pairing'),false);
});
test('初回登録も認証を終えてからprimaryを作成する',async t=>{
 const e=environment(t);await prepareDevicePairing();assert.equal(e.db.records.has('primary'),false);
 assert.equal(await finishDevicePairing(),true);assert.ok(e.db.records.get('primary'));assert.equal(e.db.records.has('pairing'),false);
});

test('昇格transactionが失敗しても両方の鍵から再ログインできる',async t=>{
 const old=await keys(),e=environment(t,old);await prepareDevicePairing();
 e.db.abortNextWrite();await assert.rejects(finishDevicePairing(),/transaction aborted/);
 assert.equal(e.db.records.get('primary'),old);const pending=e.db.records.get('pairing');assert.ok(pending);
 assert.equal(await loginWithDeviceKey(),true);assert.equal(e.db.records.get('primary').privateKey,pending.privateKey);
});
test('旧バージョンで準備済みの鍵とsessionコードでも登録を完了できる',async t=>{
 const old=await keys(),e=environment(t,old);globalThis.sessionStorage.getItem=()=> 'legacy-pairing-code';
 assert.equal(await finishDevicePairing(),true);assert.equal(e.enrollments,0);assert.equal(e.db.records.get('primary').privateKey,old.privateKey);
});
