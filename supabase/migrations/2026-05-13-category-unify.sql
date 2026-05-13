-- 2026-05-13 receipt-scanner Loop 4: 接待交際費・会議費 → 交際費 統合
-- 適用対象 Supabase project: zzopayofegpmdkwckstq (receipt-scanner prod)
-- 🆘 適用前に必ず list_projects で name 確認 (kintai zjjbfffhbobwwxyvdszl と取り違え事故防止)

BEGIN;

-- (1) result_json.category 直値置換
UPDATE receipts
SET result_json = jsonb_set(
  result_json,
  '{category}',
  to_jsonb('交際費'::text)
)
WHERE result_json->>'category' IN ('接待交際費', '会議費');

-- (2) result_json.splits[].category 要素単位置換
UPDATE receipts
SET result_json = jsonb_set(
  result_json,
  '{splits}',
  COALESCE(
    (
      SELECT jsonb_agg(
        CASE
          WHEN elem->>'category' IN ('接待交際費', '会議費')
          THEN jsonb_set(elem, '{category}', to_jsonb('交際費'::text))
          ELSE elem
        END
      )
      FROM jsonb_array_elements(result_json->'splits') elem
    ),
    result_json->'splits'
  )
)
WHERE result_json ? 'splits'
  AND result_json->'splits' @? '$[*] ? (@.category == "接待交際費" || @.category == "会議費")';

-- 件数集計 (apply 前後で実行可能)
-- SELECT count(*) FROM receipts WHERE result_json->>'category' IN ('接待交際費', '会議費');
-- SELECT count(*) FROM receipts WHERE result_json->'splits' @? '$[*] ? (@.category == "接待交際費" || @.category == "会議費")';

COMMIT;
