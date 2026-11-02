import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { processOutbox } from '../src/ledger.js';

// Independent C gate: queue fairness, positive ACK proof, and interrupted bodies.
function database(t) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => sql.close());
  return { sql, prepare(query) {
    const statement = sql.prepare(query); let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return statement.get(...values) || null; },
      async all() { return { results:statement.all(...values) }; },
      async run() { const result = statement.run(...values); return { meta:{ changes:result.changes } }; }
    };
  } };
}
function add(DB, id, source, revision, created = '2026-11-01T00:00:00.000Z') {
  DB.sql.prepare(`INSERT INTO ledger_outbox
    (id,source_record_id,source_revision,path,payload_json,status,created_at,updated_at)
    VALUES (?,?,?,'/api/v1/products/sync',?,'pending',?,?)`).run(id, source, revision,
    JSON.stringify({ source_system:'winning-url-vault', source_record_id:source, source_revision:revision, data:{ product_id:source } }), created, created);
}
const row = (DB, id) => DB.sql.prepare('SELECT * FROM ledger_outbox WHERE id=?').get(id);
const applied = () => Response.json({ ok:true, result:'applied' });

for (const blockedBy of ['permanent', 'backoff']) test(`C gate: ${blockedBy} predecessors cannot starve an unrelated series behind more than one batch`, async t => {
  const DB = database(t);
  add(DB, 'blocked-1', 'blocked-product', 1);
  DB.sql.prepare("UPDATE ledger_outbox SET status='failed',next_attempt_at=? WHERE id='blocked-1'")
    .run(blockedBy === 'permanent' ? null : '2999-01-01T00:00:00.000Z');
  for (let revision = 2; revision <= 32; revision++) add(DB, 'blocked-' + revision, 'blocked-product', revision);
  add(DB, 'independent', 'independent-product', 1, '2026-11-02T00:00:00.000Z');
  const sent = [];
  const env = { DB, LEDGER_VAULT:{ async fetch(request) { sent.push(await request.json()); return applied(); } } };
  await processOutbox(env, { limit:25 });
  assert.equal(row(DB, 'independent').status, 'sent', 'Blocked successors filled the selection LIMIT and starved a different product');
  assert.deepEqual(sent.map(value => value.source_record_id), ['independent-product']);
  assert.equal(row(DB, 'blocked-1').status, 'failed');
  assert.equal(row(DB, 'blocked-2').attempts, 0);
});

for (const payload of [{}, { result:'applied' }, { ok:true, result:'queued' }, { ok:'true', result:'applied' }]) {
  test('C gate: mutation requires a positive final ACK: ' + JSON.stringify(payload), async t => {
    const DB = database(t); add(DB, 'one', 'one', 1);
    const result = await processOutbox({ DB, LEDGER_VAULT:{ async fetch() { return Response.json(payload); } } });
    assert.equal(row(DB, 'one').status, 'failed', 'A valid JSON body without a final success ACK must not be recorded as sent');
    assert.equal(row(DB, 'one').sent_at, null);
    assert.equal(result.results[0].retryable, false);
  });
}

test('C gate: a response body that stalls after headers is bounded by the same timeout', async t => {
  const DB = database(t); add(DB, 'body-timeout', 'body-timeout', 1);
  let entered, aborted = false, body;
  const headersReceived = new Promise(resolve => { entered = resolve; });
  t.mock.timers.enable({ apis:['setTimeout'] });
  const delivery = processOutbox({ DB, LEDGER_VAULT:{ fetch(request) {
    request.signal.addEventListener('abort', () => { aborted = true; });
    const response = new Response(new ReadableStream({ start(controller) { body = controller; } }));
    entered(); return response;
  } } });
  await headersReceived; t.mock.timers.tick(10000);
  const result = await delivery;
  body.close();
  assert.equal(aborted, true); assert.equal(result.results[0].retryable, true);
  assert.equal(row(DB, 'body-timeout').status, 'failed');
  assert.match(row(DB, 'body-timeout').last_error, /LEDGER_TIMEOUT/);
});

test('C gate: accepted upstream then unreadable response replays the exact revision as duplicate', async t => {
  const DB = database(t); add(DB, 'uncertain', 'uncertain', 7);
  const before = row(DB, 'uncertain').payload_json, received = [];
  const env = { DB, LEDGER_VAULT:{ async fetch(request) {
    received.push(await request.text());
    if (received.length === 1) return new Response(new ReadableStream({ start(controller) { controller.error(new Error('body disconnected')); } }));
    return Response.json({ ok:true, result:'duplicate' });
  } } };
  const first = await processOutbox(env);
  assert.equal(first.results[0].retryable, true);
  DB.sql.prepare("UPDATE ledger_outbox SET next_attempt_at='2020-01-01' WHERE id='uncertain'").run();
  const retried = await processOutbox(env);
  assert.equal(retried.results[0].result, 'duplicate'); assert.equal(row(DB, 'uncertain').status, 'sent');
  assert.deepEqual(received, [before, before]); assert.equal(row(DB, 'uncertain').source_revision, 7);
});
