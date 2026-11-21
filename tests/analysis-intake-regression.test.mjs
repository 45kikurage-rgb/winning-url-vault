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
      bind(...values) {
        assert.ok(values.length <= 100, 'D1 parameter limit');
        assert.ok(values.every(value => typeof value !== 'string' || Buffer.byteLength(value) <= 2_000_000),
          'D1 string limit');
        args = values;
        return this;
      },
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
      return Response.json({ results: body.items.map(item => ({ label: item.label, url: item.url, ...resultFor(item.url, body) })) });
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

const beer = { status: 'ok', site: 'seven', kind: 'coupon', product: 'ザ・ビタリスト',
  capacity: '350ml', redeemPlace: 'セブンイレブン', expiresOn: '2026-12-01' };

test('finalization recovers 30 already staged image-heavy tickets without fetching them again', async t => {
  let analyzerCalls = 0;
  const { sql, env, receive, request } = await runtime(t, () => {
    analyzerCalls += 1;
    return beer;
  });
  const queue = [];
  env.ANALYSIS_QUEUE = { async send(message) { queue.push(message); } };
  const urls = Array.from({ length: 30 }, (_, i) => `https://example.test/beer/${i}`);
  const { job } = await receive(urls);
  const imageBase64 = 'A'.repeat(245_124);
  const representative = 'data:image/jpeg;base64,' + imageBase64;
  const addStaging = sql.prepare('INSERT INTO analysis_staging(item_id,job_id,batch_no,result_json) VALUES (?,?,0,?)');
  for (const item of sql.prepare('SELECT id,value FROM items').all()) {
    addStaging.run(item.id, job.id, JSON.stringify({ ...beer, url: item.value,
      productImageDataUri: representative, imageBase64 }));
  }
  sql.prepare("UPDATE analysis_job_items SET state='staged' WHERE job_id=?").run(job.id);
  sql.prepare(`UPDATE analysis_jobs SET status='finalizing',finalize_owner='expired',
    finalize_until='2000-01-01T00:00:00.000Z',last_error='SQLITE_TOOBIG' WHERE id=?`).run(job.id);

  let scheduled;
  await worker.scheduled(null, env, { waitUntil(promise) { scheduled = promise; } });
  await scheduled;
  const finalize = queue.find(message => message.type === 'finalize');
  assert.equal(finalize?.jobId, job.id);
  let acknowledgements = 0;
  const delivery = { body: finalize, ack() { acknowledgements += 1; }, retry() { assert.fail('Unexpected retry'); } };
  await worker.queue({ messages: [delivery, delivery] }, env);
  assert.equal(acknowledgements, 2);
  assert.equal(analyzerCalls, 0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS count FROM analysis_staging').get().count, 0);
  const pending = (await request('/api/pending')).items;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].item_count, 30);
  assert.equal(pending[0].image_data_uri, representative);
  await request(`/api/pending/${pending[0].id}/confirm`, { action: 'ok' });
  const cards = (await request('/api/cards')).cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].unassigned_count, 30);
  for (const row of sql.prepare('SELECT value,analysis_json FROM items').all()) {
    assert.deepEqual(JSON.parse(row.analysis_json), { ...beer, url: row.value });
  }
});

test('background intake ignores oversized image fields and fetches only one confirmation image', async t => {
  const requests = [];
  const representative = 'data:image/png;base64,aW1hZ2U=';
  const largeImage = 'A'.repeat(2_100_000);
  const { sql, receive, request } = await runtime(t, (url, body) => {
    requests.push({ url, includeProductImage: body.includeProductImage });
    return { ...beer, productImageDataUri: body.includeProductImage ? representative : 'data:image/jpeg;base64,' + largeImage,
      imageBase64: body.includeProductImage ? 'aW1hZ2U=' : largeImage };
  });
  await receive(['https://example.test/beer/1', 'https://example.test/beer/2']);
  const pending = (await request('/api/pending')).items;
  assert.equal(pending[0].item_count, 2);
  assert.equal(pending[0].image_data_uri, representative);
  assert.equal(requests.filter(item => item.includeProductImage).length, 1);
  for (const { analysis_json } of sql.prepare('SELECT analysis_json FROM items').all()) {
    const analysis = JSON.parse(analysis_json);
    assert.equal(analysis.product, beer.product);
    assert.equal(analysis.imageBase64, undefined);
    assert.equal(analysis.productImageDataUri, undefined);
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
