# receipt-scanner Loop 7 — 構造化ログ整備

- **作成日**: 2026-04-27
- **担当**: Tech Lead（設計）/ Engineer A・B（実装、GLM）/ Reviewer（集約 1 名）
- **対象プロジェクト**: `receipt-scanner`
- **並列度**: 2 (A / B)
- **方針**: 自作シンプルロガー（依存ゼロ）

---

## 1. 概要（何を・なぜ）

### 何を
`receipt-scanner/api/**/*.js` 配下の `console.log` / `console.warn` / `console.error` を、自作の構造化ロガー `api/lib/logger.js` 経由の出力に統一する。

### なぜ
- Vercel Serverless のログビューアでは行単位で取り込まれるため、JSON 1 行の構造化ログにすると `level` / `msg` / `ctx` でのフィルタ・grep が容易になる。
- 現状は free-form 文字列 (`'Receipts GET error:'` など) で運用が手探りになっており、エラーオブジェクトを生で渡している箇所もあって `[Object]` 化されるリスクがある。
- 依存追加（pino 等）は Cold Start・Bundle・脆弱性管理の観点でコストが大きい。`JSON.stringify` 1 行で十分な要件のため、自作の薄いロガー（**選択肢 B**）を採用する。

### スコープ
- 対象: `api/process.js`, `api/upload.js`, `api/register.js`, `api/receipts.js`, `api/lib/freee.js`, `api/lib/freee-auth.js`
- **追加スコープ**: 現状把握中に `api/lib/freee-auth.js` にも 4 箇所の `console.*` を発見。同じ `api/lib/` 配下のため B チームに追加する。
- 対象外:
  - `api/dev-server.js` — ローカル専用ツール。`[dev-server]` プレフィックスの可読ログが既に機能しており、Vercel に乗らないので変更不要。
  - フロント側 (`src/` 配下) の `console.*` — Loop 7 のスコープ外。
  - `api/lib/prompt.js` / `api/lib/supabase.js` — `console.*` 呼び出しなし（要確認だが grep 結果に出ていない）。

### 現状の `console.*` 検出結果（参考）
| ファイル | 件数 | 主な種別 |
|---|---|---|
| `api/process.js` | 2 | error |
| `api/upload.js` | 4 | warn / error |
| `api/register.js` | 4 | warn / error |
| `api/receipts.js` | 5 | error |
| `api/lib/freee.js` | 5 | error |
| `api/lib/freee-auth.js` | 4 | log / warn / error |
| **合計** | **24** | |

---

## 2. 分割戦略

### 並列度: 2

| Team | 担当 | 影響範囲 | 競合リスク |
|---|---|---|---|
| **A** | `api/lib/logger.js` 新規 + `api/process.js` + `api/upload.js` | エンドポイント 2 本 + ロガー本体 | なし（B と独立） |
| **B** | `api/register.js` + `api/receipts.js` + `api/lib/freee.js` + `api/lib/freee-auth.js` | エンドポイント 2 本 + lib 2 本 | なし（A と独立） |

### 依存関係
- **A → B**: B は A の `logger.js` を `import` するため、A が先に完成 / もしくは並列でも B 側はシグネチャ合意済みの前提で書ける。
  - 本設計書で `logger.js` のシグネチャ・I/O 仕様を**完全固定**することで、A と B を**同時並列実行可能**にする。
- **B → A**: なし。
- ファイル単位で完全に分離しているため、merge 時の競合は発生しない。

### 実行順
A と B を**同時に**起動する。Reviewer は両方の patch が出揃ってから 1 回のレビューに集約。

---

## 3. ロガー仕様（A・B 共通の契約）

### 3.1 ファイル: `api/lib/logger.js`（新規・A 担当）

```js
// api/lib/logger.js
// 依存ゼロの構造化ロガー。Vercel Serverless ログ向けに 1 行 1 JSON で出力する。

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevelThreshold() {
  const env = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[env] ?? LEVELS.info;
}

function serializeError(err) {
  if (!err) return undefined;
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack, name: err.name };
  }
  if (typeof err === 'object') {
    // Error-like (e.g. Supabase error: { message, code, details, hint })
    return { ...err };
  }
  return { message: String(err) };
}

function emit(level, msg, ctx = {}) {
  if (LEVELS[level] < currentLevelThreshold()) return;

  const entry = { ts: new Date().toISOString(), level, msg };

  // err は特別扱い（Error オブジェクトを安全にシリアライズ）
  if (ctx && 'err' in ctx) {
    const { err, ...rest } = ctx;
    entry.err = serializeError(err);
    Object.assign(entry, rest);
  } else if (ctx && typeof ctx === 'object') {
    Object.assign(entry, ctx);
  }

  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (msg, ctx) => emit('debug', msg, ctx),
  info: (msg, ctx) => emit('info', msg, ctx),
  warn: (msg, ctx) => emit('warn', msg, ctx),
  error: (msg, ctx) => emit('error', msg, ctx),
};
```

