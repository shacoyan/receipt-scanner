// 実行: node scripts/fetch-freee-account-items.mjs

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { freeeApiFetch } from '../api/lib/freee-auth.js';

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
  // .env が存在しない場合は無視
}

const { FREEE_ACCESS_TOKEN, FREEE_COMPANY_ID } = process.env;
if (!FREEE_ACCESS_TOKEN || !FREEE_COMPANY_ID) {
  console.error('必須環境変数が不足しています: FREEE_ACCESS_TOKEN, FREEE_COMPANY_ID');
  process.exit(1);
}

const outputDir = resolve(__dirname, 'output');
mkdirSync(outputDir, { recursive: true });

try {
  const res = await freeeApiFetch(
    `https://api.freee.co.jp/api/1/account_items?company_id=${FREEE_COMPANY_ID}`,
    {
      headers: {
        Authorization: `Bearer ${FREEE_ACCESS_TOKEN}`,
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    console.error(`HTTPエラー: ${res.status}`);
    console.error(body);
    process.exit(1);
  }

  const data = await res.json();
  const items = data.account_items || [];

  // (a) 仕入高・仕入系ハイライトセクション
  const shiireItems = items.filter(
    item => item.name.includes('仕入高') || item.name.includes('仕入')
  );

  console.log('=== 仕入高候補（name に「仕入」を含む） ===');
  shiireItems.forEach(item => {
    console.log(
      `  id=${item.id}  name=${item.name}  shortcut=${item.shortcut || '-'}  category=${item.account_category || '-'}  available=${item.available}`
    );
  });
  console.log('');

  // (b) 全件テーブル（日本語文字幅は考慮せず単純 padEnd で整形、ズレは許容）
  const idW = 10;
  const nameW = 30;
  const scW = 12;
  const catW = 20;
  const availW = 5;

  const header = `${'id'.padEnd(idW)} | ${'name'.padEnd(nameW)} | ${'shortcut'.padEnd(scW)} | ${'account_category'.padEnd(catW)} | ${'available'.padEnd(availW)}`;
  const sep = `${'-'.padEnd(idW, '-')}-+-${'-'.padEnd(nameW, '-')}-+-${'-'.padEnd(scW, '-')}-+-${'-'.padEnd(catW, '-')}-+-${'-'.padEnd(availW, '-')}`;

  console.log(header);
  console.log(sep);

  items.forEach(item => {
    const line = `${String(item.id).padEnd(idW)} | ${(item.name || '').padEnd(nameW)} | ${(item.shortcut || '-').padEnd(scW)} | ${(item.account_category || '-').padEnd(catW)} | ${String(item.available ?? '-').padEnd(availW)}`;
    console.log(line);
  });

  console.log('');
  console.log(`総件数: ${items.length}`);
  console.log(`仕入候補件数: ${shiireItems.length}`);

  // (c) JSONファイル保存
  writeFileSync(resolve(outputDir, 'account-items.json'), JSON.stringify(items, null, 2));
} catch (err) {
  console.error('エラーが発生しました:', err);
  process.exit(1);
}
