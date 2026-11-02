import { VaultLedgerError, assignSingleWinToCampaign } from './ledger.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const issue = (message, code, status=409) => new VaultLedgerError(message,status,code);
const eligible = `i.card_id=? AND i.intake_source=? AND i.status='active'
  AND NOT EXISTS(SELECT 1 FROM item_campaign_assignments a WHERE a.item_id=i.id)
  AND NOT EXISTS(SELECT 1 FROM tiktok_video_links v WHERE v.item_id=i.id)`;
const cleanIds = ids => Array.isArray(ids) && ids.length > 0 && ids.length <= 5000 && ids.every(id=>typeof id==='string'&&UUID.test(id))
  ? [...new Set(ids.map(id=>id.toLowerCase()))].sort() : null;
const dateOf = value => {
  const text = String(value || '').replace(' ','T');
  const time = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : text+'Z');
  if (!Number.isFinite(time)) throw issue('登録日を確認できません。','SINGLE_WIN_DATE_INVALID');
  return new Date(time+9*60*60*1000).toISOString().slice(0,10);
};
const snapshotKey = (cardId,source,ids,token) => sha(JSON.stringify([cardId,source,ids,token]));
const previewToken = (cardId,source,ids,model) => sha(JSON.stringify([cardId,source,ids,model]));
// Match the existing Ledger projection boundary before issuing a campaign ID.
// Keep the source values intact: invalid product information must be corrected
// by the user, never silently truncated or stripped in the authoritative store.
const forbiddenText = /[\x00-\x1f\x7f]|(?:https?:|www\.|data:|javascript:|ftp:)/i;
const validProjectionText = (value,nullable=false) => nullable && value===null ||
  typeof value==='string' && Boolean(value.trim()) && value.length<=200 && !forbiddenText.test(value);
const validProjectionDate = value => value===null || typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
function productProjectionIssue(model) {
  for (const [name,value,nullable] of [['商品名',model.raw_name,false],['交換場所',model.redeem_place||null,true],['規格',model.specification||null,true]]) {
    if (validProjectionText(value,nullable)) continue;
    if (typeof value==='string' && value.length>200) return `${name}が200文字を超えています。`;
    if (typeof value==='string' && forbiddenText.test(value)) return `${name}にURLまたは使用できない文字が含まれています。`;
    return `${name}が空欄または無効な形式です。`;
  }
  return validProjectionDate(model.expires_on||null) ? null : '有効期限が実在する日付ではありません。';
}
function campaignLabel(model) {
  const display = model.display_name;
  return (typeof display==='string' && display.trim() && !forbiddenText.test(display) ? display : model.raw_name).trim().slice(0,512);
}

async function modelFor(env,cardId,source) {
  const row = await env.DB.prepare(`SELECT c.id card_id,c.product_id master_id,c.intake_source,c.expires_on,
    p.raw_name,p.normalized_name,p.display_name,p.redeem_place,p.specification
    FROM cards c JOIN product_master p ON p.id=c.product_id WHERE c.id=? AND c.intake_source=?`).bind(cardId,source).first();
  if (!row) throw issue('対象の仕分けカードが見つかりません。','CARD_NOT_FOUND',404);
  return row;
}
async function selectedItems(env,cardId,source,ids=null) {
  const query = `SELECT i.id,i.received_at FROM items i WHERE ${eligible}` +
    (ids ? ` AND i.id IN (SELECT value FROM json_each(?))` : '') + ' ORDER BY i.id LIMIT 5001';
  const result = await env.DB.prepare(query).bind(cardId,source,...(ids?[JSON.stringify(ids)]:[])).all();
  return result.results || [];
}

export async function singleWinPreview(env,cardId,source) {
  const model = await modelFor(env,cardId,source), rows = await selectedItems(env,cardId,source);
  if (rows.length>5000) throw issue('一度に登録できるのは5,000件までです。','SINGLE_WIN_TOO_LARGE',400);
  const ids = rows.map(row=>row.id).sort();
  return {ok:true,card_id:cardId,intake_source:source,ids,count:ids.length,product_name:model.raw_name,
    display_name:model.display_name,redemption_place:model.redeem_place,product_spec:model.specification,
    valid_until:model.expires_on,registration_date:rows.length?rows.map(row=>dateOf(row.received_at)).sort()[0]:null,
    preview_token:ids.length?await previewToken(cardId,source,ids,model):null};
}

