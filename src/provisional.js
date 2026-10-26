import { classifyValue, normalizeName, normalizeRedeemPlace, normalizeSpecification, stableJson } from "./core.js";
import { digest, IntakeError } from "./sending-auth.js";

const SLOTS = ["A", "B", "C", "D", "E"];
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const invalid = (message, status = 400, code = "PROVISIONAL_INVALID") => new IntakeError(code, status, message);
const slotValid = value => SLOTS.includes(value);

export function parseProvisionalValues(raw, values) {
  const fullText = [...(raw?.values || []), raw?.text || ""].join("\n").normalize("NFKC");
  const isCoinPlus = /COIN\s*\+/i.test(fullText);
  if (isCoinPlus) {
    const date = fullText.match(/受取期限[\s:：]*(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    let expiry = "";
    if (date) {
      const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]);
      const d = new Date(Date.UTC(year, month - 1, day));
      if (d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month && d.getUTCDate() === day)
        expiry = [year, String(month).padStart(2, "0"), String(day).padStart(2, "0")].join("-");
    }
    const codes = [...fullText.matchAll(/ギフトコード[\s:：]*([A-Z0-9]{16})(?![A-Z0-9])/gi)];
    if (codes.length) {
      return codes.map(match => ({
        value: match[1].toUpperCase(),
        source: "coin_plus",
        expiry,
        redeemPlace: "エアウォレット"
      }));
    }
    // Do not accidentally turn surrounding 16-character tokens into PayPay.
    return [{ value: fullText.trim(), source: "coin_plus_unparsed", expiry, redeemPlace: "エアウォレット" }];
  }
  return values.map(value => ({ value, source: "", expiry: "", redeemPlace: "" }));
}

export function provisionalPlan(raw, values) {
  const seen = new Set();
  const plan = [];
  for (const parsed of parseProvisionalValues(raw, values)) {
    const classified = classifyValue(parsed.value);
    if (!classified) continue;
    const canonical = classified.canonicalValue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    plan.push({
      id: uid(),
      value: classified.storedValue,
      canonical,
      // Codes are intentionally not classified as PayPay while in an inbox.
      type: classified.type === "url" || classified.type === "quocardpay" ? "url" : "text",
      analysis: {
        provisional: true,
        source: parsed.source,
        expiresOn: parsed.expiry,
        redeemPlace: parsed.redeemPlace,
        parseStatus: parsed.source === "coin_plus_unparsed" ? "requires_review" : "ok"
      }
    });
  }
  return plan;
}

async function state(env) {
  return env.DB.prepare("SELECT mode FROM provisional_mode WHERE id=1").first();
}

export async function modeInfo(env) {
  const mode = (await state(env))?.mode || "normal";
  const rows = await env.DB.prepare(
    "SELECT s.slot,s.active_bucket_id bucket_id,COUNT(i.id) count " +
    "FROM provisional_slots s LEFT JOIN provisional_entries e ON e.bucket_id=s.active_bucket_id " +
    "LEFT JOIN items i ON i.id=e.item_id AND i.status='provisional' " +
    "GROUP BY s.slot ORDER BY s.slot"
  ).all();
  return { mode, slots: (rows.results || []).map(row => ({
    slot: row.slot, bucketId: row.bucket_id, count: Number(row.count || 0)
  })) };
}

export async function changeMode(env, requested) {
  if (requested !== "normal" && !slotValid(requested)) throw invalid("受信先は通常または暫定A〜Eを指定してください");
  await env.DB.prepare("UPDATE provisional_mode SET mode=?,updated_at=? WHERE id=1").bind(requested, now()).run();
  return modeInfo(env);
}

async function receiptByRequest(env, ownerKey, requestId) {
  return env.DB.prepare("SELECT * FROM provisional_receipts WHERE owner_key=? AND client_request_id=?")
    .bind(ownerKey, requestId).first();
}

