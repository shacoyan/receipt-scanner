# 設計書 v6: receipt-scanner 店舗名正規化ロジック強化

- 日付: 2026-04-24
- プロジェクト: receipt-scanner
- 作成: Tech Lead
- 対象バージョン: v5 → v6
- 関連ファイル:
  - 既存: `/Users/usr0103301/Documents/個人仕事/newWorld/receipt-scanner/api/process.js`
  - 新規: `/Users/usr0103301/Documents/個人仕事/newWorld/receipt-scanner/scripts/renormalize-stores.mjs`

---

## 1. 概要

### 何を
`api/process.js` の `STORE_NORMALIZATION_RULES` と `normalizeStoreName()` を拡張し、
1. セブンイレブンの正規形をハイフンなし統一
2. アークランズ / アークランド の表記揺れ統一
3. **末尾「〜店」を可変長で一律除去**（商店／商会は保護）

加えて既存 `done` レコードを再正規化する one-shot スクリプト `scripts/renormalize-stores.mjs` を作成する。

### なぜ
v5 リリース後の実データ 62 件集計で以下が判明。

- セブンイレブンは 25 件に集約できたが `セブン-イレブン〇〇店` のように支店名付きのまま残り、チェーン単位の金額集計が困難。
- `アークランズ株式会社` と `アークランド株式会社` が別チェーン扱いで分散。
- オーナー決定: **パターンA（末尾「〜店」一律除去）+ 新ルール追加** で統一する。

### 非目標
- 新規 LLM 呼び出しによる再抽出は **行わない**（コスト増回避）。
- `result_json.store` 以外のフィールド（金額、日付、勘定科目）は変更対象外。
- v6 時点でのチェーン一覧の網羅追加は行わない（アークランズのみ追加、他は継続観察）。

---

## 2. 分割戦略

本タスクは **単一ファイル + 付随スクリプト1本** の小粒タスクのため分割効果が薄い。単一チーム（A）に集約し、Reviewer → D チーム → Tech Lead の順で直列処理する。

| チーム | 役割 | 対象 |
|---|---|---|
| A | 実装 | `api/process.js` 改修 + `scripts/renormalize-stores.mjs` 新規 |
| Reviewer | レビュー | A の成果物 |
| D チーム | 統合 | 単一ファイルのためコンフリクトなし・動作確認のみ |
| Tech Lead | 最終承認 | git diff + dry-run 出力検査 |

並列度: 1（同一ファイル・関数内改修）
依存関係: スクリプトは `api/process.js` から `normalizeStoreName` / `STORE_NORMALIZATION_RULES` を import するため、両者は同一コミットで一貫性を保つ。

---

## 3. チーム A 作業指示

### 3.1 `api/process.js` 改修

#### (a) `STORE_NORMALIZATION_RULES` の修正

- **セブンイレブン**: normalized を `'セブンイレブン'`（ハイフン削除）に変更。パターンも現在互換を保ちつつハイフン揺れを吸収。
  ```js
  {
    pattern: /^(セブン[‐ー\-–—−]?イレブン|7[-\s]?Eleven|SEVEN[-\s]?ELEVEN|アブゾー?イレブン|アクセブン[ー\-]?イレブン)/i,
    normalized: 'セブンイレブン',
  }
  ```
- **アークランズ / アークランド**: 新規ルール追加。
  ```js
  {
    pattern: /^(アークランズ|アークランド)/,
    normalized: 'アークランズ',
  }
  ```
- 既存ルール（ファミマ / ローソン / リカーマウンテン / ダイソー）は据え置き。
- ミニストップ / デイリー / 業務スーパー等は v6 では追加しない（末尾店除去で吸収可能なものは自動正規化される）。

#### (b) `normalizeStoreName()` 関数改修

現状ロジック: マッチ時は normalized + suffix、非マッチ時は trimmed をそのまま返却。

**v6 挙動**:
1. ルールマッチした場合
   - `${normalized}${suffix}` を生成（既存通り）
   - **生成結果に対しても末尾「〜店」除去ロジックを適用**
     - 理由: `セブンイレブン西心斎橋店` → `セブンイレブン` のように、チェーンマッチ済みでも接尾を消したい
2. ルール非マッチの場合
   - trimmed に対し末尾「〜店」除去を適用