function receipt(row) {
  return {ok:true,request_id:row.request_id,card_id:row.card_id,intake_source:row.intake_source,
    state:row.completed_at?'completed':row.invalidated_at?'needs_review':'pending',campaign_id:row.campaign_id,product_id:row.completed_at?row.product_id:null,
    assigned_count:Number(row.assigned_count),registration_date:row.registration_date,completed_at:row.completed_at};
}
export async function singleWinStatus(env,requestId) {
  if (!UUID.test(requestId || '')) throw issue('受付IDが不正です。','INVALID_SINGLE_WIN_REQUEST',400);
  const row = await env.DB.prepare('SELECT * FROM vault_single_wins WHERE request_id=?').bind(requestId.toLowerCase()).first();
  if (!row) throw issue('この受付IDの登録結果はまだありません。','SINGLE_WIN_NOT_FOUND',404);
  return receipt(row);
}

export async function singleWinAvailability(env) {
  const contract = 'vault-single-win-v1';
  const local = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vault_single_wins'").first();
  if (!local || !env.ALIGN_SINGLE_WIN?.availability) return {ok:true,contract,ready:false};
  try {
    const remote = await env.ALIGN_SINGLE_WIN.availability();
    return {ok:true,contract,ready:remote?.ok===true && remote?.ready===true && remote?.contract===contract};
  } catch { return {ok:true,contract,ready:false}; }
}

async function findOperation(env,requestId,key,token) {
  const row = await env.DB.prepare(`SELECT * FROM vault_single_wins WHERE request_id=? OR (snapshot_key=? AND invalidated_at IS NULL)
    ORDER BY CASE WHEN request_id=? THEN 0 ELSE 1 END LIMIT 1`).bind(requestId,key,requestId).first();
  if (row && (row.snapshot_key!==key || row.preview_token!==token))
    throw issue('同じ受付IDに異なる内容が指定されています。','SINGLE_WIN_REQUEST_CONFLICT');
  return row;
}

async function needsReview(env,operation,message='商品や登録対象が更新されています。対象を再確認してください。',code='SINGLE_WIN_PREVIEW_CHANGED') {
  if (operation) {
    await env.DB.prepare('UPDATE vault_single_wins SET invalidated_at=COALESCE(invalidated_at,?) WHERE request_id=? AND completed_at IS NULL')
      .bind(new Date().toISOString(),operation.request_id).run();
    const current = await singleWinStatus(env,operation.request_id);
    if (current.state==='completed') return current;
  }
  throw issue(message,code);
}

