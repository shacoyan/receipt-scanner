# receipt-scanner ダッシュボード Loop B 設計書

- 作成日: 2026-04-28
- Tech Lead: Claude
- 前提: Loop A 完了 (newWorld 2b35b87 / receipt-scanner fbcfbf7)
- ループ範囲: パフォーマンス監査 #3
  「ReceiptTableRow / ReceiptMobileCard の React.memo 化と DashboardPage 内 rowProps の useMemo 化」

## 1. 目的 / Why

DashboardPage 1 ページに最大 PAGE_LIMIT 件 (現状 50) の行が並ぶ。
現状の振る舞い:

- 編集 (`editDraft` / `editSectionId`) 1 文字ごとに DashboardPage が re-render
- DashboardPage の `rowProps` は毎レンダ新規生成のオブジェクト → `{...rowProps}` で全行の props が新規参照
- ReceiptTableRow / ReceiptMobileCard は memo 化されていないため、編集中でない 49 行も毎ストロークで再レンダリング

目的:

1. 編集中行のみ再レンダリングし、他行は skip する
2. 選択 / 展開 トグル時も該当行 + 旧該当行のみ再レンダ、それ以外は skip
3. 既存の挙動 (即時保存・即時編集反映・即時選択反映) は完全に保つ

## 2. 現状の hook / 参照安定性の事実確認

`src/pages/dashboard/useBulkActions.ts`:
- 全コールバック (toggleSelect / toggleExpand / startEdit / cancelEdit / saveEdit / openSplitModal / closeSplitModal / approveSelected / deleteSelected / unapproveSelected / rerunSelected / sendToFreee / clearSelection / resetExpanded / toggleSelectAll) は **既に useCallback 化済み**
- `setEditDraft` / `setEditSectionId` / `setPreviewUrl` は **React useState の setter** → 参照 stable (React 保証)
- 戻り値の `selected` / `expandedIds` は **新しい Set オブジェクト** で更新される

`src/pages/DashboardPage.tsx` 53-69:
- `rowProps = { ... }` を毎レンダ生成 (useMemo なし)

`src/pages/dashboard/ReceiptTableRow.tsx` / `ReceiptMobileCard.tsx`:
- `React.memo` ラップなし
- 内部に `setEditDraftSafe = (d) => setEditDraft(d)` を毎レンダ生成 (`EditableCell` に props として流す)

## 3. 戦略

### 3.1 propsAreEqual を書かずに shallow compare を効かせる

カスタム `propsAreEqual` は読みづらく保守性が下がる。代わりに **DashboardPage 側で props を「行視点でスカラー化」して、shallow compare だけで完璧に効くように整形する**。

具体的には:

| 現状 props (Set / 全体) | Loop B 後 (行視点スカラー)                           |
|-------------------------|-----------------------------------------------------|
| `selected: Set<string>` | `isSelected: boolean` (= `selected.has(r.id)`)      |
| `expandedIds: Set<string>` | `isExpanded: boolean` (= `expandedIds.has(r.id)`) |
| `editingId: string \| null` | `isEditing: boolean` (= `editingId === r.id`)   |
| `editDraft: ReceiptResult \| null` | `editDraft: ReceiptResult \| null` (= 編集中行のみ実値、他行は **null**) |
| `editSectionId: string \| null`    | `editSectionId: string \| null` (= 編集中行のみ実値、他行は **null**) |

→ 編集中以外の行は `editDraft = null`、`editSectionId = null`、`isSelected` も `isExpanded` も値が変わったときだけ更新 → shallow compare で完璧に skip。

### 3.2 行コンポーネント側のコールバック参照安定化

- `setEditDraftSafe` は廃止。`EditableCell` 側の型 (`setEditDraft: (d: ReceiptResult) => void`) を `(d: ReceiptResult | null) => void` に揃えるか、`ReceiptTableRow` / `ReceiptMobileCard` の props で受ける `setEditDraft` の型を `(d: ReceiptResult) => void` に **狭めて** そのまま渡す方が clean。
- 採用案: **行コンポーネント側で受け取る `setEditDraft` の型を `(d: ReceiptResult) => void` に変更** し、`DashboardPage` 側で `useBulkActions` の `setEditDraft` を `useCallback((d: ReceiptResult) => bulk.setEditDraft(d), [bulk.setEditDraft])` でラップする。
  - こうすることで `EditableCell` の型はそのまま、行コンポーネント内のローカル関数 `setEditDraftSafe` は不要、参照は完全 stable。