3. 末尾「〜店」除去ロジック（`stripBranchSuffix`）
   - 末尾が「店」で終わる場合のみ処理
   - ただし「商店」「商会」は保護（※「商会」は末尾「店」ではないが念のため）
   - 除去対象: 空白区切りの最後のトークン、または末尾から可変長で「店」の手前の名詞相当文字列
   - 実装方針:
     - ステップ1: 末尾が `商店` なら何もしない（return as-is）
     - ステップ2: 末尾が `店` なら、スペース（半角/全角）区切りで最後のトークンを丸ごと除去
     - ステップ3: スペース区切りがない（空白なし）の場合、末尾の `店` 直前の連続文字（漢字/カナ/英数/記号中黒等、空白以外）を除去
     - ステップ4: 末尾に残る空白・中黒（`・` `・`）を trim

#### (c) 推奨実装（参考コード）

```js
/**
 * 末尾「〜店」を除去する。ただし「商店」は保護する。
 * - 空白区切りがある場合は最後のトークンを除去
 * - 空白がない場合は末尾「店」+直前の非空白文字列を除去（可変長）
 * - 「商店」で終わる文字列は変更しない
 */
function stripBranchSuffix(input) {
  if (!input || typeof input !== 'string') return input;
  let s = input.trim();
  if (!s.endsWith('店')) return s;
  // 「商店」保護
  if (/商店$/.test(s)) return s;

  // 空白区切り（半角/全角）で分割できる場合は最後のトークンを除去
  if (/[\s\u3000]/.test(s)) {
    const parts = s.split(/[\s\u3000]+/);
    const last = parts[parts.length - 1];
    if (last.endsWith('店') && !/商店$/.test(last)) {
      parts.pop();
      s = parts.join(' ').trim();
      // 末尾に中黒・記号が残った場合 trim
      return s.replace(/[・\-\s\u3000]+$/, '').trim();
    }
  }

  // 空白なし：末尾「店」の直前から可変長で除去
  // 「商」の直後の「店」は残す
  const re = /(?<!商)店$/;
  if (re.test(s)) {
    // 末尾 "店" を削り、さらに直前の固有名（地名等）も落とすかは判断が分かれる
    // v6 では「空白なしで末尾 店」のケースは「店」1文字のみ削る方針
    // 理由: 「久世福商店」→「久世福商店」保護、「リカーマウンテン畳屋町店」は
    //       現状ルール後の suffix として空白で区切って入ってくるため上の分岐で処理される
    s = s.replace(/(?<!商)店$/, '');
  }
  return s.replace(/[・\-\s\u3000]+$/, '').trim();
}

export function normalizeStoreName(rawStore) {
  if (!rawStore || typeof rawStore !== 'string') return rawStore;
  const trimmed = rawStore.trim();
  for (const rule of STORE_NORMALIZATION_RULES) {
    const m = trimmed.match(rule.pattern);
    if (m) {
      const matched = m[0];
      const suffix = trimmed.slice(matched.length).trimStart();
      const combined = suffix ? `${rule.normalized}${suffix}` : rule.normalized;
      return stripBranchSuffix(combined);
    }
  }
  return stripBranchSuffix(trimmed);
}
```

> **補足**: 期待結果「リカーマウンテン畳屋町店 → リカーマウンテン」を達成するには、suffix が `畳屋町店`（空白なし）で連結されるケースがある。この場合、上の実装では「空白なし末尾店」分岐に入り `畳屋町` が残ってしまう。
>
> そこで **ルールマッチ時は `combined` ではなく `rule.normalized` をベースに、suffix 側で `...店$` 形なら suffix を丸ごと破棄する** 最適化を追加する。
>
> 最終実装方針（確定版）:
> ```js
> if (m) {
>   const matched = m[0];
>   const suffix = trimmed.slice(matched.length).trimStart();
>   // suffix 自体が末尾「店」で終わっていたら（かつ商店でなければ）suffix 全体を破棄
>   if (suffix && /店$/.test(suffix) && !/商店$/.test(suffix)) {
>     return rule.normalized;
>   }
>   return suffix ? `${rule.normalized}${suffix}` : rule.normalized;
> }
> ```
> この方針で、「セブンイレブン西心斎橋店」「リカーマウンテン畳屋町店」「業務スーパー高津店」は全て正規名のみに縮約される。
> ルール非マッチの場合は `stripBranchSuffix(trimmed)` を呼び、空白区切りの最後のトークンが「店」で終わる場合に除去する。

#### (d) export 追加

スクリプトから import 可能にするため以下を named export する。

```js
export { STORE_NORMALIZATION_RULES, normalizeStoreName };
```

