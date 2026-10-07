import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Miniflare } from "miniflare";
import { getRevenueSummary } from "../src/ledger.js";

const authCookies = new WeakMap();

async function startAnalyzer() {
  const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (request.url !== "/api/analyze-detail") {
    server.ledgerRequests.push({ method: request.method, path: request.url, body });
    if (server.failLedger) {
      response.writeHead(503, { "content-type": "application/json" });
      return response.end(JSON.stringify({ ok: false, error: { code: "STORAGE_UNAVAILABLE", retryable: true, details: {} } }));
    }
    const path = new URL(request.url, "http://ledger.test").pathname;
    if (request.method === "GET" && path === "/api/v1/campaigns") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ items: server.campaigns, next_cursor: null }));
    }
    const previewMatch = path.match(/^\/api\/v1\/campaigns\/([^/]+)\/close-preview$/);
    if (request.method === "GET" && previewMatch) {
      const campaignId = previewMatch[1];
      if (!server.totals.has(campaignId)) {
        response.writeHead(409, { "content-type": "application/json" });
        return response.end(JSON.stringify({ ok: false, error: { code: "DEPENDENCY_NOT_READY", retryable: true, details: {} } }));
      }
      const products = [...server.products.values()].filter(item => item.campaign_id === campaignId);
      const total = server.totals.get(campaignId)?.current_winner_count || 0;
      const productTotal = products.reduce((sum, item) => sum + item.current_winner_count, 0);
      const adjustedTotal = total + (campaignId === "campaign-closing" ? 1 : 0);
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ campaign_id: campaignId, status: "closing", final_account_count: 10,
        final_winner_count: adjustedTotal, final_product_winner_count: productTotal,
        winner_count_difference: adjustedTotal - productTotal, has_mismatch: adjustedTotal !== productTotal,
        products: products.map(item => ({ product_id: item.product_id, product_name: item.product_name,
          final_winner_count: item.current_winner_count, is_archived: false })), preview_token: "a".repeat(64) }));
    }
    if (request.method === "POST") {
      const record = body.source_record_id;
      const previous = server.revisions.get(record);
      const serialized = JSON.stringify(body);
      if (previous && body.source_revision === previous.revision && serialized !== previous.serialized) {
        response.writeHead(409, { "content-type": "application/json" });
        return response.end(JSON.stringify({ ok: false, error: { code: "REVISION_CONFLICT", retryable: false, details: {} } }));
      }
      if (previous && body.source_revision === previous.revision) {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify({ ok: true, result: "duplicate", source_revision: body.source_revision }));
      }
      if (previous && body.source_revision < previous.revision) {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify({ ok: true, result: "stale", source_revision: body.source_revision }));
      }
      server.revisions.set(record, { revision: body.source_revision, serialized });
      if (path === "/api/v1/products/sync") server.products.set(body.data.product_id, body.data);
      if (path === "/api/v1/totals/sync") server.totals.set(body.data.campaign_id, body.data);
      if (path === "/api/v1/revenue/products/sync") server.revenues.set(`${body.data.month}:${body.data.product_id}`, body.data);
      const lifecycle = path.match(/^\/api\/v1\/campaigns\/([^/]+)\/(close|corrections)$/);
      if (lifecycle) {
        const campaign = server.campaigns.find(item => item.campaign_id === lifecycle[1]);
        if (campaign) campaign.status = lifecycle[2] === "close" ? "closed" : "correcting";
      }
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ ok: true, result: "applied", source_revision: body.source_revision }));
    }
    response.writeHead(404, { "content-type": "application/json" });
    return response.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", retryable: false, details: {} } }));
  }
  server.analysisRequests.push(body);
  const results = [];
  for (const item of body.items || []) {
    if (item.url.includes("unsupported")) continue;
    const generic = item.url.includes("generic");
    results.push({
      label: item.label, url: item.url, status: "ok", site: "seven", kind: "coupon",
      product: generic ? "セブン-イレブン クーポン" : "セブンカフェ カフェラテ",
      capacity: "300ml", size: "other", redeemPlace: "セブンイレブン",
      expiresOn: item.url.includes("new-expiry") ? "2026-11-30" : "2026-10-31",
      productImageDataUri: body.includeProductImage === true ? "data:image/png;base64,aW1hZ2U=" : null
    });
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ results, mode: "stable", processingMs: 1 }));
  });
  server.analysisRequests = [];
  server.ledgerRequests = [];
  server.revisions = new Map();
  server.products = new Map();
  server.totals = new Map();
  server.revenues = new Map();
  server.campaigns = [
    { campaign_id: "campaign-active-a", campaign_name: "コークオン", lottery_start_date: "2026-10-01", status: "active", is_archived: false, current_winner_count: 0, final_winner_count: null, final_account_count: null },
    { campaign_id: "campaign-active-b", campaign_name: "コークオン", lottery_start_date: "2026-11-01", status: "active", is_archived: false, current_winner_count: 0, final_winner_count: null, final_account_count: null },
    { campaign_id: "campaign-closing", campaign_name: "終了テスト", lottery_start_date: "2026-09-01", status: "closing", is_archived: false, current_winner_count: 0, final_winner_count: null, final_account_count: 10 },
    { campaign_id: "campaign-archived", campaign_name: "非表示", lottery_start_date: "2026-08-01", status: "closed", is_archived: true, current_winner_count: 1, final_winner_count: 1, final_account_count: 1 }
  ];
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function createRuntime() {
  const analyzer = await startAnalyzer();
  const port = analyzer.address().port;
  let mf;
  try {
    mf = new Miniflare({
      modules: true, scriptPath: new URL("../src/index.js", import.meta.url).pathname,
      modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
      compatibilityDate: "2026-09-22", d1Databases: { DB: "vault-db" },
      serviceBindings: {
        COUPON_ANALYZER: { external: { address: `127.0.0.1:${port}`, http: {} } },
        LEDGER_READER: { external: { address: `127.0.0.1:${port}`, http: {} } },
        LEDGER_VAULT: { external: { address: `127.0.0.1:${port}`, http: {} } }
      },
      bindings: {
        COKEON_REDEEM_BASE_URL: "https://c.cocacola.co.jp/spn/app/cp/couponcode.html?couponcode=",
        ACCESS_PASSWORD_SHA256: "b916a41ca29c2e11feef1e12aa42f69e6a5531c4995a8a4f4979c165206b0171",
        SESSION_SECRET: "integration-test-session-secret",
        OPERATION_MODE: "trial"
      }
    });
    const { DB } = await mf.getBindings();
    const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
    for (const statement of schema.split(";").map(value => value.trim()).filter(Boolean)) await DB.prepare(statement).run();
    const worker = await mf.getWorker();
    const loginResponse = await worker.fetch("https://vault.test/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-access-password" })
    });
    assert.equal(loginResponse.ok, true);
    authCookies.set(worker, loginResponse.headers.get("set-cookie").split(";")[0]);
    return { mf, analyzer, worker, DB };
  } catch (error) {
    await mf?.dispose().catch(() => {});
    analyzer.closeAllConnections?.();
    analyzer.close();
    analyzer.unref();
    throw error;
  }
}

