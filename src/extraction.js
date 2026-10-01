import { VaultLedgerError } from "./ledger.js";

const METHODS = new Set(["unset", "normal", "cokeon", "wallet", "paypay", "text_single"]);
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

function chunks(values, size = 80) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function compatibleWhere(method, alias = "i") {
  if (method === "normal" || method === "wallet") return `${alias}.value LIKE 'https://%'`;
  if (method === "cokeon") return `${alias}.value_type='cokeon'`;
  if (method === "paypay") return `${alias}.value_type='paypay'`;
  if (method === "text_single") return `${alias}.value<>''`;
  return "0=1";
}

async function product(env, productId) {
  const row = await env.DB.prepare(`SELECT p.*,c.campaign_name,c.lottery_start_date,c.status campaign_status
    FROM ledger_products p LEFT JOIN vault_campaigns c ON c.campaign_id=p.campaign_id WHERE p.product_id=?`)
    .bind(productId).first();
  if (!row) throw new VaultLedgerError("当選カードが見つかりません", 404, "PRODUCT_NOT_FOUND");
  return row;
}

export async function listWinningLists(env) {
  const rows = await env.DB.prepare(`SELECT p.product_id,p.campaign_id,p.product_name,p.redemption_place,p.product_spec,
    p.valid_until,p.output_method,p.assigned_at,c.campaign_name,c.lottery_start_date,c.status campaign_status,
    COUNT(a.item_id) total_count,
    COALESCE(SUM(CASE WHEN a.exported_at IS NOT NULL THEN 1 ELSE 0 END),0) exported_count,
    COALESCE(SUM(CASE WHEN a.exported_at IS NULL AND (
      p.output_method='text_single' OR
      (p.output_method IN ('normal','wallet') AND i.value LIKE 'https://%') OR
      (p.output_method='cokeon' AND i.value_type='cokeon') OR
      (p.output_method='paypay' AND i.value_type='paypay')) THEN 1 ELSE 0 END),0) unexported_count,
    COALESCE(SUM(CASE WHEN p.output_method<>'unset' AND NOT (
      p.output_method='text_single' OR
      (p.output_method IN ('normal','wallet') AND i.value LIKE 'https://%') OR
      (p.output_method='cokeon' AND i.value_type='cokeon') OR
      (p.output_method='paypay' AND i.value_type='paypay')) THEN 1 ELSE 0 END),0) unmatched_count
    FROM ledger_products p
    JOIN item_campaign_assignments a ON a.product_id=p.product_id
    JOIN items i ON i.id=a.item_id AND i.status='active'
    LEFT JOIN vault_campaigns c ON c.campaign_id=p.campaign_id
    WHERE p.is_archived=0
    GROUP BY p.product_id
    ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'closing' THEN 1 WHEN 'correcting' THEN 2 ELSE 3 END,
      c.lottery_start_date DESC,p.assigned_at DESC`).all();
  return rows.results || [];
}

export async function setOutputMethod(env, productId, method) {
  if (!METHODS.has(method)) throw new VaultLedgerError("抽出方法が不正です", 400, "INVALID_OUTPUT_METHOD");
  await product(env, productId);
  const pending = await env.DB.prepare("SELECT id FROM export_batches WHERE status='pending' LIMIT 1").first();
  if (pending) throw new VaultLedgerError("進行中の一括抽出を完了またはキャンセルしてください", 409, "EXPORT_BATCH_PENDING", { batch_id: pending.id });
  await env.DB.prepare("UPDATE ledger_products SET output_method=?,updated_at=? WHERE product_id=?")
    .bind(method, now(), productId).run();
  return { product_id: productId, output_method: method };
}

async function eligibleItems(env, model, order = "received") {
  if (model.output_method === "unset") throw new VaultLedgerError("先に抽出方法を設定してください", 409, "OUTPUT_METHOD_UNSET");
  const sorting = order === "asc" ? "i.value COLLATE NOCASE,i.received_at,i.id" : "i.received_at,i.id";
  const rows = await env.DB.prepare(`SELECT i.id,i.value,i.value_type,i.received_at
    FROM item_campaign_assignments a JOIN items i ON i.id=a.item_id
    WHERE a.product_id=? AND a.exported_at IS NULL AND i.status='active' AND ${compatibleWhere(model.output_method)}
    ORDER BY ${sorting}`).bind(model.product_id).all();
  return rows.results || [];
}

async function readBatchItems(env, batch) {
  const ids = JSON.parse(batch.item_ids_json || "[]");
  const byId = new Map();
  for (const group of chunks(ids)) {
    const placeholders = group.map(() => "?").join(",");
    const rows = await env.DB.prepare(`SELECT id,value,value_type,received_at FROM items WHERE id IN (${placeholders})`)
      .bind(...group).all();
    for (const row of rows.results || []) byId.set(row.id, row);
  }
  return ids.map(id => byId.get(id)).filter(Boolean);
}

async function batchPayload(env, batch) {
  const model = await product(env, batch.product_id);
  return { id: batch.id, product_id: batch.product_id, product_name: model.product_name,
    output_method: model.output_method, status: batch.status, copy_order: batch.copy_order,
    count: Number(batch.item_count || 0), created_at: batch.created_at,
    completed_at: batch.completed_at || null, items: await readBatchItems(env, batch) };
}

