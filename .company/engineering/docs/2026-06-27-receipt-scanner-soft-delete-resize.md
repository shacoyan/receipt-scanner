# receipt-scanner 論理削除＋ゴミ箱 / アップロード時リサイズ / 読み取り横串ガード 設計書

- 日付: 2026-06-27
- 起案: Tech Lead
- 対象リポジトリ: `/Users/usr0103301/Documents/個人仕事/newWorld/receipt-scanner`
- Supabase prod project: `zzopayofegpmdkwckstq`（**name=receipt-scanner で list_projects 確認済**。kintai=`zjjbfffhbobwwxyvdszl` と誤投入厳禁）
- 関連スコープ: オーナー承認済（Tier L・3点一括）

---

## 1. 概要（何を・なぜ）

現状の「削除」は `api/receipts.js handleDelete` が **storage画像 .remove() + 行 .delete() の物理削除**で、復元不可。誤削除のリカバリ手段が無い。また画像は `api/upload.js` で **リサイズ無し・最大10MB/枚の生バッファ**をそのまま storage に保存しており、容量の本体になっている（receipts 行自体は約290バイト/件と極小）。Claude vision は内部で長辺≤1568px/約1.15MP に自動縮小して OCR するため、長辺~2000px で保存しても読み取り精度は変わらない。

本案件は次の3点を**一括（同一 Loop）**で実装する。

1. **論理削除＋ゴミ箱** — `receipts.deleted_at` 列を追加し、既定の削除を `deleted_at=now()` の論理削除に変更。全 read 経路から `deleted_at IS NOT NULL` を除外。ゴミ箱タブで復元（restore）／完全削除（permanent = 現行の物理削除）を提供。
2. **アップロード時リサイズ** — `api/upload.js` で storage upload 前に `sharp` で長辺 max 2000px（拡大なし）・EXIF 向き適用後メタ除去・JPEG q85 にエンコードし、`storage_path` 拡張子と `mime_type` を `image/jpeg` に統一。失敗時は元バッファでフォールバック（アップロードは止めない）。
3. **読み取り横串ガード** — `process.js` の pending 取得、`register.js` の freee 送信対象取得、`receipts.js` の GET / counts、フロント各タブの全 read 経路に `deleted_at IS NULL` 除外を漏れなく入れる。

### なぜ RLS ポリシー変更が不要か（裏取り済）

フロントは `/api` 経由でのみ Supabase にアクセスし、`api/lib/supabase.js` は `SUPABASE_SERVICE_ROLE_KEY` のシングルトンクライアント（`getSupabase()`）を返す。**Service Role は RLS をバイパス**するため、`deleted_at` の見え方制御は **API 層のクエリ条件（`.is('deleted_at', null)`）が唯一の防衛線**になる。よって RLS ポリシーは触らない。

> 注: `get_advisors` 相当で `public.receipts` は **RLS disabled**（anon/authenticated に素通し）と警告が出るが、これは本案件のスコープ外（既存状態）であり、本設計では変更しない。別件として MEMORY/オーナー判断に委ねる。

---

## 2. リスクティアと判定根拠

**Tier L（フルフロー + 本番ゲート + Reviewer 厳格）**

判定ゲート該当:

- **DB / migration**: `receipts` に列追加 + 部分 INDEX 追加（migration 004 を**ファイル作成のみ**）→ 該当
- **金額計算**: freee 送信（register.js）の対象選定ロジックに触れる → 会計データに影響しうる → 該当
- **4ファイル以上**: backend 4ファイル（migration / receipts.js / process.js / register.js / upload.js / package.json）+ frontend 7ファイル → 該当
- 認可: 直接は非該当（Service Role 固定・ログイン認可は既存のまま）だが、**論理削除済みレコードの不可視性**という「見えてはいけないものを見せない」要件が認可に準じる。

→ ゲート複数該当のため **L 確定**。

### apply / commit の責務分界（厳守）

- 本番 migration の **apply は秘書が別途実施**。**Engineer は `apply_migration` / `execute_sql` を絶対に呼ばない**（migration 004 はファイル作成のみ）。
- git commit / push も秘書が実施。
- 過去に物理削除済みデータの復旧、RLS ポリシー変更、定期バックアップ cron、既存 storage 画像の遡及リサイズは **やらない**。

---

## 3. 分割戦略（並列度・チーム・依存）

本案件は backend と frontend が **API 契約**で結合する。契約をこの設計書で確定させることで、Phase 1（backend）と Phase 2（frontend）を**疎結合に並列**できる。ただし frontend は backend の `?trash=1` / `permanent:true` / `action:'restore'` / counts の `trash` を前提とするため、**契約が唯一の真実源**。並列度 3。

- **Phase 1（並列・3 Engineer）**
  - **Engineer A（DB+receipts コア）**: migration 004 作成 + `api/receipts.js`（handleDelete / handlePatch restore / handleGet trash・除外 / handleGetCounts 除外+trash）。本案件の心臓部。
  - **Engineer B（read 横串ガード）**: `api/process.js`（pending 除外）+ `api/register.js`（freee 送信ガード）+ `api/dev-server.js`（検証のみ・原則無改修）。
  - **Engineer C（upload リサイズ）**: `api/upload.js`（sharp リサイズ）+ `package.json`（sharp 追加 + `npm install`）。**A/B と完全独立**（receipts 行への列追加に依存しない）。
