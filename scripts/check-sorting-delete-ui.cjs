const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'../public'),app=fs.readFileSync(root+'/app.js','utf8');
 const cardCode=app.slice(app.indexOf('function cardHtml('),app.indexOf('function renderSortingCards('));
 const deleteCode=app.slice(app.indexOf('const sortingDeletes = new Set();'),app.indexOf('function bindDynamic()'));
 const browser=await chromium.launch({headless:true});
 try {
  for(const width of [320,360,412]){
   const page=await browser.newPage({viewport:{width,height:850},isMobile:true});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('http://vault.local/**',route=>route.fulfill({contentType:'text/css',body:fs.readFileSync(root+'/styles.css')}));
   await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="http://vault.local/styles.css"><body><main id="app"><section id="cards"></section></main></body>');
   await page.addScriptTag({content:`
    const card={id:'card',display_name:'オールフリー 350ml缶(税込177円)',raw_name:'オールフリー',specification:'350ml',redeem_place:'ファミリーマート',expires_on:'2026-11-16',unassigned_count:1};
    const state={sortingSource:'arunomatic',cards:new Map([['card',card]])};
    const esc=value=>String(value||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
    const displayLabel=(scope,id,name)=>name,isEraberuPay=()=>false;
    window.deleteCalls=0;
    async function api(path,options){if(!options)return {count:1,ids:['one']};window.deleteCalls++;card.unassigned_count=0;return {deleted:1,skipped:0};}
    async function load(){document.getElementById('cards').innerHTML=card.unassigned_count?cardHtml(card):'<p>仕分け待ちのカードはありません</p>';}
    ${cardCode}\n${deleteCode}
    load().then(()=>{document.querySelector('[data-delete-sorting]').onclick=event=>deleteSortingCard(event.currentTarget);});
   `});
   const button=page.locator('[data-delete-sorting="card"]');
   await button.waitFor();assert.equal(await button.textContent(),'削除');
   assert.equal(await page.locator('.unassigned-label').textContent(),'未仕分け1件');
   assert((await button.boundingBox()).height>=44);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   page.once('dialog',dialog=>dialog.dismiss());await button.click();
   assert.equal(await page.evaluate(()=>window.deleteCalls),0);assert(await button.isEnabled());
   page.on('dialog',async dialog=>{if(dialog.type()==='confirm'){assert.match(dialog.message(),/オールフリー/);assert.match(dialog.message(),/未仕分けの1件/);}await dialog.accept();});
   await button.click();await page.waitForFunction(()=>window.deleteCalls===1);
   assert.equal(await page.getByRole('button',{name:/削除/}).count(),0);
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log('Sorting deletion mobile UI passed at 320/360/412px: visible button, no horizontal overflow, cancel, confirmation and removal.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});