### 3.2 出力フォーマット契約

```json
{"ts":"2026-04-27T12:34:56.789Z","level":"error","msg":"register error","err":{"message":"...","stack":"...","name":"Error"},"receiptId":"abc-123"}
```

- **必須フィールド**: `ts` (ISO8601), `level` (debug|info|warn|error), `msg` (string)
- **オプショナル**: `err` (シリアライズ済み), 任意の `ctx` キー（`receiptId`, `fileName`, `endpoint` など）
- **1 行 = 1 JSON**。改行は含めない。

### 3.3 環境変数 `LOG_LEVEL`
- 値: `debug` / `info` / `warn` / `error`
- 未指定時のデフォルト: `info`
- しきい値以下のレベルは **emit しない**（早期 return）
- 大文字小文字は区別しない（`.toLowerCase()` で正規化）

### 3.4 設計上のルール
- **err は必ず `ctx.err` に入れる**。`logger.error('msg', { err })` の形に統一。
  - これにより呼び出し側で毎回 `{ message: e.message, stack: e.stack }` と書く必要がなくなる。
- `ctx` のキーは英数字 + アンダースコア / camelCase 推奨（JSON で grep しやすくするため）。
- ファイルやエンドポイントを示すキーは `endpoint` または `scope` で統一（例: `{ endpoint: 'upload', fileName: '...' }`）。

---

## 4. 置換マップ（A・B チーム共通）

### 4.1 一般則
| Before | After |
|---|---|
| `console.log('msg')` | `logger.info('msg')` |
| `console.log('label:', value)` | `logger.info('label', { value })` |
| `console.warn('msg', e.message)` | `logger.warn('msg', { reason: e.message })` |
| `console.error('label:', err.message)` | `logger.error('label', { err })` |
| `console.error('label:', err.message, err.stack)` | `logger.error('label', { err })` |
| `console.error('label:', errLike.message)`（DB エラー等） | `logger.error('label', { err: errLike })` |

### 4.2 import 追加
ロガーを使う各ファイル先頭に以下を追加:
```js
import { logger } from './lib/logger.js';
```
- `api/lib/freee.js`, `api/lib/freee-auth.js` は同階層のため `'./logger.js'`。
- `api/*.js` (handler 群) は `'./lib/logger.js'`。

---

## 5. チーム別タスク

### Team A — ロガー本体 + process.js + upload.js

#### A-1. `api/lib/logger.js` を**新規作成**
- 上記 3.1 のコードをそのまま実装。
- `export const logger` のみ公開（default export しない）。

#### A-2. `api/process.js` の置換（2 箇所）
冒頭に `import { logger } from './lib/logger.js';` を追加。

| line | Before | After |
|---|---|---|
| 469 | `console.error(\`Process error for ${receipt.id}:\`, err.message);` | `logger.error('process: receipt failed', { err, receiptId: receipt.id });` |
| 482 | `console.error('Process handler error:', error.message, error.stack);` | `logger.error('process: handler error', { err: error });` |

#### A-3. `api/upload.js` の置換（4 箇所）
冒頭に `import { logger } from './lib/logger.js';` を追加。

| line | Before | After |
|---|---|---|
| 43 | `console.warn(\`Skipped non-image file: ${file.originalFilename} (${mimeType})\`);` | `logger.warn('upload: skipped non-image', { fileName: file.originalFilename, mimeType });` |
| 62 | `console.error(\`Upload error for ${file.originalFilename}:\`, uploadError.message);` | `logger.error('upload: storage upload failed', { err: uploadError, fileName: file.originalFilename });` |
| 82 | `console.error(\`DB insert error for ${file.originalFilename}:\`, insertError.message);` | `logger.error('upload: db insert failed', { err: insertError, fileName: file.originalFilename });` |
| 102 | `console.error('Upload error:', error.message, error.stack);` | `logger.error('upload: handler error', { err: error });` |