- **Phase 2（Phase 1 の API 契約確定後・frontend 一括 1 Engineer 推奨）**
  - **Engineer D（frontend 配線）**: `src/types/receipt.ts` / `src/pages/dashboard/constants.ts` / `useReceipts.ts` / `useBulkActions.ts` / `cells.tsx` / `ReceiptTableRow.tsx` / `ReceiptMobileCard.tsx` / `DashboardPage.tsx` / `src/pages/ApprovePage.tsx`。タブ追加・ボタン配線は相互依存が強く 1 人で通すのが安全。

> 統合は Tech Lead が兼任。Phase 1 の 3 ファイル群はファイル重複なし（receipts.js / process.js+register.js+dev-server.js / upload.js+package.json）で衝突しない。

---

## 4. migration 004 最終SQL（確定・冪等）

ファイル: `supabase/migrations/004_receipts_soft_delete.sql`（**作成のみ。apply は秘書**）

```sql
-- 2026-06-27 receipt-scanner: 論理削除（ゴミ箱）対応
-- 適用対象 Supabase project: zzopayofegpmdkwckstq (receipt-scanner prod)
-- 🆘 適用前に必ず list_projects で name=receipt-scanner 確認
--    (kintai zjjbfffhbobwwxyvdszl と取り違え事故防止)
-- 冪等性: 再実行可能 (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)
-- 用途:
--   - receipts.deleted_at IS NULL  = 通常表示対象（アクティブ）
--   - receipts.deleted_at IS NOT NULL = ゴミ箱（論理削除済み・復元/完全削除の対象）
--   API 層 (Service Role) が deleted_at IS NULL 除外で可視性を制御する（RLS 非依存）。

BEGIN;

-- (1) 論理削除フラグ列。NULL = アクティブ。
ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN public.receipts.deleted_at IS
  '論理削除（ゴミ箱）時刻。NULL=アクティブ / NOT NULL=ゴミ箱。完全削除は別途 storage.remove + DELETE。';

-- (2) アクティブ行のホットパス用 部分INDEX
--     一覧/カウントの主クエリ = status フィルタ + created_at DESC ソート on アクティブ行。
CREATE INDEX IF NOT EXISTS idx_receipts_active
  ON public.receipts (status, created_at DESC)
  WHERE deleted_at IS NULL;

-- (3) ゴミ箱タブ用 部分INDEX（deleted_at DESC で新しく捨てた順）
CREATE INDEX IF NOT EXISTS idx_receipts_trash
  ON public.receipts (deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

COMMIT;

-- 確認クエリ (apply 後に手動 run):
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
--   WHERE table_name='receipts' AND column_name='deleted_at';
--   -- 期待: deleted_at | timestamp with time zone | YES
-- SELECT indexname FROM pg_indexes
--   WHERE tablename='receipts' AND indexname IN ('idx_receipts_active','idx_receipts_trash');
--   -- 期待: 2 行
-- SELECT count(*) FROM receipts WHERE deleted_at IS NOT NULL;  -- 初期 0
```

設計判断:

- `BEGIN; ... COMMIT;` で囲う（既存 002/003/category-unify の様式に合わせる）。`ADD COLUMN` / `CREATE INDEX`（`CONCURRENTLY` ではない）はトランザクション内で可。**本番 receipts は約62行と極小**のため `CREATE INDEX`（テーブルロック数ms）で問題なし。`CONCURRENTLY` は不要（むしろ BEGIN 内で使えない）。
- `status` の CHECK 制約は `deleted_at` と独立（CHECK は status 列のみ参照）。列追加で **既存 CHECK は壊れない**。
- 既存行は `deleted_at` が NULL（デフォルト）→ 全件アクティブ扱い。挙動互換。

---

## 5. API 契約（delete soft / permanent / restore / trash一覧 / counts）

エンドポイントは既存どおり `/api/receipts`（メソッド分岐）。**既存の PATCH 編集（action: approve/unapprove/update/rerun/markError）は一切変更しない。**

### 5.1 DELETE /api/receipts — 論理削除（既定）/ 完全削除（permanent）

リクエスト body（JSON）:

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `ids` | `string[]`（非空） | ✓ | 対象レシート ID 配列 |
| `permanent` | `boolean` | 任意（既定 false） | `true` のとき**現行の物理削除**（storage `.remove` + 行 `.delete`）。省略/false のとき**論理削除** |

- **論理削除（既定）**: `UPDATE receipts SET deleted_at = now() WHERE id IN (ids) AND deleted_at IS NULL`。storage 画像・行は残す。冪等（既に論理削除済みは `deleted_at IS NULL` 条件で再更新されない）。`{ count: 'exact' }` で更新件数取得。
- **完全削除（permanent:true）**: 現行 handleDelete と同一フロー。`select('id, storage_path').in('id', ids)` → `storage.from('receipts').remove(storagePaths)`（失敗は warn して継続）→ `delete().in('id', ids)`。**ゴミ箱内/アクティブを問わず物理削除可**（permanent は明示操作なので条件を付けない。ただしフロントは原則ゴミ箱タブからのみ呼ぶ）。

レスポンス（200）:

```jsonc
// 論理削除
{ "success": true, "mode": "soft", "deleted": <updated件数> }
// 完全削除
{ "success": true, "mode": "hard", "deleted": <deleted件数> }
```

エラー: `ids` 不正は 400 `{ "error": "ids array is required" }`（現行踏襲）。例外時 500 `{ "error": <msg> }`。

