export function currentWinningMonth(date = new Date()) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

export function winningMonth(item) {
  const value = String(item.lottery_start_date || "");
  return /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(value) ? value.slice(0, 7) : "unknown";
}

export function winningMonthLabel(month) {
  return month === "unknown" ? "開始月未設定" : `${month.slice(0, 4)}年${Number(month.slice(5))}月`;
}

export function groupWinningFolders(items, currentMonth = currentWinningMonth()) {
  const months = new Map();
  for (const item of items) {
    if (item.show_in_permanent === true || item.show_in_permanent === 1) continue;
    const month = winningMonth(item);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(item);
  }
  return [
    { key: "permanent", label: "常設", open: true, items: items.filter(item => item.show_in_permanent === true || item.show_in_permanent === 1) },
    ...[...months.keys()].sort((a, b) => a === "unknown" ? 1 : b === "unknown" ? -1 : b.localeCompare(a))
      .map(month => ({ key: month, label: winningMonthLabel(month), open: month === currentMonth, items: months.get(month) }))
  ];
}