### 3.3 React.memo の適用

- `ReceiptTableRow`: `export const ReceiptTableRow = React.memo<ReceiptTableRowProps>((props) => { ... })`
- `ReceiptMobileCard`: 同上
- `propsAreEqual` は **指定しない** (shallow compare で十分)
- displayName を設定 (devtools 可読性)

### 3.4 DashboardPage の rowProps useMemo 化

`rowProps` は **行ごとに違う値** (`isSelected` / `isExpanded` / `isEditing` / `editDraft` / `editSectionId`) と **行を跨いで共通の値** (`setEditDraft` / `setEditSectionId` / `setPreviewUrl` / `startEdit` / `cancelEdit` / `saveEdit` / `toggleSelect` / `toggleExpand` / `openSplitModal`) に分かれる。

設計:

- `commonRowProps` を `useMemo` 化 (deps: 共通コールバック群)
- 各行の **行依存 props** は `<ReceiptTableRow ... isSelected={...} />` のように map 内で **直接プロパティとして** 渡す (オブジェクトラップせず) → これで余分な useMemo は不要、子の shallow compare に直で乗る

```tsx
const commonRowProps = useMemo(() => ({
  setEditDraft: handleSetEditDraft,
  setEditSectionId: b.setEditSectionId,
  setPreviewUrl: b.setPreviewUrl,
  startEdit: b.startEdit,
  cancelEdit: b.cancelEdit,
  saveEdit: b.saveEdit,
  toggleSelect: b.toggleSelect,
  toggleExpand: b.toggleExpand,
  openSplitModal: b.openSplitModal,
}), [
  handleSetEditDraft,
  b.setEditSectionId, b.setPreviewUrl,
  b.startEdit, b.cancelEdit, b.saveEdit,
  b.toggleSelect, b.toggleExpand, b.openSplitModal,
]);
```

map 内:

```tsx
{receipts.map((r) => {
  const isEditing = b.editingId === r.id;
  return (
    <ReceiptTableRow
      key={r.id}
      receipt={r}
      isEditing={isEditing}
      isSelected={b.selected.has(r.id)}
      isExpanded={b.expandedIds.has(r.id)}
      editDraft={isEditing ? b.editDraft : null}
      editSectionId={isEditing ? b.editSectionId : null}
      {...commonRowProps}
    />
  );
})}
```

### 3.5 selected / expandedIds の参照変化への対応

- `b.selected.has(r.id)` は `b.selected` が変わるたびに DashboardPage で全行に対して再評価される (これは避けられない)
- ただし **値 (boolean) が変わらなければ** 子の shallow compare で skip される → OK

例: 行 A を選択 → `selected` Set 参照変化 → 親が re-render → 全行で `selected.has(r.id)` 再評価 → 行 A だけ `isSelected: true` で値が変わる → 行 A のみ re-render、他 49 行は props 全部同値で skip ✓

## 4. 影響ファイル / 変更箇所

### 4.1 `src/pages/dashboard/ReceiptTableRow.tsx`

**Props 型の変更 (差し替え):**

```ts
// Before
export interface ReceiptTableRowProps {
  receipt: Receipt;
  editingId: string | null;
  editDraft: ReceiptResult | null;
  editSectionId: string | null;
  setEditDraft: (d: ReceiptResult | null) => void;
  setEditSectionId: (s: string | null) => void;
  startEdit: (r: Receipt) => void;
  cancelEdit: () => void;
  saveEdit: () => Promise<void>;
  selected: Set<string>;
  toggleSelect: (id: string) => void;
  expandedIds: Set<string>;
  toggleExpand: (id: string) => void;
  openSplitModal: (r: Receipt) => void;
  setPreviewUrl: (u: string | null) => void;
}

// After
export interface ReceiptTableRowProps {
  receipt: Receipt;
  isEditing: boolean;            // ← editingId === r.id を親で計算
  isSelected: boolean;           // ← selected.has(r.id) を親で計算
  isExpanded: boolean;           // ← expandedIds.has(r.id) を親で計算
  editDraft: ReceiptResult | null;       // 非編集行は null
  editSectionId: string | null;          // 非編集行は null
  setEditDraft: (d: ReceiptResult) => void;   // 型を狭める (null 不可)
  setEditSectionId: (s: string | null) => void;
  startEdit: (r: Receipt) => void;
  cancelEdit: () => void;
  saveEdit: () => Promise<void>;
  toggleSelect: (id: string) => void;
  toggleExpand: (id: string) => void;
  openSplitModal: (r: Receipt) => void;
  setPreviewUrl: (u: string | null) => void;
}
```

