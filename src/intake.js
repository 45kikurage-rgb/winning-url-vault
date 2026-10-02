import {classifyValue,extractInputValues} from './core.js';
import {digest,IntakeError} from './sending-auth.js';
const MAX_BYTES=512*1024;
const stamp=()=>new Date().toISOString();
const incomplete=()=>new IntakeError('INTAKE_INCOMPLETE',503,'受付を完了できませんでした。同じ受付IDで再送してください');

export async function readIntake(request, requireId=false) {
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')) throw new IntakeError('INVALID_REQUEST',400,'JSON形式で送信してください');
  const reader=request.body?.getReader();
  if(!reader) throw new IntakeError('INVALID_REQUEST',400,'入力がありません');
  const chunks=[];let size=0;
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>MAX_BYTES){await reader.cancel();throw new IntakeError('PAYLOAD_TOO_LARGE',413,'送信内容が512KBを超えています');}chunks.push(value);}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new IntakeError('INVALID_REQUEST',400,'JSONが不正です');}
  if(!body||Array.isArray(body)||typeof body!=='object'||
    (body.values!==undefined&&(!Array.isArray(body.values)||body.values.some(x=>typeof x!=='string')))||
    (body.text!==undefined&&typeof body.text!=='string')) throw new IntakeError('INVALID_REQUEST',400,'入力形式が不正です');
  if((requireId||body.clientRequestId!==undefined)&& (typeof body.clientRequestId!=='string'||! /^[0-9a-f-]{16,64}$/i.test(body.clientRequestId))) throw new IntakeError('INVALID_REQUEST',400,'受付IDが不正です');
  // Preserve exact strings for retries. Product extraction happens only after this envelope is retained.
  const raw={values:body.values||[],text:body.text||''};
  if(raw.values.length>=5000) throw new IntakeError('PAYLOAD_TOO_LARGE',413,'1回の上限は4,999件です');
  const values=extractInputValues({text:[...raw.values,raw.text].join('\n')},5000);
  if(values.length>=5000) throw new IntakeError('PAYLOAD_TOO_LARGE',413,'1回の上限は4,999件です');
  if(!values.length) throw new IntakeError('INVALID_REQUEST',400,'URL・コード・テキストを入力してください');
  return {raw,values,clientRequestId:body.clientRequestId||crypto.randomUUID()};
}

export async function beginIntake(env, input, ownerKey) {
  const rawJson=JSON.stringify(input.raw),payloadHash=await digest(rawJson);
  let receipt=await env.DB.prepare('SELECT * FROM intake_receipts WHERE owner_key=? AND client_request_id=?').bind(ownerKey,input.clientRequestId).first();
  if(receipt){if(receipt.payload_hash!==payloadHash)throw new IntakeError('REQUEST_ID_CONFLICT',409,'同じ受付IDに異なる内容が送信されました');return {receipt,resumed:true};}
  // Legacy receipts have no original envelope: never claim a partially saved legacy job is complete.
  if(ownerKey==='admin'){
    const legacy=await env.DB.prepare('SELECT id FROM analysis_jobs WHERE client_request_id=?').bind(input.clientRequestId).first();
    if(legacy)throw incomplete();
  }
  const identity=await digest(JSON.stringify([ownerKey,input.clientRequestId]));
  const jobId=`${identity.slice(0,8)}-${identity.slice(8,12)}-${identity.slice(12,16)}-${identity.slice(16,20)}-${identity.slice(20,32)}`;
  const seen=new Set(),plan=[];let duplicates=0;
  for(const raw of input.values){const value=classifyValue(raw,env.COKEON_REDEEM_BASE_URL);
    if(!value)continue;if(seen.has(value.canonicalValue)){duplicates++;continue;}seen.add(value.canonicalValue);
    plan.push({...value,id:crypto.randomUUID()});}
  const createdAt=stamp();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO analysis_jobs(id,client_request_id,input_total,input_duplicates,status,updated_at)
      VALUES (?,?,?,?,'receiving',?)`).bind(jobId,`intake:${identity}`,input.values.length,duplicates,createdAt),
    env.DB.prepare(`INSERT OR IGNORE INTO intake_receipts(job_id,owner_key,client_request_id,payload_hash,raw_json,plan_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).bind(jobId,ownerKey,input.clientRequestId,payloadHash,rawJson,JSON.stringify(plan),createdAt)
  ]);
  receipt=await env.DB.prepare('SELECT * FROM intake_receipts WHERE owner_key=? AND client_request_id=?').bind(ownerKey,input.clientRequestId).first();
  if(!receipt)throw incomplete();
  if(receipt.payload_hash!==payloadHash)throw new IntakeError('REQUEST_ID_CONFLICT',409,'同じ受付IDに異なる内容が送信されました');
  // The persisted plan is authoritative even when concurrent requests generated different candidate IDs.
  return {receipt,resumed:receipt.created_at!==createdAt||receipt.plan_json!==JSON.stringify(plan)};
}

