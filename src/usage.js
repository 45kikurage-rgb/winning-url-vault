// Only an explicit, per-URL analyzer verdict can mark a coupon as used.
export function usageVerdict(result, value) {
  if (!result || result.url !== value) return 'unknown';
  if (result.status === 'used') return 'used';
  if (result.status === 'ok') return 'not_used';
  return 'unknown';
}

const unassigned = `NOT EXISTS (SELECT 1 FROM item_campaign_assignments a WHERE a.item_id=items.id)`;
const eligible = `status IN ('active','pending_confirmation','unresolved') AND ${unassigned}`;

export async function usageOverview(env) {
  const candidates = await env.DB.prepare(`SELECT id,value,value_type FROM items WHERE ${eligible} ORDER BY received_at,id`).all();
  const used = await env.DB.prepare(`SELECT id FROM items WHERE status='used' AND ${unassigned} ORDER BY received_at,id`).all();
  const rows = candidates.results || [];
  const urls = rows.filter(row => row.value_type === 'url' && /^https:\/\//i.test(row.value));
  return { ids: urls.map(row => row.id), unsupported: rows.length - urls.length, usedIds: (used.results || []).map(row => row.id) };
}

export async function markUsed(env, itemId, result) {
  const update = await env.DB.prepare(`UPDATE items SET status='used',card_id=NULL,pending_id=NULL,
    analysis_json=?,analyzed_at=CURRENT_TIMESTAMP WHERE id=?
    AND status IN ('received','queued','active','pending_confirmation','unresolved','used') AND ${unassigned}`)
    .bind(JSON.stringify(result), itemId).run();
  if (Number(update.meta?.changes || 0)) {
    await env.DB.prepare("DELETE FROM unresolved_items WHERE item_id=? AND EXISTS(SELECT 1 FROM items WHERE id=? AND status='used')")
      .bind(itemId,itemId).run();
    return true;
  }
  return false;
}

export async function recheckUsage(env, ids, analyzerRequest) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 5 || ids.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) {
    return { ok:false, error:'確認対象は1〜5件のURLを指定してください' };
  }
  const unique = [...new Set(ids)];
  const rows = await env.DB.prepare(`SELECT id,value FROM items WHERE id IN (${unique.map(()=>'?').join(',')})
    AND value_type='url' AND ${eligible}`).bind(...unique).all();
  const items = rows.results || [];
  let results = [];
  let error = '';
  try { results = await analyzerRequest(env,items.map(row=>row.value),{ includeProductImage:false }); }
  catch (failure) { error = failure.message || '使用状況を取得できませんでした'; }
  const byUrl = new Map(results.filter(row=>row?.url).map(row=>[row.url,row]));
  const counts = { checked:items.length, used:0, notUsed:0, unknown:0, skipped:unique.length-items.length };
  for (const item of items) {
    const result = byUrl.get(item.value);
    const verdict = usageVerdict(result,item.value);
    if (verdict === 'used') {
      if (await markUsed(env,item.id,result)) counts.used++;
      else counts.skipped++;
    } else {
      if (verdict === 'not_used') counts.notUsed++;
      else counts.unknown++;
      // Preserve product matching data while recording this URL's latest check.
      await env.DB.prepare(`UPDATE items SET analysis_json=json_set(COALESCE(analysis_json,'{}'),'$.usageCheck',json(?))
        WHERE id=? AND ${eligible}`).bind(JSON.stringify({ verdict,checkedAt:new Date().toISOString() }),item.id).run();
    }
  }
  return { ok:true,...counts,...(error?{error}: {}) };
}

export async function deleteUsed(env, ids) {
  if (!Array.isArray(ids) || ids.length > 5000 || ids.some(id=>typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) {
    return { ok:false,error:'削除対象が不正です' };
  }
  let deleted = 0;
  const unique = [...new Set(ids)];
  for (let start=0; start<unique.length; start+=80) {
    const chunk=unique.slice(start,start+80);
    const result = await env.DB.prepare(`DELETE FROM items WHERE id IN (${chunk.map(()=>'?').join(',')})
      AND status='used' AND ${unassigned} RETURNING id`).bind(...chunk).all();
    deleted += (result.results || []).length;
  }
  return {ok:true,deleted};
}
