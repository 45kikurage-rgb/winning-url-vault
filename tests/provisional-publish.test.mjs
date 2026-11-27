import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { publishBucket } from "../src/provisional.js";

function setupDb(t) {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  t.after(() => sql.close());
  const DB = {
    prepare(query) {
      const s = sql.prepare(query);
      let args = [];
      return {
        bind(...v) { args = v; return this; },
        async first() { return s.get(...args) || null; },
        async all() { return { results: s.all(...args) }; },
        async run() { return { meta: { changes: s.run(...args).changes } }; },
        execute() { return { meta: { changes: s.run(...args).changes } }; }
      };
    },
    async batch(statements) {
      sql.exec("BEGIN");
      try {
        const result = statements.map(s => s.execute());
        sql.exec("COMMIT");
        return result;
      } catch (e) { sql.exec("ROLLBACK"); throw e; }
    }
  };
  return { sql, env: { DB } };
}

function seedProvisional(sql, { receiptStatus = "stored" } = {}) {
  const receiptId = crypto.randomUUID();
  sql.prepare("INSERT INTO provisional_receipts(id,owner_key,client_request_id,payload_hash,bucket_id,raw_json,plan_json,status) " +
    "VALUES (?,?,?,?,?,'{}','[]',?)")
    .run(receiptId, "owner", "req-1", "hash", "initial-C", receiptStatus);
  const ids = [];
  for (const value of ["CODE-A", "CODE-B", "CODE-C"]) {
    const id = crypto.randomUUID();
    ids.push(id);
    sql.prepare("INSERT INTO items(id,value,canonical_value,value_type,status) VALUES (?,?,?,'text','provisional')")
      .run(id, value, value);
    sql.prepare("INSERT INTO provisional_entries(item_id,receipt_id,bucket_id) VALUES (?,?, 'initial-C')")
      .run(id, receiptId);
  }
  return ids;
}

const itemRow = (sql, id) => sql.prepare("SELECT status,card_id FROM items WHERE id=?").get(id);
const bucketRow = (sql, id) => sql.prepare("SELECT status FROM provisional_buckets WHERE id=?").get(id);
const activeBucket = sql => sql.prepare("SELECT active_bucket_id FROM provisional_slots WHERE slot='C'").get().active_bucket_id;

test("選択した項目だけがカード化され、残りは暫定に残る", async t => {
  const { sql, env } = setupDb(t);
  const ids = seedProvisional(sql);
  const result = await publishBucket(env, "C", "initial-C", { name: "選択分", item_ids: [ids[0], ids[2]] });
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.equal(result.count, 2);
  assert.equal(itemRow(sql, ids[0]).status, "active");
  assert.equal(itemRow(sql, ids[0]).card_id, result.cardId);
  assert.equal(itemRow(sql, ids[2]).status, "active");
  assert.equal(itemRow(sql, ids[2]).card_id, result.cardId);
  assert.equal(itemRow(sql, ids[1]).status, "provisional");
  assert.equal(itemRow(sql, ids[1]).card_id, null);
  assert.equal(bucketRow(sql, "initial-C").status, "open");
  assert.equal(activeBucket(sql), "initial-C");
});

test("選択カード化の後に残りを全件カード化できる", async t => {
  const { sql, env } = setupDb(t);
  const ids = seedProvisional(sql);
  await publishBucket(env, "C", "initial-C", { name: "選択分", item_ids: [ids[0]] });
  const result = await publishBucket(env, "C", "initial-C", { name: "残り全部" });
  assert.equal(result.count, 2);
  assert.equal(itemRow(sql, ids[1]).status, "active");
  assert.equal(itemRow(sql, ids[2]).status, "active");
  assert.equal(bucketRow(sql, "initial-C").status, "published");
  assert.notEqual(activeBucket(sql), "initial-C");
});

test("item_ids が無い場合は従来どおり全件カード化される", async t => {
  const { sql, env } = setupDb(t);
  const ids = seedProvisional(sql);
  const result = await publishBucket(env, "C", "initial-C", { name: "全件" });
  assert.equal(result.count, 3);
  assert.equal(result.partial, undefined);
  for (const id of ids) assert.equal(itemRow(sql, id).status, "active");
  assert.equal(bucketRow(sql, "initial-C").status, "published");
});

test("選択に他所の項目や処理済みの項目が混じると 409 で何も動かない", async t => {
  const { sql, env } = setupDb(t);
  const ids = seedProvisional(sql);
  await assert.rejects(
    publishBucket(env, "C", "initial-C", { item_ids: [ids[0], crypto.randomUUID()] }),
    error => error.status === 409 && error.code === "PROVISIONAL_CHANGED");
  assert.equal(itemRow(sql, ids[0]).status, "provisional");
  await publishBucket(env, "C", "initial-C", { item_ids: [ids[0]] });
  await assert.rejects(
    publishBucket(env, "C", "initial-C", { item_ids: [ids[0]] }),
    error => error.status === 409 && error.code === "PROVISIONAL_CHANGED");
  assert.equal(itemRow(sql, ids[1]).status, "provisional");
});

