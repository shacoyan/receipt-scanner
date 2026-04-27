# receipt-scanner Loop 6 — Bundle 最適化 + Supabase 集約 + lazy route 整備

作成日: 2026-04-27
担当: Tech Lead → Engineer A / B（並列）→ Reviewer 1名集約 → Tech Lead 統合+承認

---

## 1. 概要（何を・なぜ）

Loop 5 までで Confirm/SplitEdit 軽量化と freee ヘルパ集約が完了。Loop 6 は最終仕上げとして以下を実施する。

- **Bundle 最適化**: 現状 main chunk が 171.73 kB（gzip 56.73 kB）。`react-vendor` / `supabase-vendor` を `manualChunks` で分離し、初回ロードのキャッシュ効率を向上。
- **Supabase クライアント集約**: バックエンド 4 ファイル（`api/register.js` / `api/upload.js` / `api/receipts.js` / `api/process.js`）に同一の `getSupabase()` または inline `createClient` が散在。`api/lib/supabase.js` にシングルトン化。フロント側は `createClient` 利用なしを確認済（`src/` 全域ヒット 0 件）→ 集約対象は API のみ。
- **Lazy route 確認**: `src/App.tsx` で `DashboardPage` / `ApprovePage` は既に lazy 化済。`UploadPage` のみ eager（"/" の初回到達ページなので意図通り）。`PreloadLink` 等の追加最適化余地を Engineer A が判断。

### 目的
- 初回ロード TTI 短縮 + ベンダーキャッシュ分離による再訪問高速化
- API 側の Supabase 接続ロジックの DRY 化（環境変数取り扱いの一元管理 + 将来のオプション追加が 1 箇所で済む）
- Loop 7（構造化ログ）への準備として、共通モジュール集約パターンを完成させる

---

## 2. 現状把握（before）

### 2.1 ビルド結果（Loop 5 後 / 2026-04-27 時点）

```
dist/index.html                          0.40 kB │ gzip:  0.27 kB
dist/assets/index-Bo-zqoY-.css          24.84 kB │ gzip:  5.13 kB
dist/assets/ApprovePage-BwsJLxml.js      8.33 kB │ gzip:  3.02 kB
dist/assets/DashboardPage-dngmcNYH.js   36.69 kB │ gzip:  9.28 kB
dist/assets/index-DnnZXlDN.js          171.73 kB │ gzip: 56.73 kB
✓ 51 modules transformed / built in 1.64s
```

メイン chunk `index-*.js` 171.73 kB に React + ReactDOM + react-router-dom + UploadPage + 共通コンポーネントが同梱。

### 2.2 Supabase createClient 重複箇所

```
api/register.js:15-16   getSupabase() ヘルパ（async import 形式）
api/upload.js:16-17     handler 内で inline createClient
api/receipts.js:19-20   getSupabase() ヘルパ（async import 形式）
api/process.js:138-139  handler 内で inline createClient
```

合計 4 箇所。3 ファイルが `process.env.SUPABASE_URL` + `process.env.SUPABASE_SERVICE_ROLE_KEY` のサービスロール契約。フロント側は `src/` 全域で `createClient` 0 ヒット → API のみが対象。

### 2.3 src/App.tsx 構造

```tsx
import UploadPage from './pages/UploadPage';                       // eager（"/" 初回ページ）
const DashboardPage = lazy(() => import('./pages/DashboardPage')); // lazy 済
const ApprovePage   = lazy(() => import('./pages/ApprovePage'));   // lazy 済
```

→ lazy 化は既に概ね完了。`UploadPage` は意図的 eager（"/"= ホーム）。`CompletePage` は `pages/` に存在するが `App.tsx` ルート未登録（要確認）。

### 2.4 vite.config.ts 現状

```ts
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: true } } },
});
```

→ `build.rollupOptions` 未設定。`manualChunks` 追加でベンダー分離可能。

---

## 3. 期待される変化（after）

### 3.1 Bundle（推定）

| chunk | before | after（推定） | 備考 |
|---|---|---|---|
| react-vendor | （main 同梱） | ~140 kB / gzip ~45 kB | react + react-dom + react-router-dom |
| supabase-vendor | — | （フロントは未使用なので生成されない見込み） | 念のため設定だけ追加 |
| index（app shell） | 171.73 kB | ~30 kB / gzip ~10 kB | UploadPage + 共通 + main.tsx |
| DashboardPage | 36.69 kB | 36.69 kB（変化なし） | |
| ApprovePage | 8.33 kB | 8.33 kB（変化なし） | |

