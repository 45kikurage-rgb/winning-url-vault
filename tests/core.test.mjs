import test from "node:test";
import assert from "node:assert/strict";
import { classifyValue, extractValues, isGenericName, normalizeAnalysis } from "../src/core.js";

test("汎用名は解析成功として扱わない", () => {
  for (const name of ["セブン-イレブン クーポン", "セブンイレブン クーポン", "ファミリーマート クーポン", "商品名不明"]) {
    assert.equal(isGenericName(name), true, name);
  }
  assert.equal(isGenericName("セブンカフェ カフェラテ 300ml"), false);
});

test("全必須情報がそろった結果だけ有効になる", () => {
  const valid = normalizeAnalysis({ status:"ok", site:"seven", kind:"coupon", product:"セブンカフェ カフェラテ", capacity:"300ml", size:"other", redeemPlace:"セブン-イレブン", expiresOn:"2026-10-31" });
  assert.equal(valid.valid, true);
  const noExpiry = normalizeAnalysis({ status:"ok", site:"seven", kind:"coupon", product:"セブンカフェ カフェラテ", capacity:"300ml", size:"other", redeemPlace:"セブン-イレブン" });
  assert.equal(noExpiry.valid, false);
  assert.match(noExpiry.reason, /使用期限/);
});

test("容量・利用先・商品条件の差は別の照合キーになる", () => {
  const base = { status:"ok", site:"seven", kind:"coupon", product:"対象商品", size:"other", redeemPlace:"セブンイレブン", expiresOn:"2026-10-31" };
  const a = normalizeAnalysis({ ...base, capacity:"350ml" });
  const b = normalizeAnalysis({ ...base, capacity:"500ml" });
  const c = normalizeAnalysis({ ...base, capacity:"350ml", site:"familymart", redeemPlace:"ファミリーマート" });
  assert.notEqual(a.matchKey, b.matchKey);
  assert.notEqual(a.matchKey, c.matchKey);
});

test("表示名は照合キーへ入らない", () => {
  const input = { status:"ok", site:"seven", kind:"coupon", product:"正式商品名 350ml", capacity:"350ml", size:"350", redeemPlace:"セブンイレブン", expiresOn:"2026-10-31" };
  const a = normalizeAnalysis(input);
  const b = normalizeAnalysis({ ...input, display_name:"短縮表示" });
  assert.equal(a.matchKey, b.matchKey);
});

test("Coke ONとPayPayの現行形式を分離判定する", () => {
  const coke = classifyValue("cdAb12Cd34Ef56");
  assert.equal(coke.type, "cokeon");
  assert.equal(coke.storedValue, "https://c.cocacola.co.jp/spn/app/cp/couponcode.html?couponcode=cdAb12Cd34Ef56");
  assert.equal(classifyValue("ABCD-EFGH-IJKL-MNOP").type, "paypay");
  assert.equal(classifyValue("ABCDEFGHIJKLMNOP").type, "paypay");
  assert.equal(classifyValue("https://giftcard.paypay.ne.jp/card/example").type, "paypay");
});

test("受信テキストはURL抽出と入力内重複排除を行う", () => {
  const values = extractValues({ text:"https://example.com/a\nhttps://example.com/a\ncdAb12Cd34Ef56" });
  assert.deepEqual(values, ["https://example.com/a", "cdAb12Cd34Ef56"]);
});
