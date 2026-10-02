import test from 'node:test';
import assert from 'node:assert/strict';
import {currentWinningMonth, groupWinningFolders} from '../public/winning-folders.js';

test('開始月を保持して分類し、常設のカードは年月フォルダに重複表示しない', () => {
  const items = [
    {product_id:'a',lottery_start_date:'2026-10-02',show_in_permanent:1},
    {product_id:'b',lottery_start_date:'2026-09-01'},
    {product_id:'c',lottery_start_date:'2025-10-01'},
    {product_id:'d',lottery_start_date:'2026-11-01'}
  ];
  const folders = groupWinningFolders(items, '2026-10');
  assert.deepEqual(folders.map(f => [f.key,f.open]), [
    ['permanent',true],['2026-11',false],['2026-09',false],['2025-10',false]
  ]);
  assert.equal(folders[0].items[0],items[0]);
  assert.equal(folders.flatMap(folder => folder.items).filter(item => item.product_id === 'a').length,1);
  assert.equal(items[0].lottery_start_date,'2026-10-02');
  assert.equal(items.length,4);
  assert.equal(groupWinningFolders([], '2026-10')[0].key,'permanent');
});

test('常設を解除すると保持していた開始月フォルダへ戻る', () => {
  const item = {product_id:'a',lottery_start_date:'2026-10-02',show_in_permanent:0};
  const folders = groupWinningFolders([item], '2026-10');
  assert.equal(folders.find(folder => folder.key === '2026-10').items[0],item);
});

test('当月は日本時間の月替わりで切り替わる', () => {
  assert.equal(currentWinningMonth(new Date('2026-09-30T14:59:59Z')),'2026-09');
  assert.equal(currentWinningMonth(new Date('2026-09-30T15:00:00Z')),'2026-10');
});
