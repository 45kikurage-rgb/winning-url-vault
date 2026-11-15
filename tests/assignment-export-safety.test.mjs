import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { assignmentPreview, assignCardToCampaign, reassignmentPreview, reassignWinningProduct } from '../src/ledger.js';
import { listWinningLists, completeExportBatch, cancelExportBatch, undoExportBatch } from '../src/extraction.js';

function database(t) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => sql.close());
  return { sql, beforeBatch:null, prepare(query) {
    const statement = sql.prepare(query); let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() { return statement.get(...args) || null; },
      async all() { return { results:statement.all(...args) }; },
      async run() { return { meta:{ changes:statement.run(...args).changes } }; }
    };
  }, async batch(statements) {
    if (this.beforeBatch) { const hook = this.beforeBatch; this.beforeBatch = null; await hook(); }
    sql.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      sql.exec('COMMIT'); return results;
    } catch (error) { sql.exec('ROLLBACK'); throw error; }
  } };
}

function seed(DB) {
  DB.sql.exec(`INSERT INTO product_master(id,raw_name,normalized_name,display_name,redeem_place,match_key)
    VALUES ('master','商品','商品','商品','店舗','key');
    INSERT INTO cards(id,product_id) VALUES ('card','master');
    INSERT INTO vault_campaigns(campaign_id,campaign_name,lottery_start_date,status,last_refreshed_at)
    VALUES ('A','A','2026-11-01','active','2026-11-01'),('B','B','2026-11-01','active','2026-11-01');`);
  addItem(DB,'initial');
}
function addItem(DB,id) {
  DB.sql.prepare(`INSERT INTO items(id,value,canonical_value,value_type,card_id,status,received_at)
    VALUES (?,?,?,'url','card','active','2026-11-01')`).run(id,'https://example.test/'+id,id);
}

test('an archived exact product reopens under its existing ID after reassignment without moving earlier winnings back',async t => {
  const DB = database(t), env = { DB }; seed(DB);
  const original = await assignCardToCampaign(env,'card','A');
  await DB.prepare("UPDATE ledger_products SET output_method='normal',unit_price=100 WHERE product_id=?")
    .bind(original.product_id).run();
  const preview = await reassignmentPreview(env,original.product_id,'B');
  const moved = await reassignWinningProduct(env,original.product_id,'B',preview.preview_key);
  const earlier = DB.sql.prepare('SELECT * FROM item_campaign_assignments WHERE item_id=?').get('initial');
  const outboxBefore = DB.sql.prepare('SELECT * FROM ledger_outbox ORDER BY id').all();
  addItem(DB,'new');
  const result = await assignCardToCampaign(env,'card','A');
  assert.equal(result.product_id,original.product_id);
  assert.equal(result.assigned_count,1);
  assert.equal(result.reused,true);
  const restored = DB.sql.prepare('SELECT * FROM ledger_products WHERE product_id=?').get(original.product_id);
  assert.equal(restored.is_archived,0);
  assert.equal(restored.campaign_id,'A');
  assert.equal(restored.output_method,'normal');
  assert.equal(restored.unit_price,100);
  assert.deepEqual(DB.sql.prepare('SELECT * FROM item_campaign_assignments WHERE item_id=?').get('initial'),earlier);
  assert.equal(earlier.product_id,moved.product_id);
  assert.equal(DB.sql.prepare('SELECT COUNT(*) n FROM ledger_products').get().n,2);
  for (const row of outboxBefore) assert.deepEqual(DB.sql.prepare('SELECT * FROM ledger_outbox WHERE id=?').get(row.id),row);
  const lists = await listWinningLists(env);
  assert.deepEqual(lists.map(row=>[row.campaign_id,row.total_count]).sort(),[['A',1],['B',1]]);
});

