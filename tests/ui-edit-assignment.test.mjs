import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import worker from '../src/index.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const confirmationCode = section('const pendingConfirmations = new Set();', '\nasync function copyPendingForChatGPT') +
  section('async function submitConfirmation(card, action)', '\nasync function receive()');
const assignmentCode = 'let assignmentSaving = null, assignmentPreviewRequest = 0;\n' +
  section('async function openAssignment(', '\nasync function openClose');
function classList(initial = []) {
  const values = new Set(initial);
  return { add: value => values.add(value), remove: value => values.delete(value), contains: value => values.has(value) };
}
function editor(id = crypto.randomUUID(), source = 'arunomatic') {
  const fields = {raw_name:'修正したお茶',normalized_name:'修正したお茶',display_name:'お茶350',specification:'350ml',redeem_place:'セブンイレブン',expires_on:'2026-11-30'};
  const inputs = Object.entries(fields).map(([name, value]) => ({name,value,readOnly:false,focus(){}}));
  const buttons = Object.fromEntries(['ok','edit','cancel','copy'].map(action => [action,{disabled:false,hidden:false,textContent:action}]));
  const message = {textContent:'',classList:classList(['hidden'])};
  return { dataset:{pending:id,source}, inputs, buttons, message, classList:classList(['editing']), removed:false,
    querySelector(selector) { if(selector === '.confirmation-message') return message; if(selector === 'input') return inputs[0]; return buttons[selector.match(/data-action="(.*?)"/)?.[1]] || null; },
    querySelectorAll(selector) { return selector.startsWith('input') ? inputs : Object.values(buttons); },
    remove(){this.removed=true;} };
}
function confirmationHarness(card, api) {
  const notices = [], nodes = [card];
  const dialog = {open:true,close(){this.open=false;}};
  const context = { state:{sortingSource:card.dataset.source,pendingItems:new Map([[card.dataset.pending,{}]]),dialogPendingId:card.dataset.pending},
    document:{querySelectorAll:() => nodes},
    $:id => id === 'pendingDialog' ? dialog : {innerHTML:''},
    api, load:async()=>true, loadJob:async()=>{}, setSortingNotice:(...args)=>notices.push(args), confirm:()=>true };
  vm.createContext(context); vm.runInContext(confirmationCode,context);
  return {context,notices,dialog,nodes};
}
function database(t) {
  const sql=new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>sql.close());
  const DB={prepare(query){const statement=sql.prepare(query);let args=[];return {bind(...values){args=values;return this;},async first(){return statement.get(...args)||null;},async all(){return {results:statement.all(...args)};},async run(){return {meta:{changes:statement.run(...args).changes}};},execute(){return {meta:{changes:statement.run(...args).changes}};}};},async batch(statements){sql.exec('BEGIN');try{const results=statements.map(statement=>statement.execute());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}};
  const env={DB,SESSION_SECRET:'ui-confirm-test',ACCESS_PASSWORD_SHA256:'configured'};
  return {sql,api:async(path,options) => {
    const expiry=String(Math.floor(Date.now()/1000)+3600),signature=createHmac('sha256',env.SESSION_SECRET).update(expiry).digest('base64url');
    const response=await worker.fetch(new Request('https://vault.test'+path,{...options,headers:{...options.headers,origin:'https://vault.test',cookie:`wuv_session=${expiry}.${signature}`}}),env,{});
    const result=await response.json(); if(!response.ok)throw Error(result.error);return result;
  }};
}

test('editing then original OK saves visible names/specification through the real Worker into both grouped items',async t => {
  const {sql,api}=database(t),card=editor(),id=card.dataset.pending;
  sql.prepare("INSERT INTO pending_confirmations(id,match_key,expires_on,raw_name,normalized_name,display_name,redeem_place,specification,analysis_json) VALUES (?,?,'2026-11-30','元のお茶','元のお茶','元のお茶','セブンイレブン','600ml','{}')").run(id,id);
  for(let i=0;i<2;i++)sql.prepare("INSERT INTO items(id,value,canonical_value,value_type,pending_id,status) VALUES (?,?,?,'url',?,'pending_confirmation')").run(crypto.randomUUID(),'https://example.test/'+i,'https://example.test/'+i,id);
  const {context,notices}=confirmationHarness(card,api);
  context.bindPendingControls(card);
  await card.buttons.ok.onclick();
  const product=sql.prepare('SELECT * FROM product_master').get();
  assert.equal(product.raw_name,'修正したお茶');assert.equal(product.normalized_name,'修正したお茶');assert.equal(product.display_name,'お茶350');assert.equal(product.specification,'350ml');
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM items WHERE status='active'").get().n,2);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM pending_confirmations').get().n,0);
  assert.equal(JSON.parse(sql.prepare("SELECT detail FROM audit_log WHERE action='confirmation_group_approved'").get().detail).edited,true);
  assert.equal(card.removed,true);assert.match(notices[0][1],/2件.*保存/);
});

