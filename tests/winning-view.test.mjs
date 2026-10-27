import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VIEW, normalizeView, attentionReasons, orderWinningItems, expiryDays, expiryLabel, matchesWinningItem, selectWinningItems } from '../public/winning-view.js';
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
test('標準は対応未抽出が多い順、同数はキャンペーン抽選開始日が新しい順、作業後は位置固定',()=>{
  const data=[
    product('old-many',{unexported_count:8,lottery_start_date:'2026-04-01'}),
    product('new-few',{unexported_count:3,lottery_start_date:'2026-10-01'}),
    product('new-many',{unexported_count:8,lottery_start_date:'2026-10-01'}),
    product('unset-zero',{output_method:'unset',unexported_count:0,unmatched_count:0,lottery_start_date:'2026-10-01'}),
  ];
  const first=orderWinningItems(data).map(p=>p.product_id);
  assert.deepEqual(first,['new-many','old-many','new-few','unset-zero']);
  const updated=data.map(p=>p.product_id==='new-many'?{...p,unexported_count:0}:p);
  assert.deepEqual(orderWinningItems(updated,first).map(p=>p.product_id),first);
  assert.deepEqual(orderWinningItems(updated,first,'recommended',true).map(p=>p.product_id),['old-many','new-few','new-many','unset-zero']);
  const next=orderWinningItems([...updated,product('new',{output_method:'unset',unexported_count:1,lottery_start_date:'2026-10-02'})],first);
  assert.equal(next.at(-1).product_id,'new');
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

test('手動終了を商品単位で区切り、CP状態や対応件数を変更せず通常へ戻せる',()=>{
 const a=product('a',{manual_finished:1,raw_unexported_count:108,output_method:'unset',unexported_count:0}),b=product('b',{campaign_status:'closing'}),c=product('c',{campaign_status:'closed',manual_finished:0});
 const before=structuredClone([a,b,c]);const selected=selectWinningItems([a,b,c],DEFAULT_VIEW);
 assert.deepEqual(selected.active.map(x=>x.product_id),['b']);assert.deepEqual(selected.closed.map(x=>x.product_id),['a','c']);
 assert.equal(selected.closedRawRemaining,108);assert.equal(selected.closedRemaining,0);assert.deepEqual([a,b,c],before);
 assert.deepEqual(selectWinningItems([{...a,manual_finished:0},b,c],DEFAULT_VIEW).active.map(x=>x.product_id),['a','b']);
});
