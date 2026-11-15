import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=name=>readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
function values(fields){
 const source=read('share.js'),code=source.slice(source.indexOf('function cleanValue'),source.indexOf('function showState'));
 const context={URLSearchParams,location:{hash:'#'+new URLSearchParams(fields)}};
 vm.createContext(context);vm.runInContext(code,context);
 return JSON.parse(JSON.stringify(vm.runInContext('sharedText().values',context)));
}
test('説明textがあっても別フィールドのURLを保持する',()=>{
 assert.deepEqual(values({text:'当選クーポンです',url:'https://example.test/coupon',title:'ギフト'}),['https://example.test/coupon']);
});
test('text/url/titleの全URLを重複なく保持しコードのみの従来共有も保持する',()=>{
 assert.deepEqual(values({text:'https://a.test/1\nhttps://b.test/2',url:'https://a.test/1',title:'https://c.test/3'}),['https://a.test/1','https://b.test/2','https://c.test/3']);
 assert.deepEqual(values({text:'ABCD1234\nEFGH5678',title:'ギフト'}),['ABCD1234','EFGH5678']);
 assert.deepEqual(values({title:'CODE1234'}),['CODE1234']);
});
test('初回オフライン共有のmoduleとstylesheetはHTMLと同じURLで事前保存される',async()=>{
 const source=read('sw.js'),assets=JSON.parse(source.match(/const ASSETS = (\[[\s\S]*?\]);/)[1]),html=read('share.html');
 const script=html.match(/src="(\/share.js[^\"]*)"/)[1],css=html.match(/href="(\/styles.css[^\"]*)"/)[1];
 assert.ok(assets.includes(script));assert.ok(assets.includes(css));
 const cached=new Map(assets.map(path=>['https://vault.test'+path,new Response(path)]));let handler,result;
 const context={URL,URLSearchParams,crypto,Request,Response,self:{location:{origin:'https://vault.test'},addEventListener(type,fn){if(type==='fetch')handler=fn;}},fetch:async()=>{throw new TypeError('offline');},caches:{match:async request=>cached.get(typeof request==='string'?'https://vault.test'+request:request.url)?.clone()}};
 vm.createContext(context);vm.runInContext(source,context);
 handler({request:new Request('https://vault.test'+script),respondWith(promise){result=promise;}});
 assert.equal((await result).status,200);
});
