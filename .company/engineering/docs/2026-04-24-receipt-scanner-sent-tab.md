# receipt-scanner 「送信済み」タブ実装

- Date: 2026-04-24
- Owner: Tech Lead
- Target project: receipt-scanner

---

## 1. 概要 / ゴール

### 現状課題
- freee 登録機能（`api/register.js`）は実装済みで、ダッシュボードから承認済みレシートを freee に送信できる。
- しかし「送信済み」状態は `DashboardPage.tsx` の `useState<Set<string>>(sentIds)` によるフロント上のローカル状態でしか保持されていない。
- リロード・別端末・セッション切れで送信済みフラグが消失し、同じレシートを二重送信するリスクがある。

### オーナー承認済み仕様
1. **永続化**: DB（Supabase `receipts` テーブル）に送信済み状態を保持する。マイグレーション（カラム追加）OK。
2. **UX**: 「送信済み」という新規タブを追加。承認済みタブからは送信済みレシートを除外し、送信済みタブに移す。
3. **フロー**: 既存の「承認 → freee 送信」フローは変更なし。送信成功時に自動で送信済みタブに移動する。

### ゴール
- `receipts` テーブルに `freee_sent_at` / `freee_deal_id` を追加。
- `api/register.js` が freee 登録成功時に DB へ送信記録を書き込む。
- ダッシュボードに「送信済み」タブを追加し、以下の振り分けを DB の値ベースで行う:
  - approved タブ: `status = 'approved' AND freee_sent_at IS NULL`
  - sent タブ: `status = 'approved' AND freee_sent_at IS NOT NULL`（※本設計では「送信済み」は `status = 'approved'` のまま `freee_sent_at` の有無で判定する方針）
- freee 送信ボタンは「承認済みかつ未送信」のもののみを対象にする。二重送信ガード。

---

## 2. 分割戦略

シンプルな変更なので **2チーム並列** で進める。両者はカラム追加後に合流する必要があるため、**マイグレーションは先行実施** → Aチーム・Bチーム並列で実装 → 統合（Dチーム）→ Reviewer → Tech Lead 承認。

| チーム | 担当 | 成果物 |
| --- | --- | --- |
| **事前** (Tech Lead 直接 or Aチーム先行) | Supabase マイグレーション適用 | `receipts` テーブルにカラム追加 |
| **Aチーム** | バックエンド (`api/register.js`, `api/receipts.js`) | 送信記録書き込み + フィルタクエリ対応 |
| **Bチーム** | フロント (`src/pages/DashboardPage.tsx`) | 型・TABS・絞り込み・ボタン制御・バッジ |
| **Dチーム（統合）** | マージ後の通し動作確認 | ビルド通過 / ローカル手動スモーク |

依存:
- マイグレーションはA/B両チームの前提。**必ず先に本番DBへ適用**する（本プロジェクトはマイグレーションファイル運用していないため MCP `supabase__apply_migration` で直接適用、または Supabase ダッシュボードから手動実行）。
- AとBは互いに独立（APIのレスポンス形状に `freee_sent_at` が載ることだけが接点 → 設計書レベルで固定する）。
- Dチームは両方のマージ後、`npm run build` とローカル `api/dev-server.js` + `vite` でのスモーク確認。

---

## 3. マイグレーションSQL

Supabase プロジェクトに対して以下を適用する。

```sql
-- 2026-04-24: freee 送信記録カラム追加
ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS freee_sent_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS freee_deal_id TEXT NULL;

-- 送信済みフィルタ用インデックス（approved かつ freee_sent_at IS NULL の高頻度検索を想定）
CREATE INDEX IF NOT EXISTS idx_receipts_status_sent
  ON public.receipts (status, freee_sent_at);

COMMENT ON COLUMN public.receipts.freee_sent_at IS 'freee 取引登録が成功した日時。NULL の間は未送信。';
COMMENT ON COLUMN public.receipts.freee_deal_id IS 'freee API が返した deal.id。重複送信検知・トレーサビリティ用。';
```

注意:
- `TIMESTAMPTZ` で保存（既存 `created_at` と揃える想定）。API レスポンスでは ISO 8601 文字列として返る。
- `freee_deal_id` は freee API 側の ID 型がドキュメント上は数値だが、将来の型変更耐性のため TEXT で保持する。

---

## 4. 各ファイルの変更内容

### 4.1 Aチーム: `api/register.js`

**変更点**: freee 取引作成が成功した直後、`receipts` テーブルに送信記録を UPDATE する。

擬似コード（追記箇所のみ）:

