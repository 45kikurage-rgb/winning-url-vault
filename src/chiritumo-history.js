import {normalizeAnalysis,normalizeName,normalizeRedeemPlace,normalizeSpecification} from './core.js';

const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const encoder=new TextEncoder();
const hex=bytes=>[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
async function signature(env,value){
  if(!env.SESSION_SECRET)throw Error('History signing unavailable');
  const key=await crypto.subtle.importKey('raw',encoder.encode(env.SESSION_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(await crypto.subtle.sign('HMAC',key,encoder.encode('chiritumo-history:'+value)));
}
function equal(a,b){if(a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
function model(row){
  let analysis={};try{analysis=JSON.parse(row.analysis_json||'{}')||{};}catch{}
  const fallback=normalizeAnalysis(analysis);
  const name=row.product_name||fallback.rawName||'';
  const place=normalizeRedeemPlace(row.redeem_place||fallback.redeemPlace||'');
  const specification=normalizeSpecification(row.specification||fallback.specification||'');
  const processing=['received','queued'].includes(row.status);
  return {name:name||'商品名未判定',place:place||'引換先未判定',specification,processing,identified:Boolean(name&&place),key:JSON.stringify([normalizeName(name),place,specification])};
}
async function overview(env){
  const rows=(await env.DB.prepare(`SELECT i.id,i.rowid sequence,i.status,i.received_at,
    json_object('product',json_extract(CASE WHEN json_valid(i.analysis_json) THEN i.analysis_json ELSE '{}' END,'$.product'),
      'groupName',json_extract(CASE WHEN json_valid(i.analysis_json) THEN i.analysis_json ELSE '{}' END,'$.groupName'),
      'redeemPlace',json_extract(CASE WHEN json_valid(i.analysis_json) THEN i.analysis_json ELSE '{}' END,'$.redeemPlace'),
      'merchant',json_extract(CASE WHEN json_valid(i.analysis_json) THEN i.analysis_json ELSE '{}' END,'$.merchant'),
      'brand',json_extract(CASE WHEN json_valid(i.analysis_json) THEN i.analysis_json ELSE '{}' END,'$.brand'),
      'capacity',json_extract(CASE WHEN json_valid(i.analysis_json) THEN i.analysis_json ELSE '{}' END,'$.capacity'),
      'groupSpecification',json_extract(CASE WHEN json_valid(i.analysis_json) THEN i.analysis_json ELSE '{}' END,'$.groupSpecification'),
      'site',json_extract(CASE WHEN json_valid(i.analysis_json) THEN i.analysis_json ELSE '{}' END,'$.site'),
      'kind',json_extract(CASE WHEN json_valid(i.analysis_json) THEN i.analysis_json ELSE '{}' END,'$.kind'),
      'boxCategory',json_extract(CASE WHEN json_valid(i.analysis_json) THEN i.analysis_json ELSE '{}' END,'$.boxCategory'),
      'balance',json_extract(CASE WHEN json_valid(i.analysis_json) THEN i.analysis_json ELSE '{}' END,'$.balance'),
      'balanceUnit',json_extract(CASE WHEN json_valid(i.analysis_json) THEN i.analysis_json ELSE '{}' END,'$.balanceUnit')) analysis_json,
    COALESCE(p.raw_name,pc.raw_name) product_name,COALESCE(p.redeem_place,pc.redeem_place) redeem_place,
    COALESCE(p.specification,pc.specification) specification
    FROM items i LEFT JOIN cards c ON c.id=i.card_id LEFT JOIN product_master p ON p.id=c.product_id
    LEFT JOIN pending_confirmations pc ON pc.id=i.pending_id
    WHERE i.intake_source='chiritumo' AND NOT EXISTS(SELECT 1 FROM chiritumo_history_hidden h WHERE h.item_id=i.id)
    ORDER BY i.rowid DESC`).all()).results||[];
  const groups=new Map();let processing=0;
  for(const row of rows){
    const m=model(row);if(m.processing)processing++;
    if(!groups.has(m.key))groups.set(m.key,{productName:m.name,redeemPlace:m.place,specification:m.specification,count:0,processing:0,identified:m.identified,lastReceivedAt:row.received_at,ids:[]});
    const group=groups.get(m.key);group.count++;group.processing+=Number(m.processing);group.ids.push(row.id);
  }
  const categories=[];
  for(const [key,group] of groups){
    const snapshot=btoa(JSON.stringify({v:1,ids:group.ids}));
    const hideToken=snapshot+'.'+await signature(env,snapshot);
    const {ids,...visible}=group;
    categories.push({...visible,id:hex(await crypto.subtle.digest('SHA-256',encoder.encode(key))),hideToken});
  }
  return {ok:true,total:rows.length,processing,categories};
}
async function hide(request,env){
  if(request.headers.get('origin')!=='https://chiritumo-kikurage1.vercel.app')return json({ok:false,error:'チリツモ画面から操作してください'},403);
  if(Number(request.headers.get('content-length')||0)>1000000)return json({ok:false,error:'対象が多すぎます'},413);
  let body;try{body=await request.json();}catch{return json({ok:false,error:'入力が正しくありません'},400);}
  const token=body?.hideToken;
  if(typeof token!=='string'||token.length>1000000)return json({ok:false,error:'履歴を更新してやり直してください'},400);
  const [snapshot,sig,...extra]=token.split('.');
  if(extra.length||!equal(sig||'',await signature(env,snapshot)))return json({ok:false,error:'履歴を更新してやり直してください'},400);
  let data;try{data=JSON.parse(atob(snapshot));}catch{return json({ok:false,error:'削除対象が正しくありません'},400);}
  if(data?.v!==1||!Array.isArray(data.ids)||!data.ids.length||data.ids.length>20000||data.ids.some(x=>typeof x!=='string'||!/^[-0-9a-f]{36}$/i.test(x)))return json({ok:false,error:'削除対象が正しくありません'},400);
  const ids=[...new Set(data.ids)],statements=[],stamp=new Date().toISOString();
  for(let i=0;i<ids.length;i+=70){const chunk=ids.slice(i,i+70);statements.push(env.DB.prepare(`INSERT OR IGNORE INTO chiritumo_history_hidden(item_id,hidden_at)
    SELECT id,? FROM items WHERE intake_source='chiritumo' AND id IN (${chunk.map(()=>'?').join(',')})`).bind(stamp,...chunk));}
  await env.DB.batch(statements);
  return json({ok:true,hidden:ids.length,preserved:'coupon_urls_and_chiritumo_source'});
}
export async function chiritumoHistory(request,env){
  // Sending credentials retain their existing write-only scope.
  if(request.headers.has('authorization'))return json({ok:false,error:'送信専用トークンでは操作できません'},403);
  if(request.method==='GET')return json(await overview(env));
  if(request.method==='POST')return hide(request,env);
  return json({ok:false,error:'GETまたはPOSTのみ対応'},405);
}
