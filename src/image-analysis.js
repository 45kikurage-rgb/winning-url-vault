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

function answerText(response) {
  let value = response;
  for (let depth = 0; depth < 3 && value && typeof value === "object"; depth += 1) {
    const choice = value.choices?.[0]?.message?.content;
    if (typeof choice === "string") return choice;
    if (typeof value.answer === "string") return value.answer;
    if (typeof value.response === "string") return value.response;
    value = value.result;
  }
  return value;
}

// The screenshot can say both "350ml缶" and "1本無料". Only the former is capacity.
// Read the explicitly printed volume; never infer it from the benefit or price.
function printedVolume(value) {
  const matches = [...String(value || "").normalize("NFKC").matchAll(/(?:^|[^\d])(\d+(?:\.\d+)?)\s*(ml|mℓ|l|ℓ)(?=$|[^a-z])/gi)]
    .map(match => `${match[1]}${/^(?:l|ℓ)$/i.test(match[2]) ? "L" : "ml"}`);
  return new Set(matches).size === 1 ? matches[0] : "";
}

function proposalVolume(source, productName, displayName, specification) {
  // Prefer the literal product title over a model-generated specification.
  for (const candidate of [productName, source.coupon_title, source.couponTitle, displayName, source.volume, specification]) {
    const volume = printedVolume(candidate);
    if (volume) return volume;
  }
  return "";
}

export function normalizeImageProposal(value) {
  const source = value && typeof value === "object" ? value : {};
  const productName = clean(source.product_name || source.productName, 160);
  const displayName = clean(source.display_name || source.displayName || productName, 64);
  const redeemPlace = clean(source.redeem_place || source.redeemPlace, 64);
  let specification = clean(source.specification, 80);
  if (/^(?:ローソン|lawson)$/i.test(redeemPlace)) {
    const volume = proposalVolume(source, productName, displayName, specification);
    if (volume && (printedVolume(specification) !== volume || /無料|値引|クーポン|税込/.test(specification))) {
      specification = volume;
    } else if (!volume && /^(?:(?:税込)?\d+円[・、\s/]*)?\d+本無料(?:クーポン)?$/.test(specification)) {
      // A free-item count is not a size. Leave it blank for human verification.
      specification = "";
    }
  }
  const expiresOn = clean(source.expires_on || source.expiresOn, 10);
  return { productName, displayName, redeemPlace, specification, expiresOn };
}

export async function analyzeCouponImage(env, imageDataUri) {
  if (!env?.AI?.run) throw new Error("画像判定サービスが未設定です");
  const image = validateCouponImage(imageDataUri);
  const question = [
    "日本のクーポン画面のスクリーンショットから、表示されている1件の商品情報を読み取ってください。",
    "JSONだけを返してください。説明文やMarkdownは不要です。",
    "形式: {\"product_name\":\"容量表記を含む正式な商品名\",\"display_name\":\"短い表示名\",\"redeem_place\":\"利用できる店舗・サービス\",\"specification\":\"容量・規格（例: 350ml）\",\"volume\":\"容量だけ（例: 350ml）\",\"coupon_title\":\"画像中の商品タイトルを正確に転記\",\"expires_on\":\"YYYY-MM-DD\"}",
    "容量は商品名の350ml缶・500mlなどの表記から必ず探してください。『350ml缶 1本無料クーポン』ならspecificationとvolumeは『350ml』です。",
    "『1本無料』『1個無料』『税込251円』は数量・特典・価格であり容量ではありません。容量の数字が読めない場合はvolumeを空文字にし、推測で作らないでください。",
    "商品名にはバーコード番号、URL、注意書き、利用期限を含めないでください。",
    "利用期限はクーポンのご利用期限・有効期限・引換期限を使い、画像にない項目は空文字にしてください。",
    "曜日が書かれていても日付はYYYY-MM-DDだけにしてください。推測で補完しないでください。"
  ].join("\n");
  const response = await env.AI.run("@cf/google/gemma-4-26b-a4b-it", {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: question },
        { type: "image_url", image_url: { url: image } }
      ]
    }],
    temperature: 0,
    max_tokens: 500,
    stream: false,
    chat_template_kwargs: { enable_thinking: false }
  });
  return normalizeImageProposal(parseJsonAnswer(answerText(response)));
}
