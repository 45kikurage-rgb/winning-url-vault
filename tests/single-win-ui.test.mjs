import test from 'node:test';
import assert from 'node:assert/strict';
import { createSingleWinController } from '../public/single-win-ui.js';
const key='winning-url-vault:single-win-pending:v1';
const preview=(card='card-A',source='arunomatic')=>({card_id:card,intake_source:source,count:2,ids:[card+'-1',card+'-2'],preview_token:'snapshot-token',product_name:'お茶',product_spec:'350ml',registration_date:'2026-11-02'});
const receipt=record=>({state:'completed',request_id:record.request_id,card_id:record.card_id,intake_source:record.intake_source,campaign_id:'campaign',product_id:'product',assigned_count:2});
const memory=()=>({values:new Map(),getItem(key){return this.values.get(key)||null;},setItem(key,value){this.values.set(key,value);}});
const missing=()=>Object.assign(Error('not found'),{status:404,code:'SINGLE_WIN_NOT_FOUND'});

test('operation metadata is saved before POST; successful receipt clears only that operation',async()=>{
  const storage=memory(),calls=[];let record;
  const controller=createSingleWinController({storage,requestId:()=> 'request-A',api:async(path,options)=>{calls.push({path,options});assert.equal(JSON.parse(storage.getItem(key))[0].attempted,true);return receipt(record);}});
  record=controller.prepare(preview());const result=await controller.submit(record);
  assert.equal(result.state,'completed');assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/cards/card-A/single-win?intake_source=arunomatic');
  assert.deepEqual(JSON.parse(calls[0].options.body),{request_id:'request-A',ids:['card-A-1','card-A-2'],preview_token:'snapshot-token',confirmation:'単発当選として登録'});
  assert.deepEqual(controller.pending(),[]);
});

test('lost success response survives recreation: completion is read without reposting',async()=>{
  const storage=memory();let posts=0,saved;
  let controller=createSingleWinController({storage,requestId:()=> 'request-A',api:async()=>{posts++;throw Error('response lost');}});
  saved=controller.prepare(preview());await assert.rejects(controller.submit(saved),/response lost/);
  const before=storage.getItem(key);
  controller=createSingleWinController({storage,api:async(path,options)=>{assert.equal(options,undefined);assert.equal(path,'/api/single-wins/request-A');return receipt(saved);}});
  assert.equal(controller.pending()[0].request_id,'request-A');assert.equal(controller.pending()[0].attempted,true);
  await controller.submit(controller.pending()[0]);assert.equal(posts,1);assert.match(before,/request-A/);assert.deepEqual(controller.pending(),[]);
});

test('unknown or pending receipt retries the exact same payload, including original source and snapshot',async()=>{
  for(const state of ['missing','pending']){
    const storage=memory();let fail=true;const calls=[];
    const controller=createSingleWinController({storage,requestId:()=> 'request-A',api:async(path,options)=>{
      calls.push({path,options});if(!options){if(state==='missing')throw missing();return {state:'pending'};}
      if(fail){fail=false;throw Error('offline');}return receipt(record);
    }});
    const record=controller.prepare(preview('card-A','chiritumo'));await assert.rejects(controller.submit(record));await controller.submit(record);
    assert.equal(calls.length,3);assert.equal(calls[0].options.body,calls[2].options.body);assert.match(calls[2].path,/intake_source=chiritumo$/);
  }
});

test('simultaneous submit calls share one network operation',async()=>{
  const storage=memory();let resolve,calls=0,record;
  const controller=createSingleWinController({storage,requestId:()=> 'request-A',api:async()=>{calls++;await new Promise(done=>{resolve=done;});return receipt(record);}});
  record=controller.prepare(preview());const first=controller.submit(record),second=controller.submit(record);
  assert.equal(first,second);assert.equal(calls,1);resolve();await Promise.all([first,second]);
});

test('storage denial prevents POST; unreadable existing metadata is retained',async()=>{
  let posts=0;
  const denied={getItem:()=>null,setItem(){throw Error('quota');}};
  const controller=createSingleWinController({storage:denied,api:async()=>{posts++;}});
  assert.throws(()=>controller.prepare(preview()),/端末に保存できません/);assert.equal(posts,0);
  const storage=memory();storage.setItem(key,'{broken');
  const broken=createSingleWinController({storage,api:async()=>{posts++;}});
  assert.throws(()=>broken.prepare(preview()),/読み込めません/);assert.equal(storage.getItem(key),'{broken');assert.equal(posts,0);
});

test('malformed or mismatched completion never drops the pending operation',async()=>{
  for(const change of [{state:'pending'},{card_id:'different'},{intake_source:'chiritumo'},{assigned_count:3},{product_id:''}]){
    const storage=memory();let record;
    const controller=createSingleWinController({storage,requestId:()=> 'request-A',api:async()=>({...receipt(record),...change})});
    record=controller.prepare(preview());await assert.rejects(controller.submit(record),/完了を確認できません/);assert.equal(controller.pending().length,1);
  }
});

test('only an explicitly confirmed absent operation may be replaced after preview changes',async()=>{
  const storage=memory();let exists=true;
  const controller=createSingleWinController({storage,requestId:()=> 'request-A',api:async()=>{if(exists)return {state:'pending'};throw missing();}});
  const record=controller.prepare(preview());await assert.rejects(controller.replaceChanged(record),/登録処理が保存/);assert.equal(controller.pending().length,1);
  exists=false;await controller.replaceChanged(record);assert.equal(controller.pending().length,0);
});

test('parallel operations preserve each other; metadata contains no URL payload',async()=>{
  const storage=memory();let next=0;const records=new Map();
  const controller=createSingleWinController({storage,requestId:()=> 'request-'+(++next),api:async(path,options)=>receipt(records.get(JSON.parse(options.body).request_id))});
  const a=controller.prepare(preview('card-A'));records.set(a.request_id,a);
  const b=controller.prepare(preview('card-B','chiritumo'));records.set(b.request_id,b);
  assert.doesNotMatch(storage.getItem(key),/https?:|values|canonical/);
  await controller.submit(a);assert.deepEqual(controller.pending().map(record=>record.request_id),[b.request_id]);
  await controller.submit(b);assert.equal(controller.pending().length,0);
});

test('a confirmed registration remains successful when local cleanup fails',async()=>{
  const storage=memory();let cleanupFail=false,record;
  const original=storage.setItem.bind(storage);storage.setItem=(key,value)=>{if(cleanupFail&&value==='[]')throw Error('quota');original(key,value);};
  const controller=createSingleWinController({storage,requestId:()=> 'request-A',api:async()=>{cleanupFail=true;return receipt(record);}});
  record=controller.prepare(preview());const result=await controller.submit(record);assert.equal(result.state,'completed');assert.match(result.device_warning,/登録は完了/);assert.equal(controller.pending().length,1);
});

test('server-invalidated needs_review operation can be explicitly replaced, but mismatched receipts are kept',async()=>{
  const storage=memory();let record,mismatched=false;
  const controller=createSingleWinController({storage,requestId:()=> 'request-A',api:async()=>({...receipt(record),state:'needs_review',...(mismatched?{card_id:'different'}:{})})});
  record=controller.prepare(preview());record.attempted=true;
  await assert.rejects(controller.submit(record),error=>error.code==='SINGLE_WIN_PREVIEW_CHANGED');
  assert.equal(controller.pending().length,1);
  mismatched=true;await assert.rejects(controller.replaceChanged(record),/登録処理が保存/);assert.equal(controller.pending().length,1);
  mismatched=false;await controller.replaceChanged(record);assert.equal(controller.pending().length,0);
});
