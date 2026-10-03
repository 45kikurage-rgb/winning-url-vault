-- One-off correction for the initial naming mistake on the Seven Premium tea product.
-- Keep IDs, URLs, counts and assignments unchanged. Only naming/match keys are corrected.
-- The guard intentionally fails unless exactly one product_master row matches.

CREATE TABLE IF NOT EXISTS _migration_0007_target (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  product_id TEXT NOT NULL UNIQUE
);
DELETE FROM _migration_0007_target;

INSERT INTO _migration_0007_target(singleton, product_id)
SELECT 1, id
FROM product_master
WHERE display_name = 'セブンプレミアム お茶 600ml 7種類から1つ'
  AND (
    raw_name = 'セブンプレミアム お茶 600ml 7種類から1つ(烏龍茶・むぎ茶・ジャスミン茶・ほうじ茶・緑茶・アールグレイ 無糖・ルイボスティー) / 600ml'
    OR normalized_name = 'セブンプレミアム お茶 600ml 7種類から1つ'
    OR normalized_name = 'セブンプレミアム お茶 600ml 7種類から1つ(烏龍茶・むぎ茶・ジャスミン茶・ほうじ茶・緑茶・アールグレイ 無糖・ルイボスティー)/600ml'
  );

-- Fail safely if the target is missing. More than one target fails above on the singleton PK.
INSERT INTO _migration_0007_target(singleton, product_id)
SELECT 0, '__missing__'
WHERE NOT EXISTS (SELECT 1 FROM _migration_0007_target);

UPDATE product_master
SET raw_name = 'セブンプレミアム お茶 600ml 7種類から1つ(烏龍茶・むぎ茶・ジャスミン茶・ほうじ茶・緑茶・アールグレイ 無糖・ルイボスティー) / 600ml',
    normalized_name = 'セブンプレミアム お茶 600ml 7種類から1つ(烏龍茶・むぎ茶・ジャスミン茶・ほうじ茶・緑茶・アールグレイ 無糖・ルイボスティー)/600ml',
    display_name = 'セブンプレミアム お茶 600ml 7種類から1つ',
    match_key = 'セブンプレミアム お茶 600ml 7種類から1つ(烏龍茶・むぎ茶・ジャスミン茶・ほうじ茶・緑茶・アールグレイ 無糖・ルイボスティー)/600ml'
      || char(31) || specification || char(31) || redeem_place || char(31) || required_conditions,
    updated_at = CURRENT_TIMESTAMP
WHERE id = (SELECT product_id FROM _migration_0007_target WHERE singleton = 1);

-- Existing campaign destinations also use a separate identity key for exact-match reuse.
UPDATE ledger_products
SET identity_key = (
      SELECT lower(pm.normalized_name) || char(31)
        || lower(pm.redeem_place) || char(31)
        || lower(pm.specification) || char(31)
        || lower(c.expires_on)
      FROM cards c
      JOIN product_master pm ON pm.id = c.product_id
      WHERE c.id = ledger_products.card_id
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE card_id IN (
  SELECT c.id
  FROM cards c
  WHERE c.product_id = (SELECT product_id FROM _migration_0007_target WHERE singleton = 1)
);

INSERT INTO audit_log(id, item_id, action, detail)
SELECT lower(hex(randomblob(16))), NULL, 'oneoff_product_name_correction',
       json_object(
         'product_id', product_id,
         'raw_name', 'セブンプレミアム お茶 600ml 7種類から1つ(烏龍茶・むぎ茶・ジャスミン茶・ほうじ茶・緑茶・アールグレイ 無糖・ルイボスティー) / 600ml',
         'normalized_name', 'セブンプレミアム お茶 600ml 7種類から1つ(烏龍茶・むぎ茶・ジャスミン茶・ほうじ茶・緑茶・アールグレイ 無糖・ルイボスティー)/600ml',
         'display_name', 'セブンプレミアム お茶 600ml 7種類から1つ'
       )
FROM _migration_0007_target
WHERE singleton = 1;

DROP TABLE _migration_0007_target;
