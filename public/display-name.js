// Display aliases never change product identity or the analyzer's formal names.
export function nameUnits(value) {
  return [...String(value)].reduce((sum, char) => sum + (/^[\x20-\x7e\uff61-\uff9f]$/.test(char) ? 0.5 : 1), 0);
}
export function validateDisplayName(value) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\t\x00-\x1f\x7f]/.test(value)) return '表示名を1行で入力してください。';
  if (nameUnits(value.trim()) > 14) return '表示名は全角14文字相当以内（半角は0.5文字）にしてください。';
  return '';
}
// Measure the real field after layout, including its actual font and available width.
// No hardcoded viewport, character-width estimate, or ellipsis-as-success.
export function nameFits(element, value) {
  if (!element?.getClientRects().length || element.clientWidth <= 0) return false;
  const style = getComputedStyle(element), probe = document.createElement('span');
  probe.className = 'display-name-measure';
  probe.style.font = style.font;
  probe.style.letterSpacing = style.letterSpacing;
  probe.style.fontKerning = style.fontKerning;
  probe.textContent = value;
  document.body.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  const usable = element.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0);
  return width <= usable + 0.25;
}
