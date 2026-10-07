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
    return { answer: '```json\n{"product_name":"【大塚製薬】 ファイブミニ 1本無料","display_name":"ファイブミニ 1本無料","redeem_place":"ローソン","specification":"税込130円・1本無料","expires_on":"2026-10-19"}\n```' };
  } } };
  const result = await analyzeCouponImage(env, IMAGE);
  assert.equal(calls[0].model, "@cf/moondream/moondream3.1-9B-A2B");
  assert.equal(calls[0].input.image, IMAGE);
  assert.equal(result.productName, "【大塚製薬】 ファイブミニ 1本無料");
  assert.equal(result.expiresOn, "2026-10-19");
  assert.equal(result.redeemPlace, "ローソン");
});

test("画像判定項目は長さを制限し、存在しない項目を空欄にする", () => {
  const result = normalizeImageProposal({ product_name: " 商品名 ", display_name: "", expires_on: "" });
  assert.deepEqual(result, {
    productName: "商品名", displayName: "商品名", redeemPlace: "", specification: "", expiresOn: ""
  });
});
