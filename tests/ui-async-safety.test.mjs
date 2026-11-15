import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const index = app.indexOf(start);
  assert.notEqual(index, -1);
  return app.slice(index, app.indexOf(end, index));
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(code, api) {
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { value: '', textContent: '', innerHTML: '', disabled: false, open: false,
        classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value),
          toggle(value, on) { if (on) classes.add(value); else classes.delete(value); } },
        showModal() { this.open = true; }, close() { this.open = false; },
        insertAdjacentHTML(where, html) { this.innerHTML += html; }
      });
    }
    return nodes.get(id);
  };
  const state = { campaigns: [], sortingSource: 'arunomatic', unresolvedItems: new Map([
    ['A', { value: 'https://coupon.test/A' }], ['B', { value: 'https://coupon.test/B' }]
  ]) };
  const context = { state, $, api, URLSearchParams, esc: value => value,
    document: { querySelectorAll: () => [] }, navigator: { clipboard: { writeText: async () => {} } },
    load: async () => {}, loadCampaigns: async () => {}, loadWinningLists: async () => {} };
  vm.createContext(context); vm.runInContext(code, context);
  return { context, $, state };
}
const imageCode = section('let imageAnalysisGeneration =', '\nfunction methodLabel(');
const closeCode = section('let closeGeneration =', '\nfunction openCorrection(');
const itemsCode = section('let itemsGeneration =', "$('settingsInspectUnexported').onclick");
const proposal = name => ({ productName: name, displayName: name, redeemPlace: 'ローソン', specification: '350ml', expiresOn: '2026-11-30' });
const preview = (count, mismatch = true) => ({ final_winner_count: count, final_product_winner_count: count - 1,
  winner_count_difference: 1, has_mismatch: mismatch, products: [] });

test('image result for A cannot populate or confirm B after switching the dialog', async () => {
  const gate = deferred(), calls = [];
  const { context: c, $, state } = harness(imageCode, async (path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return gate.promise; });
  c.openImageAnalysis('A'); state.couponImageData = 'image-A';
  const reading = c.analyzeSelectedImage();
  $('imageAnalysisDialog').close(); c.openImageAnalysis('B');
  gate.resolve({ itemId: 'A', proposal: proposal('Aの商品') }); await reading;
  assert.equal($('imageProductName').value, '');
  await c.confirmSelectedImage();
  assert.equal(calls.length, 1); assert.equal(state.imageAnalysisItemId, 'B');
});

test('only newest image response and matching item identity may be confirmed', async () => {
  const gates = [deferred(), deferred()], requests = [];
  const { context: c, $, state } = harness(imageCode, async (path, options) => {
    requests.push({ path, body: JSON.parse(options.body) });
    if (path.endsWith('image-analyze')) return gates[requests.filter(call => call.path.endsWith('image-analyze')).length - 1].promise;
    return {};
  });
  c.openImageAnalysis('A'); state.couponImageData = 'first'; const first = c.analyzeSelectedImage();
  state.couponImageData = 'second'; const second = c.analyzeSelectedImage();
  gates[1].resolve({ itemId: 'A', proposal: proposal('最新の商品') }); await second;
  gates[0].resolve({ itemId: 'A', proposal: proposal('古い商品') }); await first;
  assert.equal($('imageProductName').value, '最新の商品');
  await c.confirmSelectedImage();
  assert.equal(requests[2].path, '/api/unresolved/A/image-confirm');
  assert.equal(requests[2].body.product_name, '最新の商品');
});

test('image response with wrong itemId remains unconfirmable', async () => {
  let writes = 0;
  const { context: c, $, state } = harness(imageCode, async (path) => {
    if (path.endsWith('image-confirm')) writes++;
    return { itemId: 'B', proposal: proposal('別のURLの商品') };
  });
  c.openImageAnalysis('A'); state.couponImageData = 'image'; await c.analyzeSelectedImage(); await c.confirmSelectedImage();
  assert.equal(writes, 0); assert.match($('imageAnalysisMessage').textContent, /対象URL/);
});

test('completed image save cannot close a newly opened dialog and duplicate confirmation is blocked', async () => {
  const saving = deferred(); let writes = 0;
  const { context: c, $, state } = harness(imageCode, async path => {
    if (path.endsWith('image-analyze')) return { itemId: 'A', proposal: proposal('商品A') };
    writes++; return saving.promise;
  });
  c.openImageAnalysis('A'); state.couponImageData = 'image'; await c.analyzeSelectedImage();
  const first = c.confirmSelectedImage(); await c.confirmSelectedImage(); assert.equal(writes, 1);
  $('imageAnalysisDialog').close(); c.openImageAnalysis('B');
  saving.resolve({}); await first;
  assert.equal($('imageAnalysisDialog').open, true); assert.equal(state.imageAnalysisItemId, 'B');
});

