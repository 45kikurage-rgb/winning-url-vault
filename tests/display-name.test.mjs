import test from 'node:test';
import assert from 'node:assert/strict';
import { nameUnits, validateDisplayName, nameFits } from '../public/display-name.js';
import { setUnitPrice } from '../src/ledger.js';

test('14 full-width equivalents, ASCII/half-width, and invalid names',()=>{
  assert.equal(nameUnits('茶'.repeat(14)),14);
  assert.equal(validateDisplayName('茶'.repeat(14)),'');
  assert.ok(validateDisplayName('茶'.repeat(15)));
  assert.equal(validateDisplayName('W'.repeat(28)),'');
  assert.ok(validateDisplayName('W'.repeat(29)));
  for(const name of ['', '   ', '商品\n名', '商品\t名',null,[],14]) assert.ok(validateDisplayName(name));
});

test('width validation uses the real field including padding, and fails closed when hidden',()=>{
  const oldDocument=globalThis.document,oldStyle=globalThis.getComputedStyle;
  let measured=320;
  globalThis.document={createElement:()=>({style:{},getBoundingClientRect:()=>({width:measured}),remove(){}}),body:{append(){}}};
  globalThis.getComputedStyle=()=>({font:'700 16px sans-serif',paddingLeft:'2',paddingRight:'2',letterSpacing:'normal'});
  try{
    const field=width=>({clientWidth:width,getClientRects:()=>[{}]});
    assert.equal(nameFits(field(314),'wide'),false);
    assert.equal(nameFits(field(340),'wide'),true);
    measured=290;
    assert.equal(nameFits(field(292),'wide'),false);
    assert.equal(nameFits(field(330),'wide'),true);
    assert.equal(nameFits({clientWidth:340,getClientRects:()=>[]},'x'),false);
  }finally{globalThis.document=oldDocument;globalThis.getComputedStyle=oldStyle;}
});

test('unit-price rejects coercible nonnumbers before any DB call',async()=>{
  let writes=0;
  const env={DB:{prepare(){writes++;throw Error('DB must not be called');}}};
  for(const value of [undefined,null,'',' ',false,true,[],{},'0','80','80.0','1e3','0x10',-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
    await assert.rejects(setUnitPrice(env,'test',value),e=>e.code==='INVALID_UNIT_PRICE');
  assert.equal(writes,0);
});
