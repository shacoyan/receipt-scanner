-- 2026-06-27 receipt-scanner: 論理削除（ゴミ箱）対応
-- 適用対象 Supabase project: zzopayofegpmdkwckstq (receipt-scanner prod)
-- 🆘 適用前に必ず list_projects で name=receipt-scanner 確認
--    (kintai zjjbfffhbobwwxyvdszl と取り違え事故防止)
-- 冪等性: 再実行可能 (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)
-- 用途:
--   - receipts.deleted_at IS NULL  = 通常表示対象（アクティブ）
--   - receipts.deleted_at IS NOT NULL = ゴミ箱（論理削除済み・復元/完全削除の対象）
--   API 層 (Service Role) が deleted_at IS NULL 除外で可視性を制御する（RLS 非依存）。

BEGIN;

-- (1) 論理削除フラグ列。NULL = アクティブ。
ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN public.receipts.deleted_at IS
  '論理削除（ゴミ箱）時刻。NULL=アクティブ / NOT NULL=ゴミ箱。完全削除は別途 storage.remove + DELETE。';

-- (2) アクティブ行のホットパス用 部分INDEX
--     一覧/カウントの主クエリ = status フィルタ + created_at DESC ソート on アクティブ行。
CREATE INDEX IF NOT EXISTS idx_receipts_active
  ON public.receipts (status, created_at DESC)
  WHERE deleted_at IS NULL;

-- (3) ゴミ箱タブ用 部分INDEX（deleted_at DESC で新しく捨てた順）
CREATE INDEX IF NOT EXISTS idx_receipts_trash
  ON public.receipts (deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

COMMIT;

-- 確認クエリ (apply 後に手動 run):
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
--   WHERE table_name='receipts' AND column_name='deleted_at';
--   -- 期待: deleted_at | timestamp with time zone | YES
-- SELECT indexname FROM pg_indexes
--   WHERE tablename='receipts' AND indexname IN ('idx_receipts_active','idx_receipts_trash');
--   -- 期待: 2 行
-- SELECT count(*) FROM receipts WHERE deleted_at IS NOT NULL;  -- 初期 0