既存の `export default async function handler` は据え置き。Vercel Serverless Function としての挙動に変更なし（named export は API route 仕様上無視される）。

### 3.2 `scripts/renormalize-stores.mjs` 新規作成

#### 要件
- Node.js ESM
- Supabase Service Role Key で全 `done` レコードを取得
- 各レコードの `result_json.store` に `normalizeStoreName()` を適用
- 変更があったレコードのみ UPDATE
- `--dry-run`（デフォルト）/ `--apply` フラグで切り替え
- `dotenv` で `.env.local` 読み込み（既存 `scripts/reset-receipts-to-pending.mjs` と同じ流儀）

#### スケルトン仕様

```js
// scripts/renormalize-stores.mjs
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { normalizeStoreName } from '../api/process.js';

const APPLY = process.argv.includes('--apply');
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('ENV missing'); process.exit(1); }
const supabase = createClient(url, key);

async function main() {
  const { data, error } = await supabase
    .from('receipts')
    .select('id, result_json')
    .eq('status', 'done');
  if (error) throw error;

  const diffs = [];
  for (const row of data || []) {
    const old = row.result_json?.store;
    if (!old) continue;
    const next = normalizeStoreName(old);
    if (next !== old) {
      diffs.push({ id: row.id, old, next, result_json: { ...row.result_json, store: next } });
    }
  }

  console.log(`対象: ${data.length} 件 / 変更: ${diffs.length} 件`);
  for (const d of diffs) console.log(`  [${d.id}] "${d.old}" → "${d.next}"`);

  if (!APPLY) {
    console.log('\ndry-run モード。--apply で実行します。');
    return;
  }

  let ok = 0, ng = 0;
  for (const d of diffs) {
    const { error: e } = await supabase
      .from('receipts')
      .update({ result_json: d.result_json })
      .eq('id', d.id);
    if (e) { ng++; console.error(d.id, e.message); } else { ok++; }
  }
  console.log(`\n適用完了: 成功 ${ok} / 失敗 ${ng}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

#### 留意点
- `api/process.js` 冒頭の `export const config = {...}` は ESM import 時にも評価されるが副作用はない。
- import path: スクリプト側から見て `../api/process.js`。拡張子 `.js` を明示すること（ESM 必須）。
- テーブル名は既存スクリプトと同じ `receipts`、カラム名 `result_json` / `status`。
- `done` 以外（pending / failed）は対象外。
- 再実行可能（冪等）: 2回目以降は差分 0 になる。

---

## 4. テストケース（Reviewer 検証必須）

### 4.1 `normalizeStoreName()` 単体テストケース

| # | 入力 | 期待出力 | ルール |
|---|---|---|---|
| 1 | `セブン-イレブン大阪宗右衛門町店` | `セブンイレブン` | ルールマッチ + suffix「店」破棄 |
| 2 | `セブンイレブン西心斎橋店` | `セブンイレブン` | ハイフンなし + suffix 破棄 |
| 3 | `セブン−イレブン難波店`（U+2212） | `セブンイレブン` | ハイフン揺れ吸収 |
| 4 | `7-Eleven Osaka Namba Store` | `セブンイレブン Osaka Namba Store` | ※英語 suffix は「店」で終わらないので保持 |
| 5 | `ファミリーマート大阪宗右衛門町店` | `ファミリーマート` | |
| 6 | `ローソンS OSL大阪日本橋駅店` | `ローソン` | 先頭マッチ、suffix 末尾「店」で破棄 |
| 7 | `ローソン銀座店` | `ローソン銀座店` | 否定先読みで除外（現状維持）※v6 でも挙動不変 |
| 8 | `LAWSON 道頓堀` | `ローソン 道頓堀` | |
| 9 | `アークランズ株式会社` | `アークランズ株式会社` | ルールマッチ、末尾「店」ではない |
| 10 | `アークランド株式会社` | `アークランズ株式会社` | 表記統一 |
| 11 | `リカーマウンテン畳屋町店` | `リカーマウンテン` | ルール + suffix 末尾「店」破棄 |
| 12 | `業務スーパー高津店` | `業務スーパー` | ルール非マッチ → stripBranchSuffix（空白なし末尾「店」） |
| 13 | `久世福商店 なんばウォーク店` | `久世福商店` | 空白区切り最後のトークン除去、「商店」保護 |
| 14 | `久世福商店` | `久世福商店` | 「商店」保護（無変更） |
| 15 | `A-PRICE 熱波千日前店` | `A-PRICE 熱波千日前` | 空白区切り最後のトークンが「千日前店」→除去…**注意**: 期待は「A-PRICE 熱波千日前」。実装方針上 `熱波千日前店` トークンごと除去してしまうため、要調整 |
| 16 | `ダイソー` | `ダイソー` | |
| 17 | `商店` | `商店` | 単独「商店」は無変更 |
| 18 | `〇〇商会` | `〇〇商会` | 末尾「店」ではないので無変更 |
| 19 | 空文字 / null | 同値 | 先頭ガード |
| 20 | `店` | `` もしくは `店` | エッジ: 単独「店」はユーザー判断。v6 では **無変更**（`店` を残す）とする（`/(?<!商)店$/` でマッチするが、短すぎるので別途ガード: `if (s.length <= 1) return s;`） |

