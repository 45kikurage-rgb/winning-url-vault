import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VIEW, normalizeView, attentionReasons, recommendedRank, orderWinningItems, expiryDays, expiryLabel, matchesWinningItem, selectWinningItems } from '../public/winning-view.js';
const product = (product_id, extra={}) => ({product_id,display_name:product_id,output_method:'normal',campaign_status:'active',unit_price:100,total_count:17,exported_count:12,unexported_count:0,unmatched_count:5,...extra});

test('対応未抽出0と終了を分離し、APIの独立集計を変更しない',()=>{
  const active=product('a'), closed=product('b',{campaign_status:'closed',unexported_count:3}), unknown=product('c',{campaign_status:null});
  const data=[active,closed,unknown], before=structuredClone(data);
  const result=selectWinningItems(data,DEFAULT_VIEW);
  assert.deepEqual(result.active.map(p=>p.product_id),['a','c']);
  assert.deepEqual(result.closed.map(p=>p.product_id),['b']);
  assert.equal(result.closedRemaining,3);
  assert.deepEqual(data,before);
  assert.equal(active.exported_count,12);
  assert.equal(attentionReasons(active).includes('対象外 5件'),true);
  assert.equal(attentionReasons(unknown).includes('状態未取得'),true);
});
test('終了全体の残数は月・検索の絞り込みで消えない',()=>{
  const data=[product('a',{campaign_status:'closed',campaign_name:'春のCP',lottery_start_date:'2026-04-01',unexported_count:4}),product('b',{campaign_status:'closed',campaign_name:'秋のCP',lottery_start_date:'2026-10-01',unexported_count:7})];
  const result=selectWinningItems(data,{...DEFAULT_VIEW,query:'春',month:'2026-04'});
  assert.equal(result.closedCount,2); assert.equal(result.closedRemaining,11);
  assert.equal(result.filteredClosedRemaining,4); assert.equal(result.closed.length,1);
});
test('要確認は理由を明示し、0円を単価未設定にしない',()=>{
  assert.deepEqual(attentionReasons(product('a',{unit_price:0,unmatched_count:0})),[]);
  for(const state of ['closing','correcting',null]) assert.ok(attentionReasons(product('a',{campaign_status:state})).length);
  assert.ok(attentionReasons(product('a',{output_method:'unset'})).includes('方式未設定'));
  assert.ok(attentionReasons(product('a',{unit_price:null})).includes('単価未設定'));
});
test('初回は方式未設定→対応未抽出→要確認の0件→その他、作業後は位置固定',()=>{
  const data=[product('done',{unmatched_count:0}),product('attention'),product('remaining',{unexported_count:8}),product('unset',{output_method:'unset'})];
  const first=orderWinningItems(data).map(p=>p.product_id);
  assert.deepEqual(first,['unset','remaining','attention','done']);
  const updated=data.map(p=>p.product_id==='remaining'?{...p,unexported_count:0,unmatched_count:0}:p);
  assert.deepEqual(orderWinningItems(updated,first).map(p=>p.product_id),first);
  assert.deepEqual(orderWinningItems(updated,first,'recommended',true).map(p=>p.product_id),['unset','attention','done','remaining']);
  const next=orderWinningItems([...updated,product('new',{output_method:'unset'})],first);
  assert.equal(next.at(-1).product_id,'new');
  assert.equal(recommendedRank(product('x',{unexported_count:0})),2);
});
test('標準期限は日付のみ、不明を期限なしと断定しない。JSTの任意フィルター',()=>{
  const now=new Date('2026-10-24T16:00:00Z');
  assert.equal(expiryLabel(product('a',{valid_until:null})),'期限未取得');
  assert.equal(expiryLabel(product('a',{valid_until:'2026-10-25'})),'期限 2026-10-25');
  assert.equal(expiryDays(product('a',{valid_until:'2026-10-25'}),now),0);
  assert.equal(expiryLabel(product('a',{valid_until:'2026-10-25'}),true,now),'期限 2026-10-25（本日）');
  for(const date of ['2026-10-24','2026-11-01']) assert.ok(matchesWinningItem(product('a',{valid_until:date}),{...DEFAULT_VIEW,status:'due'},now));
  for(const date of [null,'2026-11-02']) assert.equal(matchesWinningItem(product('a',{valid_until:date}),{...DEFAULT_VIEW,status:'due'},now),false);
});
test('キャンペーン名・商品・規格・引換先をAND検索し、別商品を合算しない',()=>{
  const item=product('a',{campaign_name:'ＣＰ秋',product_spec:'500ml',redemption_place:'ローソン'});
  assert.ok(matchesWinningItem(item,{...DEFAULT_VIEW,query:'cp秋 500 ローソン'}));
  assert.equal(matchesWinningItem(item,{...DEFAULT_VIEW,query:'cp秋 セブン'}),false);
  assert.equal(selectWinningItems([item,{...item,product_id:'b'}],DEFAULT_VIEW).active.length,2);
});
test('壊れた保存値を既定へ戻し、認めた表示設定だけを採用する',()=>{
  for(const value of [null,[],42,'invalid']) assert.deepEqual(normalizeView(value),DEFAULT_VIEW);
  assert.deepEqual(normalizeView({sort:'DROP',status:'complete',showCampaign:'false',relativeDates:true,unexpected:'x'}),{...DEFAULT_VIEW,relativeDates:true});
});
