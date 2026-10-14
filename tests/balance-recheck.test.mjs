import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceVerdict } from '../src/balance-recheck.js';
const url = 'https://example.test/box';
const base = { url, status:'ok', site:'giftee_box', kind:'box', boxCategory:'eraberu_pay', balance:100 };
test('残高判定はURL・カテゴリー・数値を厳密に確認する', () => {
  for (const balance of [1, 100, '500', ' 0.5 ']) assert.equal(balanceVerdict({...base,balance},url),'positive');
  for (const balance of [0,'0']) assert.equal(balanceVerdict({...base,balance},url),'zero');
  for (const balance of [null,undefined,'', ' ',true,false,[],{},-1,Infinity,NaN,'100ポイント']) {
    assert.equal(balanceVerdict({...base,balance},url),'unknown');
  }
  for (const override of [{url:url+'/other'},{status:'used'},{status:'error'},{kind:'gift'},{boxCategory:'giftee_box'},{site:'other'}]) {
    assert.equal(balanceVerdict({...base,...override},url),'unknown');
  }
});
