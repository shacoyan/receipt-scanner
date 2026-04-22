// 実行: node scripts/reset-receipts-to-pending.mjs [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--category=XXX] [--status=done,approved,error] [--dry-run]
// 用途: receipts テーブルの指定レコードを status='pending', result_json=null, error_message=null に戻し、
//       既存 api/process.js (cron) に再解析させるためのローカル運用スクリプト。
// 注意: SUPABASE_SERVICE_ROLE_KEY を使うためローカル実行専用。Vercel にはデプロイしない。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envPath = resolve(__dirname, '../.env');

try {
  const envContent = readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) return;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
} catch {
  // .env が存在しない場合は無視（プロセス環境変数のみ利用）
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('必須環境変数が不足しています: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function parseArgs(argv) {
  const args = { from: null, to: null, category: null, statuses: [], dryRun: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--from=')) {
      args.from = arg.split('=')[1];
    } else if (arg.startsWith('--to=')) {
      args.to = arg.split('=')[1];
    } else if (arg.startsWith('--category=')) {
      args.category = arg.split('=')[1];
    } else if (arg.startsWith('--status=')) {
      args.statuses = arg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  return args;
}

function askConfirmation(question) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function applyFilters(query, args) {
  if (args.from) {
    query = query.gte('created_at', `${args.from}T00:00:00Z`);
  }
  if (args.to) {
    query = query.lte('created_at', `${args.to}T23:59:59.999Z`);
  }
  if (args.category) {
    query = query.eq('result_json->>category', args.category);
  }
  if (args.statuses.length > 0) {
    query = query.in('status', args.statuses);
  }
  return query;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log('フィルタ条件:');
  console.log(`  from:     ${args.from || '(指定なし)'}`);
  console.log(`  to:       ${args.to || '(指定なし)'}`);
  console.log(`  category: ${args.category || '(指定なし)'}`);
  console.log(`  status:   ${args.statuses.length > 0 ? args.statuses.join(',') : '(全status)'}`);
  console.log(`  dry-run:  ${args.dryRun}`);
  console.log('');

  let countQuery = supabase
    .from('receipts')
    .select('id', { count: 'exact', head: true });
  countQuery = applyFilters(countQuery, args);

  const { count, error: countError } = await countQuery;

  if (countError) {
    console.error('対象件数の取得に失敗しました:', countError.message);
    process.exit(1);
  }

  if (!count || count === 0) {
    console.log('対象件数: 0件');
    console.log('処理を終了します。');
    process.exit(0);
  }

  console.log(`対象件数: ${count}件`);

  if (args.dryRun) {
    console.log('--dry-run モードのため、DB変更は行いません。');
    process.exit(0);
  }

  const answer = await askConfirmation(`${count}件を pending にリセットします。続行しますか？ [y/N]: `);
  if (answer !== 'y' && answer !== 'yes') {
    console.log('中止しました。');
    process.exit(0);
  }

  let updateQuery = supabase
    .from('receipts')
    .update({
      status: 'pending',
      result_json: null,
      error_message: null,
    }, { count: 'exact' });
  updateQuery = applyFilters(updateQuery, args);
  updateQuery = updateQuery.not('id', 'is', null);

  const { error: updateError, count: updatedCount } = await updateQuery;

  if (updateError) {
    console.error('更新に失敗しました:', updateError.message);
    process.exit(1);
  }

  console.log(`更新完了: ${updatedCount !== null ? updatedCount : count}件を pending にリセットしました。`);
  console.log('次回の cron 実行 (api/process.js) で順次再解析されます。');
}

main();
