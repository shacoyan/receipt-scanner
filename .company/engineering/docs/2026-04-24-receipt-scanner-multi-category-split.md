# receipt-scanner: 1レシート複数勘定科目分割（Phase 1 + Phase 2 同時実装）

- 起票日: 2026-04-24
- 対象リポジトリ: `receipt-scanner`
- Tech Lead: 設計のみ。実装は Engineer（GLM）。
- Engineer 制約: **Read ツール禁止**（system-reminder 誤検知回避）。`Bash cat` / `Grep` / `Glob` / `Write` / `Edit` のみで作業する。

---

## 1. 概要 / ゴール

1枚のレシートを **複数の勘定科目に按分して freee 取引として登録** できるようにする。分割は任意で、デフォルト（単一科目）は従来通り1行登録。

### 代表シナリオ
- コンビニで「おにぎり（食品=軽減8%=仕入高）」と「ボールペン（標準10%=消耗品費）」を同時購入。
  - 現状: 合計金額を1行・仕入高・税10%固定で登録 → 実態と乖離。
  - 目標: AI が明細を読み取り `splits: [{category:仕入高, amount:X, tax_code:137}, {category:消耗品費, amount:Y, tax_code:136}]` を生成し、freee `details[]` に2行として登録。

### ゴール（DoD 要約）
1. AI が自動で「分割すべきか」を判断する。分割不要なレシートは従来と同一の単一行で登録される。
2. 分割ありのレシートは freee で `details[]` が2行以上の取引として作成される（部門 section_id は全行に適用）。
3. 確認画面（ConfirmPage）で人間が分割を追加・編集・削除・金額按分でき、合計バリデーションが機能する。
4. ダッシュボードで「分割済みレシート」を一目で判別できる（バッジ表示）。
5. 既存レシート（`result_json.splits` なし）は従来通りに動作する（後方互換）。

---

## 2. データモデル（DB マイグレーション不要・JSONB 拡張のみ）

### Before（現状の result_json）
```json
{
  "date": "2026-04-20",
  "amount": 1200,
  "store": "セブンイレブン",
  "category": "仕入高"
}
```

### After（拡張後の result_json）
```json
{
  "date": "2026-04-20",
  "amount": 1200,
  "store": "セブンイレブン",
  "category": "仕入高",
  "tax_code": 137,
  "splits": [
    { "category": "仕入高", "amount": 800, "tax_code": 137, "description": "食品" },
    { "category": "消耗品費", "amount": 400, "tax_code": 136, "description": "文具" }
  ]
}
```

### フィールド仕様（**API コントラクト・厳守**）

| キー | 型 | 必須 | 意味 |
|---|---|---|---|
| `date` | `string (YYYY-MM-DD)` | 必須 | 発行日 |
| `amount` | `number` | 必須 | **総額（splits がある場合は splits の合計と一致すること）** |
| `store` | `string` | 必須 | 店名（正規化済み） |
| `category` | `string` | 条件付き必須 | **splits なしの場合の科目**。splits ありの場合は代表科目（最大金額の行の category）を入れる（UI バッジ用）。 |
| `tax_code` | `number` | オプショナル | **splits なしの場合の税区分**。省略時は `136`（10%標準）。splits ありの場合は無視。 |
| `splits` | `Array<SplitItem>` | オプショナル | 存在すれば分割登録。長さ 0 や 1 の場合は `splits` キーごと除去すること（UI/バックエンド両方の整合性のため）。 |

### `SplitItem` 仕様
```ts
interface SplitItem {
  category: string;   // CATEGORY_MAP のキーのいずれか（register.js 側）
  amount: number;     // 正整数（1以上）
  tax_code: number;   // 136 (10%) | 137 (軽減8%) のいずれか（Phase 1 時点）
  description?: string; // 摘要。空文字/undefined 可。freee details[].description に入れる
}
```

### 不変条件（invariant）
1. `splits` が存在し要素数 ≥ 2 のとき: `Σ split.amount === amount`（厳密一致）。
2. `splits` は要素数 1 を許容しない（意味がない。単一行は splits キーを省略する）。
3. `tax_code` は `136` または `137` のみ許容（Phase 1）。不明値は 136 にフォールバック。
4. `category` は以下のリストのいずれかのみ（現行と同一）:
   `消耗品費 / 交通費 / 接待交際費 / 会議費 / 通信費 / 雑費 / 仕入高`
