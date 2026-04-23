// scripts/renormalize-stores.mjs
// done レコードの result_json.store を v6 正規化ルールで再計算する one-shot スクリプト。
// - デフォルトは dry-run（差分一覧を出力のみ）
// - --apply フラグで UPDATE を実行
// 使い方:
//   node scripts/renormalize-stores.mjs            # dry-run
//   node scripts/renormalize-stores.mjs --apply    # 適用
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { normalizeStoreName } from '../api/process.js';

const APPLY = process.argv.includes('--apply');
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('ENV missing: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(url, key);

async function main() {
  const { data, error } = await supabase
    .from('receipts')
    .select('id, result_json')
    .eq('status', 'done');
  if (error) throw error;

  const rows = data || [];
  const diffs = [];
  for (const row of rows) {
    const old = row.result_json?.store;
    if (!old) continue;
    const next = normalizeStoreName(old);
    if (next !== old) {
      diffs.push({
        id: row.id,
        old,
        next,
        result_json: { ...row.result_json, store: next },
      });
    }
  }

  console.log(`対象: ${rows.length} 件 / 変更: ${diffs.length} 件`);
  for (const d of diffs) {
    console.log(`  [${d.id}] "${d.old}" → "${d.next}"`);
  }

  if (!APPLY) {
    console.log('\ndry-run モード。--apply で実行します。');
    return;
  }

  let ok = 0;
  let ng = 0;
  for (const d of diffs) {
    const { error: e } = await supabase
      .from('receipts')
      .update({ result_json: d.result_json })
      .eq('id', d.id);
    if (e) {
      ng++;
      console.error(d.id, e.message);
    } else {
      ok++;
    }
  }
  console.log(`\n適用完了: 成功 ${ok} / 失敗 ${ng}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
