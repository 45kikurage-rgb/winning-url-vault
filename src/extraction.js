import { VaultLedgerError } from "./ledger.js";

const METHODS = new Set(["unset", "normal", "cokeon", "wallet", "paypay", "text_single"]);
const PAYPAY_KINDS = new Set(["url", "code"]);
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

function chunks(values, size = 80) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function compatibleWhere(method, alias = "i") {
  if (method === "normal") return `${alias}.value_type IN ('url','quocardpay')`;
  if (method === "wallet") return `${alias}.value LIKE 'https://%'`;
  if (method === "cokeon") return `${alias}.value_type='cokeon'`;
  if (method === "paypay") return `${alias}.value_type='paypay'`;
  if (method === "text_single") return `${alias}.value<>''`;
  return "0=1";
}

function paypayWhere(kind, alias = "i") {
  if (kind === "url") return `${alias}.value LIKE 'https://%'`;
  if (kind === "code") return `${alias}.value NOT LIKE 'https://%'`;
  return "1=1";
}

function inferPaypayKind(items) {
  if (!items.length || items.some(item => item.value_type !== "paypay")) return null;
  const hasUrl = items.some(item => /^https:\/\//i.test(item.value));
  const hasCode = items.some(item => !/^https:\/\//i.test(item.value));
  if (hasUrl && hasCode) return "mixed";
  return hasUrl ? "url" : "code";
}

async function product(env, productId) {
  const row = await env.DB.prepare(`SELECT p.*,c.campaign_name,c.lottery_start_date,c.status campaign_status
    FROM ledger_products p LEFT JOIN vault_campaigns c ON c.campaign_id=p.campaign_id WHERE p.product_id=?`)
    .bind(productId).first();
  if (!row) throw new VaultLedgerError("当選カードが見つかりません", 404, "PRODUCT_NOT_FOUND");
  return row;
}

export async function listWinningLists(env) {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const currentMonth = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}`;
  const rows = await env.DB.prepare(`SELECT p.product_id,p.campaign_id,p.product_name,p.redemption_place,p.product_spec,
    COALESCE(NULLIF(TRIM(pm.display_name),''),p.product_name) display_name,
    p.valid_until,p.output_method,p.unit_price,p.assigned_at,c.campaign_name,c.lottery_start_date,c.status campaign_status,
    r.month revenue_month,r.winner_count revenue_winner_count,r.amount current_month_revenue,r.sync_status revenue_sync_status,
    COUNT(a.item_id) total_count,
    COALESCE(SUM(CASE WHEN a.exported_at IS NOT NULL THEN 1 ELSE 0 END),0) exported_count,
    COALESCE(SUM(CASE WHEN a.exported_at IS NULL AND (
      p.output_method='text_single' OR
      (p.output_method='normal' AND i.value_type IN ('url','quocardpay')) OR
      (p.output_method='wallet' AND i.value LIKE 'https://%') OR
      (p.output_method='cokeon' AND i.value_type='cokeon') OR
      (p.output_method='paypay' AND i.value_type='paypay')) THEN 1 ELSE 0 END),0) unexported_count,
    COALESCE(SUM(CASE WHEN p.output_method<>'unset' AND NOT (
      p.output_method='text_single' OR
      (p.output_method='normal' AND i.value_type IN ('url','quocardpay')) OR
      (p.output_method='wallet' AND i.value LIKE 'https://%') OR
      (p.output_method='cokeon' AND i.value_type='cokeon') OR
      (p.output_method='paypay' AND i.value_type='paypay')) THEN 1 ELSE 0 END),0) unmatched_count,
    COALESCE(SUM(CASE WHEN a.exported_at IS NULL AND p.output_method='paypay' AND i.value_type='paypay'
      AND i.value LIKE 'https://%' THEN 1 ELSE 0 END),0) paypay_url_unexported_count,
    COALESCE(SUM(CASE WHEN a.exported_at IS NULL AND p.output_method='paypay' AND i.value_type='paypay'
      AND i.value NOT LIKE 'https://%' THEN 1 ELSE 0 END),0) paypay_code_unexported_count
    FROM ledger_products p
    LEFT JOIN cards card ON card.id=p.card_id
    LEFT JOIN product_master pm ON pm.id=card.product_id
    JOIN item_campaign_assignments a ON a.product_id=p.product_id
    JOIN items i ON i.id=a.item_id AND i.status='active'
    LEFT JOIN vault_campaigns c ON c.campaign_id=p.campaign_id
    LEFT JOIN product_monthly_revenue r ON r.product_id=p.product_id AND r.month=?
    WHERE p.is_archived=0
    GROUP BY p.product_id
    ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'closing' THEN 1 WHEN 'correcting' THEN 2 ELSE 3 END,
      c.lottery_start_date DESC,p.assigned_at DESC`).bind(currentMonth).all();
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

async function eligibleItems(env, model, order = "received", paypayKind = "") {
  if (model.output_method === "unset") throw new VaultLedgerError("先に抽出方法を設定してください", 409, "OUTPUT_METHOD_UNSET");
  if (paypayKind && !PAYPAY_KINDS.has(paypayKind)) {
    throw new VaultLedgerError("PayPayの抽出種別が不正です", 400, "INVALID_PAYPAY_KIND");
  }
  const sorting = order === "asc" ? "i.value COLLATE NOCASE,i.received_at,i.id" : "i.received_at,i.id";
  const kindWhere = model.output_method === "paypay" ? ` AND ${paypayWhere(paypayKind)}` : "";
  const rows = await env.DB.prepare(`SELECT i.id,i.value,i.value_type,i.received_at
    FROM item_campaign_assignments a JOIN items i ON i.id=a.item_id
    WHERE a.product_id=? AND a.exported_at IS NULL AND i.status='active' AND ${compatibleWhere(model.output_method)}
    ${kindWhere} ORDER BY ${sorting}`).bind(model.product_id).all();
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
  const items = await readBatchItems(env, batch);
  return { id: batch.id, product_id: batch.product_id, product_name: model.product_name,
    output_method: model.output_method, status: batch.status, copy_order: batch.copy_order,
    count: Number(batch.item_count || 0), created_at: batch.created_at,
    completed_at: batch.completed_at || null, paypay_kind: inferPaypayKind(items), items };
}

export async function startExportBatch(env, productId, order = "received", requestedPaypayKind = "") {
  const pending = await env.DB.prepare("SELECT * FROM export_batches WHERE status='pending' ORDER BY created_at LIMIT 1").first();
  if (pending) {
    const active = await batchPayload(env, pending);
    if (pending.product_id !== productId) {
      throw new VaultLedgerError(`${active.product_name}の商品で一括抽出が進行中です`, 409,
        "EXPORT_BATCH_OTHER_PRODUCT", { batch_id: active.id, product_id: active.product_id,
          product_name: active.product_name, item_count: active.count });
    }
    return { batch: active, restored: true };
  }
  const model = await product(env, productId);
  const copyOrder = order === "asc" ? "asc" : "received";
  if (model.output_method === "paypay" && requestedPaypayKind && !PAYPAY_KINDS.has(requestedPaypayKind)) {
    throw new VaultLedgerError("PayPayの抽出種別が不正です", 400, "INVALID_PAYPAY_KIND");
  }
  const paypayKind = model.output_method === "paypay" && PAYPAY_KINDS.has(requestedPaypayKind)
    ? requestedPaypayKind : "";
  let items = await eligibleItems(env, model, copyOrder, paypayKind);
  let selectedPaypayKind = paypayKind;
  if (model.output_method === "paypay" && !selectedPaypayKind && items.length) {
    selectedPaypayKind = items.some(item => /^https:\/\//i.test(item.value)) ? "url" : "code";
    items = items.filter(item => selectedPaypayKind === "url" ? /^https:\/\//i.test(item.value) : !/^https:\/\//i.test(item.value));
  }
  if (!items.length) throw new VaultLedgerError("未抽出データはありません", 409, "NO_UNEXPORTED_ITEMS");
  const batch = { id: uuid(), product_id: productId, item_ids_json: JSON.stringify(items.map(item => item.id)),
    copy_order: copyOrder, item_count: items.length, status: "pending", created_at: now() };
  try {
    await env.DB.prepare(`INSERT INTO export_batches
      (id,product_id,item_ids_json,copy_order,status,item_count,created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(batch.id, batch.product_id, batch.item_ids_json, batch.copy_order, batch.status, batch.item_count, batch.created_at).run();
  } catch (error) {
    const active = await env.DB.prepare("SELECT * FROM export_batches WHERE status='pending' ORDER BY created_at LIMIT 1").first();
    if (active) {
      const payload = await batchPayload(env, active);
      if (active.product_id !== productId) {
        throw new VaultLedgerError(`${payload.product_name}の商品で一括抽出が進行中です`, 409,
          "EXPORT_BATCH_OTHER_PRODUCT", { batch_id: payload.id, product_id: payload.product_id,
            product_name: payload.product_name, item_count: payload.count });
      }
      return { batch: payload, restored: true };
    }
    throw error;
  }
  return { batch: { ...batch, product_name: model.product_name, output_method: model.output_method,
    paypay_kind: selectedPaypayKind || null, count: items.length, items }, restored: false };
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
  const cancelledAt = now();
  const [, result] = await env.DB.batch([
    env.DB.prepare(`UPDATE item_campaign_assignments SET exported_at=NULL,export_method=NULL,export_batch_id=NULL
      WHERE export_batch_id=? AND EXISTS (
        SELECT 1 FROM export_batches b WHERE b.id=? AND b.status='pending'
      )`).bind(batchId, batchId),
    env.DB.prepare("UPDATE export_batches SET status='cancelled',cancelled_at=? WHERE id=? AND status='pending'")
      .bind(cancelledAt, batchId)
  ]);
  if (!Number(result.meta?.changes || 0)) throw new VaultLedgerError("キャンセルできる一括抽出がありません", 409, "EXPORT_BATCH_NOT_PENDING");
  return { id: batchId, status: "cancelled" };
}

export async function completeExportBatch(env, batchId) {
  const batch = await env.DB.prepare("SELECT * FROM export_batches WHERE id=?").bind(batchId).first();
  if (!batch || batch.status !== "pending") throw new VaultLedgerError("確定できる一括抽出がありません", 409, "EXPORT_BATCH_NOT_PENDING");
  const ids = JSON.parse(batch.item_ids_json || "[]");
  if ((await product(env, batch.product_id)).output_method === "paypay") {
    const kind = inferPaypayKind(await readBatchItems(env, batch));
    if (kind === "mixed") {
      throw new VaultLedgerError("URLとコードが混在する旧一括抽出です。中断して種別ごとに抽出し直してください", 409,
        "PAYPAY_BATCH_MIXED");
    }
  }
  const completedAt = now();
  const statements = [];
  for (const group of chunks(ids)) {
    const placeholders = group.map(() => "?").join(",");
    statements.push(env.DB.prepare(`UPDATE item_campaign_assignments SET exported_at=?,export_method='bulk',export_batch_id=?
      WHERE product_id=? AND item_id IN (${placeholders}) AND exported_at IS NULL`)
      .bind(completedAt, batchId, batch.product_id, ...group));
  }
  statements.push(env.DB.prepare("UPDATE export_batches SET status='completed',completed_at=? WHERE id=? AND status='pending'")
    .bind(completedAt, batchId));
  const results = await env.DB.batch(statements);
  const batchResult = results.at(-1);
  if (!Number(batchResult?.meta?.changes || 0)) {
    throw new VaultLedgerError("確定できる一括抽出がありません", 409, "EXPORT_BATCH_NOT_PENDING");
  }
  const changed = results.slice(0, -1).reduce((sum, result) => sum + Number(result.meta?.changes || 0), 0);
  return { id: batchId, status: "completed", changed_count: changed, completed_at: completedAt };
}

export async function undoExportBatch(env, batchId) {
  const batch = await env.DB.prepare("SELECT * FROM export_batches WHERE id=? AND status='completed'").bind(batchId).first();
  if (!batch) throw new VaultLedgerError("取り消せる一括抽出がありません", 409, "EXPORT_BATCH_NOT_COMPLETED");
  const [result] = await env.DB.batch([
    env.DB.prepare(`UPDATE item_campaign_assignments SET exported_at=NULL,export_method=NULL,export_batch_id=NULL
      WHERE export_batch_id=? AND EXISTS (
        SELECT 1 FROM export_batches b WHERE b.id=? AND b.status='completed'
      )`).bind(batchId, batchId),
    env.DB.prepare("UPDATE export_batches SET status='cancelled',cancelled_at=? WHERE id=? AND status='completed'")
      .bind(now(), batchId)
  ]);
  return { id: batchId, undone_count: Number(result.meta?.changes || 0) };
}

export async function nextExportItem(env, productId, paypayKind = "") {
  const model = await product(env, productId);
  const items = await eligibleItems(env, model, "received", paypayKind);
  return { product_id: productId, product_name: model.product_name, output_method: model.output_method,
    paypay_kind: model.output_method === "paypay" ? paypayKind || null : null,
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