async function request(worker, path, options) {
  const headers = new Headers(options?.headers || {});
  headers.set("cookie", authCookies.get(worker) || "");
  const response = await worker.fetch(`https://vault.test${path}`, { ...options, headers });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

test('ARUNOMATIC sending token saves unknown input in D1 and resumes after token rotation',async t=>{
  const {mf,analyzer,worker,DB}=await createRuntime();t.after(()=>cleanup(mf,analyzer));
  async function issue(){return request(worker,'/api/sending-tokens',{method:'POST',headers:{'content-type':'application/json',origin:'https://vault.test'},body:JSON.stringify({deviceId:'03'})});}
  const firstToken=await issue();
  const input={values:['未知の当選コードと説明文'],clientRequestId:crypto.randomUUID()};
  async function send(token){return worker.fetch('https://vault.test/api/receive',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json; charset=UTF-8'},body:JSON.stringify(input)});}
  const first=await send(firstToken.token);assert.equal(first.status,202);const stored=await first.json();
  assert.equal(stored.stored,true);assert.equal(stored.clientRequestId,input.clientRequestId);assert.equal(stored.job.status,'completed');assert.equal(stored.job.unresolved,1);
  const row=await DB.prepare('SELECT value,status FROM items').first();assert.equal(row.value,input.values[0]);assert.equal(row.status,'unresolved');
  const unresolved=await request(worker,'/api/unresolved');assert.equal(unresolved.items[0].value,input.values[0]);
  const secondToken=await issue();assert.equal((await send(firstToken.token)).status,401);
  const retry=await send(secondToken.token);assert.equal(retry.status,200);assert.equal((await retry.json()).job.id,stored.job.id);
  const denied=await worker.fetch('https://vault.test/api/cards',{headers:{authorization:'Bearer '+secondToken.token,cookie:authCookies.get(worker)}});assert.equal(denied.status,403);
});

test("未ログインではAPIを読めず、ログイン状態と試用モードを確認できる", async t => {
  const { mf, analyzer, worker } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  const denied = await worker.fetch("https://vault.test/api/cards");
  assert.equal(denied.status, 401);
  const status = await request(worker, "/api/auth/status");
  assert.equal(status.authenticated, true);
  assert.equal(status.mode, "trial");
});

async function cleanup(mf, analyzer) {
  await mf.dispose();
  analyzer.closeAllConnections?.();
  await new Promise(resolve => analyzer.close(resolve));
}

test("受信から初回確認、自動振り分け、未判定隔離まで実働する", async t => {
  const { mf, analyzer, worker } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  const post = value => request(worker, "/api/receive", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: [value] })
  });

  const first = await post("https://coupon.sej.co.jp/latte-first");
  assert.equal(first.counts.pending_confirmation, 1);

  const duplicate = await post("https://coupon.sej.co.jp/latte-first");
  assert.equal(duplicate.duplicate, 1);

  let pending = await request(worker, "/api/pending");
  assert.equal(pending.items.length, 1);
  const pendingId = pending.items[0].id;
  const reanalyzed = await request(worker, `/api/pending/${pendingId}/reanalyze`, { method: "POST" });
  assert.equal(reanalyzed.imageUpdated, true);
  pending = await request(worker, "/api/pending");
  assert.match(pending.items[0].image_data_uri, /^data:image\/png;base64,/);
  const approved = await request(worker, `/api/pending/${pendingId}/confirm`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ok" })
  });
  assert.equal(approved.classified, 1);

  const automatic = await post("https://coupon.sej.co.jp/latte-second");
  assert.equal(automatic.counts.active, 1);
  let cards = await request(worker, "/api/cards");
  assert.equal(cards.cards.length, 1);
  assert.equal(Number(cards.cards[0].count), 2);

  const generic = await post("https://coupon.sej.co.jp/generic");
  assert.equal(generic.counts.unresolved, 1);
  const unsupported = await post("https://coupon.sej.co.jp/unsupported");
  assert.equal(unsupported.counts.unresolved, 1);
  const unresolved = await request(worker, "/api/unresolved");
  assert.equal(unresolved.items.length, 2);
  assert.match(unresolved.items[0].reason + unresolved.items[1].reason, /汎用名/);
  assert.match(unresolved.items[0].reason + unresolved.items[1].reason, /対応対象/);
  const deletedId = unresolved.items.find(item => item.value.includes("unsupported")).id;
  const deleted = await request(worker, `/api/unresolved/${deletedId}`, { method: "DELETE" });
  assert.equal(deleted.deleted, 1);
  assert.equal((await request(worker, "/api/unresolved")).items.length, 1);
  assert.equal((await post("https://coupon.sej.co.jp/unsupported")).counts.unresolved, 1);

  const newExpiry = await post("https://coupon.sej.co.jp/latte-new-expiry");
  assert.equal(newExpiry.counts.pending_confirmation, 1);
  pending = await request(worker, "/api/pending");
  assert.equal(pending.items.length, 1);
  assert.equal(pending.items[0].expires_on, "2026-11-30");
});

