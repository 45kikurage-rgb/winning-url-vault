import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Miniflare } from "miniflare";
import { campaignLabel, canAssignCampaign, buildProductEnvelope, buildTotalsEnvelope } from "../src/ledger.js";

const cookies = new WeakMap();
const ACTIVE = "11111111-1111-4111-8111-111111111111";
const ACTIVE_2 = "22222222-2222-4222-8222-222222222222";
const CLOSING = "33333333-3333-4333-8333-333333333333";
const ZERO = "44444444-4444-4444-8444-444444444444";

function campaigns(state) {
  return [
    { campaign_id:ACTIVE,campaign_name:"コークオン",lottery_start_date:"2026-10-01",status:"active",is_archived:false },
    { campaign_id:ACTIVE_2,campaign_name:"コークオン",lottery_start_date:"2027-02-01",status:"active",is_archived:false },
    { campaign_id:CLOSING,campaign_name:"終了テスト",lottery_start_date:null,status:state.closed?"closed":state.correcting?"correcting":"closing",is_archived:false },
    { campaign_id:ZERO,campaign_name:"0件テスト",lottery_start_date:null,status:"closing",is_archived:false }
  ];
}
async function startLedger() {
  const state={ posts:[],failWrites:false,mismatch:false,closed:false,correcting:false };
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,"http://ledger.test");
    const send=(status,payload)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(payload));};
    if(req.method==="GET"&&url.pathname==="/api/v1/campaigns") return send(200,{items:campaigns(state),next_cursor:null});
    const detail=url.pathname.match(/^\/api\/v1\/campaigns\/([0-9a-f-]+)$/i);
    if(req.method==="GET"&&detail){const c=campaigns(state).find(x=>x.campaign_id===detail[1]);return c?send(200,c):send(404,{ok:false,error:{code:"NOT_FOUND"}});}
    const preview=url.pathname.match(/^\/api\/v1\/campaigns\/([0-9a-f-]+)\/close-preview$/i);
    if(req.method==="GET"&&preview){
      const campaignId=preview[1];
      const productPosts=state.posts.filter(x=>x.path==="/api/v1/products/sync"&&x.body.data.campaign_id===campaignId);
      const latestProducts=new Map(productPosts.map(x=>[x.body.data.product_id,x.body.data]));
      const totals=state.posts.filter(x=>x.path==="/api/v1/totals/sync"&&x.body.data.campaign_id===campaignId).at(-1)?.body.data.current_winner_count;
      if(totals===undefined)return send(409,{ok:false,error:{code:"DEPENDENCY_NOT_READY",retryable:true,details:{}}});
      const products=[...latestProducts.values()].map(p=>({product_id:p.product_id,product_name:p.product_name,final_winner_count:p.current_winner_count,is_archived:false}));
      const productTotal=products.reduce((n,p)=>n+p.final_winner_count,0)-(state.mismatch?1:0);
      return send(200,{campaign_id:campaignId,status:"closing",final_account_count:100,final_winner_count:totals,
        final_product_winner_count:productTotal,winner_count_difference:totals-productTotal,has_mismatch:totals!==productTotal,products,preview_token:`token-${campaignId}-${totals}`});
    }
    if(req.method==="POST"){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}");
      state.posts.push({path:url.pathname,body});
      if(state.failWrites)return send(503,{ok:false,error:{code:"STORAGE_UNAVAILABLE",retryable:true,details:{}}});
      if(url.pathname.endsWith("/corrections")){state.correcting=true;state.closed=false;}
      if(url.pathname.endsWith("/close")){state.closed=true;state.correcting=false;}
      return send(200,{ok:true,result:"applied",event_id:crypto.randomUUID(),source_revision:body.source_revision});
    }
    return send(404,{ok:false,error:{code:"NOT_FOUND"}});
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  return {server,state,address:`127.0.0.1:${server.address().port}`};
}
async function runtime() {
  const ledger=await startLedger();
  const mf=new Miniflare({modules:true,scriptPath:new URL("../src/worker.js",import.meta.url).pathname,
    modulesRules:[{type:"ESModule",include:["**/*.js"]}],compatibilityDate:"2026-09-22",d1Databases:{DB:"vault-db"},
    serviceBindings:{LEDGER_READER:{external:{address:ledger.address,http:{}}},LEDGER_VAULT:{external:{address:ledger.address,http:{}}}},
    bindings:{ACCESS_PASSWORD_SHA256:"b916a41ca29c2e11feef1e12aa42f69e6a5531c4995a8a4f4979c165206b0171",SESSION_SECRET:"integration-test-session-secret",OPERATION_MODE:"trial",
      COKEON_REDEEM_BASE_URL:"https://c.cocacola.co.jp/spn/app/cp/couponcode.html?couponcode="}});
  const {DB}=await mf.getBindings();
  for(const file of ["../schema.sql","../migrations/0001_central_ledger.sql"]){
    const sql=await readFile(new URL(file,import.meta.url),"utf8");
    for(const statement of sql.split(";").map(x=>x.trim()).filter(Boolean))await DB.prepare(statement).run();
  }
  const worker=await mf.getWorker();
  const login=await worker.fetch("https://vault.test/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:"test-access-password"})});
  assert.equal(login.ok,true);cookies.set(worker,login.headers.get("set-cookie").split(";")[0]);
  return {mf,worker,DB,...ledger};
}
async function req(worker,path,options={}){const headers=new Headers(options.headers||{});headers.set("cookie",cookies.get(worker)||"");const response=await worker.fetch(`https://vault.test${path}`,{...options,headers});const payload=await response.json();return {response,payload};}
async function ok(worker,path,options){const r=await req(worker,path,options);assert.equal(r.response.ok,true,JSON.stringify(r.payload));return r.payload;}
async function cleanup(ctx){await ctx.mf.dispose();ctx.server.closeAllConnections?.();await new Promise(resolve=>ctx.server.close(resolve));}
async function receiveCode(worker,code){return ok(worker,"/api/receive",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({values:[code]})});}