```js
// 既存: const res = await freeeApiFetch('https://api.freee.co.jp/api/1/deals', {...});
if (res.ok) {
  const data = await res.json();
  const dealId = data.deal?.id ?? null;

  // ADD: Supabase に送信記録を保存（receipt_id があるときのみ）
  if (receipt_id) {
    try {
      const supabase = await getSupabase();
      const { error: updateError } = await supabase
        .from('receipts')
        .update({
          freee_sent_at: new Date().toISOString(),
          freee_deal_id: dealId ? String(dealId) : null,
        })
        .eq('id', receipt_id);
      if (updateError) {
        // 送信は成功しているのでフロントには success を返すが、ログに残す
        console.error('freee_sent_at update failed:', updateError.message);
      }
    } catch (e) {
      console.error('freee_sent_at update exception:', e.message);
    }
  }

  return response.status(200).json({
    success: true,
    deal_id: dealId,
    receipt_uploaded: !!freeeReceiptId,
  });
}
```

ポイント:
- **成功時のみ** UPDATE する（失敗時は freee に作られていないので未送信のまま）。
- UPDATE が失敗しても freee 登録自体は成功しているため、HTTP 200 は返す。ログだけ残す。
- `receipt_id` が無い呼び出し（旧式）には触らない（後方互換）。

### 4.2 Aチーム: `api/receipts.js`

**変更点**: GET でクエリパラメータ `sent=true|false` をサポート。SELECT の `*` にはもともと新カラムが含まれるので、カラム追加後は自動的にレスポンスに `freee_sent_at` / `freee_deal_id` が載る。

擬似コード（`handleGet` 抜粋）:

```js
const { status, sent, page: pageStr, limit: limitStr } = req.query || {};

// ... 既存クエリ構築 ...

if (status) {
  const statuses = Array.isArray(status) ? status : [status];
  query = query.in('status', statuses);
}

// ADD: sent フィルタ
if (sent === 'true') {
  query = query.not('freee_sent_at', 'is', null);
} else if (sent === 'false') {
  query = query.is('freee_sent_at', null);
}
```

補足:
- タブ件数集計 (`fetchTabCounts`) の都合でサーバー側で絞れるようにしておくのが筋。
- `select('*')` のままで OK（新カラムは自動で載る）。ただし `image_url` 生成後のオブジェクトスプレッドも `*` を保ってくれる。

### 4.3 Bチーム: `src/pages/DashboardPage.tsx`

**変更点**:

1. 型追加
```ts
interface Receipt {
  id: string;
  image_url: string;
  status: ReceiptStatus;
  result_json: ReceiptResult | null;
  error_message: string | null;
  section_id: string | null;
  created_at: string;
  freee_sent_at: string | null;   // ADD
  freee_deal_id: string | null;   // ADD
}
```

2. `TabKey` と `TABS` を拡張
```ts
type TabKey = 'all' | 'analyzing' | 'done' | 'approved' | 'sent' | 'error';

const TABS = [
  { key: 'all',       label: '全て',     statuses: null,         sent: null  },
  { key: 'analyzing', label: '解析中',   statuses: ['pending','processing'], sent: null  },
  { key: 'done',      label: '解析済み', statuses: ['done'],     sent: null  },
  { key: 'approved',  label: '承認済み', statuses: ['approved'], sent: false }, // ← 未送信のみ
  { key: 'sent',      label: '送信済み', statuses: ['approved'], sent: true  }, // ← 新規
  { key: 'error',     label: 'エラー',   statuses: ['error'],    sent: null  },
];
```

3. `statusQueryParam` を拡張してクエリに `sent=true|false` を付ける
```ts
const tab = TABS.find(t => t.key === activeTab);
const parts: string[] = [];
if (tab?.statuses) parts.push(...tab.statuses.map(s => `status=${s}`));
if (tab?.sent === true)  parts.push('sent=true');
if (tab?.sent === false) parts.push('sent=false');
return parts.join('&');
```

4. `tabCounts` を拡張
```ts
const [tabCounts, setTabCounts] = useState<Record<TabKey, number>>({
  all: 0, analyzing: 0, done: 0, approved: 0, sent: 0, error: 0,
});

// fetchTabCounts 内
const [analyzing, doneCnt, approvedUnsent, sent, errorCnt] = await Promise.all([
  countFor(['pending','processing']),
  countFor(['done']),
  countFor(['approved'], { sent: false }),
  countFor(['approved'], { sent: true  }),
  countFor(['error']),
]);
```
`countFor` を `(statuses, opts?: { sent?: boolean })` に拡張してクエリに `sent=` を付けられるようにする。