test("Lawson coupon reception preserves original data and sends login to the analyzer", async t => {
  const { mf, analyzer, worker } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  const original = 'https://apli.lawson.jp/ldcp/coupon/?campaignId=testfixture&encDataCode=VEVTVEZJWFRVUkU%3D';
  const result = await request(worker, '/api/receive', { method: 'POST', headers: {'content-type':'application/json'}, body:JSON.stringify({values:[original]}) });
  assert.equal(result.counts.pending_confirmation, 1);
  assert.equal(analyzer.analysisRequests[0].items[0].url, original.replace('/coupon/','/login/'));
  const db = await mf.getD1Database('DB');
  const item = await db.prepare('SELECT value,analysis_json FROM items LIMIT 1').first();
  assert.equal(item.value, original);
  assert.equal(JSON.parse(item.analysis_json).url, original);
  const pending = await request(worker, '/api/pending');
  await request(worker, `/api/pending/${pending.items[0].id}/confirm`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'ok'})});
  await request(worker, '/api/ledger/campaigns');
  const card = (await request(worker, '/api/cards')).cards[0];
  const assigned = await request(worker, `/api/cards/${card.id}/assign`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({campaign_id:'campaign-active-a'})});
  await request(worker, `/api/products/${assigned.product_id}/output-method`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({output_method:'normal'})});
  const next = await request(worker, `/api/products/${assigned.product_id}/export-next`);
  assert.equal(next.item.value, original.replace('/coupon/','/login/'));
  const batch = await request(worker, `/api/products/${assigned.product_id}/export-batches`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})});
  assert.equal(batch.batch.items[0].value, next.item.value);
  assert.equal((await db.prepare('SELECT value FROM items LIMIT 1').first()).value, original);
  const unsupported = original.replace('testfixture', 'unsupported');
  await request(worker, '/api/receive', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({values:[unsupported]})});
  const unresolved = (await request(worker, '/api/unresolved')).items.find(item => item.value === unsupported);
  assert.equal(unresolved.value, unsupported);
  assert.equal(unresolved.openUrl, unsupported.replace('/coupon/', '/login/'));
});

test("未判定URLの画像確認は選択した1件だけを確定する", async t => {
  const { mf, analyzer, worker, DB } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  const first = "https://coupon.sej.co.jp/unsupported-image-one";
  const second = "https://coupon.sej.co.jp/unsupported-image-two";
  await request(worker, "/api/receive", {
    method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ values:[first, second] })
  });
  let unresolved = await request(worker, "/api/unresolved");
  assert.equal(unresolved.items.length, 2);
  const target = unresolved.items.find(item => item.value === first);
  const confirmed = await request(worker, `/api/unresolved/${target.id}/image-confirm`, {
    method:"POST", headers:{ "content-type":"application/json" },
    body:JSON.stringify({
      product_name:"【大塚製薬】ファイブミニ（税込130円）1本無料クーポン",
      display_name:"ファイブミニ 1本無料",
      redeem_place:"ローソン",
      specification:"1本無料",
      expires_on:"2026-10-19"
    })
  });
  assert.equal(confirmed.classified, 1);
  unresolved = await request(worker, "/api/unresolved");
  assert.deepEqual(unresolved.items.map(item => item.value), [second]);
  const rows = await DB.prepare("SELECT value,status FROM items ORDER BY value").all();
  assert.deepEqual(rows.results.map(item => [item.value, item.status]), [[first, "active"], [second, "unresolved"]]);
  const cards = await request(worker, "/api/cards");
  assert.equal(cards.cards.length, 1);
  assert.equal(cards.cards[0].display_name, "ファイブミニ 1本無料");
  assert.equal(cards.cards[0].expires_on, "2026-10-19");
});

test("コード系とQUOカードPayはURL解析と分離し、専用カードへ保管する", async t => {
  const { mf, analyzer, worker } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  const result = await request(worker, "/api/receive", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "cdAb12Cd34Ef56\nABCD-EFGH-IJKL-MNOP\nhttps://br.quocardpay.jp/card/A1B2C3D4E5F6G7H8" })
  });
  assert.equal(result.counts.active, 3);
  const cards = await request(worker, "/api/cards");
  assert.equal(cards.cards.length, 3);
  const coke = cards.cards.find(card => card.display_name === "Coke ON");
  const items = await request(worker, `/api/cards/${coke.id}/items`);
  assert.equal(items.items[0].value, "https://c.cocacola.co.jp/spn/app/cp/couponcode.html?couponcode=cdAb12Cd34Ef56");
  const quo = cards.cards.find(card => card.display_name === "QUOカードPay");
  assert.equal(Number(quo.unassigned_count), 1);
  const quoItems = await request(worker, `/api/cards/${quo.id}/items`);
  assert.equal(quoItems.items[0].value, "https://br.quocardpay.jp/card/A1B2C3D4E5F6G7H8");
  assert.equal(analyzer.analysisRequests.length, 0);
});

test("全件受付で貼付内重複と既登録を分け、完全一致候補をグループ化する", async t => {
  const { mf, analyzer, worker } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  const firstUrl = "https://coupon.sej.co.jp/group-first";
  const secondUrl = "https://coupon.sej.co.jp/group-second";
  const first = await request(worker, "/api/receive", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId: crypto.randomUUID(), values: [firstUrl, firstUrl, secondUrl] })
  });
  assert.equal(first.job.inputTotal, 3);
  assert.equal(first.job.inputDuplicates, 1);
  assert.equal(first.job.existing, 0);
  assert.equal(first.job.accepted, 2);
  assert.equal(first.job.processed, 2);
  assert.equal(first.job.pendingConfirmation, 2);

  const pending = await request(worker, "/api/pending");
  assert.equal(pending.items.length, 1);
  assert.equal(Number(pending.items[0].item_count), 2);

  const second = await request(worker, "/api/receive", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId: crypto.randomUUID(), values: [firstUrl, secondUrl] })
  });
  assert.equal(second.job.inputDuplicates, 0);
  assert.equal(second.job.existing, 2);
  assert.equal(second.job.accepted, 0);
});