5. 既存レシートは `splits` キーを持たないため、`splits === undefined` を「単一科目モード」とみなす。`null` も同様扱い。

---

## 3. 分割戦略（4チーム並列＋統合）

| チーム | 担当ファイル | 依存 | 並列度 |
|---|---|---|---|
| **Aチーム** | `api/process.js`（Claude プロンプト拡張・result_json スキーマ） | なし（API コントラクトは本設計書で確定） | 並列可 |
| **Bチーム** | `api/register.js`（details 展開・tax_code 反映・合計バリデーション） | 本設計書の API コントラクトのみ | 並列可 |
| **Cチーム** | `src/pages/ConfirmPage.tsx`（分割 UI） | 本設計書の API コントラクト | 並列可 |
| **Dチーム** | `src/pages/DashboardPage.tsx`（バッジ表示・編集 UI 対応） | 本設計書の型定義 | 並列可 |
| **統合（Eチーム）** | ビルド通し・型チェック・API コントラクト検証・E2E サニティ | A/B/C/D の完了後 | 直列 |

**競合リスク**: なし。4チームは異なるファイルを触る。唯一の接点は `result_json` スキーマだが本設計書で固定済み。

---

## 4. 各チームのタスク詳細

### 4.1 Aチーム — `api/process.js`

#### 変更点
1. プロンプト拡張: 「分割判断」と「税区分判定」を Claude に行わせる。
2. `resultJson` 構築ロジックで `splits` / `tax_code` を受理。
3. 既存のバリデーション（必須項目・日付範囲・金額上限）は `amount` ベースで従来通り動作させる。
4. 金額上限チェックの閾値（仕入高10万・その他3万）は「総額 amount」に対して適用（splits の個別行ではなく総額で判定。現仕様と同じ挙動を維持）。
5. 除外店舗チェックも従来通り `store` で判定。

#### 新プロンプト案（差分・追加セクションのみ掲載）

既存の「## 勘定科目」「## 業態→勘定科目の判定テーブル」はそのまま残し、以下を追加/置換する。

```text
## 【新規】明細分割ルール（重要）
レシートには複数の商品カテゴリが混在することがあります。以下を判定して出力してください。

### 判定基準
- コンビニ / スーパー / ドラッグストア等の複合業態でレシートテープに品目明細が列挙されている場合、
  各品目を以下の2軸で分類してください:
    1. 勘定科目（前掲の7種類から選択）
    2. 税区分（`tax_code`: 136=標準10%, 137=軽減8%）
       - 軽減8%(137): **飲食料品**（酒類・外食を除く）、新聞定期購読。ほぼ「食品・飲料（テイクアウト/持ち帰り含む）」と読み替えて良い。
       - 標準10%(136): 上記以外すべて（日用品・雑貨・酒類・外食・交通・通信 等）。

### 分割の可否
- 全品目が **同一の勘定科目 かつ 同一の税区分** の場合: 分割しない。単一モードで返す。
- 勘定科目または税区分が **2種類以上** 混在する場合: splits 配列で返す。
- ただし少額端数（1品目 100 円未満かつ総額の5%未満）は主たる科目に吸収して良い。明細が細かすぎる場合は最大5行程度に集約する。
- 正式領収書（品目明細なし）の場合は分割不可。単一モードで返す。
- 飲食店でのイートイン（接待交際費・会議費）は原則単一モード。税区分は 136（10%）。

### 金額整合性（最重要）
- splits を返す場合、Σ split.amount は必ず amount（総額・税込）と一致させること。
- 1円でもずれそうな場合は、最後の行で端数調整する（主たる科目の行に差分を寄せる）。
- どうしても一致できない場合は splits を返さず単一モードにフォールバックする。

### 税区分の付与
- 単一モード: `tax_code` を1つだけ返す（食品専門店・スーパー・コンビニで食品主体なら 137、それ以外は 136）。
- 分割モード: 各 split に tax_code を付ける。全 split が同一 tax_code なら本来は単一モードで良い（前項参照）。

## 出力形式（厳守・更新版）
以下のJSON1オブジェクトのみを出力。前置き・解説・コードフェンス・末尾テキストを一切付けない。

### 単一モード（分割なし）
{"date":"YYYY-MM-DD","amount":数値,"store":"店名","category":"勘定科目","tax_code":136}

### 分割モード
{"date":"YYYY-MM-DD","amount":数値,"store":"店名","category":"代表科目（splits 内の最大金額の category）","tax_code":136,"splits":[{"category":"仕入高","amount":800,"tax_code":137,"description":"食品"},{"category":"消耗品費","amount":400,"tax_code":136,"description":"文具"}]}

※ 代表 category/tax_code はダッシュボード表示用。splits がある場合は splits が真実。
※ 分割時も tax_code フィールドは（UI 表示用に）代表値を入れて返すこと。
```

