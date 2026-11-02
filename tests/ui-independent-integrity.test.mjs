import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createSingleWinController } from '../public/single-win-ui.js';

// D independent acceptance gate: receipt identity, exact recovery and cross-view
// interference. This harness executes the shipped controller and app handlers.
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const extract = (start,end) => app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
const confirmationCode = extract('const pendingConfirmations = new Set();','\nasync function copyPendingForChatGPT') + extract('async function submitConfirmation(card, action)','\nasync function receive()');
const assignmentCode = 'let assignmentSaving = null, assignmentPreviewRequest = 0;\n' + extract('async function openAssignment(','\nasync function openClose');
const classList = () => { const state=new Set();return {add:v=>state.add(v),remove:v=>state.delete(v),contains:v=>state.has(v)}; };
const deferred = () => {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function editor(id,source='arunomatic') {
 const inputs=[{name:'raw_name',value:'実際の編集値',readOnly:false},{name:'display_name',value:'画面名',readOnly:true}];
 const buttons=[{disabled:false},{disabled:false}],message={textContent:'',classList:classList()};
 const card={dataset:{pending:id,source},inputs,buttons,message,classList:classList(),removed:false,
  querySelector:s=>s==='.confirmation-message'?message:null,querySelectorAll:s=>s.startsWith('input')?inputs:buttons,remove(){this.removed=true;}};
 card.classList.add('editing');return card;
}
function confirmationHarness(cards,api) {
 const notice=[],dialog={open:true,close(){this.open=false;}};
 const context={state:{sortingSource:'arunomatic',dialogPendingId:cards[0].dataset.pending,pendingItems:new Map(cards.map(c=>[c.dataset.pending,{}]))},api,
  document:{querySelectorAll:()=>cards},$:id=>id==='pendingDialog'?dialog:{innerHTML:''},load:async()=>true,loadJob:async()=>true,setSortingNotice:(...args)=>notice.push(args)};
 vm.createContext(context);vm.runInContext(confirmationCode,context);return {context,dialog,notice};
}

test('D: two separate editor nodes for one pending group cannot write twice or close a different group',async()=>{
 const a=editor('group-A'),copy=editor('group-A'),b=editor('group-B','chiritumo'),gate=deferred(),requests=[];
 const {context,dialog}=confirmationHarness([a,copy,b],async(path,opts)=>{requests.push({path,body:JSON.parse(opts.body)});return gate.promise;});
 const first=context.submitConfirmation(a,'ok');await context.submitConfirmation(copy,'ok');
 context.state.dialogPendingId='group-B';context.state.sortingSource='chiritumo';
 gate.resolve({ok:true,action:'edit',classified:2});await first;
 assert.equal(requests.length,1);assert.equal(requests[0].body.raw_name,'実際の編集値');
 assert.match(requests[0].path,/intake_source=arunomatic$/);assert.equal(a.removed,true);assert.equal(copy.removed,true);
 assert.equal(b.removed,false);assert.equal(dialog.open,true);assert.equal(context.state.pendingItems.has('group-B'),true);
});

test('D: uncertain edit response restores the exact editable/read-only field mix and no success notice',async()=>{
 const card=editor('group-A');const {context,notice}=confirmationHarness([card],async()=>({ok:true,action:'ok',classified:1}));
 await context.submitConfirmation(card,'ok');
 assert.deepEqual(card.inputs.map(i=>i.readOnly),[false,true]);assert.equal(card.inputs[0].value,'実際の編集値');
 assert.equal(card.removed,false);assert.equal(card.classList.contains('editing'),true);assert.equal(notice.length,0);
 assert.match(card.message.textContent,/保存結果の応答を確認できません/);
});

test('D: completed sorting refresh does not report another source card count or move tabs',async()=>{
 const gate=deferred(),notices=[];const context={state:{sortingSource:'arunomatic',cards:new Map()},
  setSortingNotice:(...args)=>notices.push(args),load:()=>gate.promise,loadCampaigns:async()=>true,loadWinningLists:async()=>true,loadRevenueSummary:async()=>true};
 vm.createContext(context);vm.runInContext(extract('async function refreshAfterAssignment(','\nasync function openAssignment('),context);
 const saving=context.refreshAfterAssignment({assigned_count:2},'arunomatic');context.state.sortingSource='chiritumo';
 context.state.cards=new Map([['other',{unassigned_count:98}]]);gate.resolve(true);await saving;
 assert.deepEqual(notices,[['arunomatic','2件を仕分けました。']]);assert.equal(context.state.sortingSource,'chiritumo');
});

test('D: a preview arriving after closing its modal cannot enable confirmation or replace the cleared target',async()=>{
 const gate=deferred(),fields={assignmentCampaign:{value:'campaign-A'},assignmentMessage:{textContent:''},assignmentDecision:{innerHTML:''},assignmentConfirm:{disabled:false},assignmentDialog:{open:true}};
 const context={state:{sortingSource:'arunomatic',assignmentSource:'arunomatic',assignmentCardId:'card-A',assignmentPreview:null},$:id=>fields[id],api:()=>gate.promise};
 vm.createContext(context);vm.runInContext(assignmentCode,context);
 const opening=context.loadAssignmentPreview();fields.assignmentDialog.open=false;
 gate.resolve({campaign:{campaign_id:'campaign-A',status:'active'},card:{id:'card-A',unassigned_count:4},possible_products:[]});await opening;
 assert.equal(context.state.assignmentPreview,null);assert.equal(fields.assignmentConfirm.disabled,true);assert.equal(fields.assignmentDecision.innerHTML,'');
});

const storageKey='winning-url-vault:single-win-pending:v1';
const memory=()=>({data:new Map(),getItem(k){return this.data.get(k)||null;},setItem(k,v){this.data.set(k,v);}});
const preview=(token='token-A',ids=['item-A','item-B'])=>({card_id:'card-A',intake_source:'arunomatic',count:ids.length,ids,preview_token:token,product_name:'お茶'});
const receipt=(record,extra={})=>({state:'completed',request_id:record.request_id,card_id:record.card_id,intake_source:record.intake_source,campaign_id:'campaign-A',product_id:'product-A',assigned_count:record.count,...extra});
const failed=(status,code)=>Object.assign(new Error('status unavailable'),{status,code});
async function preparedRecovery(api) {
 const storage=memory();let controller=createSingleWinController({storage,requestId:()=> 'local-request-A',api:async()=>{throw Error('first response lost');}});
 const record=controller.prepare(preview());await assert.rejects(controller.submit(record));
 controller=createSingleWinController({storage,api});return {storage,controller,record:controller.pending()[0]};
}

test('D: GET transport failure, unknown state, and generic404 keep recovery metadata and never POST',async()=>{
 for(const outcome of ['transport','unknown','generic404']){
  const calls=[];const fixture=await preparedRecovery(async(path,opts)=>{calls.push({path,opts});if(outcome==='transport')throw failed(503,'unavailable');if(outcome==='generic404')throw failed(404,'WRONG_ROUTE');return {state:'mystery'};});
  const before=fixture.storage.getItem(storageKey);await assert.rejects(fixture.controller.submit(fixture.record));
  assert.equal(calls.length,1);assert.equal(calls[0].opts,undefined);assert.equal(fixture.storage.getItem(storageKey),before);
 }
});

test('D: returning to a card with newer preview data preserves the original pending snapshot',async()=>{
 const {controller,record}=await preparedRecovery(async()=>{throw Error('not called');});
 const reused=controller.prepare(preview('token-new',['item-A','item-B','item-new']));
 assert.equal(reused.request_id,record.request_id);assert.equal(reused.preview_token,'token-A');assert.deepEqual(reused.ids,['item-A','item-B']);
 assert.equal(controller.pending().length,1);assert.equal(reused.count,2);
});

test('D: canonical dedupe completion after missing local receipt resends original snapshot and clears only after success',async()=>{
 const calls=[];let original;
 const fixture=await preparedRecovery(async(path,opts)=>{calls.push({path,opts});if(!opts)throw failed(404,'SINGLE_WIN_NOT_FOUND');return receipt(original,{request_id:'canonical-server-request'});});
 original=fixture.record;const result=await fixture.controller.submit(original);
 assert.equal(calls.length,2);assert.equal(calls[0].path,'/api/single-wins/local-request-A');
 assert.deepEqual(JSON.parse(calls[1].opts.body),{request_id:'local-request-A',ids:['item-A','item-B'],preview_token:'token-A',confirmation:'単発当選として登録'});
 assert.equal(result.request_id,'canonical-server-request');assert.deepEqual(fixture.controller.pending(),[]);
});

test('D: server review of a different source cannot discard the original pending operation',async()=>{
 let original;const fixture=await preparedRecovery(async()=>receipt(original,{state:'needs_review',intake_source:'chiritumo'}));original=fixture.record;
 const before=fixture.storage.getItem(storageKey);await assert.rejects(fixture.controller.replaceChanged(original),/登録処理が保存/);
 assert.equal(fixture.storage.getItem(storageKey),before);
});