> soft/hard を `mode` フィールドで明示区別（スコープの「返却に soft/hard を区別」要件）。フロントは `mode` で確認ダイアログ文言・トースト文言を切り替えられる（必須ではない）。

### 5.2 PATCH /api/receipts — 復元（action: 'restore'）を追加

既存 PATCH の `action` allowlist に **`restore` を追加**する。それ以外の action（approve/unapprove/update/rerun/markError）の検証・payload は**完全に現状維持**。

リクエスト body（JSON）:

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `ids` | `string[]`（非空） | ✓ | 対象 ID |
| `action` | `'restore'` | ✓ | 復元 |

- 処理: `restore` のとき `updatePayload = { deleted_at: null }`。`UPDATE ... WHERE id IN (ids)`（既存の共通 update ブロックをそのまま通す）。`status` は復元時に変更しない（捨てる前の status を維持）。
- allowlist 変更: `['approve','update','unapprove','rerun','markError']` → `['approve','update','unapprove','rerun','markError','restore']`。エラーメッセージにも `restore` を追記。

レスポンス（200）: 既存どおり `{ "success": true, "updated": <count> }`。

> restore を PATCH の新 action に乗せることで、既存の単件編集 PATCH 経路（共通 `update().in('id', ids)`）を**壊さず**最小差分で実現する。`deleted_at` は `update` action の `result_json` 検証ブロックを通らない（`action==='update'` 分岐のみが data 検証する）ため安全。

### 5.3 GET /api/receipts — 既定でアクティブのみ / ?trash=1 でゴミ箱

| クエリ | 既定挙動 | 変更後挙動 |
|---|---|---|
| `?counts=1` | counts モード | 各カウントに `deleted_at IS NULL`、`trash` カウント追加（5.4） |
| `?status=...&sent=...&page=&limit=` | 一覧 | **`deleted_at IS NULL` を既定付与**。status/sent フィルタは温存 |
| `?trash=1`（または `?deleted=1`） | （新規） | `deleted_at IS NOT NULL` の行のみ返す。**status/sent フィルタは無視**し、`order('deleted_at', desc)` で新しく捨てた順 |

- 実装: `handleGet` 冒頭で `const isTrash = req.query?.trash === '1' || req.query?.deleted === '1';`
  - `isTrash` のとき: `query.not('deleted_at', 'is', null).order('deleted_at', { ascending: false })`。status/sent の `if` 分岐は**スキップ**（trash では全 status を見せる）。`range`/`count`/signed URL 生成は共通。
  - `isTrash` でないとき: 既存クエリに `.is('deleted_at', null)` を追加。status/sent 分岐は現状維持。
- signed URL 生成（`getCachedSignedUrl`）は両モード共通。論理削除でも storage 画像は残っているので**ゴミ箱でもサムネ表示可能**。

レスポンス（200）: 既存どおり `{ data: Receipt[], total, page }`（各 `Receipt` に `image_url` 付与）。`Receipt` には `deleted_at` も含めて返す（フロント型に追加）。

### 5.4 GET /api/receipts?counts=1 — 全カウントにアクティブ除外 + trash 追加

`handleGetCounts` の `base()` は `select('*', { count:'exact', head:true })`。**全 6 枝に `.is('deleted_at', null)` を付与**し、7 枝目 `trash` を追加。

```jsonc
// 変更後 base 群（擬似）
all          = base().is('deleted_at', null)
analyzing    = base().is('deleted_at', null).in('status', ['pending','processing'])
done         = base().is('deleted_at', null).in('status', ['done'])
approved     = base().is('deleted_at', null).in('status', ['approved']).is('freee_sent_at', null)
sent         = base().is('deleted_at', null).in('status', ['approved']).not('freee_sent_at','is', null)
error        = base().is('deleted_at', null).in('status', ['error'])
trash        = base().not('deleted_at', 'is', null)   // ★追加
```

レスポンス（200）:

```jsonc
{
  "all": 0, "analyzing": 0, "done": 0,
  "approved": 0, "sent": 0, "error": 0,
  "trash": 0                                  // ★追加
}
```

> `all` カウントが「アクティブ全件（ゴミ箱を含まない）」になることで、タブ「全て」の件数と一覧が論理削除分を除いて**整合**する（スコープの検証要件）。

---

## 6. backend ファイル別 変更指示

### 6.1 `supabase/migrations/004_receipts_soft_delete.sql`（新規・Engineer A）

§4 の SQL をそのまま新規作成。**apply 禁止**（ファイル作成のみ）。

### 6.2 `api/receipts.js`（Engineer A）

1. **handleGetCounts**（48–74行）: §5.4 のとおり全 6 枝に `.is('deleted_at', null)` を付与し、`trash` 枝を `Promise.all` に追加。返却 JSON に `trash` 追加。
2. **handleGet**（76–133行）: §5.3。冒頭で `isTrash` 判定。trash 時は `.not('deleted_at','is',null).order('deleted_at',{ascending:false})` かつ status/sent 分岐スキップ。非 trash 時は既存クエリに `.is('deleted_at', null)` を追加（`counts==='1'` の早期 return より後、クエリ組み立て時）。`select('*')` のままで `deleted_at` も返る。
3. **handlePatch**（135–263行）: action allowlist に `'restore'` 追加（151–153行のバリデーション）。`restore` 分岐 `updatePayload = { deleted_at: null }` を `if (action === 'approve')` 連鎖の適切な位置に追加（`update` の前後どちらでも可・data 検証を通さないこと）。**既存 update/approve 等のロジックは無改変**。共通の `update(updatePayload).in('id', ids)`（249–252行）をそのまま再利用。
4. **handleDelete**（265–321行）: body から `permanent` を取得。
   - `permanent === true` → 現行の物理削除フロー（select storage_path → storage.remove → delete）。返却 `{ success:true, mode:'hard', deleted:count }`。
   - それ以外 → `UPDATE receipts SET deleted_at=now()` を `{ count:'exact' }` 付きで `WHERE id IN (ids)`、かつ `.is('deleted_at', null)`（冪等・二重カウント防止）。storage/行は触らない。返却 `{ success:true, mode:'soft', deleted:count }`。

  > supabase-js の UPDATE は RLS 0 行を無音 success にするが、本件は Service Role なので RLS 0 行は起きない。それでも `{ count:'exact' }` を取り、`deleted` を返すことで「対象 0 件」をフロントが検知できる形にする（MEMORY の mutate 落とし穴対策）。