export async function startExportBatch(env, productId, order = "received") {
  const pending = await env.DB.prepare("SELECT * FROM export_batches WHERE status='pending' ORDER BY created_at LIMIT 1").first();
  if (pending) return { batch: await batchPayload(env, pending), restored: true };
  const model = await product(env, productId);
  const copyOrder = order === "asc" ? "asc" : "received";
  const items = await eligibleItems(env, model, copyOrder);
  if (!items.length) throw new VaultLedgerError("未抽出データはありません", 409, "NO_UNEXPORTED_ITEMS");
  const batch = { id: uuid(), product_id: productId, item_ids_json: JSON.stringify(items.map(item => item.id)),
    copy_order: copyOrder, item_count: items.length, status: "pending", created_at: now() };
  try {
    await env.DB.prepare(`INSERT INTO export_batches
      (id,product_id,item_ids_json,copy_order,status,item_count,created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(batch.id, batch.product_id, batch.item_ids_json, batch.copy_order, batch.status, batch.item_count, batch.created_at).run();
  } catch (error) {
    const active = await env.DB.prepare("SELECT * FROM export_batches WHERE status='pending' ORDER BY created_at LIMIT 1").first();
    if (active) return { batch: await batchPayload(env, active), restored: true };
    throw error;
  }
  return { batch: { ...batch, product_name: model.product_name, output_method: model.output_method,
    count: items.length, items }, restored: false };
}

export async function getExportBatch(env, batchId) {
  const batch = await env.DB.prepare("SELECT * FROM export_batches WHERE id=?").bind(batchId).first();
  if (!batch) throw new VaultLedgerError("一括抽出が見つかりません", 404, "EXPORT_BATCH_NOT_FOUND");
  return batchPayload(env, batch);
}

export async function getPendingExportBatch(env) {
  const batch = await env.DB.prepare("SELECT * FROM export_batches WHERE status='pending' ORDER BY created_at LIMIT 1").first();
  return batch ? batchPayload(env, batch) : null;
}

export async function cancelExportBatch(env, batchId) {
  const result = await env.DB.prepare("UPDATE export_batches SET status='cancelled',cancelled_at=? WHERE id=? AND status='pending'")
    .bind(now(), batchId).run();
  if (!Number(result.meta?.changes || 0)) throw new VaultLedgerError("キャンセルできる一括抽出がありません", 409, "EXPORT_BATCH_NOT_PENDING");
  return { id: batchId, status: "cancelled" };
}

export async function completeExportBatch(env, batchId) {
  const batch = await env.DB.prepare("SELECT * FROM export_batches WHERE id=?").bind(batchId).first();
  if (!batch || batch.status !== "pending") throw new VaultLedgerError("確定できる一括抽出がありません", 409, "EXPORT_BATCH_NOT_PENDING");
  const ids = JSON.parse(batch.item_ids_json || "[]");
  const completedAt = now();
  let changed = 0;
  for (const group of chunks(ids)) {
    const placeholders = group.map(() => "?").join(",");
    const result = await env.DB.prepare(`UPDATE item_campaign_assignments SET exported_at=?,export_method='bulk',export_batch_id=?
      WHERE item_id IN (${placeholders}) AND exported_at IS NULL`).bind(completedAt, batchId, ...group).run();
    changed += Number(result.meta?.changes || 0);
  }
  await env.DB.prepare("UPDATE export_batches SET status='completed',completed_at=? WHERE id=? AND status='pending'")
    .bind(completedAt, batchId).run();
  return { id: batchId, status: "completed", changed_count: changed, completed_at: completedAt };
}

export async function undoExportBatch(env, batchId) {
  const batch = await env.DB.prepare("SELECT * FROM export_batches WHERE id=? AND status='completed'").bind(batchId).first();
  if (!batch) throw new VaultLedgerError("取り消せる一括抽出がありません", 409, "EXPORT_BATCH_NOT_COMPLETED");
  const result = await env.DB.prepare(`UPDATE item_campaign_assignments SET exported_at=NULL,export_method=NULL,export_batch_id=NULL
    WHERE export_batch_id=?`).bind(batchId).run();
  await env.DB.prepare("UPDATE export_batches SET status='cancelled',cancelled_at=? WHERE id=?")
    .bind(now(), batchId).run();
  return { id: batchId, undone_count: Number(result.meta?.changes || 0) };
}

export async function nextExportItem(env, productId) {
  const model = await product(env, productId);
  const items = await eligibleItems(env, model, "received");
  return { product_id: productId, product_name: model.product_name, output_method: model.output_method,
    remaining_count: items.length, item: items[0] || null };
}

export async function completeExportItem(env, productId, itemId) {
  const model = await product(env, productId);
  const item = await env.DB.prepare(`SELECT i.id,i.value,i.value_type FROM item_campaign_assignments a
    JOIN items i ON i.id=a.item_id WHERE a.product_id=? AND a.item_id=? AND a.exported_at IS NULL
    AND i.status='active' AND ${compatibleWhere(model.output_method)}`).bind(productId, itemId).first();
  if (!item) throw new VaultLedgerError("対象データは既に抽出済みか、抽出方法の対象外です", 409, "ITEM_NOT_EXPORTABLE");
  await env.DB.prepare(`UPDATE item_campaign_assignments SET exported_at=?,export_method='single',export_batch_id=NULL
    WHERE product_id=? AND item_id=? AND exported_at IS NULL`).bind(now(), productId, itemId).run();
  return { product_id: productId, item_id: itemId, status: "exported" };
}
