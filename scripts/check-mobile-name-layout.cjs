const assert = require('node:assert/strict');
const { readFileSync, mkdirSync } = require('node:fs');
const { createServer } = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

// Execute the real list renderers and name-dialog handlers, not copied markup.
const publicRoot = path.resolve(__dirname, '../public');
const app = readFileSync(path.join(publicRoot, 'app.js'), 'utf8');
function section(start, end) {
  const from = app.indexOf(start), to = app.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, `Source section missing: ${start}`);
  return app.slice(from, to);
}
const fixtureJs = `
import { attentionReasons, expiryLabel } from '/winning-view.js';
import { isEraberuPay } from '/analysis-amount.js';
import { isTikTokVideoCard } from '/tiktok-video.js';
import { nameUnits, validateDisplayName } from '/display-name.js';
const $ = id => document.getElementById(id);
const state = { cards:new Map(), winningLists:[], sortingSource:'arunomatic' };
const displayNames = new Map(), balanceRechecks = new Map(), sortingNotices = new Map();
const winningView = { showCampaign:true, relativeDates:false };
let editingName;
${section('function displayLabel(', 'async function loadDisplayNames(')}
${section('function displayNameField(', 'async function saveDisplayAlias(')}
${section('function esc(', 'function parseReceiveValues(')}
${section('function cardHtml(', 'function renderSortingCards(')}
${section('function renderSortingCards(', 'async function load(')}
${section('function syncWinningChildren(', 'function renderWinningSection(')}
${section('function renderSortingNotice(', 'async function refreshAfterAssignment(')}
${section('function winningCardHtml(', 'function productContext(')}
${section('function winningProduct(', 'function bindWinningControls(')}
function methodLabel() { return '通常URL'; }
window.setFixture = ({ name, scale, count, view }) => {
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  document.documentElement.style.fontSize = 16 * scale + 'px';
  document.body.dataset.operationMode = 'production';
  document.body.dataset.activeTab = view;
  $('loginScreen').classList.add('hidden');
  $('app').classList.remove('hidden');
  document.querySelector('.trial-notice').classList.add('hidden');
  document.querySelectorAll('#app>.tab-page').forEach(node => node.classList.add('hidden'));
  $('headerMonthlyRevenue').textContent = '123,456,789 円';
  $('headerDailyRevenue').textContent = '123,456 円';
  const card = { id:'card-fixture', display_name:name, raw_name:name,
    specification:'350ml / 500ml / SpecialUnbrokenSpecification'.repeat(3),
    redeem_place:'セブンイレブン・ファミリーマート・ローソン', expires_on:'2026-11-30',
    unassigned_count:count, assignments:[] };
  const item = { product_id:'product-fixture', display_name:name, product_name:name,
    product_spec:card.specification, redemption_place:card.redeem_place,
    valid_until:card.expires_on, total_count:count, unexported_count:count,
    output_method:'normal', campaign_status:'active', unit_price:100,
    campaign_name:'長いキャンペーン名'.repeat(8), lottery_start_date:'2026-11-01' };
  state.cards = new Map([[card.id, card]]); state.winningLists = [item];
  if (view === 'sorting') {
    $('tabSorting').classList.remove('hidden');
    $('cards').innerHTML = '<div data-sorting-card="card-fixture">' + cardHtml(card) + '</div>';
    $('provisionalSortingPanel').classList.add('hidden');
    $('pendingSection').classList.add('hidden');
  } else {
    $('tabWinning').classList.remove('hidden');
    $('winningActive').innerHTML = '<article class="winning-card winning-product-row">' + winningCardHtml(item) + '</article>';
  }
  bindProductNames();
};
window.checkAlias = () => checkDisplayName();
window.prepareScrollList = () => {
  window.setFixture({ name:'スクロール確認商品', scale:1, count:123, view:'sorting' });
  const template = [...state.cards.values()][0];
  const cards = Array.from({length:20}, (_, index) => ({...template, id:'scroll-'+index, display_name:'商品 '+index}));
  state.cards = new Map(cards.map(card => [card.id, card]));
  renderSortingCards(cards); bindProductNames();
  const port = $('tabSorting'), anchor = document.querySelector('[data-sorting-card="scroll-10"]');
  port.scrollTop += anchor.getBoundingClientRect().top - port.getBoundingClientRect().top + 20;
};
window.removePriorCardAndShowNotice = () => {
  state.cards.delete('scroll-2'); renderSortingCards([...state.cards.values()]);
  setSortingNotice('arunomatic', '123件を仕分けました。残りの仕分けを続けられます。');
};
window.fixtureReady = true;
`;
const html = readFileSync(path.join(publicRoot, 'index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace('</body>', '<script type="module" src="/fixture.js"></script></body>');
const staticFiles = new Set(['styles.css', 'winning-view.js', 'winning-folders.js',
  'tiktok-video.js', 'analysis-amount.js', 'display-name.js']);

(async () => {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
    if (pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fixtureJs); }
    const name = pathname.slice(1);
    if (!staticFiles.has(name)) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript');
    res.end(readFileSync(path.join(publicRoot, name)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, checked = 0;
  try {
    browser = await chromium.launch({ headless:true,
      ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath:process.env.BROWSER_EXECUTABLE_PATH } : {}) });
    const names = ['短い商品名', '下記の対象商品の内いずれか一つをセブンイレブン店舗でご利用可能'.repeat(4),
      'W'.repeat(160), 'お茶🍵と家族👨‍👩‍👧‍👦のセット「<img src=x onerror=alert(1)>」'.repeat(8)];
    for (const width of [320, 360, 393, 412]) {
      const page = await browser.newPage({ viewport:{ width, height:850 }, isMobile:true, hasTouch:true });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('http://127.0.0.1:' + server.address().port);
      await page.waitForFunction(() => window.fixtureReady);
      for (const scale of [1, 1.5, 2]) for (const [index, name] of names.entries()) for (const view of ['sorting', 'winning']) {
        const scenario = { width, scale, view, nameIndex:index };
        await page.evaluate(input => window.setFixture(input), { name, scale, count:index < 2 ? 3 : 123456789, view });
        const port = view === 'sorting' ? '#tabSorting' : '#tabWinning';
        const metrics = await page.evaluate(port => {
          const root = document.querySelector(port), viewport = innerWidth;
          const selectors = '[data-name-scope],.coupon,.winning-product-row,.product-body,.product-controls,.card-actions,button';
          const bad = [...root.querySelectorAll(selectors)].filter(node => node.getClientRects().length).flatMap(node => {
            const box = node.getBoundingClientRect();
            return box.left < -1 || box.right > viewport + 1 ? [{ tag:node.tagName, cls:node.className, left:box.left, right:box.right }] : [];
          });
          const name = root.querySelector('[data-name-scope]'), box = name.getBoundingClientRect(), css = getComputedStyle(name);
          const buttons = [...root.querySelectorAll('.card-actions button,.product-actions button')].map(node => ({
            height:node.getBoundingClientRect().height, client:node.clientWidth, scroll:node.scrollWidth
          }));
          const actionRow = [...root.querySelectorAll('.card-actions button')].map(node => {
            const box = node.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(node);
            return { top:box.top, left:box.left, right:box.right, height:box.height, width:box.width,
              lines:range.getClientRects().length,
              action:['assignCard','deleteSorting','editSortingName','card'].find(key => key in node.dataset) || 'unexpected' };
          });
          const headerText = [...document.querySelectorAll('#app>header h1,#headerRevenue span,#headerRevenue strong')].map(node => {
            const range = document.createRange(); range.selectNodeContents(node);
            const box = range.getBoundingClientRect();
            return { text:node.textContent, left:box.left, right:box.right, top:box.top, bottom:box.bottom };
          });
          return { bad, portOverflow:root.scrollWidth - root.clientWidth,
            name:{ width:box.width, height:box.height, max:14 * parseFloat(css.fontSize), overflow:css.overflowX, ellipsis:css.textOverflow }, buttons, actionRow, headerText };
        }, port);
        assert.deepEqual(metrics.bad, [], JSON.stringify({ scenario, metrics }));
        assert(metrics.portOverflow <= 1, JSON.stringify({ scenario, metrics }));
        assert(metrics.name.width <= metrics.name.max + 1, JSON.stringify({ scenario, metrics }));
        assert(metrics.name.height >= 44, JSON.stringify({ scenario, metrics }));
        assert.equal(metrics.name.overflow, 'hidden'); assert.equal(metrics.name.ellipsis, 'ellipsis');
        for (const [position, text] of metrics.headerText.entries()) {
          assert(text.left >= -1 && text.right <= width + 1, JSON.stringify({ scenario, reason:'Header text must stay inside the viewport', text }));
          for (const other of metrics.headerText.slice(position + 1)) {
            const overlapWidth = Math.min(text.right, other.right) - Math.max(text.left, other.left);
            const overlapHeight = Math.min(text.bottom, other.bottom) - Math.max(text.top, other.top);
            assert(overlapWidth <= 1 || overlapHeight <= 1, JSON.stringify({ scenario, reason:'Header title and revenue must not overlap', text, other }));
          }
        }
        for (const button of metrics.buttons) {
          assert(button.height >= 44, JSON.stringify({ scenario, button }));
          assert(button.scroll <= button.client + 1, JSON.stringify({ scenario, button }));
        }
        if (view === 'sorting') {
          assert.deepEqual(metrics.actionRow.map(button => button.action), ['assignCard','deleteSorting','editSortingName','card'],
            'The card must expose exactly four actions in the agreed order');
          for (const [position, button] of metrics.actionRow.entries()) {
            assert(button.width >= 44, JSON.stringify({ scenario, reason:'Each sorting action needs a 44px-wide touch target at every text scale', button }));
            assert(Math.abs(button.top - metrics.actionRow[0].top) <= 1,
              JSON.stringify({ scenario, reason:'Sorting actions must stay on one row', actionRow:metrics.actionRow }));
            if (position) assert(button.left >= metrics.actionRow[position - 1].right,
              JSON.stringify({ scenario, reason:'Sorting actions must not overlap', actionRow:metrics.actionRow }));
            if (scale === 1) {
              assert.equal(button.lines, 1, JSON.stringify({ scenario, reason:'Normal-size short labels must not wrap', button }));
              assert(button.height <= 48, JSON.stringify({ scenario, reason:'Normal-size action row should stay compact', button }));
            }
          }
        }
        if (process.env.MOBILE_LAYOUT_SCREENSHOT_DIR && width === 393 && index === 1 && [1, 2].includes(scale)) {
          mkdirSync(process.env.MOBILE_LAYOUT_SCREENSHOT_DIR, { recursive:true });
          await page.screenshot({ path:path.join(process.env.MOBILE_LAYOUT_SCREENSHOT_DIR, `${view}-${width}-${scale}x.png`) });
        }
        const nameField = page.locator(port + ' [data-name-scope]');
        assert.equal(await nameField.textContent(), name);
        await nameField.scrollIntoViewIfNeeded();
        if (index % 2) { await nameField.focus(); await page.keyboard.press('Enter'); } else await nameField.tap();
        const detail = page.locator('#productNameDialog[open]');
        await detail.waitFor();
        const fullNames = await detail.locator('.product-name-detail span').allTextContents();
        assert.equal(fullNames[0], name); assert.equal(fullNames[1], name);
        assert.equal(await detail.locator('img').count(), 0, 'Markup-like text must remain plain text');
        assert(await detail.evaluate(node => {
          const box = node.getBoundingClientRect();
          return box.left >= 0 && box.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1;
        }), JSON.stringify(scenario));
        if (width === 320 && scale === 2 && index === 2) {
          await detail.locator('[data-name-edit]').click();
          const editor = page.locator('#displayNameDialog[open]');
          await editor.waitFor();
          await editor.locator('#displayNameInput').fill('W'.repeat(28));
          assert.equal(await page.evaluate(() => window.checkAlias()), true,
            'A valid 14-unit alias must be accepted even when its displayed glyphs need ellipsis');
          assert.equal(await editor.locator('#displayNameSave').isDisabled(), false);
          await editor.evaluate(node => node.close());
        } else await detail.locator('[data-name-close]').click();
        checked++;
      }
      await page.evaluate(() => window.prepareScrollList());
      const anchor = page.locator('[data-sorting-card="scroll-10"]');
      const before = (await anchor.boundingBox()).y;
      await page.evaluate(() => window.removePriorCardAndShowNotice());
      assert(Math.abs((await anchor.boundingBox()).y - before) <= 2,
        `The remaining visible card moved after earlier-card removal and success notice at ${width}px`);
      await page.evaluate(() => document.querySelector('[data-notice-dismiss]').click());
      assert(Math.abs((await anchor.boundingBox()).y - before) <= 2,
        `Dismissing the success notice moved the remaining card at ${width}px`);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log(`Mobile name layout: ${checked} scenarios plus 4 scroll-anchor scenarios passed (320/360/393/412px; 100/150/200% root text; long Japanese/ASCII/emoji; exact full text; keyboard and touch; four sorting actions on one row; action targets).`);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
