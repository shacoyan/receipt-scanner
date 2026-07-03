# receipt-scanner OCR精度改善 Wave2 Stage2B 実装記録（2026-07-03・Tier L）

## 概要
Wave2 後半 **Stage2B = 金額・税区分の読み取り強化**。RECEIPT_PROMPT v3.12→**v3.13**（実装）→**v3.13b**（splits吸収是正・出荷版）。

## 実装した6提案（api/lib/prompt.js のみ・全て追記）
| id | 内容 |
|---|---|
| AMT-1 | 合計ブロック構造。『お預り』『お釣り』を amount に採用禁止、tendered_amount/change_amount/payment_amounts/tax_breakdown 新フィールドに分離抽出、合計＝お預り−お釣り検算 |
| AMT-3 | 手書き様式(第5様式)を confidence 強制 medium。改ざん防止斜線/欄外走り書き/桁付与禁止＋is_handwritten |
| AMT-5 | 請求書『前回御請求額/入金額/繰越額』採用禁止・『今回御請求額』最優先 |
| TAX-2 | モードB 5サブルール。税率ラベル直結・0円対象額不採用・行種別3分類(対象額/小計/税額)＋検算・お預り釣り流用禁止・対象額2行→splits必須 |
| TAX-6 | 非課税/対象外印字で tax_exempt_hint:true（ゲートはWave3・tax_code拡張なし） |
| ACCT-P3 | 品目根拠なし交際費を confidence medium 強制 |

新フィールド: tendered_amount/change_amount/payment_amounts/tax_breakdown/is_handwritten/tax_exempt_hint（全optional・逐語転記のみ・計算補完禁止・process.js未参照＝Wave3前提）。

## 検証（スコープ再OCR＋v3.12コントロールで変動切り分け）
検証セット291件（ターゲット140＋回帰151・splits重点81）を v3.13 再OCR → A/B。**v3.12(現行本番)を同一経路で58件コントロール再OCR**（splits重点フロア30含む）。

### 結果
- **ターゲット140件: 28完全修正＋26部分改善**。お預り金額の誤取り(1000→676)、0円対象の税区分誤り(LUPICIA)、金額誤読多数を修正。
- **splits重点フロア変動率=33%**（2Aの店名16%より高い＝splits/税区分は OCR run-to-run ばらつきが本質的に最大の領域。破綻の大半は store/date/amount 正・splits のみ揺れる）。
- **回帰候補28件のうち24件は変動**（v3.12でも壊れる＝Stage2B無関係）。notation(藤田商店 株式会社↔(株))・A-PRICE/業務スーパー/ライフ/ハナマサの tax/split・セブン/ダイソーの confidence・佐川→null・コーナン・ハナマサPLUS・イオン→ダイエー等は全て既存ばらつき。
- **真回帰4件**（v3.12コントロールで正）。うち3件が★系統的相互作用＝**新 tax_breakdown フィールドが splits を吸収**（2税率を tax_breakdown に書いて splits を null 化。process.js は splits で明細を作るため大額 receipt が単一税率登録される危険）。

### ★Stage2B の要修正発見と是正（v3.13→v3.13b）
tax_breakdown≥2率 but splits<2 を全291件で走査→5件、うち3件が真の分割取りこぼし。根本原因＝新フィールドが splits の「逃げ道」。**v3.13b で tax_breakdown 定義と TAX-2(d) の2箇所に「tax_breakdown は splits を代替しない・2税率実在なら両方独立に埋める」を明記**。recheck 20件（該当5＋splits重点15）で splits 復活を確認。残る不一致は¥3-5レジ袋レベルの**正解データ自体の不整合**（税理士側で分割する/しない・¥5品目の仕入高/消耗品費が非一貫）＝金額影響¥0.3-0.5で不可縮ノイズ。splits重点サンプル回帰4/15=27%も33%変動フロア内。

### 正味評価
28金額/税区分修正を取り込みつつ系統的 splits吸収を是正。真の残差回帰は無し（全て33%splits変動フロア内・正解データ不整合）。**net win**。

## ゲート／レビュー
- build（tsc+vite）PASS・v3.13b len 68712。
- Reviewer（Opus・Codexネイティブバイナリ欠落で不可）: **approved・must_fix 0**。3削除=出力例JSON行の無害置換のみ・既存ルール弱体化ゼロ、新6フィールドは freee登録経路から完全未参照（grep 0件・process.js L405-412 明示ホワイトリスト）、tax_code厳格クランプ、splits吸収是正は「2税率の対象額実在」で条件化され単一税率receiptを過剰分割しない、全失敗モードが安全側（¥0対象額はprocess.js amount>0フィルタ→length1 errorゲートで手動確認）。
- 監視点: AMT-1(d)/TAX-2(b)検算medium過検出（分割決済でお預り部分印字）・¥0混在receiptのsplits挙動・巨大明細のmax_tokens。いずれも安全側フェイル（誤登録でなく手動確認増）。nice_to_have=AMT-5合算に「本体・税双方明瞭時のみ」限定コメント（挙動不変）。

## ★方法論の学び（Stage2A に追加）
- **splits/税区分の検証は変動フロアが33%と高い**（店名16%の倍）。単一の A/B で「回帰」に見えても大半はノイズ。必ずコントロールで切り分ける。
- **新フィールド追加は既存フィールドを「吸収」しうる**。tax_breakdown が splits の生成義務を免除する逃げ道になった。新フィールドは既存の必須フィールドと独立である旨を明記必須。全件走査（tax_breakdown≥2 but splits<2）で系統性を定量化してから判断。
- **正解データ(freee)も微少額で不整合**。¥3-5レジ袋の分割有無・category は税理士側で非一貫→完全一致は原理的に不能。金額影響で足切りして「不可縮ノイズ」と「本物の誤り」を分ける。

## 残
- Wave3: 新フィールド依存ゲート（tax_breakdown vs splits 検算・tendered/change 検算・printed_weekday 曜日・tax_exempt_hint 非課税ゲート・log観測先行）。
- EX-4卸辞書はops依存（マスタ正本名確定=notation-P3後）。
