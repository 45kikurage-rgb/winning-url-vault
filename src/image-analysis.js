const IMAGE_DATA = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/i;
const MAX_IMAGE_DATA_URI_LENGTH = 3_000_000;

export function validateCouponImage(value) {
  const image = String(value || "");
  const match = image.match(IMAGE_DATA);
  if (!match) throw new Error("PNG・JPEG・WebPの画像を選択してください");
  if (image.length > MAX_IMAGE_DATA_URI_LENGTH) throw new Error("画像が大きすぎます。別の画像を選択してください");
  return image;
}

function clean(value, max) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max);
}

function parseJsonAnswer(answer) {
  const source = String(answer || "").trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  for (const candidate of [fenced, source, source.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch {}
  }
  throw new Error("画像から判定項目を読み取れませんでした。別の画像を選択するか手入力してください");
}

export function normalizeImageProposal(value) {
  const source = value && typeof value === "object" ? value : {};
  const productName = clean(source.product_name || source.productName, 160);
  const displayName = clean(source.display_name || source.displayName || productName, 64);
  const redeemPlace = clean(source.redeem_place || source.redeemPlace, 64);
  const specification = clean(source.specification, 80);
  const expiresOn = clean(source.expires_on || source.expiresOn, 10);
  return { productName, displayName, redeemPlace, specification, expiresOn };
}

export async function analyzeCouponImage(env, imageDataUri) {
  if (!env?.AI?.run) throw new Error("画像判定サービスが未設定です");
  const image = validateCouponImage(imageDataUri);
  const question = [
    "日本のクーポン画面のスクリーンショットから、表示されている1件の商品情報を読み取ってください。",
    "JSONだけを返してください。説明文やMarkdownは不要です。",
    "形式: {\"product_name\":\"正式な商品名\",\"display_name\":\"短い表示名\",\"redeem_place\":\"利用できる店舗・サービス\",\"specification\":\"容量・本数・無料または値引き条件\",\"expires_on\":\"YYYY-MM-DD\"}",
    "商品名にはバーコード番号、URL、注意書き、利用期限を含めないでください。",
    "利用期限はクーポンのご利用期限・有効期限・引換期限を使い、画像にない項目は空文字にしてください。",
    "曜日が書かれていても日付はYYYY-MM-DDだけにしてください。推測で補完しないでください。"
  ].join("\n");
  const response = await env.AI.run("@cf/moondream/moondream3.1-9B-A2B", {
    task: "query", image, question, reasoning: false, temperature: 0, max_tokens: 500, stream: false
  });
  return normalizeImageProposal(parseJsonAnswer(response?.answer || response?.response || response));
}