#### A-4. 検証
- `node --check api/lib/logger.js`
- `node --check api/process.js`
- `node --check api/upload.js`
- 残存 `console.*` 確認: `grep -n "console\." api/lib/logger.js api/process.js api/upload.js` → 0 件であること
- 簡易動作確認: `node -e "import('./api/lib/logger.js').then(({logger}) => { logger.info('test', {a:1}); logger.error('boom', {err: new Error('x')}); })"` で 2 行 JSON が出ること

---

### Team B — register.js + receipts.js + freee.js + freee-auth.js

#### B-1. `api/register.js` の置換（4 箇所）
冒頭に `import { logger } from './lib/logger.js';` を追加。

| line | Before | After |
|---|---|---|
| 130 | `console.error('Receipt select error:', receiptSelectError.message);` | `logger.error('register: receipt select failed', { err: receiptSelectError });` |
| 141 | `console.error('Receipt download error:', downloadError.message);` | `logger.error('register: receipt download failed', { err: downloadError });` |
| 167 | `console.warn('result_json.splits validation failed, falling back to single mode.');` | `logger.warn('register: splits validation failed, falling back to single mode');` |
| 223 | `console.error('register error:', e.message);` | `logger.error('register: handler error', { err: e });` |

#### B-2. `api/receipts.js` の置換（5 箇所）
冒頭に `import { logger } from './lib/logger.js';` を追加。

| line | Before | After |
|---|---|---|
| 43 | `console.error('Receipts counts error:', error.message, error.stack);` | `logger.error('receipts: counts query failed', { err: error });` |
| 105 | `console.error('Receipts GET error:', error.message, error.stack);` | `logger.error('receipts: GET failed', { err: error });` |
| 224 | `console.error('Receipts PATCH error:', error.message, error.stack);` | `logger.error('receipts: PATCH failed', { err: error });` |
| 266 | `console.error('Storage delete error (continuing):', storageError.message);` | `logger.warn('receipts: storage delete failed (continuing)', { err: storageError });` |
| 282 | `console.error('Receipts DELETE error:', error.message, error.stack);` | `logger.error('receipts: DELETE failed', { err: error });` |

注: line 266 は「処理は継続する」エラーのため、レベルを `error` → `warn` に格上げ（=実体に合わせて意味付け）。

#### B-3. `api/lib/freee.js` の置換（5 箇所）
冒頭に `import { logger } from './logger.js';` を追加（同階層）。

| line | Before | After |
|---|---|---|
| 65 | `console.error('freee receipt upload error:', err);` | `logger.error('freee: receipt upload failed', { err });` |
| 99 | `console.error('Partner create failed:', err);` | `logger.error('freee: partner create failed', { err });` |
| 206 | `console.error('freee_sent_at update error:', updateError.message);` | `logger.error('freee: freee_sent_at update failed', { err: updateError });` |
| 209 | `console.error('freee_sent_at update exception:', e.message);` | `logger.error('freee: freee_sent_at update exception', { err: e });` |
| 220 | `console.error('freee API error:', err);` | `logger.error('freee: API error', { err });` |

注: line 65 / 99 / 220 の `err` は `await res.text()` の文字列または fetch 例外のいずれか。`serializeError` がいずれも安全にハンドリングするため、`{ err }` でそのまま渡してよい。

#### B-4. `api/lib/freee-auth.js` の置換（4 箇所）
冒頭に `import { logger } from './logger.js';` を追加。

| line | Before | After |
|---|---|---|
| 66 | `console.log('freee: トークンをリフレッシュしました');` | `logger.info('freee: token refreshed');` |
| 68 | `console.warn('freee: .envファイルの更新に失敗しました（process.envは更新済み）:', e.message);` | `logger.warn('freee: .env update failed (process.env updated)', { err: e });` |
| 95 | `console.log('freee: 401を受信、トークンをリフレッシュします...');` | `logger.info('freee: 401 received, refreshing token');` |
| 102 | `console.error('freee: トークンリフレッシュに失敗:', e.message);` | `logger.error('freee: token refresh failed', { err: e });` |

#### B-5. 検証
- `node --check api/register.js`
- `node --check api/receipts.js`
- `node --check api/lib/freee.js`
- `node --check api/lib/freee-auth.js`
- 残存 `console.*` 確認: `grep -n "console\." api/register.js api/receipts.js api/lib/freee.js api/lib/freee-auth.js` → 0 件であること

---

## 6. 統合時の注意点