test("campaign reader uses campaign_id, distinguishes same names and tolerates missing start date",async t=>{
  const ctx=await runtime();t.after(()=>cleanup(ctx));
  const result=await ok(ctx.worker,"/api/ledger/campaigns");
  assert.equal(result.campaigns.length,4);
  assert.equal(result.campaigns[0].campaign_id,ACTIVE);
  assert.equal(result.campaigns[1].campaign_id,ACTIVE_2);
  assert.equal(result.campaigns[0].campaign_name,result.campaigns[1].campaign_name);
  assert.notEqual(result.campaigns[0].lottery_start_date,result.campaigns[1].lottery_start_date);
  assert.match(result.campaigns.find(c=>c.campaign_id===CLOSING).display_label,/開始日未設定/);
  assert.equal(result.campaigns.find(c=>c.campaign_id===CLOSING).assignable,true);
  ctx.state.closed=true;
  const closed=await ok(ctx.worker,"/api/ledger/campaigns");
  assert.equal(closed.campaigns.find(c=>c.campaign_id===CLOSING).assignable,false);
});

test("formal product_id is issued only on campaign assignment and product/totals envelopes contain no winning URL",async t=>{
  const ctx=await runtime();t.after(()=>cleanup(ctx));
  await receiveCode(ctx.worker,"cdAb12Cd34Ef56");
  const card=(await ok(ctx.worker,"/api/ledger/sorting/cards")).cards[0];
  assert.equal(card.unassigned_count,1);
  assert.equal((await ctx.DB.prepare("SELECT COUNT(*) n FROM campaign_products").first()).n,0);
  const assigned=await ok(ctx.worker,`/api/ledger/cards/${card.card_id}/assign`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({campaign_id:ACTIVE})});
  assert.match(assigned.product_id,/^[0-9a-f-]{36}$/i);
  assert.equal(assigned.campaign_id,ACTIVE);
  assert.equal((await ctx.DB.prepare("SELECT COUNT(*) n FROM campaign_products").first()).n,1);
  const writes=ctx.state.posts.filter(x=>["/api/v1/products/sync","/api/v1/totals/sync"].includes(x.path));
  assert.deepEqual(writes.map(x=>x.path),["/api/v1/products/sync","/api/v1/totals/sync"]);
  assert.equal(writes[0].body.source_system,"winning-url-vault");
  assert.equal(writes[0].body.source_record_id,`product:${assigned.product_id}`);
  assert.equal(writes[1].body.source_record_id,`totals:${ACTIVE}`);
  assert.equal(writes[0].body.data.campaign_id,ACTIVE);
  assert.equal(writes[0].body.data.current_winner_count,1);
  assert.equal(writes[1].body.data.current_winner_count,1);
  assert.equal(JSON.stringify(writes).includes("couponcode.html"),false);
  const duplicate=await receiveCode(ctx.worker,"cdAb12Cd34Ef56");
  assert.equal(duplicate.duplicate,1);
  const noChange=await ok(ctx.worker,`/api/ledger/cards/${card.card_id}/assign`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({campaign_id:ACTIVE})});
  assert.equal(noChange.no_change,true);
  assert.equal(noChange.product_id,assigned.product_id);
});

