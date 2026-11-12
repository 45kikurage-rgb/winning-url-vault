import { classifyValue } from './core.js';

export async function legacyCokeOnDuplicates(env, values) {
  const wanted = new Set(values.map(value => classifyValue(value)).filter(value => value?.type === 'cokeon').map(value => value.code));
  const found = new Map();
  if (!wanted.size) return found;
  const rows = await env.DB.prepare(`SELECT id,value FROM items WHERE value_type='cokeon'
    OR instr(lower(value),'https://c.cocacola.co.jp/spn/app/cp/linegift.html?')=1
    OR instr(lower(value),'https://c.cocacola.co.jp/spn/app/cp/couponcode.html?')=1`).all();
  for (const row of rows.results || []) {
    const classified = classifyValue(row.value);
    if (classified?.type === 'cokeon' && wanted.has(classified.code) && !found.has(classified.code)) found.set(classified.code,row.id);
  }
  return found;
}