export async function registerSingleWin(env,cardId,source,body) {
  const ids = cleanIds(body?.ids), requestId = body?.request_id?.toLowerCase?.();
  if (!['arunomatic','chiritumo'].includes(source) || !UUID.test(cardId || '') || !UUID.test(requestId || '') ||
      !ids || ids.length!==body.ids.length || typeof body.preview_token!=='string' || !/^[a-f0-9]{64}$/.test(body.preview_token) ||
      body.confirmation!=='単発当選として登録')
    throw issue('登録対象を確認してから単発当選を登録してください。','INVALID_SINGLE_WIN_REQUEST',400);
  const key = await snapshotKey(cardId,source,ids,body.preview_token);
  let operation = await findOperation(env,requestId,key,body.preview_token);
  if (operation?.completed_at) return receipt(operation);
  if (operation?.invalidated_at) throw issue('登録対象を再確認してください。','SINGLE_WIN_PREVIEW_CHANGED');
  let model;
  try { model = await modelFor(env,cardId,source); }
  catch (error) { if (operation && error.code==='CARD_NOT_FOUND') return needsReview(env,operation); throw error; }
  const selected = await selectedItems(env,cardId,source,ids);
  if (selected.length!==ids.length || await previewToken(cardId,source,ids,model)!==body.preview_token)
    return needsReview(env,operation);
  const productIssue = productProjectionIssue(model);
  if (productIssue) {
    const message = `このカードは現在の商品情報では単発登録できません。理由: ${productIssue}`;
    if (operation) return needsReview(env,operation,message,'SINGLE_WIN_PRODUCT_INVALID');
    throw issue(message,'SINGLE_WIN_PRODUCT_INVALID',400);
  }
  if (!operation) {
    const registered = selected.map(row=>dateOf(row.received_at)).sort()[0];
    await env.DB.prepare(`INSERT OR IGNORE INTO vault_single_wins
      (request_id,snapshot_key,preview_token,card_id,intake_source,item_ids_json,product_json,registration_date,product_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(requestId,key,body.preview_token,cardId,source,JSON.stringify(ids),JSON.stringify(model),registered,
      crypto.randomUUID(),new Date().toISOString()).run();
    operation = await findOperation(env,requestId,key,body.preview_token);
    if (!operation) throw issue('受付を保存できませんでした。同じ受付IDで再送してください。','SINGLE_WIN_STORAGE_INCOMPLETE',503);
    if (operation.completed_at) return receipt(operation);
    if (operation.invalidated_at) throw issue('登録対象を再確認してください。','SINGLE_WIN_PREVIEW_CHANGED');
  }
  if (!env.ALIGN_SINGLE_WIN?.createSingleWin) throw issue('単発当選の登録先に接続できません。同じ受付IDで再送できます。','SINGLE_WIN_BINDING_UNAVAILABLE',503);
  let result;
  try {
    result = await env.ALIGN_SINGLE_WIN.createSingleWin({request_id:operation.request_id,
      product_label:campaignLabel(model),
      registration_date:operation.registration_date});
  } catch {
    throw issue('登録結果をまだ確認できません。同じ受付IDで再送してください。','SINGLE_WIN_REMOTE_UNAVAILABLE',503);
  }
  if (result?.ok!==true || result.stored!==true || result.request_id!==operation.request_id) {
    if (result?.error?.code==='SINGLE_WIN_REQUEST_CONFLICT') throw issue('受付内容の照合に失敗しました。','SINGLE_WIN_REQUEST_CONFLICT');
    throw issue('キャンペーンの保存を確認できません。同じ受付IDで再送してください。','SINGLE_WIN_REMOTE_UNAVAILABLE',503);
  }
  const campaign = result.campaign;
  if (!campaign || !UUID.test(campaign.campaign_id||'') || typeof campaign.campaign_name!=='string' || !campaign.campaign_name.trim() ||
      campaign.lottery_start_date!==operation.registration_date || campaign.layout_enabled!==false || campaign.is_archived!==false ||
      !['active','closing'].includes(campaign.status))
    return needsReview(env,operation,'登録先の状態が変更されています。登録先を確認してください。','SINGLE_WIN_CAMPAIGN_CHANGED');
  if (operation.campaign_id && operation.campaign_id!==campaign.campaign_id)
    throw issue('登録先IDが一致しません。','SINGLE_WIN_REQUEST_CONFLICT');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO vault_campaigns(campaign_id,campaign_name,lottery_start_date,status,is_archived,last_refreshed_at)
      VALUES (?,?,?,?,0,?) ON CONFLICT(campaign_id) DO NOTHING`)
      .bind(campaign.campaign_id,campaign.campaign_name,campaign.lottery_start_date,campaign.status,new Date().toISOString()),
    env.DB.prepare('UPDATE vault_single_wins SET campaign_id=? WHERE request_id=? AND (campaign_id IS NULL OR campaign_id=?)')
      .bind(campaign.campaign_id,operation.request_id,campaign.campaign_id)
  ]);
  operation = await env.DB.prepare('SELECT * FROM vault_single_wins WHERE request_id=?').bind(operation.request_id).first();
  try { await assignSingleWinToCampaign(env,operation); }
  catch (error) { if (error.code==='SINGLE_WIN_PREVIEW_CHANGED') return needsReview(env,operation); throw error; }
  return singleWinStatus(env,operation.request_id);
}
