# receipt-scanner: freee送信後のローカル保存画像を800px縮小（Storage容量節約）

- 日付: 2026-07-01
- リポジトリ: receipt-scanner（Vercel Functions `api/` / Supabase Storage bucket `receipts`）
- 対象ファイル: `api/register.js`（1ファイルのみ）
- 起票: Tech Lead

---

## 1. 概要（何を・なぜ）

- **何を**: freee 送信（画像アップロード＋取引作成）が成功した後に限り、Supabase Storage 上の同一パスのローカル保存画像を **長辺800px / JPEG q80** に縮小して**上書き**する。
- **なぜ**: OCR 精度を落とさず（OCR 入力は upload.js の ≤2000px/q85 画像・process.js で使用済＝以後不要）Storage 容量を節約する。会計の正本は freee 側に**フル解像度で**渡った後なので、ローカル画像は縮小してよい。
- **オーナー決定**: 対象=**freee送信後のみ**（未送信・ゴミ箱行きは対象外）／縮小=**長辺800px・JPEG q80**。

> 補足（実コード確認済の差分）: upload.js の現行リサイズは **2000px/q85**（設計プロンプトの「1600px」は旧値／今回は変更対象外なので影響なし）。列名は `mime_type`。

---

## 2. リスクティアと判定根拠 → **Tier S**

判定ゲート（DB / RLS / migration / 金額計算 / 認可）を全て通す:

| ゲート | 該当 | 根拠 |
|---|---|---|
| DB スキーマ / migration | **なし** | テーブル定義変更なし。receipts への書き込みも追加しない（storage_path/mime_type は SELECT のみ）。 |
| RLS | **なし** | 既存 service-role Supabase クライアント（`getSupabase()`）の Storage 上書きのみ。ポリシー変更なし。 |
| 金額 / 取引 / 税 / partner | **なし** | amount・deal・tax_code・partner ロジックには一切触れない。縮小は取引作成成功**後**の付随処理。 |
| 認可 | **なし** | 認可経路の変更なし。 |
| 変更ファイル数 | **1** | `api/register.js` のみ。 |

→ 影響は **Storage 上の画像バイナリ上書き（同一パス）1点のみ**。データ系（DB/RLS/migration/金額/認可）非接触・1ファイル → **Tier S**。
Codex は任意（本件は単純なため Claude 直接実装で可）。Reviewer は Claude 1巡。

**残存リスク（Sで許容）と緩衝**:
- 画像の不可逆縮小: ただし (a) freee 側にフル解像度が既にあり会計正本は保全、(b) ローカル画像は intake 用途（送信済後は補助）。best-effort・失敗時も 200 を変えないため登録成否に影響なし。
- upsert 上書き失敗時: catch でログのみ、元画像は残存（上書き未実行）＝データ損失なし。

---

## 3. 分割戦略

- 並列度 **1**（単一ファイル・単一関数内の局所変更）。依存・Phase 分割なし。
- 担当: engineer サブエージェント（Claude 直接実装）1名。

---

## 4. Engineer 向け実装指示（`api/register.js`）

> 読み方: Read 誤検知回避のため **Bash 経由（`sed -n` / `grep -n`）** で確認。Edit は通常使用。
> 既に Tech Lead が全文確認済。ハンドラは `export default async function handler`（L16〜237）。freee 送信ロジックは try ブロック（L116〜236）内。

### 4-1. 変数 hoist（フル解像度バッファを成功分岐まで持ち越す）

- try ブロック直下、既存の `let receipt = null;`（**L119**）/`let result_json = null;`（**L120**）の並びに **`let fullBuffer = null;`** を1行追加する。
  - `receipt` は既にこのスコープにあり成功分岐から参照可能（storage_path・mime_type は `receipt.storage_path` / `receipt.mime_type` で取得）。**新たな SELECT 追加は不要**。
- **L152** の `const buffer = Buffer.from(await fileData.arrayBuffer());` の**直後**に **`fullBuffer = buffer;`** を追加（`buffer` は `if (fileData)` 内スコープのまま／外側へ持ち出すのは `fullBuffer` 経由）。
  - `buffer` 自体の宣言・freee アップロード呼び出し（L153-158 `uploadReceiptToFreee`）は**一切変更しない**（フル解像度原本が freee に渡る順序を保証）。