**初回ロード合計（gzip）**: 56.73 kB → 約 55 kB（ほぼ同等）。
**真のメリット**: vendor chunk が long-term cache される → 2 回目以降の訪問とアプリコード変更時の差分配信が劇的に改善。

### 3.2 API 側

`api/lib/supabase.js`（新規 ~25 行）に集約。各 API から `import { getSupabase } from './lib/supabase.js'` で 1 行呼び出しに統一。

---

## 4. 分割戦略

| チーム | 役割 | 並列度 | 依存 |
|---|---|---|---|
| Engineer A | vite.config.ts manualChunks + lazy route 確認 | 並列 | なし（フロントのみ） |
| Engineer B | Supabase クライアント集約（api/lib/supabase.js + 4 ファイル書き換え） | 並列 | なし（バックのみ） |

**競合リスク**: A はフロント（`vite.config.ts` / `src/App.tsx`）のみ、B はバック（`api/`）のみ → ファイル競合なし。完全並列可能。

---

## 5. チーム別タスク

### 5.1 Engineer A — Bundle 最適化 + lazy route 整備

#### 対象ファイル
- `vite.config.ts`（既存、編集）
- `src/App.tsx`（既存、必要に応じて編集）

#### 変更内容

**(1) vite.config.ts に manualChunks 追加**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'supabase-vendor': ['@supabase/supabase-js'],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
```

注意:
- `@supabase/supabase-js` をフロントが import していない場合、Vite は警告なしでこの chunk を空（未生成）にするのが通常挙動。`build.rollupOptions.output.manualChunks` の値はあくまで「もし import されたら」のヒント。
- `package.json` の `dependencies` に `@supabase/supabase-js` が含まれているか確認。含まれない場合は `'supabase-vendor'` 行を削除すること（Rollup が "Cannot find module" で落ちる可能性）。

**(2) lazy route 確認**

- `src/App.tsx` の現状（DashboardPage/ApprovePage が lazy、UploadPage が eager）は適切と判断。**変更不要**。
- `src/pages/CompletePage.tsx` が `App.tsx` のルートに登録されていないことを確認。もし未使用なら **削除はしない**（Loop 6 のスコープ外、報告のみ）。
- `PreloadLink` 等の追加導入は Loop 6 では行わない（YAGNI）。実測で 2nd page load が遅い問題が出た時点で再検討。

#### 期待動作
- `npm run build` 実行後、`dist/assets/` に `react-vendor-*.js` が生成される。
- `index-*.js`（app shell）が 30 kB 前後まで縮小。
- `npm run dev` で http://localhost:5173 起動 → "/"（UploadPage）/ "/dashboard" / "/approve" がすべて従来通り動作。

#### 検証コマンド
```bash
# ビルドサイズ確認
npm run build 2>&1 | tail -20

# 開発サーバ起動 + ルーティング動作確認
npm run dev
# → ブラウザで /, /dashboard, /approve を巡回し、コンソールエラーなしを確認
```

---

### 5.2 Engineer B — Supabase クライアント集約

#### 対象ファイル
- `api/lib/supabase.js`（**新規作成**）
- `api/register.js`（編集）
- `api/upload.js`（編集）
- `api/receipts.js`（編集）
- `api/process.js`（編集）

#### 変更内容

**(1) api/lib/supabase.js（新規）**

```js
// api/lib/supabase.js
// Supabase Service Role クライアントの共通生成ヘルパ
// 全 API ハンドラから import { getSupabase } で利用する

let _client = null;

/**
 * Service Role 権限の Supabase クライアントを取得（シングルトン）
 * @returns {Promise<import('@supabase/supabase-js').SupabaseClient>}
 */
