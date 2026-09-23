import {
  classifyValue, codeCard, extractInputValues, isGenericName, normalizeAnalysis,
  normalizeName, normalizeRedeemPlace, normalizeSpecification, stableJson
} from "./core.js";

const VERSION = "0.4.0";
const ANALYSIS_BATCH_SIZE = 10;
const SESSION_COOKIE = "wuv_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const encoder = new TextEncoder();
const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...securityHeaders }
});
const nowSql = () => new Date().toISOString();
const id = () => crypto.randomUUID();

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes) {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function safeEqual(left, right) {
  const a = encoder.encode(String(left || ""));
  const b = encoder.encode(String(right || ""));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}

async function sha256(value) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function cookieValue(request, name) {
  const source = request.headers.get("cookie") || "";
  for (const part of source.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

async function authenticated(request, env) {
  if (!env.SESSION_SECRET || !env.ACCESS_PASSWORD_SHA256) return false;
  const token = cookieValue(request, SESSION_COOKIE);
  const [expiryText, signature] = token.split(".");
  const expiry = Number(expiryText);
  if (!expiry || expiry <= Math.floor(Date.now() / 1000) || !signature) return false;
  return safeEqual(signature, await sign(expiryText, env.SESSION_SECRET));
}

async function loginIdentifier(request, env) {
  const address = request.headers.get("cf-connecting-ip") || "local";
  return sha256(`${env.SESSION_SECRET}:${address}`);
}

async function login(request, env) {
  if (!env.ACCESS_PASSWORD_SHA256 || !env.SESSION_SECRET) {
    return json({ ok: false, error: "ログイン設定が未完了です" }, 503);
  }
  const identifier = await loginIdentifier(request, env);
  const row = await env.DB.prepare("SELECT attempts,blocked_until,window_started FROM auth_rate_limits WHERE identifier_hash=?")
    .bind(identifier).first();
  const now = Date.now();
  if (row?.blocked_until && Date.parse(row.blocked_until) > now) {
    return json({ ok: false, error: "ログイン試行が多すぎます。15分後に再度お試しください" }, 429);
  }
  const body = await request.json().catch(() => ({}));
  const passwordHash = await sha256(String(body.password || ""));
  if (!safeEqual(passwordHash, env.ACCESS_PASSWORD_SHA256)) {
    const windowStarted = row?.window_started && now - Date.parse(row.window_started) < 15 * 60 * 1000
      ? row.window_started : new Date(now).toISOString();
    const attempts = windowStarted === row?.window_started ? Number(row?.attempts || 0) + 1 : 1;
    const blockedUntil = attempts >= 5 ? new Date(now + 15 * 60 * 1000).toISOString() : null;
    await env.DB.prepare(`INSERT INTO auth_rate_limits (identifier_hash,attempts,window_started,blocked_until,updated_at)
      VALUES (?,?,?,?,?) ON CONFLICT(identifier_hash) DO UPDATE SET attempts=excluded.attempts,
      window_started=excluded.window_started,blocked_until=excluded.blocked_until,updated_at=excluded.updated_at`)
      .bind(identifier, attempts, windowStarted, blockedUntil, new Date(now).toISOString()).run();
    return json({ ok: false, error: attempts >= 5 ? "ログイン試行が多すぎます。15分後に再度お試しください" : "アクセスパスワードが違います" }, attempts >= 5 ? 429 : 401);
  }
  await env.DB.prepare("DELETE FROM auth_rate_limits WHERE identifier_hash=?").bind(identifier).run();
  const expiry = Math.floor(now / 1000) + SESSION_SECONDS;
  const signature = await sign(String(expiry), env.SESSION_SECRET);
  const response = json({ ok: true, authenticated: true, mode: env.OPERATION_MODE || "trial" });
  response.headers.append("set-cookie", `${SESSION_COOKIE}=${expiry}.${signature}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`);
  return response;
}

function logout(env) {
  const response = json({ ok: true, authenticated: false, mode: env.OPERATION_MODE || "trial" });
  response.headers.append("set-cookie", `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`);
  return response;
}

function protectedAsset(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function patternKey(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return "unknown-input"; }
}

async function audit(env, itemId, action, detail = {}) {
  await env.DB.prepare("INSERT INTO audit_log (id,item_id,action,detail) VALUES (?,?,?,?)")
    .bind(id(), itemId || null, action, JSON.stringify(detail)).run();
}

async function markUnresolved(env, item, reason, lastError = "") {
  await env.DB.batch([
    env.DB.prepare("UPDATE items SET status='unresolved',card_id=NULL,pending_id=NULL,analyzed_at=? WHERE id=?")
      .bind(nowSql(), item.id),
    env.DB.prepare(`INSERT INTO unresolved_items (item_id,reason,pattern_key,last_error,updated_at)
      VALUES (?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET reason=excluded.reason,pattern_key=excluded.pattern_key,
      last_error=excluded.last_error,updated_at=excluded.updated_at`)
      .bind(item.id, reason, patternKey(item.value), lastError || null, nowSql())
  ]);
  await audit(env, item.id, "unresolved", { reason });
  return { id: item.id, status: "unresolved", reason };
}

async function assignCard(env, itemId, cardId, analysis = null) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE items SET status='active',card_id=?,pending_id=NULL,analysis_json=COALESCE(?,analysis_json),
      analyzed_at=?,classified_at=? WHERE id=?`).bind(cardId, analysis ? JSON.stringify(analysis) : null, nowSql(), nowSql(), itemId),
    env.DB.prepare("DELETE FROM unresolved_items WHERE item_id=?").bind(itemId)
  ]);
  await audit(env, itemId, "classified", { cardId });
  return { id: itemId, status: "active", cardId };
}

async function ensureCodeCard(env, type) {
  const model = codeCard(type);
  if (!model) return null;
  const requiredConditions = stableJson(model.conditions);
  const matchKey = [normalizeName(model.normalizedName), normalizeSpecification(model.specification),
    normalizeRedeemPlace(model.redeemPlace), requiredConditions].join("\u001f");
  let product = await env.DB.prepare("SELECT id FROM product_master WHERE match_key=? AND confirmed=1").bind(matchKey).first();
  if (!product) {
    const productId = id();
    await env.DB.prepare(`INSERT OR IGNORE INTO product_master
      (id,source_type,raw_name,normalized_name,display_name,redeem_place,specification,required_conditions,match_key,confirmed)
      VALUES (?,?,?,?,?,?,?,?,?,1)`).bind(productId, model.sourceType, model.rawName, normalizeName(model.normalizedName),
        model.displayName, normalizeRedeemPlace(model.redeemPlace), normalizeSpecification(model.specification), requiredConditions, matchKey).run();
    product = await env.DB.prepare("SELECT id FROM product_master WHERE match_key=? AND confirmed=1").bind(matchKey).first();
  }
  let card = await env.DB.prepare("SELECT id FROM cards WHERE product_id=? AND expires_on='' ").bind(product.id).first();
  if (!card) {
    const cardId = id();
    await env.DB.prepare("INSERT OR IGNORE INTO cards (id,product_id,expires_on,locked) VALUES (?,?,'',1)").bind(cardId, product.id).run();
    card = await env.DB.prepare("SELECT id FROM cards WHERE product_id=? AND expires_on='' ").bind(product.id).first();
  }
  return card.id;
}

async function analyzerRequest(env, values, options = {}) {
  if (!values.length) return [];
  const request = new Request("https://coupon-analyzer.internal/api/analyze-detail", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: values.map((value, index) => ({ label: String(index + 1), url: value })),
      mode: "stable", renderImage: options.renderImage === true })
  });
  let response;
  if (env.COUPON_ANALYZER?.fetch) response = await env.COUPON_ANALYZER.fetch(request);
  else if (env.ANALYZER_BASE_URL) response = await fetch(new Request(new URL("/api/analyze-detail", env.ANALYZER_BASE_URL), request));
  else throw new Error("Coupon Analyzer Service Bindingが未設定です");
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Analyzer HTTP ${response.status}`);
  if (!Array.isArray(payload.results)) throw new Error("Analyzerの応答形式が不正です");
  return payload.results;
}

async function processAnalysis(env, item, result) {
  const normalized = normalizeAnalysis(result);
  const analysisJson = JSON.stringify(result);
  if (!normalized.valid) {
    await env.DB.prepare("UPDATE items SET analysis_json=?,analyzed_at=? WHERE id=?")
      .bind(analysisJson, nowSql(), item.id).run();
    return markUnresolved(env, item, normalized.reason, result?.message || "");
  }

  const existing = await env.DB.prepare(`SELECT c.id card_id FROM product_master p
    JOIN cards c ON c.product_id=p.id WHERE p.match_key=? AND p.confirmed=1 AND c.expires_on=? LIMIT 1`)
    .bind(normalized.matchKey, normalized.expiresOn).first();
  if (existing) return assignCard(env, item.id, existing.card_id, result);

  let pending = await env.DB.prepare("SELECT id,image_data_uri FROM pending_confirmations WHERE match_key=? AND expires_on=?")
    .bind(normalized.matchKey, normalized.expiresOn).first();
  let createdPending = false;
  if (!pending) {
    const pendingId = id();
    const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO pending_confirmations
      (id,match_key,expires_on,source_type,raw_name,normalized_name,display_name,redeem_place,specification,
       required_conditions,image_data_uri,analysis_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(pendingId, normalized.matchKey, normalized.expiresOn, "url", normalized.rawName, normalized.normalizedName,
        normalized.displayName, normalized.redeemPlace, normalized.specification, normalized.requiredConditions,
        normalized.imageDataUri, analysisJson).run();
    createdPending = Number(inserted.meta?.changes || 0) > 0;
    pending = await env.DB.prepare("SELECT id,image_data_uri FROM pending_confirmations WHERE match_key=? AND expires_on=?")
      .bind(normalized.matchKey, normalized.expiresOn).first();
    if (!pending) {
      const confirmedDuringAnalysis = await env.DB.prepare(`SELECT c.id card_id FROM product_master p
        JOIN cards c ON c.product_id=p.id WHERE p.match_key=? AND p.confirmed=1 AND c.expires_on=? LIMIT 1`)
        .bind(normalized.matchKey, normalized.expiresOn).first();
      if (confirmedDuringAnalysis) return assignCard(env, item.id, confirmedDuringAnalysis.card_id, result);
      return markUnresolved(env, item, "確認候補グループを作成できませんでした");
    }
  } else if (!pending.image_data_uri && normalized.imageDataUri) {
    await env.DB.prepare("UPDATE pending_confirmations SET image_data_uri=?,analysis_json=? WHERE id=?")
      .bind(normalized.imageDataUri, analysisJson, pending.id).run();
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE items SET status='pending_confirmation',pending_id=?,card_id=NULL,analysis_json=?,analyzed_at=? WHERE id=?")
      .bind(pending.id, analysisJson, nowSql(), item.id),
    env.DB.prepare("DELETE FROM unresolved_items WHERE item_id=?").bind(item.id)
  ]);
  await audit(env, item.id, "pending_confirmation", { pendingId: pending.id });
  return { id: item.id, status: "pending_confirmation", pendingId: pending.id,
    needsImage: createdPending && !pending.image_data_uri };
}

async function processUrlChunk(env, items) {
  if (!items.length) return [];
  let results;
  try { results = await analyzerRequest(env, items.map(item => item.value)); }
  catch (error) {
    return Promise.all(items.map(item => markUnresolved(env, item, "Coupon Analyzerで解析できませんでした", error.message)));
  }
  const byUrl = new Map(results.filter(result => result?.url).map(result => [result.url, result]));
  const byLabel = new Map(results.filter(result => result?.label).map(result => [String(result.label), result]));
  const output = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const labelled = byLabel.get(String(index + 1));
    const result = byUrl.get(item.value) || (labelled?.url === item.value ? labelled : null);
    output.push(result
      ? await processAnalysis(env, item, result)
      : await markUnresolved(env, item, "AnalyzerがURLを対応対象として認識しませんでした"));
  }
  return output;
}

