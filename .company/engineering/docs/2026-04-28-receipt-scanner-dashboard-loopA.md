# receipt-scanner Dashboard Loop A 設計書 (2026-04-28)

監査結果 `.company/engineering/docs/2026-04-28-receipt-scanner-dashboard-perf-audit.md` の優先度高/中の中から
**ROI が高く・低リスク・並列実装可能** な以下 4 項目を 1 ループで投入する。

---

## 概要

### 何を
- **#1** auto-refresh の visibility / focus ガード（タブ非アクティブ時にフェッチ停止）
- **#2** `/api/receipts` GET の signed URL を Vercel Function 内で **メモリ TTL キャッシュ**
- **#4** `SplitEditModal` を `lazy()` + `<Suspense>` 化（DashboardPage チャンク削減）
- **#5** 全 `<img>` に `loading="lazy"` / `decoding="async"` 付与

### なぜ
- 監査結果より「常時走るネットワーク I/O」と「毎回 50 件 sign する Supabase RTT」が残存ボトルネック。
- バンドル削減（#4）は副次効果。`<img>` 属性（#5）は 3 行レベルだが下スクロール時の体感を改善。
- React.memo 化（監査 #3 / #7 / #8）はリスクが大きいため **Loop B (Task #28)** に分離済み。

### 期待効果
| 指標 | 現状 | Loop A 後 |
|------|------|-----------|
| 非アクティブタブ時のリクエスト数 | 6 req/min | 0 req/min |
| GET /api/receipts レスポンス | 200〜400ms | 50〜100ms (warm) |
| DashboardPage チャンク | 37.3K | 推定 26〜29K |
| 初期画像 fetch | 50 件 | 視界内のみ (~10〜20 件) |

---

## 分割戦略

### 並列度: **3 並列 (A / B / C)**

| Engineer | 担当 | 対象ファイル | 競合 |
|---|---|---|---|
| A | #1 + #4 | `src/pages/dashboard/useReceipts.ts`、`src/pages/DashboardPage.tsx` | B/C と競合なし |
| B | #2 | `api/receipts.js` | A/C と競合なし |
| C | #5 | `src/pages/dashboard/ReceiptTableRow.tsx`、`src/pages/dashboard/ReceiptMobileCard.tsx`、`src/pages/dashboard/ImagePreviewModal.tsx` | A/B と競合なし |

### ファイル競合マトリクス

```
                useReceipts  DashboardPage  receipts.js  TableRow  MobileCard  PreviewModal
Engineer A           x             x
Engineer B                                       x
Engineer C                                                  x          x            x
```

完全に直交しており、**3 並列の完全並列実行が可能**。

### 依存関係
- なし（独立タスク × 3）。
- 統合時は Tech Lead が単純マージ → ローカル `npm run build` + 軽い手動確認のみ。

---

## Engineer A — visibility ガード + SplitEditModal lazy 化

### A-1. `useReceipts.ts` への visibility / focus ガード追加 (#1)

**対象ファイル:** `src/pages/dashboard/useReceipts.ts`

**現状（該当箇所）:**
```ts
useEffect(() => {
  timerRef.current = setInterval(() => {
    fetchReceipts(true);
    fetchTabCounts();
  }, AUTO_REFRESH_MS);
  return () => {
    if (timerRef.current) clearInterval(timerRef.current);
  };
}, [fetchReceipts, fetchTabCounts]);
```

**実装方針:**

1. **interval 内に `document.hidden` チェックを追加**
   - 隠れていれば fetch をスキップ。interval 自体は止めない（復帰時の再セットアップ不要・シンプル）。

2. **`visibilitychange` リスナで「非表示 → 表示」に戻った瞬間に即時 1 回 `refetchSilent` 相当を実行**
   - 直前の interval 同期分を埋める。

3. **`window.focus` イベントでも同じ refetch をトリガ**
   - 別ウィンドウから戻った時用。

4. **クリーンアップ漏れ防止（必須）:**
   - 同じ `useEffect` 内で `addEventListener` した `visibilitychange` / `focus` を **return クロージャで `removeEventListener`**。
   - 既存の `clearInterval` と並列で必ず両方解除する。
   - StrictMode の double-mount でリスナが二重登録されないこと（cleanup で解除されるので OK）。
   - 関数を `useCallback` 化せず useEffect 内ローカル関数で OK（依存配列に乗せる必要がない）。

5. **依存配列:**
   - `[fetchReceipts, fetchTabCounts]` のまま維持。両者とも既に `useCallback` 化されているため再生成は活性タブ／ページ変更時のみ。

