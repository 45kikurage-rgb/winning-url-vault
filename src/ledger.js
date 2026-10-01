const SOURCE_SYSTEM = "winning-url-vault";
const LEDGER_ORIGIN = "https://aruno-consolidated-ledger.internal";
const RETRY_SECONDS = [60, 120, 300, 900, 3600];
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const validId = value => /^[A-Za-z0-9_-]{1,128}$/.test(String(value || ""));
const responseJson = (data, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

export function canAssignCampaign(campaign) {
  return Boolean(campaign && !campaign.is_archived && ["active", "closing", "correcting"].includes(campaign.status));
}
export function campaignLabel(campaign) {
  const date = campaign?.lottery_start_date || "開始日未設定";
  return `${campaign?.campaign_name || ""} ${date}`.trim();
}
function ledgerError(payload, status, fallback = "中央管理台帳との通信に失敗しました") {
  const code = payload?.error?.code || payload?.error || "LEDGER_UNAVAILABLE";
  const error = new Error(`${fallback}: ${code}`);
  error.status = status || 502;
  error.code = String(code);
  error.retryable = Boolean(payload?.error?.retryable) || status >= 500;
  error.details = payload?.error?.details || {};
  return error;
}
async function bindingJson(binding, path, options = {}) {
  if (!binding?.fetch) throw ledgerError(null, 503, "中央管理台帳Service Bindingが未設定です");
  const request = new Request(new URL(path, LEDGER_ORIGIN), options);
  let response;
  try { response = await binding.fetch(request); }
  catch (cause) { const e = ledgerError(null, 503); e.cause = cause; throw e; }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) throw ledgerError(payload, response.status);
  return payload;
}
const reader = (env, path) => bindingJson(env.LEDGER_READER, path, { method: "GET" });
const vault = (env, path, payload) => bindingJson(env.LEDGER_VAULT, path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
});

export async function fetchCampaigns(env) {
  const items = [];
  let after = "";
  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({ limit: "100", include_archived: "false" });
    if (after) query.set("after", after);
    const result = await reader(env, `/api/v1/campaigns?${query}`);
    items.push(...(Array.isArray(result.items) ? result.items : []));
    if (!result.next_cursor) break;
    after = result.next_cursor;
  }
  return items.map(campaign => ({ ...campaign, display_label: campaignLabel(campaign), assignable: canAssignCampaign(campaign) }));
}
async function campaignDetails(env, campaignId) {
  if (!validId(campaignId)) throw Object.assign(new Error("campaign_idが不正です"), { status: 400 });
  return reader(env, `/api/v1/campaigns/${encodeURIComponent(campaignId)}`);
}
async function syncState(env, campaignId) {
  return env.DB.prepare(`SELECT campaign_id,totals_revision,lifecycle_revision,outbox_sequence
    FROM vault_campaign_sync_state WHERE campaign_id=?`).bind(campaignId).first();
}
async function cardModel(env, cardId) {
  return env.DB.prepare(`SELECT c.id AS card_id,c.expires_on,p.raw_name,p.display_name,p.redeem_place,p.specification
    FROM cards c JOIN product_master p ON p.id=c.product_id WHERE c.id=?`).bind(cardId).first();
}
async function unassignedItems(env, cardId) {
  const rows = await env.DB.prepare(`SELECT i.id FROM items i LEFT JOIN campaign_product_items x ON x.item_id=i.id
    WHERE i.card_id=? AND i.status='active' AND x.item_id IS NULL ORDER BY i.received_at,i.id`).bind(cardId).all();
  return rows.results || [];
}
async function assignedProductCount(env, productId) {
  const row = await env.DB.prepare("SELECT COUNT(*) count FROM campaign_product_items WHERE product_id=?").bind(productId).first();
  return Number(row?.count || 0);
}
async function campaignAssignedCount(env, campaignId) {
  const row = await env.DB.prepare(`SELECT COUNT(*) count FROM campaign_product_items x
    JOIN campaign_products cp ON cp.product_id=x.product_id WHERE cp.campaign_id=?`).bind(campaignId).first();
  return Number(row?.count || 0);
}
export async function listSortingCards(env) {
  const cards = (await env.DB.prepare(`SELECT c.id AS card_id,c.expires_on,p.display_name,p.raw_name,p.redeem_place,p.specification,
    COUNT(i.id) AS total_count,COALESCE(SUM(CASE WHEN x.item_id IS NULL THEN 1 ELSE 0 END),0) AS unassigned_count
    FROM cards c JOIN product_master p ON p.id=c.product_id
    LEFT JOIN items i ON i.card_id=c.id AND i.status='active'
    LEFT JOIN campaign_product_items x ON x.item_id=i.id
    GROUP BY c.id HAVING COUNT(i.id)>0
    ORDER BY CASE WHEN c.expires_on='' THEN 1 ELSE 0 END,c.expires_on,c.created_at DESC`).all()).results || [];
  const assignments = (await env.DB.prepare(`SELECT cp.card_id,cp.product_id,cp.campaign_id,cp.assigned_at,cp.is_archived,
    COUNT(x.item_id) AS winner_count FROM campaign_products cp
    LEFT JOIN campaign_product_items x ON x.product_id=cp.product_id
    GROUP BY cp.product_id ORDER BY cp.assigned_at,cp.product_id`).all()).results || [];
  const byCard = new Map();
  for (const a of assignments) {
    if (!byCard.has(a.card_id)) byCard.set(a.card_id, []);
    byCard.get(a.card_id).push({ product_id:a.product_id,campaign_id:a.campaign_id,assigned_at:a.assigned_at,
      is_archived:Boolean(a.is_archived),winner_count:Number(a.winner_count || 0) });
  }
  return cards.map(card => ({ ...card,total_count:Number(card.total_count || 0),unassigned_count:Number(card.unassigned_count || 0),assignments:byCard.get(card.card_id) || [] }));
}