**本体の変更:**

- `const isEditing = editingId === r.id;` 削除 (props で受ける)
- `selected.has(r.id)` → `isSelected`
- `expandedIds.has(r.id)` → `isExpanded`
- ローカル `setEditDraftSafe` 廃止 → `<EditableCell setEditDraft={setEditDraft} />` で直接渡す
  - `EditableCell` は `(d: ReceiptResult) => void` を受ける → 型一致で OK
- `CategoryCell` の `expandedIds` / `toggleExpand` props も整理:
  - `cells.tsx` の `CategoryCellProps` を `expandedIds: Set<string>` から `isExpanded: boolean` に変更し、行から `isExpanded` を渡す
  - `toggleExpand` の引数は `(id: string) => void` のままでも、`receipt` を持っているので `() => toggleExpand(receipt.id)` を渡してもよい。ここでは **既存シグネチャ維持 + isExpanded を追加** が破壊変更小。
- `<React.Fragment key={r.id}>` の `key` は不要 (親が key を渡している) → ただし既存挙動変更なしのため touch しない
- `ReceiptTableRow` を `React.memo` でラップ:

```tsx
const ReceiptTableRowImpl: React.FC<ReceiptTableRowProps> = ({...}) => { ... };
ReceiptTableRowImpl.displayName = 'ReceiptTableRow';
export const ReceiptTableRow = React.memo(ReceiptTableRowImpl);
```

### 4.2 `src/pages/dashboard/ReceiptMobileCard.tsx`

ReceiptTableRow と完全対称の変更:

- Props 型を 4.1 と同じ形に変更
- `selected.has(r.id)` → `isSelected`、`expandedIds.has(r.id)` → `isExpanded`
- `setEditDraftSafe` 廃止
- `React.memo` でラップ + displayName

### 4.3 `src/pages/dashboard/cells.tsx`

`CategoryCell` の props は `expandedIds: Set<string>` を取っているが、現状 `expandedIds.has(receipt.id)` でしか使っていない (行 116 など)。

**変更案:**

```ts
// Before
export interface CategoryCellProps {
  receipt: Receipt;
  isEditing: boolean;
  result: ReceiptResult | null;
  isSplit: boolean;
  expandedIds: Set<string>;
  toggleExpand: (id: string) => void;
  editDraft: ReceiptResult | null;
  setEditDraft: (d: ReceiptResult) => void;
}

// After
export interface CategoryCellProps {
  receipt: Receipt;
  isEditing: boolean;
  result: ReceiptResult | null;
  isSplit: boolean;
  isExpanded: boolean;          // ← 単純化
  toggleExpand: (id: string) => void;
  editDraft: ReceiptResult | null;
  setEditDraft: (d: ReceiptResult) => void;
}
```

本体の `expandedIds.has(receipt.id) ? '▾' : '▸'` を `isExpanded ? '▾' : '▸'` に置き換え。

`CategoryCell` 自身は memo 化しない (親行が memo で守るため、cells は素のまま)。

### 4.4 `src/pages/DashboardPage.tsx`

**import 追加:** `useMemo`, `useCallback`

**`b` 分割と `setEditDraft` ラップ:**

```tsx
const b = useBulkActions({ receipts, onMutate: refetch });

// useBulkActions の setEditDraft は (d: ReceiptResult | null) => void
// 行コンポーネント側は (d: ReceiptResult) => void を受け取るのでラップ
const handleSetEditDraft = useCallback(
  (d: ReceiptResult) => b.setEditDraft(d),
  [b.setEditDraft],
);
```

**`commonRowProps` を useMemo 化** (3.4 参照)

**map 部分の差し替え** (3.4 参照、Desktop / Mobile 両方):

