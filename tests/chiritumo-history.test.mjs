import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/index.js';
function setup(t){
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>sql.close());
 const DB={prepare(query){const s=sql.prepare(query);let args=[];return {bind(...v){args=v;return this},async first(){return s.get(...args)||null},async all(){return {results:s.all(...args)}},async run(){return {meta:{changes:s.run(...args).changes}}},execute(){return s.run(...args)}}},async batch(statements){sql.exec('BEGIN');try{const r=statements.map(s=>s.execute());sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}};
 const env={DB,SESSION_SECRET:'history-test-secret'};
 async function call(method='GET',body,headers={}){const response=await worker.fetch(new Request('https://vault.test/api/chiritumo/history',{method,headers:{'Content-Type':'application/json',Origin:'https://chiritumo-kikurage1.vercel.app',...headers},...(body?{body:JSON.stringify(body)}:{})}),env,{});return {response,data:await response.json()}}
 function add({source='chiritumo',product='カフェラテ',place='セブンイレブン',capacity='300ml',status='unresolved',card=null}={}){const id=crypto.randomUUID(),value='https://example.test/'+id;sql.prepare('INSERT INTO items(id,value,canonical_value,value_type,status,intake_source,card_id,analysis_json) VALUES (?,?,?,?,?,?,?,?)').run(id,value,value,'url',status,source,card,JSON.stringify({product,redeemPlace:place,capacity,status:'ok',site:'seven'}));return id}
 return {sql,call,add};
}
test('履歴は同一商品・規格・引換先をまとめ、期限と受信元・重複の影響を分離する',async t=>{
 const {sql,call,add}=setup(t);
 add();add();add({place:'ローソン'});add({capacity:'500ml'});add({source:'arunomatic'});add({product:'',place:'',status:'queued'});
 const {response,data}=await call();assert.equal(response.status,200);assert.equal(data.total,5);assert.equal(data.processing,1);assert.equal(data.categories.length,4);
 assert.equal(data.categories.find(c=>c.productName==='カフェラテ'&&c.redeemPlace==='セブンイレブン'&&c.specification==='300ml').count,2);
 const unknown=data.categories.find(c=>c.processing);assert.equal(unknown.identified,false);assert.equal(unknown.productName,'商品名未判定');
 assert(!JSON.stringify(data).includes('https://example.test/'));assert(!JSON.stringify(data).includes('analysis_json'));
 const first=sql.prepare("SELECT id FROM items WHERE intake_source='chiritumo' LIMIT 1").get();
 sql.prepare('UPDATE items SET analysis_json=json_set(analysis_json,\'$.expiresOn\',\'2028-12-31\') WHERE id=?').run(first.id);
 assert.deepEqual((await call()).data.categories.map(c=>c.count),data.categories.map(c=>c.count));
});
test('1回の削除で表示時点の履歴だけを隠し、URL・受信元・新規到着分を保持する',async t=>{
 const {sql,call,add}=setup(t);const first=add(),second=add(),other=add({source:'arunomatic'});
 const category=(await call()).data.categories[0],before=sql.prepare('SELECT * FROM items ORDER BY id').all();
 const later=add();const hidden=await call('POST',{hideToken:category.hideToken});assert.equal(hidden.response.status,200);
 const data=(await call()).data;assert.equal(data.total,1);assert.equal(data.categories[0].count,1);
 for(const row of before)assert.deepEqual(sql.prepare('SELECT * FROM items WHERE id=?').get(row.id),row);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM chiritumo_history_hidden').get().n,2);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM chiritumo_history_hidden WHERE item_id IN (?,?)').get(later,other).n,0);
 await call('POST',{hideToken:category.hideToken});assert.equal((await call()).data.total,1);
 assert.equal(sql.prepare('SELECT intake_source FROM items WHERE id=?').get(first).intake_source,'chiritumo');
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM items').get().n,4);
});
test('改ざんされた削除・別オリジン・送信専用トークンを拒否する',async t=>{
 const {sql,call,add}=setup(t);add();const token=(await call()).data.categories[0].hideToken;
 assert.equal((await call('POST',{hideToken:token+'a'})).response.status,400);
 assert.equal((await call('POST',{hideToken:token},{Origin:'https://evil.test'})).response.status,403);
 assert.equal((await call('GET',null,{Authorization:'Bearer send-only'})).response.status,403);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM chiritumo_history_hidden').get().n,0);
 assert.equal((await call()).data.total,1);
});
