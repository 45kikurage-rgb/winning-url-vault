import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readMyBestRevenue } from "../src/mybest-daily-revenue.js";

const clock=Date.parse("2026-11-02T15:00:00Z");
function fixture() {
  const sql=new DatabaseSync(":memory:");
  sql.exec(`
    CREATE TABLE items(id,received_at,status);
    CREATE TABLE item_campaign_assignments(item_id,product_id,campaign_id);
    CREATE TABLE ledger_products(product_id,unit_price);
    CREATE TABLE product_monthly_revenue(month,product_id,campaign_id,unit_price,winner_count,amount,source_revision,finalized_at);
    INSERT INTO ledger_products VALUES ('p',300);
    INSERT INTO items VALUES (1,'2026-10-31T14:59:59Z','active'), (2,'2026-10-31T15:00:00Z','active'),
      (3,'2026-11-02T15:00:00Z','active'), (4,'2026-11-01T00:00:00Z','used');
    INSERT INTO item_campaign_assignments VALUES (1,'p','c'),(2,'p','c'),(3,'p','c'),(4,'p','c');
    INSERT INTO product_monthly_revenue VALUES ('2026-11','p','c',300,2,600,7,NULL);
  `);
  return {sql,prepare(query){return {bind(...args){return {all(){return {results:sql.prepare(query).all(...args)};}};}};}};
}

test("month boundary, zero day, current-day exclusion and valid product revision",async()=>{
  const db=fixture();
  const r=await readMyBestRevenue(db,"2026-11",clock);
  assert.equal(r.through,"2026-11-02");
  assert.deepEqual({...r.days},{"2026-11-01":300,"2026-11-02":0});
  assert.equal(r.products[0].amount,600);
  assert.equal(r.products[0].source_revision,7);
});

test("unpriced, finalized and mismatching products fail closed",async()=>{
  const db=fixture();
  for(const [change,revert] of [
    ["UPDATE ledger_products SET unit_price=NULL","UPDATE ledger_products SET unit_price=300"],
    ["UPDATE product_monthly_revenue SET finalized_at='frozen'","UPDATE product_monthly_revenue SET finalized_at=NULL"],
    ["UPDATE items SET status='used' WHERE id=2","UPDATE items SET status='active' WHERE id=2"]
  ]){
    db.sql.exec(change);
    assert.equal(await readMyBestRevenue(db,"2026-11",clock),null);
    db.sql.exec(revert);
  }
  assert.equal(await readMyBestRevenue(db,"2026-09",clock),null);
});
