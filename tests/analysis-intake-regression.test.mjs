import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { digest } from '../src/sending-auth.js';
import { changeMode } from '../src/provisional.js';

// Exercise the actual receive/finalize/read pipeline with an isolated database
// and per-ticket analyzer replies. No external service or production data.
async function runtime(t, resultFor) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => sql.close());
  const DB = { prepare(query) {
    const statement = sql.prepare(query); let args = [];
    return {
      bind(...values) { assert.ok(values.length <= 100, 'D1 parameter limit'); args = values; return this; },
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args) }; },
      async run() { return this.execute(); },
      execute() { return { meta: { changes: statement.run(...args).changes } }; }
    };
  }, async batch(statements) {
    sql.exec('BEGIN');
    try { const result = statements.map(s => s.execute()); sql.exec('COMMIT'); return result; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } };
  const env = { DB, SESSION_SECRET: 'regression-only', ACCESS_PASSWORD_SHA256: await digest('regression-only'),
    COUPON_ANALYZER: { async fetch(request) {
      const body = await request.json();
      return Response.json({ results: body.items.map(item => ({ label: item.label, url: item.url, ...resultFor(item.url) })) });
    } } };
  const login = await worker.fetch(new Request('https://vault.test/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'regression-only' })
  }), env, {});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function request(path, body) {
    const response = await worker.fetch(new Request('https://vault.test' + path, {
      method: body ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    }), env, {});
    const result = await response.json();
    assert.equal(response.ok, true, JSON.stringify(result));
    return result;
  }
  return { sql, env, request, receive: values => request('/api/receive', { values, clientRequestId: crypto.randomUUID() }) };
}

const pay = balance => ({ status: 'ok', site: 'giftee_box', kind: 'box', boxCategory: 'eraberu_pay',
  groupName: 'えらべるPay', redeemPlace: 'giftee Box', balance, balanceUnit: 'ポイント' });

test('receive keeps each ticket balance and URL across pending and confirmed groups beyond 80 items', async t => {
  const { sql, receive, request } = await runtime(t, url => pay(Number(new URL(url).pathname.slice(1))));
  const urls = Array.from({ length: 82 }, (_, i) => `https://example.test/${i + 1}`);
  await receive(urls);
  const pending = (await request('/api/pending')).items;
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].analysis_amount_summary, {
    totals: [{ unit: 'ポイント', total: 3403, count: 82 }], unknownCount: 0, itemCount: 82
  });
  await request(`/api/pending/${pending[0].id}/confirm`, { action: 'ok' });
  await receive(['https://example.test/500', 'https://example.test/1000']);
  const rows = sql.prepare('SELECT value,status,analysis_json,card_id FROM items').all();
  assert.equal(rows.length, 84);
  assert.equal(new Set(rows.map(row => row.card_id)).size, 1);
  for (const row of rows) {
    const result = JSON.parse(row.analysis_json);
    assert.equal(row.status, 'active');
    assert.equal(result.url, row.value);
    assert.equal(result.balance, Number(new URL(row.value).pathname.slice(1)));
  }
});

test('unresolved tickets retain their individual evidence instead of copying a group representative', async t => {
  const { sql, receive } = await runtime(t, url => ({ status: 'unknown', message: '判定不能', evidence: url }));
  await receive(['https://example.test/a', 'https://example.test/b']);
  for (const row of sql.prepare('SELECT value,status,analysis_json FROM items').all()) {
    assert.equal(row.status, 'unresolved');
    assert.equal(JSON.parse(row.analysis_json).url, row.value);
    assert.equal(JSON.parse(row.analysis_json).evidence, row.value);
  }
});

test('provisional receipt counts input repeats plus existing duplicates and replays its durable counts', async t => {
  const { sql, env, receive, request } = await runtime(t, () => pay(1));
  await changeMode(env, 'A');
  await receive(['https://example.test/existing']);
  const input = { values: ['https://example.test/existing', 'https://example.test/new', 'https://example.test/new'], clientRequestId: crypto.randomUUID() };
  const result = await request('/api/receive', input);
  assert.equal(result.received, 1); assert.equal(result.duplicate, 2); assert.equal(result.job.inputTotal, 3);
  const receipt = sql.prepare('SELECT * FROM provisional_receipts WHERE client_request_id=?').get(input.clientRequestId);
  assert.equal(JSON.parse(receipt.plan_json).length, 2);
  // Existing receipts already have the same raw_json/plan_json format: no migration.
  await changeMode(env, 'normal');
  const replay = await request('/api/receive', input);
  assert.equal(replay.job.id, result.job.id);
  assert.equal(replay.received, 1); assert.equal(replay.duplicate, 2); assert.equal(replay.job.inputTotal, 3);
});

test('provisional COIN+ counts gift codes, including repeats, rather than surrounding text lines', async t => {
  const { env, request } = await runtime(t, () => pay(1));
  await changeMode(env, 'A');
  const text = 'COIN+残高へ加算\nギフトコード ABCD1234EFGH5678\n説明文\nギフトコード ABCD1234EFGH5678';
  const input = { text, clientRequestId: crypto.randomUUID() };
  const result = await request('/api/receive', input);
  assert.equal(result.received, 1); assert.equal(result.duplicate, 1); assert.equal(result.job.inputTotal, 2);
  const replay = await request('/api/receive', input);
  assert.equal(replay.job.id, result.job.id); assert.equal(replay.duplicate, 1);
});