test("40件単位の並列解析を一時領域で集約し、商品画像は初回確認用の1件だけ取得する", async t => {
  const { mf, analyzer, worker, DB } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  const values = Array.from({ length: 85 }, (_, index) => `https://coupon.sej.co.jp/bulk-${index}`);
  const result = await request(worker, "/api/receive", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId: crypto.randomUUID(), values })
  });

  assert.equal(result.job.accepted, 85);
  assert.equal(result.job.processed, 85);
  assert.equal(result.job.pendingConfirmation, 85);
  const pending = await request(worker, "/api/pending");
  assert.equal(pending.items.length, 1);
  assert.equal(Number(pending.items[0].item_count), 85);
  assert.match(pending.items[0].image_data_uri, /^data:image\/png;base64,/);
  assert.equal((await DB.prepare("SELECT COUNT(*) count FROM analysis_staging").first()).count, 0);

  const bulkRequests = analyzer.analysisRequests.filter(body => body.includeProductImage === false);
  const imageRequests = analyzer.analysisRequests.filter(body => body.includeProductImage === true);
  assert.deepEqual(bulkRequests.map(body => body.items.length).sort((a, b) => a - b), [5, 40, 40]);
  assert.equal(imageRequests.length, 1);
  assert.equal(imageRequests[0].items.length, 1);
});

test("試用版の完全削除はURLデータだけを消し、商品マスターを残す", async t => {
  const { mf, analyzer, worker, DB } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  const first = await request(worker, "/api/receive", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: ["https://coupon.sej.co.jp/reset-target"] })
  });
  const pending = await request(worker, "/api/pending");
  await request(worker, `/api/pending/${pending.items[0].id}/confirm`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ok" })
  });
  assert.equal(first.job.accepted, 1);

  const reset = await request(worker, "/api/trial/reset", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "完全削除" })
  });
  assert.equal(reset.deleted, 1);
  assert.equal((await DB.prepare("SELECT COUNT(*) count FROM items").first()).count, 0);
  assert.equal((await DB.prepare("SELECT COUNT(*) count FROM analysis_jobs").first()).count, 0);
  assert.equal((await DB.prepare("SELECT COUNT(*) count FROM analysis_staging").first()).count, 0);
  assert.equal((await DB.prepare("SELECT COUNT(*) count FROM product_master").first()).count, 1);
  assert.equal((await request(worker, "/api/cards")).cards.length, 0);
  assert.equal((await request(worker, "/api/jobs/latest")).job, null);
});

async function createConfirmedCard(worker, suffix) {
  await request(worker, "/api/receive", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: [`https://coupon.sej.co.jp/ledger-${suffix}`] })
  });
  const pending = await request(worker, "/api/pending");
  if (pending.items.length) {
    await request(worker, `/api/pending/${pending.items[0].id}/confirm`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ok" })
    });
  }
  const cards = await request(worker, "/api/cards");
  return cards.cards[0];
}

test("Readerの同名キャンペーンを開始日で区別し、割当時だけ正式product_idを発行して現在値を同期する", async t => {
  const { mf, analyzer, worker } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  const campaigns = await request(worker, "/api/ledger/campaigns");
  const sameName = campaigns.campaigns.filter(item => item.campaign_name === "コークオン");
  assert.deepEqual(sameName.map(item => item.lottery_start_date).sort(), ["2026-10-01", "2026-11-01"]);
  assert.equal(campaigns.campaigns.some(item => item.campaign_id === "campaign-archived"), false);

  let card = await createConfirmedCard(worker, "first");
  assert.equal(card.unassigned_count, 1);
  assert.equal(card.assignments.length, 0);
  const preview = await request(worker, `/api/cards/${card.id}/assignment-preview?campaign_id=campaign-active-a`);
  assert.equal(preview.card.unassigned_count, 1);
  assert.equal(preview.exact_product, null);
  const first = await request(worker, `/api/cards/${card.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "campaign-active-a" })
  });
  assert.match(first.product_id, /^[0-9a-f-]{36}$/);

  await createConfirmedCard(worker, "second");
  card = (await request(worker, "/api/cards")).cards[0];
  const second = await request(worker, `/api/cards/${card.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "campaign-active-a" })
  });
  assert.equal(second.product_id, first.product_id);
  assert.equal(first.assigned_count, 1);
  assert.equal(second.assigned_count, 1);

  await createConfirmedCard(worker, "third");
  card = (await request(worker, "/api/cards")).cards[0];
  const otherCampaign = await request(worker, `/api/cards/${card.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "campaign-active-b" })
  });
  assert.notEqual(otherCampaign.product_id, first.product_id);

  const productA = analyzer.products.get(first.product_id);
  assert.equal(productA.campaign_id, "campaign-active-a");
  assert.equal(productA.current_winner_count, 2);
  assert.equal(analyzer.totals.get("campaign-active-a").current_winner_count, 2);
  assert.equal(analyzer.totals.get("campaign-active-b").current_winner_count, 1);
  const sentBodies = analyzer.ledgerRequests.filter(item => item.method === "POST").map(item => JSON.stringify(item.body)).join("\n");
  assert.doesNotMatch(sentBodies, /coupon\.sej\.co\.jp|canonical_value|"url"|"code"/i);
  assert.deepEqual([...analyzer.revisions.entries()].filter(([key]) => key === `product:${first.product_id}`).map(([, value]) => value.revision), [2]);
});

test("Ledger停止中もVault保存と仕分けを確定し、outboxを保持して復旧後に再送する", async t => {
  const { mf, analyzer, worker, DB } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  await request(worker, "/api/ledger/campaigns");
  analyzer.failLedger = true;
  const card = await createConfirmedCard(worker, "offline");
  const assigned = await request(worker, `/api/cards/${card.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "campaign-active-a" })
  });
  assert.match(assigned.product_id, /^[0-9a-f-]{36}$/);
  assert.equal((await DB.prepare("SELECT COUNT(*) count FROM item_campaign_assignments").first()).count, 1);
  let outbox = await request(worker, "/api/ledger/outbox");
  assert.equal(outbox.failed, 2);
  analyzer.failLedger = false;
  await request(worker, "/api/ledger/outbox/retry", { method: "POST" });
  outbox = await request(worker, "/api/ledger/outbox");
  assert.equal(outbox.failed, 0);
  assert.equal(outbox.sent, 2);
  assert.equal(analyzer.products.get(assigned.product_id).current_winner_count, 1);
});

