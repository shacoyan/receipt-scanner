# Loop 5: ConfirmPage / SplitEditModal 軽量化 + freee ヘルパ抽出

- 作成日: 2026-04-27
- プロジェクト: receipt-scanner
- 担当: Tech Lead 設計 → Engineer A/B/C 並列 → Reviewer 集約 → Tech Lead 統合 + 承認
- 関連: Loop 2 (共通型抽出 / `src/types/receipt.ts`), Loop 3 (`api/lib/prompt.js` 切り出し), Loop 4 (`src/pages/dashboard/` 分割パターン + `useReceipts` / `useBulkActions`)

---

## 1. 概要

### 何を
- `src/pages/ConfirmPage.tsx` (512 行) を子コンポーネント + ハンドラフックに分割して 200 行未満に圧縮。
- `src/components/SplitEditModal.tsx` (446 行) を子コンポーネント + ハンドラフックに分割し、`result_json` のインライン型を `src/types/receipt.ts` に統合。
- `api/register.js` (365 行) の freee API 呼び出し (partner 検索/作成 / receipt アップロード / deal 作成 / supabase 反映) を `api/lib/freee.js` (新規) に抽出して、ハンドラ本体をビジネスロジック (バリデーション + オーケストレーション) に専念させる。

### なぜ
- Loop 4 で実装した「ページ → サブディレクトリ + 子コンポーネント + フック」パターンを、残る大物 (ConfirmPage / SplitEditModal) にも適用し、ファイル単位の責務を明確化。
- freee 関連のインライン処理が register.js 内で 200 行以上を占め、今後の処理 (再送 / リトライ / receipts.js からの呼び出し) が来るたびにコピペが発生する。先んじてヘルパ化する。
- Loop 2 で残した `SplitEditModal` インライン型 (`receipt.result_json` の独自定義) を共通型に寄せ、`Receipt['result_json']` (= `ReceiptResult | null`) に揃える。

### スコープ外
- 機能追加なし (純粋なリファクタ)。UI 上の挙動・freee API 呼び出しの順序・ペイロードは 1 byte も変えない。
- Loop 6 で扱う bundle 最適化 / lazy route / supabase 集約は対象外。
- `process.js` / `receipts.js` 側からの freee ヘルパ利用は今回は呼び出しを変更せず「将来の入口を作る」のみ (= ヘルパ実装のみ。call site は register.js のみ)。

---

## 2. 分割戦略

| Engineer | 担当 | 対象ファイル | 想定 LOC 増減 |
|---|---|---|---|
| A | ConfirmPage 軽量化 + 子コンポーネント抽出 + ハンドラフック化 | `src/pages/ConfirmPage.tsx` + `src/pages/confirm/*` (新規) | -350 行 (ConfirmPage 本体) / +新規 4 ファイル |
| B | SplitEditModal 軽量化 + `result_json` 型整理 + 子コンポーネント抽出 | `src/components/SplitEditModal.tsx` + `src/components/splitEdit/*` (新規) + `src/types/receipt.ts` (型追加) | -300 行 (本体) / +新規 3 ファイル / +1 型 |
| C | freee ヘルパ抽出 | `api/register.js` (差し替え) + `api/lib/freee.js` (新規) | -180 行 (register.js) / +1 ファイル |

### 並列度
- 完全並列 (A/B/C 間の干渉ゼロ)。
  - A: `src/pages/ConfirmPage.tsx` と新規 `src/pages/confirm/`
  - B: `src/components/SplitEditModal.tsx`、新規 `src/components/splitEdit/`、`src/types/receipt.ts`
  - C: `api/register.js` と新規 `api/lib/freee.js`
- B のみ `src/types/receipt.ts` に追記する。型追加は **末尾 export 追加のみ** で既存 export 行は触らないこと。A は新規型を import するのみで、B より後にマージしても破綻しないよう「既存型のみで実装可、B が追加した型は B 内部のみで使う」設計とする。
- C は別ディレクトリ (`api/`) なので完全独立。