test("durable outbox preserves local assignment during ledger outage and resends frozen newer revisions",async t=>{
  const ctx=await runtime();t.after(()=>cleanup(ctx));
  await receiveCode(ctx.worker,"cdAb12Cd34Ef56");
  const card=(await ok(ctx.worker,"/api/ledger/sorting/cards")).cards[0];
  const first=await ok(ctx.worker,`/api/ledger/cards/${card.card_id}/assign`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({campaign_id:ACTIVE})});
  await receiveCode(ctx.worker,"cdZz12Yy34Xx56");
  ctx.state.failWrites=true;
  const second=await ok(ctx.worker,`/api/ledger/cards/${card.card_id}/assign`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({campaign_id:ACTIVE})});
  assert.equal(second.product_id,first.product_id);
  assert.equal(second.product_revision,2);
  assert.equal(second.totals_revision,2);
  assert.equal((await ctx.DB.prepare("SELECT COUNT(*) n FROM campaign_product_items").first()).n,2);
  assert.equal((await ctx.DB.prepare("SELECT COUNT(*) n FROM ledger_outbox WHERE status!='sent'").first()).n,2);
  const retryPayload=ctx.state.posts.filter(x=>x.path==="/api/v1/products/sync"&&x.body.source_revision===2).at(-1).body;
  ctx.state.failWrites=false;
  const retried=await ok(ctx.worker,"/api/ledger/outbox/retry",{method:"POST"});
  assert.equal(retried.pending,0);
  assert.equal(retried.failed,0);
  const resent=ctx.state.posts.filter(x=>x.path==="/api/v1/products/sync"&&x.body.source_revision===2).at(-1).body;
  assert.deepEqual(resent,retryPayload);
  assert.equal((await ctx.DB.prepare("SELECT COUNT(*) n FROM ledger_outbox WHERE status='sent'").first()).n,4);
});

test("closing mismatch requires confirmation, closed blocks assignment, correction reopens, and zero-win close initializes totals",async t=>{
  const ctx=await runtime();t.after(()=>cleanup(ctx));
  await receiveCode(ctx.worker,"cdAb12Cd34Ef56");
  const card=(await ok(ctx.worker,"/api/ledger/sorting/cards")).cards[0];
  await ok(ctx.worker,`/api/ledger/cards/${card.card_id}/assign`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({campaign_id:CLOSING})});
  ctx.state.mismatch=true;
  const preview=await ok(ctx.worker,`/api/ledger/campaigns/${CLOSING}/close-preview`);
  assert.equal(preview.preview.has_mismatch,true);
  const refused=await req(ctx.worker,`/api/ledger/campaigns/${CLOSING}/close`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({preview_token:preview.preview.preview_token,accept_mismatch:false})});
  assert.equal(refused.response.status,409);
  await ok(ctx.worker,`/api/ledger/campaigns/${CLOSING}/close`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({preview_token:preview.preview.preview_token,accept_mismatch:true})});
  await receiveCode(ctx.worker,"cdZz12Yy34Xx56");
  const blocked=await req(ctx.worker,`/api/ledger/cards/${card.card_id}/assign`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({campaign_id:CLOSING})});
  assert.equal(blocked.response.status,409);
  await ok(ctx.worker,`/api/ledger/campaigns/${CLOSING}/corrections`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({reason:"件数訂正"})});
  const corrected=await ok(ctx.worker,`/api/ledger/cards/${card.card_id}/assign`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({campaign_id:CLOSING})});
  assert.equal(corrected.assigned,1);
  ctx.state.mismatch=false;
  const zero=await ok(ctx.worker,`/api/ledger/campaigns/${ZERO}/close-preview`);
  assert.equal(zero.preview.final_winner_count,0);
  assert.ok(ctx.state.posts.some(x=>x.path==="/api/v1/totals/sync"&&x.body.data.campaign_id===ZERO&&x.body.data.current_winner_count===0));
});

test("pure envelope rules keep immutable ids and expected source series",()=>{
  assert.equal(campaignLabel({campaign_name:"A",lottery_start_date:null}),"A 開始日未設定");
  assert.equal(canAssignCampaign({status:"active",is_archived:false}),true);
  assert.equal(canAssignCampaign({status:"closing",is_archived:false}),true);
  assert.equal(canAssignCampaign({status:"correcting",is_archived:false}),true);
  assert.equal(canAssignCampaign({status:"closed",is_archived:false}),false);
  const product=buildProductEnvelope({productId:"p-1",campaignId:"c-1",model:{raw_name:"商品",redeem_place:"店",specification:"350ml",expires_on:"2026-10-31"},count:2,assignedAt:"2026-10-01T00:00:00.000Z",revision:3,occurredAt:"2026-10-01T00:01:00.000Z"});
  assert.equal(product.source_record_id,"product:p-1");assert.equal(product.source_revision,3);assert.equal(product.data.campaign_id,"c-1");
  const totals=buildTotalsEnvelope({campaignId:"c-1",count:2,revision:4,occurredAt:"2026-10-01T00:01:00.000Z"});
  assert.equal(totals.source_record_id,"totals:c-1");assert.equal(totals.source_revision,4);assert.equal(totals.data.current_winner_count,2);
});