async function finishReceive(env, receipt) {
  if (receipt.status !== "stored") {
    const plan = JSON.parse(receipt.plan_json);
    for (let cursor = receipt.cursor; cursor < plan.length; cursor += 30) {
      const chunk = plan.slice(cursor, cursor + 30);
      const statements = [];
      for (const entry of chunk) {
        statements.push(env.DB.prepare(
          "INSERT OR IGNORE INTO items(id,value,canonical_value,value_type,status,analysis_json) " +
          "SELECT ?,?,?,?,'provisional',? WHERE EXISTS " +
          "(SELECT 1 FROM provisional_receipts WHERE id=? AND status='receiving')"
        ).bind(entry.id, entry.value, entry.canonical, entry.type, JSON.stringify(entry.analysis), receipt.id));
        statements.push(env.DB.prepare(
          "INSERT OR IGNORE INTO provisional_entries(item_id,receipt_id,bucket_id,source_label,parsed_expiry) " +
          "SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM items WHERE id=? AND status='provisional')"
        ).bind(entry.id, receipt.id, receipt.bucket_id, entry.analysis.source, entry.analysis.expiresOn, entry.id));
      }
      statements.push(env.DB.prepare(
        "UPDATE provisional_receipts SET cursor=MAX(cursor,?) WHERE id=? AND status='receiving'"
      ).bind(cursor + chunk.length, receipt.id));
      await env.DB.batch(statements);
    }
    await env.DB.prepare("UPDATE provisional_receipts SET status='stored' WHERE id=? AND cursor=?")
      .bind(receipt.id, plan.length).run();
  }
  const stored = await env.DB.prepare("SELECT status,plan_json,bucket_id FROM provisional_receipts WHERE id=?")
    .bind(receipt.id).first();
  if (!stored || stored.status !== "stored") throw invalid("暫定保管が完了していません。受付IDを変えず再送してください", 503, "INTAKE_INCOMPLETE");
  const count = await env.DB.prepare("SELECT COUNT(*) n FROM provisional_entries WHERE receipt_id=?")
    .bind(receipt.id).first();
  return {
    ok: true, stored: true, provisional: true,
    mode: (await env.DB.prepare("SELECT slot FROM provisional_buckets WHERE id=?")
      .bind(receipt.bucket_id).first())?.slot,
    received: Number(count?.n || 0),
    duplicate: JSON.parse(stored.plan_json).length - Number(count?.n || 0),
    // ARUNOMATIC expects a durable job id, terminal status and inputTotal in
    // every stored:true receipt. Reuse the persisted provisional receipt UUID,
    // not a synthetic analysis job (provisional data is deliberately not analyzed).
    job: {
      id: receipt.id,
      status: "completed",
      inputTotal: JSON.parse(stored.plan_json).length
    }
  };
}

export async function maybeReceiveProvisional(env, input, ownerKey) {
  const previous = await receiptByRequest(env, ownerKey, input.clientRequestId);
  if (!previous && ((await state(env))?.mode || "normal") === "normal") return null;

  const payloadHash = await digest(JSON.stringify(input.raw));
  let receipt = previous;
  if (receipt && receipt.payload_hash !== payloadHash)
    throw invalid("同じ受付IDに別の入力は送信できません", 409, "REQUEST_ID_CONFLICT");
  if (!receipt) {
    const mode = (await state(env))?.mode || "normal";
    if (!slotValid(mode)) return null;
    const bucket = await env.DB.prepare(
      "SELECT b.id FROM provisional_slots s JOIN provisional_buckets b ON b.id=s.active_bucket_id " +
      "WHERE s.slot=? AND b.status='open'"
    ).bind(mode).first();
    if (!bucket) throw invalid("暫定保管先の切替中です。再送してください", 503, "PROVISIONAL_SLOT_BUSY");
    const plan = provisionalPlan(input.raw, input.values);
    if (!plan.length) throw invalid("暫定保管できる入力がありません");
    const receiptId = uid();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO provisional_receipts " +
      "(id,owner_key,client_request_id,payload_hash,bucket_id,raw_json,plan_json) " +
      "SELECT ?,?,?,?,?,?,? FROM provisional_buckets WHERE id=? AND status='open'"
    ).bind(receiptId, ownerKey, input.clientRequestId, payloadHash, bucket.id,
      JSON.stringify(input.raw), JSON.stringify(plan), bucket.id).run();
    receipt = await receiptByRequest(env, ownerKey, input.clientRequestId);
    if (!receipt) throw invalid("暫定保管先の切替中です。再送してください", 503, "PROVISIONAL_SLOT_BUSY");
    if (receipt.payload_hash !== payloadHash)
      throw invalid("同じ受付IDに別の入力は送信できません", 409, "REQUEST_ID_CONFLICT");
  }
  return finishReceive(env, receipt);
}