#### result_json 構築ロジック（擬似コード）

```js
// 既存の parsed = JSON.parse(jsonStr) の直後に以下を差し込む

const rawSplits = Array.isArray(parsed.splits) ? parsed.splits : null;

// splits 正規化
let normalizedSplits = null;
if (rawSplits && rawSplits.length >= 2) {
  const cleaned = rawSplits
    .map((s) => ({
      category: typeof s.category === 'string' ? s.category : null,
      amount: typeof s.amount === 'number' ? s.amount
             : (s.amount ? parseInt(s.amount, 10) : null),
      tax_code: (s.tax_code === 136 || s.tax_code === 137) ? s.tax_code : 136,
      description: typeof s.description === 'string' ? s.description : '',
    }))
    .filter((s) => s.category && typeof s.amount === 'number' && s.amount > 0);

  if (cleaned.length >= 2) {
    const splitSum = cleaned.reduce((a, b) => a + b.amount, 0);
    // 総額との差分が1円以内なら最大額の行に寄せる
    const totalAmount = typeof parsed.amount === 'number' ? parsed.amount : parseInt(parsed.amount, 10);
    const diff = totalAmount - splitSum;
    if (Math.abs(diff) <= 5 && cleaned.length > 0) {
      // 最大額の行に差分を加算
      const idx = cleaned.reduce((maxIdx, cur, i, arr) => cur.amount > arr[maxIdx].amount ? i : maxIdx, 0);
      cleaned[idx].amount += diff;
    }
    // 最終チェック: 一致しなければ splits は捨てる
    const finalSum = cleaned.reduce((a, b) => a + b.amount, 0);
    if (finalSum === totalAmount) {
      normalizedSplits = cleaned;
    }
  }
}

const resultJson = {
  date: parsed.date || null,
  amount: /* 既存ロジックそのまま */,
  store: normalizeStoreName(parsed.store) || null,
  category: parsed.category || null,
  tax_code: (parsed.tax_code === 136 || parsed.tax_code === 137) ? parsed.tax_code : 136,
};
if (normalizedSplits) {
  resultJson.splits = normalizedSplits;
}
```

#### DoD（Aチーム）
- [ ] プロンプトに上記分割ルールが追記されている。
- [ ] `resultJson.tax_code` が常に数値（136 or 137）で入る。
- [ ] splits があるときのみ `resultJson.splits` が存在し、必ず長さ ≥ 2。
- [ ] Σ split.amount !== amount のときは splits を捨てる（単一モードにフォールバック）。
- [ ] 既存の除外店舗チェック・必須項目チェック・日付範囲・金額上限チェックがすべて従来通り動く。

---

### 4.2 Bチーム — `api/register.js`

#### 変更点
1. request body から `splits` と `tax_code` を受理。
2. `details[]` を動的構築。splits があれば展開、無ければ従来通り1行。
3. `tax_code` は各行ごとに個別設定（splits 時は split.tax_code、単一時は body.tax_code || 136）。
4. `section_id` は全 details 行に適用する。
5. 合計額バリデーション: `splits` 受信時に `Σsplit.amount === amount` を入口でチェック。不一致なら 400。
6. CATEGORY_MAP は全 split 行のマッピングに使用。

#### 擬似コード（核心部分）