```tsx
{/* Desktop */}
{receipts.map((r) => {
  const isEditing = b.editingId === r.id;
  return (
    <ReceiptTableRow
      key={r.id}
      receipt={r}
      isEditing={isEditing}
      isSelected={b.selected.has(r.id)}
      isExpanded={b.expandedIds.has(r.id)}
      editDraft={isEditing ? b.editDraft : null}
      editSectionId={isEditing ? b.editSectionId : null}
      {...commonRowProps}
    />
  );
})}

{/* Mobile */}
{receipts.map((r) => {
  const isEditing = b.editingId === r.id;
  return (
    <ReceiptMobileCard
      key={r.id}
      receipt={r}
      isEditing={isEditing}
      isSelected={b.selected.has(r.id)}
      isExpanded={b.expandedIds.has(r.id)}
      editDraft={isEditing ? b.editDraft : null}
      editSectionId={isEditing ? b.editSectionId : null}
      {...commonRowProps}
    />
  );
})}
```

**旧 rowProps 定義は削除** (53-69 行)。

### 4.5 `src/pages/dashboard/useBulkActions.ts`

**変更なし。** (既に全コールバックが useCallback 化されている)

## 5. 並列分割

### Engineer 1 (担当: 行コンポーネント 2 ファイル)
- `src/pages/dashboard/ReceiptTableRow.tsx` — Props 型変更 + 本体修正 + React.memo
- `src/pages/dashboard/ReceiptMobileCard.tsx` — Props 型変更 + 本体修正 + React.memo

### Engineer 2 (担当: cells と DashboardPage)
- `src/pages/dashboard/cells.tsx` — `CategoryCellProps` の `expandedIds` → `isExpanded` 変更、本体の参照差し替え
- `src/pages/DashboardPage.tsx` — `commonRowProps` useMemo 化、`handleSetEditDraft` 追加、map 部の props 渡し方変更、旧 `rowProps` 削除

**依存関係:** Engineer 2 の DashboardPage は Engineer 1 が定義した新 Props 型を使う。型定義は **本設計書の 4.1 / 4.2 / 4.3 に明記済み** なので、両者は **本設計書を参照して並列に作業可能** (お互いの実装は読まなくてよい)。

**並列度:** 2 並列 (タスク量バランス: Eng1 ≒ Eng2)。

3 並列にする案も検討したが、cells.tsx は 1 か所しか触らず DashboardPage と同じ Engineer に持たせた方が型整合の確認が早い → 2 並列が最適。

## 6. 受け入れ条件

- ビルドが通る (TypeScript エラー 0、Vite warning なし)
- 編集モードに入る/抜ける時に他行が re-render しない (React DevTools Profiler で確認可能、必須ではないが推奨)
- 編集中の文字入力が即時反映される (体感で判断)
- 「選択した N 件」のカウントが即時反映される
- 分割行の展開トグルが正しく動く
- 画像クリックでプレビューが開く
- freee 送信・承認・削除・再判定が全て動く
- DashboardPage chunk のサイズに大きな増減なし (memo は無視できるサイズ)

## 7. リスクと検証観点

### R1: 編集中の文字反映が遅延する / stuck する
- 原因候補: `editDraft` の参照が `useBulkActions` 側で stable に維持されると memo で skip される
- 対策確認: `useBulkActions.setEditDraft` は `(d) => setEditDraft(d)` で **新オブジェクトをそのまま set** しているので、毎ストロークで `editDraft` 参照は変わる。`isEditing===true` の行は `editDraft` prop が変わる → memo 通過 → re-render する → OK
- 検証: Engineer は `npm run build` 後、ローカルで `npm run dev` 起動可能なら 1 件編集を 1 文字打って即時反映を目視

### R2: 非編集行が誤って re-render され続ける
- 原因候補: 非編集行に `editDraft={isEditing ? b.editDraft : null}` で `null` を渡しているが、`isEditing` が常時 false なら `null === null` で安定 → OK
- 検証: ビルドが通れば実害なし。Profiler は任意

### R3: 選択チェックボックスが遅延する
- 原因候補: `b.selected` 参照変化 → 親 re-render → 全行 `isSelected` 再計算 → 該当行のみ shallow compare で抜ける
- 該当行は `isSelected` の値変化 → re-render → ✓ 即時反映
- 検証: ビルド + 任意で目視

### R4: 展開トグルが効かない / 他行も展開される
- 原因候補: `isExpanded` の伝播ミス、`CategoryCell` 内の `expandedIds.has(receipt.id)` を `isExpanded` に置換し忘れ
- 検証: `cells.tsx` の grep で `expandedIds` 残存ゼロを Engineer 自身が確認、Reviewer も再確認

