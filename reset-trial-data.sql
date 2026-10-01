PRAGMA foreign_keys = ON;

-- 試用期間中に受信したURL・未確定情報・操作履歴だけを削除します。
-- 確認済みの商品マスターとカード定義は残るため、正式運用で自動振り分けを継続できます。
-- 中央台帳へ仕分け済みのURLがある場合は、同期履歴を壊さないよう全体を中止します。
CREATE TEMP TABLE trial_reset_guard (ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO trial_reset_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM item_campaign_assignments) THEN 0 ELSE 1 END;
DELETE FROM unresolved_items;
DELETE FROM audit_log;
DELETE FROM analysis_staging;
DELETE FROM analysis_job_items;
DELETE FROM analysis_jobs;
DELETE FROM items;
DELETE FROM pending_confirmations;
DELETE FROM auth_rate_limits;
DROP TABLE trial_reset_guard;