#### ケース 15 の扱いについて
期待結果表では `A-PRICE 熱波千日前店 → A-PRICE 熱波千日前` とある。
空白区切りでトークン化すると `['A-PRICE', '熱波千日前店']` となり、最後のトークン丸ごと除去すると `A-PRICE` になってしまう。

**ルール再定義**: 空白区切りの最後のトークンが「〜店」で終わる場合、**そのトークン内で末尾の「店」1文字のみ除去**する。トークンごと破棄するのはチェーン名マッチ時の suffix のみ。

修正後のロジック:
```js
function stripBranchSuffix(input) {
  if (!input || typeof input !== 'string') return input;
  let s = input.trim();
  if (s.length <= 1) return s;
  if (!s.endsWith('店')) return s;
  if (/商店$/.test(s)) return s;
  // 末尾「店」1文字のみ除去（商店保護は上でガード済み）
  return s.replace(/(?<!商)店$/, '').trim();
}
```

このルールだと:
- `業務スーパー高津店` → `業務スーパー高津` ← **期待と違う**（期待は `業務スーパー`）

つまり「チェーン名マッチで suffix 破棄」と「末尾1文字削除」の **2系統** を併用する必要がある。

**最終確定ロジック**:
- ルールマッチ時: suffix が「店」で終わり、かつ「商店」でなければ **suffix 全体を破棄**（`rule.normalized` のみ返す）
- ルール非マッチ時: `stripBranchSuffix` で **末尾1文字の「店」のみ除去**（商店保護）

この前提で期待結果表を再検証:

| # | 入力 | 期待 | v6 実装出力 | 一致? |
|---|---|---|---|---|
| 11 | `リカーマウンテン畳屋町店` | `リカーマウンテン` | リカーマウンテン（ルールマッチ・suffix 破棄） | ✅ |
| 12 | `業務スーパー高津店` | `業務スーパー` | `業務スーパー高津`（ルール未定義） | ❌ |
| 15 | `A-PRICE 熱波千日前店` | `A-PRICE 熱波千日前` | `A-PRICE 熱波千日前`（末尾店除去のみ） | ✅ |
| 13 | `久世福商店 なんばウォーク店` | `久世福商店` | `久世福商店 なんばウォーク`（末尾店除去のみ） | ❌ |

**結論**: 期待結果表と完全一致させるには、業務スーパー / 久世福商店も `STORE_NORMALIZATION_RULES` に追加するのが最も確実。オーナーと合意済みのケース 12 / 13 のため、以下を v6 で **追加ルール** として入れる。

```js
// 業務スーパー系
{
  pattern: /^(業務スーパー|業務用スーパー)/,
  normalized: '業務スーパー',
},
// 久世福商店系
{
  pattern: /^(久世福商店)/,
  normalized: '久世福商店',
},
```

`久世福商店` はチェーン名自体に「商店」が入るため、マッチ時に suffix を破棄するロジックでも `久世福商店` が保護される（ルールの normalized を返すので「商店」文字列は常に保持される）。

---

### 4.2 Edge case リスト（Reviewer 必ず通すこと）

1. **商店保護**: `久世福商店` / `〇〇商店` / `酒商店` → 末尾「店」除去してはならない
2. **空文字 / null / undefined**: クラッシュせず原値を返す
3. **単独「店」**: 無変更（短すぎるガード）
4. **英数字チェーン**: `A-PRICE` `7-Eleven` の前方マッチ阻害しない
5. **全角空白**: `久世福商店　なんばウォーク店` → ルールマッチ優先で `久世福商店`
6. **中黒**: `〇〇・〇〇店` → 末尾「店」除去後 `〇〇・〇〇` に中黒が残らないよう trim
7. **数字店舗番号**: `〇〇店123` のようなケースは末尾「店」ではないので無変更（想定外）
8. **ルールマッチ + suffix が「商店」で終わる**: `セブンイレブン〇〇商店` のような奇妙ケース → suffix 破棄しない（商店保護優先）