### 6.1 全ファイル共通の最終検証（Tech Lead 統合フェーズ）
1. **残存 console チェック**:
   ```bash
   grep -rn "console\." api/ --include="*.js" | grep -v "api/dev-server.js" | grep -v "api/lib/logger.js"
   ```
   - `dev-server.js` と `logger.js`（内部で `console.log`/`console.error` を使う）以外で **0 件**であること。
2. **ビルド検証**: `npm run build`（TypeScript + Vite）が通ること。
3. **Node 構文チェック**: `node --check api/lib/logger.js && node --check api/process.js && ...` （対象 6 ファイル全て）。
4. **import パス確認**:
   - `api/*.js` → `./lib/logger.js`
   - `api/lib/*.js` → `./logger.js`
   - 大文字小文字・拡張子 `.js` ともに正確であること（ESM はパス厳格）。
5. **動作スモーク**: `node -e "import('./api/lib/logger.js').then(({logger}) => logger.error('t', { err: new Error('x'), foo: 1 }))"` → 1 行 JSON で `ts/level/msg/err.{message,stack,name}/foo` が含まれること。

### 6.2 競合リスク
- A と B は**ファイル単位で完全分離**。同一ファイルを両チームが触ることはない。
- ただし両チームが新規 `import` 行を追加するため、各ファイル先頭の import ブロックの位置・順序は既存スタイルに合わせる（既存 import の直後に追加）。

### 6.3 互換性
- 出力先は引き続き `console.log` / `console.error`（内部実装）。Vercel ログ取り込みに影響なし。
- 既存の grep ベース運用がある場合、文字列が変わるため一時的に検索漏れが発生する可能性。Loop 7 完了後に運用 grep を更新する。

### 6.4 注意した落とし穴
- **`{ err }` short-hand**: ES2015 のオブジェクト省略記法。`{ err: err }` と等価。
- **Supabase エラー**: `.message` を持つが `Error` インスタンスではないことが多い。`serializeError` の `typeof err === 'object'` 分岐で `{ ...err }` 展開され、`message` / `code` / `details` / `hint` 等が保持される。
- **fetch のテキストエラー**: `freee.js:65` の `err = await res.text()` は文字列。`serializeError` の最終分岐で `{ message: String(err) }` になる。
- **debug レベル**: 現状 `console.log('freee: トークンをリフレッシュしました')` 等は info に格上げ（運用上重要なイベント）。`logger.debug` は今回の置換では使わない。将来の細かなトレース用に予約。

---

## 7. Reviewer チェックリスト（集約 1 名）

- [ ] `api/lib/logger.js` が仕様 3.1 と完全一致する
- [ ] `LOG_LEVEL` のしきい値判定が正しく動作する（debug < info の場合に debug が出ないこと）
- [ ] `serializeError` が Error / Error-like / 文字列 / undefined の 4 ケースを処理できる
- [ ] 対象 6 ファイル全ての `console.*` が消えている（24 → 0）
- [ ] 各ファイルに正しい相対パスで `import { logger } from '...'` が追加されている
- [ ] `{ err }` 渡しの統一（`err.message` / `err.stack` を呼び出し側で展開していない）
- [ ] `receipts.js:266` の警告レベル変更（error → warn）が反映されている
- [ ] `npm run build` が通る
- [ ] 既存ロジックは一切変更していない（ログ呼び出しの置換のみ）

---

## 8. 完了条件

1. A・B 両チームの patch が Reviewer に承認される
2. `grep -rn "console\." api/ --include="*.js"` で `dev-server.js` と `logger.js` 以外がヒットしない
3. `npm run build` が通る
4. Tech Lead が `git diff` を最終検査し、approved を返す
5. dual push（newWorld + receipt-scanner 両リポジトリ）

---

## 9. 想定外への対応

- **GLM が ESM の import パスを間違える**: Reviewer がパス厳格チェック。失敗時は集約レビューで具体的な訂正指示。
- **既存ロジック改変**: 「ログ置換のみ」を厳守。条件分岐や戻り値を変えた場合は差し戻し。
- **logger.js の循環参照**: `logger.js` は何も import しない（`process` グローバルのみ参照）。安全。

---

## 10. v3.9.2 追補 — apollostation 正規化（2026-05-13 追記）

### 10.1 背景
v3.9.1（P3 修正 + R 略記 + Few-shot J 鮨菊）の Reviewer 直前にオーナーから追加要件:
「apollostation が含まれる場合は store を `apollostation` に正規化してほしい」。