**実装イメージ（参考・実装は Engineer A 自身で記述）:**
```ts
useEffect(() => {
  const tick = () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    fetchReceipts(true);
    fetchTabCounts();
  };
  const id = setInterval(tick, AUTO_REFRESH_MS);
  timerRef.current = id;

  const onVisible = () => {
    if (!document.hidden) {
      fetchReceipts(true);
      fetchTabCounts();
    }
  };
  const onFocus = () => {
    fetchReceipts(true);
    fetchTabCounts();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onFocus);

  return () => {
    clearInterval(id);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onFocus);
  };
}, [fetchReceipts, fetchTabCounts]);
```

**期待動作:**
- DevTools Network タブで「タブを別ウィンドウに切り替えると `/api/receipts` リクエストが完全停止」「タブ復帰直後に 1 回だけ発火」。
- `document.hidden` が true のまま `setInterval` は走り続けるが fetch は飛ばない（CPU 影響ほぼゼロ）。

---

### A-2. `SplitEditModal` を lazy + Suspense 化 (#4)

**対象ファイル:** `src/pages/DashboardPage.tsx`

**現状（該当箇所）:**
- L8: `import SplitEditModal from '../components/SplitEditModal';`
- L259-271: `{b.splitModalReceipt && (<SplitEditModal ... />)}`

**実装方針:**

1. `import` 文を削除し、ファイル冒頭で
   ```ts
   import React, { lazy, Suspense, useEffect } from 'react';
   const SplitEditModal = lazy(() => import('../components/SplitEditModal'));
   ```
2. 既存の `{b.splitModalReceipt && (...)}` ブロック全体を `<Suspense fallback={null}>` でラップ。
   - `fallback={null}` で OK（モーダルが開く瞬間に一瞬空白でも、SplitEditModal 自体の読み込みは数十 KB なので体感ほぼ無し）。
3. **型互換性:** 既存の `as React.ComponentProps<typeof SplitEditModal>['receipt']` キャストは `lazy` 経由でも `typeof SplitEditModal` から型解決される（React の `LazyExoticComponent<T>` は内部 props 型を保持）。動作するはずだが、tsc エラーが出たら `import type SplitEditModalT from '../components/SplitEditModal'` で型のみ static import し、`React.ComponentProps<typeof SplitEditModalT>` で型を取り直す。
4. **既存の機能は 100% 維持。**

**期待効果:**
- DashboardPage チャンクから SplitEditModal + 配下（`splitEdit/SplitEditFields`、`SplitTable`、`useSplitEditState`）が独立 chunk へ分離。
- 推定 8〜12K 削減。`npm run build` で確認可能。

---

## Engineer B — `/api/receipts` signed URL メモリキャッシュ (#2)

**対象ファイル:** `api/receipts.js`

**現状（該当箇所、L80-92）:**
```js
const dataWithUrls = await Promise.all(
  (data || []).map(async (receipt) => {
    let image_url = null;
    if (receipt.storage_path) {
      const { data: signedData } = await supabase.storage
        .from('receipts')
        .createSignedUrl(receipt.storage_path, 3600); // 1 hour
      image_url = signedData?.signedUrl || null;
    }
    return { ...receipt, image_url };
  })
);
```

### 実装方針

#### キャッシュ設計
- **データ構造:** `Map<storage_path: string, { url: string, expiresAt: number }>`
- **モジュールスコープのグローバル定数として** `api/receipts.js` の上部に配置。
  - Vercel Functions は **同一インスタンス再利用中、モジュール変数が保持される**（cold start 時のみ消える）。
  - 別インスタンス間で同期しなくても問題ない（個別インスタンスごとに最大 1 回ずつ sign するだけ）。
- **TTL:** signed URL の有効期限 3600 秒に対し、**キャッシュは 50 分（3000 秒）に設定**。
  - 残り 10 分の余裕を持って再発行 → クライアントが古い URL で fetch 開始しても確実に有効。
- **キャッシュキー:** `storage_path`（既に DB で一意）。
- **エビクション:** TTL 失効時に自然に再生成。明示削除は不要だが、暴走防止のため **`MAX_ENTRIES = 500`** を設定し、超えたら `Map` を作り直す（最古エントリ削除よりシンプル）。

#### 実装イメージ（参考）
```js
const SIGNED_URL_TTL_MS = 50 * 60 * 1000;  // 50 min
const SIGNED_URL_MAX_ENTRIES = 500;
let signedUrlCache = new Map();

function getCachedSignedUrl(storagePath) {
  const hit = signedUrlCache.get(storagePath);
  if (hit && hit.expiresAt > Date.now()) return hit.url;
  return null;
}

function setCachedSignedUrl(storagePath, url) {
  if (signedUrlCache.size >= SIGNED_URL_MAX_ENTRIES) {
    signedUrlCache = new Map();  // 暴走防止 (簡易)
  }
  signedUrlCache.set(storagePath, {
    url,
    expiresAt: Date.now() + SIGNED_URL_TTL_MS,
  });
}
```

