import { validateDisplayName } from '../public/display-name.js';
import { VaultLedgerError } from './ledger.js';

export async function listDisplayNames(env) {
  const rows = await env.DB.prepare('SELECT scope,target_id,display_name FROM ui_display_names').all();
  return rows.results || [];
}
export async function saveDisplayName(env, scope, targetId, value) {
  const error = validateDisplayName(value);
  if (error) throw new VaultLedgerError(error, 400, 'INVALID_DISPLAY_NAME');
  const query = scope === 'sorting' ? 'SELECT id FROM cards WHERE id=?' :
    scope === 'winning' ? 'SELECT product_id FROM ledger_products WHERE product_id=? AND is_archived=0' : null;
  if (!query) throw new VaultLedgerError('表示箇所が不正です', 400, 'INVALID_NAME_SCOPE');
  if (!await env.DB.prepare(query).bind(targetId).first()) throw new VaultLedgerError('商品が見つかりません', 404, 'PRODUCT_NOT_FOUND');
  const displayName = value.trim();
  await env.DB.prepare(`INSERT INTO ui_display_names(scope,target_id,display_name,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(scope,target_id) DO UPDATE SET display_name=excluded.display_name,updated_at=excluded.updated_at`)
    .bind(scope,targetId,displayName,new Date().toISOString()).run();
  return { scope, target_id:targetId, display_name:displayName };
}