### 4.3 スクリプト動作確認項目

1. `--dry-run`（デフォルト）で副作用なし・差分一覧のみ出力
2. `--apply` で UPDATE 実行
3. 再実行で差分 0（冪等性）
4. `done` 以外のレコードは対象外
5. `result_json.store` が null / undefined のレコードはスキップ

---

## 5. 統合時の注意点

- `api/process.js` は Vercel Serverless Function のエントリポイント。named export 追加が **Vercel のビルドに悪影響を与えないこと** を Reviewer が確認する（dev サーバで `vercel dev` か `vite` で起動して疎通確認）。
- スクリプトは `package.json` の `"type": "module"` もしくは `.mjs` 拡張子で ESM として動く前提。既存スクリプト `reset-receipts-to-pending.mjs` と同じ流儀に合わせる。
- 既存 `receipts.js` / `upload.js` など他 API の挙動に影響なきこと（import 関係の変更は今回の改修範囲外）。
- Supabase schema 変更なし（マイグレーション不要）。

---

## 6. Engineer 実装フェーズ指示

### 6.1 実装方式
- **Claude 直接実装可**。ただし Read 禁止運用（サブエージェントの malware 誤検知回避）で、Bash + Write/Edit を駆使する。
- GLM 併用も可だが、regex + 否定後読みが多いため Claude 直接実装の方が確実。
- Engineer サブエージェントが Read を使う場合、**このファイル（設計書）のみ** を対象とし、`api/process.js` は必ず `cat` / `sed` / `grep` 系 Bash コマンドで操作する。

### 6.2 実装順序
1. `api/process.js` を編集
   - セブンイレブン normalized を `'セブンイレブン'` に変更
   - アークランズ / 業務スーパー / 久世福商店 ルール追加
   - `normalizeStoreName()` 内: ルールマッチ時の suffix「店」破棄分岐を追加
   - `stripBranchSuffix()` 新設し、ルール非マッチ時の末尾「店」1文字除去を実装
   - named export: `STORE_NORMALIZATION_RULES`, `normalizeStoreName`
2. `scripts/renormalize-stores.mjs` を新規作成
3. dry-run 実行確認（ローカル env 必須）
4. 変更を Reviewer に引き渡し

### 6.3 動作確認
- `node --test` が使える環境であれば、テストケース 4.1 を `test` ファイルに書くのが望ましい（任意）。
- 最低限: `scripts/renormalize-stores.mjs --dry-run` を手動実行し、差分サンプルを出力して設計書と照合する。

### 6.4 禁則
- `result_json.items` / `result_json.total` など **store 以外のフィールドは一切書き換えない**。
- `status` カラムを触らない（再処理フラグなどと干渉するため）。
- `.env.local` を git にコミットしない。

---

## 7. 成果物チェックリスト（Tech Lead 最終承認）

- [ ] `api/process.js` に新ルール 3 件追加（アークランズ / 業務スーパー / 久世福商店）
- [ ] セブンイレブン normalized が `'セブンイレブン'`（ハイフンなし）
- [ ] `normalizeStoreName()` のルールマッチ時 suffix「店」破棄分岐が動作
- [ ] `stripBranchSuffix()` が「商店」を保護
- [ ] `STORE_NORMALIZATION_RULES` / `normalizeStoreName` が named export されている
- [ ] `scripts/renormalize-stores.mjs` 新規作成・dry-run 動作確認済
- [ ] テストケース 4.1 の #1〜#18 を Reviewer が検証ログとして提出
- [ ] git diff を確認し、store 正規化以外の変更が混入していない
- [ ] Engineer → Reviewer → D チーム → Tech Lead のループを通過

---

## 8. リスク / フォールバック

- **Regex 後読み非対応ランタイム**: Vercel の Node.js ランタイムは ES2018+ なので `(?<!...)` 利用可。ローカル Node.js 18+ も OK。
- **normalizeStoreName 非マッチ時の過剰除去**: `〇〇支店` `〇〇本店` など「店」で終わる別概念の名称は末尾除去対象となる。v6 ではオーナー判断で許容。将来 v7 で除外リストを追加する可能性あり。
- **既存データの意図しない改変**: dry-run 必須。差分 20 件超なら Tech Lead に再確認を取る運用とする。

以上。