### R5: 型エラー (setEditDraft の null 受け入れ問題)
- 行コンポーネントで受ける `setEditDraft: (d: ReceiptResult) => void` と、useBulkActions が返す `setEditDraft: (d: ReceiptResult | null) => void` を `handleSetEditDraft = (d: ReceiptResult) => b.setEditDraft(d)` でブリッジする
- 検証: `npm run build` 通過

### R6: cells.tsx の `CategoryCellProps` 変更による他参照の破壊
- 確認: `CategoryCell` を呼んでいるのは `ReceiptTableRow` と `ReceiptMobileCard` の 2 箇所のみ (Engineer 1 がどちらも更新する)
- 検証: `grep -rn "CategoryCell" src/` で参照網羅

### R7: useBulkActions が返す setter (setEditDraft 等) を DashboardPage 直接呼んでいる箇所
- ImagePreviewModal の `onClose={() => b.setPreviewUrl(null)}` (DashboardPage 内、276 行付近) → これは行コンポーネント外なのでそのままで OK
- splitModal 等も同様

## 8. ビルド検証コマンド

各 Engineer 完了後、Reviewer は以下を実行:

```bash
DIR=$(ls -1 ~/Documents | grep "個" | head -1)
cd ~/Documents/"$DIR"/newWorld/receipt-scanner

# 1. 型 + ビルド
npm run build 2>&1 | tail -40

# 2. expandedIds の残存ゼロ確認 (cells.tsx と行コンポーネント)
grep -rn "expandedIds" src/pages/dashboard/

# 3. setEditDraftSafe の残存ゼロ確認
grep -rn "setEditDraftSafe" src/pages/dashboard/

# 4. React.memo の適用確認
grep -n "React.memo\|memo(" src/pages/dashboard/ReceiptTableRow.tsx src/pages/dashboard/ReceiptMobileCard.tsx

# 5. useMemo / useCallback の DashboardPage 適用確認
grep -n "useMemo\|useCallback" src/pages/DashboardPage.tsx

# 6. chunk size 確認
ls -la dist/assets/ | grep -i dashboard
```

期待:
- (1) build success
- (2) `cells.tsx` / `ReceiptTableRow.tsx` / `ReceiptMobileCard.tsx` での `expandedIds` 直接参照ゼロ (`isExpanded` のみ)
- (3) `setEditDraftSafe` 出現ゼロ
- (4) 両ファイルで `React.memo` ヒット
- (5) DashboardPage で `useMemo` / `useCallback` がヒット
- (6) DashboardPage chunk が Loop A 比 ±数 KB

## 9. ループ後フロー

1. Engineer 1, 2 並列実装 (sed/cat/grep のみ、Read/Edit/Write/GLM 禁止)
2. Reviewer 1 名集約 — 上記検証コマンドを実行 + 設計書 §4 との突合
3. Tech Lead 統合承認 — `git diff` 確認、approve 判定
4. デュアル push — newWorld + receipt-scanner subtree (master)

## 10. Engineer プロンプト案

### Engineer 1 への指示

```
あなたは receipt-scanner Loop B の Engineer 1 です。
設計書: .company/engineering/docs/2026-04-28-receipt-scanner-dashboard-loopb-design.md

担当ファイル:
- src/pages/dashboard/ReceiptTableRow.tsx
- src/pages/dashboard/ReceiptMobileCard.tsx

タスク:
1. 設計書 §4.1, §4.2 に従い、両ファイルの Props 型を新仕様に変更:
   - editingId/selected/expandedIds → isEditing/isSelected/isExpanded (boolean) に置換
   - setEditDraft の型を (d: ReceiptResult) => void に狭める
   - 不要な setEditDraft の null 許容を排除
2. 本体内の以下を修正:
   - `const isEditing = editingId === r.id;` の行を削除 (props で受ける)
   - `selected.has(r.id)` → `isSelected`
   - `expandedIds.has(r.id)` → `isExpanded`
   - `setEditDraftSafe = (d: ReceiptResult) => setEditDraft(d);` の行を削除
   - `<EditableCell setEditDraft={setEditDraftSafe} ... />` を `<EditableCell setEditDraft={setEditDraft} ... />` に変更
   - `<CategoryCell ... expandedIds={expandedIds} ... />` を `<CategoryCell ... isExpanded={isExpanded} ... />` に変更 (toggleExpand はそのまま)
3. ファイル末尾で React.memo ラップ:
   - export 名はそのまま `ReceiptTableRow` / `ReceiptMobileCard`
   - 本体は `Impl` サフィックスでローカル定数化、displayName を設定
   - 例:
     const ReceiptTableRowImpl: React.FC<ReceiptTableRowProps> = (props) => { ... };
     ReceiptTableRowImpl.displayName = 'ReceiptTableRow';
     export const ReceiptTableRow = React.memo(ReceiptTableRowImpl);

制約:
- Read / Edit / Write / GLM 禁止
- 使用可能ツール: sed / head / tail / cat / grep / cp のみ
- ファイル全体を cat で出力 → sed/awk で書き換え → cp で上書き、または heredoc で全文書き直し
- 完了後: grep で setEditDraftSafe / expandedIds.has が残っていないことを確認、結果を報告

cwd: ~/Documents/{個人仕事}/newWorld/receipt-scanner
(動的に: DIR=$(ls -1 ~/Documents | grep "個" | head -1) を使う)
```

