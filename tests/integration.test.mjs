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
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function createRuntime() {
  const analyzer = await startAnalyzer();
  const port = analyzer.address().port;
  try {
    const mf = new Miniflare({
      modules: true, scriptPath: new URL("../src/index.js", import.meta.url).pathname,
      modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
      compatibilityDate: "2026-09-22", d1Databases: { DB: "vault-db" },
      serviceBindings: { COUPON_ANALYZER: { external: { address: `127.0.0.1:${port}`, http: {} } } },
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
    analyzer.close();
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

test("コード系はURL解析と分離し、Coke ONをURL化する", async t => {
  const { mf, analyzer, worker } = await createRuntime();
  t.after(() => cleanup(mf, analyzer));
  const result = await request(worker, "/api/receive", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "cdAb12Cd34Ef56\nABCD-EFGH-IJKL-MNOP" })
  });
  assert.equal(result.counts.active, 2);
  const cards = await request(worker, "/api/cards");
  assert.equal(cards.cards.length, 2);
  const coke = cards.cards.find(card => card.display_name === "Coke ON");
  const items = await request(worker, `/api/cards/${coke.id}/items`);
  assert.equal(items.items[0].value, "https://c.cocacola.co.jp/spn/app/cp/couponcode.html?couponcode=cdAb12Cd34Ef56");
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