apollostation は ENEOS グループのガソリンスタンドブランド（旧出光・昭和シェル統合）。レシート上は「ENEOS apollostation」「Dr.Drive セルフ apollostation」「apollostation 〇〇店」等の表記揺れが頻出するため、集計用途で単一名へ統一する。

### 10.2 判定（Tech Lead）
| 判定軸 | 結論 | 理由要約 |
|---|---|---|
| 実装方式 | **C. ハイブリッド (prompt + post-process)** | LLM 誘導 + 決定論的後処理の二重防御 |
| 取扱い | **v3.9.1 に統合 → v3.9.2** | Reviewer 未実施・push 前のため統合コスト最小 |
| 汎用化 | **正規化マップを別ファイルで最小実装** | 将来の表記揺れ案件（セブン/ファミマ等）で 1 行追加運用 |

### 10.3 分割戦略
- **並列度**: 1（スコープ小・疎結合）
- **チーム**: Team A 単独

### 10.4 Team A — apollostation 正規化統合

#### 対象ファイル
| ファイル | 種別 | 変更概要 |
|---|---|---|
| `api/prompt.js`（実体: prompt 文字列を保持するファイル）| 修正 | §2.9 末尾に「オプション G: チェーン店表記正規化」追記 |
| `api/_normalize.js` | **新規** | `CHAIN_ALIAS_MAP` + `normalizeStore()` |
| OCR レスポンス処理箇所（grep で特定） | 修正 | JSON.parse 直後に `normalizeStore()` を 1 行挿入 |

#### prompt.js 追記内容（§2.9 末尾）
```
オプション G: チェーン店表記正規化

画像中に以下のキーワードが含まれる場合、store は対応する正規名に統一する。
表記揺れ（前後の修飾語・店舗名・支店名・系列名）があっても、キーワード一致を最優先。

| キーワード（部分一致, 大小無視） | 正規名 |
|---|---|
| apollostation | apollostation |

例:
- "ENEOS apollostation 〇〇SS"         → store: "apollostation"
- "Dr.Drive セルフ apollostation 中央店" → store: "apollostation"
- "apollostation 渋谷店"                → store: "apollostation"
```

#### `api/_normalize.js`（新規）仕様
- エクスポート:
  - `CHAIN_ALIAS_MAP`: `Array<{ canonical: string, pattern: RegExp }>`
  - `normalizeStore(rawStore: string): string`
- 初期登録: `{ canonical: "apollostation", pattern: /apollostation/i }` の 1 件のみ
- ロジック:
  1. `rawStore` が falsy なら そのまま返却
  2. `CHAIN_ALIAS_MAP` を順次検査、`pattern.test(rawStore)` 真なら `canonical` を返却
  3. どれにもマッチしなければ `rawStore` をパススルー
- モジュール形式: 既存 `api/` 配下のスタイル（CJS / ESM）に追従

#### OCR レスポンス処理箇所への組み込み
- engineer が `grep -rn "JSON.parse" api/` で OCR レスポンスの parse 箇所を特定
- **JSON.parse 成功直後・バリデーション前** に以下を挿入:
  ```
  parsed.store = normalizeStore(parsed.store);
  ```
- import / require は既存ファイルのスタイルに合わせる

#### 期待動作
- 入力レシート OCR テキストに `apollostation`（大小無視）を含む → store 出力が `"apollostation"` に統一
- 含まない場合は既存挙動完全維持（パススルー）
- prompt 誘導により LLM が `apollostation` を含めて返す確率が上がる → 後処理マッチ率向上

#### 検証
- `node --check api/prompt.js` PASS
- `node --check api/_normalize.js` PASS
- `node --check <parse 修正ファイル>` PASS
- `grep -c "apollostation" api/prompt.js` ≥ 4（見出し + 表 1 行 + 例 3 つ）
- `grep -n "normalizeStore" <parse 修正ファイル>` ヒット（import 1 + 呼び出し 1）
- 既存 v3.9.1 修正項目（P3 / R 略記 / Few-shot J / Few-shot I AND）に regression がないこと

### 10.5 統合時の注意
- OCR レスポンス処理は **JSON.parse 成功後・バリデーション前** に挟むこと（順序を間違えると後処理が空振り）
- CJS / ESM 混在に注意。既存ファイルに合わせて `require` or `import` を選択
- `CHAIN_ALIAS_MAP` は **配列で順序保持**（先勝ち）。将来 `apollostation` より広いパターンを追加する際の優先度制御に必要

