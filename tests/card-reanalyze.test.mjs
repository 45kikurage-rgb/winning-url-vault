import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { digest } from '../src/sending-auth.js';
import { changeMode } from '../src/provisional.js';

// Items published from a provisional bucket were never analyzed. The card
// re-judgement endpoint must run them through the normal classification:
// code types land on their code card, URLs are analyzed (confirmed product
// card / first-time confirmation / unresolved / used), and anything else
// becomes unresolved. Campaign-assigned items and items without the
// provisional marker are never touched.
async function runtime(t, resultFor) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => sql.close());
  const DB = { prepare(query) {
    const statement = sql.prepare(query); let args = [];
    return {
      bind(...values) { args = values; return this; },
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
  const env = { DB, SESSION_SECRET: 'test'.padEnd(32, 'x'),
    ACCESS_PASSWORD_SHA256: await digest('reanalyze-only'),
    COUPON_ANALYZER: { async fetch(request) {
      const body = await request.json();
      return Response.json({ results: body.items.map(item => ({ label: item.label, url: item.url, ...resultFor(item.url, body) })) });
    } } };
  const login = await worker.fetch(new Request('https://vault.test/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'reanalyze-only' })
  }), env, {});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function request(path, body, headers = {}) {
    const response = await worker.fetch(new Request('https://vault.test' + path, {
      method: body ? 'POST' : 'GET',
      headers: { cookie, 'content-type': 'application/json', origin: 'https://vault.test', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {})
    }), env, {});
    return { status: response.status, body: await response.json() };
  }
  return { sql, env, request,
    receive: values => request('/api/receive', { values, clientRequestId: crypto.randomUUID() }) };
}

const beer = { status: 'ok', site: 'seven', kind: 'coupon', product: 'ザ・ビタリスト',
  capacity: '350ml', redeemPlace: 'セブンイレブン', expiresOn: '2026-12-01' };

async function publishProvisional(t, runtimeParts, slot, values) {
  const { env, request } = runtimeParts;
  await changeMode(env, slot);
  const held = await request('/api/receive', { values, clientRequestId: crypto.randomUUID() });
  assert.equal(held.status, 202, JSON.stringify(held.body));
  const overview = await request('/api/provisional');
  const bucket = overview.body.buckets.find(row => row.slot === slot);
  assert.ok(bucket?.bucketId, 'bucket id from the overview');
  const published = await request(`/api/provisional/${slot}/publish`, { bucket_id: bucket.bucketId });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  await changeMode(env, 'normal');
  return published.body.cardId;
}

test('re-judgement classifies provisional card items like a normal retry', async t => {
  const parts = await runtime(t, url => url.includes('beer') ? beer : { status: 'unknown', message: '判定不能' });
  const { sql, request } = parts;
  const cardId = await publishProvisional(t, parts, 'C', [
    'EFGH5678IJKL9012',
    'https://example.test/beer/1',
    'https://example.test/mystery',
    'ただのメモテキスト'
  ]);
  const cards = (await request('/api/cards')).body.cards;
  const provisionalCard = cards.find(card => card.id === cardId);
  assert.ok(provisionalCard, 'provisional card is listed');
  assert.equal(provisionalCard.provisional_count, 4);

  const result = await request(`/api/cards/${cardId}/reanalyze`, { confirmation: '再判定' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.processed, 4);
  assert.equal(result.body.remaining, 0);
  assert.deepEqual(result.body.outcomes, { active: 1, pending_confirmation: 1, unresolved: 2 });

  const paypay = sql.prepare("SELECT * FROM items WHERE value='EFGH5678IJKL9012'").get();
  assert.equal(paypay.status, 'active');
  assert.notEqual(paypay.card_id, cardId);
  assert.equal(JSON.parse(paypay.analysis_json).provisional, undefined,
    'the provisional marker is removed once a code item lands on its code card');
  const beerItem = sql.prepare("SELECT * FROM items WHERE value='https://example.test/beer/1'").get();
  assert.equal(beerItem.status, 'pending_confirmation');
  assert.ok(beerItem.pending_id);
  for (const value of ['https://example.test/mystery', 'ただのメモテキスト']) {
    const item = sql.prepare('SELECT * FROM items WHERE value=?').get(value);
    assert.equal(item.status, 'unresolved', value);
    assert.ok(sql.prepare('SELECT item_id FROM unresolved_items WHERE item_id=?').get(item.id), value);
  }
  assert.equal(sql.prepare("SELECT COUNT(*) AS count FROM items WHERE card_id=? AND status='active'").get(cardId).count, 0);
  const after = (await request('/api/cards')).body.cards;
  assert.equal(after.some(card => card.id === cardId), false, 'the emptied provisional card disappears');

  const again = await request(`/api/cards/${cardId}/reanalyze`, { confirmation: '再判定' });
  assert.equal(again.body.processed, 0);
});

test('re-judgement moves URL items onto an already confirmed product card', async t => {
  const parts = await runtime(t, () => beer);
  const { sql, request } = parts;
  await request('/api/receive', { values: ['https://example.test/beer/9'], clientRequestId: crypto.randomUUID() });
  const pending = (await request('/api/pending')).body.items;
  assert.equal(pending.length, 1);
  const confirmed = await request(`/api/pending/${pending[0].id}/confirm`, { action: 'ok' });
  const beerCardId = confirmed.body.cardId;
  assert.ok(beerCardId);

  const cardId = await publishProvisional(t, parts, 'B', ['https://example.test/beer/10']);
  const result = await request(`/api/cards/${cardId}/reanalyze`, { confirmation: '再判定' });
  assert.equal(result.body.processed, 1);
  assert.deepEqual(result.body.outcomes, { active: 1 });
  const item = sql.prepare("SELECT * FROM items WHERE value='https://example.test/beer/10'").get();
  assert.equal(item.status, 'active');
  assert.equal(item.card_id, beerCardId);
});

test('campaign-assigned provisional items are skipped and stay on the card', async t => {
  const parts = await runtime(t, () => beer);
  const { sql, request } = parts;
  const cardId = await publishProvisional(t, parts, 'A', ['EFGH5678IJKL9012']);
  const item = sql.prepare("SELECT * FROM items WHERE value='EFGH5678IJKL9012'").get();
  const card = sql.prepare('SELECT product_id FROM cards WHERE id=?').get(cardId);
  sql.prepare(`INSERT INTO ledger_products (product_id,campaign_id,card_id,product_name,identity_key,assigned_at)
    VALUES (?,?,?,?,?,?)`).run(card.product_id, 'campaign-x', cardId, '暫定C', 'test-identity', '2026-11-27T00:00:00.000Z');
  sql.prepare(`INSERT INTO item_campaign_assignments (item_id,campaign_id,product_id,assigned_at)
    VALUES (?,?,?,?)`).run(item.id, 'campaign-x', card.product_id, '2026-11-27T00:00:00.000Z');
  const cards = (await request('/api/cards')).body.cards;
  assert.equal(cards.find(row => row.id === cardId)?.provisional_count ?? 0, 0);
  const result = await request(`/api/cards/${cardId}/reanalyze`, { confirmation: '再判定' });
  assert.equal(result.body.processed, 0);
  const after = sql.prepare('SELECT * FROM items WHERE id=?').get(item.id);
  assert.equal(after.status, 'active');
  assert.equal(after.card_id, cardId);
});

test('re-judgement requires the confirmation text and an existing card', async t => {
  const parts = await runtime(t, () => beer);
  const { request } = parts;
  const cardId = await publishProvisional(t, parts, 'D', ['EFGH5678IJKL9012']);
  const wrong = await request(`/api/cards/${cardId}/reanalyze`, { confirmation: '削除' });
  assert.equal(wrong.status, 400);
  const missing = await request(`/api/cards/${crypto.randomUUID()}/reanalyze`, { confirmation: '再判定' });
  assert.equal(missing.status, 404);
  const noOrigin = await request(`/api/cards/${cardId}/reanalyze`, { confirmation: '再判定' }, { origin: 'https://evil.test' });
  assert.equal(noOrigin.status, 403);
});

test('partial (selected) publish still counts and re-judges its items', async t => {
  const parts = await runtime(t, () => ({ status: 'unknown', message: '判定不能' }));
  const { env, request } = parts;
  await changeMode(env, 'C');
  const held = await request('/api/receive', {
    values: ['EFGH5678IJKL9012', 'https://example.test/partial-a', 'https://example.test/partial-b'],
    clientRequestId: crypto.randomUUID()
  });
  assert.equal(held.status, 202, JSON.stringify(held.body));
  const overview = await request('/api/provisional');
  const bucket = overview.body.buckets.find(row => row.slot === 'C');
  assert.ok(bucket?.bucketId);
  assert.equal(bucket.items.length, 3);
  const selected = bucket.items.slice(0, 2).map(item => item.id);
  const published = await request('/api/provisional/C/publish', { bucket_id: bucket.bucketId, item_ids: selected });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  await changeMode(env, 'normal');
  const cardId = published.body.cardId;
  const cards = (await request('/api/cards')).body.cards;
  assert.equal(cards.find(card => card.id === cardId)?.provisional_count, 2);
  const result = await request(`/api/cards/${cardId}/reanalyze`, { confirmation: '再判定' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.processed, 2);
});

test('re-judgement processes at most 100 items per call and reports the rest', async t => {
  const parts = await runtime(t, () => beer);
  const { request } = parts;
  const codes = Array.from({ length: 101 }, (_, i) => 'C' + String(i).padStart(15, '0'));
  const cardId = await publishProvisional(t, parts, 'E', codes);
  const first = await request(`/api/cards/${cardId}/reanalyze`, { confirmation: '再判定' });
  assert.equal(first.body.processed, 100);
  assert.equal(first.body.remaining, 1);
  const second = await request(`/api/cards/${cardId}/reanalyze`, { confirmation: '再判定' });
  assert.equal(second.body.processed, 1);
  assert.equal(second.body.remaining, 0);
});
