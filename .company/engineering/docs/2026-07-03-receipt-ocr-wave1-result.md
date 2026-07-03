# receipt-scanner OCR精度改善 Wave1 実装記録（2026-07-03・Tier L）

## 概要
freee（税理士修正済＝高信頼の正解）1〜4月 全経費取引 3,197件（うち画像添付 2,034枚）と、本番パイプライン再現ハーネスの OCR 結果を突き合わせ、不一致の根本原因を画像実査＋敵対検証で確定。うち **オフライン再評価でゼロコスト・破壊ゼロを機械実証できる6提案**を Wave1 として実装。

## 実装した6提案（api/process.js 5 + api/lib/freee.js 1）
| id | 種別 | 内容 |
|---|---|---|
| notation-P1 | 正規化 | セブンイレブン誤読変種5種を前方一致追加（ザ/デイセブン/アブアブ/アフィラ・セブン/アブーズ・イルワン）。ジャパン系/ダイソーイルフンは多義のため除外 |
| notation-P2 | 正規化辞書 | 個別店舗6エントリ（久兵衛/TACOYAcoco/カルディ/タイマーケット2種/だんぜんダイソー・全て replaceMode:'full'・freee実partner名に1:1） |
| notation-P5 | freee.js | findOrCreatePartner 近似重複ガード（スペース除去+株式会社前後除去の2操作等価・候補一意時のみ採用・全文ログ）。partnerマスタ汚染の自己増殖ループを予防 |
| AMT-4 | ゲート | 暦日実在性チェック。`new Date('2026-02-29')`=Invalid Date が範囲比較を NaN ですり抜ける穴を strict パースで塞ぐ |
| DATE-P2 | ゲート | 未来日ゲート。発行日JST > アップロード日(created_at)JST を error。厳密 > で same-day 正読は通過・created_at 欠損時は非発動 |
| S3-gate | ゲート | 自社/関連法人の宛名誤抽出（KITSUNE/KIJUNE/IOBT/ISEDAI/SABABA/ヤタ 等）を error。EXCLUDED（削除誘導）とは別文言＝経費レシート誤削除を防止。英字パターンは語境界化 |

## 検証（オフライン再評価・API/OCR不要・ゼロコスト）
`scratchpad/replay-wave1.mjs`＝本番 normalizeStoreName を live import＋新ゲートを predicate 再現し、freee正解2,034件へ適用:
- **all_match 1040 → 1053（+13）** — 13件の正規化 fix（全て truth 一致）
- **store 正解破壊 0**
- **新ゲート done→error 転換 19件**（future_date 12 / self_addressee 6 / calendar 1）＝全て現状 done-mismatch（誤自動登録）を人手確認へ
- **正解の error 誤爆 0（break=0）**

## ゲート／レビュー
- `npm run build`（tsc+vite）PASS
- Reviewer（Opus・Claude単独／Codexはネイティブバイナリ欠落で不可）: **approved・must_fix 0**。会計事故（誤値自動登録・別会社誤紐付け）を増やす変更なしと確認。全ゲートは fail-safe（done→error のみ）。
- nice_to_have で S3-gate 英字パターンを含有マッチ→語境界化（YATA/SABABA/ISEDAI）で将来の実レシート誤爆を予防（適用済・6件の検証済 flip は不変）。

## 位置づけ
- Wave2（prompt.js改善群・要スコープ再OCR）/ Wave3（新フィールド依存ゲート・log観測先行）は後続。
- ops（オーナー→税理士）: notation-P3 マスタ重複統合（カクヤス/ハナマサ/マツキヨ/ブルータス等・約206件の恒久改善の前提=notation-P4）／ TAX-5 計上規約。
- 設計正本: `2026-07-03-receipt-ocr-accuracy-batch-plan.md`。