test("closingの差分を表示し、明示承認で終了後、訂正フローへ移行できる", async t => {
  const { mf, analyzer, worker } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  await request(worker, "/api/ledger/campaigns");
  const card = await createConfirmedCard(worker, "closing");
  await request(worker, `/api/cards/${card.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "campaign-closing" })
  });
  const preview = await request(worker, "/api/ledger/campaigns/campaign-closing/close-preview");
  assert.equal(preview.has_mismatch, true);
  assert.equal(preview.winner_count_difference, 1);

  const denied = await worker.fetch("https://vault.test/api/ledger/campaigns/campaign-closing/close", {
    method: "POST", headers: { "content-type": "application/json", cookie: authCookies.get(worker) },
    body: JSON.stringify({ accept_mismatch: false })
  });
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).code, "MISMATCH_CONFIRMATION_REQUIRED");

  const closed = await request(worker, "/api/ledger/campaigns/campaign-closing/close", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accept_mismatch: true })
  });
  assert.equal(closed.delivery.ok, true);
  assert.equal(analyzer.campaigns.find(item => item.campaign_id === "campaign-closing").status, "closed");
  const lateCard = await createConfirmedCard(worker, "closed-reject");
  const rejectedAssignment = await worker.fetch(`https://vault.test/api/cards/${lateCard.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json", cookie: authCookies.get(worker) },
    body: JSON.stringify({ campaign_id: "campaign-closing" })
  });
  assert.equal(rejectedAssignment.status, 409);
  assert.equal((await rejectedAssignment.json()).code, "CAMPAIGN_CLOSED");
  const corrected = await request(worker, "/api/ledger/campaigns/campaign-closing/corrections", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "遅れて届いた当選URLを追加" })
  });
  assert.equal(corrected.delivery.ok, true);
  assert.equal(analyzer.campaigns.find(item => item.campaign_id === "campaign-closing").status, "correcting");
});

test("当選0件のclosingでも0件同期を先に作り終了確認できる", async t => {
  const { mf, analyzer, worker } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  await request(worker, "/api/ledger/campaigns");
  assert.equal(analyzer.totals.has("campaign-closing"), false);
  const preview = await request(worker, "/api/ledger/campaigns/campaign-closing/close-preview");
  assert.equal(preview.final_winner_count, 1);
  assert.equal(analyzer.totals.get("campaign-closing").current_winner_count, 0);
});

test("画面表示名を保存して振り分けると当選リストにも反映し、正式名称は保持する", async t => {
  const { mf, analyzer, worker, DB } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  await request(worker, "/api/ledger/campaigns");
  await request(worker, "/api/receive", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: ["https://coupon.sej.co.jp/display-name"] })
  });
  const pending = (await request(worker, "/api/pending")).items[0];
  const displayName = "カフェラテ";
  await request(worker, `/api/pending/${pending.id}/confirm`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "edit", display_name: displayName })
  });
  const card = (await request(worker, "/api/cards")).cards[0];
  assert.equal(card.display_name, displayName);
  const assigned = await request(worker, `/api/cards/${card.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "campaign-active-a" })
  });
  const list = (await request(worker, "/api/winning-lists")).products[0];
  assert.equal(list.display_name, displayName);
  assert.equal(list.product_name, pending.raw_name);
  assert.equal(Number(list.total_count), 1);
  const stored = await DB.prepare("SELECT product_name FROM ledger_products WHERE product_id=?").bind(assigned.product_id).first();
  assert.equal(stored.product_name, pending.raw_name);
  await DB.prepare("UPDATE product_master SET display_name='' WHERE id=(SELECT product_id FROM cards WHERE id=?)").bind(card.id).run();
  assert.equal((await request(worker, "/api/winning-lists")).products[0].display_name, pending.raw_name);
});

test("常設への追加・解除は保存され、当選件数や収益・同期を変更しない", async t => {
  const { mf, analyzer, worker, DB } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  await request(worker, "/api/ledger/campaigns");
  const card = await createConfirmedCard(worker, "folder");
  const assigned = await request(worker, `/api/cards/${card.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "campaign-active-a" })
  });
  const before = (await request(worker, "/api/winning-lists")).products[0];
  const outbox = await DB.prepare("SELECT COUNT(*) n FROM ledger_outbox").first();
  assert.equal(before.show_in_permanent, 0);
  for (const enabled of [true, false]) {
    await request(worker, `/api/products/${assigned.product_id}/folder-visibility`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ show_in_permanent: enabled })
    });
    const after = (await request(worker, "/api/winning-lists")).products;
    assert.equal(after.length, 1);
    assert.equal(after[0].show_in_permanent, enabled ? 1 : 0);
    for (const key of ['total_count','unexported_count','exported_count','current_month_revenue','lottery_start_date']) {
      assert.equal(after[0][key],before[key]);
    }
  }
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM ledger_outbox").first()).n, outbox.n);
});