#### `handleGet` 内の置換
```js
const dataWithUrls = await Promise.all(
  (data || []).map(async (receipt) => {
    let image_url = null;
    if (receipt.storage_path) {
      const cached = getCachedSignedUrl(receipt.storage_path);
      if (cached) {
        image_url = cached;
      } else {
        const { data: signedData } = await supabase.storage
          .from('receipts')
          .createSignedUrl(receipt.storage_path, 3600);
        if (signedData?.signedUrl) {
          image_url = signedData.signedUrl;
          setCachedSignedUrl(receipt.storage_path, image_url);
        }
      }
    }
    return { ...receipt, image_url };
  })
);
```

### 制約・注意

- **API レスポンス互換性:** `image_url` のフィールド名・型（string | null）は変わらない。値（URL）はキャッシュヒット中は同一値を返すが、フロントは URL 文字列をそのまま `<img src=>` に渡しているだけなので影響なし。
- **DELETE / PATCH との整合性:**
  - DELETE 後に `storage_path` が消えても、キャッシュに残った URL は最大 50 分で消える。**画像が削除されても URL は 1 時間有効** なので元々誰かが古い URL を持っていれば見える、という現実は同じ。新規発行 URL がレシート削除後に発行されることは無い（DB に行が無いため map ループに来ない）。
  - PATCH で `storage_path` 自体を更新するロジックは現状コードに存在しない（確認済）。
- **複数 Vercel インスタンス間の不整合:** 各インスタンスで独立にキャッシュするだけなので不整合は発生しない（同じ storage_path に対して別の signed URL を返してもクライアント挙動は同一）。
- **メモリ圧迫:** PAGE_LIMIT=50 想定 + ユーザー数からみて 500 エントリ上限で十分（実運用ではせいぜい数百件）。
- **副次効果:** counts モード (`?counts=1`) は signedUrl を生成しないため、このキャッシュ機構は影響しない。

### 期待動作
- 初回 GET: 50 件分 sign（warm 化）。
- 2 回目以降の auto-refresh: 全件キャッシュヒットで sign 呼び出しゼロ。
- 50 分経過後: 自然失効、次回 GET でまとめて再 sign。
- レスポンスタイム: 想定 200〜400ms → 50〜100ms（DB クエリのみが残る）。

---

## Engineer C — `<img>` 属性追加 (#5)

**対象ファイル（3 ファイル、各 1 行のみ）:**

| ファイル | 行 | 現状 |
|---|---|---|
| `src/pages/dashboard/ReceiptTableRow.tsx` | 205 | `<img src={r.image_url} alt="receipt" className="w-full h-full object-cover" />` |
| `src/pages/dashboard/ReceiptMobileCard.tsx` | 107 | `<img src={r.image_url} alt="receipt" className="w-full h-full object-cover" />` |
| `src/pages/dashboard/ImagePreviewModal.tsx` | 29 | `<img src={url} alt="receipt preview" className="max-w-full max-h-[85vh] object-contain" />` |

### 実装方針
- **TableRow / MobileCard（サムネ）:** `loading="lazy" decoding="async"` 両方付与。
- **ImagePreviewModal（モーダル大画像）:** `decoding="async"` のみ付与。
  - モーダル開いた瞬間に表示されるので `loading="lazy"` は付けない（無意味かつ一瞬のチラつき要因）。

### 期待動作
- スクロール外のサムネがブラウザによって遅延ロード。
- DevTools Network タブで「初期表示時の画像 fetch が視界内 (~10-20 件) のみ」「下スクロールで段階的に追加 fetch」。
- decode が並列化され、メインスレッドのスクロール jank が軽減。

### 制約
- 既存の `className`・`src`・`alt`・onClick 等の挙動は **完全に維持**。
- 属性追加のみ、行入れ替え・他の変更は禁止。

---

## 統合時の注意点（Tech Lead）

1. **マージ順序:**
   - 3 つは完全直交。順不同。
   - `git diff` で 3 ブランチ分の変更が正しく分離されていることを確認。

2. **ビルド検証 (必須):**
   - `cd receipt-scanner && npm run build`
   - tsc エラーなしを確認（特に Engineer A の `lazy(() => import(...))` の型解決）。
   - DashboardPage チャンクサイズが減少していることを確認:
     - 旧: `dist/assets/index-*.js` 中の DashboardPage chunk 約 37.3K
     - 新: 期待値 26〜29K + 別 chunk として SplitEditModal 系 8〜12K が独立
   - manualChunks 設定（`vite.config.ts`）は変更しない。

