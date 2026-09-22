const GENERIC_NAMES = [
  /^商品名不明$/i,
  /^クーポン$/i,
  /^(?:セブン(?:-?イレブン)?|seven[ -]?eleven)\s*(?:クーポン|coupon)?$/i,
  /^(?:ファミリーマート|ファミマ|familymart)\s*(?:クーポン|coupon)?$/i,
  /^(?:ミスタードーナツ|ミスド)\s*(?:クーポン|ギフト|e?gift)?$/i,
  /^(?:スターバックス|starbucks)\s*(?:クーポン|ギフト|e?gift)?$/i,
];

export function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[‐‑‒–—―ー-]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ja-JP");
}

export function normalizeName(value) {
  return normalizeText(value)
    .replace(/[「」『』【】]/g, "")
    .replace(/\s*([・･/／])\s*/g, "$1");
}

export function normalizeSpecification(value) {
  return normalizeText(value)
    .replace(/\s*(ml|g|kg|l|本|個|枚)\b/gi, "$1")
    .replace(/ｍｌ/gi, "ml");
}

export function normalizeRedeemPlace(value) {
  const normalized = normalizeText(value).replace(/[・･\s-]/g, "");
  if (/^(?:セブンイレブン|7eleven)$/.test(normalized)) return "セブンイレブン";
  if (/^(?:ファミリーマート|ファミマ|familymart)$/.test(normalized)) return "ファミリーマート";
  if (/^(?:ミスタードーナツ|ミスド)$/.test(normalized)) return "ミスタードーナツ";
  if (/^(?:スターバックス|starbucks)$/.test(normalized)) return "スターバックス";
  return normalized;
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function isGenericName(value) {
  const candidate = String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  return !candidate || GENERIC_NAMES.some(pattern => pattern.test(candidate));
}

export function codeCard(type) {
  if (type === "cokeon") return {
    sourceType: "cokeon", rawName: "Coke ON ドリンクチケット", normalizedName: "coke on ドリンクチケット",
    displayName: "Coke ON", redeemPlace: "Coke ON", specification: "cd+英数字12文字",
    conditions: { codeFormat: "cd+alnum12", kind: "code" }
  };
  if (type === "paypay") return {
    sourceType: "paypay", rawName: "PayPayギフトカード", normalizedName: "paypayギフトカード",
    displayName: "PayPay", redeemPlace: "PayPay", specification: "16文字英数字",
    conditions: { codeFormat: "alnum16", kind: "code" }
  };
  return null;
}

function normalizePayPayCode(value) {
  return value.replace(/-/g, "").toUpperCase();
}

export function classifyValue(raw, cokeOnBaseUrl = "https://c.cocacola.co.jp/spn/app/cp/couponcode.html?couponcode=") {
  const text = String(raw || "").normalize("NFKC").trim();
  if (!text) return null;
  if (/^cd[A-Za-z0-9]{12}$/.test(text)) {
    const code = text.slice(0, 2).toLowerCase() + text.slice(2);
    return { type: "cokeon", canonicalValue: code, storedValue: `${cokeOnBaseUrl}${encodeURIComponent(code)}`, code };
  }
  if (/^[A-Za-z0-9]{16}$/.test(text) || /^[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{4}){3}$/.test(text)) {
    const code = normalizePayPayCode(text);
    return { type: "paypay", canonicalValue: code, storedValue: text, code: text };
  }
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") return { type: "unknown", canonicalValue: text, storedValue: text, reason: "HTTPS以外のURL" };
    url.hash = "";
    if (url.hostname === "giftcard.paypay.ne.jp") {
      return { type: "paypay", canonicalValue: url.href, storedValue: url.href, code: "" };
    }
    return { type: "url", canonicalValue: url.href, storedValue: url.href, hostname: url.hostname };
  } catch {
    return { type: "unknown", canonicalValue: text, storedValue: text, reason: "未対応の入力形式" };
  }
}

export function extractValues(body) {
  const values = Array.isArray(body?.values) ? body.values : [];
  const text = typeof body?.text === "string" ? body.text : "";
  const tokens = [...values];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const urls = trimmed.match(/https:\/\/[^\s<>"']+/gi);
    if (urls?.length) tokens.push(...urls.map(value => value.replace(/[.,;、。\])}]+$/, "")));
    else tokens.push(trimmed);
  }
  return [...new Set(tokens.map(value => String(value).trim()).filter(Boolean))].slice(0, 100);
}

export function normalizeAnalysis(result) {
  const rawName = String(result?.product || result?.boxName || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  const expiresOn = String(result?.expiresOn || "").trim();
  const redeemPlace = normalizeRedeemPlace(result?.redeemPlace || result?.merchant || result?.brand || "");
  const specification = normalizeSpecification(result?.capacity || (result?.size && !["none", "unknown", "mixed"].includes(result.size) ? result.size : ""));
  const normalizedName = normalizeName(rawName);
  const conditions = {
    brand: normalizeText(result?.brand || ""),
    kind: normalizeText(result?.kind || "coupon"),
    site: normalizeText(result?.site || ""),
    size: normalizeText(result?.size || "none")
  };
  const reasons = [];
  if (result?.status !== "ok") reasons.push(result?.status === "used" ? "使用済みクーポンの商品を特定できません" : result?.message || "解析結果が未確定です");
  if (isGenericName(rawName)) reasons.push("正式商品名ではなく汎用名しか取得できませんでした");
  if (!redeemPlace) reasons.push("利用先がありません");
  if (!expiresOn || !/^20\d{2}-\d{2}-\d{2}$/.test(expiresOn)) reasons.push("使用期限がありません");
  if (["unknown", "mixed"].includes(result?.size)) reasons.push("容量・規格が確定していません");
  if (!conditions.site) reasons.push("解析元サイトがありません");
  const requiredConditions = stableJson(conditions);
  const matchKey = [normalizedName, specification, redeemPlace, requiredConditions].join("\u001f");
  return {
    valid: reasons.length === 0,
    reason: [...new Set(reasons)].join(" / "),
    rawName, normalizedName, displayName: rawName.slice(0, 32), redeemPlace,
    specification, expiresOn, requiredConditions, matchKey,
    imageDataUri: /^data:image\/(?:png|jpeg|webp);base64,/i.test(result?.productImageDataUri || "")
      && result.productImageDataUri.length <= 1_500_000 ? result.productImageDataUri : null
  };
}