### 4-2. 縮小上書き（成功分岐・200 return の直前）

- 挿入位置: **L222 `if (dealResult.ok) {` ブロック内**、**L223 の `return response.status(200).json({...})` の直前**。
- ガード条件（すべて満たす時のみ実行）:
  1. `fullBuffer` が truthy
  2. `receipt` が truthy かつ `receipt.storage_path` が truthy
  3. `receipt.mime_type` が `image/` で始まる（PDF 等除外。upload.js は jpeg 統一だが防御。`mime_type` 未設定=null の場合も skip する＝`String(receipt.mime_type || '').startsWith('image/')` 等で判定）
- 処理（**upload.js の既存 sharp chain を踏襲した object 形で統一** — Reviewer 収束のため位置引数形にしない）:
  ```
  sharp(fullBuffer)
    .rotate()                                                      // EXIF回転を焼き込み
    .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer()
  ```
  で `smallBuffer` を生成し、
  ```
  await supabase.storage
    .from('receipts')
    .upload(receipt.storage_path, smallBuffer, { upsert: true, contentType: 'image/jpeg' })
  ```
  で**同一パスへ上書き**する。
  - `supabase` インスタンス: 成功分岐スコープからは `if (receipt_id)` 内で作った `supabase` が見えないため、**縮小ブロック内で `const supabase = await getSupabase();` を再取得**する（`getSupabase` は L13 import 済・service role）。※ここは元コードの `supabase` を try 全体へ hoist する案もあるが、**再取得の方が差分が局所的で安全**＝こちらを採る。
- **best-effort 不変条件**:
  - 上記 sharp〜upload 一式を **`try { ... } catch (shrinkErr) { logger.warn(...) }`** で包む。
  - `upload` の返り値 `error` も検査し、非 null なら `logger.warn('register: post-send shrink upload failed', { err })`（throw しない）。
  - **200 レスポンスは絶対に変えない／deal のロールバックもしない**。縮小失敗は登録成功に一切影響させない。
- ログ文言例: 成功時は任意（無くてよい）、失敗時 `logger.warn('register: post-send image shrink failed (non-fatal)', { err: shrinkErr })`。**error_message は全文**（substring 短縮禁止＝組織ルール）。

### 4-3. 順序の不変条件（厳守）

1. 縮小は **freee 画像アップロード成功（`uploadReceiptToFreee` → `freeeReceiptId` 取得）** かつ **取引作成成功（`dealResult.ok === true`）** の**後**でのみ実行する。
2. **freee 送信前に縮小してはならない**（freee には必ずフル解像度 `buffer` が渡る）。
3. `fullBuffer` は L152 生成の**フル解像度そのもの**（縮小前）。縮小結果を `fullBuffer` に代入し直さない。

### 4-4. 触ってはいけないもの（out of scope）

- `api/upload.js` / `api/process.js` は**変更禁止**（OCR 入力・アップロード時リサイズは現状維持）。
- register.js 内の OCR 結果・金額・取引・税(`tax_code`)・partner・splits・section 解決ロジックは**一切変更しない**。
- receipts テーブルへの書き込み（`freee_sent_at`・deleted_at 等）は追加しない。
- 新規の重複 freee 送信経路を作らない（縮小は送信の**後段**にのみ足す。送信を再実行しうる分岐を増やさない）。

### 4-5. 再送エッジ（設計上の許容・実装不要）

縮小後に同一レシートが再度 register された場合、freee に小画像が渡りうるが: (a) 初回送信で freee は既にフル解像度を保持、(b) 送信済レシートの再送は正常フローでない、ため**許容**。今回の変更で新規の重複送信リスクは作らないこと（4-4 参照）。

---

## 5. 受け入れチェックリスト（Reviewer 1巡収束用）

Reviewer は以下を diff（`git diff`）と実コードで確認する。全項目 PASS で approve。