### 10.6 将来拡張ポリシー
- セブン-イレブン / ファミマ / ローソン / マクドナルド 等の追加要件は **`CHAIN_ALIAS_MAP` への 1 行追加 + prompt §2.9 表に 1 行追加** で完結させる
- prompt と後処理マップは **手動同期**（自動化は ROI 低）。新規追加 PR では両方を必ず touch

### 10.7 Reviewer チェックリスト追補（v3.9.2 範囲）
- [ ] `api/_normalize.js` が新規作成され、`CHAIN_ALIAS_MAP` と `normalizeStore` をエクスポート
- [ ] `normalizeStore("")` / `normalizeStore(null)` / `normalizeStore(undefined)` が落ちず安全に返却
- [ ] `normalizeStore("ENEOS apollostation 中央SS")` === `"apollostation"`
- [ ] `normalizeStore("Apollostation 渋谷")` === `"apollostation"`（大小無視）
- [ ] `normalizeStore("セブン-イレブン 〇〇店")` === `"セブン-イレブン 〇〇店"`（未登録はパススルー）
- [ ] prompt.js §2.9 にオプション G が追記され、表 + 例 3 つを含む
- [ ] OCR レスポンス処理で `normalizeStore` 呼び出しが JSON.parse 直後に挿入されている
- [ ] v3.9.1 で行った P3 修正 / R 略記 / Few-shot J / Few-shot I AND の 4 項目に影響なし
- [ ] `node --check` 全ファイル PASS

### 10.8 完了条件
1. Team A の patch が Reviewer（Claude + Codex 並列）に承認される
2. `node --check` 全ファイル PASS
3. apollostation を含む実レシート 1 件で store 出力 = `"apollostation"` を実機確認（オーナー手動 or サンプル投入）
4. Tech Lead が `git diff` 最終検査し approved
5. dual push（newWorld + receipt-scanner）

---

## 11. v3.9.3 追補 — 自信度ゲート強化（"あやふやなら他情報確認 → 強制エラー" / 2026-05-13 追記）

### 11.1 背景
v3.9.2（apollostation 正規化）の設計確定直後、オーナーから追加要件:
> 「あやふやなものはそれ以外のところを見てその後強制的にエラーに送って」

要求の本質を 2 軸で分解:
1. **あやふや検出の網羅性向上** — confidence:medium/low のみならず uncertainty_reason に「迷い」ヒントがあれば「あやふや」と認定
2. **fail-safe 化** — あやふや検出時は人間レビュー（status=error）に **無条件で振り分け**、ベスト推測で done 化させない

### 11.2 現状ロジックの再確認（Tech Lead が直接 grep / sed で確認済）

`api/process.js` には既に **v3.2 自信度ゲート**（L325-336）が実装されており、
```
if (resultJson.confidence !== 'high') {
  → status: 'error'
}
```
が稼働中。つまり `confidence: medium/low` は **既に error 振り分け済**。

そこで v3.9.3 で残る論点は次の 3 つに整理される:

| 論点 | 現状 | v3.9.3 対応 |
|---|---|---|
| (a) confidence:high だが uncertainty_reason に迷いの記述あり | done 化される | error に降格させるか |
| (b) prompt 側で「あやふやなら他フィールドで補強推論を試みる」誘導 | 部分的（Few-shot レベル） | §2.9 にオプション H として明文化 |
| (c) 既存 done レコードへの遡及影響 | — | 新規 receipt のみ適用・遡及なし |

### 11.3 判定（Tech Lead）

| 判定軸 | 結論 | 理由要約 |
|---|---|---|
| 解釈の選択 | **C 案ハイブリッド（prompt 補強誘導 + post-process 強化ゲート）** | A 案だけでは prompt 改善余地を捨てる。B 案だけでは LLM 任せで非決定的。Cが事故ゼロに最も近い |
| Loop 取扱い | **v3.9.3 として Loop 7 内吸収（v3.9.2 と同 Reviewer ターンで投入）** | v3.9.2 がまだ未実装 → patch が重なる前に統合した方が衝突小。Reviewer のレビュー範囲は 3 件まとめに増えるが diff は小規模 |
| 既存 done → error 降格 | **遡及なし（新規 receipt のみに適用）** | 過去 done を error 降格させると freee 連携済の取引と齟齬が出る。`status='done'` の receipt は触らない |
| confidence:high + uncertainty_reason 非空時の扱い | **error に降格する（"high-but-doubting" 検出）** | LLM が形式的に high を出しつつ理由を残すケースは事故率高。実害なく fail-safe 側に倒す |