### 6.3 `api/process.js`（Engineer B）

- pending 取得（238–243行）: `.eq('status','pending')` に **`.is('deleted_at', null)` を追加**。論理削除済みの pending を OCR 解析しない。
- それ以外（processing マーク・requeue・status 更新・OCR ロジック）は無改変。requeue（289–293行）は `id IN (deferredIds)` で動くため deleted_at 条件は不要（対象はこのループで掴んだアクティブ id のみ）。

### 6.4 `api/register.js`（Engineer B）

- id 指定取得（122–129行）: `select('storage_path, mime_type, original_filename, section_id, result_json')` に **`deleted_at` を追加**。
- 取得直後に安全弁: `receipt` が取れて `receipt.deleted_at != null` なら **freee 送信を中止**して 4xx/409 を返す（例: `return response.status(409).json({ error: '削除済み（ゴミ箱）のレシートは freee 送信できません' });`）。`single()` で取れない（既に物理削除）場合は既存の `receiptSelectError` ログ経路に乗る（現状維持）。
  - 配置: `if (receipt_id) { ... .single(); ... }` ブロック内、`receipt = receiptData;` の直後・画像ダウンロード前。
- これにより、フロントが論理削除済みを送信対象に含めない前提が崩れても **二重防御**が効く（freee への誤送信＝会計事故を防ぐ）。

> 注: `register.js` は `request.body` を直に読む（`bodyParser` 無効化なし＝Vercel 既定 JSON parse）。`receipt_id` 経由のみ DB を引くため、`deleted_at` ガードはこの 1 経路で十分。`createDealAndMarkReceipt`（freee.js）側は受け取った receiptId をそのまま `update().eq('id', receiptId)` するだけなので追加ガード不要。

### 6.5 `api/dev-server.js`（Engineer B・原則無改修）

- GET/PATCH/DELETE は既にルーティング済み（134–140行）。`?trash=1` は `query` オブジェクトに自動的に乗る。PATCH `action:'restore'` / DELETE `permanent:true` は既存の `parseJsonBody` で `req.body` に入る。**新規パラメータ/アクションのために dev-server を変更する必要はない**。
- Engineer B は「ローカルで GET `?trash=1` / PATCH restore / DELETE permanent が通ること」を**確認するのみ**（コード変更なし）。万一通らない事象があれば最小修正。

### 6.6 `api/upload.js` + `package.json`（Engineer C）

- `package.json`: `dependencies` に `sharp` を追加し、`npm install` を実行して `package-lock.json` を更新。sharp は `api/`（Vercel Functions）専用で Vite ビルド（フロント）には import されない。
- `api/upload.js`:
  - `import sharp from 'sharp';` を追加。
  - ファイルループ内、`imageBuffer = await fs.readFile(file.filepath)` の後に **リサイズ処理**を挟む:
    ```js
    let outBuffer = imageBuffer;
    let outMime = 'image/jpeg';
    let outExt = 'jpg';
    try {
      outBuffer = await sharp(imageBuffer)
        .rotate()                       // EXIF 向きを適用（その後メタは破棄される）
        .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch (e) {
      logger.warn('upload: sharp resize failed, using original buffer', { err: e, fileName: file.originalFilename });
      outBuffer = imageBuffer;          // フォールバック: 元バッファ
      // フォールバック時は mime/ext を元のものに戻す（下記参照）
    }
    ```
  - **storagePath 拡張子と mime_type の統一**: リサイズ成功時は `storagePath = \`${yearMonth}/${id}.jpg\``、`contentType: 'image/jpeg'`、insert の `mime_type: 'image/jpeg'`。
  - **フォールバック時の整合**: sharp が失敗して元バッファを使う場合、拡張子/mime を**元ファイル由来**（現行の `ext`/`mimeType`）に戻す。成功/失敗で `outExt`/`outMime` を確定し、`storagePath`・`upload(contentType)`・`insert(mime_type)` の3箇所で同じ値を使う（**齟齬を作らない**）。
    - 実装方針: 成功時に `outExt='jpg'; outMime='image/jpeg';`、catch 時に `outExt = (path.extname(file.originalFilename||'').replace('.','') || 'jpg'); outMime = mimeType;` をセットし、以降は `outExt`/`outMime`/`outBuffer` のみを使う。
  - upload は `upsert:false`・`id` は `crypto.randomUUID()` で衝突しないため、拡張子変更による storagePath 衝突は起きない。
  - 非画像スキップ（43–45行）・temp cleanup（90–94行）・エラーログは現状維持。

  > OCR 影響: `process.js` はダウンロードした実バイト列を base64 化して送るだけで mime は `receipt.mime_type || 'image/jpeg'` を使う。リサイズ後 JPEG + `mime_type='image/jpeg'` なので Claude に正しく渡る。長辺2000px は Claude 内部の1568px 縮退より大きいため精度不変。