```js
const { date, amount, store, category, receipt_id, section_id, tax_code, splits } = request.body;

// 既存のバリデーションに追加
if (splits !== undefined && splits !== null) {
  if (!Array.isArray(splits) || splits.length < 2) {
    errors.push('splits は 2 件以上の配列である必要があります');
  } else {
    const splitSum = splits.reduce((a, s) => a + (typeof s.amount === 'number' ? s.amount : 0), 0);
    if (splitSum !== amount) {
      errors.push(`分割合計が総額と一致しません（分割合計:${splitSum} / 総額:${amount}）`);
    }
    for (const s of splits) {
      if (!s.category || !CATEGORY_MAP[s.category]) {
        errors.push(`分割行の勘定科目が不正です: ${s.category}`);
      }
      if (typeof s.amount !== 'number' || s.amount <= 0) {
        errors.push('分割行の金額が不正です');
      }
      if (s.tax_code !== 136 && s.tax_code !== 137) {
        errors.push(`分割行の税区分が不正です: ${s.tax_code}`);
      }
    }
  }
}

// ... 既存の freee partner 解決・section 解決はそのまま ...

// details 構築
const buildDetail = (item) => {
  const d = {
    account_item_id: CATEGORY_MAP[item.category] || DEFAULT_ACCOUNT_ITEM_ID,
    amount: item.amount,
    description: item.description || `${store || ''}`,
    tax_code: (item.tax_code === 136 || item.tax_code === 137) ? item.tax_code : 136,
  };
  if (freeSectionId) d.section_id = freeSectionId;
  return d;
};

const detailsArray = (Array.isArray(splits) && splits.length >= 2)
  ? splits.map(buildDetail)
  : [buildDetail({
      category,
      amount,
      description: store || '',
      tax_code: (tax_code === 136 || tax_code === 137) ? tax_code : 136,
    })];

const dealBody = {
  company_id: companyId,
  issue_date: date,
  type: 'expense',
  details: detailsArray,
  payments: [{
    date,
    from_walletable_type: 'wallet',
    from_walletable_id: WALLET_ID,
    amount, // 支払合計は総額のまま
  }],
};
```

#### DoD（Bチーム）
- [ ] `splits` が無い既存 body で従来通り動作。
- [ ] `splits` があるとき details[] に正しく展開される。
- [ ] `section_id` が全 details 行に適用される。
- [ ] `tax_code` が行ごとに 136/137 で入る。
- [ ] Σsplit.amount !== amount のとき 400 で弾く。
- [ ] 不正カテゴリ・税区分を 400 で弾く。
- [ ] `payments[0].amount` は総額のまま。
- [ ] 既存の freee_sent_at / freee_deal_id 更新ロジックは変更なし。

---

### 4.3 Cチーム — `src/pages/ConfirmPage.tsx`

#### 現状の要件確認（Bash grep 調査タスク）
Engineer には実装前に以下を `Grep` で確認させる:
```bash
Grep pattern="analyses" path="/Users/usr0103301/Documents/個人仕事/newWorld/receipt-scanner/src" output_mode="content" -n=true
Grep pattern="ConfirmPage" path="/Users/usr0103301/Documents/個人仕事/newWorld/receipt-scanner/src" output_mode="content" -n=true
Grep pattern="memo|description" path="/Users/usr0103301/Documents/個人仕事/newWorld/receipt-scanner/src/pages/ConfirmPage.tsx" output_mode="content" -n=true
```
（Tech Lead メモ: 現状 ConfirmPage は `AnalysisResult[]` を location.state 経由で受け取り、各レシート単位の FormState を管理している。`memo` フィールドがあるが、これは任意メモであり freee には未送信。今回は `splits` モードと併存させる。）

#### UI 設計

```
┌─ レシート 1 / 合計3 ────────────────────────┐
│ 日付: [2026-04-20]                          │
│ 金額(総額): [¥1,200]                        │
│ 店舗: [セブンイレブン]                       │
│                                             │
│ ── 勘定科目 ──────────────────────────────  │
│                                             │
│ [ ] 分割する  (off = 単一モード)             │
│                                             │
│ ▼ 単一モードのとき                            │
│   勘定科目: [仕入高 ▼]                       │
│   税区分:   [ 10% 標準 ▼ / 8% 軽減 ]         │
│                                             │
│ ▼ 分割モードのとき                            │
│   ┌─ 行 1 ──────────────────────────────┐  │
│   │ 金額 [800] 科目[仕入高▼] 税[8%▼]     │  │
│   │ 摘要 [食品]                   [×削除] │  │
│   └────────────────────────────────────┘  │
│   ┌─ 行 2 ──────────────────────────────┐  │
│   │ 金額 [400] 科目[消耗品費▼] 税[10%▼]  │  │
│   │ 摘要 [文具]                   [×削除] │  │
│   └────────────────────────────────────┘  │
│   [+ 行を追加]  [残額を自動で次の行に按分]  │
│                                             │
│   合計: ¥1,200 / ¥1,200 ✓一致               │
│   （不一致なら 赤文字で ✗ 不一致 ¥-50）      │
│                                             │
│ メモ: [...]                                 │
└────────────────────────────────────────────┘
```