export function buildProductEnvelope({ productId, campaignId, model, count, assignedAt, revision, occurredAt }) {
  return { source_system:SOURCE_SYSTEM, source_record_id:`product:${productId}`, source_revision:revision, occurred_at:occurredAt,
    data:{ product_id:productId,campaign_id:campaignId,product_name:model.raw_name,
      redemption_place:model.redeem_place || null,product_spec:model.specification || null,valid_until:model.expires_on || null,
      current_winner_count:count,assigned_at:assignedAt,is_archived:false } };
}
export function buildTotalsEnvelope({ campaignId, count, revision, occurredAt }) {
  return { source_system:SOURCE_SYSTEM,source_record_id:`totals:${campaignId}`,source_revision:revision,occurred_at:occurredAt,
    data:{ campaign_id:campaignId,current_winner_count:count } };
}
function outboxInsert(env, { id, campaignId, sequence, path, envelope, occurredAt }) {
  return env.DB.prepare(`INSERT INTO ledger_outbox
    (id,campaign_id,campaign_sequence,path,source_record_id,source_revision,payload_json,status,attempts,available_at,created_at)
    VALUES (?,?,?,?,?,?,?,'pending',0,?,?)`).bind(id,campaignId,sequence,path,envelope.source_record_id,envelope.source_revision,
      JSON.stringify(envelope),occurredAt,occurredAt);
}