---

## 7. frontend ファイル別 変更指示（Engineer D）

### 7.1 `src/types/receipt.ts`

- `interface Receipt` に `deleted_at?: string | null;` を追加（既存フィールドは不変）。

### 7.2 `src/pages/dashboard/constants.ts`

- `TabKey` に `'trash'` を追加: `'all' | 'analyzing' | 'done' | 'approved' | 'sent' | 'error' | 'trash'`。
- `TabDef` に `trash?: boolean` フラグを追加（オプショナル）。
- `TABS` 末尾に `{ key: 'trash', label: 'ゴミ箱', statuses: null, sent: null, trash: true }` を追加。

### 7.3 `src/pages/dashboard/useReceipts.ts`

- `EMPTY_COUNTS` に `trash: 0` を追加（`TabCounts = Record<TabKey, number>` なので **trash を入れないと型エラー**になる→必須）。
- `fetchTabCounts` の `setTabCounts({...})` に `trash: j.trash ?? 0` を追加。
- `fetchReceipts` の URL 生成: アクティブタブが trash のとき `?trash=1` を投げ、status/sent param は**付けない**。実装:
  ```ts
  const activeDef = TABS.find(t => t.key === activeTab);
  if (activeDef?.trash) {
    url = `/api/receipts?trash=1&page=${page}&limit=${PAGE_LIMIT}`;
  } else {
    const statusParam = statusQueryParam();
    url = `/api/receipts?${statusParam ? statusParam + '&' : ''}page=${page}&limit=${PAGE_LIMIT}`;
  }
  ```
  （`statusQueryParam` は trash 時 statuses/sent が null なので空文字を返すが、明示的に trash 分岐させて意図を明確化＋将来 status 付きトラッシュ検索の誤発火を防ぐ。）
- 自動更新（10s ポーリング）はそのまま全タブで機能（trash 一覧も silent refetch される）。

### 7.4 `src/pages/dashboard/useBulkActions.ts`

- **`deleteSelected`**: 挙動は論理削除（body はそのまま `{ ids }`＝既定 soft）。確認文言を「ゴミ箱に移動」に変更:
  - 例: `window.confirm(\`選択した${ids.length}件をゴミ箱に移動しますか？\nゴミ箱からは復元できます。\`)`。失敗 alert も「ゴミ箱への移動に失敗しました」。
- **`restoreSelected`（新規）**: `PATCH { ids, action:'restore' }`。成功で `setSelected(new Set())` + `await onMutate()`。確認は不要（復元は安全操作）。失敗 alert「復元に失敗しました」。
- **`permanentDeleteSelected`（新規）**: **強い確認**付き `DELETE { ids, permanent:true }`。
  - 例: `window.confirm(\`選択した${ids.length}件を完全に削除します。\n画像も含めて完全に削除され、元に戻せません。本当に削除しますか？\`)`。失敗 alert「完全削除に失敗しました」。
- `UseBulkActionsResult` インターフェースに `restoreSelected: () => Promise<void>` と `permanentDeleteSelected: () => Promise<void>` を追加し、return に含める。
- `sendToFreee` の対象 base フィルタ（238–240行）は `r.status === 'approved' && r.result_json && !r.freee_sent_at`。**論理削除済みはそもそも一覧（receipts）に出てこない**（GET が除外）ので追加フィルタ不要だが、二重防御として `!r.deleted_at` を AND に足してもよい（任意・コストゼロ）。backend §6.4 のガードが本丸。

### 7.5 `DashboardPage.tsx`（バルクアクションバー / タブ）

- タブ表示（124–139行）は `TABS.map` なので **trash タブは自動で増える**（label「ゴミ箱(件数)」）。追加コード不要。
- バルクアクションバー（141–229行）を**タブ別に出し分け**:
  - `activeTab !== 'trash'` のとき: 既存の「承認 / 削除 / 解析済みに戻す / 再判定 / (error時)承認モード / freee送信」を**現状どおり**表示。「削除」ボタンの文言は「ゴミ箱へ移動」に変更（`deleteSelected` が論理削除になったため）。
  - `activeTab === 'trash'` のとき: 上記の承認系/送信系を**隠し**、代わりに **「復元」ボタン（`b.restoreSelected`）** と **「完全削除」ボタン（`b.permanentDeleteSelected`＝赤・強）** のみ表示。いずれも `disabled={b.selected.size === 0}`。
  - 実装は `{activeTab === 'trash' ? (<復元/完全削除>) : (<既存バルク群>)}` の三項で分岐するのが最小。freee 送信ボタン（200–228行）も trash では非表示にする（送信対象が無いため）。
- ゴミ箱タブでも一覧テーブル/カードは既存の `ReceiptTableRow` / `ReceiptMobileCard` をそのまま再利用（画像サムネは signed URL で表示可）。
- 行内の「編集 / 分割 / 承認」導線は trash でも表示されうるが、論理削除済みでも status は維持される（done/error/approved）ため編集ボタンは出る。**MVP では行内編集は許容**（編集→保存しても deleted_at は触らないので害は小さい）。より厳密にするなら trash 時に行内編集を抑止できるが、スコープ外として**任意**扱い。

