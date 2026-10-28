import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash,randomBytes,createCipheriv,createDecipheriv,publicEncrypt,X509Certificate} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isTikTokLongVideo} from '../public/tiktok-video.js';

const account='02100d2235d6f7d7f893b4217b58b902',database='1d3e496f-3d8c-49d7-892a-d32ea5661e0c';
const worker='winning-url-vault',root='https://winning-url-vault.45kikurage.workers.dev';
const baseline='fb7c27cb-7a54-48e1-b81f-aa0c760d4df2';
const prefix=`https://api.cloudflare.com/client/v4/accounts/${account}`;
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value,(_,v)=>v && !Array.isArray(v) && typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const fixedTables=['tiktok_video_links','tiktok_video_batches'];
const statePath='.private/tiktok-state.json',proofPath='tiktok-release-evidence.json';
mkdirSync('.private',{recursive:true,mode:0o700});
const proof=data=>writeFileSync(proofPath,JSON.stringify(data,null,2));
async function api(path,body) {
  const response=await fetch(prefix+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
  assert(response.ok,'CF_HTTP_'+response.status);const json=await response.json();assert(json.success,'CF_REQUEST_FAILED');return json.result;
}
async function sql(query,params=[]) {
  const rows=await api('/d1/database/'+database+'/query',{sql:query,params});
  assert(rows.every(r=>r.success),'D1_QUERY_FAILED');return rows[0].results || [];
}
async function version(){const data=await api('/workers/scripts/'+worker+'/deployments');const versions=data.deployments[0].versions;assert.equal(versions.length,1);assert.equal(versions[0].percentage,100);return versions[0].version_id;}
async function runtime(){
  const base='/workers/scripts/'+worker;
  const [settings,schedules,subdomain]=await Promise.all(['settings','schedules','subdomain'].map(s=>api(base+'/'+s)));
  const {annotations,assets,main_module,etag,modified_on,created_on,...kept}=settings;
  kept.bindings.sort((a,b)=>a.name.localeCompare(b.name));
  return {settings:kept,schedules,subdomain,fullSettings:settings};
}
async function schema(){return sql("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'tiktok_video_%' AND name NOT LIKE 'idx_tiktok_video_%' ORDER BY type,name");}
async function getCode(){
  const response=await fetch(prefix+'/workers/scripts/'+worker,{headers:{Authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN},signal:AbortSignal.timeout(60000)});assert(response.ok,'WORKER_READ_FAILED');
  const mime=response.headers.get('content-type');
  if(!mime.includes('multipart/'))return [sha(Buffer.from(await response.arrayBuffer()))];
  const form=await response.formData(),hashes=[];
  for(const [name,value] of form){if(name!=='metadata'&&name!=='metadata.json')hashes.push(sha(Buffer.from(typeof value==='string'?value:await value.arrayBuffer())));}
  return hashes;
}
async function publicRead(path){const r=await fetch(root+path,{redirect:'error',headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(60000)});return {status:r.status,bytes:Buffer.from(await r.arrayBuffer())};}
async function github(path,method,body){
  const response=await fetch('https://api.github.com/repos/'+process.env.GITHUB_REPOSITORY+path,{method,headers:{Authorization:'Bearer '+process.env.GH_TOKEN,Accept:'application/vnd.github+json','Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  assert(response.ok,'BACKUP_GITHUB_HTTP_'+response.status);return response.json();
}

if(process.argv[2]==='prepare') {
  assert.equal(await version(),baseline,'UNEXPECTED_PRODUCTION_VERSION');
  const before=await runtime();
  assert(before.fullSettings.bindings.some(b=>b.type==='d1' && b.name==='DB' && (b.id||b.database_id)===database));
  const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
  assert.equal(config.compatibility_date,before.fullSettings.compatibility_date);
  for(const key of ['compatibility_flags','observability','limits','logpush','tail_consumers'])if(before.fullSettings[key]!=null)config[key]=before.fullSettings[key];
  if(before.fullSettings.placement?.mode)config.placement=before.fullSettings.placement;
  delete config.vars;config.workers_dev=before.subdomain.enabled;config.preview_urls=before.subdomain.previews_enabled || false;
  writeFileSync('.release-wrangler.json',JSON.stringify(config));
  const beforeSchema=await schema();
  assert.equal((await sql("SELECT name FROM sqlite_master WHERE name IN ('tiktok_video_links','tiktok_video_batches')")).length,0,'REVIEW_EXISTING_VIDEO_TABLES');
  let exported=await api('/d1/database/'+database+'/export',{output_format:'polling'});
  for(let i=0;i<40 && exported.status!=='complete';i++){
    assert.notEqual(exported.status,'error','D1_EXPORT_FAILED');
    await new Promise(r=>setTimeout(r,1000));
    exported=await api('/d1/database/'+database+'/export',{output_format:'polling',current_bookmark:exported.at_bookmark});
  }
  assert.equal(exported.status,'complete');
  const exportUrl=new URL(exported.result.signed_url);assert.equal(exportUrl.protocol,'https:');
  const response=await fetch(exportUrl,{redirect:'error',signal:AbortSignal.timeout(60000)});assert(response.ok);
  const dump=await response.text();assert(dump.length>0 && dump.length<150*1024*1024);
  const restored=new DatabaseSync(':memory:');restored.exec(dump);
  const check=restored.prepare('PRAGMA integrity_check').get();assert.equal(Object.values(check)[0],'ok');
  const tableCounts={};
  for(const table of restored.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()){
    assert(/^[a-zA-Z0-9_]+$/.test(table.name));const n=restored.prepare('SELECT COUNT(*) n FROM "'+table.name+'"').get().n;
    tableCounts[table.name]=n;
  }
  // Actual full restore into a separate SQLite database, including FKs and original schema.
  assert.equal(restored.prepare('PRAGMA foreign_key_check').all().length,0);
  restored.close();
  const beforeCode=await getCode();
  const privateState={before,beforeSchema,baseline,beforeCode,dump,bookmark:exported.at_bookmark,tableCounts};
  const raw=Buffer.from(JSON.stringify(privateState));
  const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  const ciphertext=Buffer.concat([cipher.update(raw),cipher.final()]),tag=cipher.getAuthTag();
  const roundtrip=createDecipheriv('aes-256-gcm',key,iv);roundtrip.setAuthTag(tag);assert.deepEqual(Buffer.concat([roundtrip.update(ciphertext),roundtrip.final()]),raw);
  const certificate=new X509Certificate(readFileSync('scripts/backup-recipient.crt'));
  const pin=certificate.fingerprint256.replaceAll(':','').toLowerCase();assert.equal(pin,'14e1d564276b56dfbc95888ce8108aafbdaf4da938f7d5b1ed0fb593f274ca3f');
  const envelope=JSON.stringify({schema:1,algorithm:'RSA-OAEP-SHA256+AES-256-GCM',certificateSha256:pin,encryptedKey:publicEncrypt({key:certificate.publicKey,oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:tag.toString('base64'),ciphertext:ciphertext.toString('base64')});key.fill(0);
  const branch='backup/tiktok-videos-'+process.env.GITHUB_RUN_ID;
  await github('/git/refs','POST',{ref:'refs/heads/'+branch,sha:process.env.GITHUB_SHA});
  const saved=await github('/contents/backups/tiktok-videos/pre-release.enc.json','PUT',{branch,message:'Encrypted pre-release database backup [skip ci]',content:Buffer.from(envelope).toString('base64')});
  assert(saved.content?.sha && saved.commit?.sha,'BACKUP_COMMIT_MISSING');
  writeFileSync(statePath,JSON.stringify(privateState),{mode:0o600});
  proof({source_sha:process.env.GITHUB_SHA,stage:'backup_restored_and_saved',base_version:baseline,backup_branch:branch,backup_commit:saved.commit.sha,backup_sha256:sha(envelope),restore_integrity:true,foreign_key_check:true,table_counts:tableCounts,bookmark:exported.at_bookmark,real_device_test:'pending'});
  console.log('Full D1 export restored with integrity/FK checks; encrypted backup committed. No production mutation yet.');
} else if(process.argv[2]==='add-tables') {
  const state=JSON.parse(readFileSync(statePath));assert.equal(await version(),baseline);
  const current=await runtime();assert.equal(canonical(current),canonical(state.before));
  assert.equal(canonical(await schema()),canonical(state.beforeSchema));
  assert.deepEqual(await getCode(),state.beforeCode);
  const migration=readFileSync('migrations/0012_tiktok_videos.sql','utf8');
  assert(!/\b(?:DROP|ALTER|DELETE|UPDATE|INSERT|REPLACE)\b/i.test(migration));
  assert.equal(migration.split(';').filter(s=>s.trim()).length,4);
  await sql(migration);
  assert.deepEqual(await schema(),state.beforeSchema);
  for(const table of fixedTables)assert.equal((await sql('SELECT COUNT(*) n FROM '+table))[0].n,0);
  const report=JSON.parse(readFileSync(proofPath));proof({...report,stage:'additive_tables_ready',existing_schema_unchanged:true});
  console.log('Two isolated video tables and indexes added; existing schema retained.');
} else if(process.argv[2]==='verify') {
  const state=JSON.parse(readFileSync(statePath)),after=await runtime();
  for(const key of ['settings','schedules','subdomain'])assert.equal(canonical(after[key]),canonical(state.before[key]),'RUNTIME_CHANGED_'+key);
  assert.deepEqual(await schema(),state.beforeSchema);
  assert.notEqual(await version(),baseline);
  assert.deepEqual(await getCode(),[sha(readFileSync('release-bundle/index.js'))]);
  const files=['index.html','app.js','styles.css','sw.js','winning-view.js','tiktok-video.js','tiktok-videos-ui.js','share.js','provisional-ui.js','device-login.js','network-read.js','manifest.json'];
  for(const name of files){const r=await publicRead('/'+name+'?release='+process.env.GITHUB_SHA);assert.equal(r.status,200);assert.equal(sha(r.bytes),sha(readFileSync('public/'+name)));}
  for(const path of ['/api/cards','/api/winning-lists','/api/tiktok-videos/export-batches/pending'])assert.equal((await publicRead(path)).status,401);
  const auth=await publicRead('/api/auth/status'),status=JSON.parse(auth.bytes);assert.equal(auth.status,200);assert.equal(status.authenticated,false);assert.equal(status.deviceOnlyMode,true);assert.equal(status.mode,'production');
  // Recover already received, unassigned videos only. Keep the original value and received_at.
  const rows=await sql(`SELECT i.id,i.value FROM items i WHERE i.value LIKE 'https://lite.tiktok.com/t/%'
    AND i.status IN ('received','queued','unresolved','pending_confirmation','active')
    AND NOT EXISTS(SELECT 1 FROM item_campaign_assignments a WHERE a.item_id=i.id)`);
  const ids=rows.filter(r=>isTikTokLongVideo(r.value)).map(r=>r.id);let recovered=0;
  for(let start=0;start<ids.length;start+=60){
    const group=ids.slice(start,start+60);assert(group.every(id=>/^[0-9a-f-]{36}$/i.test(id)));
    const list=group.map(id=>"'"+id+"'").join(',');
    await sql(`INSERT OR IGNORE INTO tiktok_video_links(item_id) SELECT id FROM items WHERE id IN (${list})
      AND status IN ('received','queued','unresolved','pending_confirmation','active')
      AND NOT EXISTS(SELECT 1 FROM item_campaign_assignments a WHERE a.item_id=items.id);
      UPDATE items SET status='active',card_id=NULL,pending_id=NULL,classified_at=COALESCE(classified_at,CURRENT_TIMESTAMP)
      WHERE id IN (${list}) AND EXISTS(SELECT 1 FROM tiktok_video_links v WHERE v.item_id=items.id);
      DELETE FROM unresolved_items WHERE item_id IN (${list}) AND EXISTS(SELECT 1 FROM tiktok_video_links v WHERE v.item_id=unresolved_items.item_id);`);
    recovered+=group.length;
  }
  const counts=(await sql("SELECT COUNT(*) total,SUM(exported_at IS NULL) unexported FROM tiktok_video_links"))[0];
  const report=JSON.parse(readFileSync(proofPath));proof({...report,stage:'published_verified',version:await version(),runtime_unchanged:true,existing_schema_unchanged:true,worker_and_assets_match:true,anonymous_guards:true,existing_video_candidates:ids.length,recovered,video_counts:counts,real_device_test:'pending'});
  console.log('Published bytes, authentication and runtime verified; received video URLs classified.');
} else throw Error('INVALID_RELEASE_ACTION');
