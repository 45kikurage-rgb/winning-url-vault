import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyValue} from '../src/core.js';

test('Coke ON links share a case-sensitive ticket identity with code-only input',()=>{
 const code='cdAb12Cd34Ef56';
 for(const path of ['linegift.html','couponcode.html']){
  const url=`https://c.cocacola.co.jp/spn/app/cp/${path}?source=line&couponcode=${code}#ticket`;
  const item=classifyValue(url);assert.equal(item.type,'cokeon');assert.equal(item.code,code);
  assert.equal(item.canonicalValue,classifyValue(code).canonicalValue);assert.equal(item.storedValue,url);
 }
 assert.notEqual(classifyValue('cdab12Cd34Ef56').canonicalValue,classifyValue(code).canonicalValue);
 for(const url of [
  'https://c.cocacola.co.jp/spn/app/cp/linegift.html',
  'https://c.cocacola.co.jp/spn/app/cp/linegift.html?couponcode=',
  'https://c.cocacola.co.jp/spn/app/cp/linegift.html?couponcode=cdSHORT',
  `https://c.cocacola.co.jp/spn/app/cp/linegift.html?couponcode=${code}&couponcode=${code}`,
  `https://c.cocacola.co.jp.evil.test/spn/app/cp/linegift.html?couponcode=${code}`,
  `https://user@c.cocacola.co.jp/spn/app/cp/linegift.html?couponcode=${code}`,
  `https://c.cocacola.co.jp:444/spn/app/cp/linegift.html?couponcode=${code}`,
  `https://c.cocacola.co.jp/spn/app/cp/other.html?couponcode=${code}`,
 ])assert.notEqual(classifyValue(url).type,'cokeon',url);
});