### 7.6 `cells.tsx` / `ReceiptTableRow.tsx` / `ReceiptMobileCard.tsx`

- これらは `Receipt` を受け取り表示するだけ。`deleted_at` 追加で**型エラーは出ない**（オプショナル）。**原則無改修**。
- スコープの「cells.tsx / ReceiptTableRow / ReceiptMobileCard でゴミ箱タブと復元/完全削除ボタンを配線」は、行単位の復元/完全削除ボタンを**もし**付けるなら、という指示。**MVP はバルク操作（選択→復元/完全削除）で実装**し、行単位ボタンは付けない（差分最小・並列衝突回避）。行単位を付ける場合は props に `onRestore?(id)`/`onPermanentDelete?(id)` を追加する設計だが、**今回は見送り推奨**（DashboardPage のバルクバーで完結）。
  - → Engineer D は **cells/Row/Card を改修しない**（型追加のみで通る）。レビューで「ゴミ箱配線が無い」と誤指摘されないよう本設計で明記。

### 7.7 `src/pages/ApprovePage.tsx`

- `handleDelete`（119–140行）: 現在 `DELETE { ids:[receipt.id] }` で**物理削除**（permanent 無指定＝backend 変更後は自動的に論理削除になる）。**body は変更不要**（既定 soft に乗る）。確認文言のみ「このレシートをゴミ箱に移動しますか？」に更新。`removeFromQueue` でキューから消すのは現状維持（承認画面の挙動は変わらない）。
- ApprovePage は done/error キューを `?status=done|error` で引く（22行）。backend GET が `deleted_at IS NULL` を既定除外するので、**ゴミ箱送りした項目は次回フェッチで自動的に消える**（追加対応不要）。

---

## 8. 受け入れチェックリスト（Reviewer 1巡収束用）

- [ ] **migration 004 はファイル作成のみ**。`apply_migration`/`execute_sql` を**呼んでいない**（diff/コマンド履歴で確認）。SQL は `IF NOT EXISTS` で冪等・`BEGIN..COMMIT` 様式・project name コメント有り。
- [ ] `handleGetCounts`: 全 6 枝に `.is('deleted_at', null)`、`trash` 枝（`.not('deleted_at','is',null)`）追加、返却に `trash`。
- [ ] `handleGet`: 非 trash は `.is('deleted_at', null)` 付与、status/sent フィルタ温存。`?trash=1` で `.not('deleted_at','is',null)` + `order('deleted_at',desc)` + status/sent スキップ。`?counts=1` 早期 return は不変。
- [ ] `handlePatch`: allowlist に `restore` 追加のみ。**approve/unapprove/update/rerun/markError の検証・payload・共通 update は無改変**（diff で確認）。restore は `{ deleted_at: null }` で data 検証を通らない。
- [ ] `handleDelete`: 既定 soft（`deleted_at=now()` + `is('deleted_at',null)` + `{count:'exact'}`）。`permanent:true` のみ物理削除（storage.remove→delete）。返却に `mode: 'soft'|'hard'`。
- [ ] `process.js` pending fetch に `.is('deleted_at', null)`。それ以外無改変。
- [ ] `register.js`: select に `deleted_at` 追加 + `receipt.deleted_at != null` で送信中止（4xx/409）。**freee へ削除済みが送られない**。
- [ ] `dev-server.js`: 無改修（または最小）で `?trash=1`/restore/permanent がローカル疎通。
- [ ] `upload.js`: sharp で長辺2000px・`withoutEnlargement`・`.rotate()`・JPEG q85。**try/catch でフォールバック**（失敗時 元バッファ）。成功/失敗で `storagePath 拡張子`・`contentType`・`mime_type` の3箇所が**一貫**（成功=jpg/image/jpeg、失敗=元 ext/元 mime）。`package.json` に sharp 追加 + lock 更新。
- [ ] `types/receipt.ts`: `Receipt.deleted_at?: string|null`。
- [ ] `constants.ts`: `TabKey` に `'trash'`、`TabDef.trash?`、`TABS` に ゴミ箱エントリ。
- [ ] `useReceipts.ts`: `EMPTY_COUNTS.trash`、`setTabCounts` に `trash`、trash タブ時 `?trash=1` で fetch（status param 不付与）。**`TabCounts` 型に trash が無いと tsc 落ちる**点に注意（漏れ即検知）。
- [ ] `useBulkActions.ts`: `deleteSelected` 文言「ゴミ箱に移動」（挙動=soft）、`restoreSelected`（PATCH restore）、`permanentDeleteSelected`（DELETE permanent・強い確認）追加し interface/return に反映。
- [ ] `DashboardPage.tsx`: trash タブで承認系/送信系を隠し復元/完全削除のみ表示。非 trash の「削除」文言を「ゴミ箱へ移動」に。タブ自体は `TABS.map` で自動増。
- [ ] `cells.tsx`/`ReceiptTableRow.tsx`/`ReceiptMobileCard.tsx`: **無改修**（型追加で通る・行単位ボタンは今回作らない）。
- [ ] `ApprovePage.tsx`: `handleDelete` 文言「ゴミ箱に移動」（body 不変で soft）。done/error キューから論理削除分が消える。
- [ ] **既存タブ（全て/解析中/解析済み/承認済み/送信済み/エラー）のカウントと一覧が論理削除分を除いて整合**。送信済みタブ・freee 送信が壊れない。
- [ ] `npx tsc --noEmit` 通過 / `npm run build` 通過。

