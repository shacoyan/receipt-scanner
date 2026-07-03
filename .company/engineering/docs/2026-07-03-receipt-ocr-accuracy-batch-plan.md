# receipt-scanner OCR精度改善 バッチ設計書（2026-07-03）

Tech Lead 設計。実装は engineer サブエージェント。Tech Lead はコードを書かない。

## 0. 概要（何を・なぜ）

freee に税理士が修正確定した 2026-01〜04 の全経費取引（正解＝ground-truth）と、本番パイプライン再現ハーネスの OCR 結果 2,034 件を突合し、不一致の根本原因を画像実査で確定・各改善を2レンズ（退行リスク／会計安全）で敵対検証した確定台帳（`scratchpad/ledger.json`）を実装計画に落とす。

- ベースライン（`dataset/summary.json`）: done=1,764 / all_match=**1,040** / mismatch=724 / error=270（うち値は正しいのに error=112）。
- 目的: (a) 店名正規化・辞書で partner 分裂と表記ミスマッチを潰す、(b) 決定論ゲートで「日付・自社宛名」の誤自動登録を人手確認へ振り分ける、(c) prompt 改善で発行者取り違え・税区分・金額誤読を上流で減らす。
- 大原則（constraint 2）: **ゲート追加は「締める方向」のみ。自動修正はしない**（誤りは error 化して人手確認へ）。緩和系は REJECTED 済みで含めない。新ゲートは log 観測 → FP 率確認 → error 化昇格の段階導入。

## 1. リスクティア宣言

**Tier L（データ系）。** 判定根拠:

- 変更対象が freee 会計へ直結する **金額 / 税区分(tax_code) / 勘定科目(account_item) / 取引先(partner)** の確定に影響する（リスクゲート「金額計算・認可」相当のデータ系）。誤りは税理士確定済み帳簿の汚染・二重計上・誤 partner 新規作成を生む。
- 一方 **DB / RLS / migration は無い**（receipt-scanner アプリ層のみ。Supabase は receipts テーブルの status/result_json 更新のみで、RLS ポリシー変更・スキーマ変更は伴わない）。
- ファイル数は全 Wave 合算で 4 以上（process.js / lib/freee.js / lib/prompt.js / register.js / api/receipts.js）。

→ **フルフロー（設計→Engineer→Reviewer→承認）＋本番ゲート＋Codex 必須**。特に freee 書込経路に触れる notation-P5（findOrCreatePartner）と、tax_code/splits を扱う Wave3 は Reviewer Claude ＋ Codex(gpt-5.5) 並列レビュー必須。

### 1.1 receipt-scanner における「本番ゲート」（全 Wave 共通・承認の必要条件）

