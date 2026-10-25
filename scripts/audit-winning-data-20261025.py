"""Read-only aggregate audit. Never selects coupon URLs/codes or auth data."""
import os,json,urllib.request,urllib.error,hashlib
from pathlib import Path
ACCOUNT='02100d2235d6f7d7f893b4217b58b902'
DB='1d3e496f-3d8c-49d7-892a-d32ea5661e0c'
queries={
'campaigns':"""SELECT c.campaign_id,c.campaign_name,c.status,c.is_archived,c.current_winner_count cached_count,c.final_winner_count,
 COUNT(DISTINCT p.product_id) product_count,
 COUNT(a.item_id) assigned_count,
 SUM(CASE WHEN i.status='active' THEN 1 ELSE 0 END) active_count,
 SUM(CASE WHEN i.status='active' AND p.is_archived=0 THEN 1 ELSE 0 END) visible_active_count,
 SUM(CASE WHEN i.status='used' THEN 1 ELSE 0 END) used_count,
 SUM(CASE WHEN i.status='active' AND p.is_archived=1 THEN 1 ELSE 0 END) archived_active_count
 FROM vault_campaigns c LEFT JOIN ledger_products p ON p.campaign_id=c.campaign_id
 LEFT JOIN item_campaign_assignments a ON a.product_id=p.product_id AND a.campaign_id=c.campaign_id
 LEFT JOIN items i ON i.id=a.item_id GROUP BY c.campaign_id ORDER BY c.lottery_start_date DESC,c.campaign_id""",
'products':"""SELECT p.product_id,p.campaign_id,c.campaign_name,c.status campaign_status,p.product_name,
 pm.display_name original_display_name,n.display_name saved_display_name,p.output_method,p.is_archived,p.unit_price,
 COUNT(a.item_id) assigned_count,
 SUM(CASE WHEN i.status='active' THEN 1 ELSE 0 END) active_count,
 SUM(CASE WHEN i.status='used' THEN 1 ELSE 0 END) used_count,
 SUM(CASE WHEN i.status='active' AND a.exported_at IS NOT NULL THEN 1 ELSE 0 END) exported_count,
 SUM(CASE WHEN i.status='active' AND a.exported_at IS NULL THEN 1 ELSE 0 END) raw_unexported_count,
 SUM(CASE WHEN i.status='active' AND a.exported_at IS NULL AND (
 p.output_method='text_single' OR (p.output_method='normal' AND i.value_type IN ('url','quocardpay')) OR
 (p.output_method='wallet' AND i.value LIKE 'https://%') OR
 (p.output_method='cokeon' AND i.value_type='cokeon') OR
 (p.output_method='paypay' AND i.value_type='paypay')) THEN 1 ELSE 0 END) compatible_unexported_count
 FROM ledger_products p LEFT JOIN vault_campaigns c ON c.campaign_id=p.campaign_id
 LEFT JOIN cards card ON card.id=p.card_id LEFT JOIN product_master pm ON pm.id=card.product_id
 LEFT JOIN ui_display_names n ON n.scope='winning' AND n.target_id=p.product_id
 LEFT JOIN item_campaign_assignments a ON a.product_id=p.product_id
 LEFT JOIN items i ON i.id=a.item_id GROUP BY p.product_id ORDER BY p.campaign_id,p.product_id""",
'item_states':"SELECT status,value_type,COUNT(*) count FROM items GROUP BY status,value_type ORDER BY status,value_type",
'card_states':"""SELECT c.id card_id,p.display_name,COUNT(i.id) active_count,
 SUM(CASE WHEN a.item_id IS NULL AND i.id IS NOT NULL THEN 1 ELSE 0 END) unassigned_count
 FROM cards c JOIN product_master p ON p.id=c.product_id
 LEFT JOIN items i ON i.card_id=c.id AND i.status='active'
 LEFT JOIN item_campaign_assignments a ON a.item_id=i.id GROUP BY c.id ORDER BY c.id""",
'integrity':"""SELECT 'assignment_without_item' check_name,COUNT(*) count FROM item_campaign_assignments a LEFT JOIN items i ON i.id=a.item_id WHERE i.id IS NULL
 UNION ALL SELECT 'assignment_without_product',COUNT(*) FROM item_campaign_assignments a LEFT JOIN ledger_products p ON p.product_id=a.product_id WHERE p.product_id IS NULL
 UNION ALL SELECT 'assignment_campaign_mismatch',COUNT(*) FROM item_campaign_assignments a JOIN ledger_products p ON p.product_id=a.product_id WHERE a.campaign_id<>p.campaign_id
 UNION ALL SELECT 'product_without_campaign',COUNT(*) FROM ledger_products p LEFT JOIN vault_campaigns c ON c.campaign_id=p.campaign_id WHERE c.campaign_id IS NULL
 UNION ALL SELECT 'item_card_mismatch',COUNT(*) FROM item_campaign_assignments a JOIN items i ON i.id=a.item_id JOIN ledger_products p ON p.product_id=a.product_id WHERE i.card_id IS NOT p.card_id
 UNION ALL SELECT 'active_item_without_card',COUNT(*) FROM items WHERE status='active' AND card_id IS NULL
 UNION ALL SELECT 'pending_groups',COUNT(*) FROM pending_confirmations
 UNION ALL SELECT 'unresolved_rows',COUNT(*) FROM unresolved_items""",
'outbox':"SELECT status,COUNT(*) count FROM ledger_outbox GROUP BY status",
'revenue':"""SELECT month,COUNT(*) product_rows,SUM(winner_count) winner_count,
 SUM(CASE WHEN unit_price IS NULL THEN winner_count ELSE 0 END) unpriced_winner_count,
 SUM(CASE WHEN unit_price IS NULL THEN 1 ELSE 0 END) unpriced_products,
 SUM(COALESCE(amount,0)) amount,
 SUM(CASE WHEN unit_price IS NOT NULL AND amount<>winner_count*unit_price THEN 1 ELSE 0 END) arithmetic_mismatch,
 SUM(CASE WHEN finalized_at IS NOT NULL THEN 1 ELSE 0 END) finalized_products
 FROM product_monthly_revenue GROUP BY month ORDER BY month""",
'winning_item_types':"""SELECT a.product_id,i.value_type,COUNT(*) active_count
 FROM item_campaign_assignments a JOIN items i ON i.id=a.item_id AND i.status='active'
 JOIN ledger_products p ON p.product_id=a.product_id WHERE p.is_archived=0
 GROUP BY a.product_id,i.value_type ORDER BY a.product_id,i.value_type"""
}
result={}
for name,sql in queries.items():
    assert sql.lstrip().upper().startswith('SELECT ') and ';' not in sql
    req=urllib.request.Request(f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{DB}/query',data=json.dumps({'sql':sql}).encode(),headers={'Authorization':'Bearer '+os.environ['CLOUDFLARE_API_TOKEN'],'Content-Type':'application/json','User-Agent':'ARUNO-ReadOnly-Data-Audit'})
    try:
        with urllib.request.urlopen(req,timeout=45) as r:payload=json.load(r)
    except urllib.error.HTTPError as e:
        try:errors=json.load(e).get('errors',[])
        except Exception:errors=[]
        result[name]={'error':'CF_HTTP_'+str(e.code),'details':[{'code':x.get('code'),'message':str(x.get('message',''))[:240]} for x in errors]}
        print('Audit query failed:',name,json.dumps(result[name]))
        continue
    assert payload.get('success') is True,'CF_QUERY_FAILED'
    row=payload['result'][0];assert row.get('success') is True,'D1_QUERY_FAILED'
    result[name]={'rows':row.get('results',[]),'rows_read':row.get('meta',{}).get('rows_read')}
Path('audit-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print('Read-only aggregate audit completed:',len(queries),'SELECT queries. Coupon values and auth data were not selected.')
