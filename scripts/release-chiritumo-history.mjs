import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const account='02100d2235d6f7d7f893b4217b58b902',database='1d3e496f-3d8c-49d7-892a-d32ea5661e0c';
const base=`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}`,root='https://winning-url-vault.45kikurage.workers.dev';
const statePath='.private/chiritumo-history-state.json',proofPath='chiritumo-history-evidence.json';mkdirSync('.private',{recursive:true,mode:0o700});
async function api(path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});assert(r.ok,'D1 HTTP '+r.status);const d=await r.json();assert(d.success,'D1 request failed');return d.result;}
async function sql(query,params=[]){const r=await api('/query',{sql:query,params});assert(r.every(x=>x.success));return r[0].results||[];}
const fingerprint=async()=> (await sql("SELECT intake_source,COUNT(*) n,GROUP_CONCAT(id,',') ids FROM (SELECT id,intake_source FROM items ORDER BY id) GROUP BY intake_source")).map(x=>({source:x.intake_source,count:x.n,sha256:createHash('sha256').update(x.ids||'').digest('hex')}));
async function publicApi(path,body){const r=await fetch(root+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(path.endsWith('/history')&&body?{Origin:'https://chiritumo-kikurage1.vercel.app'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});const d=await r.json();assert(r.ok,JSON.stringify({status:r.status,error:d.error}));return d;}
const idsOf=c=>JSON.parse(atob(c.hideToken.split('.')[0])).ids;
if(process.argv[2]==='prepare'){
 const bookmark=await api('/time_travel/bookmark');assert(bookmark.bookmark);
 writeFileSync(statePath,JSON.stringify({before:await fingerprint(),bookmark:bookmark.bookmark}),{mode:0o600});
 writeFileSync(proofPath,JSON.stringify({stage:'prepared',source_sha:process.env.GITHUB_SHA,existing_data_mutations:0}));
 console.log('History-only additive migration prepared. Existing items unchanged.');
}else if(process.argv[2]==='record-migration'){
 await sql('INSERT OR IGNORE INTO d1_migrations(name) VALUES (?)',['0014_chiritumo_history.sql']);
}else if(process.argv[2]==='verify'){
 const state=JSON.parse(readFileSync(statePath));assert.deepEqual(await fingerprint(),state.before);
 assert((await publicApi('/api/chiritumo/history')).ok);
 const label='CHIRIHIST'+process.env.GITHUB_RUN_ID;
 const values=[0,1,2].map(i=>'https://br.quocardpay.jp/card/'+label+i);
 const testIds=[];let proof;
 try{
  const sent=await publicApi('/api/chiritumo/receive',{text:values.slice(0,2).join('\n'),clientRequestId:crypto.randomUUID()});assert.equal(sent.received,2);assert.equal(sent.duplicate,0);
  const repeat=await publicApi('/api/chiritumo/receive',{text:values[0],clientRequestId:crypto.randomUUID()});assert.equal(repeat.received,0);assert.equal(repeat.duplicate,1);
  for(let i=0;i<45;i++){
   const rows=await sql('SELECT id,status FROM items WHERE value IN (?,?)',values.slice(0,2));
   assert.equal(rows.length,2);testIds.splice(0,testIds.length,...rows.map(r=>r.id));
   if(rows.every(r=>!['queued','received'].includes(r.status)))break;
   assert(i<44,'Analyzer did not complete');await new Promise(r=>setTimeout(r,2000));
  }
  // Isolate synthetic grouping checks from every real category, irrespective of analyzer fallback.
  const analysis=JSON.stringify({status:'ok',product:'試験用 '+label,redeemPlace:'試験専用引換先',capacity:'試験規格',site:'test'});
  await sql("UPDATE items SET card_id=NULL,pending_id=NULL,status='unresolved',analysis_json=? WHERE intake_source='chiritumo' AND value IN (?,?)",[analysis,...values.slice(0,2)]);
  let history=await publicApi('/api/chiritumo/history');const category=history.categories.find(c=>idsOf(c).includes(testIds[0]));
  assert(category);assert.equal(category.count,2);assert(idsOf(category).every(id=>testIds.includes(id)));assert.equal(category.redeemPlace,'試験専用引換先');
  const third=await publicApi('/api/chiritumo/receive',{text:values[2],clientRequestId:crypto.randomUUID()});assert.equal(third.received,1);
  const row=(await sql('SELECT id FROM items WHERE value=?',[values[2]]))[0];assert(row);testIds.push(row.id);
  // Finish the third item's analysis before updating this test-only result.
  for(let i=0;i<45;i++){const jobs=await sql('SELECT state FROM analysis_job_items WHERE item_id=?',[row.id]);if(jobs.length&&jobs.every(r=>r.state==='done'))break;assert(i<44);await new Promise(r=>setTimeout(r,2000));}
  await sql("UPDATE items SET card_id=NULL,pending_id=NULL,status='unresolved',analysis_json=? WHERE id=? AND value=? AND intake_source='chiritumo'",[analysis,row.id,values[2]]);
  const hidden=await publicApi('/api/chiritumo/history',{hideToken:category.hideToken});assert(hidden.ok);
  history=await publicApi('/api/chiritumo/history');assert(!history.categories.some(c=>idsOf(c).some(id=>testIds.slice(0,2).includes(id))));
  const remaining=history.categories.find(c=>idsOf(c).includes(row.id));assert(remaining);assert.equal(remaining.count,1);
  assert.equal((await sql("SELECT COUNT(*) n FROM items WHERE value IN (?,?,?) AND intake_source='chiritumo'",values))[0].n,3);
  proof={stage:'production_history_verified',source_sha:process.env.GITHUB_SHA,intake_duplicate_checked:true,analyzer_pipeline_completed:true,synthetic_same_product_same_place_group_count:2,hide_preserved_urls_and_source:true,new_arrival_after_snapshot_preserved:true,other_items_preserved:true};
 }finally{
  // Always remove this run's synthetic coupons, including their hidden markers.
  for(const value of values){
   const row=(await sql("SELECT id FROM items WHERE value=? AND intake_source='chiritumo'",[value]))[0];if(!row)continue;
   assert(value.includes(label));assert.equal((await sql('SELECT COUNT(*) n FROM item_campaign_assignments WHERE item_id=?',[row.id]))[0].n,0);
   for(const table of ['unresolved_items','analysis_staging','analysis_job_items','chiritumo_history_hidden'])await sql(`DELETE FROM ${table} WHERE item_id=?`,[row.id]);
   await sql("DELETE FROM items WHERE id=? AND value=? AND intake_source='chiritumo'",[row.id,value]);
  }
  assert.equal((await sql('SELECT COUNT(*) n FROM items WHERE value IN (?,?,?)',values))[0].n,0);
  assert.deepEqual(await fingerprint(),state.before,'Other item identities changed during verification');
  console.log('Production test coupons removed; all other item identities/counts retained.');
 }
 assert(proof);proof.synthetic_test_items_remaining=0;writeFileSync(proofPath,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}