async function processUrls(env, items) {
  const output = [];
  for (let start = 0; start < items.length; start += 10) {
    output.push(...await processUrlChunk(env, items.slice(start, start + 10)));
  }
  return output;
}

async function findExistingCanonicals(env, values) {
  const existing = new Set();
  for (let start = 0; start < values.length; start += 50) {
    const chunk = values.slice(start, start + 50);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(`SELECT canonical_value FROM items WHERE canonical_value IN (${placeholders})`)
      .bind(...chunk).all();
    for (const row of rows.results || []) existing.add(row.canonical_value);
  }
  return existing;
}

async function jobSummary(env, jobId) {
  const job = await env.DB.prepare("SELECT * FROM analysis_jobs WHERE id=?").bind(jobId).first();
  if (!job) return null;
  const counts = await env.DB.prepare(`SELECT
    COUNT(*) accepted,
    COALESCE(SUM(CASE WHEN ji.state='queued' THEN 1 ELSE 0 END),0) queued,
    COALESCE(SUM(CASE WHEN ji.state='processing' THEN 1 ELSE 0 END),0) processing,
    COALESCE(SUM(CASE WHEN ji.state='done' THEN 1 ELSE 0 END),0) processed,
    COALESCE(SUM(CASE WHEN ji.state='done' AND i.status='active' THEN 1 ELSE 0 END),0) active,
    COALESCE(SUM(CASE WHEN ji.state='done' AND i.status='pending_confirmation' THEN 1 ELSE 0 END),0) pending_confirmation,
    COALESCE(SUM(CASE WHEN ji.state='done' AND i.status='unresolved' THEN 1 ELSE 0 END),0) unresolved
    FROM analysis_job_items ji JOIN items i ON i.id=ji.item_id WHERE ji.job_id=?`).bind(jobId).first();
  const accepted = Number(counts?.accepted || 0);
  const processed = Number(counts?.processed || 0);
  const pending = Number(counts?.pending_confirmation || 0);
  let status = job.status;
  if (processed >= accepted) status = pending ? "awaiting_confirmation" : "completed";
  else if (Number(counts?.processing || 0) > 0) status = "processing";
  else if (accepted > 0) status = "queued";
  return {
    id: job.id, clientRequestId: job.client_request_id, status,
    inputTotal: Number(job.input_total || 0), inputDuplicates: Number(job.input_duplicates || 0),
    existing: Number(job.existing_count || 0), accepted,
    queued: Number(counts?.queued || 0), processing: Number(counts?.processing || 0), processed,
    active: Number(counts?.active || 0), pendingConfirmation: pending,
    unresolved: Number(counts?.unresolved || 0), lastError: job.last_error || "",
    createdAt: job.created_at, completedAt: job.completed_at
  };
}

