PRAGMA foreign_keys = ON;

-- 試用期間中に受信したURL・未確定情報・操作履歴だけを削除します。
-- 確認済みの商品マスターとカード定義は残るため、正式運用で自動振り分けを継続できます。
DELETE FROM unresolved_items;
DELETE FROM audit_log;
DELETE FROM analysis_staging;
DELETE FROM analysis_job_items;
DELETE FROM analysis_jobs;
DELETE FROM items;
DELETE FROM pending_confirmations;
DELETE FROM auth_rate_limits;