5. `sentIds` (useState) の扱い
   - 基本は **廃止**し、判定は `r.freee_sent_at != null` に置き換える。
   - それが最も真実に近く、他端末で送信済みになったレシートも自動反映される。
   - `sendToFreee` 内ロジックも `!r.freee_sent_at` でフィルタし、成功後は `fetchReceipts()` で DB から最新を取り直す（楽観的 UI 更新はしない。二重送信防止優先）。

```ts
const sendToFreee = async () => {
  const targets = receipts.filter(
    r => r.status === 'approved' && r.result_json && !r.freee_sent_at
  );
  if (targets.length === 0) { alert('送信可能な承認済みレシートがありません'); return; }
  setSending(true);
  let ok = 0, ng = 0; const failMsgs: string[] = [];
  for (const r of targets) {
    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...r.result_json, receipt_id: r.id, section_id: r.section_id }),
      });
      if (res.ok) ok++;
      else { ng++; const err = await res.json().catch(() => ({})); failMsgs.push(`${r.result_json?.store || '不明'}: ${err.error || '送信失敗'}`); }
    } catch { ng++; failMsgs.push(`${r.result_json?.store || '不明'}: 通信エラー`); }
  }
  setSending(false);
  alert(`freee送信完了: 成功 ${ok}件${ng ? `\n失敗 ${ng}件:\n${failMsgs.join('\n')}` : ''}`);
  await fetchReceipts();
  await fetchTabCounts();
};
```

6. 「送信済み」バッジ表示（テーブル行・カード行の両方）
   - 既存の `sentIds.has(r.id)` を `!!r.freee_sent_at` に置換（2 箇所、L430, L549 付近）。
   - 可能なら `title` 属性に `freee_sent_at` を ISO 表示、`freee_deal_id` があれば併記。

7. 「承認済みをfreeeに送信」ボタンの disabled 条件
```ts
disabled={sending || receipts.filter(r => r.status === 'approved' && !r.freee_sent_at).length === 0}
```
さらに「送信済み」タブ表示時はボタン自体を非表示 or disabled にする UX 配慮も可（最低限は条件式で OK）。

8. 「再判定」の confirm 文言（L283）はそのまま据え置きでよいが、`freee_sent_at` が埋まっているレシートを再判定対象に含めた場合の警告だけは残す（既存で OK）。

### 4.4 その他ファイル（変更なし想定）
- `api/process.js`, `api/upload.js`, `api/lib/freee-auth.js`: 変更不要。
- `src/pages/ConfirmPage.tsx`, `CompletePage.tsx`, `UploadPage.tsx`: 変更不要。
- `scripts/reset-receipts-to-pending.mjs`: Phase2 以降、必要なら「送信済みをリセット」オプション追加を検討。本PRスコープ外。

---

## 5. API コントラクト（フロント⇔バック固定仕様）

**GET `/api/receipts`** 追加クエリ:

| name | type | 効果 |
| --- | --- | --- |
| `sent` | `"true" \| "false"` | `"true"`: `freee_sent_at IS NOT NULL` / `"false"`: `freee_sent_at IS NULL` / 未指定: フィルタなし |

レスポンスの各 `data[i]` に以下を追加:
```json
{
  "freee_sent_at": "2026-04-24T12:34:56.000Z" | null,
  "freee_deal_id": "1234567" | null
}
```

**POST `/api/register`** レスポンス:
- 既存通り `{ success, deal_id, receipt_uploaded }`。フロント側の追加要件なし。
- 副作用として該当 `receipt` が DB 上で `freee_sent_at = now(), freee_deal_id = deal_id` に更新される。

---

## 6. DoD（Definition of Done）

- [ ] Supabase 本番DBに `freee_sent_at`, `freee_deal_id` カラムとインデックスが追加されている（`\d public.receipts` で確認）。
- [ ] `api/register.js`: freee 登録成功時に該当レシートの `freee_sent_at`/`freee_deal_id` が埋まる。
- [ ] `api/receipts.js`: `GET /api/receipts?status=approved&sent=false` で未送信の承認済みだけ、`sent=true` で送信済みだけが返る。
- [ ] `DashboardPage.tsx`:
  - [ ] 「送信済み」タブが表示される。
  - [ ] 承認済みタブからは送信済みのレシートが消え、送信済みタブに移っている。
  - [ ] 「承認済みをfreeeに送信」ボタンは未送信があるときだけ有効。
  - [ ] freee 送信後にリロードしなくても自動で送信済みタブへ移動する（`fetchReceipts()` 後）。
  - [ ] 送信済みバッジ（紫）がテーブル行・カード行で正しく表示される。
