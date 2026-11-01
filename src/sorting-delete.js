// Keep URL identity for duplicate detection; only unassigned, active items leave sorting.
const eligible = `status='active' AND card_id=? AND intake_source=?
  AND NOT EXISTS(SELECT 1 FROM item_campaign_assignments a WHERE a.item_id=items.id)
  AND NOT EXISTS(SELECT 1 FROM tiktok_video_links v WHERE v.item_id=items.id)`;

export async function sortingDeletePreview(env, cardId, source) {
  const rows = await env.DB.prepare(`SELECT id FROM items WHERE ${eligible} ORDER BY received_at,id LIMIT 5001`)
    .bind(cardId, source).all();
  const ids = (rows.results || []).map(row => row.id);
  if (ids.length > 5000) return {ok:false,error:'一度に削除できるのは5,000件までです'};
  return {ok:true,ids,count:ids.length};
}

export async function deleteSortingItems(env, cardId, source, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 5000 ||
      ids.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)))
    return {ok:false,error:'削除対象が不正です'};
  const unique = [...new Set(ids)], statements = [], tick = new Date().toISOString();
  for (let start = 0; start < unique.length; start += 80) {
    const chunk = unique.slice(start, start + 80);
    const where = `${eligible} AND id IN (${chunk.map(() => '?').join(',')})`;
    statements.push(env.DB.prepare(`INSERT INTO audit_log(id,item_id,action,detail)
      SELECT lower(hex(randomblob(16))),id,'sorting_deleted',? FROM items WHERE ${where}`)
      .bind(JSON.stringify({cardId,source,deletedAt:tick}),cardId,source,...chunk));
    statements.push(env.DB.prepare(`UPDATE items SET status='sorting_deleted',classified_at=? WHERE ${where}`)
      .bind(tick,cardId,source,...chunk));
  }
  // D1 batch is transactional; eligibility is checked again during the write.
  const results = await env.DB.batch(statements);
  const deleted = results.reduce((sum, result, index) => sum + (index % 2 ? Number(result.meta?.changes || 0) : 0), 0);
  return {ok:true,deleted,skipped:unique.length-deleted};
}