test("当選カードごとに抽出方法を設定し、一括確定・取消・1件ずつ処理できる", async t => {
  const { mf, analyzer, worker } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  await request(worker, "/api/ledger/campaigns");
  await createConfirmedCard(worker, "export-one");
  await createConfirmedCard(worker, "export-two");
  const card = await createConfirmedCard(worker, "export-three");
  const assigned = await request(worker, `/api/cards/${card.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "campaign-active-a" })
  });

  let lists = await request(worker, "/api/winning-lists");
  assert.equal(lists.products.length, 1);
  assert.equal(Number(lists.products[0].total_count), 3);
  assert.equal(lists.products[0].output_method, "unset");

  await request(worker, `/api/products/${assigned.product_id}/output-method`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ output_method: "normal" })
  });
  lists = await request(worker, "/api/winning-lists");
  assert.equal(Number(lists.products[0].unexported_count), 3);

  const batch = await request(worker, `/api/products/${assigned.product_id}/export-batches`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ copy_order: "received" })
  });
  assert.equal(batch.batch.count, 3);
  assert.equal((await request(worker, "/api/winning-lists")).products[0].unexported_count, 3);
  const completed = await request(worker, `/api/export-batches/${batch.batch.id}/complete`, { method: "POST" });
  assert.equal(completed.changed_count, 3);
  lists = await request(worker, "/api/winning-lists");
  assert.equal(Number(lists.products[0].unexported_count), 0);
  assert.equal(Number(lists.products[0].exported_count), 3);

  const undone = await request(worker, `/api/export-batches/${batch.batch.id}/undo`, { method: "POST" });
  assert.equal(undone.undone_count, 3);
  const next = await request(worker, `/api/products/${assigned.product_id}/export-next`);
  assert.equal(next.remaining_count, 3);
  await request(worker, `/api/products/${assigned.product_id}/items/${next.item.id}/export-complete`, { method: "POST" });
  lists = await request(worker, "/api/winning-lists");
  assert.equal(Number(lists.products[0].unexported_count), 2);
  assert.equal(Number(lists.products[0].exported_count), 1);
});

test("JSTの2026-10以降だけを商品月収益へ集約し、抽出状態と分離して単価変更を再計算する", async t => {
  const { mf, analyzer, worker, DB } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  await request(worker, "/api/ledger/campaigns");
  const card = await createConfirmedCard(worker, "revenue-base");
  const assigned = await request(worker, `/api/cards/${card.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "campaign-active-a" })
  });
  await DB.prepare("UPDATE items SET received_at=? WHERE card_id=?")
    .bind("2026-10-02T01:00:00.000Z", card.id).run();
  assert.equal(analyzer.ledgerRequests.filter(item => item.path === "/api/v1/revenue/products/sync").length, 0);

  const records = [
    ...Array.from({ length: 98 }, (_, index) => ({
      id: crypto.randomUUID(), value: `https://coupon.example.test/revenue-${index}`,
      received_at: new Date(Date.UTC(2026, 9, 2, 0, index)).toISOString()
    })),
    { id: crypto.randomUUID(), value: "https://coupon.example.test/jst-october", received_at: "2026-09-30T15:00:00.000Z" },
    { id: crypto.randomUUID(), value: "https://coupon.example.test/jst-september", received_at: "2026-09-30T14:59:59.999Z" }
  ];
  for (let start = 0; start < records.length; start += 40) {
    const group = records.slice(start, start + 40);
    await DB.batch(group.flatMap(item => [
      DB.prepare(`INSERT INTO items(id,value,canonical_value,value_type,card_id,status,received_at)
        VALUES (?,?,?,?,?,'active',?)`).bind(item.id,item.value,item.value,"url",card.id,item.received_at),
      DB.prepare(`INSERT INTO item_campaign_assignments(item_id,campaign_id,product_id,assigned_at)
        VALUES (?,?,?,?)`).bind(item.id,"campaign-active-a",assigned.product_id,"2026-10-02T00:00:00.000Z")
    ]));
  }
  await request(worker, `/api/products/${assigned.product_id}/unit-price`, {
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({unit_price:150})
  });
  let revenue=analyzer.revenues.get(`2026-10:${assigned.product_id}`);
  assert.deepEqual({winner_count:revenue.winner_count,unit_price:revenue.unit_price,amount:revenue.amount},
    {winner_count:100,unit_price:150,amount:15000});
  let list=(await request(worker,"/api/winning-lists")).products[0];
  assert.equal(Number(list.unit_price),150);assert.equal(Number(list.current_month_revenue),15000);
  let summary = await getRevenueSummary({ DB }, Date.parse("2026-10-02T10:00:00.000Z"));
  assert.deepEqual({ monthly:summary.monthly_revenue, daily:summary.daily_revenue }, { monthly:15000, daily:14850 });
  const liveSummary = await request(worker, "/api/revenue/summary");
  assert.equal(typeof liveSummary.monthly_revenue, "number");
  assert.equal(typeof liveSummary.daily_revenue, "number");
  assert.doesNotMatch(JSON.stringify(liveSummary), /coupon\.example\.test|canonical_value|"value"/i);

  await request(worker, `/api/products/${assigned.product_id}/output-method`, {
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({output_method:"normal"})
  });
  const batch=await request(worker, `/api/products/${assigned.product_id}/export-batches`, {
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({})
  });
  await request(worker, `/api/export-batches/${batch.batch.id}/complete`, {method:"POST"});
  list=(await request(worker,"/api/winning-lists")).products[0];
  assert.equal(Number(list.current_month_revenue),15000);

  await request(worker, `/api/products/${assigned.product_id}/unit-price`, {
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({unit_price:200})
  });
  revenue=analyzer.revenues.get(`2026-10:${assigned.product_id}`);
  assert.equal(revenue.amount,20000);
  summary = await getRevenueSummary({ DB }, Date.parse("2026-10-02T10:00:00.000Z"));
  assert.deepEqual({ monthly:summary.monthly_revenue, daily:summary.daily_revenue }, { monthly:20000, daily:19800 });
  const revenueRequests=analyzer.ledgerRequests.filter(item => item.path === "/api/v1/revenue/products/sync");
  assert.equal(revenueRequests.length,2);
  assert.equal(revenueRequests[1].body.source_revision,2);
  const serialized=JSON.stringify(revenueRequests.map(item=>item.body));
  assert.doesNotMatch(serialized,/coupon\.example\.test|canonical_value|"value"/i);
});

test("別商品の進行中一括を返さず、進行中の商品名を409で通知する", async t => {
  const { mf, analyzer, worker } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  await request(worker, "/api/ledger/campaigns");
  let card = await createConfirmedCard(worker, "batch-product-a");
  const productA = await request(worker, `/api/cards/${card.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "campaign-active-a" })
  });
  await createConfirmedCard(worker, "batch-product-b");
  card = (await request(worker, "/api/cards")).cards[0];
  const productB = await request(worker, `/api/cards/${card.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "campaign-active-b" })
  });
  for (const productId of [productA.product_id, productB.product_id]) {
    await request(worker, `/api/products/${productId}/output-method`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ output_method: "normal" })
    });
  }
  const started = await request(worker, `/api/products/${productA.product_id}/export-batches`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({})
  });
  const response = await worker.fetch(`https://vault.test/api/products/${productB.product_id}/export-batches`, {
    method: "POST", headers: { "content-type": "application/json", cookie: authCookies.get(worker) }, body: JSON.stringify({})
  });
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.code, "EXPORT_BATCH_OTHER_PRODUCT");
  assert.equal(payload.details.product_id, productA.product_id);
  assert.match(payload.error, /の商品で一括抽出が進行中です$/);
  assert.equal((await request(worker, "/api/export-batches/pending")).batch.id, started.batch.id);
  const lists = (await request(worker, "/api/winning-lists")).products;
  assert.equal(lists.reduce((sum, item) => sum + Number(item.exported_count), 0), 0);
});