### 依存関係
- A ⊥ B ⊥ C (相互独立)。
- 統合順は A → B → C のいずれでも構わない。tsc / build は最後に一括実行。

---

## 3. Engineer A — ConfirmPage 軽量化

### 3.1 目的
512 行ある `src/pages/ConfirmPage.tsx` を「親 (ルーティング + 並びの管理)」と「子 (1 件分のフォーム)」に分け、ハンドラを `useConfirmForms` フックに集約する。

### 3.2 新規ファイル構成

```
src/pages/confirm/
  ├── useConfirmForms.ts   ← state + ハンドラ (toggleSplit / handleSplitChange / addSplitRow / removeSplitRow / autoFillLastSplit / handleChange / handleRegisterAll)
  ├── ReceiptForm.tsx      ← 1 件分のフォーム JSX（日付/金額/店舗/カテゴリ/税区分/分割UI/メモ）
  ├── SplitRows.tsx        ← 分割UI 部分（行追加/削除/合計表示）
  └── constants.ts         ← CATEGORIES / TAX_OPTIONS（※ ConfirmPage 内の同名定数を移動）
```

### 3.3 各ファイル詳細

#### `src/pages/confirm/constants.ts`
- ConfirmPage.tsx の `CATEGORIES` (l.20-29) と `TAX_OPTIONS` (l.30-33) をそのまま移植。
- `as const` を付ける。型は推論まかせ。
- 既存 `src/pages/dashboard/constants.ts` に類似カテゴリ定義があるが、**今回は import せず confirm/ ローカルに置く**（ConfirmPage 用と Dashboard 用は将来分岐する可能性があるため、Loop 5 では統合しない）。

