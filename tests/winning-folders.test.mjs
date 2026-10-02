import test from 'node:test';
import assert from 'node:assert/strict';
import {currentWinningMonth, groupWinningFolders} from '../public/winning-folders.js';

test('開始月で分類し、当月と常設だけ開き、年を区別する', () => {
  const items = [
    {product_id:'a',lottery_start_date:'2026-10-02',show_in_permanent:1},
    {product_id:'b',lottery_start_date:'2026-09-01'},
    {product_id:'c',lottery_start_date:'2025-10-01'},
    {product_id:'d',lottery_start_date:'2026-11-01'}
  ];
  const folders = groupWinningFolders(items, '2026-10');
  assert.deepEqual(folders.map(f => [f.key,f.open]), [
    ['permanent',true],['2026-11',false],['2026-10',true],['2026-09',false],['2025-10',false]
  ]);
  assert.equal(folders[2].label,'2026年10月');
  assert.equal(folders[0].items[0],folders[2].items[0]);
  assert.equal(items.length,4);
  assert.equal(groupWinningFolders([], '2026-10')[0].key,'permanent');
});

test('当月は日本時間の月替わりで切り替わる', () => {
  assert.equal(currentWinningMonth(new Date('2026-09-30T14:59:59Z')),'2026-09');
  assert.equal(currentWinningMonth(new Date('2026-09-30T15:00:00Z')),'2026-10');
});