test("一括確定の途中でDB更新が失敗しても全件未抽出を維持し、中断時は部分更新も戻す", async t => {
  const { mf, analyzer, worker, DB } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  await request(worker, "/api/ledger/campaigns");
  const card = await createConfirmedCard(worker, "atomic-base");
  const assigned = await request(worker, `/api/cards/${card.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "campaign-active-a" })
  });
  const records = Array.from({ length: 90 }, (_, index) => ({
    id: crypto.randomUUID(), value: `https://coupon.example.test/atomic-${String(index).padStart(3, "0")}`
  }));
  for (let start = 0; start < records.length; start += 40) {
    const group = records.slice(start, start + 40);
    await DB.batch(group.flatMap((item, offset) => [
      DB.prepare(`INSERT INTO items(id,value,canonical_value,value_type,card_id,status,received_at)
        VALUES (?,?,?,?,?,'active',?)`).bind(item.id, item.value, item.value, "url", card.id,
        new Date(Date.UTC(2026, 9, 2, 0, start + offset)).toISOString()),
      DB.prepare(`INSERT INTO item_campaign_assignments(item_id,campaign_id,product_id,assigned_at)
        VALUES (?,?,?,?)`).bind(item.id, "campaign-active-a", assigned.product_id, "2026-10-02T00:00:00.000Z")
    ]));
  }
  await request(worker, `/api/products/${assigned.product_id}/output-method`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ output_method: "normal" })
  });
  const batch = await request(worker, `/api/products/${assigned.product_id}/export-batches`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({})
  });
  const failingId = batch.batch.items[85].id;
  await DB.prepare(`CREATE TRIGGER fail_export_update BEFORE UPDATE OF exported_at ON item_campaign_assignments
    WHEN NEW.exported_at IS NOT NULL AND NEW.item_id='${failingId}'
    BEGIN SELECT RAISE(ABORT,'forced export failure'); END`).run();
  const response = await worker.fetch(`https://vault.test/api/export-batches/${batch.batch.id}/complete`, {
    method: "POST", headers: { cookie: authCookies.get(worker) }
  });
  assert.equal(response.status, 500);
  assert.equal((await DB.prepare("SELECT COUNT(*) count FROM item_campaign_assignments WHERE exported_at IS NOT NULL").first()).count, 0);
  assert.equal((await DB.prepare("SELECT status FROM export_batches WHERE id=?").bind(batch.batch.id).first()).status, "pending");
  await DB.prepare("DROP TRIGGER fail_export_update").run();
  await DB.prepare(`UPDATE item_campaign_assignments SET exported_at=?,export_method='bulk',export_batch_id=? WHERE item_id=?`)
    .bind("2026-10-02T00:00:00.000Z", batch.batch.id, batch.batch.items[0].id).run();
  await request(worker, `/api/export-batches/${batch.batch.id}`, { method: "DELETE" });
  assert.equal((await DB.prepare("SELECT COUNT(*) count FROM item_campaign_assignments WHERE exported_at IS NOT NULL").first()).count, 0);
});