export async function assignCardToCampaign(env, cardId, campaignId) {
  if (!validId(cardId) || !validId(campaignId)) throw Object.assign(new Error("IDが不正です"), { status:400 });
  const [campaign, model, items] = await Promise.all([campaignDetails(env,campaignId),cardModel(env,cardId),unassignedItems(env,cardId)]);
  if (!model) throw Object.assign(new Error("商品カードが見つかりません"), { status:404 });
  if (!canAssignCampaign(campaign)) throw Object.assign(new Error(campaign?.status === "closed" ? "終了済みキャンペーンへ新規仕分けできません" : "このキャンペーンへは仕分けできません"), { status:409 });
  const existing = await env.DB.prepare(`SELECT product_id,assigned_at,source_revision FROM campaign_products
    WHERE campaign_id=? AND card_id=?`).bind(campaignId,cardId).first();
  if (!items.length) return { assigned:0,product_id:existing?.product_id || null,campaign_id:campaignId,no_change:true };

  const productId = existing?.product_id || uuid();
  const assignedAt = existing?.assigned_at || now();
  const occurredAt = now();
  const productRevision = Number(existing?.source_revision || 0) + 1;
  const state = await syncState(env,campaignId);
  const totalsRevision = Number(state?.totals_revision || 0) + 1;
  const sequenceBase = Number(state?.outbox_sequence || 0);
  const productCount = await assignedProductCount(env,productId) + items.length;
  const totalCount = await campaignAssignedCount(env,campaignId) + items.length;
  const productEnvelope = buildProductEnvelope({ productId,campaignId,model,count:productCount,assignedAt,revision:productRevision,occurredAt });
  const totalsEnvelope = buildTotalsEnvelope({ campaignId,count:totalCount,revision:totalsRevision,occurredAt });
  const statements = [
    env.DB.prepare(`INSERT INTO vault_campaign_sync_state(campaign_id,totals_revision,lifecycle_revision,outbox_sequence,updated_at)
      VALUES (?,?,0,?,?) ON CONFLICT(campaign_id) DO UPDATE SET totals_revision=excluded.totals_revision,
      outbox_sequence=excluded.outbox_sequence,updated_at=excluded.updated_at`).bind(campaignId,totalsRevision,sequenceBase+2,occurredAt)
  ];
  if (existing) statements.push(env.DB.prepare("UPDATE campaign_products SET source_revision=?,updated_at=? WHERE product_id=?")
    .bind(productRevision,occurredAt,productId));
  else statements.push(env.DB.prepare(`INSERT INTO campaign_products
    (product_id,campaign_id,card_id,assigned_at,is_archived,source_revision,created_at,updated_at) VALUES (?,?,?,?,0,?,?,?)`)
    .bind(productId,campaignId,cardId,assignedAt,productRevision,occurredAt,occurredAt));
  for (const item of items) statements.push(env.DB.prepare(`INSERT INTO campaign_product_items(item_id,product_id,assigned_at)
    VALUES (?,?,?)`).bind(item.id,productId,occurredAt));
  statements.push(
    outboxInsert(env,{id:uuid(),campaignId,sequence:sequenceBase+1,path:"/api/v1/products/sync",envelope:productEnvelope,occurredAt}),
    outboxInsert(env,{id:uuid(),campaignId,sequence:sequenceBase+2,path:"/api/v1/totals/sync",envelope:totalsEnvelope,occurredAt})
  );
  await env.DB.batch(statements);
  await processOutbox(env,10).catch(error => console.warn("ledger outbox",error));
  return { assigned:items.length,product_id:productId,campaign_id:campaignId,product_revision:productRevision,totals_revision:totalsRevision,sync:await outboxSummary(env) };
}