test('a failed save preserves the editor, and a second click cannot submit the same group concurrently',async()=>{
  const card=editor();let release,calls=0,body;
  const {context}=confirmationHarness(card,async(path,options)=>{calls++;body=JSON.parse(options.body);await new Promise(resolve=>{release=resolve;});throw Error('通信切断');});
  const first=context.submitConfirmation(card,'ok');
  assert.equal(card.inputs.every(input=>input.readOnly),true);assert.equal(card.buttons.ok.disabled,true);
  card.inputs[0].value='入力は残す';
  await context.submitConfirmation(card,'ok');assert.equal(calls,1);assert.equal(body.raw_name,'修正したお茶');
  release();await first;
  assert.equal(card.inputs[0].value,'入力は残す');assert.equal(card.inputs.every(input=>!input.readOnly),true);
  assert.equal(card.classList.contains('editing'),true);assert.equal(card.buttons.ok.disabled,false);assert.equal(card.removed,false);
  assert.match(card.message.textContent,/入力内容は残っています/);
});

test('saved confirmation is removed even if display refresh fails; another modal and source are not closed',async()=>{
  const card=editor();const calls=[];
  const {context,dialog,notices}=confirmationHarness(card,async(path,options)=>{calls.push({path,options});context.state.sortingSource='chiritumo';context.state.dialogPendingId='another';return {ok:true,action:'edit',classified:1};});
  context.load=async()=>false;context.loadJob=async()=>{throw Error('offline');};
  await context.submitConfirmation(card,'ok');
  assert.equal(calls.length,1);assert.match(calls[0].path,/intake_source=arunomatic$/);
  assert.equal(dialog.open,true);assert.equal(card.removed,true);assert.equal(context.state.pendingItems.has(card.dataset.pending),false);
  assert.equal(notices.at(-1)[0],'arunomatic');assert.match(notices.at(-1)[1],/保存しました.*一覧の更新/);
});

test('edit UI has one primary save action; unresolved action never sends edits',async()=>{
  const card=editor();card.classList.remove('editing');let request;
  const {context}=confirmationHarness(card,async(path,options)=>{request=JSON.parse(options.body);return {ok:true,action:'cancel',movedToUnresolved:1};});
  context.bindPendingControls(card);card.buttons.edit.onclick();
  assert.equal(card.buttons.edit.hidden,true);assert.equal(card.buttons.ok.textContent,'修正を保存して確定');
  await context.submitConfirmation(card,'cancel');assert.deepEqual(request,{action:'cancel'});
});

function assignmentHarness(api) {
  const fields={assignmentCampaign:{value:'campaign-A'},assignmentTitle:{textContent:''},assignmentPrediction:{textContent:'',classList:classList()},assignmentMessage:{textContent:''},assignmentDecision:{innerHTML:''},assignmentConfirm:{disabled:false},assignmentDialog:{open:true,querySelectorAll:()=>[fields.assignmentCampaign,fields.assignmentConfirm],showModal(){this.open=true;},close(){this.open=false;}}};
  const state={sortingSource:'arunomatic',assignmentCardId:'card-A',assignmentSource:'arunomatic',campaigns:[],cards:new Map(),assignmentPreview:{campaign:{campaign_id:'campaign-A'},possible_products:[]}};
  const refreshed=[],singleWins=[];
  const context={state,$:id=>fields[id],document:{querySelector:()=>null},esc:value=>value,campaignLabel:campaign=>campaign.campaign_id,predictAssignmentCampaign:()=>null,singleWinUI:{open:async(...args)=>singleWins.push(args)},api,refreshAfterAssignment:async(...args)=>{refreshed.push(args);}};
  vm.createContext(context);vm.runInContext(assignmentCode,context);return {context,fields,state,refreshed,singleWins};
}

test('single-win remains available without campaigns and retains the source/card chosen by the user',async()=>{
  let calls=0;const {context,fields,state,singleWins}=assignmentHarness(async()=>{calls++;});
  await context.openAssignment('no-campaign-card','単発商品');
  assert.equal(calls,0);assert.equal(fields.assignmentDialog.open,true);assert.equal(fields.assignmentConfirm.disabled,true);
  state.sortingSource='chiritumo';
  await context.openSingleWinFromAssignment();
  assert.deepEqual(singleWins,[['no-campaign-card','arunomatic']]);assert.equal(fields.assignmentDialog.open,false);assert.equal(state.assignmentPreview,null);
});

