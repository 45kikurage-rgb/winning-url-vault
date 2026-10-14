// Each item contributes once; pending group's representative analysis is not used.
export function summarizeAnalysisAmounts(analyses) {
  const totals = new Map();
  let unknownCount = 0;
  for (const analysis of analyses) {
    let result;
    try { result = JSON.parse(analysis || "null"); } catch { result = null; }
    const value = result?.balance;
    if (result?.status !== "ok" || result?.site !== "giftee_box" || result?.kind !== "box"
      || !["number", "string"].includes(typeof value) || String(value).trim() === ""
      || !Number.isFinite(Number(value)) || Number(value) < 0) {
      unknownCount++;
      continue;
    }
    const unit = String(result.balanceUnit || "ポイント").trim() || "ポイント";
    const group = totals.get(unit) || { unit, total: 0, count: 0 };
    group.total += Number(value);
    group.count++;
    totals.set(unit, group);
  }
  return { totals: [...totals.values()], unknownCount, itemCount: analyses.length };
}
