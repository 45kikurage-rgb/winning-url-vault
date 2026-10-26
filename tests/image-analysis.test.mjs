import test from "node:test";
import assert from "node:assert/strict";
import { analyzeCouponImage, normalizeImageProposal, validateCouponImage } from "../src/image-analysis.js";

const IMAGE = "data:image/png;base64,aW1hZ2U=";

test("画像判定は対応画像だけを受け付け、AIのJSONを確認画面用に整える", async () => {
  assert.equal(validateCouponImage(IMAGE), IMAGE);
  assert.throws(() => validateCouponImage("data:text/plain;base64,YQ=="), /PNG・JPEG・WebP/);
  const calls = [];
  const env = { AI: { run: async (model, input) => {
    calls.push({ model, input });
    return { choices: [{ message: { content: '```json\n{"product_name":"【大塚製薬】 ファイブミニ 1本無料","display_name":"ファイブミニ 1本無料","redeem_place":"ローソン","specification":"税込130円・1本無料","expires_on":"2026-10-19"}\n```' } }] };
  } } };
  const result = await analyzeCouponImage(env, IMAGE);
  assert.equal(calls[0].model, "@cf/google/gemma-4-26b-a4b-it");
  assert.equal(calls[0].input.messages[0].content[1].image_url.url, IMAGE);
  assert.equal(result.productName, "【大塚製薬】 ファイブミニ 1本無料");
  assert.equal(result.expiresOn, "2026-10-19");
  assert.equal(result.redeemPlace, "ローソン");
});

test("画像モデル応答がresultで包まれていても解析できる", async () => {
  const env = { AI: { run: async () => ({
    result: { response: '{"product_name":"商品","display_name":"商品","redeem_place":"店舗","specification":"無料","expires_on":"2026-12-31"}' }
  }) } };
  assert.equal((await analyzeCouponImage(env, IMAGE)).productName, "商品");
});

test("画像判定項目は長さを制限し、存在しない項目を空欄にする", () => {
  const result = normalizeImageProposal({ product_name: " 商品名 ", display_name: "", expires_on: "" });
  assert.deepEqual(result, {
    productName: "商品名", displayName: "商品名", redeemPlace: "", specification: "", expiresOn: ""
  });
});

test("ローソン画像の350ml缶は1本無料より優先して容量に入れる", () => {
  const result = normalizeImageProposal({
    product_name: "【サントリー】角ハイボール〈タコどき〉350ml缶（税込251円）1本無料クーポン",
    display_name: "角ハイボール",
    redeem_place: "ローソン",
    specification: "1本無料",
    expires_on: "2026-11-09"
  });
  assert.equal(result.specification, "350ml");
  assert.equal(result.expiresOn, "2026-11-09");
});

test("ローソン商品名が省略されても画像のタイトル・容量欄から補う", () => {
  assert.equal(normalizeImageProposal({
    product_name: "角ハイボール",
    coupon_title: "【サントリー】角ハイボール〈タコどき〉350ml缶 1本無料クーポン",
    redeem_place: "LAWSON",
    specification: "税込251円・1本無料"
  }).specification, "350ml");
  assert.equal(normalizeImageProposal({
    product_name: "角ハイボール 350ml缶",
    redeem_place: "ローソン",
    specification: "500ml"
  }).specification, "350ml");
});

test("画像に容量がなければ無料数量から推測せず、他店の既存判定は変えない", () => {
  assert.equal(normalizeImageProposal({
    product_name: "容量不明の商品",
    redeem_place: "ローソン",
    specification: "1本無料"
  }).specification, "");
  assert.equal(normalizeImageProposal({
    product_name: "ファイブミニ",
    redeem_place: "ファミリーマート",
    specification: "1本無料"
  }).specification, "1本無料");
  assert.equal(normalizeImageProposal({
    product_name: "お茶 600ml",
    redeem_place: "ローソン",
    specification: "600ml"
  }).specification, "600ml");
});

test("画像AIへ容量と無料条件を分けて読むよう指示する", async () => {
  let question = "";
  const env = { AI: { run: async (_model, input) => {
    question = input.messages[0].content[0].text;
    return { choices: [{ message: { content: JSON.stringify({
      product_name: "角ハイボール", coupon_title: "角ハイボール 350ml缶 1本無料",
      redeem_place: "ローソン", specification: "1本無料", volume: "350ml"
    }) } }] };
  } } };
  assert.equal((await analyzeCouponImage(env, IMAGE)).specification, "350ml");
  assert.match(question, /1本無料.*容量ではありません/);
  assert.match(question, /volume/);
});