#### 型拡張（Cチーム内部の TypeScript 型）

```ts
interface SplitItem {
  category: string;
  amount: number;
  tax_code: 136 | 137;
  description: string;
}

interface FormState {
  date: string;
  amount: number;           // 総額
  store: string;
  category: string;         // 単一モード時の科目 / 分割時の代表
  tax_code: 136 | 137;      // 単一モード時
  memo: string;             // 任意
  splitMode: boolean;       // UI 状態
  splits: SplitItem[];      // splitMode=true のときだけ使う
}

// AnalysisResult の拡張（入力側）
interface AnalysisResult {
  date: string | null;
  amount: number | null;
  store: string | null;
  category: string | null;
  tax_code?: number | null;
  splits?: SplitItem[] | null;
  memo: string | null;
}
```

#### 初期化ロジック

```ts
const initialForm = (a: AnalysisResult): FormState => {
  const hasSplits = Array.isArray(a.splits) && a.splits.length >= 2;
  return {
    date: a.date ?? '',
    amount: a.amount ?? 0,
    store: a.store ?? '',
    category: a.category ?? '雑費',
    tax_code: (a.tax_code === 137 ? 137 : 136),
    memo: a.memo ?? '',
    splitMode: hasSplits,
    splits: hasSplits
      ? a.splits!.map((s) => ({
          category: s.category,
          amount: s.amount,
          tax_code: (s.tax_code === 137 ? 137 : 136),
          description: s.description ?? '',
        }))
      : [],
  };
};
```

#### 送信ペイロード構築

```ts
const buildPayload = (f: FormState) => {
  const base = {
    date: f.date,
    amount: f.amount,
    store: f.store,
    category: f.splitMode
      // 分割時の代表 category は最大金額の行
      ? f.splits.reduce((max, s) => s.amount > max.amount ? s : max, f.splits[0]).category
      : f.category,
    tax_code: f.splitMode ? 136 : f.tax_code,  // 代表値（使われないが整合性のため）
  };
  if (f.splitMode && f.splits.length >= 2) {
    return { ...base, splits: f.splits };
  }
  return base;
};
```

#### 分割操作

- 「分割する」チェック時: 現状の単一科目をコピーして2行に分け、金額を総額の半々に初期按分（端数は最初の行へ）。
- 「+ 行を追加」: 新行 `{category:'雑費', amount:0, tax_code:136, description:''}` を追加。
- 「× 削除」: 行を削除。残りが 1 行になったら splitMode=false に戻す（UX 自動切替）。
- 「残額を自動按分」: 最後の行に `amount - Σ(他の行)` を入れる。

#### バリデーション（送信時）

```ts
const validateForm = (f: FormState): string | null => {
  if (f.splitMode) {
    if (f.splits.length < 2) return '分割モードでは2行以上が必要です';
    const sum = f.splits.reduce((a, s) => a + s.amount, 0);
    if (sum !== f.amount) return `分割合計(¥${sum}) が総額(¥${f.amount}) と一致しません`;
    for (const s of f.splits) {
      if (!s.category) return '全ての行に勘定科目を選択してください';
      if (s.amount <= 0) return '金額は1円以上で指定してください';
    }
  }
  return null;
};
```

送信ボタンを押したときに `forms` 全体を検証し、1件でも不一致があれば送信中断＋当該レシートをスクロール強調。

#### 税区分セレクト

```ts
const TAX_OPTIONS = [
  { value: 136, label: '10% 標準' },
  { value: 137, label: '8% 軽減（食品）' },
];
```

#### DoD（Cチーム）
- [ ] `analyses` に `splits` が入っていれば初期表示で分割モード ON。
- [ ] 「分割する」トグルで UI が切り替わる。
- [ ] 行追加・削除・金額編集・科目選択・税区分選択が動く。
- [ ] 合計一致バッジ（reactive）が表示される。
- [ ] 不一致のまま送信不可（ボタン disabled もしくは警告で止める）。
- [ ] 送信ペイロードに `splits` が正しく入る（長さ1や0になったら splits キー削除）。
- [ ] 既存の単一モードフロー（memo / category 単体）が壊れない。
- [ ] 税区分セレクトが単一モード・分割モード両方で動作する。

---