export async function materializeIntake(env, receipt) {
  if(receipt.status==='stored') return receipt;
  const plan=JSON.parse(receipt.plan_json),jobId=receipt.job_id;
  for(let start=receipt.cursor;start<plan.length;start+=40){
    const chunk=plan.slice(start,start+40),statements=[];
    for(const [offset,item] of chunk.entries()){
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO items(id,value,canonical_value,value_type,status)
        SELECT ?,?,?,?,'queued' WHERE EXISTS(SELECT 1 FROM intake_receipts WHERE job_id=? AND status='receiving')`)
        .bind(item.id,item.storedValue,item.canonicalValue,item.type,jobId));
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO analysis_job_items(job_id,item_id,ordinal,state,updated_at)
        SELECT ?,id,?,'queued',? FROM items WHERE id=?
        AND EXISTS(SELECT 1 FROM intake_receipts WHERE job_id=? AND status='receiving')`)
        .bind(jobId,start+offset,stamp(),item.id,jobId));
    }
    statements.push(env.DB.prepare(`UPDATE intake_receipts SET cursor=MAX(cursor,?) WHERE job_id=? AND status='receiving'`).bind(start+chunk.length,jobId));
    // Every item and its analysis relation commit together. Cursor advances only with this batch.
    await env.DB.batch(statements);
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE analysis_jobs SET accepted_count=(SELECT COUNT(*) FROM analysis_job_items WHERE job_id=?),
      existing_count=?-(SELECT COUNT(*) FROM analysis_job_items WHERE job_id=?),
      status=CASE WHEN EXISTS(SELECT 1 FROM analysis_job_items WHERE job_id=?) THEN 'queued' ELSE 'completed' END,
      completed_at=CASE WHEN EXISTS(SELECT 1 FROM analysis_job_items WHERE job_id=?) THEN NULL ELSE ? END,updated_at=?
      WHERE id=? AND status='receiving' AND EXISTS(SELECT 1 FROM intake_receipts WHERE job_id=? AND cursor=?)`)
      .bind(jobId,plan.length,jobId,jobId,jobId,stamp(),stamp(),jobId,jobId,plan.length),
    env.DB.prepare(`UPDATE intake_receipts SET status='stored' WHERE job_id=? AND cursor=?
      AND EXISTS(SELECT 1 FROM analysis_jobs WHERE id=? AND status!='receiving')`).bind(jobId,plan.length,jobId)
  ]);
  const saved=await env.DB.prepare('SELECT * FROM intake_receipts WHERE job_id=?').bind(jobId).first();
  if(saved?.status!=='stored')throw incomplete();
  return saved;
}

export async function dispatchIntake(env,receipt,processFully) {
  if(receipt.dispatched||receipt.status!=='stored')return;
  const planLength=JSON.parse(receipt.plan_json).length;
  if(env.ANALYSIS_QUEUE?.send){
    // Ordinals refer to the original plan and can have gaps where another intake owned a duplicate.
    const rows=await env.DB.prepare(`SELECT DISTINCT CAST(ordinal/40 AS INTEGER) batch_no FROM analysis_job_items WHERE job_id=? AND state!='done'`).bind(receipt.job_id).all();
    const messages=(rows.results||[]).map(row=>({body:{type:'analyze',jobId:receipt.job_id,batchNo:row.batch_no}}));
    if(env.ANALYSIS_QUEUE.sendBatch){for(let i=0;i<messages.length;i+=100)await env.ANALYSIS_QUEUE.sendBatch(messages.slice(i,i+100));}
    else for(const message of messages)await env.ANALYSIS_QUEUE.send(message.body);
  }else await processFully(env,receipt.job_id,planLength);
  await env.DB.prepare('UPDATE intake_receipts SET dispatched=1 WHERE job_id=?').bind(receipt.job_id).run();
}

export async function recoverIntakes(env,processFully) {
  const rows=await env.DB.prepare('SELECT * FROM intake_receipts WHERE dispatched=0 ORDER BY created_at LIMIT 10').all();
  for(const receipt of rows.results||[]){try{await dispatchIntake(env,await materializeIntake(env,receipt),processFully);}catch{console.error('Intake recovery deferred',receipt.job_id);}}
}
