import test from "node:test";
import assert from "node:assert/strict";
import { analysisAmount } from "../public/analysis-amount.js";
import { summarizeAnalysisAmounts } from "../src/analysis-amount.js";
import { normalizeAnalysis } from "../src/core.js";
const base = { status: "ok", site: "giftee_box", kind: "box", boxCategory: "eraberu_pay",
  groupName: "えらべるPay", redeemPlace: "giftee Box", size: "none", balanceUnit: "ポイント" };
const result = (balance, extra = {}) => JSON.stringify({ ...base, balance, ...extra });
const display = analyses => analysisAmount({ analysis_amount_summary: summarizeAnalysisAmounts(analyses) });

test("各URLの異なる金額を合計し、えらべるPayの判定条件は変えない", () => {
  assert.equal(display([result(1000), result("500"), result(0)]), "合計 1,500ポイント（3件分）");
  const a = normalizeAnalysis({ ...base, balance: 500 });
  const b = normalizeAnalysis({ ...base, balance: 1000 });
  assert.equal(a.matchKey, b.matchKey);
  assert.equal(a.specification, "");
  assert.equal(analysisAmount({ analysis_json: result(1000), item_count: 3 }), "");
});
test("未取得や不正値を0にせず、取得済み合計と未取得件数を表示する", () => {
  const unknowns = [null, undefined, "", " ", "unknown", -1, true, []].map(value => result(value));
  unknowns.push("broken", result(500, { status: "error" }));
  assert.equal(display([result(500), ...unknowns]), "合計 500ポイント（金額未取得 10件／全11件）");
  assert.equal(display([result(null)]), "合計金額未取得（金額未取得 1件／全1件）");
});
test("単位が異なる金額は別々に合計する", () => {
  assert.equal(display([result(500), result(1000), result(300, { balanceUnit: "円" })]), "合計 1,500ポイント / 300円（3件分）");
});