export async function provisionalOverview(env) {
  const current = await modeInfo(env);
  const buckets = [];
  for (const slot of current.slots) {
    const rows = await env.DB.prepare(
      "SELECT e.item_id id,i.value,i.received_at,e.source_label source,e.parsed_expiry expires_on " +
      "FROM provisional_entries e JOIN items i ON i.id=e.item_id " +
      "WHERE e.bucket_id=? AND i.status='provisional' ORDER BY i.received_at,i.id LIMIT 40"
    ).bind(slot.bucketId).all();
    buckets.push({ ...slot, items: rows.results || [], truncated: slot.count > 40 });
  }
  return { mode: current.mode, buckets };
}

// Keep the canonical value and receipt for durable duplicate detection. A deleted
// provisional item is excluded from lists and publish, never physically erased.
export async function deleteProvisionalItem(env, slot, bucketId, itemId) {
  if (!slotValid(slot) || !/^[a-zA-Z0-9-]{3,80}$/.test(String(bucketId || "")) ||
      !/^[0-9a-f-]{36}$/i.test(String(itemId || ""))) throw invalid("削除対象が不正です");
  const tick = now();
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE items SET status='provisional_deleted',classified_at=? " +
      "WHERE id=? AND status='provisional' AND card_id IS NULL AND pending_id IS NULL " +
      "AND NOT EXISTS (SELECT 1 FROM item_campaign_assignments WHERE item_id=items.id) " +
      "AND EXISTS (SELECT 1 FROM provisional_entries e " +
      "JOIN provisional_receipts r ON r.id=e.receipt_id " +
      "JOIN provisional_buckets b ON b.id=e.bucket_id " +
      "JOIN provisional_slots s ON s.active_bucket_id=b.id " +
      "WHERE e.item_id=items.id AND b.id=? AND s.slot=? AND b.status='open' AND r.status='stored')"
    ).bind(tick, itemId, bucketId, slot),
    env.DB.prepare(
      "INSERT INTO audit_log(id,item_id,action,detail) " +
      "SELECT ?,id,'provisional_deleted',? FROM items " +
      "WHERE id=? AND status='provisional_deleted' AND classified_at=? " +
      "AND NOT EXISTS (SELECT 1 FROM audit_log WHERE item_id=? AND action='provisional_deleted')"
    ).bind(uid(), JSON.stringify({ slot, bucketId }), itemId, tick, itemId)
  ]);
  if (Number(result[0]?.meta?.changes || 0) !== 1)
    throw invalid("対象が更新されています。最新の一覧を読み込んでください", 409, "PROVISIONAL_CHANGED");
  return { ok: true, deleted: 1, itemId };
}

