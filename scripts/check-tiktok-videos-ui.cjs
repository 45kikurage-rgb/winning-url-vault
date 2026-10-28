const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {createServer}=require('node:http');
const {chromium}=require('playwright');

(async()=>{
  const html=`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><body><main><article class="winning-card winning-product-row" id="card"></article></main><script type="module">
  import {initTikTokVideosUI,tikTokVideoCardHtml} from '/tiktok-videos-ui.js';
  const urls=['https://lite.tiktok.com/t/ZSgbn9NaF/','https://lite.tiktok.com/t/ZSgbnCxDU/','https://lite.tiktok.com/t/ZSgbnmLwv/'];
  window.flow={copied:'',failCopy:true,exported:0,completeCalls:0,pending:null};
  window.alert=()=>{};window.confirm=()=>true;
  const api=async(path,options={})=>{
    if(path.endsWith('/complete')){flow.completeCalls++;flow.exported=flow.pending.count;return {changed_count:flow.exported};}
    if(path.endsWith('/undo')){flow.exported=0;flow.pending=null;return {changed_count:3};}
    if(options.method==='DELETE'){flow.pending=null;return {status:'cancelled'};}
    return {batch:flow.pending ||= {id:'00000000-0000-0000-0000-000000000001',count:3,items:urls.map(value=>({value}))}};
  };
  const refresh=async()=>{document.querySelector('#card').innerHTML=tikTokVideoCardHtml({total_count:3,unexported_count:3-flow.exported});
    document.querySelector('[data-tiktok-copy]').onclick=()=>ui.open();document.querySelector('[data-tiktok-undo]').onclick=()=>ui.undo();};
  const ui=initTikTokVideosUI({api,refresh,writeClipboard:async text=>{if(flow.failCopy)throw Error('denied');flow.copied=text;}});
  await refresh();window.fixtureReady=true;
  </script></body></html>`;
  const server=createServer((req,res)=>{
    if(req.url==='/'){res.setHeader('content-type','text/html');return res.end(html);}
    const name=req.url.slice(1);if(!['styles.css','tiktok-video.js','tiktok-videos-ui.js'].includes(name)){res.statusCode=404;return res.end();}
    res.setHeader('content-type',name.endsWith('.css')?'text/css':'application/javascript');res.end(readFileSync('public/'+name));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try{
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:360,height:740}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.fixtureReady);
    assert(await page.locator('#card').innerText().then(text=>text.includes('Tiktoklite長時間動画')&&text.includes('単価登録不要')));
    await page.locator('[data-tiktok-copy]').click();await page.locator('#tiktokVideoCopyDialog[open]').waitFor();
    assert.equal(await page.locator('[data-complete]').isDisabled(),true);
    assert.equal(await page.evaluate(()=>flow.completeCalls),0);
    await page.evaluate(()=>{flow.failCopy=false;});await page.locator('[data-copy]').click();
    await page.waitForFunction(()=>flow.copied.includes('ZSgbnmLwv'));
    assert.deepEqual((await page.evaluate(()=>flow.copied)).split('\n'),['https://lite.tiktok.com/t/ZSgbn9NaF/','https://lite.tiktok.com/t/ZSgbnCxDU/','https://lite.tiktok.com/t/ZSgbnmLwv/']);
    assert.equal(await page.locator('[data-complete]').isDisabled(),false);
    assert(await page.locator('#tiktokVideoCopyDialog').evaluate(el=>el.getBoundingClientRect().width<=360));
    await page.locator('[data-close]').click();await page.locator('[data-tiktok-copy]').click();
    await page.locator('[data-complete]').click();await page.waitForFunction(()=>flow.exported===3);
    assert.equal(await page.locator('[data-tiktok-copy]').isDisabled(),true);
    await page.locator('[data-tiktok-undo]').click();await page.waitForFunction(()=>flow.exported===0);
    await page.locator('[data-tiktok-copy]').click();await page.locator('[data-cancel]').click();
    await page.waitForFunction(()=>flow.pending===null);assert.equal(await page.evaluate(()=>flow.exported),0);
    assert.deepEqual(errors,[]);console.log('Phone-width video card, clipboard failure/retry, exact URLs, restore, completion, undo and cancel passed.');
  } finally{await browser?.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
