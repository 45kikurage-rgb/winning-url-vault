const SOURCE_SYSTEM = "winning-url-vault";
const RETRY_SECONDS = [60, 120, 300, 900, 3600];
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

export class VaultLedgerError extends Error {
  constructor(message, status = 400, code = "VAULT_LEDGER_ERROR", details = {}) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

function binding(env, kind) {
  const value = kind === "reader" ? env.LEDGER_READER : env.LEDGER_VAULT;
  if (!value?.fetch) throw new VaultLedgerError("中央管理台帳のService Bindingが未設定です", 503, "LEDGER_BINDING_MISSING");
  return value;
}

async function callLedger(env, kind, path, options = {}) {
  const request = new Request(`https://ledger.internal${path}`, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const response = await binding(env, kind).fetch(request);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const code = payload?.error?.code || `LEDGER_HTTP_${response.status}`;
    throw new VaultLedgerError(`中央管理台帳: ${code}`, response.status, code, payload?.error?.details || {});
  }
  return payload;
}

function safeText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function identityKey(model) {
  return [model.normalized_name, model.redeem_place, model.specification, model.expires_on]
    .map(value => safeText(value).toLowerCase()).join("\u001f");
}

async function cachedCampaigns(env) {
  const rows = await env.DB.prepare(`SELECT * FROM vault_campaigns
    WHERE is_archived=0 ORDER BY lottery_start_date DESC,campaign_name,campaign_id`).all();
  return rows.results || [];
}

export async function refreshCampaigns(env) {
  const items = [];
  let after = "";
  try {
    do {
      const query = new URLSearchParams({ limit: "100", include_archived: "true" });
      if (after) query.set("after", after);
      const page = await callLedger(env, "reader", `/api/v1/campaigns?${query}`);
      items.push(...(page.items || []));
      after = page.next_cursor || "";
    } while (after);
    const refreshedAt = now();
    for (let start = 0; start < items.length; start += 40) {
      await env.DB.batch(items.slice(start, start + 40).map(item => env.DB.prepare(`INSERT INTO vault_campaigns
        (campaign_id,campaign_name,lottery_start_date,status,is_archived,current_winner_count,final_winner_count,final_account_count,last_refreshed_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(campaign_id) DO UPDATE SET
        campaign_name=excluded.campaign_name,lottery_start_date=excluded.lottery_start_date,status=excluded.status,
        is_archived=excluded.is_archived,current_winner_count=excluded.current_winner_count,
        final_winner_count=excluded.final_winner_count,final_account_count=excluded.final_account_count,
        last_refreshed_at=excluded.last_refreshed_at`)
        .bind(item.campaign_id, item.campaign_name, item.lottery_start_date, item.status, item.is_archived ? 1 : 0,
          item.current_winner_count ?? null, item.final_winner_count ?? null, item.final_account_count ?? null, refreshedAt)));
    }
    return { campaigns: (await cachedCampaigns(env)).map(campaign => ({ ...campaign, is_archived: Boolean(campaign.is_archived) })), stale: false };
  } catch (error) {
    const cached = await cachedCampaigns(env);
    if (!cached.length) throw error;
    return { campaigns: cached.map(campaign => ({ ...campaign, is_archived: Boolean(campaign.is_archived) })), stale: true,
      warning: error instanceof Error ? error.message : String(error) };
  }
}

async function cardModel(env, cardId) {
  return env.DB.prepare(`SELECT c.id card_id,c.expires_on,p.raw_name,p.normalized_name,p.display_name,p.redeem_place,p.specification
    FROM cards c JOIN product_master p ON p.id=c.product_id WHERE c.id=?`).bind(cardId).first();
}

export async function assignmentPreview(env, cardId, campaignId) {
  const campaign = await env.DB.prepare("SELECT * FROM vault_campaigns WHERE campaign_id=?").bind(campaignId).first();
  if (!campaign || campaign.is_archived) throw new VaultLedgerError("仕分け先キャンペーンが見つかりません", 404, "CAMPAIGN_NOT_FOUND");
  if (!['active', 'closing', 'correcting'].includes(campaign.status)) {
    throw new VaultLedgerError("終了済みキャンペーンへ新規仕分けはできません", 409, "CAMPAIGN_CLOSED");
  }
  const model = await cardModel(env, cardId);
  if (!model) throw new VaultLedgerError("カードが見つかりません", 404, "CARD_NOT_FOUND");
  const key = identityKey(model);
  const exact = await env.DB.prepare("SELECT * FROM ledger_products WHERE campaign_id=? AND identity_key=?")
    .bind(campaignId, key).first();
  const possibleRows = await env.DB.prepare(`SELECT product_id,product_name,redemption_place,product_spec,valid_until
    FROM ledger_products WHERE campaign_id=? AND identity_key<>? AND
    (lower(product_name)=lower(?) OR (COALESCE(redemption_place,'')=? AND COALESCE(product_spec,'')=? AND COALESCE(valid_until,'')=?))
    ORDER BY assigned_at LIMIT 20`).bind(campaignId, key, model.raw_name, model.redeem_place || "", model.specification || "", model.expires_on || "").all();
  const count = await env.DB.prepare(`SELECT COUNT(*) count FROM items i
    WHERE i.card_id=? AND i.status='active' AND NOT EXISTS
    (SELECT 1 FROM item_campaign_assignments a WHERE a.item_id=i.id)`).bind(cardId).first();
  return {
    campaign: { campaign_id: campaign.campaign_id, campaign_name: campaign.campaign_name,
      lottery_start_date: campaign.lottery_start_date, status: campaign.status },
    card: { id: model.card_id, product_name: model.raw_name, display_name: model.display_name,
      redemption_place: model.redeem_place || null, product_spec: model.specification || null,
      valid_until: model.expires_on || null, unassigned_count: Number(count?.count || 0) },
    exact_product: exact || null, possible_products: possibleRows.results || []
  };
}

function enqueueProductAndTotals(db, productId, campaignId, occurredAt) {
  const productRecord = `product:${productId}`;
  const totalsRecord = `totals:${campaignId}`;
  return [
    db.prepare(`INSERT INTO ledger_sync_series(source_record_id,current_revision,updated_at) VALUES (?,1,?)
      ON CONFLICT(source_record_id) DO UPDATE SET current_revision=current_revision+1,updated_at=excluded.updated_at`).bind(productRecord, occurredAt),
    db.prepare(`INSERT INTO ledger_outbox(id,source_record_id,source_revision,path,payload_json,status,created_at,updated_at)
      SELECT ?,?,s.current_revision,'/api/v1/products/sync',json_object(
        'source_system',?,'source_record_id',?,'source_revision',s.current_revision,'occurred_at',?,
        'data',json_object('product_id',p.product_id,'campaign_id',p.campaign_id,'product_name',p.product_name,
        'redemption_place',p.redemption_place,'product_spec',p.product_spec,'valid_until',p.valid_until,
        'current_winner_count',(SELECT COUNT(*) FROM item_campaign_assignments a JOIN items i ON i.id=a.item_id WHERE a.product_id=p.product_id AND i.status='active'),
        'assigned_at',p.assigned_at,'is_archived',json(CASE WHEN p.is_archived=1 THEN 'true' ELSE 'false' END))
      ),'pending',?,? FROM ledger_sync_series s JOIN ledger_products p ON p.product_id=? WHERE s.source_record_id=?`)
      .bind(uuid(), productRecord, SOURCE_SYSTEM, productRecord, occurredAt, occurredAt, occurredAt, productId, productRecord),
    db.prepare(`INSERT INTO ledger_sync_series(source_record_id,current_revision,updated_at) VALUES (?,1,?)
      ON CONFLICT(source_record_id) DO UPDATE SET current_revision=current_revision+1,updated_at=excluded.updated_at`).bind(totalsRecord, occurredAt),
    db.prepare(`INSERT INTO ledger_outbox(id,source_record_id,source_revision,path,payload_json,status,created_at,updated_at)
      SELECT ?,?,s.current_revision,'/api/v1/totals/sync',json_object(
        'source_system',?,'source_record_id',?,'source_revision',s.current_revision,'occurred_at',?,
        'data',json_object('campaign_id',?,'current_winner_count',
          (SELECT COUNT(*) FROM item_campaign_assignments a JOIN items i ON i.id=a.item_id WHERE a.campaign_id=? AND i.status='active'))
      ),'pending',?,? FROM ledger_sync_series s WHERE s.source_record_id=?`)
      .bind(uuid(), totalsRecord, SOURCE_SYSTEM, totalsRecord, occurredAt, campaignId, campaignId, occurredAt, occurredAt, totalsRecord)
  ];
}

function enqueueTotalsOnly(db, campaignId, occurredAt, outboxId) {
  const record = `totals:${campaignId}`;
  return [
    db.prepare(`INSERT INTO ledger_sync_series(source_record_id,current_revision,updated_at) VALUES (?,1,?)
      ON CONFLICT(source_record_id) DO UPDATE SET current_revision=current_revision+1,updated_at=excluded.updated_at`).bind(record, occurredAt),
    db.prepare(`INSERT INTO ledger_outbox(id,source_record_id,source_revision,path,payload_json,status,created_at,updated_at)
      SELECT ?,?,s.current_revision,'/api/v1/totals/sync',json_object(
        'source_system',?,'source_record_id',?,'source_revision',s.current_revision,'occurred_at',?,
        'data',json_object('campaign_id',?,'current_winner_count',
          (SELECT COUNT(*) FROM item_campaign_assignments a JOIN items i ON i.id=a.item_id
            WHERE a.campaign_id=? AND i.status='active'))
      ),'pending',?,? FROM ledger_sync_series s WHERE s.source_record_id=?`)
      .bind(outboxId, record, SOURCE_SYSTEM, record, occurredAt, campaignId, campaignId, occurredAt, occurredAt, record)
  ];
}

export async function assignCardToCampaign(env, cardId, campaignId, choice = {}) {
  const preview = await assignmentPreview(env, cardId, campaignId);
  if (!preview.card.unassigned_count) throw new VaultLedgerError("このカードに未仕分けURLはありません", 409, "NO_UNASSIGNED_ITEMS");
  let product = preview.exact_product;
  if (choice.product_id) {
    product = await env.DB.prepare("SELECT * FROM ledger_products WHERE product_id=? AND campaign_id=?")
      .bind(choice.product_id, campaignId).first();
    if (!product) throw new VaultLedgerError("選択した既存商品が見つかりません", 404, "PRODUCT_NOT_FOUND");
    if (preview.exact_product && product.product_id !== preview.exact_product.product_id) {
      throw new VaultLedgerError("完全一致の商品があるため、別の商品へ統合できません", 409, "EXACT_PRODUCT_EXISTS");
    }
  } else if (!product && preview.possible_products.length && choice.create_separate !== true) {
    throw new VaultLedgerError("似ている商品があります。同一商品か別商品かを選択してください", 409, "PRODUCT_DECISION_REQUIRED", {
      possible_products: preview.possible_products
    });
  }
  if (product && choice.create_separate === true && preview.exact_product) {
    throw new VaultLedgerError("完全一致の商品は別商品として重複登録できません", 409, "EXACT_PRODUCT_EXISTS");
  }
  const occurredAt = now();
  const statements = [];
  if (!product) {
    const model = await cardModel(env, cardId);
    const productId = uuid();
    statements.push(env.DB.prepare(`INSERT INTO ledger_products
      (product_id,campaign_id,card_id,product_name,redemption_place,product_spec,valid_until,identity_key,assigned_at,is_archived,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`).bind(productId, campaignId, cardId, model.raw_name,
      model.redeem_place || null, model.specification || null, model.expires_on || null, identityKey(model), occurredAt, occurredAt, occurredAt));
    product = { product_id: productId };
  }
  statements.push(env.DB.prepare(`INSERT OR IGNORE INTO item_campaign_assignments(item_id,campaign_id,product_id,assigned_at)
    SELECT i.id,?,?,? FROM items i WHERE i.card_id=? AND i.status='active'
    AND NOT EXISTS(SELECT 1 FROM item_campaign_assignments a WHERE a.item_id=i.id)`)
    .bind(campaignId, product.product_id, occurredAt, cardId));
  statements.push(...enqueueProductAndTotals(env.DB, product.product_id, campaignId, occurredAt));
  await env.DB.batch(statements);
  const assigned = await env.DB.prepare("SELECT COUNT(*) count FROM item_campaign_assignments WHERE product_id=?")
    .bind(product.product_id).first();
  return { product_id: product.product_id, campaign_id: campaignId, assigned_count: Number(assigned?.count || 0),
    reused: Boolean(preview.exact_product || choice.product_id) };
}

export async function cardAssignments(env) {
  const rows = await env.DB.prepare(`SELECT p.*,i.card_id,c.campaign_name,c.lottery_start_date,c.status campaign_status,
    (SELECT COUNT(*) FROM item_campaign_assignments a JOIN items i ON i.id=a.item_id
      WHERE a.product_id=p.product_id AND i.status='active') current_winner_count,
    (SELECT o.status FROM ledger_outbox o WHERE o.source_record_id='product:'||p.product_id
      ORDER BY o.source_revision DESC LIMIT 1) sync_status,
    (SELECT o.last_error FROM ledger_outbox o WHERE o.source_record_id='product:'||p.product_id
      ORDER BY o.source_revision DESC LIMIT 1) sync_error
    FROM ledger_products p JOIN item_campaign_assignments a ON a.product_id=p.product_id
    JOIN items i ON i.id=a.item_id LEFT JOIN vault_campaigns c ON c.campaign_id=p.campaign_id
    GROUP BY i.card_id,p.product_id ORDER BY p.assigned_at DESC`).all();
  const byCard = new Map();
  for (const row of rows.results || []) {
    const list = byCard.get(row.card_id) || [];
    list.push({ ...row, is_archived: Boolean(row.is_archived) });
    byCard.set(row.card_id, list);
  }
  return byCard;
}

export async function enrichCards(env, cards) {
  const assignments = await cardAssignments(env);
  for (const card of cards) {
    const row = await env.DB.prepare(`SELECT COUNT(*) count FROM items i WHERE i.card_id=? AND i.status='active'
      AND NOT EXISTS(SELECT 1 FROM item_campaign_assignments a WHERE a.item_id=i.id)`).bind(card.id).first();
    card.unassigned_count = Number(row?.count || 0);
    card.assignments = assignments.get(card.id) || [];
  }
  return cards;
}

async function updateOutboxFailure(env, row, error) {
  const attempts = Number(row.attempts || 0) + 1;
  const retryable = error.status >= 500 || error.code === "DEPENDENCY_NOT_READY" || error.code === "CONCURRENT_MODIFICATION";
  const delay = RETRY_SECONDS[Math.min(attempts - 1, RETRY_SECONDS.length - 1)];
  const nextAttempt = retryable ? new Date(Date.now() + delay * 1000).toISOString() : null;
  const message = `${error.code || "LEDGER_ERROR"}: ${error.message || String(error)}`.slice(0, 500);
  await env.DB.prepare(`UPDATE ledger_outbox SET status='failed',attempts=?,next_attempt_at=?,last_error=?,updated_at=? WHERE id=?`)
    .bind(attempts, nextAttempt, message, now(), row.id).run();
  return { id: row.id, ok: false, retryable: Boolean(nextAttempt), error: message };
}

export async function processOutbox(env, options = {}) {
  const limit = Math.min(50, Math.max(1, Number(options.limit || 25)));
  const due = options.id
    ? await env.DB.prepare("SELECT * FROM ledger_outbox WHERE id=? AND status!='sent'").bind(options.id).all()
    : await env.DB.prepare(`SELECT * FROM ledger_outbox WHERE status!='sent'
      AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at,source_revision LIMIT ?`).bind(now(), limit).all();
  const results = [];
  const blocked = new Set();
  for (const row of due.results || []) {
    if (blocked.has(row.source_record_id)) continue;
    const prior = await env.DB.prepare(`SELECT 1 blocked FROM ledger_outbox WHERE source_record_id=? AND source_revision<? AND status!='sent' LIMIT 1`)
      .bind(row.source_record_id, row.source_revision).first();
    if (prior) { blocked.add(row.source_record_id); continue; }
    try {
      const payload = JSON.parse(row.payload_json);
      const response = await callLedger(env, "vault", row.path, { method: row.method, body: payload });
      await env.DB.prepare(`UPDATE ledger_outbox SET status='sent',attempts=attempts+1,next_attempt_at=NULL,last_error=NULL,
        ledger_result=?,sent_at=?,updated_at=? WHERE id=?`).bind(response.result || "applied", now(), now(), row.id).run();
      results.push({ id: row.id, ok: true, result: response.result || "applied" });
    } catch (error) {
      results.push(await updateOutboxFailure(env, row, error));
      blocked.add(row.source_record_id);
    }
  }
  return { attempted: results.length, results };
}

export async function outboxStatus(env) {
  const counts = await env.DB.prepare(`SELECT
    SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
    SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) sent FROM ledger_outbox`).first();
  const errors = await env.DB.prepare(`SELECT id,source_record_id,source_revision,last_error,next_attempt_at,updated_at
    FROM ledger_outbox WHERE status='failed' ORDER BY updated_at DESC LIMIT 20`).all();
  return { pending: Number(counts?.pending || 0), failed: Number(counts?.failed || 0), sent: Number(counts?.sent || 0), errors: errors.results || [] };
}

export async function retryOutbox(env) {
  await env.DB.prepare("UPDATE ledger_outbox SET status='pending',next_attempt_at=NULL,updated_at=? WHERE status='failed'").bind(now()).run();
  return processOutbox(env, { limit: 50 });
}

export async function ensureCampaignTotals(env, campaignId) {
  const campaign = await env.DB.prepare("SELECT status FROM vault_campaigns WHERE campaign_id=?").bind(campaignId).first();
  if (!campaign) throw new VaultLedgerError("キャンペーンが見つかりません", 404, "CAMPAIGN_NOT_FOUND");
  const record = `totals:${campaignId}`;
  let latest = await env.DB.prepare(`SELECT * FROM ledger_outbox WHERE source_record_id=?
    ORDER BY source_revision DESC LIMIT 1`).bind(record).first();
  if (!latest) {
    const outboxId = uuid();
    const occurredAt = now();
    await env.DB.batch(enqueueTotalsOnly(env.DB, campaignId, occurredAt, outboxId));
    latest = await env.DB.prepare("SELECT * FROM ledger_outbox WHERE id=?").bind(outboxId).first();
  }
  if (latest?.status !== "sent") {
    await env.DB.prepare("UPDATE ledger_outbox SET status='pending',next_attempt_at=NULL,updated_at=? WHERE id=?")
      .bind(now(), latest.id).run();
    const delivery = await processOutbox(env, { id: latest.id });
    if (!delivery.results[0]?.ok) {
      throw new VaultLedgerError("当選数を中央管理台帳へ同期できませんでした。自動再送します", 503,
        "TOTALS_SYNC_PENDING", { delivery: delivery.results[0] || null });
    }
  }
  return { campaign_id: campaignId, ready: true };
}

export async function closePreview(env, campaignId) {
  await ensureCampaignTotals(env, campaignId);
  return callLedger(env, "vault", `/api/v1/campaigns/${encodeURIComponent(campaignId)}/close-preview`);
}

async function enqueueLifecycle(env, campaignId, path, data) {
  const record = `lifecycle:${campaignId}`;
  const occurredAt = now();
  const outboxId = uuid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO ledger_sync_series(source_record_id,current_revision,updated_at) VALUES (?,1,?)
      ON CONFLICT(source_record_id) DO UPDATE SET current_revision=current_revision+1,updated_at=excluded.updated_at`).bind(record, occurredAt),
    env.DB.prepare(`INSERT INTO ledger_outbox(id,source_record_id,source_revision,path,payload_json,status,created_at,updated_at)
      SELECT ?,?,current_revision,?,json_object('source_system',?,'source_record_id',?,
        'source_revision',current_revision,'occurred_at',?,'data',json(?)),'pending',?,?
      FROM ledger_sync_series WHERE source_record_id=?`).bind(outboxId, record, path, SOURCE_SYSTEM, record,
      occurredAt, JSON.stringify(data), occurredAt, occurredAt, record)
  ]);
  return outboxId;
}

export async function closeCampaign(env, campaignId, acceptMismatch) {
  const preview = await closePreview(env, campaignId);
  if (preview.has_mismatch && acceptMismatch !== true) {
    throw new VaultLedgerError("総当選数と商品別合計に差分があります", 409, "MISMATCH_CONFIRMATION_REQUIRED", preview);
  }
  const outboxId = await enqueueLifecycle(env, campaignId, `/api/v1/campaigns/${campaignId}/close`, {
    preview_token: preview.preview_token,
    final_winner_count: preview.final_winner_count,
    products: (preview.products || []).map(product => ({ product_id: product.product_id, final_winner_count: product.final_winner_count })),
    confirm: true,
    accept_mismatch: acceptMismatch === true
  });
  const delivery = await processOutbox(env, { id: outboxId });
  if (delivery.results[0]?.ok) await refreshCampaigns(env);
  return { preview, delivery: delivery.results[0] || { ok: false } };
}

export async function startCorrection(env, campaignId, reason) {
  const cleanReason = safeText(reason);
  if (!cleanReason || cleanReason.length > 500) throw new VaultLedgerError("訂正理由を入力してください", 400, "INVALID_REASON");
  const campaign = await env.DB.prepare("SELECT status FROM vault_campaigns WHERE campaign_id=?").bind(campaignId).first();
  if (campaign?.status !== "closed") throw new VaultLedgerError("終了済みキャンペーンだけ訂正を開始できます", 409, "INVALID_TRANSITION");
  const outboxId = await enqueueLifecycle(env, campaignId, `/api/v1/campaigns/${campaignId}/corrections`, { reason: cleanReason });
  const delivery = await processOutbox(env, { id: outboxId });
  if (delivery.results[0]?.ok) await refreshCampaigns(env);
  return { delivery: delivery.results[0] || { ok: false } };
}