### 4.4 Dチーム — `src/pages/DashboardPage.tsx`

#### 変更点
1. `ReceiptResult` 型を拡張（`tax_code?`, `splits?`）。
2. テーブル・カード表示: `splits` があるとき「分割 N件」バッジを出す。
3. 「勘定科目」列の表示:
   - `splits` なし: 従来通り `result_json.category`。
   - `splits` あり: 主たる科目（最大金額の行）を表示 + 「他 N件」補足。
4. 金額列: 総額（`amount`）を従来通り表示。変更なし。
5. インライン編集（`startEdit` / `editDraft`）: **Phase 2 範囲では splits の編集を許可しない**（MVP: 単一モードの編集のみ）。分割済みレシートの編集ボタンを押したら「このレシートは分割登録済みです。編集は確認画面から再度やり直してください」のツールチップを出す。
   - 実装簡略化のため、`result_json.splits` が存在する行では編集ボタンを非表示（または disabled + title 属性）にする。
6. `sendToFreee` の body は現状 `...r.result_json` なので、`splits` / `tax_code` が自動的に含まれる。**ここは変更不要**（Bチーム側が受け取る）。

#### 擬似コード（表示部）

```tsx
// 型拡張
interface ReceiptResult {
  date: string;
  amount: number;
  store: string;
  category: string;
  tax_code?: number;
  splits?: Array<{
    category: string;
    amount: number;
    tax_code: number;
    description?: string;
  }>;
}

// バッジヘルパー
const renderSplitBadge = (r: Receipt) => {
  const splits = r.result_json?.splits;
  if (!splits || splits.length < 2) return null;
  return (
    <span
      className="ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800"
      title={splits.map(s => `${s.category} ¥${s.amount.toLocaleString()}`).join(' / ')}
    >
      分割{splits.length}件
    </span>
  );
};

// カテゴリ列のレンダリングを差し替え
const renderCategoryCell = (r: Receipt, isEditing: boolean) => {
  const splits = r.result_json?.splits;
  if (splits && splits.length >= 2) {
    const main = splits.reduce((m, s) => s.amount > m.amount ? s : m, splits[0]);
    return (
      <span className="text-gray-700">
        {main.category}
        <span className="ml-1 text-xs text-gray-400">他{splits.length - 1}件</span>
      </span>
    );
  }
  return renderEditableCell(r.result_json?.category || '-', 'category', isEditing);
};

// 編集ボタンの条件変更
const canEdit =
  (r.status === 'done' || r.status === 'error') &&
  !!r.result_json &&
  !(r.result_json?.splits && r.result_json.splits.length >= 2);
```

#### DoD（Dチーム）
- [ ] 分割済みレシートにバッジ「分割N件」が表示される（tooltip に内訳）。
- [ ] カテゴリ列が「主科目 + 他N件」表示になる。
- [ ] 分割済みレシートではインライン編集ボタンが無効化される。
- [ ] `sendToFreee` が splits 付きの body を自動生成できる（= 現状コード無変更でOK）。
- [ ] 既存の単一モードレシート表示が壊れない。

---

### 4.5 統合（Eチーム）

1. `npm run build` がエラーなく通る。
2. TypeScript 型チェック全通過。
3. API コントラクト整合性確認:
   - Aチームが出す result_json の形 == Bチームが受ける body の形 == Cチームが送る payload の形。
   - 特に `tax_code` / `splits` のキー名・型・数値範囲が一致しているか Grep で検証。
4. E2E サニティ（手動 or Playwright）:
   - a) 単一モードのレシートをアップロード → 従来通り freee 登録される。
   - b) 分割モードのレシートをアップロード → ConfirmPage で分割 UI が初期表示される。
   - c) 確認画面で分割追加 → 合計一致でのみ送信可。
   - d) Dashboard で「分割N件」バッジが出る。
   - e) freee 送信後、実際に details が 2 行で作成されている（freee UI 目視）。
5. ロールバック観点: `result_json.splits` を運用後に削除したくなった場合、DB 側はフィールド消えれば自動で単一モードに戻る（後方互換）。

---

## 5. API コントラクト（確定仕様・全チーム参照）

### 5.1 `api/process.js` が `receipts.result_json` に書き込む形