test("通常URLはvalue_typeがurlまたはquocardpayのデータだけを対象にする", async t => {
  const { mf, analyzer, worker, DB } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  await request(worker, "/api/ledger/campaigns");
  const card = await createConfirmedCard(worker, "normal-types");
  const assigned = await request(worker, `/api/cards/${card.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "campaign-active-a" })
  });
  const extras = [
    ["https://br.quocardpay.jp/card/A1B2C3D4E5F6G7H8", "quocardpay"],
    ["https://c.cocacola.co.jp/spn/app/cp/couponcode.html?couponcode=cdAb12Cd34Ef56", "cokeon"],
    ["https://giftcard.paypay.ne.jp/card/normal-types", "paypay"]
  ];
  for (const [value, type] of extras) {
    const itemId = crypto.randomUUID();
    await DB.batch([
      DB.prepare(`INSERT INTO items(id,value,canonical_value,value_type,card_id,status,received_at)
        VALUES (?,?,?,?,?,'active',?)`).bind(itemId, value, value, type, card.id, new Date().toISOString()),
      DB.prepare(`INSERT INTO item_campaign_assignments(item_id,campaign_id,product_id,assigned_at)
        VALUES (?,?,?,?)`).bind(itemId, "campaign-active-a", assigned.product_id, new Date().toISOString())
    ]);
  }
  await request(worker, `/api/products/${assigned.product_id}/output-method`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ output_method: "normal" })
  });
  const list = (await request(worker, "/api/winning-lists")).products[0];
  assert.equal(Number(list.unexported_count), 2);
  assert.equal(Number(list.unmatched_count), 2);
  const batch = await request(worker, `/api/products/${assigned.product_id}/export-batches`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({})
  });
  assert.deepEqual(new Set(batch.batch.items.map(item => item.value_type)), new Set(["url", "quocardpay"]));
});

test("PayPayはURLとコードを別々に一括・1件ずつ抽出する", async t => {
  const { mf, analyzer, worker } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  await request(worker, "/api/ledger/campaigns");
  await request(worker, "/api/receive", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: [
      "https://giftcard.paypay.ne.jp/card/separate-test", "ABCDEFGHIJKLMNOP", "QRST-UVWX-YZ12-3456"
    ] })
  });
  const paypayCard = (await request(worker, "/api/cards")).cards.find(item => item.display_name === "PayPay");
  const assigned = await request(worker, `/api/cards/${paypayCard.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "campaign-active-a" })
  });
  await request(worker, `/api/products/${assigned.product_id}/output-method`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ output_method: "paypay" })
  });
  const list = (await request(worker, "/api/winning-lists")).products[0];
  assert.equal(Number(list.paypay_url_unexported_count), 1);
  assert.equal(Number(list.paypay_code_unexported_count), 2);

  let batch = await request(worker, `/api/products/${assigned.product_id}/export-batches`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ paypay_kind: "url" })
  });
  assert.equal(batch.batch.paypay_kind, "url");
  assert.equal(batch.batch.items.length, 1);
  assert.ok(batch.batch.items.every(item => /^https:\/\//i.test(item.value)));
  await request(worker, `/api/export-batches/${batch.batch.id}`, { method: "DELETE" });

  batch = await request(worker, `/api/products/${assigned.product_id}/export-batches`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ paypay_kind: "code" })
  });
  assert.equal(batch.batch.paypay_kind, "code");
  assert.equal(batch.batch.items.length, 2);
  assert.ok(batch.batch.items.every(item => !/^https:\/\//i.test(item.value)));
  await request(worker, `/api/export-batches/${batch.batch.id}`, { method: "DELETE" });

  const nextUrl = await request(worker, `/api/products/${assigned.product_id}/export-next?paypay_kind=url`);
  const nextCode = await request(worker, `/api/products/${assigned.product_id}/export-next?paypay_kind=code`);
  assert.match(nextUrl.item.value, /^https:\/\//i);
  assert.doesNotMatch(nextCode.item.value, /^https:\/\//i);

  const legacyBatch = await request(worker, `/api/products/${assigned.product_id}/export-batches`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({})
  });
  assert.ok(legacyBatch.batch.items.every(item => /^https:\/\//i.test(item.value)));
});

test("1000件を超える当選URLを1カードから一括抽出できる", async t => {
  const { mf, analyzer, worker, DB } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  await request(worker, "/api/ledger/campaigns");
  const card = await createConfirmedCard(worker, "bulk-1005-base");
  const assigned = await request(worker, `/api/cards/${card.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "campaign-active-a" })
  });
  const records = Array.from({ length: 1004 }, (_, index) => ({
    id: crypto.randomUUID(), value: `https://coupon.example.test/bulk-${String(index).padStart(4, "0")}`
  }));
  for (let start = 0; start < records.length; start += 80) {
    const group = records.slice(start, start + 80);
    await DB.batch(group.flatMap((item, offset) => [
      DB.prepare(`INSERT INTO items(id,value,canonical_value,value_type,card_id,status,received_at)
        VALUES (?,?,?,?,?,'active',?)`).bind(item.id, item.value, item.value, "url", card.id,
        new Date(Date.UTC(2026, 9, 1, 0, start + offset)).toISOString()),
      DB.prepare(`INSERT INTO item_campaign_assignments(item_id,campaign_id,product_id,assigned_at)
        VALUES (?,?,?,?)`).bind(item.id, "campaign-active-a", assigned.product_id, "2026-10-01T00:00:00.000Z")
    ]));
  }
  await request(worker, `/api/products/${assigned.product_id}/output-method`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ output_method: "normal" })
  });
  const batch = await request(worker, `/api/products/${assigned.product_id}/export-batches`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ copy_order: "asc" })
  });
  assert.equal(batch.batch.count, 1005);
  assert.equal(batch.batch.items.length, 1005);
  const completed = await request(worker, `/api/export-batches/${batch.batch.id}/complete`, { method: "POST" });
  assert.equal(completed.changed_count, 1005);
  const list = (await request(worker, "/api/winning-lists")).products[0];
  assert.equal(Number(list.exported_count), 1005);
  assert.equal(Number(list.unexported_count), 0);
});

test("outbox再送はduplicateとstaleを成功扱いし、同一revision異内容を競合として保持する", async t => {
  const { mf, analyzer, worker, DB } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  await request(worker, "/api/ledger/campaigns");
  let card = await createConfirmedCard(worker, "revision-one");
  const first = await request(worker, `/api/cards/${card.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "campaign-active-a" })
  });
  await createConfirmedCard(worker, "revision-two");
  card = (await request(worker, "/api/cards")).cards[0];
  await request(worker, `/api/cards/${card.id}/assign`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "campaign-active-a" })
  });
  const rows = (await DB.prepare(`SELECT * FROM ledger_outbox WHERE source_record_id=? ORDER BY source_revision`)
    .bind(`product:${first.product_id}`).all()).results;
  assert.equal(rows.length, 2);

  await DB.prepare("UPDATE ledger_outbox SET status='pending',sent_at=NULL WHERE id=?").bind(rows[1].id).run();
  await request(worker, "/api/ledger/outbox/retry", { method: "POST" });
  assert.equal((await DB.prepare("SELECT ledger_result FROM ledger_outbox WHERE id=?").bind(rows[1].id).first()).ledger_result, "duplicate");

  await DB.prepare("UPDATE ledger_outbox SET status='pending',sent_at=NULL WHERE id=?").bind(rows[0].id).run();
  await request(worker, "/api/ledger/outbox/retry", { method: "POST" });
  assert.equal((await DB.prepare("SELECT ledger_result FROM ledger_outbox WHERE id=?").bind(rows[0].id).first()).ledger_result, "stale");

  const conflicting = JSON.parse(rows[1].payload_json);
  conflicting.data.current_winner_count = 999;
  await DB.prepare("UPDATE ledger_outbox SET status='pending',sent_at=NULL,payload_json=? WHERE id=?")
    .bind(JSON.stringify(conflicting), rows[1].id).run();
  await request(worker, "/api/ledger/outbox/retry", { method: "POST" });
  const conflict = await DB.prepare("SELECT status,next_attempt_at,last_error FROM ledger_outbox WHERE id=?").bind(rows[1].id).first();
  assert.equal(conflict.status, "failed");
  assert.equal(conflict.next_attempt_at, null);
  assert.match(conflict.last_error, /REVISION_CONFLICT/);
  assert.equal(analyzer.revisions.get(`product:${first.product_id}`).revision, 2);
});