3. **手動確認チェックリスト:**
   - DevTools Network タブを開いた状態で:
     - [ ] DashboardPage 初期表示時、`/api/receipts` が 1 回呼ばれ、画像が視界内のみロード
     - [ ] 10 秒後の auto-refresh で `/api/receipts` が叩かれる
     - [ ] **タブを別ウィンドウに切り替える → 10〜20 秒待つ → `/api/receipts` リクエストが追加で発生していない**
     - [ ] **タブを戻すと `/api/receipts` が即時 1 回叩かれる**
     - [ ] 別ウィンドウから戻る (`window.focus`) でも 1 回叩かれる
     - [ ] レシート行の「分割編集」ボタンを押すとモーダル表示（lazy chunk が 1 回読まれる、2 回目以降は cache）
     - [ ] サムネイル画像クリックで ImagePreviewModal が表示
   - 監査 #2 のサーバ側キャッシュは Vercel デプロイ後に Network タブのレスポンスタイムで確認（ローカル `vercel dev` でも warm 後の差は出る）。

4. **回帰リスク:**
   - **Engineer A**: visibilitychange のリスナ漏れ → メモリリーク。Reviewer は cleanup の `removeEventListener` 2 件と `clearInterval` を必ず確認すること。
   - **Engineer B**: キャッシュ TTL のバグで永遠に古い URL を返す可能性 → `expiresAt > Date.now()` の比較演算子を念入りに review。
   - **Engineer C**: 単純属性追加のみ。リスクほぼゼロ。

5. **ロールバック容易性:**
   - 3 タスクとも局所変更。問題発生時は当該 1 ファイル revert で対応可能。

---

## 検証方法（最終承認時）

```bash
DIR=$(ls -1 ~/Documents | grep "個" | head -1) && cd ~/Documents/"$DIR"/newWorld/receipt-scanner

# 1. 型チェック・ビルド
npm run build 2>&1 | tail -50

# 2. チャンクサイズ確認
ls -lah dist/assets/*.js | sort -k5 -h

# 3. SplitEditModal が別 chunk になっているか
grep -l "SplitEditModal\|splitEdit" dist/assets/*.js | head -5

# 4. <img> 属性確認
grep -n "loading=\"lazy\"\|decoding=\"async\"" \
  src/pages/dashboard/ReceiptTableRow.tsx \
  src/pages/dashboard/ReceiptMobileCard.tsx \
  src/pages/dashboard/ImagePreviewModal.tsx

# 5. visibilitychange / focus リスナの確認
grep -n "visibilitychange\|window.addEventListener.*focus\|document.hidden" \
  src/pages/dashboard/useReceipts.ts

# 6. signed URL キャッシュの確認
grep -n "signedUrlCache\|SIGNED_URL_TTL_MS" api/receipts.js
```

---

## 想定 chunk size 変化（#4）

- **DashboardPage chunk:** 37.3K → 推定 26〜29K（SplitEditModal + splitEdit/* が分離）
- **新規 chunk:** SplitEditModal_*.js として 8〜12K 程度
- **総バンドルサイズ:** 変わらない（再配置のみ）。ただし「分割編集を使わないユーザーの初期 DL」が 8〜12K 削減。
- **react-vendor chunk:** 158K のまま（変更なし）。

---

## 注意事項（再掲）

- **機能 100% 維持。** UX 上の挙動変化は許容しない。
- **API レスポンス互換性:** `image_url` の値はキャッシュヒット中同一になるが、形式（string | null）・キー名は変わらない。
- **React.memo / rowProps useMemo は今回スコープ外** （Loop B / Task #28）。

---

## 並列実行可否

**完全並列実行可（A / B / C 同時並行で着手可能）。** ファイル競合ゼロ・ロジック依存ゼロ。

---

## チェックリスト（Tech Lead 最終承認）

- [ ] Engineer A: useReceipts.ts に `document.hidden` ガード追加
- [ ] Engineer A: visibilitychange / focus の addEventListener + cleanup の removeEventListener
- [ ] Engineer A: DashboardPage.tsx の SplitEditModal が `lazy()` + `<Suspense>`
- [ ] Engineer B: api/receipts.js にキャッシュ Map + TTL 50 min + MAX_ENTRIES 500
- [ ] Engineer B: handleGet 内で getCachedSignedUrl / setCachedSignedUrl 経由
- [ ] Engineer C: 3 ファイルの `<img>` に lazy/async 属性
- [ ] `npm run build` 成功・tsc エラーゼロ
- [ ] DashboardPage chunk が縮小・SplitEditModal が独立 chunk
- [ ] 手動確認: タブ非表示時 fetch 停止、復帰時即 fetch