### Engineer 2 への指示

```
あなたは receipt-scanner Loop B の Engineer 2 です。
設計書: .company/engineering/docs/2026-04-28-receipt-scanner-dashboard-loopb-design.md

担当ファイル:
- src/pages/dashboard/cells.tsx
- src/pages/DashboardPage.tsx

タスク A: cells.tsx
1. CategoryCellProps を変更:
   - `expandedIds: Set<string>;` を削除
   - `isExpanded: boolean;` を追加 (toggleExpand の直前に置く)
2. CategoryCell 本体の `expandedIds.has(receipt.id) ? '▾' : '▸'` を `isExpanded ? '▾' : '▸'` に変更
3. CategoryCell 自体は memo 化しない (素のまま)

タスク B: DashboardPage.tsx
1. import 行に `useMemo`, `useCallback` を追加
2. `const b = useBulkActions(...)` の直後に追加:
     const handleSetEditDraft = useCallback(
       (d: ReceiptResult) => b.setEditDraft(d),
       [b.setEditDraft],
     );
   ※ ReceiptResult を types/receipt から import 追加
3. 旧 `const rowProps = { ... };` ブロック (53-69 行付近) を削除し、以下に差し替え:
     const commonRowProps = useMemo(() => ({
       setEditDraft: handleSetEditDraft,
       setEditSectionId: b.setEditSectionId,
       setPreviewUrl: b.setPreviewUrl,
       startEdit: b.startEdit,
       cancelEdit: b.cancelEdit,
       saveEdit: b.saveEdit,
       toggleSelect: b.toggleSelect,
       toggleExpand: b.toggleExpand,
       openSplitModal: b.openSplitModal,
     }), [
       handleSetEditDraft,
       b.setEditSectionId, b.setPreviewUrl,
       b.startEdit, b.cancelEdit, b.saveEdit,
       b.toggleSelect, b.toggleExpand, b.openSplitModal,
     ]);
4. Desktop table と Mobile cards の map ブロックを下記に書き換え:
     {receipts.map((r) => {
       const isEditing = b.editingId === r.id;
       return (
         <ReceiptTableRow
           key={r.id}
           receipt={r}
           isEditing={isEditing}
           isSelected={b.selected.has(r.id)}
           isExpanded={b.expandedIds.has(r.id)}
           editDraft={isEditing ? b.editDraft : null}
           editSectionId={isEditing ? b.editSectionId : null}
           {...commonRowProps}
         />
       );
     })}
   Mobile も同様 (ReceiptMobileCard に置き換え)

制約:
- Read / Edit / Write / GLM 禁止
- 使用可能ツール: sed / head / tail / cat / grep / cp のみ
- 完了後: npm run build を実行し型エラーなしを確認、結果を報告

cwd: ~/Documents/{個人仕事}/newWorld/receipt-scanner
```

## 11. まとめ

- 並列: **Engineer 2 名**
- 設計書パス: `.company/engineering/docs/2026-04-28-receipt-scanner-dashboard-loopb-design.md`
- カスタム propsAreEqual は不要 (DashboardPage 側で props を行視点スカラー化することで shallow compare が完璧に効く)
- useBulkActions は無変更 (既に useCallback 完備)
- 編集即時反映は `isEditing===true` の行に `editDraft` を渡し続ける限り保たれる
