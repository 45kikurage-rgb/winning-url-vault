import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash,randomBytes,createCipheriv,createDecipheriv,publicEncrypt,X509Certificate} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const account='02100d2235d6f7d7f893b4217b58b902',database='1d3e496f-3d8c-49d7-892a-d32ea5661e0c',worker='winning-url-vault';
const root='https://winning-url-vault.45kikurage.workers.dev',prefix=`https://api.cloudflare.com/client/v4/accounts/${account}`;
const sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>JSON.stringify(x,(_,v)=>v&&!Array.isArray(v)&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const statePath='.private/chiritumo-state.json',proofPath='chiritumo-release-evidence.json';mkdirSync('.private',{recursive:true,mode:0o700});
const proof=x=>writeFileSync(proofPath,JSON.stringify(x,null,2));
async function api(path,body){
 const retrySafe=body===undefined||/^(?:SELECT|PRAGMA|CREATE TABLE IF NOT EXISTS|INSERT OR IGNORE)\b/i.test(String(body?.sql||'').trim());
 for(let attempt=0;attempt<6;attempt++){
  const r=await fetch(prefix+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
  if(retrySafe&&[429,500,502,503,504].includes(r.status)&&attempt<5){const seconds=Math.min(330,Math.max(1,Number(r.headers.get('retry-after'))||2**attempt));await r.arrayBuffer();console.log('Read/check API temporarily limited; retrying after',seconds,'seconds');await new Promise(resolve=>setTimeout(resolve,seconds*1000));continue}
  if(!r.ok){const failure=await r.json().catch(()=>({}));console.log('Provider error codes',JSON.stringify((failure.errors||[]).map(e=>({code:e.code,message:String(e.message||'').slice(0,180)}))));}
  assert(r.ok,'CF_HTTP_'+r.status+' '+path);const d=await r.json();assert(d.success,'CF_REQUEST_FAILED');return d.result;
 }
}
async function sql(query,params=[]){const data=await api('/d1/database/'+database+'/query',{sql:query,params});assert(data.every(r=>r.success),'D1_QUERY_FAILED');return data[0].results||[]}
async function version(){const d=await api('/workers/scripts/'+worker+'/deployments');assert.equal(d.deployments[0].versions.length,1);assert.equal(d.deployments[0].versions[0].percentage,100);return d.deployments[0].versions[0].version_id}
async function runtime(){const b='/workers/scripts/'+worker;const [fullSettings,schedules,subdomain]=await Promise.all(['settings','schedules','subdomain'].map(s=>api(b+'/'+s)));const {annotations,assets,main_module,etag,modified_on,created_on,...settings}=fullSettings;settings.bindings.sort((a,b)=>a.name.localeCompare(b.name));return {settings,fullSettings,schedules,subdomain}}
async function publicRead(path,options={}){let u=new URL(path,root);for(let i=0;i<4;i++){const r=await fetch(u,{...options,redirect:'manual',signal:AbortSignal.timeout(60000)});if([301,302,303,307,308].includes(r.status)){u=new URL(r.headers.get('location'),u);assert.equal(u.origin,new URL(root).origin);continue}return {status:r.status,bytes:Buffer.from(await r.arrayBuffer())}}throw Error('REDIRECT_LOOP')}
const tables=['product_master','cards','pending_confirmations','items'];
async function readTable(table){
 assert(tables.includes(table));const output=[];let cursor=0;const fields=(await sql('PRAGMA table_info('+table+')')).map(c=>c.name);assert(fields.every(name=>/^[a-zA-Z0-9_]+$/.test(name)));const projection=fields.map(name=>name==='analysis_json'?"'{}' AS analysis_json":name==='image_data_uri'?'NULL AS image_data_uri':name).join(',');
 while(true){const rows=await sql(`SELECT rowid AS __backup_rowid,${projection} FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 200`,[cursor]);if(!rows.length)break;cursor=rows.at(-1).__backup_rowid;for(const row of rows){delete row.__backup_rowid;output.push(row)}await new Promise(resolve=>setTimeout(resolve,150))}
 console.log('Read checkpoint table',table,'rows',output.length);return output;
}
if(process.argv[2]==='prepare'){
 const before=await runtime(),baseline=await version();
 const recovery=await api('/d1/database/'+database+'/time_travel/bookmark');assert(recovery.bookmark,'TIME_TRAVEL_BOOKMARK_REQUIRED');assert(before.fullSettings.bindings.some(b=>b.name==='DB'&&(b.id||b.database_id)===database));
 assert.equal((await sql('PRAGMA table_info(items)')).filter(c=>c.name==='intake_source').length,0,'SOURCE_MIGRATION_ALREADY_PRESENT');
 const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));assert.equal(config.compatibility_date,before.fullSettings.compatibility_date);
 for(const key of ['compatibility_flags','observability','limits','logpush','tail_consumers'])if(before.fullSettings[key]!=null)config[key]=before.fullSettings[key];
 if(before.fullSettings.placement?.mode)config.placement=before.fullSettings.placement;
 delete config.vars;config.workers_dev=before.subdomain.enabled;config.preview_urls=before.subdomain.previews_enabled||false;writeFileSync('.release-wrangler.json',JSON.stringify(config));
 const snapshot={},definitions={};
 for(const table of tables){definitions[table]=(await sql('SELECT sql FROM sqlite_master WHERE type=? AND name=?',['table',table]))[0].sql;snapshot[table]=await readTable(table);}
 const restored=new DatabaseSync(':memory:');for(const table of tables)restored.exec(definitions[table]);
 for(const table of tables)for(const row of snapshot[table]){const keys=Object.keys(row);restored.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]))}
 for(const table of tables){const rows=restored.prepare(`SELECT * FROM ${table}`).all(),map=new Map(rows.map(r=>[r.id,r]));assert.equal(rows.length,snapshot[table].length);for(const row of snapshot[table])assert.equal(canonical(row),canonical(map.get(row.id)))}
 assert.equal(Object.values(restored.prepare('PRAGMA integrity_check').get())[0],'ok');assert.equal(restored.prepare('PRAGMA foreign_key_check').all().length,0);restored.close();
 const privateState={before,baseline,snapshot,definitions,recovery};writeFileSync(statePath,JSON.stringify(privateState),{mode:0o600});
 const raw=Buffer.from(JSON.stringify(privateState)),key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),ciphertext=Buffer.concat([cipher.update(raw),cipher.final()]),tag=cipher.getAuthTag();const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);assert.deepEqual(Buffer.concat([decipher.update(ciphertext),decipher.final()]),raw);
 const cert=new X509Certificate(readFileSync('scripts/backup-recipient.crt'));assert.equal(cert.fingerprint256.replaceAll(':','').toLowerCase(),'14e1d564276b56dfbc95888ce8108aafbdaf4da938f7d5b1ed0fb593f274ca3f');
 const envelope={schema:1,algorithm:'RSA-OAEP-SHA256+AES-256-GCM',encryptedKey:publicEncrypt({key:cert.publicKey,oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:tag.toString('base64'),ciphertext:ciphertext.toString('base64')};key.fill(0);writeFileSync('chiritumo-recovery.enc.json',JSON.stringify(envelope));
 proof({source_sha:process.env.GITHUB_SHA,stage:'prepared',baseline,backup_scope:'URL and intake metadata; full images/analysis retained by D1 Time Travel',tables,time_travel_bookmark:recovery.bookmark,backup_restore_integrity:true,counts:Object.fromEntries(tables.map(t=>[t,snapshot[t].length])),encrypted_backup_sha256:sha(JSON.stringify(envelope))});
 console.log('Intake metadata restored with integrity/FK checks; full database recovery bookmark and encrypted metadata checkpoint ready. Production unchanged.');
}else if(process.argv[2]==='migrate'){
 const state=JSON.parse(readFileSync(statePath));assert.equal(await version(),state.baseline);assert.equal(canonical((await runtime()).settings),canonical(state.before.settings));
 // Wrangler runs this one additive-column migration transactionally; no business rows are deleted.
 const {execFileSync}=await import('node:child_process');execFileSync('npx',['wrangler','d1','execute','winning-url-vault','--remote','--file=migrations/0013_chiritumo_intake.sql'],{stdio:'inherit'});
 // Record this explicitly applied migration so later standard deploys do not apply it twice.
 await sql("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
 await sql("INSERT OR IGNORE INTO d1_migrations(name) VALUES (?)",['0013_chiritumo_intake.sql']);
 for(const table of ['items','cards','pending_confirmations'])assert((await sql('PRAGMA table_info('+table+')')).some(c=>c.name==='intake_source'));
 proof({...JSON.parse(readFileSync(proofPath)),stage:'migrated'});
}else if(process.argv[2]==='verify'){
 const state=JSON.parse(readFileSync(statePath)),after=await runtime();for(const key of ['settings','schedules','subdomain'])assert.equal(canonical(after[key]),canonical(state.before[key]),'RUNTIME_CHANGED_'+key);
 for(const table of tables){const rows=await readTable(table),byId=new Map(rows.map(r=>[r.id,r]));for(const old of state.snapshot[table]){if(table==='pending_confirmations'&&!byId.has(old.id))continue;const row=byId.get(old.id);assert(row,'OLD_ROW_MISSING_'+table);for(const key of table==='items'?['id','value','canonical_value','received_at']:table==='cards'?['id','product_id','expires_on']:['id'])assert.equal(row[key],old[key],'EXISTING_DATA_CHANGED_'+table+'_'+key);if(['items','cards','pending_confirmations'].includes(table))assert.equal(row.intake_source,'arunomatic')}}
 for(const file of ['index.html','app.js','styles.css','sw.js']){const response=await publicRead('/'+file+'?release='+process.env.GITHUB_SHA);assert.equal(response.status,200);assert.equal(sha(response.bytes),sha(readFileSync('public/'+file)))}
 assert.equal((await publicRead('/api/cards?intake_source=chiritumo')).status,401);assert.equal((await publicRead('/api/chiritumo/receive')).status,405);
 const testId=crypto.randomUUID(),testUrl='https://br.quocardpay.jp/card/CHIRITEST'+process.env.GITHUB_RUN_ID.slice(-7).padStart(7,'0');
 const send=()=>publicRead('/api/chiritumo/receive',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:testUrl,clientRequestId:testId})});
 const sent=await send(),body=JSON.parse(sent.bytes);assert(sent.status===202||sent.status===200);assert.equal(body.stored,true);
 const testRow=(await sql('SELECT id,intake_source,value,status FROM items WHERE value=?',[testUrl]))[0];assert(testRow);assert.equal(testRow.intake_source,'chiritumo');
 const retry=JSON.parse((await send()).bytes);assert.equal(retry.job.id,body.job.id);assert.equal((await sql('SELECT COUNT(*) n FROM items WHERE value=?',[testUrl]))[0].n,1);
 proof({...JSON.parse(readFileSync(proofPath)),stage:'published_verified',deployed_version:await version(),runtime_preserved:true,old_data_preserved:true,served_bytes_verified:true,write_only_intake:true,test_item_id:testRow.id,test_label:'CHIRITEST'+process.env.GITHUB_RUN_ID.slice(-7),test_source:testRow.intake_source,test_request_id:testId,repeat_safe:true,real_device_test:'pending'});
 console.log('Published bytes, retained settings/data, isolated Chiritumo intake and retry verified. Identified test row retained.');
}