### 単位・型・境界の明示（収束のため）

- `deleted_at` は **timestamptz**。フロント型は `string | null`（ISO 文字列）。判定は **NULL/NOT NULL のみ**（真偽値カラムではない）。
- 論理削除の冪等条件は `AND deleted_at IS NULL`（二度押しで件数が嵩まない）。
- `mode` は `'soft' | 'hard'` の文字列リテラル。
- counts レスポンスは7キー固定（all/analyzing/done/approved/sent/error/trash）すべて number。
- freee 送信ガードは **register.js（API層・Service Role）が正本**。フロントの `!r.deleted_at` は任意の二重防御。

---

## 9. 読み取り横串ガード チェックリスト（deleted_at IS NULL 除外を入れる全 read 経路）

論理削除済みが「見えてはいけない/処理されてはいけない」全経路を列挙（guard_checklist 正本）:

1. `api/process.js` — pending 取得（`.eq('status','pending')` に `.is('deleted_at', null)` 追加）。OCR 対象から除外。
2. `api/receipts.js handleGet` 一覧 — 非 trash モードに `.is('deleted_at', null)` 追加。
3. `api/receipts.js handleGet` trash モード — `.not('deleted_at','is',null)`（ゴミ箱のみ表示・専用経路）。
4. `api/receipts.js handleGetCounts` — 全6カウント枝に `.is('deleted_at', null)`、trash 枝は `.not('deleted_at','is',null)`。
5. `api/register.js` — freee 送信対象の id 取得 select に `deleted_at` 追加 + `deleted_at != null` で送信中止。
6. フロント `useReceipts.fetchReceipts` — 非 trash タブは backend 既定で除外（フロント変更不要）／trash タブは `?trash=1`。
7. フロント `useReceipts.fetchTabCounts` — backend counts が除外 + trash 提供（フロントは `trash` を受けるのみ）。
8. フロント `ApprovePage.fetchQueue` — `?status=done|error` は backend GET が `deleted_at IS NULL` 既定除外（フロント変更不要・文言のみ）。
9. フロント `useBulkActions.sendToFreee` の base フィルタ — 一覧自体が除外済みのため対象に入らない（任意で `!r.deleted_at` 追加可）。

> 非除外で良い経路（明示）: `handleDelete` permanent（ゴミ箱内を消すので除外しない）/ `handlePatch restore`（ゴミ箱内を戻すので `deleted_at IS NOT NULL` 対象＝除外しない）/ `process.js` requeue（このループで掴んだアクティブ id のみ）/ `freee.js createDealAndMarkReceipt` の `update().eq('id', receiptId)`（呼び出し元 register.js でガード済）。

---

## 10. リスク列挙

1. **sharp の Vercel デプロイ（最重要）**: `sharp` はネイティブ（libvips）バイナリ依存。Vercel Functions（Linux x64）で動かすには **linux-x64 バイナリが同梱**される必要がある。ローカル（darwin/arm64）で `npm install` した `package-lock.json` のままだと、Vercel ビルドで適切なバイナリが解決されないと**実行時に "Could not load the sharp module" で upload が 500**になりうる。
   - 緩和: sharp は近年 **optional dependencies に各プラットフォームの prebuilt（`@img/sharp-linux-x64` 等）を含む**設計のため、Vercel の `npm install` で linux バイナリが解決されるのが通常。だが念のため **本番デプロイ後に upload を 1 枚実機テスト**（プレビュー or 本番）して 500 が出ないことを確認する。出た場合の対処は `sharp` の version 固定 / `--include=optional` / Vercel の Node ランタイム整合を検討（**この検証はデプロイ責務を持つ秘書/オーナーのゲート項目**）。
   - try/catch フォールバックがあるため、**最悪でも「リサイズされない元画像が保存される」だけで upload 自体は成功**する設計（sharp import 自体が失敗するケースはモジュール解決エラーで catch 外になりうる点に注意 → import は top-level なので、import が壊れると関数全体が起動失敗。**動的 import + フォールバック**も選択肢だが、まず prebuilt 解決を信頼し実機確認で担保）。
2. **OCR 精度の回帰**: 長辺2000px・JPEG q85 は Claude 内部縮退（1568px/1.15MP）より高解像度なので**理論上は精度不変**。ただし q85 圧縮で微細な文字（小さな税率表記等）が劣化する可能性は残る。受領レシートで OCR が悪化していないか **デプロイ後に数枚の新規アップロードで done 率を観察**（process.js のゲートが厳しいので、もし悪化すれば error 増として顕在化する）。
3. **freee 誤送信（会計事故）**: 論理削除済みが freee に飛ぶと取り消しコストが高い。→ §6.4 の register.js ガード（API層・Service Role）を**正本の防衛線**にし、フロント除外を二重防御に。Reviewer はこのガードの存在を必ず確認。
4. **容量・コスト**: storage 使用量は**新規アップロード分から削減**（既存画像は遡及リサイズしない＝スコープ外）。論理削除は storage を消さないため、**ゴミ箱に溜め続けると storage が増える**。当面は手動の完全削除で運用（将来 cron で N 日経過ゴミ箱の自動 purge を検討余地・今回はやらない）。receipts 行自体は約290B と無視できる。
5. **migration の取り違え（致命）**: kintai prod（`zjjbfffhbobwwxyvdszl`）と同 region・同 org で**区別困難**。apply は秘書が **list_projects で name=receipt-scanner を突合してから**実施。SQL ファイル冒頭にも警告コメントを記載済。
6. **status CHECK 制約**: `status = ANY(['pending','processing','done','error','approved'])` は `deleted_at` と独立。列追加で壊れないことを確認済（schema 実査）。**論理削除は status を変えない**（done のままゴミ箱）ため CHECK 違反は起きない。
7. **trash タブの行内編集**: ゴミ箱でも編集ボタンが出るが、保存しても `deleted_at` は触らない（PATCH update は result_json/section_id のみ更新）ので害は限定的。厳密化は任意（スコープ外）。
8. **dev-server の body parse**: PATCH/DELETE は `parseJsonBody` 済。`permanent`/`action:'restore'` は同じ body に乗るだけで追加処理不要。万一ローカルで通らなければ Engineer B が最小修正（リスク低）。
9. **INDEX 作成ロック**: 本番 receipts は約62行で `CREATE INDEX`（非 CONCURRENTLY）でも数ms。`BEGIN..COMMIT` 内で問題なし。テーブル肥大化前提の `CONCURRENTLY` は不要（むしろ BEGIN 内不可）。
10. **mutate 0行の無音 success**: Service Role なので RLS 0 行は起きないが、`handleDelete` soft / restore は `{count:'exact'}` を取り `deleted`/`updated` を返す → フロントが「0件適用」を検知可能（MEMORY の mutate 落とし穴に沿う）。

