-- 機能追加: freee 側 deal の tax_code 修正完了時刻を記録する列を追加
-- 用途: scripts/fix-freee-tax-codes.mjs (137→163 一括修正) の冪等性確保用フラグ
-- 冪等性: 再実行可能 (IF NOT EXISTS)

BEGIN;

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS freee_corrected_at timestamptz;

COMMENT ON COLUMN receipts.freee_corrected_at IS 'freee 側 deal の tax_code 修正完了時刻 (scripts/fix-freee-tax-codes.mjs)';

COMMIT;

-- 確認クエリ (apply 後に手動で run):
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'receipts' AND column_name = 'freee_corrected_at';
-- 期待: freee_corrected_at | timestamp with time zone | YES
--
-- SELECT COUNT(*) FROM receipts WHERE freee_corrected_at IS NOT NULL; -- 0 (初期)
-- 全件修正後: 51 期待