async function finishJobIfComplete(env, jobId) {
  const remaining = await env.DB.prepare(`SELECT COUNT(*) count FROM analysis_job_items
    WHERE job_id=? AND state!='done'`).bind(jobId).first();
  const complete = Number(remaining?.count || 0) === 0;
  await env.DB.prepare(`UPDATE analysis_jobs SET status=?,completed_at=CASE WHEN ? THEN COALESCE(completed_at,?) ELSE NULL END,
    updated_at=? WHERE id=?`).bind(complete ? "completed" : "processing", complete ? 1 : 0, nowSql(), nowSql(), jobId).run();
  return complete;
}

async function processJobBatch(env, jobId) {
  const rows = await env.DB.prepare(`SELECT ji.item_id,i.id,i.value,i.canonical_value,i.value_type
    FROM analysis_job_items ji JOIN items i ON i.id=ji.item_id
    WHERE ji.job_id=? AND ji.state='queued' ORDER BY ji.ordinal LIMIT ?`)
    .bind(jobId, ANALYSIS_BATCH_SIZE).all();
  const items = rows.results || [];
  if (!items.length) return finishJobIfComplete(env, jobId);

  const claimedAt = nowSql();
  await env.DB.batch([
    env.DB.prepare("UPDATE analysis_jobs SET status='processing',started_at=COALESCE(started_at,?),updated_at=?,last_error=NULL WHERE id=?")
      .bind(claimedAt, claimedAt, jobId),
    ...items.map(item => env.DB.prepare("UPDATE analysis_job_items SET state='processing',updated_at=? WHERE job_id=? AND item_id=? AND state='queued'")
      .bind(claimedAt, jobId, item.id))
  ]);

  try {
    const output = [];
    const urls = [];
    for (const item of items) {
      if (item.value_type === "url") urls.push(item);
      else if (["cokeon", "paypay"].includes(item.value_type)) {
        const cardId = await ensureCodeCard(env, item.value_type);
        output.push(await assignCard(env, item.id, cardId));
      } else output.push(await markUnresolved(env, item, "未対応の入力形式"));
    }
    output.push(...await processUrlChunk(env, urls));
    await env.DB.batch(items.map(item => env.DB.prepare("UPDATE analysis_job_items SET state='done',updated_at=? WHERE job_id=? AND item_id=?")
      .bind(nowSql(), jobId, item.id)));

    const pendingForImage = [...new Set(output.filter(item => item.needsImage && item.pendingId).map(item => item.pendingId))];
    for (const pendingId of pendingForImage) {
      try { await reanalyzePending(env, pendingId); } catch (error) { console.warn("pending image", error); }
    }

    const complete = await finishJobIfComplete(env, jobId);
    if (!complete && env.ANALYSIS_QUEUE?.send) await env.ANALYSIS_QUEUE.send({ jobId });
    return complete;
  } catch (error) {
    await env.DB.batch([
      ...items.map(item => env.DB.prepare("UPDATE analysis_job_items SET state='queued',updated_at=? WHERE job_id=? AND item_id=?")
        .bind(nowSql(), jobId, item.id)),
      env.DB.prepare("UPDATE analysis_jobs SET status='queued',last_error=?,updated_at=? WHERE id=?")
        .bind(error instanceof Error ? error.message : String(error), nowSql(), jobId)
    ]);
    throw error;
  }
}