1. **オフライン再評価で all_match ≥ 1,040 を割らない**（break=0、net ≥ 0）。ハーネスは `scratchpad/dataset/predictions.jsonl` の `raw_store`/`result_json` を改修後ロジックに通し、`ground-truth.jsonl` と再突合して fix/break を機械実測。**faithful-port 要件**: 改修前ロジックの移植は 1,764 done 行の shipped `predicted.store`/`status` を完全再現（意図した変更行以外は 0 差分）してからでないと計測を信用しない。
2. **`npm run build`（= `tsc && vite build`）通過**、api の Node 実行時エラーなし。既存 vitest があれば通過。
3. **Reviewer verdict = approved**（Tier L のため Claude ＋ Codex）。
4. **dual push**: `origin`(newWorld) ＋ subtree remote `receipt-scanner`(https://github.com/shacoyan/receipt-scanner.git) の両方（kintai と同じ subtree dual-push。force push は禁止）。
5. **Vercel 反映**: receipt-scanner は auto-deploy 有（本番 alias `receipt-scanner-rose.vercel.app`）。push 後デプロイ完了を確認。cron は cron-job.org 外部運用のため、次回 cron 実行が **新コード（Wave1=新ゲート/正規化、Wave2/3=新 prompt）を使用**していることを 1 レシートで確認（Wave2/3 は prompt バージョン文字列が v3.12 系に上がっていることを OCR ログで確認）。

## 2. 採用提案 最終リスト

判定は実データ measured_impact 準拠。過剰設計せず、net 負・退行ありは採らない。

### 2.1 CONFIRMED(39) の処遇

**コード変更あり → Wave 割当**

| id | type | 処遇 | 根拠(measured) |
|---|---|---|---|
| notation-P1 | normalization | **Wave1** | 変化 7 レコードのみ全て→セブンイレブン、7 件とも truth=セブンイレブン。現行 1,764 done 完全再現・退行0 |
| notation-P2 | dictionary | **Wave1** | 変化 7 件、うち 6 件 all_match 昇格・退行0。partner ID 6件実在確認済 |
| notation-P5 | normalization | **Wave1** | findOrCreatePartner 近似重複ガード。退行0・誤紐付け0、新規 partner 作成 148→146 |
| AMT-4 | gate | **Wave1** | 暦日 strict パースで非実在日(2026-02-29)の done すり抜け 1 件を error 化。誤爆0・all_match 破壊0 |
| DATE-P2 | gate | **Wave1** | 未来日ゲート。done→error 12 件（全件 checks.date=False）、all_match 誤検知0 |
| S3(gate 部) | gate | **Wave1** | 自社宛名パターン→error。done→error 5〜6 件（自社実体へ誤登録¥81k+防止）。all_match 破壊0 |
| S3(prompt 部) | prompt | **Wave2** | 宛名/御中 few-shot 3例＋自己検証手順。要スコープ再OCR |
| S4 | prompt | **Wave2** | コンビニ大手ブランド裏取り決定表＋ライフ縦書き＋AEON 支店行。真事故16件対象・回帰母集団313件で退行確認必須 |
| S6 | prompt | **Wave2** | 百貨店テナント名採用禁止。partner 安全な純増は 2 件のみ（大丸等は条件付き・退行注意） |
| EX-1 | prompt | **Wave2** | 配達/納品書 宛名・発行者分離。約28/34 正方向・宅配送り状 4 件の誤付替えに要注意 |
| EX-2 | prompt | **Wave2** | 運送伝票 荷送人優先。4 件 ERR→MATCH・新規誤登録 1 件(474113332)に注意 |
| EX-4 | dictionary | **Wave2** | 卸業者3エントリ。**EX-1/EX-2 実装後に抽出開始＋EX-5(ops) 名寄せで正本表記確定が前提** → EX クラスタと同 Wave |
| AMT-1 | prompt | **Wave2** | お預り/お釣り/決済行の分離抽出フィールド新設。amount 修正のみで all_match 化=4件。**新フィールドは Wave3 AMT-2 検算の前提** |
| AMT-3 | prompt | **Wave2** | 手書き強制 medium＋glyph 誤読ルール。≥10000 強制 medium で 3/7 件ゲート・正解喪失0 |
| AMT-5 | prompt | **Wave2** | 請求書 今回御請求額優先。amount 33 件（freee 側誤り是正方向） |
| DATE-P3(prompt 部) | prompt | **Wave2** | 曜日整合・複数箇所突合で confidence 降格。現実的 fix 2〜4 件 |
| DATE-P3(gate 部) | gate | **Wave3** | printed_weekday 出力→process.js 照合。**新フィールド前提** |
| DATE-P4 | prompt | **Wave2** | カクヤス様式 日付検証。純増 3 件 |
| TAX-2 | prompt | **Wave2** | v3.12 税区分サマリ強化。上限40件だが clean-flip 5件・過分割退行面 796件 → 慎重に回帰確認 |
| TAX-6(prompt 部) | prompt | **Wave2** | 非課税/対象外印字の検出。対象3件 |
| TAX-6(gate 部) | gate | **Wave3** | 非課税フラグ→人手確認ゲート。**新フラグフィールド前提** |
| ACCT-P3 | prompt | **Wave2** | 品目根拠なし交際費を confidence medium 強制→既存 non-high error 経路で人手化。対象27件 |
| notation-P4 | dictionary | **ops-first（保留）** | **notation-P3(ops マスタ統合) 完了が前提**。統合前適用は fixed156/broken107 の純トレード → P3 後に実施 |
| TAX-3 | gate | **Wave3** | 8%税額行→10%split 捏造検出。既存 splits で動くが desc矛盾FP7・逆比FP25 → **error 化は TAX-5(ops) 確定後**。FR-4 の printed_tax 証拠で精密化 |
| FR-1 | gate | **Wave3** | modeB_suspect 証拠ベース化。**tax_summary(新フィールド)前提**（現 predictions に0件）。現 modeB 過検知48/正検知7 |
| FR-4 | gate | **Wave3** | 税額算術コロボレーション基盤。**printed_tax(新フィールド)逐語転記が前提** |

**S5 の処遇（confirmed_with_changes）**: 第2段階の編集距離1補正は refute（実フロー発火9件で正4/誤5=44%、d1発火35件でも48.6%＝発動条件「>過半」未達）で **DROP**。第1段階の可視化（store_unverified バッジ＋partners 週次キャッシュ）は有効だが process.js＋freee.js＋UI(receipts.js) にまたがる新インフラのため **Wave1 からは切り離し、follow-up として保留**。partner 重複汚染への即効防波堤は notation-P5（近似重複ガード＋全文ログ）で Wave1 に確保する。

**ops_report_only（コード変更0・秘書→オーナー/税理士へ報告）**: S7 / EX-5 / AMT-6 / DATE-P6 / notation-P3 / TAX-5 / ACCT-P6 / FR-8。うち **notation-P3 と TAX-5 はコード Wave の前提**（P3=マスタ統合→notation-P4、TAX-5=テンプレ計上規約確定→TAX-3 error 化）なので優先的にオーナー/税理士へエスカレーション。

**no_change_data_issue（コード禁止・記録のみ）**: S8 / DATE-P5(評価除外37件) / notation-P6(不採用hint2件) / TAX-4(少額丸め・仕入高136固定・多数派丸め の棄却) / ACCT-P4(交通費→旅費交通費 棄却 net-107) / ACCT-P5(店舗一括科目 棄却)。**これらは「実装しない」ことが結論**。ハーネス/評価から除外・退行防止の証跡として保持。

### 2.2 NEEDS_REVIEW(5) 段階導入方針（1レンズ refute＝いずれも Wave1 非採用）

| id | 判定 | 方針 |
|---|---|---|
| S1 | refuted | **DROP**。truth=セブンイレブン9件は直すが rule(a) が新規3件を誤書換(ファミマ→セブン, same_receipt=True)。安全部分集合=notation-P1 に一本化 |
| FR-7 | refuted | **DROP（現形）**。error→done 解消0・store_exact 退行7件。マツキヨ スローガン除去も net 負 |
| EX-3 | refuted | **Wave2 の EX クラスタへ ops-gate 付きで統合**。実際に error を離脱するのは2件のみ＋新規誤自動登録を生む → allowlist 単独導入せず、EX-1/EX-2＋P5(ヤマト過検出)＋マスタ確定と束で再設計 |
| ACCT-P1 | refuted | **ops 前提で保留**。net+6 だが broken10 が新規会計事故（税理士が10%分を消耗品費で分割計上したものを単一仕入高に潰す）→ 酒類ベンダー科目規約を税理士確定後でないとコード化しない |
| FR-5 | refuted | **Wave3 送り**。tax_summary(新フィールド)前提で現状効果0・FP3。FR-1/FR-4 のフィールドが入ってから再評価 |

### 2.3 NO_VERDICT(52) オフライン裏取り結論

code 系 NO_VERDICT は **オフライン再評価すると既存 CONFIRMED の別定式化（重複）か、Wave2/3 依存か、refute 隣接**であり、**新規採用は0**（dedup で吸収）。主な帰着:

- N-1 → notation-P1（セブン「ザ・」前置）に吸収。N-2 ⊂ notation-P2（5→6件の部分集合）。N-3 ≡ notation-P5。**dedup**。
- date-4 ≡ AMT-4＋DATE-P2（暦妥当性＋未来日）。EO-1（未来日 +1年→処理日+7日）は DATE-P2（date>upload で厳密）に包含。date-3 ≡ DATE-P3(gate 部, Wave3)。**dedup**。
- EXC-1/EXC-2/EXC-5/EXC-4/EXC-3 ≡ EX-1/EX-2/EX-4/EX-cluster（Wave2）。P3(年下1桁二仮説)/P2(ドンキ強制medium解除)/P4(宛名レイアウト)/EO-2/EO-4/EO-5/EO-7/N-4 → Wave2 prompt 候補（既存 CONFIRMED prompt 群と重複領域・個別採否は Wave2 設計で確定）。
- N-5(ボトルワールドOK 空白統一)/P5(ヤマト過検出精密化) → **マスタ統合(notation-P3)/EX クラスタ依存で保留**（統合前の表記変更は既存一致を壊す純トレード＝constraint 3）。
- P7(ヒストグラム正規化前処理)/EO-3(missing_fields リトライ前処理) → **実験（精度ハーネス合格を導入条件）。別 Loop**。full 再OCR コスト高で Wave スコープ外。
- F-6(category_map 調整)/ACCT-3(酒類→仕入高 override) → ACCT-P4/P5/ACCT-P1 の棄却・保留と同根で **非採用/ops 保留**。

→ **NO_VERDICT からの新規 Wave1 採用は無し**。dedup 結論のみ（下記 §3）。

### 2.4 REJECTED(7) 不採用理由（各1行）

- **S2**（駐車場運営法人→ブランド辞書15件）: 実測退行あり・1:1裏取りが実フローで崩れ誤合流 → 不採用。
- **DATE-P1**（駐車場レンジ=入庫日）: truth=精算/出庫日の現一致を最低5件反転（パラカ/Times24）→ net 負。
- **TAX-1**（tax_code 189/187 経過措置＋免税辞書）: all_match +2 に対し break 6・model は 189 非出力 → net 微＋会計リスク。
- **ACCT-P2**（プリント代 雑費→消耗品費）: net −91（truth=雑費107 を消耗品費へ誤登録）→ 強い退行。
- **FR-2**（★/grid 強制medium を緩和）: **緩和系**（constraint 2 で除外）。
- **FR-3**（二仮説自動生成禁止）: 隣接候補内に正解が存在する4件を潰す・緩和隣接で net 不明 → 不採用。
- **FR-6**（店名confidence 採点範囲限定で high 解放）: 13件解放中 誤 auto登録9件 → net 負。

## 3. 重複統合の結論

| 統合前 | 統合後（採用） | 理由 |
|---|---|---|
| S1 / notation-P1 / N-1 | **notation-P1** | S1 rule(a) は新規3誤書換。安全な7レコード版（セブン変種吸収）に一本化 |
| N-2 / notation-P2 | **notation-P2** | notation-P2 が上位集合（+だんぜんダイソー）。partner ID 実在確認済の6件版 |
| N-3 / notation-P5 | **notation-P5** | findOrCreatePartner 近似重複ガードの同一提案 |
| AMT-2(G2 非実在日) / AMT-4 / date-4 | **AMT-4** | 暦日 strict パースで同一（470567460）。AMT-2 の残り2検算（お預り−お釣り＝合計/税内訳合計/決済合計）は新フィールド前提で Wave3 |
| DATE-P2 / EO-1 / date-4(未来日部) | **DATE-P2** | date>upload の厳密版が +7日ソフト版を包含 |
| EX-4 / EXC-5 / 卸辞書群 | **EX-4** | 卸業者 partner 分裂防止。EX-1/EX-2＋EX-5 名寄せと束（Wave2） |
| EX-3 / EXC-3 / P5(ヤマト) | **Wave2 EX クラスタで再設計** | 運送会社除外の精密化は carrier ルール＋マスタ確定と一体でないと誤自動登録を生む |
| notation-P3(ops) → notation-P4(code) | **順序厳守** | マスタ統合(ops)が先。統合前の P4 は純トレード（constraint 3） |
| ACCT-P1 / ACCT-3 | **ops 確定まで保留** | 酒類ベンダー科目は税理士規約確定が前提 |

## 4. Wave 分割

検証モード軸（constraint 1）で切る。**Wave1 = オフライン再評価（API/OCR 不要・ゼロコスト）で即検証できる低リスク確定改善**。Wave2/3 は再OCR 依存。

### Wave1 — オフライン再評価で即検証（normalization / dictionary / 決定論ゲート）

対象6提案。すべて `predictions.jsonl` の raw_store/result_json ＋ `ground-truth.jsonl` で fix/break を機械実測可能。error 化は「締める方向」のみで all_match を壊さない。

| id | ファイル | 変更概要 |
|---|---|---|
| notation-P1 | process.js `STORE_NORMALIZATION_RULES` L100-103 | セブンイレブン系 pattern に「ザ[・･\s]?」前置許容＋幻覚変種（デイセブン/アブアブ/アフィラ・セブン/アブーズ・イルワン）を追加。「ジャパンセブンイレブン」は多義で除外 |
| notation-P2 | process.js `STORE_NORMALIZATION_RULES` | 6エントリ追加（full モード・partner ID 実在確認済）: 久兵衛/TACOYAcoco/カルディ/タイマーケット2種/だんぜんダイソー→ダイソー |
| notation-P5 | lib/freee.js `findOrCreatePartner` L76-105 | 完全一致失敗時、新規作成前に検索候補へ限定等価比較（全半角スペース除去＋先頭/末尾「株式会社」除去のみ、編集距離マッチは禁止）。一意一致1件なら採用＋全文ログ「near-match採用: <pred>→<partner>」。それ以外は従来通り新規作成 |
| AMT-4 | process.js 日付範囲チェック直前（現行 L573） | YYYY-MM-DD を strict パースし非実在日（2026-02-29 等）を error 化。現行は Invalid Date→NaN 比較すり抜けで done 化する穴を塞ぐ |
| DATE-P2 | process.js pending select L245 ＋ 日付範囲チェック直後 L587 | select に created_at を追加。resultJson.date(JST) > receipt.created_at(JST) → status=error、error_message は全文（短縮禁止）。自動補正なし・手動確認送りのみ |
| S3(gate 部) | process.js 新ゲート | 正規化後 store が自社宛名パターン（KITUNE/KITSUNE/KIJUNE/IOBT/SABABA/YATA/SEDAI/ヤタ 等の誤読変種）に一致→error『宛名を店名として誤抽出の疑い・要手動確認』。既存 EXCLUDED_STORES（削除誘導メッセージ）とは**別メッセージ**にして経費レシートを誤って捨てない |

Wave1 の net 見積り（オフライン実測の合算・すべて break=0）: all_match **1,040 → 約1,052**（notation-P1/P2 で +最大13）。加えて done→error 転換 約18〜19 件（DATE-P2 12＋S3-gate 5-6＋AMT-4 1、いずれも現状 done-mismatch＝誤自動登録を人手確認へ）。**全て all_match バケット非接触**（会計事故を止めるだけで正解一致を1件も壊さない）。

**Wave1 に含めない理由の明記**:
- EX-4 → EX-1/EX-2 の抽出開始＋EX-5(ops) 名寄せが前提のため Wave2。
- TAX-3/FR-1/FR-4/AMT-2 残検算 → 新フィールド or ops(TAX-5) 前提のため Wave3。
- S5-stage1 → 新インフラ（partners 週次キャッシュ＋UI バッジ）で切り離し。

### Wave2 — prompt.js 改善群（要スコープ再OCR）

対象（CONFIRMED prompt 群）: S3(prompt), S4, S6, EX-1, EX-2, **EX-4(dict・EX 束)**, AMT-1, AMT-3, AMT-5, DATE-P3(prompt), DATE-P4, TAX-2, TAX-6(prompt), ACCT-P3。EX-3 と P5(ヤマト) は EX クラスタで ops-gate 付き再設計。

RECEIPT_PROMPT v3.11 → **v3.12**。**再OCR は full 2,034 ではなく「各提案が対象とするレシート＋回帰サンプル」にスコープ限定**（constraint 1）。本番 API 使用禁止 → Claude Code の Sonnet サブエージェントで対象レシート＋退行監視サンプルを再OCR し before/after 比較。AMT-1 が新設する お預り/お釣り/決済 フィールド、DATE-P3 の printed_weekday、TAX-6 の非課税フラグは Wave3 ゲートの前提出力になるため、**Wave2 でフィールドを出す→Wave3 でそれを読むゲートを足す**依存を厳守。Wave2 は本設計では方針提示に留め、着手時に Wave2 専用設計書で提案別の再OCR スコープ・回帰母集団（S4 コンビニ313件、TAX-2 過分割退行面796件 等）を確定する。

### Wave3 — 新フィールド依存ゲート（Wave2 のフィールドが前提）

対象: AMT-2(残2検算＝お預り−お釣り＝合計/税内訳合計/決済合計), DATE-P3(gate=printed_weekday 照合), TAX-3(8%→10%split 捏造・**error 化は TAX-5 ops 確定後**), TAX-6(gate=非課税→人手確認), FR-1(modeB_suspect 証拠ベース化・tax_summary 前提), FR-4(printed_tax コロボレーション基盤)。

全ゲート **log 観測モードで導入 → FP 率確認 → error 化昇格**（constraint 2）。FR-4 の printed_tax 逐語転記が TAX-3/FR-1 の証拠基盤になるため FR-4 を先行実装。

## 5. ファイル所有権と並列可否

**process.js は競合するので同一 Wave 内で 1 エンジニアに集約。**

### Wave1（並列度2）

- **Engineer A — `api/process.js`（全変更を集約）**: notation-P1 / notation-P2 / AMT-4 / DATE-P2 / S3-gate。5変更だが編集領域は独立（正規化配列 L100-154／日付ゲートブロック L573-587 周辺／pending select L245／新ゲートブロック）。1 エンジニアが1回のオフラインハーネス run でまとめて検証。
- **Engineer B — `api/lib/freee.js`（findOrCreatePartner のみ）**: notation-P5。

並列可否: A と B は別ファイル → **並列安全**。論理順序（normalizeStoreName→findOrCreatePartner）はランタイムのみで、コード編集の競合なし。オフラインハーネスは両変更を直列適用して突合。**统合注意**: notation-P5 の等価比較は「株式会社」除去のみ（編集距離禁止）。normalizeStoreName が返す正規形（例「カクヤス」「ドン・キホーテ」）と freee 実在 partner 名の差（「株式会社カクヤス」等）を吸収する設計意図なので、A の正規化変更が B の等価比較対象を変えないことをハーネスで確認（変化2件が両方 same-company であることを再現）。

### Wave2（並列度は着手時に確定）

lib/prompt.js は単一ファイル → prompt 変更は 1 エンジニアに集約（複数提案を1つの v3.12 diff にまとめる）。process.js 側の付随ゲート（S3-gate は Wave1 で済・ACCT-P3 の error 経路は既存 non-high gate 流用で process.js 変更最小）と EX-4 の辞書追加（process.js）は prompt 実装後に別エンジニアが追記（同 Wave 内で process.js を触るのは 1 名に限定）。

### Wave3（並列度は着手時に確定）

新ゲートは process.js の splits/gate 群に集中 → **1 エンジニアに集約**。FR-4→(TAX-3, FR-1) の証拠依存があるため Phase 1(FR-4)→Phase 2(TAX-3/FR-1) の順。

## 6. 検証方法

### Wave1（オフライン・ゼロコスト）

`scratchpad/` にハーネススクリプト（**プロダクトコード外**）を作成:
1. 改修後の `normalizeStoreName` / `STORE_NORMALIZATION_RULES` / `findOrCreatePartner`（近似ガード）/ 各ゲートを移植。
2. faithful-port ゲート: 改修前ロジックで 1,764 done 行の `predicted.store`/`status` を 0 差分再現。
3. `predictions.jsonl`(raw_store, result_json) を改修後に通し、`ground-truth.jsonl`(deals=正解, receipt_created_at=アップロード日) と再突合。
4. 出力: fixed / broken / net、done→error 転換件数、all_match 新旧、S3/DATE-P2 のパターン別ヒット一覧（全文・短縮禁止）。
5. **合格条件**: break=0、all_match ≥ 1,040、S3-gate/DATE-P2/AMT-4 の error 化が全て「現状 done-mismatch（誤登録）」であることを ID 単位で確認。

### Wave2/3（スコープ再OCR）

本番 freee/OCR API 禁止。Claude Code の Sonnet サブエージェントで **対象レシート＋回帰監視サンプル**を再OCR し before/after 比較。Wave3 ゲートは log 観測モードで導入し、再OCR 結果に対する FP を実測してから error 化を判断。

## 7. 受け入れチェックリスト（Reviewer 1巡収束のため必須）

- [ ] **金額の型・丸め**: amount は整数（円・小数なし）。splits 使用時は `Σsplit.amount === amount`（既存 `validateSplitsFromDb` 不変条件）を壊さない。
- [ ] **税区分の値域**: tax_code は model 出力の {136, 163} のみ（Wave1 は tax_code に触れない。Wave3 で 2/37/189/187 を勝手に生成しない＝棄却済 TAX-1/TAX-6 の値域）。税率比バンドは [0.075, 0.085]=8%相当 の既存規約に合わせる。
- [ ] **勘定科目**: Wave1/2/3 とも `CATEGORY_MAP`（6科目・交通費/通信費は暫定=雑費ID 929160680）を変更しない（ACCT-P4/P5 棄却済）。
- [ ] **ゲートは締める方向のみ**: 新ゲートは done→error（人手確認）のみ。自動補正・自動値書換え・自動 partner 作成の緩和をしない。error_message は**全文表示**（substring/length カット禁止・MEMORY 規律）。
- [ ] **mutate の正確性（RLS 4操作は N/A）**: この改修に DB スキーマ/RLS 変更なし。receipts の `.update({status, result_json, error_message})` は必ず `.eq('id', receipt.id)` で対象行を限定（既存パターン踏襲）。0行更新の無音 success は本経路では発生しない（id 指定・単一行）。
- [ ] **partner 誤合流ゼロ**: notation 正規化先は freee 実登録名と 1:1 裏取り済みのみ。別チェーンの誤合流（NTT東↔西、スギ↔スド、ダイエー↔ダイソー 等の編集距離1ペア）を作らない。notation-P5 は編集距離マッチ禁止・「株式会社」/スペース除去のみ。
- [ ] **スコープ境界**: Wave1 は process.js ＋ lib/freee.js のみ。prompt.js・register.js の書込セマンティクス・CATEGORY_MAP・EXCLUDED_STORES 本体・vercel.json を変更しない。EXCLUDED_STORES と S3-gate はメッセージを分離（削除誘導 vs 手動確認）。
- [ ] **faithful-port**: オフラインハーネスの改修前移植が 1,764 done 行を 0 差分再現してから fix/break を計測。
- [ ] **本番ゲート**: all_match ≥ 1,040（break=0）／`npm run build` 通過／Reviewer(Claude＋Codex) approved／dual push／Vercel 反映＋cron 新コード使用確認。

## 8. ロールバック

- Wave1/2/3 は各 Wave 単位で 1 commit（または提案単位の小 commit 群）にまとめ、**revert 可能な粒度**を保つ。
- prompt.js は v3.11→v3.12 のバージョン文字列を明示。退行が本番で判明したら該当 Wave の commit を revert → dual push → 再デプロイで即座に旧挙動へ戻す（DB マイグレーションが無いためデータ不可逆性なし＝ロールバックは純コード revert）。
- 万一 S3-gate/DATE-P2 が本番で正当レシートを過剰 error 化した場合、error 化は register を止めるだけで会計事故を起こさない（人手で status を戻せる）。閾値/パターンの緊急調整も revert で対応。

## 9. commit / push / deploy 手順

1. ブランチ: master 直コミット可（既存運用踏襲）だが、Wave 単位で論理的に分離した commit を作る。commit message 末尾に `Co-Authored-By: Claude <noreply@anthropic.com>`。
2. **dual push**: `git push origin master` ＋ subtree push（remote `receipt-scanner`）。force push 禁止。
3. **deploy 確認**: receipt-scanner は auto-deploy 有 → push 後 Vercel ダッシュボード/alias `receipt-scanner-rose.vercel.app` でデプロイ完了確認。必要なら `vercel --prod` 手動。
4. **cron 反映確認**: cron-job.org の次回実行後、1 レシートの処理ログで新ゲート/新正規化（Wave1）または prompt v3.12（Wave2/3）が効いていることを確認。
5. 完了後、秘書に ops 報告（notation-P3 マスタ統合／TAX-5 テンプレ規約／ACCT-P1 酒類科目 等のオーナー・税理士エスカレーション項目）を引き継ぐ。

## 10. 読み済みファイル / 担当行範囲 / 統合注意

**読み済み（重複 Read 回避）**:
- `api/process.js`（644行）: STORE_NORMALIZATION_RULES L98-154 / normalizeStoreName L198-222 / gate 群 L400-628（EXCLUDED_STORES L410-420, missing_fields L435, confidence L442-453, high-but-doubting L456-479, splits 整合 L481-571, modeB L555-570, 日付範囲 L573-587, amount_cap L589-609, catch L628）/ pending select L245。
- `api/lib/freee.js`（225行）: CATEGORY_MAP L10-20 / SECTION_MAP L22-32 / validateSplitsFromDb L42-55 / findOrCreatePartner L76-105。
- `api/lib/prompt.js`（1,087行）: RECEIPT_PROMPT_V35（v3.10 記載・実質 v3.11 運用）、宛名除外ルール L194 付近。
- `api/register.js`（267行）: 未詳細（Wave1 非対象）。
- 台帳 `scratchpad/ledger.json` / データセット `scratchpad/dataset/`（summary/predictions/ground-truth/partners/mismatches/errors）。

**各 Engineer 担当行範囲（Wave1）**:
- Engineer A（process.js）: 正規化配列 L100-154（notation-P1/P2, EX-4 は Wave2）／日付ゲート L573-587＋直前（AMT-4）／pending select L245＋日付ゲート直後（DATE-P2）／新ゲートブロック（S3-gate、EXCLUDED_STORES L410 近傍とは別メッセージ）。
- Engineer B（lib/freee.js）: findOrCreatePartner L76-105（notation-P5、新規作成 POST 直前に等価比較を挿入）。

**統合注意**:
- process.js の 5 変更は同一ファイル → **必ず Engineer A 1 名**（並列不可）。オフラインハーネスは A/B 両変更を直列適用。
- notation-P5（B）の等価比較対象は A の正規化後 store。A の正規化変更で「株式会社」除去マッチ対象が変わらないことをハーネスで確認（変化2件=ツルハ/川西厨房が両方 same-company を再現）。
- S3-gate の自社宛名パターンは EXCLUDED_STORES（KITUNE/金魚/LR/moumou 等）と一部重なるが、**メッセージと意味が異なる**（EXCLUDED=削除誘導／S3=経費として手動確認）。既存 EXCLUDED_STORES を変更せず、S3-gate を別分岐で追加。
- DATE-P2 の select L245 変更は「id, storage_path, mime_type」に created_at を足すだけ（P1-5 の帯域最適化コメントを尊重し最小追加）。