```json
// 単一モード
{"date":"YYYY-MM-DD","amount":1200,"store":"セブンイレブン","category":"仕入高","tax_code":137}

// 分割モード
{"date":"YYYY-MM-DD","amount":1200,"store":"セブンイレブン","category":"仕入高","tax_code":137,
 "splits":[
   {"category":"仕入高","amount":800,"tax_code":137,"description":"食品"},
   {"category":"消耗品費","amount":400,"tax_code":136,"description":"文具"}
 ]}
```

### 5.2 フロント → `api/register.js` の request body

```ts
// 単一モード
{ date, amount, store, category, tax_code?, receipt_id?, section_id? }

// 分割モード
{ date, amount, store, category, tax_code?, splits: SplitItem[], receipt_id?, section_id? }
```

### 5.3 freee へ送る dealBody の details[]

```js
// 単一モード → 1行
details: [{ account_item_id, amount, description, tax_code, section_id? }]

// 分割モード → N行（全行に同一 section_id）
details: [
  { account_item_id: A_ID, amount: 800, description: '食品', tax_code: 137, section_id? },
  { account_item_id: B_ID, amount: 400, description: '文具', tax_code: 136, section_id? },
]
```

---

## 6. DoD / テスト観点

### 6.1 受け入れテストシナリオ

| # | ケース | 期待動作 |
|---|---|---|
| T1 | 単一科目コンビニ（全て食品） | tax_code=137, splits なし。freee に 1 行登録。 |
| T2 | 単一科目カフェ（会議費） | tax_code=136, splits なし。freee に 1 行登録。 |
| T3 | コンビニ（食品+日用品 混在） | splits 2 行（137+136）。Σ=amount。ConfirmPage で両行表示。freee に 2 行登録。 |
| T4 | 正式領収書（明細なし） | splits なし（単一モード強制）。 |
| T5 | 既存レシート（splits なしの旧データ） | ダッシュボードで従来通り表示。編集・送信可能。 |
| T6 | ConfirmPage で分割合計を誤って変更 | 「¥-50 不一致」の赤バッジ表示。送信ボタン disabled。 |
| T7 | ConfirmPage で「分割する」OFF → ON → OFF | 単一モードの値が保持される or リセットされる（仕様確定: **OFF に戻したら splits は破棄、単一モードの初期値を保持**）。 |
| T8 | 分割済みを freee に送信 | freee 取引の details が 2 行で作成、section_id が両行に適用される。 |
| T9 | 分割済みをダッシュボードで編集 | 編集ボタンが無効化されている（Phase 2 範囲外）。 |
| T10 | AI が誤判定で splits 合計ズレ | process.js で splits を捨てて単一モードにフォールバック（result_json.splits 不存在）。 |
| T11 | 除外店舗の分割判定 | 除外店舗チェックが先に走り、error で止まる（分割は関係ない）。 |
| T12 | 金額上限超過（仕入高10万超） | 従来通り error。splits は付いても良いが status=error になる。 |

### 6.2 AI 精度の検証シナリオ（人手目視）

以下のサンプル画像を用意し、process.js の再判定で splits が期待通り生成されるか確認する（対象: receipt-scanner 運用中の実データから 5-10 件抽出）。

- セブンイレブン（食品+文具）
- ファミマ（飲料+たばこ）※ たばこは 10%
- ダイソー（100円均一・複数品目・全て 10% → 単一モード期待）
- スーパー（生鮮食品のみ → 単一モード・137 期待）
- リカーマウンテン（酒類のみ → 単一モード・136 期待、軽減対象外）
- 領収書形式（明細なし → 単一モード強制）

---

## 7. リスクと対策

| リスク | 対策 |
|---|---|
| **AI 誤判定（分割すべきでないのに分割する）** | `process.js` の正規化ロジックで合計ズレ時は splits を捨てる。ConfirmPage で人手修正可。 |
| **AI 誤判定（分割すべきなのに単一）** | ConfirmPage で手動分割 UI を提供済み。ユーザーに負担を求めて良い。 |
| **税区分の誤判定（たばこ/酒を軽減にしてしまう）** | プロンプトで「酒類・たばこ・外食は軽減対象外」と明記。ConfirmPage で手動修正可。Phase 3 で判定テーブル強化。 |
| **既存レシートの再判定動作（Rerun）** | 再判定すると splits が新しく付く可能性あり。既存承認済みかつ freee 送信済みの再判定は警告ダイアログが既に存在（Dashboard の rerunSelected）。追加警告不要。 |
| **合計ズレによる freee 登録拒否** | register.js の入口で 400 で弾く（ネットワーク・API コール無駄打ち防止）。 |
| **section_id の適用漏れ** | register.js の buildDetail で freeSectionId を必ず全行に入れる。 |
| **長大な splits（10行超）で UI が重い** | process.js 側で「最大5行に集約」とプロンプト指示。ConfirmPage は理論上無制限だが実務上問題なし。 |
| **freee 側の tax_code 137 未対応** | freee 公式の標準コード表に 137（軽減8%）は存在する。既存 freee company で有効なのを統合テストで確認。不在時は 136 フォールバック（register.js のバリデーション分岐）。 |
| **Phase 2 範囲で Dashboard 編集を絞る判断** | 仕様として明記（Dチーム DoD）。Phase 3 で分割編集 UI を追加予定。 |

