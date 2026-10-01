import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Miniflare } from "miniflare";

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

  const newExpiry = await post("https://coupon.sej.co.jp/latte-new-expiry");
  assert.equal(newExpiry.counts.pending_confirmation, 1);
  pending = await request(worker, "/api/pending");
  assert.equal(pending.items.length, 1);
  assert.equal(pending.items[0].expires_on, "2026-11-30");
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
