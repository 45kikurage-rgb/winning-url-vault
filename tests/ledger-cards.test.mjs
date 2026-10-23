import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { cardAssignments, enrichCards } from "../src/ledger.js";

function database(t) {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  t.after(() => sql.close());
  const queries = [];
  return { sql, queries, prepare(query) {
    queries.push(query);
    const statement = sql.prepare(query);
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args) }; }
    };
  } };
}

function addCard(DB, id) {
  DB.sql.prepare(`INSERT INTO product_master
    (id,raw_name,normalized_name,display_name,redeem_place,match_key)
    VALUES (?,?,?,?,?,?)`).run("master:" + id, id, id, id, "店舗", id);
  DB.sql.prepare("INSERT INTO cards(id,product_id) VALUES (?,?)").run(id, "master:" + id);
  return { id, display_name: id, count: 0 };
}

function addItem(DB, id, cardId, status = "active", productId = null, campaignId = "a") {
  DB.sql.prepare(`INSERT INTO items(id,value,canonical_value,value_type,card_id,status)
    VALUES (?,?,?,'url',?,?)`).run(id, "https://example.test/" + id, id, cardId, status);
  if (productId) DB.sql.prepare(`INSERT INTO item_campaign_assignments
    (item_id,campaign_id,product_id,assigned_at) VALUES (?,?,?,'2026-10-01')`)
    .run(id, campaignId, productId);
}

function addProduct(DB, id, cardId, campaignId) {
  DB.sql.prepare(`INSERT INTO ledger_products
    (product_id,campaign_id,card_id,product_name,identity_key,assigned_at)
    VALUES (?,?,?,?,?,'2026-10-01')`).run(id, campaignId, cardId, id, id);
}

// Reference behavior before the set-based count: each card ran its own COUNT.
async function previousEnrichCards(env, cards) {
  const assignments = await cardAssignments(env);
  for (const card of cards) {
    const row = await env.DB.prepare(`SELECT COUNT(*) count FROM items i WHERE i.card_id=? AND i.status='active'
      AND NOT EXISTS(SELECT 1 FROM item_campaign_assignments a WHERE a.item_id=i.id)`)
      .bind(card.id).first();
    card.unassigned_count = Number(row?.count || 0);
    card.assignments = assignments.get(card.id) || [];
  }
  return cards;
}

test("card enrichment preserves all fields and counts across campaigns and item states", async t => {
  const DB = database(t);
  const cards = ["mixed", "assigned", "inactive", "empty"].map(id => addCard(DB, id));
  for (const id of ["a", "b"]) DB.sql.prepare(`INSERT INTO vault_campaigns
    (campaign_id,campaign_name,lottery_start_date,status,last_refreshed_at)
    VALUES (?,?,'2026-10-01','active','2026-10-01')`).run(id, "Campaign " + id);
  addProduct(DB, "mixed-a", "mixed", "a");
  addProduct(DB, "mixed-b", "mixed", "b");
  addProduct(DB, "assigned-a", "assigned", "a");
  addItem(DB, "unassigned-1", "mixed");
  addItem(DB, "unassigned-2", "mixed");
  addItem(DB, "assigned-a", "mixed", "active", "mixed-a");
  addItem(DB, "assigned-b", "mixed", "active", "mixed-b", "b");
  addItem(DB, "assigned-used", "mixed", "used", "mixed-a");
  for (const status of ["used", "pending_confirmation", "unresolved", "provisional", "queued"])
    addItem(DB, "mixed-" + status, "mixed", status);
  addItem(DB, "fully-assigned", "assigned", "active", "assigned-a");
  addItem(DB, "inactive-used", "inactive", "used");
  addItem(DB, "without-card", null);
  DB.sql.prepare(`INSERT INTO ledger_outbox
    (id,source_record_id,source_revision,path,payload_json,status,last_error)
    VALUES ('sync-a','product:mixed-a',1,'/api/v1/products/sync','{}','failed','fixture error')`).run();
  const before = DB.sql.prepare("SELECT * FROM items ORDER BY id").all();
  const expected = await previousEnrichCards({ DB }, structuredClone(cards));
  const actual = await enrichCards({ DB }, cards);
  assert.strictEqual(actual, cards);
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.map(card => card.unassigned_count), [2, 0, 0, 0]);
  assert.equal(actual[0].assignments.length, 2);
  assert.equal(actual[0].assignments.find(row => row.product_id === "mixed-a").sync_error, "fixture error");
  const subset = [structuredClone(cards[1]), structuredClone(cards[0])];
  assert.deepEqual(await enrichCards({ DB }, subset),
    await previousEnrichCards({ DB }, structuredClone(subset)));
  assert.deepEqual(DB.sql.prepare("SELECT * FROM items ORDER BY id").all(), before);
});

test("card enrichment uses a constant two queries even above D1's per-query bind limit", async t => {
  const DB = database(t);
  const cards = Array.from({ length: 205 }, (_, index) => addCard(DB, "card-" + index));
  cards.forEach(card => addItem(DB, "item-" + card.id, card.id));
  const expected = await previousEnrichCards({ DB }, structuredClone(cards));
  assert.equal(DB.queries.length, cards.length + 1);
  DB.queries.length = 0;
  const actual = await enrichCards({ DB }, cards);
  assert.deepEqual(actual, expected);
  assert.equal(DB.queries.length, 2);
  assert.ok(actual.every(card => card.unassigned_count === 1));
});

test("empty card enrichment preserves the empty array without reading assignments or items", async t => {
  const DB = database(t), cards = [];
  assert.strictEqual(await enrichCards({ DB }, cards), cards);
  assert.equal(DB.queries.length, 0);
});