---

## 11. 本番ゲート手順（Tier L・apply は秘書）

1. **project name 突合**: `list_projects` で `zzopayofegpmdkwckstq` = `receipt-scanner` を確認してから migration 004 を apply。
2. **migration 適用順**: DB apply（004）→ コード dual push（逆だと、コードが `deleted_at` を参照する窓で列が無く 42703 になる窓を作らないため。実際には backend は `is('deleted_at', null)` を投げるので **列が無いと 42703 undefined_column** → **必ず apply 先行**）。
3. **適用後検証 SQL**（§4 末尾の確認クエリ）: 列が timestamptz/nullable・INDEX 2本・`deleted_at IS NOT NULL` が 0 件。
4. **挙動検証（本番無汚染・推奨）**:
   - soft delete: 1件を `DELETE {ids:[x]}` → `all`/該当 status カウントが 1 減り `trash` が 1 増。一覧から消える。`SELECT deleted_at FROM receipts WHERE id=x` が NOT NULL。
   - restore: `PATCH {ids:[x], action:'restore'}` → `trash` 1 減・元タブ復帰・`deleted_at` NULL。
   - permanent: ゴミ箱の 1件を `DELETE {ids:[x], permanent:true}` → 行が物理消滅・storage 画像も消滅。
   - register ガード: 論理削除済み id で `/api/register` を叩き 409（freee に deal が作られないこと）。
   - **検証は使い捨てレコードで行い、本番の正規データは触らない**。
5. **upload 実機テスト**: 1枚アップロード → storage に `.jpg`・`mime_type='image/jpeg'`・サイズが縮小されていること、`status` が pending→done に流れること（sharp が Vercel で動く証跡）。
6. **集計整合**: 各タブ件数（all/analyzing/done/approved/sent/error/trash）の和と実 DB 件数が合うこと。

---

## 12. 読み済みファイル欄（重複 Read 回避）

Tech Lead が本設計で全文確認済（Engineer は担当範囲のみ再読すればよい）:

- `api/receipts.js`（1–321 全）/ `api/process.js`（1–638 全）/ `api/register.js`（1–231 全）/ `api/upload.js`（1–106 全）/ `api/dev-server.js`（1–166 全）/ `api/lib/freee.js`（1–225 全）/ `api/lib/supabase.js`（1–26 全）
- `src/types/receipt.ts`（1–91 全）/ `src/pages/dashboard/constants.ts`（1–49 全）/ `src/pages/dashboard/useReceipts.ts`（1–159 全）/ `src/pages/dashboard/useBulkActions.ts`（1–318 全）/ `src/pages/dashboard/cells.tsx`（1–139 全）/ `src/pages/dashboard/ReceiptTableRow.tsx`（1–289 全）/ `src/pages/dashboard/ReceiptMobileCard.tsx`（1–298 全）/ `src/pages/DashboardPage.tsx`（1–358 全）/ `src/pages/ApprovePage.tsx`（1–318 全）
- `supabase/migrations/`（001/002/003/2026-05-13-category-unify 全）
- prod schema: `list_tables(zzopayofegpmdkwckstq)` で `receipts` 列構成・CHECK・RLS 状態を実査。

> **TabBar.tsx は存在しない**（タブ UI は `DashboardPage.tsx` 124–139 にインライン）。スコープの「TabBar」配線は DashboardPage で行う。

---

## 13. 統合時の注意（Tech Lead）

- Phase 1 の 3 ファイル群（receipts.js / process.js+register.js / upload.js+package.json）はファイル重複なし → マージ衝突しない。
- Phase 2 frontend は backend 契約に依存。**契約変更があれば本設計書を更新してから frontend 着手**。
- `useReceipts.ts` の `TabCounts = Record<TabKey, number>` は `EMPTY_COUNTS`/`setTabCounts` の両方で trash を入れないと tsc が落ちる → 漏れは即検知される（良い性質）。
- 最終承認は `git diff` 直接検査 + `tsc`/`build` 通過 + 本番ゲート成果物（apply 後検証 SQL 結果・upload 実機テスト・register 409 確認）を秘書/オーナーから受領して判断。