function dateValid(value) {
  if (!value) return true;
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export async function publishBucket(env, slot, bucketId, form) {
  if (!slotValid(slot) || !/^[a-zA-Z0-9-]{3,80}$/.test(String(bucketId || "")))
    throw invalid("暫定保管先が不正です");
  const active = await env.DB.prepare(
    "SELECT b.id FROM provisional_slots s JOIN provisional_buckets b ON b.id=s.active_bucket_id " +
    "WHERE s.slot=? AND b.id=? AND b.status='open'"
  ).bind(slot, bucketId).first();
  if (!active) throw invalid("保管先が変更されています。最新の一覧を読み込んでください", 409);
  const count = await env.DB.prepare(
    "SELECT COUNT(*) n FROM provisional_entries e JOIN items i ON i.id=e.item_id " +
    "WHERE e.bucket_id=? AND i.status='provisional'"
  ).bind(bucketId).first();
  if (!Number(count?.n)) throw invalid("保管中のデータがありません", 409);
  const name = String(form?.name || "").normalize("NFKC").trim().slice(0, 160) || ("未設定（暫定" + slot + "）");
  const expiry = String(form?.expires_on || "").trim();
  if (!dateValid(expiry)) throw invalid("受取期限は正しい日付を入力するか空欄にしてください");
  const place = normalizeRedeemPlace(form?.redeem_place) || "未設定";
  const amountText = String(form?.amount ?? "").trim();
  if (amountText && (!/^\d{1,9}$/.test(amountText) || Number(amountText) <= 0))
    throw invalid("金額は正の整数か空欄にしてください");
  const amount = amountText ? Number(amountText) : null;
  const conditions = stableJson({ provisionalBucket: bucketId });
  const normalized = normalizeName(name);
  const spec = normalizeSpecification(form?.specification) || (amount !== null ? String(amount) + "円" : "");
  const matchKey = [normalized, spec, place, conditions].join("\u001f");
  const productId = uid(), cardId = uid();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO product_master " +
    "(id,source_type,raw_name,normalized_name,display_name,redeem_place,specification,required_conditions,match_key,confirmed) " +
    "VALUES (?,'provisional',?,?,?,?,?,?,?,1)"
  ).bind(productId, name, normalized, name.slice(0, 64), place, spec, conditions, matchKey).run();
  const product = await env.DB.prepare("SELECT id FROM product_master WHERE match_key=?")
    .bind(matchKey).first();
  await env.DB.prepare("INSERT OR IGNORE INTO cards(id,product_id,expires_on,locked) VALUES (?,?,?,1)")
    .bind(cardId, product.id, expiry).run();
  const card = await env.DB.prepare("SELECT id FROM cards WHERE product_id=? AND expires_on=?")
    .bind(product.id, expiry).first();
  const nextBucketId = uid();
  const tick = now();
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE provisional_buckets SET status='published',published_card_id=?,draft_unit_price=?,published_at=? " +
      "WHERE id=? AND status='open' AND NOT EXISTS " +
      "(SELECT 1 FROM provisional_receipts WHERE bucket_id=? AND status='receiving')"
    ).bind(card.id, amount, tick, bucketId, bucketId),
    env.DB.prepare(
      "UPDATE items SET status='active',card_id=?,pending_id=NULL,classified_at=? " +
      "WHERE status='provisional' AND id IN (SELECT e.item_id FROM provisional_entries e " +
      "JOIN provisional_buckets b ON b.id=e.bucket_id " +
      "WHERE b.id=? AND b.status='published' AND b.published_card_id=?)"
    ).bind(card.id, tick, bucketId, card.id),
    env.DB.prepare(
      "INSERT OR IGNORE INTO provisional_buckets(id,slot) " +
      "SELECT ?,? WHERE EXISTS (SELECT 1 FROM provisional_buckets WHERE id=? AND status='published' AND published_card_id=?)"
    ).bind(nextBucketId, slot, bucketId, card.id),
    env.DB.prepare(
      "UPDATE provisional_slots SET active_bucket_id=? WHERE slot=? AND active_bucket_id=? " +
      "AND EXISTS (SELECT 1 FROM provisional_buckets WHERE id=? AND status='published' AND published_card_id=?)"
    ).bind(nextBucketId, slot, bucketId, bucketId, card.id)
  ]);
  if (Number(result[0]?.meta?.changes || 0) !== 1)
    throw invalid("受信中のデータがあるか、保管先が更新されています。時間をおいて再試行してください", 409, "PROVISIONAL_BUSY");
  return { ok: true, slot, cardId: card.id, count: Number(count.n), priceRecorded: amount !== null,
    warning: amount !== null ? "入力金額は暫定メモです。収益単価はキャンペーンへ仕分け後に確認・設定してください。" : "" };
}