for (const route of ['legacy-name','explicit-similar']) test(`archived products use the same safe revival through ${route}`,async t => {
  const DB = database(t), env = { DB }; seed(DB);
  const original = await assignCardToCampaign(env,'card','A');
  DB.sql.prepare('UPDATE ledger_products SET is_archived=1,identity_key=?,product_name=? WHERE product_id=?')
    .run('legacy-identity',route==='legacy-name'?'商品':'以前の商品',original.product_id);
  DB.sql.prepare("UPDATE item_campaign_assignments SET exported_at='2026-11-02',export_method='single' WHERE item_id='initial'").run();
  const earlier = DB.sql.prepare('SELECT * FROM item_campaign_assignments WHERE item_id=?').get('initial');
  addItem(DB,'new');
  const preview = await assignmentPreview(env,'card','A');
  if (route==='legacy-name') assert.equal(preview.exact_product.product_id,original.product_id);
  else {
    assert.equal(preview.exact_product,null);
    assert.equal(preview.possible_products[0].product_id,original.product_id);
    assert.equal(preview.possible_products[0].is_archived,1);
    await assert.rejects(assignCardToCampaign(env,'card','A'),{code:'PRODUCT_DECISION_REQUIRED'});
  }
  const result = await assignCardToCampaign(env,'card','A',route==='explicit-similar'?{product_id:original.product_id}:{});
  assert.equal(result.product_id,original.product_id);
  assert.equal(DB.sql.prepare('SELECT is_archived FROM ledger_products WHERE product_id=?').get(original.product_id).is_archived,0);
  assert.deepEqual(DB.sql.prepare('SELECT * FROM item_campaign_assignments WHERE item_id=?').get('initial'),earlier);
  assert.equal((await listWinningLists(env))[0].total_count,2);
});

test('an explicit archived product from a different campaign is rejected without revival',async t => {
  const DB = database(t), env = { DB }; seed(DB);
  const original = await assignCardToCampaign(env,'card','A');
  DB.sql.prepare('UPDATE ledger_products SET is_archived=1 WHERE product_id=?').run(original.product_id);
  addItem(DB,'new');
  await assert.rejects(assignCardToCampaign(env,'card','B',{product_id:original.product_id}),{code:'PRODUCT_NOT_FOUND'});
  assert.equal(DB.sql.prepare('SELECT is_archived FROM ledger_products WHERE product_id=?').get(original.product_id).is_archived,1);
  assert.equal(DB.sql.prepare("SELECT COUNT(*) n FROM item_campaign_assignments WHERE item_id='new'").get().n,0);
});

async function exportFixture(t) {
  const DB = database(t), env = { DB }; seed(DB);
  for (let i=0;i<160;i++) addItem(DB,'extra-'+i);
  const assigned = await assignCardToCampaign(env,'card','A');
  DB.sql.prepare("UPDATE ledger_products SET output_method='normal' WHERE product_id=?").run(assigned.product_id);
  const ids = DB.sql.prepare('SELECT item_id FROM item_campaign_assignments ORDER BY item_id').all().map(row=>row.item_id);
  DB.sql.prepare("INSERT INTO export_batches(id,product_id,item_ids_json,status,item_count) VALUES ('batch',?,?,'pending',?)")
    .run(assigned.product_id,JSON.stringify(ids),ids.length);
  return { DB,env,ids };
}

test('cancel winning after completion read leaves every chunk unexported despite the stale completion request',async t => {
  const { DB,env } = await exportFixture(t);
  const before = DB.sql.prepare('SELECT * FROM item_campaign_assignments ORDER BY item_id').all();
  DB.beforeBatch = () => cancelExportBatch(env,'batch');
  await assert.rejects(completeExportBatch(env,'batch'),{code:'EXPORT_BATCH_NOT_PENDING'});
  assert.equal(DB.sql.prepare("SELECT status FROM export_batches WHERE id='batch'").get().status,'cancelled');
  assert.deepEqual(DB.sql.prepare('SELECT * FROM item_campaign_assignments ORDER BY item_id').all(),before);
});

test('ordinary completion and undo preserve multi-chunk extraction behavior',async t => {
  const { DB,env,ids } = await exportFixture(t);
  const completed = await completeExportBatch(env,'batch');
  assert.equal(completed.changed_count,ids.length);
  assert.equal(DB.sql.prepare("SELECT COUNT(*) n FROM item_campaign_assignments WHERE export_batch_id='batch' AND exported_at IS NOT NULL").get().n,ids.length);
  assert.equal((await undoExportBatch(env,'batch')).undone_count,ids.length);
  assert.equal(DB.sql.prepare('SELECT COUNT(*) n FROM item_campaign_assignments WHERE exported_at IS NOT NULL').get().n,0);
});
