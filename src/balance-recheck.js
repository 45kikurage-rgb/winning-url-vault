import { isEraberuPay } from "../public/analysis-amount.js";
import { VaultLedgerError } from "./ledger.js";

async function requireEraberuPay(env, productId) {
  const product = await env.DB.prepare(`SELECT pm.required_conditions FROM ledger_products p
    JOIN cards c ON c.id=p.card_id JOIN product_master pm ON pm.id=c.product_id
    WHERE p.product_id=? AND p.is_archived=0`).bind(productId).first();
  if (!isEraberuPay(product)) {
    throw new VaultLedgerError("えらべるPayのカードだけ再解析できます", 400, "NOT_ERABERU_PAY");
  }
  const pending = await env.DB.prepare("SELECT id FROM export_batches WHERE product_id=? AND status='pending'")
    .bind(productId).first();
  if (pending) throw new VaultLedgerError("このカードの一括抽出を完了または中断してから再解析してください", 409, "EXPORT_BATCH_PENDING");
}

export async function balanceRecheckOverview(env, productId) {
  await requireEraberuPay(env, productId);
  const rows = await env.DB.prepare(`SELECT i.id,i.value_type,i.value FROM item_campaign_assignments a
    JOIN items i ON i.id=a.item_id WHERE a.product_id=? AND i.status='active' ORDER BY i.received_at,i.id`)
    .bind(productId).all();
  const items = rows.results || [];
  const urls = items.filter(item => item.value_type === "url" && /^https:\/\//i.test(item.value));
  return { ids: urls.map(item => item.id), unsupported: items.length - urls.length };
}

export function balanceVerdict(result, url) {
  if (!result || result.url !== url || result.status !== "ok" || result.site !== "giftee_box"
    || result.kind !== "box" || result.boxCategory !== "eraberu_pay") return "unknown";
  const balance = result.balance;
  if (!((typeof balance === "number") || (typeof balance === "string" && /^\d+(?:\.\d+)?$/.test(balance.trim())))
    || !Number.isFinite(Number(balance)) || Number(balance) < 0) return "unknown";
  return Number(balance) > 0 ? "positive" : "zero";
}

export async function recheckBalances(env, productId, ids, analyze) {
  await requireEraberuPay(env, productId);
  if (!Array.isArray(ids) || !ids.length || ids.length > 5
    || ids.some(id => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) {
    throw new VaultLedgerError("再解析対象は1〜5件のURLを指定してください", 400, "INVALID_RECHECK_IDS");
  }
  const unique = [...new Set(ids)];
  const rows = await env.DB.prepare(`SELECT i.id,i.value,a.exported_at,a.export_method,a.export_batch_id
    FROM item_campaign_assignments a JOIN items i ON i.id=a.item_id
    WHERE a.product_id=? AND i.id IN (${unique.map(() => "?").join(",")})
      AND i.status='active' AND i.value_type='url' AND i.value LIKE 'https://%'`)
    .bind(productId, ...unique).all();
  const items = rows.results || [];
  let results = [];
  let error = "";
  try { results = await analyze(env, items.map(item => item.value), { includeProductImage: false }); }
  catch { error = "残高を取得できませんでした。時間をおいて再解析してください。"; }
  const counts = { checked: items.length, restored: 0, positive: 0, zero: 0, unknown: 0, skipped: unique.length - items.length };
  for (const item of items) {
    // Ambiguous, missing and different-URL responses must never restore an export.
    const matching = results.filter(result => result?.url === item.value);
    const result = matching.length === 1 ? matching[0] : null;
    let verdict = balanceVerdict(result, item.value);
    if (verdict === "positive") {
      // Compare the pre-analysis export state atomically. A new export, reassignment,
      // removal or pending bulk export while the request was in flight wins.
      const update = await env.DB.prepare(`UPDATE item_campaign_assignments
        SET exported_at=NULL,export_method=NULL,export_batch_id=NULL
        WHERE item_id=? AND product_id=? AND exported_at IS ? AND export_method IS ? AND export_batch_id IS ?
          AND EXISTS (SELECT 1 FROM items i WHERE i.id=item_id AND i.status='active')
          AND EXISTS (SELECT 1 FROM ledger_products p WHERE p.product_id=? AND p.is_archived=0)
          AND NOT EXISTS (SELECT 1 FROM export_batches b WHERE b.product_id=? AND b.status='pending')`)
        .bind(item.id, productId, item.exported_at, item.export_method, item.export_batch_id, productId, productId).run();
      if (Number(update.meta?.changes || 0)) {
        counts.positive++;
        if (item.exported_at !== null) counts.restored++;
      } else { counts.skipped++; verdict = "skipped"; }
    } else { counts[verdict]++; }
    // Keep the original classification and revenue data intact.
    const check = { verdict, checkedAt: new Date().toISOString(),
      balance: verdict === "positive" || verdict === "zero" ? Number(result.balance) : null };
    await env.DB.prepare(`UPDATE items SET analysis_json=json_set(
      CASE WHEN json_valid(analysis_json) THEN analysis_json ELSE '{}' END,'$.balanceRecheck',json(?))
      WHERE id=? AND EXISTS (SELECT 1 FROM item_campaign_assignments a WHERE a.item_id=items.id AND a.product_id=?)`)
      .bind(JSON.stringify(check), item.id, productId).run();
  }
  return { ...counts, ...(error ? { error } : {}) };
}
