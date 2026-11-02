import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { issueSendingToken } from '../src/sending-auth.js';
import { changeMode } from '../src/provisional.js';

// Independent C gate: keep persisted receipt ownership when receive mode changes
// between a lost ACK and replay, including a partly committed provisional batch.
function database(t) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => sql.close());
  return { sql, batches:0, failAt:0, prepare(query) {
    const statement = sql.prepare(query); let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return statement.get(...values) || null; },
      async all() { return { results:statement.all(...values) }; },
      async run() { const result = statement.run(...values); return { meta:{ changes:result.changes } }; },
      execute() { return statement.run(...values); }
    };
  }, async batch(statements) {
    this.batches++; sql.exec('BEGIN');
    try {
      const result = statements.map((statement, index) => {
        if (this.batches === this.failAt && index === 1) throw new Error('C gate injected provisional write failure');
        return statement.execute();
      });
      sql.exec('COMMIT'); return result;
    } catch (error) { sql.exec('ROLLBACK'); throw error; }
  } };
}
const rows = (DB, table) => DB.sql.prepare('SELECT * FROM ' + table).all();
const input = values => ({ values, clientRequestId:crypto.randomUUID() });
async function setup(t) {
  const DB = database(t), background = [], messages = [];
  const env = { DB, SESSION_SECRET:'C-review-only', ANALYSIS_QUEUE:{
    async send(message) { messages.push(message); },
    async sendBatch(batch) { messages.push(...batch.map(x => x.body)); }
  } };
  const token = (await issueSendingToken(env, { deviceId:'01' })).token;
  const ctx = { waitUntil(promise) { background.push(promise); } };
  async function call(payload, source = 'arunomatic') {
    const response = await worker.fetch(new Request('https://vault.test/api/' + (source === 'chiritumo' ? 'chiritumo/receive' : 'receive'), {
      method:'POST', headers:{ 'content-type':'application/json', ...(source === 'arunomatic' ? { authorization:'Bearer ' + token } : {}) },
      body:JSON.stringify(payload)
    }), env, ctx);
    return { status:response.status, body:await response.json() };
  }
  return { DB, env, background, messages, call };
}

test('C gate: a normal receipt replay stays normal after switching to provisional with dispatch still blocked', async t => {
  const { DB, env, background, messages, call } = await setup(t);
  let release; const blocked = new Promise(resolve => { release = resolve; });
  env.ANALYSIS_QUEUE.sendBatch = async () => blocked;
  const payload = input(['https://example.test/ack-lost-before-mode-switch']);
  try {
    const original = await call(payload);
    assert.equal(original.body.stored, true);
    await changeMode(env, 'A');
    const replay = await call(payload);
    assert.equal(replay.body.stored, true);
    assert.equal(replay.body.job.id, original.body.job.id);
    assert.equal(replay.body.provisional, undefined);
    assert.equal(rows(DB, 'items').length, 1);
    assert.equal(rows(DB, 'provisional_receipts').length, 0);
    assert.equal(rows(DB, 'intake_receipts')[0].dispatched, 0);
    assert.equal(messages.length, 0);
    const conflict = await call({ ...payload, values:['https://example.test/changed'] });
    assert.equal(conflict.status, 409); assert.equal(conflict.body.stored, false);
  } finally { release(); await Promise.all(background); }
});

test('C gate: provisional lost-ACK replay keeps its original bucket through two receive-mode changes', async t => {
  const { DB, env, background, messages, call } = await setup(t);
  await changeMode(env, 'A');
  const payload = input(['https://example.test/held-in-A']);
  const original = await call(payload), receipt = rows(DB, 'provisional_receipts')[0];
  assert.equal(original.body.stored, true); assert.equal(original.body.mode, 'A');
  for (const mode of ['B', 'normal']) {
    await changeMode(env, mode);
    const replay = await call(payload);
    assert.equal(replay.body.job.id, original.body.job.id);
    assert.equal(replay.body.provisional, true); assert.equal(replay.body.mode, 'A');
    assert.equal(replay.body.received, 1); assert.equal(replay.body.duplicate, 0);
  }
  const conflict = await call({ ...payload, values:['https://example.test/changed'] });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.stored, false);
  assert.equal(rows(DB, 'provisional_receipts').length, 1);
  assert.equal(rows(DB, 'provisional_entries')[0].bucket_id, receipt.bucket_id);
  assert.equal(rows(DB, 'intake_receipts').length, 0);
  assert.equal(rows(DB, 'items').length, 1);
  assert.equal(background.length, 0); assert.equal(messages.length, 0);
});

test('C gate: provisional partial failure resumes its original bucket after switching back to normal', async t => {
  const { DB, env, background, messages, call } = await setup(t);
  await changeMode(env, 'A');
  const payload = input(Array.from({ length:65 }, (_, i) => `https://example.test/held-partial-${i}`));
  DB.failAt = DB.batches + 2;
  const failed = await call(payload);
  assert.equal(failed.status, 503); assert.equal(failed.body.stored, false);
  assert.equal(rows(DB, 'items').length, 30);
  assert.equal(rows(DB, 'provisional_receipts')[0].status, 'receiving');
  const bucket = rows(DB, 'provisional_receipts')[0].bucket_id;
  await changeMode(env, 'normal');
  const replay = await call(payload);
  assert.equal(replay.body.stored, true); assert.equal(replay.body.provisional, true);
  assert.equal(replay.body.received, 65); assert.equal(replay.body.mode, 'A');
  assert.equal(rows(DB, 'items').length, 65);
  assert.ok(rows(DB, 'items').every(item => item.status === 'provisional'));
  assert.ok(rows(DB, 'provisional_entries').every(entry => entry.bucket_id === bucket));
  assert.equal(rows(DB, 'intake_receipts').length, 0);
  assert.equal(background.length, 0); assert.equal(messages.length, 0);
  assert.deepEqual(DB.sql.prepare('PRAGMA foreign_key_check').all(), []);
});

test('C gate: Chiritumo bypasses provisional mode but never takes ownership of a URL already held by ARUNOMATIC', async t => {
  const { DB, env, background, call } = await setup(t);
  await changeMode(env, 'A');
  const shared = 'https://example.test/shared-origin';
  const arunomatic = await call(input([shared]));
  assert.equal(arunomatic.body.provisional, true);
  const payload = input([shared, 'https://example.test/chiritumo-only']);
  const chiritumo = await call(payload, 'chiritumo');
  await Promise.all(background);
  assert.equal(chiritumo.body.stored, true); assert.equal(chiritumo.body.provisional, undefined);
  assert.equal(chiritumo.body.received, 1); assert.equal(chiritumo.body.duplicate, 1);
  const items = rows(DB, 'items');
  assert.equal(items.length, 2);
  assert.equal(items.find(item => item.value === shared).status, 'provisional');
  assert.equal(items.find(item => item.value === shared).intake_source, 'arunomatic');
  assert.equal(items.find(item => item.value.endsWith('/chiritumo-only')).intake_source, 'chiritumo');
  assert.equal(rows(DB, 'provisional_entries').length, 1);
  assert.equal(rows(DB, 'analysis_job_items').length, 1);
  const replay = await call(payload, 'chiritumo');
  await Promise.all(background);
  assert.equal(replay.body.job.id, chiritumo.body.job.id);
  assert.equal(replay.body.received, 1); assert.equal(replay.body.duplicate, 1);
});