async function outboxSummary(env) {
  const row = await env.DB.prepare(`SELECT
    COALESCE(SUM(CASE WHEN status IN ('pending','retry') THEN 1 ELSE 0 END),0) pending,
    COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) failed FROM ledger_outbox`).first();
  return { pending:Number(row?.pending || 0),failed:Number(row?.failed || 0) };
}
async function nextOutboxRows(env, limit) {
  const rows = await env.DB.prepare(`SELECT o.* FROM ledger_outbox o
    WHERE o.status IN ('pending','retry') AND o.available_at<=?
      AND NOT EXISTS (SELECT 1 FROM ledger_outbox prior WHERE prior.campaign_id=o.campaign_id
        AND prior.campaign_sequence<o.campaign_sequence AND prior.status!='sent')
    ORDER BY o.created_at,o.campaign_sequence LIMIT ?`).bind(now(),limit).all();
  return rows.results || [];
}
async function markRetry(env,row,error) {
  const attempts = Number(row.attempts || 0) + 1;
  const canRetry = Boolean(error.retryable) && attempts <= RETRY_SECONDS.length;
  const status = canRetry ? "retry" : "failed";
  const delay = canRetry ? RETRY_SECONDS[Math.min(attempts-1,RETRY_SECONDS.length-1)] : 0;
  const availableAt = new Date(Date.now()+delay*1000).toISOString();
  await env.DB.prepare(`UPDATE ledger_outbox SET status=?,attempts=?,available_at=?,last_error=? WHERE id=?`)
    .bind(status,attempts,availableAt,String(error.code || error.message || "LEDGER_ERROR").slice(0,500),row.id).run();
}
async function deliverOutbox(env,row) {
  let envelope;
  try { envelope = JSON.parse(row.payload_json); }
  catch {
    await env.DB.prepare("UPDATE ledger_outbox SET status='failed',last_error='INVALID_OUTBOX_PAYLOAD' WHERE id=?").bind(row.id).run();
    return false;
  }
  try {
    await vault(env,row.path,envelope);
    await env.DB.prepare("UPDATE ledger_outbox SET status='sent',sent_at=?,last_error=NULL WHERE id=?").bind(now(),row.id).run();
    return true;
  } catch (error) { await markRetry(env,row,error); return false; }
}
export async function processOutbox(env, limit = 20) {
  let attempted = 0, sent = 0;
  for (let round=0; round<Math.max(1,Math.min(100,Number(limit)||20)); round+=1) {
    const rows = await nextOutboxRows(env,1);
    if (!rows.length) break;
    attempted += 1;
    if (await deliverOutbox(env,rows[0])) sent += 1;
    else break;
  }
  return { attempted,sent,...await outboxSummary(env) };
}
async function ensureCampaignOutboxDrained(env,campaignId) {
  await processOutbox(env,50);
  const row = await env.DB.prepare(`SELECT status,last_error FROM ledger_outbox WHERE campaign_id=? AND status!='sent'
    ORDER BY campaign_sequence LIMIT 1`).bind(campaignId).first();
  if (row) {
    const e = new Error(row.status === "failed" ? `中央管理台帳への同期エラーを解消してから終了確認してください: ${row.last_error || "LEDGER_ERROR"}` : "中央管理台帳への同期完了後に終了確認してください");
    e.status=409;e.code="LEDGER_SYNC_PENDING";throw e;
  }
}
async function queueLifecycle(env,campaignId,path,data) {
  await ensureCampaignOutboxDrained(env,campaignId);
  const state = await syncState(env,campaignId);
  const revision = Number(state?.lifecycle_revision || 0)+1;
  const sequence = Number(state?.outbox_sequence || 0)+1;
  const occurredAt = now();
  const envelope = { source_system:SOURCE_SYSTEM,source_record_id:`lifecycle:${campaignId}`,source_revision:revision,occurred_at:occurredAt,data };
  const outboxId = uuid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO vault_campaign_sync_state(campaign_id,totals_revision,lifecycle_revision,outbox_sequence,updated_at)
      VALUES (?,0,?,?,?) ON CONFLICT(campaign_id) DO UPDATE SET lifecycle_revision=excluded.lifecycle_revision,
      outbox_sequence=excluded.outbox_sequence,updated_at=excluded.updated_at`).bind(campaignId,revision,sequence,occurredAt),
    outboxInsert(env,{id:outboxId,campaignId,sequence,path,envelope,occurredAt})
  ]);
  await processOutbox(env,10);
  const row = await env.DB.prepare("SELECT status,last_error FROM ledger_outbox WHERE id=?").bind(outboxId).first();
  return { revision,queued:row?.status !== "sent",status:row?.status || "pending",last_error:row?.last_error || null };
}
async function closePreview(env,campaignId) {
  if (!validId(campaignId)) throw Object.assign(new Error("campaign_idが不正です"),{status:400});
  await ensureCampaignOutboxDrained(env,campaignId);
  return bindingJson(env.LEDGER_VAULT,`/api/v1/campaigns/${encodeURIComponent(campaignId)}/close-preview`,{method:"GET"});
}
async function closeCampaign(request,env,campaignId) {
  const body = await request.json().catch(()=>({}));
  const preview = await closePreview(env,campaignId);
  if (body.preview_token && body.preview_token !== preview.preview_token) throw Object.assign(new Error("終了確認後に集計が更新されました。最新内容を確認してください"),{status:409});
  if (preview.has_mismatch && !body.accept_mismatch) return responseJson({ok:false,error:"商品合計と総当選数が一致していません",code:"MISMATCH_CONFIRMATION_REQUIRED",preview},409);
  const data={ preview_token:preview.preview_token,final_winner_count:preview.final_winner_count,
    products:(preview.products||[]).map(p=>({product_id:p.product_id,final_winner_count:p.final_winner_count})),
    confirm:true,accept_mismatch:Boolean(body.accept_mismatch) };
  return responseJson({ok:true,campaign_id:campaignId,close:await queueLifecycle(env,campaignId,`/api/v1/campaigns/${encodeURIComponent(campaignId)}/close`,data)});
}
async function startCorrection(request,env,campaignId) {
  const body=await request.json().catch(()=>({}));
  const reason=String(body.reason||"").trim();
  if (!reason || reason.length>500) return responseJson({ok:false,error:"訂正理由を入力してください"},400);
  const campaign=await campaignDetails(env,campaignId);
  if (campaign.status!=="closed") return responseJson({ok:false,error:"終了済みキャンペーンだけ訂正開始できます"},409);
  return responseJson({ok:true,campaign_id:campaignId,correction:await queueLifecycle(env,campaignId,`/api/v1/campaigns/${encodeURIComponent(campaignId)}/corrections`,{reason})});
}
async function retryOutbox(env) {
  const t=now();
  const result=await env.DB.prepare(`UPDATE ledger_outbox SET status='pending',attempts=0,available_at=?,last_error=NULL WHERE status IN ('failed','retry')`).bind(t).run();
  return {reset:Number(result.meta?.changes||0),...await processOutbox(env,50)};
}
export async function resetLedgerTrialData(env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ledger_outbox"),env.DB.prepare("DELETE FROM campaign_product_items"),
    env.DB.prepare("DELETE FROM campaign_products"),env.DB.prepare("DELETE FROM vault_campaign_sync_state")
  ]);
}

export async function handleLedgerRoute(request,env) {
  const url=new URL(request.url), path=url.pathname;
  if (!path.startsWith("/api/ledger/")) return null;
  try {
    if (path==="/api/ledger/campaigns" && request.method==="GET") return responseJson({ok:true,campaigns:await fetchCampaigns(env)});
    if (path==="/api/ledger/sorting/cards" && request.method==="GET") return responseJson({ok:true,cards:await listSortingCards(env),sync:await outboxSummary(env)});
    const assign=path.match(/^\/api\/ledger\/cards\/([A-Za-z0-9_-]{1,128})\/assign$/);
    if (assign && request.method==="POST") { const body=await request.json().catch(()=>({})); return responseJson({ok:true,...await assignCardToCampaign(env,assign[1],String(body.campaign_id||""))}); }
    const preview=path.match(/^\/api\/ledger\/campaigns\/([A-Za-z0-9_-]{1,128})\/close-preview$/);
    if (preview && request.method==="GET") return responseJson({ok:true,preview:await closePreview(env,preview[1])});
    const close=path.match(/^\/api\/ledger\/campaigns\/([A-Za-z0-9_-]{1,128})\/close$/);
    if (close && request.method==="POST") return closeCampaign(request,env,close[1]);
    const correction=path.match(/^\/api\/ledger\/campaigns\/([A-Za-z0-9_-]{1,128})\/corrections$/);
    if (correction && request.method==="POST") return startCorrection(request,env,correction[1]);
    if (path==="/api/ledger/outbox" && request.method==="GET") {
      const items=(await env.DB.prepare(`SELECT id,campaign_id,campaign_sequence,path,source_record_id,source_revision,status,attempts,available_at,last_error,created_at,sent_at
        FROM ledger_outbox WHERE status!='sent' ORDER BY created_at,campaign_sequence LIMIT 100`).all()).results||[];
      return responseJson({ok:true,...await outboxSummary(env),items});
    }
    if (path==="/api/ledger/outbox/retry" && request.method==="POST") return responseJson({ok:true,...await retryOutbox(env)});
    return responseJson({ok:false,error:"Not found"},404);
  } catch(error) {
    console.error("ledger integration",error);
    return responseJson({ok:false,error:error instanceof Error?error.message:"中央管理台帳連携エラー",code:error?.code||undefined},error?.status||500);
  }
}