### 11.4 分割戦略
- **並列度**: 1（変更箇所が `prompt.js §2.9` と `api/process.js` の自信度ゲート前後に限定、相互依存）
- **チーム**: Team A 単独（v3.9.2 と同チーム継続。**v3.9.2 と同 patch にまとめて投入**）
- **依存関係**: v3.9.2 の §10.4 と同一ファイルを触るが、編集箇所が分離しているため **同 Engineer に 2 件を順次指示**するのが最安全

### 11.5 Team A — v3.9.3 自信度ゲート強化

#### 対象ファイル
| ファイル | 種別 | 変更概要 |
|---|---|---|
| `api/lib/prompt.js` | 修正 | §2.9 末尾に「オプション H: あやふや時の他情報補強 + 報告義務」追記 |
| `api/process.js` | 修正 | L325-336 の自信度ゲート直後に「high-but-doubting」検出ブロックを追加 |

#### 11.5.1 prompt.js 追記内容（§2.9 末尾 / オプション G の後）

```
オプション H: あやふや時の他情報補強と報告義務

ある 1 フィールド（store / amount / date / category 等）で確信が持てない場合、
直ちに `confidence: medium` で諦めるのではなく、以下の補強推論を **必ず試行** すること。
補強で確証が取れた場合のみ `confidence: high` を維持してよい。取れなければ
**形式的に high を出さず**、`confidence: medium` + `uncertainty_reason` に
「どのフィールドで何を迷ったか」を 1 文で記述すること。

【補強推論の対象フィールドと優先順位】
1. store が不確実 → 以下を順に確認:
   - 住所 / 郵便番号 / 電話番号（市外局番）
   - 業態キーワード（カフェ / ガソリン / 酒販 / 雑貨 等）
   - 商品明細の固有名（ブランド名・型番）
   - レジ番号・登録番号フォーマット
2. amount が不確実 → 以下を順に確認:
   - 小計 + 税額の合算と一致するか
   - 釣銭・お預り金の差分整合
   - 軽減税率内訳（8%対象 + 10%対象）の合算
3. date が不確実 → 以下を順に確認:
   - 元号略記（R / 令和 等）+ 月日の整合
   - 取引時刻と曜日整合
   - クレカ伝票なら有効期限との時系列整合
4. category が不確実 → 商品明細・店舗業態から逆引き

【報告義務】
- 補強で high 維持できた場合: `uncertainty_reason: ""`（空文字列）
- 補強で確証取れなかった場合: `confidence: medium` + `uncertainty_reason`
  に「○○が不確実、△△で補強試行も□□のため確証取れず」形式で記述

【絶対禁止】
- 補強推論の試行をスキップして即 medium を返すこと
- 補強で確証が取れていないのに形式的に high を返すこと
  （後者は v3.9.3 post-process で検出され error 化される）
```

#### 11.5.2 api/process.js 修正内容

**現状**（L325-336）:
```js
// 自信度ゲート（v3.2）
if (resultJson.confidence !== 'high') {
  await supabase
    .from('receipts')
    .update({
      status: 'error',
      result_json: resultJson,
      error_message: `自信度: ${resultJson.confidence || 'unknown'}（${resultJson.uncertainty_reason || '理由不明'}）`,
    })
    .eq('id', receipt.id);
  errors++;
  continue;
}
```

**v3.9.3 追加**（既存ゲート **直後** に挿入）:
```js
// v3.9.3: high-but-doubting 検出
// confidence='high' でも uncertainty_reason に迷いの記述があれば error 化
{
  const reason = (resultJson.uncertainty_reason || '').trim();
  if (reason.length > 0) {
    await supabase
      .from('receipts')
      .update({
        status: 'error',
        result_json: resultJson,
        error_message: `自信度 high だが迷いの記述あり: ${reason}`,
      })
      .eq('id', receipt.id);
    errors++;
    continue;
  }
}
```

**配置位置**: L336 の `}` 直後、L338 の splits 整合性チェック直前。

#### 11.5.3 期待動作
- LLM が `confidence:'high'` + `uncertainty_reason:''`（空）→ 既存通り done パスへ
- LLM が `confidence:'high'` + `uncertainty_reason:'…'`（非空）→ **新規 error 化**
- LLM が `confidence:'medium'` or `'low'` → 既存通り error（v3.2 ゲートで処理済）
- 既存 `status='done'` の receipt → **一切触らない**（遡及なし）
- 新規アップロード分にのみ適用