export async function getSupabase() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Supabase env vars missing: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  }

  const { createClient } = await import('@supabase/supabase-js');
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}
```

ポイント:
- ESM / `await import()` パターン継続（Vercel Functions 互換）
- モジュールレベルのシングルトン（同一 invocation 内で接続再利用）
- env 欠落時に明示エラー（現状はサイレントに `undefined` で createClient 失敗していた）
- `auth.persistSession: false` を追加（サーバ側ではセッション永続不要）

**(2) api/register.js**

before:
```js
async function getSupabase() {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}
```

after: 上記関数を削除し、ファイル上部に追加:
```js
import { getSupabase } from './lib/supabase.js';
```
呼び出し箇所（`await getSupabase()`）はそのまま動作。

**(3) api/receipts.js**

`api/register.js` と同じ手順。`getSupabase` ローカル定義を削除し import 追加。

**(4) api/upload.js**

before:
```js
const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
```

after:
```js
const { getSupabase } = await import('./lib/supabase.js');
const supabase = await getSupabase();
```

または top-level import に格上げしても可（既存スタイルに合わせて判断）。

**(5) api/process.js**

`api/upload.js` と同じパターン。138-139 行目を上記 after と同様に置換。

#### 期待動作
- `grep -rn "createClient" api/` の結果が **`api/lib/supabase.js` の 1 箇所のみ** になる。
- 各 API エンドポイントの動作（receipts 一覧取得 / upload / process / register）が従来通り。
- 環境変数欠落時に明示的エラーメッセージが出る。

#### 検証コマンド
```bash
# 集約確認
grep -rn "createClient" api/
# 期待: api/lib/supabase.js:XX のみヒット

# 構文チェック（Vercel build がない場合）
node --check api/lib/supabase.js
node --check api/register.js
node --check api/upload.js
node --check api/receipts.js
node --check api/process.js

# ローカルサーバ起動（既存 dev-server.js 経由）で疎通確認
node api/dev-server.js &
curl http://localhost:3001/api/receipts | head -c 200
```

---

## 6. 統合時の注意点

1. **競合**: Engineer A は `vite.config.ts` / `src/App.tsx` のみ、Engineer B は `api/lib/supabase.js`（新規）+ `api/register.js` / `api/upload.js` / `api/receipts.js` / `api/process.js`。**ファイル競合なし**。
2. **dist/ 再生成**: A の作業後 `npm run build` を回し、`dist/` を再生成。`.gitignore` で `dist/` を除外している場合は commit 不要、含めている場合は古いバンドル削除 + 新規バンドル追加を 1 コミットに集約。
3. **package.json**: `@supabase/supabase-js` が dependencies にない場合、A の `'supabase-vendor'` 行は削除する。要確認事項として A に伝達済。
4. **環境変数**: Vercel 側の `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` は変更不要。新ヘルパは同じ env を読む。
5. **動作確認シナリオ**:
   - フロント: ブラウザで "/" → 領収書アップロード成功 → "/dashboard" 表示 → "/approve" でショートカット操作可能
   - バック: 既存 cron-job.org 経由の自動処理が継続動作（receipts 取得・登録）

---

## 7. 受入基準（Tech Lead 最終承認チェックリスト）

- [ ] `npm run build` 成功 + `react-vendor-*.js` chunk が生成されている
- [ ] `index-*.js`（app shell）が 50 kB 以下（gzip 20 kB 以下）に縮小
- [ ] `grep -rn "createClient" api/` が `api/lib/supabase.js` 1 件のみ
- [ ] `grep -rn "createClient" src/` は 0 件のまま（フロントは Supabase 直接利用なし）
- [ ] `node --check` が全 API ファイルで通る
- [ ] フロント 3 ルート（"/" / "/dashboard" / "/approve"）が動作
- [ ] 既存テスト（あれば）が通る
- [ ] git diff で意図しない変更（Loop 4/5 で作った dashboard/ / splitEdit/ / confirm/ 配下）が含まれていない

---

## 8. スコープ外（明示）

- 構造化ログ整備 → Loop 7
- `PreloadLink` / route prefetch の追加最適化 → 計測ベースで Loop 7 以降
- `CompletePage.tsx` の削除/利用 → 別チケット
- フロント側 Supabase 直接利用への移行 → 設計変更を伴うため別ロードマップ

---

## 9. ワークフロー

1. Tech Lead: 本設計書 commit
2. Engineer A / B: 並列実装（GLM 経由）→ 各自レポート
3. Reviewer（1名集約）: A/B 両方を確認 → approved or 差し戻し指示
4. Tech Lead: `git diff` 検査 + `npm run build` + `grep createClient` で受入基準チェック → 統合 commit + push（dual push: newWorld + receipt-scanner 専用リポジトリ）
