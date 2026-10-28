import { isTikTokLongVideo, TIKTOK_VIDEO_CATEGORY, TIKTOK_VIDEO_NAME } from '../public/tiktok-video.js';
import { VaultLedgerError } from './ledger.js';

const stamp = () => new Date().toISOString();
const fail = (message, code, status = 409) => new VaultLedgerError(message, status, code);
const pages = values => Array.from({length:Math.ceil(values.length / 60)},(_,i)=>values.slice(i*60,(i+1)*60));

export async function classifyTikTokVideos(env, items) {
  const candidates = items.filter(item => isTikTokLongVideo(item.value));
  let changed = 0;
  for (const group of pages(candidates)) {
    const statements = [];
    for (const item of group) {
      const itemId = item.id || item.item_id;
      // Never reinterpret assigned winnings, used/deleted items, or explicit provisional holds.
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO tiktok_video_links(item_id)
        SELECT id FROM items WHERE id=? AND status IN ('received','queued','unresolved','pending_confirmation','active')
        AND NOT EXISTS(SELECT 1 FROM item_campaign_assignments a WHERE a.item_id=items.id)`)
        .bind(itemId));
      statements.push(env.DB.prepare(`UPDATE items SET status='active',card_id=NULL,pending_id=NULL,
        analyzed_at=COALESCE(analyzed_at,?),classified_at=COALESCE(classified_at,?)
        WHERE id=? AND status IN ('received','queued','unresolved','pending_confirmation','active')
        AND EXISTS(SELECT 1 FROM tiktok_video_links v WHERE v.item_id=items.id)`)
        .bind(stamp(),stamp(),itemId));
      statements.push(env.DB.prepare(`DELETE FROM unresolved_items WHERE item_id=?
        AND EXISTS(SELECT 1 FROM tiktok_video_links v WHERE v.item_id=unresolved_items.item_id)`).bind(itemId));
    }
    const results = await env.DB.batch(statements);
    changed += results.filter((_,i)=>i%3===0).reduce((sum,r)=>sum+Number(r.meta?.changes || 0),0);
  }
  return changed;
}

// Bounded, idempotent recovery for old unknown/queued links. Values and original envelopes stay intact.
export async function recoverTikTokVideos(env) {
  const rows = await env.DB.prepare(`SELECT i.id,i.value FROM items i
    WHERE i.value LIKE 'https://lite.tiktok.com/t/%'
    AND i.status IN ('received','queued','unresolved','pending_confirmation','active')
    AND NOT EXISTS(SELECT 1 FROM tiktok_video_links v WHERE v.item_id=i.id)
    AND NOT EXISTS(SELECT 1 FROM item_campaign_assignments a WHERE a.item_id=i.id)
    ORDER BY i.received_at,i.rowid LIMIT 500`).all();
  return classifyTikTokVideos(env,rows.results || []);
}

export async function tikTokVideoSummary(env) {
  const row = await env.DB.prepare(`SELECT COUNT(*) total_count,
    COALESCE(SUM(v.exported_at IS NULL),0) unexported_count,
    COALESCE(SUM(v.exported_at IS NOT NULL),0) exported_count,MIN(i.received_at) assigned_at
    FROM tiktok_video_links v JOIN items i ON i.id=v.item_id WHERE i.status='active'`).first();
  if (!row?.total_count) return null;
  return {...row,product_id:TIKTOK_VIDEO_CATEGORY,category:TIKTOK_VIDEO_CATEGORY,
    product_name:TIKTOK_VIDEO_NAME,display_name:TIKTOK_VIDEO_NAME,output_method:'normal',
    product_spec:'受信URLをまとめてコピー',redemption_place:'TikTok Lite',valid_until:null,
    campaign_status:'active',show_in_permanent:1,unit_price:null,price_required:false,
    raw_unexported_count:row.unexported_count,unmatched_count:0};
}

async function readBatch(env,id) {
  const batch = await env.DB.prepare('SELECT * FROM tiktok_video_batches WHERE id=?').bind(id).first();
  if (!batch) throw fail('一括コピーが見つかりません','TIKTOK_BATCH_NOT_FOUND',404);
  const ids = JSON.parse(batch.item_ids_json);
  const byId = new Map();
  for (const group of pages(ids)) {
    const rows = await env.DB.prepare(`SELECT id,value FROM items WHERE id IN (${group.map(()=>'?').join(',')})`).bind(...group).all();
    for (const item of rows.results || []) byId.set(item.id,item);
  }
  const items = ids.map(id=>byId.get(id));
  if (items.some(item=>!item || !isTikTokLongVideo(item.value)))
    throw fail('コピー対象が変更されています','TIKTOK_BATCH_CHANGED');
  return {...batch,items,count:items.length,product_name:TIKTOK_VIDEO_NAME};
}

export async function pendingTikTokBatch(env) {
  const batch = await env.DB.prepare("SELECT id FROM tiktok_video_batches WHERE status='pending'").first();
  return batch ? readBatch(env,batch.id) : null;
}

export async function startTikTokBatch(env) {
  const pending = await pendingTikTokBatch(env);
  if (pending) return {batch:pending,restored:true};
  const rows = await env.DB.prepare(`SELECT i.id,i.value FROM tiktok_video_links v JOIN items i ON i.id=v.item_id
    WHERE v.exported_at IS NULL AND i.status='active' ORDER BY i.received_at,i.rowid`).all();
  const items = rows.results || [];
  if (!items.length) throw fail('未抽出の動画URLはありません','NO_UNEXPORTED_ITEMS');
  if (!items.every(item=>isTikTokLongVideo(item.value))) throw fail('対象外のURLがあります','TIKTOK_BATCH_CHANGED');
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare('INSERT INTO tiktok_video_batches(id,item_ids_json,created_at) VALUES (?,?,?)')
      .bind(id,JSON.stringify(items.map(item=>item.id)),stamp()).run();
  } catch(error) {
    const concurrent = await pendingTikTokBatch(env);
    if (concurrent) return {batch:concurrent,restored:true};
    throw error;
  }
  return {batch:await readBatch(env,id),restored:false};
}

export async function changeTikTokBatch(env,id,action) {
  const batch = await readBatch(env,id);
  const expected = action === 'undo' ? 'completed' : 'pending';
  if (batch.status !== expected) throw fail('一括コピーの状態が更新されています','TIKTOK_BATCH_STATE');
  const statements = [];
  const tick = stamp();
  if (action === 'complete') {
    for (const group of pages(batch.items.map(item=>item.id))) {
      statements.push(env.DB.prepare(`UPDATE tiktok_video_links SET exported_at=?,export_batch_id=?
        WHERE item_id IN (${group.map(()=>'?').join(',')}) AND exported_at IS NULL
        AND EXISTS(SELECT 1 FROM tiktok_video_batches WHERE id=? AND status='pending')`)
        .bind(tick,id,...group,id));
    }
  } else if (action === 'undo') {
    statements.push(env.DB.prepare(`UPDATE tiktok_video_links SET exported_at=NULL,export_batch_id=NULL
      WHERE export_batch_id=? AND EXISTS(SELECT 1 FROM tiktok_video_batches WHERE id=? AND status='completed')`).bind(id,id));
  }
  const next = action === 'complete' ? 'completed' : 'cancelled';
  statements.push(env.DB.prepare('UPDATE tiktok_video_batches SET status=?,completed_at=? WHERE id=? AND status=?')
    .bind(next,action === 'complete' ? tick : null,id,expected));
  const results = await env.DB.batch(statements);
  if (!results.at(-1)?.meta?.changes) throw fail('一括コピーの状態が更新されています','TIKTOK_BATCH_STATE');
  return {id,status:next,changed_count:results.slice(0,-1).reduce((n,r)=>n+Number(r.meta?.changes || 0),0)};
}

export async function tikTokVideoRoute(request,env,path) {
  if (path === '/api/tiktok-videos/export-batches/pending' && request.method === 'GET')
    return {batch:await pendingTikTokBatch(env)};
  const base = '/api/tiktok-videos/export-batches';
  const match = path.match(/^\/api\/tiktok-videos\/export-batches\/([0-9a-f-]{36})(?:\/(complete|undo))?$/i);
  if (request.method !== 'GET' && request.headers.get('origin') !== new URL(request.url).origin)
    throw fail('管理画面から操作してください','SCOPE_DENIED',403);
  if (path === base && request.method === 'POST') return startTikTokBatch(env);
  if (match && request.method === 'GET' && !match[2]) return {batch:await readBatch(env,match[1])};
  if (match && request.method === 'DELETE' && !match[2]) return changeTikTokBatch(env,match[1],'cancel');
  if (match && request.method === 'POST' && match[2]) return changeTikTokBatch(env,match[1],match[2]);
  throw fail('この操作には対応していません','METHOD_NOT_ALLOWED',405);
}