**A. スコープ / 順序**
- [ ] `let fullBuffer = null;` が try ブロック直下（`receipt`/`result_json` と同レベル）に hoist されている。関数外グローバルではない。
- [ ] `fullBuffer = buffer;` が L152 相当（`Buffer.from(await fileData.arrayBuffer())`）の直後にあり、`buffer` の宣言・`uploadReceiptToFreee` 呼び出しは無改変。
- [ ] 縮小ブロックが **`if (dealResult.ok)` 内・200 return の直前**にある（freee 送信前・deal 作成前には存在しない）。
- [ ] `fullBuffer` は縮小前フル解像度のまま。縮小結果を `fullBuffer` へ再代入していない。

**B. ガード / 型**
- [ ] 実行ガードが `fullBuffer` truthy かつ `receipt.storage_path` truthy かつ `mime_type` が `image/` 始まりの3条件 AND。`mime_type` null 時に skip する（TypeError にならない）。
- [ ] 上書きパスが `receipt.storage_path`（アップロード時と同一パス）。新パス生成をしていない。
- [ ] 列名は `mime_type`（`mime` ではない）。

**C. sharp / upload パラメータ**
- [ ] `.resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })`（object 形・長辺800）。
- [ ] `.jpeg({ quality: 80 })`（q80）。
- [ ] `.rotate()` が resize の前にある（EXIF 焼き込み）。
- [ ] `upload(..., { upsert: true, contentType: 'image/jpeg' })`（upsert 明示・contentType 明示）。

**D. best-effort 不変条件（最重要）**
- [ ] sharp〜upload 一式が try/catch で包まれ、catch は `logger.warn`/`error` のみ（throw しない・return しない）。
- [ ] `upload` 返り値の `error` を検査し、非 null でも 200 を変えず warn のみ。
- [ ] 縮小の成否にかかわらず 200 レスポンス（`success/deal_id/receipt_uploaded`）は不変。deal のロールバック・削除・再送を一切しない。
- [ ] エラーログは全文（substring 等の短縮なし）。

**E. スコープ境界 / 非改変**
- [ ] `api/upload.js` / `api/process.js` に差分がない。
- [ ] 金額・取引・税・partner・splits・section・receipts 書き込みロジックに差分がない。
- [ ] 新規の freee 送信経路・重複送信リスクを増やしていない。

**F. ビルド / 型 / テスト**
- [ ] `npm run build`（該当あれば）/ lint 通過。
- [ ] 既存テストがあれば通過（register 経路の回帰なし）。
- [ ] `import sharp from 'sharp';` を register.js 冒頭に追加済（upload.js と同形・package.json に sharp ^0.35.2 あり）。※Reviewer は import 追加漏れを特に確認。

---

## 6. 読み済みファイル欄（重複 Read 回避）

- `api/register.js` — 全文確認済（L1-237）。ハンドラ構造・hoist 対象スコープ（L119-120）・buffer 生成（L152）・freee upload（L153-158）・成功分岐（L222-227）確認済。**mime 列名 = `mime_type`**（L126, L156）。
- `api/upload.js` — sharp chain（L61-65: `sharp().rotate().resize({width,height,fit,withoutEnlargement}).jpeg({quality}).toBuffer()`）と storage upload 形（L79-81: `.from('receipts').upload(path, buf, {contentType})`）確認済。**現行リサイズは 2000px/q85**。`import sharp from 'sharp';`（L3）。
- `package.json` — `sharp ^0.35.2` / `@supabase/supabase-js ^2.101.1` 依存確認済。

---

## 7. 統合時の注意（Tech Lead 最終承認）

- `git diff` は `api/register.js` の1ファイルのみに閉じているか。
- 追加行は概ね: import 1行 + hoist 1行 + `fullBuffer = buffer;` 1行 + 成功分岐内の縮小 try/catch ブロック。想定 +25〜35行程度。これを大きく超える場合はスコープ逸脱を疑う。
- Tier S のため本番ゲート（RLS diff / 集計テスト）は不要。ただし手元で 1枚の実レシートで「freee 送信 → Storage 上の該当パス画像が 800px/JPEG に置き換わり、freee 側は原本解像度のまま」を目視確認できると理想（best-effort ログ warn が出ていないこと）。
- デプロイは receipt-scanner 通常フロー（auto-deploy 有／必要なら `vercel --prod`）。dual push（newWorld + receipt-scanner）。