test('moving to single-win invalidates an in-flight campaign preview and cannot interrupt a campaign save',async()=>{
  let release;const {context,fields,state,singleWins}=assignmentHarness(async()=>new Promise(resolve=>{release=resolve;}));
  state.campaigns=[{campaign_id:'campaign-A',status:'active'}];
  const opening=context.openAssignment('card-A','商品');await context.openSingleWinFromAssignment();
  release({campaign:{campaign_id:'campaign-A',status:'active'},card:{unassigned_count:2},possible_products:[]});await opening;
  assert.equal(state.assignmentPreview,null);assert.equal(singleWins.length,1);assert.equal(fields.assignmentDialog.open,false);
  fields.assignmentDialog.open=true;state.assignmentPreview={campaign:{campaign_id:'campaign-A'},possible_products:[]};
  const saving=context.confirmAssignment();await context.openSingleWinFromAssignment();
  assert.equal(singleWins.length,1);assert.equal(fields.assignmentDialog.open,true);
  release({assigned_count:2});await saving;
});

test('assignment pins the source and payload, sends once and leaves tab decisions to the user',async()=>{
  let release;const calls=[];const harness=assignmentHarness(async(path,options)=>{calls.push({path,options});await new Promise(resolve=>{release=resolve;});return {assigned_count:2};});
  const {context,fields,state,refreshed}=harness;
  const first=context.confirmAssignment();await context.confirmAssignment();
  state.sortingSource='chiritumo';fields.assignmentCampaign.value='campaign-B';state.assignmentCardId='card-B';
  release();await first;
  assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/cards/card-A/assign?intake_source=arunomatic');
  assert.deepEqual(JSON.parse(calls[0].options.body),{campaign_id:'campaign-A'});
  assert.equal(fields.assignmentDialog.open,false);assert.equal(refreshed.length,1);assert.equal(refreshed[0][1],'arunomatic');
  assert.equal(fields.assignmentConfirm.disabled,false);
});

test('assignment write failure keeps the selection/dialog, with no success refresh',async()=>{
  const {context,fields,refreshed}=assignmentHarness(async()=>{throw Error('offline');});
  await context.confirmAssignment();assert.equal(fields.assignmentDialog.open,true);assert.equal(fields.assignmentCampaign.value,'campaign-A');assert.equal(fields.assignmentConfirm.disabled,false);assert.equal(refreshed.length,0);assert.match(fields.assignmentMessage.textContent,/保存を確認できません/);
});

test('a delayed campaign preview never overwrites a newer choice',async()=>{
  let releaseA;const {context,fields,state}=assignmentHarness(async path=>{
    const id=path.includes('campaign-A')?'campaign-A':'campaign-B';
    if(id==='campaign-A')await new Promise(resolve=>{releaseA=resolve;});
    return {campaign:{campaign_id:id,status:'active'},card:{unassigned_count:id==='campaign-A'?1:5},possible_products:[]};
  });
  const first=context.loadAssignmentPreview();fields.assignmentCampaign.value='campaign-B';await context.loadAssignmentPreview();releaseA();await first;
  assert.equal(state.assignmentPreview.campaign.campaign_id,'campaign-B');assert.match(fields.assignmentDecision.innerHTML,/5件/);assert.equal(fields.assignmentConfirm.disabled,false);
});

test('successful assignment reports display refresh failure without changing tab or posting again',async()=>{
  const notices=[];let reads=0;const context={state:{sortingSource:'arunomatic',cards:new Map()},setSortingNotice:(...args)=>notices.push(args),load:async()=>{reads++;return false;},loadCampaigns:async()=>{},loadWinningLists:async()=>{},loadRevenueSummary:async()=>{}};
  vm.createContext(context);vm.runInContext(section('async function refreshAfterAssignment(', '\nasync function openAssignment('),context);
  await context.refreshAfterAssignment({assigned_count:3},'arunomatic');assert.equal(reads,1);assert.match(notices[0][1],/3件を仕分けました/);assert.match(notices.at(-1)[1],/一覧の更新ができません/);
});


test('HTTP success without a valid confirmation acknowledgement leaves the edited inputs intact',async()=>{
  const card=editor();const {context,notices}=confirmationHarness(card,async()=>({}));
  await context.submitConfirmation(card,'ok');
  assert.equal(card.removed,false);assert.equal(card.inputs[0].value,'修正したお茶');assert.equal(card.inputs[0].readOnly,false);
  assert.equal(notices.length,0);assert.match(card.message.textContent,/保存結果の応答を確認できません/);
});
