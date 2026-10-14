// Display-only: totals never become product matching conditions.
export function analysisAmount(item) {
  const summary = item?.analysis_amount_summary;
  if (!summary) return "";
  const amounts = summary.totals.map(({ total, unit }) =>
    `${total.toLocaleString("ja-JP", { maximumFractionDigits: 10 })}${unit}`);
  const total = amounts.length ? `合計 ${amounts.join(" / ")}` : "合計金額未取得";
  return summary.unknownCount > 0
    ? `${total}（金額未取得 ${summary.unknownCount}件／全${summary.itemCount}件）`
    : `${total}（${summary.itemCount}件分）`;
}

export function isEraberuPay(item) {
  let conditions;
  try { conditions = JSON.parse(item?.required_conditions || "null"); } catch { return false; }
  return conditions?.site === "giftee_box" && conditions?.kind === "box"
    && conditions?.boxCategory === "eraberu_pay";
}