async function processJobFully(env, jobId) {
  for (let index = 0; index < 1000; index += 1) {
    if (await processJobBatch(env, jobId)) return;
  }
  throw new Error("解析ジョブの件数が上限を超えました");
}

async function receive(request, env) {
  const body = await request.json().catch(() => ({}));
  const values = extractInputValues(body);
  if (!values.length) return json({ ok: false, error: "URLまたはコードを入力してください" }, 400);
  if (values.length >= 5000) return json({ ok: false, error: "1回に送信できる上限は4,999件です" }, 413);
  const clientRequestId = /^[0-9a-f-]{16,64}$/i.test(String(body.clientRequestId || ""))
    ? String(body.clientRequestId) : id();
  const previous = await env.DB.prepare("SELECT id,status FROM analysis_jobs WHERE client_request_id=?")
    .bind(clientRequestId).first();
  if (previous) return json({ ok: true, resumed: true, job: await jobSummary(env, previous.id) });

  const unique = [];
  const seen = new Set();
  let inputDuplicates = 0;
  for (const raw of values) {
    const classified = classifyValue(raw, env.COKEON_REDEEM_BASE_URL);
    if (!classified) continue;
    if (seen.has(classified.canonicalValue)) { inputDuplicates += 1; continue; }
    seen.add(classified.canonicalValue);
    unique.push(classified);
  }
  const existingCanonicals = await findExistingCanonicals(env, unique.map(item => item.canonicalValue));
  const accepted = unique.filter(item => !existingCanonicals.has(item.canonicalValue))
    .map((item, ordinal) => ({ ...item, id: id(), ordinal }));
  const jobId = id();
  await env.DB.prepare(`INSERT INTO analysis_jobs
    (id,client_request_id,input_total,input_duplicates,existing_count,accepted_count,status,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).bind(jobId, clientRequestId, values.length, inputDuplicates,
      existingCanonicals.size, accepted.length, accepted.length ? "queued" : "completed", nowSql()).run();
  for (let start = 0; start < accepted.length; start += 40) {
    const chunk = accepted.slice(start, start + 40);
    await env.DB.batch(chunk.flatMap(item => [
      env.DB.prepare(`INSERT INTO items (id,value,canonical_value,value_type,status) VALUES (?,?,?,?, 'queued')`)
        .bind(item.id, item.storedValue, item.canonicalValue, item.type),
      env.DB.prepare("INSERT INTO analysis_job_items (job_id,item_id,ordinal,state,updated_at) VALUES (?,?,?,'queued',?)")
        .bind(jobId, item.id, item.ordinal, nowSql())
    ]));
  }
  if (!accepted.length) {
    await env.DB.prepare("UPDATE analysis_jobs SET completed_at=?,updated_at=? WHERE id=?").bind(nowSql(), nowSql(), jobId).run();
  } else if (env.ANALYSIS_QUEUE?.send) {
    await env.ANALYSIS_QUEUE.send({ jobId });
  } else {
    await processJobFully(env, jobId);
  }
  const summary = await jobSummary(env, jobId);
  return json({ ok: true, received: accepted.length, duplicate: inputDuplicates + existingCanonicals.size,
    inputDuplicate: inputDuplicates, existing: existingCanonicals.size,
    counts: { active: summary.active, pending_confirmation: summary.pendingConfirmation, unresolved: summary.unresolved },
    job: summary }, 202);
}

async function retryUnresolved(env) {
  const rows = await env.DB.prepare(`SELECT i.id,i.value,i.canonical_value,i.value_type,u.retry_count
    FROM unresolved_items u JOIN items i ON i.id=u.item_id ORDER BY u.updated_at ASC LIMIT 100`).all();
  const items = rows.results || [];
  const urlItems = []; const output = [];
  for (const item of items) {
    await env.DB.prepare("UPDATE unresolved_items SET retry_count=retry_count+1,updated_at=? WHERE item_id=?")
      .bind(nowSql(), item.id).run();
    const classified = classifyValue(item.value, env.COKEON_REDEEM_BASE_URL);
    if (classified && ["cokeon", "paypay"].includes(classified.type)) {
      const cardId = await ensureCodeCard(env, classified.type);
      output.push(await assignCard(env, item.id, cardId));
    } else if (classified?.type === "url") urlItems.push(item);
    else output.push(await markUnresolved(env, item, classified?.reason || "未対応の入力形式"));
  }
  output.push(...await processUrls(env, urlItems));
  return json({ ok: true, retried: items.length, resolved: output.filter(item => item.status !== "unresolved").length, items: output });
}

async function confirmPending(request, env, pendingId) {
  const body = await request.json().catch(() => ({}));
  const pending = await env.DB.prepare("SELECT * FROM pending_confirmations WHERE id=?").bind(pendingId).first();
  if (!pending) return json({ ok: false, error: "確認待ちデータが見つかりません" }, 404);
  const itemRows = await env.DB.prepare("SELECT id,value FROM items WHERE pending_id=? AND status='pending_confirmation'").bind(pendingId).all();
  const items = itemRows.results || [];
  if (body.action === "cancel") {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO unresolved_items (item_id,reason,pattern_key,updated_at)
        SELECT id,'初回確認でキャンセルされました','confirmation-cancelled',? FROM items
        WHERE pending_id=? AND status='pending_confirmation'
        ON CONFLICT(item_id) DO UPDATE SET reason=excluded.reason,pattern_key=excluded.pattern_key,updated_at=excluded.updated_at`)
        .bind(nowSql(), pendingId),
      env.DB.prepare("UPDATE items SET status='unresolved',pending_id=NULL WHERE pending_id=? AND status='pending_confirmation'")
        .bind(pendingId),
      env.DB.prepare("DELETE FROM pending_confirmations WHERE id=?").bind(pendingId)
    ]);
    await audit(env, null, "confirmation_group_cancelled", { pendingId, count: items.length });
    return json({ ok: true, action: "cancel", movedToUnresolved: items.length });
  }
  if (!["ok", "edit"].includes(body.action)) return json({ ok: false, error: "actionは ok / edit / cancel のいずれかです" }, 400);

  const rawName = String(body.raw_name ?? pending.raw_name).normalize("NFKC").replace(/\s+/g, " ").trim();
  const normalizedName = normalizeName(body.normalized_name ?? rawName);
  const displayName = String(body.display_name ?? pending.display_name).normalize("NFKC").trim().slice(0, 64);
  const redeemPlace = normalizeRedeemPlace(body.redeem_place ?? pending.redeem_place);
  const specification = normalizeSpecification(body.specification ?? pending.specification);
  const expiresOn = String(body.expires_on ?? pending.expires_on).trim();
  let conditions;
  try { conditions = typeof body.required_conditions === "string" ? JSON.parse(body.required_conditions) : (body.required_conditions ?? JSON.parse(pending.required_conditions)); }
  catch { return json({ ok: false, error: "必要条件のJSONが正しくありません" }, 400); }
  const requiredConditions = stableJson(conditions);
  if (isGenericName(rawName)) return json({ ok: false, error: "汎用名は確定できません。正式商品名へ修正してください" }, 400);
  if (!normalizedName || !displayName || !redeemPlace || !/^20\d{2}-\d{2}-\d{2}$/.test(expiresOn)) {
    return json({ ok: false, error: "商品名・表示名・利用先・使用期限を確認してください" }, 400);
  }
  const matchKey = [normalizedName, specification, redeemPlace, requiredConditions].join("\u001f");
  let product = await env.DB.prepare("SELECT id FROM product_master WHERE match_key=? AND confirmed=1").bind(matchKey).first();
  if (!product) {
    const productId = id();
    await env.DB.prepare(`INSERT OR IGNORE INTO product_master
      (id,source_type,raw_name,normalized_name,display_name,redeem_place,specification,required_conditions,match_key,image_data_uri,confirmed)
      VALUES (?,?,?,?,?,?,?,?,?,?,1)`).bind(productId, pending.source_type, rawName, normalizedName, displayName, redeemPlace,
        specification, requiredConditions, matchKey, pending.image_data_uri).run();
    product = await env.DB.prepare("SELECT id FROM product_master WHERE match_key=? AND confirmed=1").bind(matchKey).first();
  } else {
    await env.DB.prepare("UPDATE product_master SET display_name=?,updated_at=? WHERE id=?")
      .bind(displayName, nowSql(), product.id).run();
  }
  let card = await env.DB.prepare("SELECT id FROM cards WHERE product_id=? AND expires_on=?").bind(product.id, expiresOn).first();
  if (!card) {
    const cardId = id();
    await env.DB.prepare("INSERT OR IGNORE INTO cards (id,product_id,expires_on,locked) VALUES (?,?,?,1)")
      .bind(cardId, product.id, expiresOn).run();
    card = await env.DB.prepare("SELECT id FROM cards WHERE product_id=? AND expires_on=?").bind(product.id, expiresOn).first();
  }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM unresolved_items WHERE item_id IN
      (SELECT id FROM items WHERE pending_id=? AND status='pending_confirmation')`).bind(pendingId),
    env.DB.prepare(`UPDATE items SET status='active',card_id=?,pending_id=NULL,classified_at=?
      WHERE pending_id=? AND status='pending_confirmation'`).bind(card.id, nowSql(), pendingId),
    env.DB.prepare("DELETE FROM pending_confirmations WHERE id=?").bind(pendingId)
  ]);
  await audit(env, null, "confirmation_group_approved", { pendingId, cardId: card.id,
    edited: body.action === "edit", count: items.length });
  return json({ ok: true, action: body.action, productId: product.id, cardId: card.id, classified: items.length });
}

async function listCards(env) {
  const rows = await env.DB.prepare(`SELECT c.id,c.expires_on,p.display_name,p.raw_name,p.redeem_place,p.specification,
    COUNT(i.id) count FROM cards c JOIN product_master p ON p.id=c.product_id
    LEFT JOIN items i ON i.card_id=c.id AND i.status='active'
    GROUP BY c.id HAVING COUNT(i.id)>0
    ORDER BY CASE WHEN c.expires_on='' THEN 1 ELSE 0 END,c.expires_on ASC,c.created_at DESC`).all();
  return json({ ok: true, cards: rows.results || [] });
}

async function listPending(env) {
  const rows = await env.DB.prepare(`SELECT p.*,COUNT(i.id) item_count FROM pending_confirmations p
    LEFT JOIN items i ON i.pending_id=p.id AND i.status='pending_confirmation'
    GROUP BY p.id ORDER BY p.created_at ASC LIMIT 100`).all();
  return json({ ok: true, items: rows.results || [] });
}

async function reanalyzePending(env, pendingId) {
  const pending = await env.DB.prepare("SELECT * FROM pending_confirmations WHERE id=?").bind(pendingId).first();
  if (!pending) return json({ ok: false, error: "確認待ちデータが見つかりません" }, 404);
  const item = await env.DB.prepare(`SELECT id,value FROM items
    WHERE pending_id=? AND status='pending_confirmation' ORDER BY received_at,id LIMIT 1`).bind(pendingId).first();
  if (!item) return json({ ok: false, error: "再解析できる確認待ちURLがありません" }, 404);

  let results;
  try { results = await analyzerRequest(env, [item.value], { renderImage: true }); }
  catch (error) { return json({ ok: false, error: `画像の再取得に失敗しました: ${error.message}` }, 502); }
  const result = results.find(candidate => candidate?.url === item.value || String(candidate?.label) === "1");
  if (!result) return json({ ok: false, error: "AnalyzerがURLを対応対象として認識しませんでした" }, 422);
  const normalized = normalizeAnalysis(result);
  if (!normalized.valid) return json({ ok: false, error: normalized.reason }, 422);
  if (!normalized.imageDataUri) return json({ ok: false, error: "商品画像を取得できませんでした" }, 422);

  const sameProduct = normalizeName(pending.raw_name) === normalized.normalizedName
    && normalizeSpecification(pending.specification) === normalized.specification
    && pending.expires_on === normalized.expiresOn;
  if (!sameProduct) return json({ ok: false, error: "再解析結果の商品条件が元の確認待ちデータと一致しません" }, 409);

  try {
    await env.DB.prepare(`UPDATE pending_confirmations SET match_key=?,raw_name=?,normalized_name=?,display_name=?,
      redeem_place=?,specification=?,required_conditions=?,image_data_uri=?,analysis_json=? WHERE id=?`)
      .bind(normalized.matchKey, normalized.rawName, normalized.normalizedName, normalized.displayName,
        normalized.redeemPlace, normalized.specification, normalized.requiredConditions, normalized.imageDataUri,
        JSON.stringify(result), pendingId).run();
  } catch (error) {
    if (/unique/i.test(error.message || "")) return json({ ok: false, error: "同じ条件の確認待ちカードが既にあります" }, 409);
    throw error;
  }
  await env.DB.prepare(`UPDATE items SET analysis_json=?,analyzed_at=?
    WHERE pending_id=? AND status='pending_confirmation'`).bind(JSON.stringify(result), nowSql(), pendingId).run();
  await audit(env, item.id, "pending_reanalyzed", { pendingId, imageUpdated: true });
  return json({ ok: true, pendingId, imageUpdated: true });
}

async function listUnresolved(env) {
  const rows = await env.DB.prepare(`SELECT i.id,i.received_at,u.reason,u.pattern_key,u.retry_count,u.last_error
    FROM unresolved_items u JOIN items i ON i.id=u.item_id ORDER BY i.received_at ASC LIMIT 500`).all();
  return json({ ok: true, items: rows.results || [] });
}

async function latestJob(env) {
  const row = await env.DB.prepare("SELECT id FROM analysis_jobs ORDER BY created_at DESC LIMIT 1").first();
  return json({ ok: true, job: row ? await jobSummary(env, row.id) : null });
}

async function getJob(env, jobId) {
  const job = await jobSummary(env, jobId);
  return job ? json({ ok: true, job }) : json({ ok: false, error: "解析ジョブが見つかりません" }, 404);
}

function decodeCursor(value) {
  try { const parsed = JSON.parse(atob(value)); return parsed?.t && parsed?.id ? parsed : null; } catch { return null; }
}

async function listCardItems(url, env, cardId) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const cursor = decodeCursor(url.searchParams.get("cursor") || "");
  const query = cursor
    ? `SELECT id,value,value_type,received_at FROM items WHERE card_id=? AND status='active'
       AND (received_at>? OR (received_at=? AND id>?)) ORDER BY received_at,id LIMIT ?`
    : `SELECT id,value,value_type,received_at FROM items WHERE card_id=? AND status='active' ORDER BY received_at,id LIMIT ?`;
  const statement = cursor
    ? env.DB.prepare(query).bind(cardId, cursor.t, cursor.t, cursor.id, limit + 1)
    : env.DB.prepare(query).bind(cardId, limit + 1);
  const rows = (await statement.all()).results || [];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return json({ ok: true, items, nextCursor: hasMore && last ? btoa(JSON.stringify({ t: last.received_at, id: last.id })) : null });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/auth/status" && request.method === "GET") {
        return json({
          ok: true,
          authenticated: await authenticated(request, env),
          configured: Boolean(env.ACCESS_PASSWORD_SHA256 && env.SESSION_SECRET),
          mode: env.OPERATION_MODE || "trial"
        });
      }
      if (url.pathname === "/api/auth/login" && request.method === "POST") return login(request, env);
      if (url.pathname.startsWith("/api/") && !await authenticated(request, env)) {
        return json({ ok: false, error: "ログインが必要です" }, 401);
      }
      if (url.pathname === "/api/auth/logout" && request.method === "POST") return logout(env);
      if (url.pathname === "/api/status" && request.method === "GET") {
        return json({ ok: Boolean(env.DB), version: VERSION, analyzer: Boolean(env.COUPON_ANALYZER || env.ANALYZER_BASE_URL), mode: env.OPERATION_MODE || "trial" });
      }
      if (url.pathname === "/api/receive" && request.method === "POST") return receive(request, env);
      if (url.pathname === "/api/jobs/latest" && request.method === "GET") return latestJob(env);
      const jobStatus = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)$/i);
      if (jobStatus && request.method === "GET") return getJob(env, jobStatus[1]);
      if (url.pathname === "/api/cards" && request.method === "GET") return listCards(env);
      if (url.pathname === "/api/pending" && request.method === "GET") return listPending(env);
      if (url.pathname === "/api/unresolved" && request.method === "GET") return listUnresolved(env);
      if (url.pathname === "/api/unresolved/retry" && request.method === "POST") return retryUnresolved(env);
      const confirmation = url.pathname.match(/^\/api\/pending\/([0-9a-f-]+)\/confirm$/i);
      if (confirmation && request.method === "POST") return confirmPending(request, env, confirmation[1]);
      const pendingReanalysis = url.pathname.match(/^\/api\/pending\/([0-9a-f-]+)\/reanalyze$/i);
      if (pendingReanalysis && request.method === "POST") return reanalyzePending(env, pendingReanalysis[1]);
      const cardItems = url.pathname.match(/^\/api\/cards\/([0-9a-f-]+)\/items$/i);
      if (cardItems && request.method === "GET") return listCardItems(url, env, cardItems[1]);
      if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "Not found" }, 404);
      return protectedAsset(await env.ASSETS.fetch(request));
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: error instanceof Error ? error.message : "Internal error" }, 500);
    }
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      const jobId = String(message.body?.jobId || "");
      if (!/^[0-9a-f-]{16,64}$/i.test(jobId)) { message.ack(); continue; }
      try {
        await processJobBatch(env, jobId);
        message.ack();
      } catch (error) {
        console.error("analysis queue", jobId, error);
        message.retry();
      }
    }
  }
};