#### `src/pages/confirm/useConfirmForms.ts`
- 入力: `analyses: AnalysisResult[]` (LocationState から）
- 戻り値:
  ```ts
  {
    forms: FormState[];
    loading: boolean;
    registered: number;
    isSubmitDisabled: boolean;
    handleChange: (index: number, e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void;
    toggleSplit: (index: number) => void;
    disableSplit: (index: number) => void;
    handleSplitChange: (index: number, splitIdx: number, field: string, value: string | number) => void;
    addSplitRow: (index: number) => void;
    removeSplitRow: (index: number, splitIdx: number) => void;
    autoFillLastSplit: (index: number) => void;
    handleRegisterAll: () => Promise<void>;
  }
  ```
- 内部で `useNavigate` を使って `/complete` に遷移する処理 (= `handleRegisterAll` の最後) を含む。
- `FormState` 型は ConfirmPage.tsx 既存のものを移植。`useConfirmForms.ts` 内で `interface FormState { ... }` を **そのまま** 定義し、`ReceiptForm` に `import type { FormState } from './useConfirmForms'` で渡す。
- `buildPayload` (l.35-58) と `validateForm` (l.60-71) は同フック内に private 関数として置く。

#### `src/pages/confirm/SplitRows.tsx`
- props:
  ```ts
  interface SplitRowsProps {
    index: number;
    form: FormState;
    splitSum: number;
    splitMismatch: boolean;
    onSplitChange: (splitIdx: number, field: string, value: string | number) => void;
    onAddSplitRow: () => void;
    onRemoveSplitRow: (splitIdx: number) => void;
    onAutoFillLastSplit: () => void;
    onDisableSplit: () => void;
  }
  ```
- 既存 ConfirmPage.tsx l.365-468 (分割UI ブロック) をそのまま移植。
- 親 (ReceiptForm) 側でカリー化して `() => addSplitRow(index)` の形で渡す。

#### `src/pages/confirm/ReceiptForm.tsx`
- props:
  ```ts
  interface ReceiptFormProps {
    index: number;
    form: FormState;
    total: number;            // forms.length（"1 / 合計N" 表示用）
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void;
    onToggleSplit: () => void;
    onDisableSplit: () => void;
    onSplitChange: (splitIdx: number, field: string, value: string | number) => void;
    onAddSplitRow: () => void;
    onRemoveSplitRow: (splitIdx: number) => void;
    onAutoFillLastSplit: () => void;
  }
  ```
- ConfirmPage.tsx l.285-482 のカード 1 件分 (`<div className="bg-white rounded-xl shadow-md p-8">`) をそのまま移植。
- 内部で `splitSum` / `splitMismatch` を計算して `SplitRows` へ。

#### `src/pages/ConfirmPage.tsx` (リファクタ後)
- 想定 130 行前後。
- 中身:
  1. `useLocation` で `analyses` を取得し空チェック (l.252-263 の no-data ガード)。
  2. `const { forms, loading, registered, isSubmitDisabled, ... } = useConfirmForms(analyses);`
  3. `forms.map((form, i) => <ReceiptForm index={i} form={form} total={forms.length} onChange={(e)=>handleChange(i,e)} ... />)`
  4. 下部の「戻る / まとめて登録」ボタン (l.485-507) はそのまま。

### 3.4 移植時の注意
- import 経路: `import type { AnalysisResult, SplitItem } from '../types/receipt';` は ConfirmPage.tsx に残す（buildPayload 内型推論用）。
- `FormState` / `LocationState` interface は **useConfirmForms.ts に移し、`export interface FormState` する**。
- `CATEGORIES` / `TAX_OPTIONS` は confirm/constants.ts に移し、`ReceiptForm` と `SplitRows` の双方が import する。
- `handleSplitChange` の field 引数は既存通り `string | number` を維持（型強化は Loop 6 以降）。
- ハンドラのカリー化 (親で `(splitIdx, field, value) => onSplitChange(index, splitIdx, field, value)` を作る) は **ReceiptForm 側で行う** こと。useConfirmForms は `(index, splitIdx, ...)` のシグネチャを返す。ReceiptForm が `index` を knowing するため。

### 3.5 検証
- `npx tsc --noEmit` でエラー 0
- `npm run build` 成功
- 目視: `npm run dev` でアップロード → /confirm 遷移 → 1 件編集 → 分割切替 → 残額自動按分 → まとめて登録 のフローが既存通り動く（任意。Reviewer がコード上で確認できれば省略可）

---

## 4. Engineer B — SplitEditModal 軽量化 + result_json 型整理

### 4.1 目的
- 446 行ある `src/components/SplitEditModal.tsx` を分割。
- インライン定義されている `receipt.result_json` (l.5-21) の型を `src/types/receipt.ts` の `ReceiptResult` に揃え、`SplitEditModalProps['receipt']` を `Receipt` 互換にする。

### 4.2 型整理

#### `src/types/receipt.ts` への追記（末尾に export 追加）

```ts
/**
 * SplitEditModal が受け取る receipt の最小形。
 * Receipt から SplitEditModal が必要とするフィールドのみを抽出。
 * DashboardPage 側の `b.splitModalReceipt as ...` キャストもこの型に置き換え可。
 */
export interface SplitEditTarget {
  id: string;
  image_url: string | null;
  section_id: string | null;
  result_json: ReceiptResult | null;
}
```

- 既存の export には一切触らない（Loop 2 互換維持）。
- `SplitEditTarget.result_json` は既存 `ReceiptResult` を再利用 (フィールド和集合は和集合のままで OK。SplitEditModal は `date / store / amount / category / tax_code / splits` のみ参照するので過剰フィールドは無視される)。

### 4.3 新規ファイル構成

```
src/components/splitEdit/
  ├── useSplitEditState.ts  ← state + ハンドラ (updateSplit / addRow / removeRow / handleSave / handleRelease / handleClose / unsaved 検知)
  ├── SplitTable.tsx        ← 分割テーブル JSX（thead/tbody/+ 行を追加 ボタン）
  └── SplitEditFields.tsx   ← 共通フィールド (日付/店名/部門/総額) JSX
```

### 4.4 各ファイル詳細

#### `src/components/splitEdit/useSplitEditState.ts`
- 入力:
  ```ts
  function useSplitEditState(
    receipt: SplitEditTarget,
    categories: string[],
    onClose: () => void,
    onSaved: () => void | Promise<void>,
  ): {
    date: string; setDate: (v: string) => void;
    store: string; setStore: (v: string) => void;
    sectionId: string; setSectionId: (v: string) => void;
    splits: SplitItem[];
    totalAmount: number; setTotalAmount: (v: number) => void;
    saving: boolean;
    releasing: boolean;
    error: string | null;
    sum: number;
    diff: number;
    isMatched: boolean;
    canSave: boolean;
    hasUnsavedChanges: boolean;
    updateSplit: (i: number, patch: Partial<SplitItem>) => void;
    addRow: () => void;
    removeRow: (i: number) => void;
    handleSave: () => Promise<void>;
    handleRelease: () => Promise<void>;
    handleClose: () => void;
  }
  ```
- 内部実装は既存 SplitEditModal.tsx l.34-196 (state 群、useMemo 群、updateSplit/addRow/removeRow、handleSave、handleRelease、handleClose) をそのまま移植。
- `useEffect` で `Escape` キーをハンドルしている部分 (l.197-208) も同フック内に置く。
- `categories` を引数で受け取るのは `addRow()` で `categories[0]` を使うため。

#### `src/components/splitEdit/SplitTable.tsx`
- props:
  ```ts
  interface SplitTableProps {
    splits: SplitItem[];
    categories: string[];
    onUpdateSplit: (i: number, patch: Partial<SplitItem>) => void;
    onAddRow: () => void;
    onRemoveRow: (i: number) => void;
  }
  ```
- 既存 SplitEditModal.tsx l.301-389 をそのまま移植。
- `formatYen` は親 (`SplitEditModal`) で使っているのでこちらでは未使用。

#### `src/components/splitEdit/SplitEditFields.tsx`
- props:
  ```ts
  interface SplitEditFieldsProps {
    date: string;
    store: string;
    sectionId: string;
    totalAmount: number;
    sections: string[];
    onChangeDate: (v: string) => void;
    onChangeStore: (v: string) => void;
    onChangeSection: (v: string) => void;
    onChangeTotalAmount: (v: number) => void;
  }
  ```
- 既存 SplitEditModal.tsx l.252-298 (Common fields の grid) をそのまま移植。

#### `src/components/SplitEditModal.tsx` (リファクタ後)
- 想定 140 行前後。
- 中身:
  1. props 定義（`SplitEditModalProps.receipt: SplitEditTarget`）。`import type { SplitEditTarget } from '../types/receipt';`
  2. `formatYen` ローカル関数は残す。
  3. `const state = useSplitEditState(receipt, categories, onClose, onSaved);`
  4. オーバーレイ + 左カラム (画像) + 右カラム (Header / SplitEditFields / SplitTable / Total match / Error / Footer) を組み立て。
  5. `Escape` ハンドラの useEffect は **フック内に移動済**なのでここからは削除。

### 4.5 DashboardPage 側の調整
- `src/pages/DashboardPage.tsx` l.262 の `as React.ComponentProps<typeof SplitEditModal>['receipt']` キャストは **そのまま残してよい** (型互換のため)。`SplitEditTarget` への明示変換に置き換えても良いが、Loop 5 のスコープ外。
- ただし `SplitEditModalProps.receipt` の型を変更したことで TS エラーが出ないかは要確認。`SplitEditTarget` は既存インライン型と構造一致 (same shape) なので互換のはず。

### 4.6 移植時の注意
- `useSplitEditState` の戻り値は **オブジェクト 1 つにまとめる**（タプルではない）。フィールドが多いので可読性優先。
- `setSplits` を直接エクスポートしない (`updateSplit / addRow / removeRow` 経由のみ)。これにより外部からの不変性を担保。
- `categories` 引数を `useSplitEditState` に渡すのは `addRow` で `categories[0]` を使うため。`addRow` 単独で抽出してもよいが、state を持つので fold する方がシンプル。
- `handleClose` / `handleSave` / `handleRelease` は既存ロジックを **1 行も変えない**。fetch 先・payload 構造・confirm 文言・error メッセージすべて同一。

### 4.7 検証
- `npx tsc --noEmit` エラー 0
- `npm run build` 成功
- DashboardPage 上で SplitEditModal が開くことを目視確認 (任意)

---

## 5. Engineer C — freee ヘルパ抽出

### 5.1 目的
`api/register.js` (365 行) の freee API 呼び出しを `api/lib/freee.js` (新規 ESM) に切り出し、register.js を「リクエスト検証 → ヘルパ呼び出し → レスポンス整形」のオーケストレーションに集中させる (約 180 行に圧縮)。

### 5.2 新規ファイル: `api/lib/freee.js`

#### 想定 export
```js
// ESM。 import { freeeApiFetch } from './freee-auth.js' を内部で使う。

// ─── 定数 (register.js 冒頭の定義をここに移動) ─────────────────
export const CATEGORY_MAP = { /* register.js l.3-12 と同一 */ };
export const SECTION_MAP  = { /* register.js l.14-24 と同一 */ };
export const DEFAULT_ACCOUNT_ITEM_ID = 929160680;
export const TAX_CODE = 136;
export const WALLET_ID = 6815911;

// ─── 関数 ────────────────────────────────────────────────

/**
 * 画像バッファを freee に receipt として アップロード。
 * @returns receipt id (number) or null (失敗時)
 */
export async function uploadReceiptToFreee(companyId, receiptData, mimeType, filename) { ... }

/**
 * 取引先 (partner) を keyword で検索。完全一致が無ければ新規作成。
 * @returns { partnerId: number | null, error?: string }
 *   - 検索/作成いずれかで HTTP エラーなら error を返し partnerId は null。
 */
export async function findOrCreatePartner(companyId, store) { ... }

/**
 * deal を作成し、成功時は receipts テーブルに freee_sent_at / freee_deal_id を反映。
 * @param {object} args
 * @param {number} args.companyId
 * @param {string} args.date
 * @param {Array}  args.details      ← buildDetail 適用済の details 配列
 * @param {number} args.amount       ← payments.amount
 * @param {number|null} args.partnerId
 * @param {number|null} args.freeeReceiptId
 * @param {string|null} args.receiptId  ← Supabase receipts.id (反映用)。null なら反映スキップ
 * @param {() => Promise<SupabaseClient>} args.getSupabase  ← register.js 側のヘルパを注入
 * @returns { ok: true, dealId: number|null, receiptUploaded: boolean }
 *        | { ok: false, status: number, error: string, detail?: string }
 */
export async function createDealAndMarkReceipt(args) { ... }

/**
 * 1 行分の details オブジェクトを構築 (buildDetail @ register.js l.252-258)。
 * @param {{category:string, amount:number, description?:string, tax_code:number, store?:string}} item
 * @returns {object}
 */
export function buildDetail(item) { ... }

/**
 * splits 配列から freee details 配列を構築。
 * splits 未指定時は単一 detail を返す。
 * @param {object} args
 * @param {SplitItem[]|undefined} args.splits
 * @param {string} args.category
 * @param {number} args.amount
 * @param {string} args.store
 * @param {number} args.singleTaxCode
 * @param {number|null} args.freeeSectionId
 * @returns {Array<object>}  freee details
 */
export function buildDetails(args) { ... }

/**
 * SECTION_MAP から freee section_id を引く。null セーフ。
 */
export function resolveSectionId(sectionName) {
  return sectionName ? (SECTION_MAP[sectionName] ?? null) : null;
}

/**
 * result_json.splits の DB 検証 (validateSplitsFromDb @ register.js l.35-46 を移植)。
 */
export function validateSplitsFromDb(arr, amount) { ... }
```

#### 実装方針
- `uploadReceiptToFreee`: register.js l.48-68 をそのままコピー。 import は `freee-auth.js` から `freeeApiFetch` のみ。
- `findOrCreatePartner`: register.js l.232-258 のロジックを抽出。HTTP エラーは throw せず `{ partnerId: null, error: '...' }` を返し、呼び出し側 (register.js) で 500 を返す。
- `createDealAndMarkReceipt`: register.js l.302-356 (deal 作成 + receipt 反映) をそのまま移植。Supabase の循環依存を避けるため `getSupabase` を引数で注入。
- `buildDetail` / `buildDetails`: register.js l.252-281 (buildDetail + details 構築 + section_id 付与) を抽出。
- `validateSplitsFromDb`: register.js l.35-46 を移動。

### 5.3 register.js (リファクタ後) の構造

```js
import { freeeApiFetch } from './lib/freee-auth.js';
import {
  CATEGORY_MAP, DEFAULT_ACCOUNT_ITEM_ID, TAX_CODE,
  uploadReceiptToFreee, findOrCreatePartner,
  createDealAndMarkReceipt, buildDetails,
  resolveSectionId, validateSplitsFromDb,
} from './lib/freee.js';

async function getSupabase() { /* 既存どおり */ }

export default async function handler(request, response) {
  // 1. method チェック
  // 2. body 取得
  // 3. splits バリデーション (l.81-101)
  // 4. 必須項目 / date / amount / store チェック (l.105-156)
  // 5. companyId 取得
  // 6. (receipt_id があれば) Supabase から receipt を取得 + 画像 download + uploadReceiptToFreee 呼び出し (l.171-211)
  // 7. effectiveSplits / effectiveTaxCode / singleTaxCode 決定 (l.214-228)
  // 8. findOrCreatePartner(companyId, store) → 失敗なら 500
  // 9. const freeeSectionId = resolveSectionId(sectionName);
  // 10. const details = buildDetails({ splits: effectiveSplits, category, amount, store, singleTaxCode, freeeSectionId });
  // 11. createDealAndMarkReceipt({ companyId, date, details, amount, partnerId, freeeReceiptId, receiptId: receipt_id, getSupabase })
  //     → 成功時 200 + { success, deal_id, receipt_uploaded }
  //     → 失敗時 500 + { error, detail? }
}
```

- 既存の `try { ... } catch (e)` は維持。catch は最終 fallback。
- 想定行数: 180 行前後（バリデーション部が 100 行近くを占めるため、これ以上は減らさない）。

### 5.4 ESM/CJS 整合
- `package.json` の `"type": "module"` 確認済。
- `api/lib/prompt.js` / `freee-auth.js` も ESM (`export ...` / `import ...`)。
- 新規 `api/lib/freee.js` も **ESM で作成**。
- import パスは拡張子 `.js` を付ける (`./freee-auth.js`, `./lib/freee.js`)。Node ESM の解決ルールに従う。

### 5.5 注意点
- **既存の API レスポンス形式・エラーメッセージ・ステータスコード・ログ出力 (`console.error`, `console.warn`) を 1 つも変えない**。文言の細かな違いも本番運用に影響するため厳禁。
- partner 検索のクエリ (`?company_id=&keyword=`) と `encodeURIComponent` の有無は既存維持。
- `receipts` 更新時の例外ハンドリング (l.337-348 の `try/catch` 二重) も既存維持。
- supabase クライアント生成は **register.js 内の `getSupabase()` を helpers に注入**する形にし、`api/lib/freee.js` から `@supabase/supabase-js` を import しない（責務分離）。
- `dealBody` のフィールド順や条件付き付与 (`if (partnerId) dealBody.partner_id = ...`) も既存維持。

### 5.6 検証
- `node --check api/register.js` で構文エラー 0
- `node --check api/lib/freee.js` で構文エラー 0
- `npm run build` 成功（フロント側に影響無いはず）
- ローカル `npm run dev:api` 起動 → /api/register に既存と同等のリクエストを投げて成功レスポンスを確認 (Reviewer 任意)
- diff レビュー: register.js の動作経路が既存と完全一致しているか (= ロジック等価変換) を読み合わせる

---

## 6. 検証総合 (統合フェーズ)

1. `cd ~/Documents/個人仕事/newWorld/receipt-scanner && npx tsc --noEmit` でエラー 0。
2. `npm run build` 成功 (vite build → dist 生成)。dist/ は本来 .gitignore 済 (Loop 1 で対応)。
3. `node --check api/register.js api/lib/freee.js api/lib/prompt.js api/lib/freee-auth.js` 全 OK。
4. `git diff --stat` で行数増減が概ね期待通り (ConfirmPage.tsx -350 / SplitEditModal.tsx -300 / register.js -180、新規 8 ファイル ＋ 型 1 つ追加)。
5. 動作確認 (Reviewer or Tech Lead が手動で 1 回): アップロード → /confirm → 登録 / Dashboard で SplitEditModal 開閉 → 保存 / freee 取引が作成される。

---

## 7. 統合時の注意点

- **マージ順は問わない**（A/B/C 完全独立）。コンフリクトは発生しない設計。
- B が `src/types/receipt.ts` 末尾に export 追加するため、`git diff src/types/receipt.ts` は **末尾追記のみ** であることを Reviewer が確認すること。Loop 2 で確定済の型定義に変更があれば差し戻し。
- C で `api/register.js` から定数 `CATEGORY_MAP` / `SECTION_MAP` などが消える。`grep -rn "CATEGORY_MAP\|SECTION_MAP\|WALLET_ID" api/` で `api/register.js` (import) と `api/lib/freee.js` (定義) の 2 箇所のみであることを確認。
- A の `useConfirmForms` から `useNavigate` を呼ぶため `react-router-dom` の依存はフック側に移る。ConfirmPage.tsx 側からは `useLocation` のみ残る形になる。
- 既存の `'分割を解除して保存'` などの日本語 UI 文言、freee エラーメッセージ、`alert` 文言は **すべて一致** が前提。差分があれば Reviewer は差し戻し。

---

## 8. ロールバック方針

万一 freee API 連携に異常 (deal 作成失敗 / partner 検索失敗 / receipt アップロード失敗) が発生した場合:
- C のみ revert (`git revert`) で `api/register.js` を Loop 4 完了時点に戻す。A/B はフロントのみのリファクタなので revert 不要。
- `api/lib/freee.js` は新規ファイルなので削除しても他に影響なし。

---

## 9. 期待される成果

| 指標 | Before | After |
|---|---|---|
| ConfirmPage.tsx | 512 行 | ~130 行 |
| SplitEditModal.tsx | 446 行 | ~140 行 |
| register.js | 365 行 | ~180 行 |
| freee 関連の重複可能性 | register.js 内インライン (再利用不可) | `api/lib/freee.js` 経由で receipts.js 等から呼び出し可能 |
| `result_json` インライン型 | SplitEditModal 内に独自 | `SplitEditTarget` (共通型) に集約 |

---

## 10. Engineer 着手指示テンプレ

各 Engineer (GLM) には以下を渡す:
- 本設計書の該当セクション (3 / 4 / 5 のいずれか)
- 対象ファイルの absolute path
- 関連既存ファイル (types/receipt.ts, freee-auth.js, prompt.js 等) のシグネチャ
- 「既存の挙動を 1 byte も変えない、純粋なリファクタ」という制約
- 完了後 `npx tsc --noEmit` (A/B) または `node --check` (C) を通すこと

レビューは集約 Reviewer 1 名 (GLM) が A/B/C 全てを確認し、Tech Lead が最終承認。
