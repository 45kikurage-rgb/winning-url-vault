const { chromium } = require('playwright');
const fs=require('node:fs');const assert=require('node:assert/strict');
(async()=>{
 const root=require('node:path').resolve(__dirname,'../public');
 const html=fs.readFileSync(root+'/index.html','utf8');
 const section=html.slice(html.indexOf('<details id="provisionalSortingPanel"'),html.indexOf('  <section id="pendingSection"'));
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:360,height:800},isMobile:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://vault.local/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/')return route.fulfill({contentType:'text/html',body:'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><main id="app"><button id="receive"></button><p id="provisionalModeStatus"></p><p id="receiveContext"></p>'+section+'</main></body></html>'});
  return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':'text/css',body:fs.readFileSync(root+path)});
 });
 await page.goto('http://vault.local');
 await page.evaluate(async()=>{
  window.deletes=0;
  let items=[{id:'11111111-1111-1111-1111-111111111111',value:'<script>CODE-1</script>',source:''},{id:'22222222-2222-2222-2222-222222222222',value:'https://example.test/'+ 'x'.repeat(300),source:''}];
  const ui=await import('/provisional-ui.js');
  window.refresh=ui.refreshProvisionalUI;
  await ui.initProvisionalUI(async(path,options)=>{
    if(options?.method==='DELETE'){window.deletes++;const body=JSON.parse(options.body);if(body.confirmation!=='暫定から削除')throw Error('confirmation missing');items=items.filter(i=>!path.endsWith(i.id));return {ok:true};}
    return {mode:'A',buckets:[{slot:'A',bucketId:'initial-A',count:items.length,items,truncated:false}]};
  },()=>{});
 });
 assert.equal(await page.locator('#provisionalSortingPanel').evaluate(el=>el.open),false);
 assert.equal(await page.locator('#provisionalTotalCount').textContent(),'2件');
 assert.equal(await page.locator('[data-delete-item]').first().isVisible(),false);
 await page.locator('#provisionalSortingPanel>summary').click();
 await page.locator('.provisional-result-group summary').click();
 await page.locator('input[name=name]').fill('入力途中を保持');
 const button=page.locator('[data-delete-item]').first();
 assert.ok((await button.boundingBox()).height>=44);
 page.once('dialog',d=>d.dismiss());await button.click();assert.equal(await page.evaluate(()=>window.deletes),0);
 page.once('dialog',d=>{assert.ok(d.message().includes('<script>CODE-1</script>'));return d.accept();});await button.click();
 await page.waitForFunction(()=>document.getElementById('provisionalTotalCount').textContent==='1件');
 assert.equal(await page.locator('input[name=name]').inputValue(),'入力途中を保持');
 assert.equal(await page.locator('.provisional-result-group details').evaluate(el=>el.open),true);
 assert.equal(await page.locator('.provisional-code-value script').count(),0);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 page.once('dialog',d=>d.accept());await page.locator('[data-delete-item]').click();
 await page.waitForFunction(()=>document.getElementById('provisionalTotalCount').textContent==='0件');
 assert.ok(await page.locator('.provisional-empty').isVisible());
 assert.equal(await page.evaluate(()=>window.deletes),2);
 assert.deepEqual(errors,[]);
 await page.reload();assert.equal(await page.locator('#provisionalSortingPanel').evaluate(el=>el.open),false);
 console.log('Mobile browser passed: default collapse, expand, cancel, delete, count, draft preservation, empty state, touch size, XSS escaping, 360px width, reload collapse.');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
