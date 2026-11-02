/* Independent acceptance gate: load the shipped document and modules unchanged.
 * Only /api responses are synthetic. No extracted renderers or application globals.
 * Run: NODE_PATH=<Playwright modules> node scripts/check-mobile-e2e.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');
const publicRoot = path.resolve(process.env.MOBILE_E2E_PUBLIC_ROOT || path.join(__dirname, '../public'));
const evidence = path.resolve(process.env.MOBILE_E2E_SCREENSHOT_DIR || 'mobile-e2e-evidence');
const report = { harness:'unchanged index.html + app.js; synthetic HTTP API; Chromium mobile emulation', passed:[], errors:[] };
fs.mkdirSync(evidence, { recursive:true });
const read = name => fs.readFileSync(path.join(publicRoot, name), 'utf8');
const longName = '対象商品のいずれか一つ🍵家族👨‍👩‍👧‍👦「<img src=x onerror=alert(1)>」' + 'W'.repeat(90) + 'をご利用いただけます'.repeat(9);
const campaign = { campaign_id:'campaign-fixture', campaign_name:'合成テストキャンペーン', status:'active', lottery_start_date:'2026-11-01', current_winner_count:7 };

function checkPrecacheClosure() {
  const html = read('index.html'), sw = read('sw.js');
  const assets = JSON.parse(sw.match(/const ASSETS\s*=\s*(\[[\s\S]*?\]);/)[1]);
  const dependencies = new Set();
  function visit(url) {
    const parsed = new URL(url, 'http://localhost'), pathname = parsed.pathname, requestUrl = pathname + parsed.search;
    if (dependencies.has(requestUrl)) return;
    dependencies.add(requestUrl);
    assert(assets.some(asset => new URL(asset, 'http://localhost').pathname === pathname), `PWA precache missing imported module ${pathname}`);
    const code = read(pathname.slice(1));
    for (const match of code.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) visit(new URL(match[1], 'http://localhost' + pathname).pathname);
  }
  for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
    assert(assets.includes(match[1]), `HTML script URL missing exact precache version: ${match[1]}`);
    visit(match[1]);
  }
  for (const match of html.matchAll(/<link[^>]+href=["']([^"']+\.css[^"']*)["']/g)) assert(assets.includes(match[1]), `HTML stylesheet URL missing exact precache version: ${match[1]}`);
  for (const asset of assets) assert(fs.existsSync(path.join(publicRoot, new URL(asset, 'http://localhost').pathname === '/' ? 'index.html' : new URL(asset, 'http://localhost').pathname.slice(1))), `Precache asset absent: ${asset}`);
  report.passed.push({name:'PWA static transitive import closure', modules:[...dependencies]});
  return { assets, dependencies:[...dependencies], cacheName:sw.match(/const CACHE\s*=\s*["']([^"']+)/)[1] };
}

function fixture({ pending = false, noCampaigns = false } = {}) {
  const cards = Object.fromEntries(['arunomatic','chiritumo'].map(source => [source, Array.from({ length:18 }, (_, index) => ({
    id:`${source}-card-${index}`, display_name:index === 0 ? longName : `続けて仕分ける商品 ${index}`,
    raw_name:index === 0 ? longName : `続けて仕分ける商品 ${index}`,
    count:index === 1 ? 123456789 : 3, unassigned_count:index === 1 ? 123456789 : 3,
    specification:'350ml／規格'.repeat(10), redeem_place:'店舗名'.repeat(12), expires_on:'2030-11-30', assignments:[]
  }))]));
  const state = { cards, mode:'normal', pending:pending ? [{ id:'pending-one', intake_source:'arunomatic', raw_name:'修正前の正式名', normalized_name:'修正前の判定名', display_name:'修正前の表示名', specification:'旧規格', redeem_place:'旧店舗', expires_on:'2030-01-01', item_count:2 }] : [],
    names:[], writes:[], reads:[], unexpected:[], failConfirm:pending, failCards:false, failSingle:true, singleReceipts:new Map() };
  const products = [{ product_id:'product-long', display_name:longName, product_name:longName,
    product_spec:'規格'.repeat(30), redemption_place:'利用店舗'.repeat(20), valid_until:'2030-11-30',
    total_count:123456789, unexported_count:123456789, output_method:'normal', unit_price:100,
    campaign_id:campaign.campaign_id, campaign_name:campaign.campaign_name, campaign_status:'active', lottery_start_date:'2026-11-01' },
  { product_id:'tiktok-fixture', category:'tiktok_lite_long_video', total_count:3, unexported_count:3, campaign_status:'active' }];
  state.respond = (url, method, body) => {
    const p = url.pathname, source = url.searchParams.get('intake_source') || 'arunomatic';
    if (method !== 'GET') state.writes.push({ path:p, source, method, body }); else state.reads.push(p);
    const success = data => [200, { ok:true, ...data }];
    const failure = (error, code='FIXTURE_FAILURE', status=503) => [status,{ ok:false,error,code }];
    if (method === 'GET') {
      if (p === '/api/auth/status') return success({ configured:true, authenticated:true, mode:'production', deviceOnlyMode:true });
      if (p === '/api/display-names') return success({names:state.names});
      if (p === '/api/cards') return state.failCards ? failure('合成読取障害') : success({cards:state.cards[source]});
      if (p === '/api/pending') return success({items:source === 'arunomatic' ? state.pending : []});
      if (p === '/api/unresolved') return success({items:[]});
      if (p === '/api/usage') return success({usedIds:[],ids:[]});
      if (p === '/api/winning-lists') return success({products});
      if (p === '/api/ledger/campaigns') return success({campaigns:noCampaigns?[]:[campaign]});
      if (p === '/api/ledger/outbox') return success({sent:3,pending:0,failed:0});
      if (p === '/api/revenue/summary') return success({monthly_revenue:1234567,daily_revenue:12345,month:'2026-11',date:'2026-11-02'});
      if (p === '/api/jobs/latest') return success({job:null});
      if (p === '/api/export-batches/pending') return success({batch:null});
      if (p === '/api/provisional') return success({mode:state.mode,buckets:[{slot:'A',bucketId:'bucket-a',count:1,items:[{id:'provisional-one',value:'https://fixture.invalid/'+'LONGCODE'.repeat(40)}]}]});
      const preview = p.match(/^\/api\/cards\/([^/]+)\/(assignment-preview|single-win-preview)$/);
      if (preview) {
        const card = state.cards[source].find(row => row.id === preview[1]);
        if (!card) return failure('合成カードなし','NOT_FOUND',404);
        if (preview[2] === 'assignment-preview') return success({card,campaign,exact_product:null,possible_products:[]});
        return success({card_id:card.id,intake_source:source,count:3,ids:['one','two','three'],preview_token:'synthetic-preview-token',product_name:card.raw_name,product_spec:card.specification,redemption_place:card.redeem_place,valid_until:card.expires_on,registration_date:'2026-11-02'});
      }
      if (p.startsWith('/api/single-wins/')) return state.singleReceipts.has(p.split('/').at(-1)) ? success(state.singleReceipts.get(p.split('/').at(-1))) : failure('まだ保存されていません','SINGLE_WIN_NOT_FOUND',404);
    } else if (method === 'POST') {
      if (p === '/api/receive-mode') { state.mode=body.mode; return success({mode:state.mode}); }
      if (p.startsWith('/api/display-names/')) { const [, , , scope, id] = p.split('/'); state.names.push({scope,target_id:id,display_name:body.display_name}); return success({}); }
      if (p === '/api/pending/pending-one/confirm') {
        if (state.failConfirm) return failure('合成保存障害');
        state.pending=[]; return success({classified:2});
      }
      const assignment = p.match(/^\/api\/cards\/([^/]+)\/(assign|single-win)$/);
      if (assignment) {
        if (assignment[2] === 'single-win' && state.failSingle) return failure('合成登録障害');
        state.cards[source] = state.cards[source].filter(card => card.id !== assignment[1]);
        if (assignment[2] === 'assign') return success({assigned_count:3});
        const receipt={state:'completed',request_id:body.request_id,card_id:assignment[1],intake_source:source,assigned_count:3,campaign_id:'single-campaign',product_id:'single-product'};
        state.singleReceipts.set(body.request_id,receipt); return success(receipt);
      }
    }
    state.unexpected.push(`${method} ${p}`); return failure('Unimplemented test API','UNEXPECTED_FIXTURE_ROUTE',501);
  };
  return state;
}

let currentFixture, browser, server, origin, activePage;
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png'};
async function startServer() {
  server = createServer(async (req,res) => {
    const url = new URL(req.url,'http://localhost');
    res.setHeader('Cache-Control','no-store');
    if (url.pathname.startsWith('/api/')) {
      let raw=''; for await (const chunk of req) raw+=chunk;
      let data; try { data=raw ? JSON.parse(raw) : {}; } catch { res.writeHead(400);return res.end(); }
      const [status,body]=currentFixture.respond(url,req.method,data);
      res.writeHead(status,{'Content-Type':'application/json'});return res.end(JSON.stringify(body));
    }
    if (url.pathname === '/probe.html') { res.writeHead(200,{'Content-Type':'text/html'});return res.end('<!doctype html><title>PWA setup</title>'); }
    const relative=url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const full=path.resolve(publicRoot,relative);
    if (!full.startsWith(publicRoot + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {res.writeHead(404);return res.end();}
    res.writeHead(200,{'Content-Type':mime[path.extname(full)] || 'application/octet-stream'});res.end(fs.readFileSync(full));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); origin='http://127.0.0.1:'+server.address().port;
}
async function openPage(width=393,scale=1,options={}) {
  currentFixture=fixture(options);
  const context=await browser.newContext({viewport:{width,height:873},isMobile:true,hasTouch:true,deviceScaleFactor:2.75,serviceWorkers:options.serviceWorkers ? 'allow' : 'block'});
  await context.addInitScript(({scale,tab})=>{localStorage.setItem('winning-url-vault:tab',tab);document.addEventListener('DOMContentLoaded',()=>{document.documentElement.style.fontSize=`${16*scale}px`;},{once:true});},{scale,tab:options.tab || 'sorting'});
  const page=await context.newPage();activePage=page;page.setDefaultTimeout(15000);
  const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(tab=>document.body.dataset.activeTab === tab && document.querySelectorAll('[data-sorting-card]').length === 18,options.tab || 'sorting');
  // This readiness marker lives in the inactive campaigns tab. Its data must
  // be ready, but boot must not require that unrelated tab to become visible.
  await page.waitForFunction(()=>document.querySelector('#ledgerSyncStatus')?.textContent.includes('中央台帳同期'));
  return {page,context,data:currentFixture,pageErrors};
}
async function settle(page) {await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function layout(page,selector,label,{targets=true}={}) {
  await settle(page);
  const metrics=await page.locator(selector).evaluate((root,targets)=>{
    const bad=[];const visible=node=>node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    const describe=node=>{
      const ancestors=[];
      for(let parent=node.parentElement;parent&&ancestors.length<5;parent=parent.parentElement){
        const box=parent.getBoundingClientRect(),style=getComputedStyle(parent);
        ancestors.push({tag:parent.tagName,id:parent.id,cls:parent.className,
          ...(parent.tagName==='DETAILS'?{open:parent.open}:{}),left:box.left,right:box.right,width:box.width,
          display:style.display,visibility:style.visibility,overflowX:style.overflowX});
      }
      return {tag:node.tagName,id:node.id,cls:node.className,text:node.textContent.replace(/\s+/g,' ').trim().slice(0,160),
        data:Object.fromEntries([...node.attributes].filter(attribute=>attribute.name.startsWith('data-')).map(attribute=>[attribute.name,attribute.value.slice(0,160)])),ancestors};
    };
    for (const node of root.querySelectorAll('button,input,select,textarea,[data-name-scope],.coupon,.winning-card')) {
      if (!visible(node)) continue;const b=node.getBoundingClientRect();
      if (b.left < -1 || b.right > innerWidth+1 || b.width > innerWidth+1) bad.push({...describe(node),left:b.left,right:b.right,width:b.width});
      if (targets && node.matches('button,[data-name-scope]') && b.height < 43.5) bad.push({...describe(node),height:b.height});
    }
    if(root.id==='app') {
      const textBoxes=[...root.querySelectorAll('header h1,#headerRevenue span,#headerRevenue strong')].filter(visible).map(node=>{
        const range=document.createRange();range.selectNodeContents(node);const box=range.getBoundingClientRect();
        return {node,box};
      });
      for(const {node,box} of textBoxes) if(box.left < -1 || box.right > innerWidth+1)
        bad.push({...describe(node),kind:'header-text-outside-viewport',left:box.left,right:box.right});
      const title=textBoxes.find(({node})=>node.tagName==='H1');
      if(title)for(const revenue of textBoxes.filter(({node})=>node.tagName!=='H1')) {
        const overlapX=Math.min(title.box.right,revenue.box.right)-Math.max(title.box.left,revenue.box.left);
        const overlapY=Math.min(title.box.bottom,revenue.box.bottom)-Math.max(title.box.top,revenue.box.top);
        if(overlapX>1&&overlapY>1)bad.push({...describe(revenue.node),kind:'header-title-revenue-overlap',overlapX,overlapY,title:title.node.textContent});
      }
    }
    return {bad,overflow:root.scrollWidth-root.clientWidth,documentOverflow:document.documentElement.scrollWidth-innerWidth};
  },targets);
  assert.deepEqual(metrics.bad,[],`${label}: ${JSON.stringify(metrics)}`);
  assert(metrics.overflow <= 1 && metrics.documentOverflow <= 1,`${label}: horizontal overflow ${JSON.stringify(metrics)}`);
}
async function clickTab(page,tab) {
  await page.locator(`[data-tab="${tab}"]`).click();
  await page.waitForFunction(tab=>document.body.dataset.activeTab === tab,tab);await settle(page);
}
async function checkJapaneseFont(context,page) {
  await page.evaluate(()=>document.fonts.ready);
  const session=await context.newCDPSession(page);
  try {
    await session.send('DOM.enable');await session.send('CSS.enable');
    const {root}=await session.send('DOM.getDocument');
    const {nodeId}=await session.send('DOM.querySelector',{nodeId:root.nodeId,selector:'[data-edit-sorting-name="arunomatic-card-0"]'});
    const {fonts}=await session.send('CSS.getPlatformFontsForNode',{nodeId});
    // The real button contains only the three Japanese characters 表示名.
    // A computed font-family string alone cannot prove that glyphs were used.
    assert(fonts.some(font=>/Noto.*(?:CJK|JP)/i.test(font.familyName)&&font.glyphCount>=3),`CI Japanese glyph font unavailable: ${JSON.stringify(fonts)}`);
    report.japaneseGlyphFonts=fonts;
    report.fontScope='CI Noto CJK glyph coverage; mobile viewport/text-scale substitute, not Pixel 10 font identity';
  } finally {await session.detach();}
}
async function checkCompactActions(page,source,scale) {
  for (const index of [0,1]) {
    const card=page.locator(`[data-sorting-card="${source}-card-${index}"]`);
    const actions=await card.evaluate(node=>{
      const selectors=['[data-assign-card]','[data-delete-sorting]','[data-edit-sorting-name]','[data-card]'];
      return selectors.map(selector=>{
        const button=node.querySelector(selector);if(!button)return{missing:selector};
        const box=button.getBoundingClientRect();
        return {selector,text:button.textContent,left:box.left,right:box.right,top:box.top,height:box.height,width:box.width,client:button.clientWidth,scroll:button.scrollWidth};
      });
    });
    assert(actions.every(action=>!action.missing),`Four primary card actions must exist: ${JSON.stringify(actions)}`);
    for (const action of actions) {
      assert(action.width>=43.5&&action.height>=43.5,`Compact touch target too small: ${JSON.stringify(action)}`);
      if(scale===1)assert(action.height<=48.5,`Normal-text action row should stay compact: ${JSON.stringify(action)}`);
      assert(action.scroll<=action.client+1,`Compact button text clipped horizontally: ${JSON.stringify(action)}`);
    }
    assert(Math.max(...actions.map(action=>action.top))-Math.min(...actions.map(action=>action.top))<=1,`Four primary actions must share one row at ${scale}x: ${JSON.stringify(actions)}`);
    for(let i=1;i<actions.length;i++)assert(actions[i].left>=actions[i-1].right-1,`Primary actions overlap or changed order: ${JSON.stringify(actions)}`);
    if(index===1)assert((await card.textContent()).includes('123,456,789'),'Large unassigned count must remain available in the card');
  }
}
async function checkName(page,scope,id) {
  const name=page.locator(`[data-name-scope="${scope}"][data-name-id="${id}"]`);
  await name.tap();const dialog=page.locator('#productNameDialog[open]');await dialog.waitFor();
  const fields=await dialog.locator('.product-name-detail span').allTextContents();assert.equal(fields[1],longName);
  assert.equal(await dialog.locator('img').count(),0,'Product text must never become HTML');
  await layout(page,'#productNameDialog','full name dialog');
  const wrap=await dialog.locator('.product-name-detail span').nth(1).evaluate(el=>({scroll:el.scrollWidth,client:el.clientWidth,height:el.getBoundingClientRect().height,line:parseFloat(getComputedStyle(el).lineHeight)}));
  assert(wrap.scroll <= wrap.client+1 && wrap.height > wrap.line,'Full product name must wrap rather than hide text');
  await dialog.locator('[data-name-edit]').click();await page.locator('#displayNameDialog[open]').waitFor();
  const alias='編集した表示名';await page.locator('#displayNameInput').fill(alias);await page.locator('#displayNameSave').click();
  await page.waitForFunction(()=>!document.querySelector('#displayNameDialog').open);
  await page.waitForFunction(({scope,id,alias})=>[...document.querySelectorAll('[data-name-scope]')].some(el=>el.dataset.nameScope===scope&&el.dataset.nameId===id&&el.textContent===alias),{scope,id,alias});
  await name.focus();await page.keyboard.press('Space');await dialog.waitFor();
  assert.equal((await dialog.locator('.product-name-detail span').allTextContents())[1],longName,'Alias edit must retain formal name');
  await dialog.locator('[data-name-close]').click();
}
async function verifyMatrix() {
  for (const width of [320,360,393,412]) for (const scale of [1,2]) {
    const test=await openPage(width,scale);const {page,context,data,pageErrors}=test;
    if(width===320&&scale===1)await checkJapaneseFont(context,page);
    await layout(page,'#app',`sorting ${width}/${scale}`);await checkCompactActions(page,'arunomatic',scale);await checkName(page,'sorting','arunomatic-card-0');
    await page.screenshot({path:path.join(evidence,`compact-actions-${width}-${scale}x.png`)});
    await page.locator('[data-assign-card="arunomatic-card-0"]').click();
    await page.waitForFunction(()=>document.querySelector('#assignmentDialog').open && !document.querySelector('#assignmentConfirm').disabled);
    await layout(page,'#assignmentDialog',`assignment entry ${width}/${scale}`);
    assert.equal(await page.locator('#assignmentSingleWin').isVisible(),true,'Compact row must retain the single-win entry');
    await page.locator('#assignmentClose').click();
    await clickTab(page,'winning');await page.locator('[data-name-id="product-long"]').waitFor();
    await layout(page,'#app',`winning ${width}/${scale}`);await checkName(page,'winning','product-long');
    assert.equal(await page.locator('[data-tiktok-copy]').count(),1,'Existing TikTok card must remain available');
    await page.locator('[data-tiktok-copy]').scrollIntoViewIfNeeded();await layout(page,'#tabWinning',`TikTok ${width}/${scale}`);
    await clickTab(page,'chiritumo');await page.locator('[data-name-id="chiritumo-card-0"]').waitFor();await layout(page,'#app',`chiritumo ${width}/${scale}`);await checkCompactActions(page,'chiritumo',scale);
    assert.equal(await page.locator('#provisionalSortingPanel').isVisible(),false,'Chiritumo must not expose provisional intake of another source');
    await clickTab(page,'receive');await page.locator('[data-provisional-mode="A"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-provisional-mode="A"]').getAttribute('aria-pressed')==='true');
    assert.equal(data.mode,'A');await layout(page,'#app',`provisional receive ${width}/${scale}`);
    await clickTab(page,'sorting');await page.locator('#provisionalSortingPanel > summary').click();
    await page.locator('[data-provisional-slot="A"] details > summary').click();await layout(page,'#tabSorting',`provisional details ${width}/${scale}`);
    await page.screenshot({path:path.join(evidence,`actual-page-${width}-${scale}x.png`)});
    assert.deepEqual(pageErrors,[]);assert.deepEqual(data.unexpected,[]);
    report.passed.push({name:'Actual-page mobile matrix',width,rootTextScale:scale,tabs:['sorting','winning','chiritumo','receive'],fullNameAndAlias:true,tiktokAndProvisional:true,compactFourActions:'one-row/order/44px/no-clipped-text',largeCount:123456789});
    await context.close();
  }
}
async function verifyAssignment(source) {
  const {page,context,data,pageErrors}=await openPage(393,1,{tab:source==='chiritumo'?'chiritumo':'sorting'});
  const tab=source==='chiritumo'?'chiritumo':'sorting', target=`${source}-card-8`, anchor=`${source}-card-9`;
  await page.locator(`[data-sorting-card="${target}"]`).evaluate(el=>{
    const port=document.querySelector('#tabSorting');
    port.scrollTop+=el.getBoundingClientRect().top-port.getBoundingClientRect().top+2;
  });
  await page.locator(`[data-assign-card="${target}"]`).click();
  await page.waitForFunction(()=>document.querySelector('#assignmentDialog').open && !document.querySelector('#assignmentConfirm').disabled);
  const before=await page.locator(`[data-sorting-card="${anchor}"]`).evaluate(el=>el.getBoundingClientRect().top);
  await page.locator('#assignmentConfirm').click();
  await page.waitForFunction(({target,tab})=>!document.querySelector('#assignmentDialog').open&&!document.querySelector(`[data-sorting-card="${target}"]`)&&document.body.dataset.activeTab===tab,{target,tab});
  await page.locator('#sortingActionNotice p').filter({hasText:'残り'}).waitFor();
  assert.equal(await page.locator('[data-sorting-card]').count(),17);
  const after=await page.locator(`[data-sorting-card="${anchor}"]`).evaluate(el=>el.getBoundingClientRect().top);
  assert(Math.abs(after-before)<=2,`Assignment shifted the surviving card by ${after-before}px`);
  const top=await page.locator('#tabSorting').evaluate(el=>el.scrollTop);assert(top>0,'Assignment must not reset to top');
  await page.locator('[data-notice-dismiss]').evaluate(el=>el.click());await settle(page);
  const afterDismiss=await page.locator(`[data-sorting-card="${anchor}"]`).evaluate(el=>el.getBoundingClientRect().top);
  assert(Math.abs(afterDismiss-after)<=2,'Dismissing completion notice must preserve the surviving scroll anchor');
  assert.equal(data.writes.filter(row=>row.path.endsWith('/assign')).length,1);assert.equal(data.writes.find(row=>row.path.endsWith('/assign')).source,source);
  assert.deepEqual(pageErrors,[]);assert.deepEqual(data.unexpected,[]);
  report.passed.push({name:'Real assignment keeps source tab and scroll',source,anchorBefore:before,anchorAfter:after,afterDismiss,scrollTop:top});await context.close();
}
async function verifyPendingFailure() {
  const {page,context,data,pageErrors}=await openPage(393,1,{pending:true});
  const card=page.locator('#pendingList [data-pending="pending-one"]');await card.locator('[data-action="edit"]').click();
  const values={raw_name:'編集後の正式名',normalized_name:'編集後の判定名',display_name:'編集後の表示名',specification:'500ml',redeem_place:'修正後店舗',expires_on:'2030-12-31'};
  for(const [name,value] of Object.entries(values)) await card.locator(`[name="${name}"]`).fill(value);
  await card.locator('[data-action="ok"]').click();await card.locator('.confirmation-message').filter({hasText:'入力内容は残っています'}).waitFor();
  assert.equal(await card.evaluate(el=>el.classList.contains('editing')),true);
  for(const [name,value] of Object.entries(values)) assert.equal(await card.locator(`[name="${name}"]`).inputValue(),value);
  assert.deepEqual(data.writes.at(-1).body,{action:'edit',...values},'Original OK path must POST all edited values');
  data.failConfirm=false;data.failCards=true;await card.locator('[data-action="ok"]').click();
  await page.waitForFunction(()=>!document.querySelector('#pendingList [data-pending="pending-one"]'));
  await page.locator('#sortingActionNotice').filter({hasText:'一覧の更新ができません'}).waitFor();
  assert.equal(data.writes.filter(row=>row.path.endsWith('/confirm')).length,2,'Read failure after durable success must not resubmit');
  assert.equal(await page.locator('body').getAttribute('data-active-tab'),'sorting');
  assert.deepEqual(pageErrors,[]);assert.deepEqual(data.unexpected,[]);report.passed.push({name:'Edited original OK, failed write retains draft, successful write/read failure remains saved'});await context.close();
}
async function verifySingleWin() {
  const {page,context,data,pageErrors}=await openPage(393,1,{noCampaigns:true});
  await page.locator('[data-assign-card="arunomatic-card-0"]').click();
  await page.locator('#assignmentDialog[open]').waitFor();
  assert.equal(await page.locator('#assignmentCampaign option').count(),0);
  assert.equal(await page.locator('#assignmentSingleWin').isEnabled(),true,'Single-win entry must work with no campaign available');
  await layout(page,'#assignmentDialog','single-win entry without campaigns');
  await page.locator('#assignmentSingleWin').click();const dialog=page.locator('#singleWinDialog[open]');await dialog.waitFor();
  assert.equal(await page.locator('#assignmentDialog').evaluate(el=>el.open),false,'Only the chosen single-win dialog remains open');
  await layout(page,'#singleWinDialog','single-win preview');
  await dialog.locator('[data-details]').filter({hasText:'登録対象 3件'}).waitFor();
  const details=await dialog.locator('[data-details]').textContent();await dialog.locator('[data-submit]').click();
  await dialog.locator('[data-message]').filter({hasText:'登録の完了を確認できません'}).waitFor();
  assert.equal(await dialog.locator('[data-details]').textContent(),details,'Failed single win must retain exact preview');
  const first=data.writes.find(row=>row.path.endsWith('/single-win'));assert(first.body.request_id);assert.equal(first.body.confirmation,'単発当選として登録');
  await dialog.locator('[data-close]').click();await page.reload();
  await page.locator('#singleWinRecovery button').waitFor();await page.locator('#singleWinRecovery button').click();await dialog.waitFor();
  assert.equal(await dialog.locator('[data-details]').textContent(),details,'Reload recovery must retain preview');
  data.failSingle=false;await dialog.locator('[data-submit]').click();await page.waitForFunction(()=>!document.querySelector('#singleWinDialog').open);
  await page.waitForFunction(()=>!document.querySelector('[data-sorting-card="arunomatic-card-0"]'));
  const writes=data.writes.filter(row=>row.path.endsWith('/single-win'));assert.equal(writes.length,2);assert.deepEqual(writes[1].body,writes[0].body,'Retry must reuse the exact operation and item IDs');
  assert(data.reads.includes('/api/single-wins/'+first.body.request_id),'Retry must read receipt before resending');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('winning-url-vault:single-win-pending:v1')).length),0);
  assert.equal(await page.locator('body').getAttribute('data-active-tab'),'sorting');
  assert.deepEqual(pageErrors,[]);assert.deepEqual(data.unexpected,[]);report.passed.push({name:'Single win entry with no campaigns, failure, reload recovery, same-ID retry and durable receipt'});await context.close();
}
async function verifyPwa(precache) {
  const {page,context,data,pageErrors}=await openPage(393,1,{serviceWorkers:true});
  await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await page.evaluate(()=>navigator.serviceWorker.ready);
  const cached=await page.evaluate(async cacheName=>(await (await caches.open(cacheName)).keys()).map(req=>{const url=new URL(req.url);return url.pathname+url.search;}),precache.cacheName);
  for(const module of precache.dependencies) assert(cached.includes(module),`Installed PWA misses ${module}`);
  const apiCached=await page.evaluate(async()=>{const all=await Promise.all((await caches.keys()).map(async key=>(await (await caches.open(key)).keys()).map(req=>new URL(req.url).pathname)));return all.flat().filter(p=>p.startsWith('/api/'));});
  assert.deepEqual(apiCached,[],'API and authentication responses must never enter offline asset cache');
  await context.setOffline(true);await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>Boolean(document.querySelector('#tiktokVideoCopyDialog')),'',{timeout:15000});
  await page.locator('#loginScreen:not(.hidden)').waitFor();
  const offline=await page.evaluate(async deps=>Promise.all(deps.map(async url=>{const response=await fetch(url);return{url,status:response.status,type:response.headers.get('content-type')};})),precache.dependencies);
  for(const asset of offline) assert(asset.status===200&&/javascript/.test(asset.type),`Offline module unavailable: ${JSON.stringify(asset)}`);
  assert.deepEqual(pageErrors,[]);assert.deepEqual(data.unexpected,[]);report.passed.push({name:'Real service worker installation, offline module loading, no API cache',cache:precache.cacheName});await context.close();
}

(async()=>{
  try {
    const precache=checkPrecacheClosure();
    if(process.argv.includes('--static-only')) {console.log('PWA static precache/import contract passed; browser scenarios NOT RUN.');return;}
    const {chromium}=require('playwright');await startServer();
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH}:{})});
    await verifyMatrix();await verifyAssignment('arunomatic');await verifyAssignment('chiritumo');await verifyPendingFailure();await verifySingleWin();await verifyPwa(precache);
    console.log(`Independent actual-page mobile E2E: ${report.passed.length} acceptance scenarios passed.`);
  } catch(error) {
    report.errors.push(error.stack || String(error));
    try {await activePage?.screenshot({path:path.join(evidence,'failure.png')});}catch{}
    throw error;
  } finally {
    fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify(report,null,2)+'\n');
    await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
