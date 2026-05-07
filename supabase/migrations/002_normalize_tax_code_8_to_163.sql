-- Bug ④: tax_code 137 (誤想定: 課対仕入8%軽) を freee 真値 163 に統一
-- 137 = 非対仕入10% (誤) / 163 = 課対仕入8%（軽）(正)
-- 冪等性: 再実行可能 (UPDATE WHERE tax_code = 137 のみ)

BEGIN;

-- 単一 tax_code 137 を 163 に
UPDATE receipts
SET result_json = jsonb_set(result_json, '{tax_code}', '163'::jsonb)
WHERE result_json->>'tax_code' = '137';

-- splits 配列内の tax_code 137 を 163 に
-- jsonb_path_query_array は使えないので、要素ごとに jsonb_set でループ
UPDATE receipts
SET result_json = jsonb_set(
  result_json,
  '{splits}',
  COALESCE(
    (
      SELECT jsonb_agg(
        CASE
          WHEN (split->>'tax_code')::int = 137
          THEN jsonb_set(split, '{tax_code}', '163'::jsonb)
          ELSE split
        END
      )
      FROM jsonb_array_elements(result_json->'splits') AS split
    ),
    result_json->'splits'
  )
)
WHERE result_json->'splits' @> '[{"tax_code":137}]'::jsonb;

COMMIT;

-- 確認クエリ (apply 後に手動で run):
-- SELECT COUNT(*) FROM receipts WHERE result_json->>'tax_code' = '137'; -- 0
-- SELECT COUNT(*) FROM receipts WHERE result_json->'splits' @> '[{"tax_code":137}]'::jsonb; -- 0
-- SELECT COUNT(*) FROM receipts WHERE result_json->>'tax_code' = '163' OR result_json->'splits' @> '[{"tax_code":163}]'::jsonb; -- 65
