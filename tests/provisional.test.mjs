import test from "node:test";
import assert from "node:assert/strict";
import { parseProvisionalValues, provisionalPlan } from "../src/provisional.js";

const block = [
  "最短1分で受け取り可能",
  "ギフトコード",
  "ABCD1234EFGH5678",
  "受取期限 2026年12月25日(金)",
  "※特典はCOIN+残高へ加算されます。"
].join("\n");

test("COIN+文面はコードのみ抽出し、受取期限を保全する", () => {
  const parsed = parseProvisionalValues({ text: block }, block.split("\n"));
  assert.deepEqual(parsed, [
    { value: "ABCD1234EFGH5678", source: "coin_plus", expiry: "2026-12-25", redeemPlace: "エアウォレット" }
  ]);
  const plan = provisionalPlan({ text: block }, block.split("\n"));
  assert.equal(plan.length, 1);
  assert.equal(plan[0].canonical, "ABCD1234EFGH5678");
  assert.equal(plan[0].type, "text");
  assert.equal(plan[0].analysis.source, "coin_plus");
});

test("COIN+文面が解析できない場合もPayPayとして確定させない", () => {
  const text = "COIN+残高へ加算されます\nギフトコード\n記載不鮮明";
  const plan = provisionalPlan({ text }, text.split("\n"));
  assert.equal(plan.length, 1);
  assert.equal(plan[0].type, "text");
  assert.equal(plan[0].analysis.parseStatus, "requires_review");
});

test("同じ16文字でも通常の文字コードは暫定中PayPay確定しない", () => {
  const plan = provisionalPlan({ values: ["EFGH5678IJKL9012"] }, ["EFGH5678IJKL9012"]);
  assert.equal(plan[0].type, "text");
  assert.equal(plan[0].canonical, "EFGH5678IJKL9012");
});
