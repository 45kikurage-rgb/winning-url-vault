import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Miniflare } from "miniflare";

async function startAnalyzer() {
  const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const results = [];
  for (const item of body.items || []) {
    if (item.url.includes("unsupported")) continue;
    const generic = item.url.includes("generic");
    results.push({
      label: item.label, url: item.url, status: "ok", site: "seven", kind: "coupon",
      product: generic ? "セブン-イレブン クーポン" : "セブンカフェ カフェラテ",
      capacity: "300ml", size: "other", redeemPlace: "セブンイレブン",
      expiresOn: item.url.includes("new-expiry") ? "2026-11-30" : "2026-10-31",
      productImageDataUri: "data:image/png;base64,aW1hZ2U="
    });
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ results, mode: "stable", processingMs: 1 }));
  });
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
      bindings: { COKEON_REDEEM_BASE_URL: "https://c.cocacola.co.jp/spn/app/cp/couponcode.html?couponcode=" }
    });
    const { DB } = await mf.getBindings();
    const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
    for (const statement of schema.split(";").map(value => value.trim()).filter(Boolean)) await DB.prepare(statement).run();
    return { mf, analyzer, worker: await mf.getWorker() };
  } catch (error) {
    analyzer.close();
    throw error;
  }
}

async function request(worker, path, options) {
  const response = await worker.fetch(`https://vault.test${path}`, options);
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

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