test('old image conversion and clipboard responses are discarded after a new target opens', async () => {
  const converted = deferred(), pasted = deferred(); let requests = 0;
  const { context: c, $, state } = harness(imageCode, async () => { requests++; return {}; });
  c.imageToDataUri = () => converted.promise;
  c.openImageAnalysis('A'); const converting = c.setCouponImage({});
  $('imageAnalysisDialog').close(); c.openImageAnalysis('B');
  converted.resolve('old-image'); await converting;
  assert.equal(state.couponImageData, null); assert.equal(requests, 0);
  c.navigator.clipboard.read = () => pasted.promise;
  const pasting = c.pasteCouponImage();
  $('imageAnalysisDialog').close(); c.openImageAnalysis('A');
  pasted.resolve([{ types: ['image/png'], getType: async () => ({}) }]); await pasting;
  assert.equal(state.couponImageData, null); assert.equal(requests, 0);
});

test('close preview for A cannot replace B counts or mismatch approval', async () => {
  const a = deferred(), b = deferred(), writes = [];
  const { context: c, $, state } = harness(closeCode, async (path, options) => {
    if (options) { writes.push({ path, body: JSON.parse(options.body) }); return { delivery: { ok: true } }; }
    return path.includes('/A/') ? a.promise : b.promise;
  });
  const openingA = c.openClose('A'); $('closeDialog').close(); c.invalidateClosePreview();
  const openingB = c.openClose('B'); b.resolve(preview(200, false)); await openingB;
  a.resolve(preview(3, true)); await openingA;
  assert.equal(state.closePreview.final_winner_count, 200); assert.match($('closeTitle').textContent, /^B/);
  await c.confirmClose();
  assert.equal(writes[0].path, '/api/ledger/campaigns/B/close'); assert.equal(writes[0].body.accept_mismatch, false);
});

test('closed or loading close preview cannot be confirmed and late errors cannot alter newer dialog', async () => {
  const a = deferred(), b = deferred(); let writes = 0;
  const { context: c, $, state } = harness(closeCode, async (path, options) => {
    if (options) { writes++; return {}; }
    return path.includes('/A/') ? a.promise : b.promise;
  });
  const openingA = c.openClose('A'); await c.confirmClose(); assert.equal(writes, 0);
  $('closeDialog').close(); c.invalidateClosePreview();
  const openingB = c.openClose('B'); b.resolve(preview(8)); await openingB;
  a.reject(Error('古い要求のエラー')); await openingA;
  assert.equal($('closeMessage').textContent, ''); assert.equal(state.closePreview.final_winner_count, 8);
  $('closeDialog').close(); c.invalidateClosePreview(); await c.confirmClose(); assert.equal(writes, 0);
});

test('close completion keeps newer dialog open and rejects duplicate submission', async () => {
  const gate = deferred(); let writes = 0;
  const { context: c, $, state } = harness(closeCode, async (path, options) => {
    if (options) { writes++; return gate.promise; }
    return preview(path.includes('/A/') ? 3 : 10);
  });
  await c.openClose('A'); const saving = c.confirmClose(); await c.confirmClose(); assert.equal(writes, 1);
  $('closeDialog').close(); c.invalidateClosePreview(); await c.openClose('B');
  gate.resolve({ delivery: { ok: true } }); await saving;
  assert.equal($('closeDialog').open, true); assert.equal(state.closeCampaignId, 'B');
});

test('content response for A cannot append codes or cursor to B', async () => {
  const a = deferred(), b = deferred();
  const { context: c, $, state } = harness(itemsCode, async path => path.includes('/A/') ? a.promise : b.promise);
  const first = c.openItems('A', '商品A'); $('itemsDialog').close(); c.invalidateItems();
  const second = c.openItems('B', '商品B');
  b.resolve({ items: [{ value: 'B_CODE' }], nextCursor: 'B_CURSOR' }); await second;
  a.resolve({ items: [{ value: 'A_CODE' }], nextCursor: 'A_CURSOR' }); await first;
  assert.match($('itemList').innerHTML, /B_CODE/); assert.doesNotMatch($('itemList').innerHTML, /A_CODE/);
  assert.equal(state.cursor, 'B_CURSOR'); assert.equal(state.cardId, 'B');
});

test('content pagination cannot fetch the same page concurrently or render after close', async () => {
  const gate = deferred(); let calls = 0;
  const { context: c, $ } = harness(itemsCode, async () => { calls++; return gate.promise; });
  const opening = c.openItems('A', '商品A'); await c.loadItems(); assert.equal(calls, 1);
  assert.equal($('loadMore').disabled, true);
  $('itemsDialog').close(); c.invalidateItems();
  gate.resolve({ items: [{ value: 'STALE' }], nextCursor: null }); await opening;
  assert.equal($('itemList').innerHTML, '');
});