test("item_ids の形式が不正なら 400", async t => {
  const { sql, env } = setupDb(t);
  seedProvisional(sql);
  for (const item_ids of [[], ["not-a-uuid"], "x", [null]])
    await assert.rejects(
      publishBucket(env, "C", "initial-C", { item_ids }),
      error => error.status === 400);
});

test("受信中の保管箱では選択カード化も止まる", async t => {
  const { sql, env } = setupDb(t);
  const ids = seedProvisional(sql, { receiptStatus: "receiving" });
  await assert.rejects(
    publishBucket(env, "C", "initial-C", { item_ids: [ids[0]] }),
    error => error.status === 409 && error.code === "PROVISIONAL_BUSY");
  assert.equal(itemRow(sql, ids[0]).status, "provisional");
});

// --- UI: 再描画で開いた状態・入力・チェックが保持されること ---

function makeGroup(slot, { open = false, fields = {}, checkedIds = [], itemIds = [] } = {}) {
  const details = { open };
  const inputs = Object.entries(fields).map(([name, value]) => ({ name, value }));
  const boxes = itemIds.map(id => ({ dataset: { selectItem: id }, checked: checkedIds.includes(id) }));
  const allBox = { checked: false, indeterminate: false };
  const publishSelectedButton = { textContent: "" };
  return {
    dataset: { provisionalSlot: slot },
    details, inputs, boxes, allBox, publishSelectedButton,
    querySelector(selector) {
      if (selector === "details") return details;
      if (selector === "[data-select-all]") return allBox;
      if (selector === "[data-publish-selected]") return publishSelectedButton;
      let m = /^input\[name="(.+)"\]$/.exec(selector);
      if (m) return inputs.find(input => input.name === m[1]) || null;
      m = /^\[data-select-item="(.+)"\]$/.exec(selector);
      if (m) return boxes.find(box => box.dataset.selectItem === m[1]) || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "input[name]") return inputs;
      if (selector === "[data-select-item]") return boxes;
      if (selector === "[data-select-item]:checked") return boxes.filter(box => box.checked);
      return [];
    }
  };
}

test("自動更新の再描画後も、開いた状態・入力・チェックが保持される", async () => {
  const id1 = crypto.randomUUID(), id2 = crypto.randomUUID();
  const container = {
    groups: [], nextGroups: null, html: "",
    set innerHTML(value) {
      this.html = value;
      if (this.nextGroups) { this.groups = this.nextGroups; this.nextGroups = null; }
    },
    get innerHTML() { return this.html; },
    querySelectorAll(selector) {
      return selector === "[data-provisional-slot]" ? this.groups : [];
    }
  };
  const nodes = {
    provisionalSortingResults: container,
    provisionalTotalCount: { textContent: "" },
    receive: { textContent: "" },
    provisionalModeStatus: { textContent: "" },
    receiveContext: { textContent: "" },
    refreshProvisional: { addEventListener() {} }
  };
  globalThis.document = {
    getElementById: id => nodes[id] || null,
    querySelectorAll: () => []
  };
  const { initProvisionalUI, refreshProvisionalUI } = await import("../public/provisional-ui.js");
  const data = {
    mode: "normal",
    buckets: [{ slot: "C", bucketId: "initial-C", count: 2, truncated: false,
      items: [{ id: id1, value: "CODE-A" }, { id: id2, value: "CODE-B" }] }]
  };
  await initProvisionalUI(async () => data, async () => {});
  assert.match(container.html, /data-select-item="/);
  assert.match(container.html, /data-publish-selected="C"/);
  assert.match(container.html, /data-select-all="C"/);

  const oldGroup = makeGroup("C", {
    open: true, fields: { name: "下書きカード名" }, checkedIds: [id1], itemIds: [id1, id2]
  });
  const newGroup = makeGroup("C", {
    open: false, fields: { name: "" }, checkedIds: [], itemIds: [id1, id2]
  });
  container.groups = [oldGroup];
  container.nextGroups = [newGroup];
  await refreshProvisionalUI();
  assert.equal(newGroup.details.open, true);
  assert.equal(newGroup.inputs.find(input => input.name === "name").value, "下書きカード名");
  assert.equal(newGroup.boxes.find(box => box.dataset.selectItem === id1).checked, true);
  assert.equal(newGroup.boxes.find(box => box.dataset.selectItem === id2).checked, false);
  assert.equal(newGroup.allBox.indeterminate, true);
  assert.match(newGroup.publishSelectedButton.textContent, /（1件）/);
});