- [ ] `npm run build` が通る（TypeScript エラーなし）。
- [ ] ESLint / tsc 警告が本変更で新規に増えていない。
- [ ] 二重送信検証: 同じ receipt に対して 2 回「送信」を押しても 2 回目は送信対象から除外される（フロント）＋ サーバ側では既に `freee_sent_at` があっても freee 側に deal は作られる仕様のままなので、フロントでのガード + ボタン disabled で防ぐ（将来的にサーバ側でも早期 return するのは Phase 2）。

---

## 7. テスト観点

### マイグレーション
- 既存レコードの `freee_sent_at` / `freee_deal_id` は NULL で追加される。既存 `status='approved'` レコードは承認済みタブに残る（送信済み扱いにならない）。

### API
- `api/receipts.js`:
  - `?sent=true` 単独 → `freee_sent_at IS NOT NULL` のみ返す。
  - `?sent=false` 単独 → `freee_sent_at IS NULL` のみ返す。
  - `?status=approved&sent=true` 複合 → 承認済み かつ 送信済み。
  - `?sent` 未指定 → 従来通り全件（status フィルタのみ適用）。
- `api/register.js`:
  - 正常系: freee 成功 → Supabase SELECT で `freee_sent_at` が埋まっていること。`freee_deal_id` が deal.id と一致。
  - 異常系: freee deal 作成失敗 → `freee_sent_at` は NULL のまま。
  - 異常系: freee 成功 / Supabase UPDATE 失敗 → API レスポンスは 200（freeeは作成済み）。サーバログに警告。
  - receipt_id 未指定の呼び出しは UPDATE スキップ（NPEにならない）。

### フロント
- 承認済みタブ: 送信済みが消えている。件数バッジも正しい。
- 送信済みタブ: 送信済みのみ。件数バッジが approved と独立。
- 「全て」タブ: 送信済みも承認済みも全部含む（status フィルタなしなので従来通り）。
- 「承認済みをfreeeに送信」ボタン: 送信済みタブでは実質 disabled になる（未送信件数 0）。
- 送信成功直後、画面上で送信済みタブへ移動していること（`fetchReceipts` 再取得）。
- リロードしても送信済みタブの内容が保持されている（= DB 永続化の確認）。
- 異なるブラウザ/端末で同じアカウントを開いても送信済み状態が一致する。

### 回帰
- 既存の「再判定」「承認/承認解除」「編集保存」「画像プレビュー」「ページング」「自動リフレッシュ」が壊れていない。

---

## 8. 手順（おすすめ実行順）

1. **Tech Lead が本設計書を秘書へ通知** → 秘書が Engineer 起票。
2. **事前**: Supabase にマイグレーション SQL 適用（MCP `supabase__apply_migration` 推奨。名前例: `2026_04_24_add_freee_sent_columns`）。
3. **Aチーム** (Engineer via GLM) が `api/register.js`, `api/receipts.js` を実装。Reviewer レビュー → 修正ループ。
4. **Bチーム** (Engineer via GLM) が `src/pages/DashboardPage.tsx` を実装。Reviewer レビュー → 修正ループ。
5. **Dチーム** が両者マージ後にビルド & ローカルスモーク。
6. **Tech Lead** が `git diff` を確認し最終承認。
7. master push → Vercel deploy 確認 → 秘書経由でオーナー報告。

---

## 9. 注意点 / リスク

- **現状コード上の `sentIds` 依存箇所**: `DashboardPage.tsx` 内 L85, L302, L312, L322, L333, L430, L549, L738 の 8 箇所。Bチームは全置換を漏れなく行うこと（grep で `sentIds` 0件になることを確認）。
- **マイグレーションの順序**: フロント/バックをデプロイする前に必ずカラムが存在していること。カラムがないまま `register.js` の新コードが走ると UPDATE が 400 で落ちる（ただし try/catch で吸収するのでサービス影響は軽微）。
- **"送信済み" タブに approved ステータスが残る件**: ステータス値は `approved` のまま。オーナー仕様「承認済みタブから消して送信済みタブに移す」はタブの見せ方レベルで実現し、DB の `status` 列はいじらない（= 取消や再送信の運用余地を残す）。
- **サーバサイド重複送信ガード**: 本PRではスコープ外。将来 `api/register.js` 冒頭で「既に `freee_sent_at` が埋まっている receipt_id なら 409 で早期 return」するのが望ましい。Issue 化して Phase 2 で対応。
- **Engineer サブエージェントの Read 禁止制約**: GLM にプロンプトを渡す際は、対象ファイルを `cat` コマンドで stdin に取り込み / GLM 出力を `> file` リダイレクトで書き出す運用を徹底する（グローバル MEMORY のルール遵守）。