---

## 8. Phase 分割（本タスクのスコープ）

- **Phase 1 + Phase 2 同時実装** = 本ドキュメント全範囲。
  - Phase 1 相当: AI 自動分割（process.js 拡張）+ register.js 展開。
  - Phase 2 相当: ConfirmPage 分割 UI + Dashboard バッジ表示。
- **Phase 3（本タスク外）**: Dashboard 上での分割編集、不課税/非課税の税区分対応、税率 5%(食品テイクアウト外の特例) 対応、分割履歴の差分管理。

---

## 9. 作業順序（Engineer への指示）

1. **ブランチ作成**: `feature/multi-category-split`（orig master から切る）。
2. **並列実装**: A / B / C / D を同時進行可能。GLM にチーム単位でプロンプト発行。
3. **Engineer 注意**: Read ツール禁止。ファイル閲覧は `Bash cat <absolute-path>` か `Grep` で行うこと。編集は `Write`/`Edit` で。
4. **Reviewer レビュー**: 各チーム成果物を Reviewer にチェックさせる（API コントラクト準拠・TypeScript 型・後方互換）。
5. **統合（Eチーム）**: `npm run build` + 型チェック + 手動 E2E サニティ（本番 Supabase は触らず、ローカル or プレビュー環境）。
6. **Tech Lead 最終承認**: `git diff` を俯瞰して approved / 差し戻しを判定。
7. **commit & push**: 両リポジトリ（newWorld + receipt-scanner 専用）に push。

---

## 10. 参考: 現状コードの該当行（調査済み・Tech Lead 調査結果）

- `api/process.js` L168〜L265: 現行プロンプト。新プロンプトは末尾に「分割ルール」「出力形式更新版」を追加する形でマージ。
- `api/process.js` L332〜L338: `resultJson` 構築箇所。ここに tax_code / splits の取り込みロジックを追加。
- `api/register.js` L3〜L12: CATEGORY_MAP（7科目マッピング済み）。変更不要。
- `api/register.js` L14〜L24: SECTION_MAP。変更不要。
- `api/register.js` L27: `TAX_CODE = 136` 固定定数。今後は使わない（削除 or `DEFAULT_TAX_CODE` にリネーム）。
- `api/register.js` L62: request body 分解。ここに `tax_code, splits` を追加。
- `api/register.js` L207〜L227: dealBody 組み立て。detailsArray ロジックに置換。
- `src/pages/ConfirmPage.tsx` L4〜L18: AnalysisResult / FormState 型。ここに splits / tax_code / splitMode を追加。
- `src/pages/ConfirmPage.tsx` L24〜L32: CATEGORIES 定数。TAX_OPTIONS を追加。
- `src/pages/ConfirmPage.tsx` L41〜L51: forms 初期化。initialForm に差し替え。
- `src/pages/ConfirmPage.tsx` L71〜L95: handleRegisterAll。buildPayload 経由に差し替え + validateForm。
- `src/pages/ConfirmPage.tsx` L111〜L180: JSX 各レシートカード。splitMode 切替 UI を追加。
- `src/pages/DashboardPage.tsx` L7〜L12: `ReceiptResult` 型。拡張。
- `src/pages/DashboardPage.tsx` L202〜L207: `startEdit`。splits 存在時は早期 return。
- `src/pages/DashboardPage.tsx` L362〜L404: `renderEditableCell`。変更なし（category 列の外側で制御）。
- `src/pages/DashboardPage.tsx` L407〜L535 / L538〜L671: renderTableRow / renderMobileCard。カテゴリ列を `renderCategoryCell` に置換、バッジ追加。

以上。