#### 11.5.4 検証
- `node --check api/lib/prompt.js` PASS
- `node --check api/process.js` PASS
- 単体: mock の resultJson `{confidence:'high', uncertainty_reason:'店名が不確実'}` → error 化される
- 単体: mock の resultJson `{confidence:'high', uncertainty_reason:''}` → done パスへ進む
- 単体: mock の resultJson `{confidence:'medium', uncertainty_reason:'…'}` → 既存ゲートで error（v3.9.3 ゲートには到達しない）
- regression: v3.9.1 / v3.9.2 の修正項目（P3 / R 略記 / Few-shot J / apollostation 正規化）に影響なし
- regression: 既存 `status='done'` の receipts テーブル件数が施策前後で減らない（遡及なし確認）

### 11.6 統合時の注意
- **挿入順序の厳守**: 「v3.2 自信度ゲート（confidence!=='high'）」 → 「v3.9.3 high-but-doubting」 → 「v3.2 splits 整合性」 の順序。逆にすると high-but-doubting が後段の整合性チェックで上書きされる事故が出る
- **新規 receipt のみ適用** = `process.js` の新規パスのみ修正。`receipts.js` の手動 update API（L159-163 の approve/unapprove/markError）は **触らない**
- **prompt の bullet 増加に伴うトークン増**: 約 +400 トークン見積。Claude API のコンテキスト残量への影響は軽微（既存プロンプトは 4k 程度、まだ余裕大）

### 11.7 Reviewer チェックリスト追補（v3.9.3 範囲）
- [ ] `api/lib/prompt.js` §2.9 末尾にオプション H（補強推論 + 報告義務）が追記され、4 フィールド分（store/amount/date/category）の補強優先順位が明記
- [ ] `api/process.js` L336 直後に v3.9.3 high-but-doubting 検出ブロックが挿入
- [ ] 挿入位置順序: 「v3.2 自信度ゲート → v3.9.3 high-but-doubting → splits 整合性」が崩れていない
- [ ] `uncertainty_reason` の trim 比較で長さ 0 のみ通過、空白のみ文字列も通過、それ以外は error
- [ ] `error_message` 文言が「自信度 high だが迷いの記述あり: …」形式
- [ ] 既存 `done` レコードへの update / migration クエリが **無い**（遡及禁止）
- [ ] `receipts.js` 側の手動 update / approve / markError 経路に変更が **無い**
- [ ] `node --check` 全ファイル PASS
- [ ] v3.9.1（P3 / R 略記 / Few-shot J / Few-shot I AND）と v3.9.2（apollostation 正規化）に影響なし

### 11.8 完了条件
1. Team A の v3.9.3 patch（prompt.js + process.js）が Reviewer（Claude + Codex 並列）に承認される
2. `node --check` 全ファイル PASS
3. 自信度 high + uncertainty_reason 非空の mock receipt 1 件で error 化を実機確認（smoke test）
4. 既存 `status='done'` 件数の施策前後比較で **減少なし**を SQL で確認（遡及なし証跡）
5. Tech Lead が `git diff` 最終検査し approved
6. dual push（newWorld + receipt-scanner）

### 11.9 v3.9.1 / v3.9.2 / v3.9.3 の一括投入順序（Loop 7 最終形）

Engineer A への指示順:
1. **v3.9.2 §10.4** apollostation 正規化（prompt.js §2.9 オプション G + 既存 `normalizeStoreName()` への CHAIN_ALIAS_MAP 1 件追加 + process.js L283 のフォールバック検証）
2. **v3.9.3 §11.5** 自信度ゲート強化（prompt.js §2.9 オプション H + process.js L336 直後 high-but-doubting ブロック）

※ v3.9.1（P3 修正 + R 略記 + Few-shot J 鮨菊）は既に Claude 直接 Edit 済のため、Engineer は **既存変更に追記** する形になる。Reviewer は v3.9.1 / v3.9.2 / v3.9.3 の **3 件を一括レビュー**。

### 11.10 注意: 既存「正規化関数の所在」
現状 `api/process.js` L108 に `normalizeStoreName()` が既に定義され L283 で利用中。v3.9.2 §10.4 で記述した「`api/_normalize.js` を新規作成」案は **修正**: 既存 `normalizeStoreName()` 内の `STORE_NORMALIZATION_RULES` に apollostation 1 行を追加する形に変更し、新規ファイル作成は **行わない**（重複定義回避）。Engineer は §10.4 の指示より §11.10 を優先すること。

