import { winningMonth } from './winning-folders.js';

export const DEFAULT_VIEW = Object.freeze({ query:'', status:'all', place:'', month:'', permanent:false, sort:'recommended', grouping:'flat', showCampaign:false, relativeDates:false });
export function normalizeView(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return { ...DEFAULT_VIEW,
    query:typeof source.query === 'string' ? source.query : '',
    status:['all','remaining','attention','zero','due'].includes(source.status) ? source.status : 'all',
    place:typeof source.place === 'string' ? source.place : '',
    month:typeof source.month === 'string' ? source.month : '',
    permanent:source.permanent === true,
    sort:['recommended','name','expiry','remaining'].includes(source.sort) ? source.sort : 'recommended',
    grouping:source.grouping === 'month' ? 'month' : 'flat',
    showCampaign:source.showCampaign === true, relativeDates:source.relativeDates === true };
}
export function attentionReasons(item) {
  const reasons = [];
  if (!item.output_method || item.output_method === 'unset') reasons.push('方式未設定');
  if (Number(item.unmatched_count) > 0) reasons.push(`対象外 ${Number(item.unmatched_count).toLocaleString()}件`);
  if (item.unit_price == null) reasons.push('単価未設定');
  if (item.campaign_status === 'closing') reasons.push('終了確認待ち');
  else if (item.campaign_status === 'correcting') reasons.push('訂正中');
  else if (!['active','closed'].includes(item.campaign_status)) reasons.push('状態未取得');
  return reasons;
}
export function campaignDate(item) {
  const value = String(item.lottery_start_date || '').slice(0,10);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '0000-00-00';
}
export function orderWinningItems(items, previousIds = [], sort = 'recommended', reset = false) {
  const previous = new Map(previousIds.map((id, index) => [id,index]));
  const name = item => String(item.display_name || item.product_name || '');
  const compare = (a,b) => {
    if (sort === 'recommended') return Number(b.unexported_count || 0) - Number(a.unexported_count || 0)
      || campaignDate(b).localeCompare(campaignDate(a));
    if (sort === 'remaining') return Number(b.unexported_count || 0) - Number(a.unexported_count || 0);
    if (sort === 'expiry') return (expiryDate(a) || '9999').localeCompare(expiryDate(b) || '9999');
    return 0;
  };
  return [...items].sort((a,b) => {
    if (!reset && previous.size) {
      const ai = previous.get(a.product_id), bi = previous.get(b.product_id);
      if (ai !== undefined || bi !== undefined) return (ai ?? Infinity) - (bi ?? Infinity);
    }
    return compare(a,b) || name(a).localeCompare(name(b),'ja') || String(a.product_id).localeCompare(String(b.product_id));
  });
}
export function expiryDate(item) {
  const value = String(item.valid_until || '').slice(0,10);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : '';
}
export function expiryDays(item, now = new Date()) {
  const date = expiryDate(item);
  if (!date) return null;
  const today = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0,10);
  return Math.round((Date.parse(date) - Date.parse(today)) / 86400000);
}
export function expiryLabel(item, relative = false, now = new Date()) {
  const date = expiryDate(item);
  if (!date) return '期限未取得';
  if (!relative) return `期限 ${date}`;
  const days = expiryDays(item,now);
  return `期限 ${date}（${days < 0 ? '期限経過' : days === 0 ? '本日' : `あと${days}日`}）`;
}
export function matchesWinningItem(item, view, now = new Date()) {
  const words = view.query.normalize('NFKC').toLocaleLowerCase('ja').trim().split(/\s+/).filter(Boolean);
  const haystack = [item.display_name,item.product_name,item.product_spec,item.redemption_place,item.campaign_name,item.campaign_id,item.lottery_start_date].join(' ').normalize('NFKC').toLocaleLowerCase('ja');
  if (!words.every(word => haystack.includes(word))) return false;
  if (view.place && item.redemption_place !== view.place) return false;
  if (view.month && winningMonth(item) !== view.month) return false;
  if (view.permanent && !item.show_in_permanent) return false;
  if (view.status === 'remaining' && !(Number(item.unexported_count) > 0)) return false;
  if (view.status === 'attention' && !attentionReasons(item).length) return false;
  if (view.status === 'zero' && Number(item.unexported_count || 0) !== 0) return false;
  if (view.status === 'due') { const days = expiryDays(item,now); if (days === null || days > 7) return false; }
  return true;
}
export function isFinished(item) { return item.campaign_status === 'closed' || item.manual_finished === true || item.manual_finished === 1; }
export function selectWinningItems(items, view, now = new Date()) {
  const closed = items.filter(isFinished);
  const filtered = items.filter(item => matchesWinningItem(item,view,now));
  return { active:filtered.filter(item => !isFinished(item)), closed:filtered.filter(isFinished),
    closedRemaining:closed.reduce((sum,item) => sum + Number(item.unexported_count || 0),0),
    filteredClosedRemaining:filtered.filter(isFinished).reduce((sum,item) => sum + Number(item.unexported_count || 0),0),
    closedRawRemaining:closed.reduce((sum,item)=>sum+Number(item.raw_unexported_count ?? item.unexported_count ?? 0),0),
    closedCount:closed.length, total:items.length, filteredCount:filtered.length };
}
