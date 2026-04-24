export const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 300,
};

/**
 * チェーン名の表記ゆらぎ正規化ルール
 * - pattern: RegExp（チェーン名部分にマッチ）
 * - normalized: 正規形（このチェーン名で上書き）
 * - 支店名（マッチ部分より後ろの文字列）は保持する
 *
 * 例: "アブゾーイレブン西心斎橋店" → pattern が前方マッチ → "セブンイレブン"
 */
const STORE_NORMALIZATION_RULES = [
  // セブンイレブン系（OCR 誤読・ハイフン揺れ U+2010/U+2012/U+2013/U+2014/U+2015/U+2212/全角ダッシュ 吸収）
  {
    pattern: /^(セブン[‐ー\-–—−]?イレブン|7[-\s]?Eleven|SEVEN[-\s]?ELEVEN|アブゾー?イレブン|アクセブン[ー\-]?イレブン)/i,
    normalized: 'セブンイレブン',
  },
  // ファミリーマート系
  {
    pattern: /^(ファミリーマート|ファミマ|FamilyMart|Family\s*Mart)/i,
    normalized: 'ファミリーマート',
  },
  // ローソン系
  {
    pattern: /^(ローソン(?!銀行)|LAWSON)/i,
    normalized: 'ローソン',
  },
  // リカーマウンテン系
  {
    pattern: /^(リカーマウンテン|Liquor\s*Mountain|LIQUOR\s*MOUNTAIN)/i,
    normalized: 'リカーマウンテン',
  },
  // ダイソー系
  {
    pattern: /^(ダイソー|DAISO|Daiso|THE\s*DAISO)/i,
    normalized: 'ダイソー',
  },
  // アークランズ系（アークランド表記揺れを統一）
  {
    pattern: /^(アークランズ|アークランド)/,
    normalized: 'アークランズ',
  },
  // 業務スーパー系
  {
    pattern: /^(業務スーパー|業務用スーパー)/,
    normalized: '業務スーパー',
  },
  // 久世福商店系（チェーン名自体に「商店」を含むため、normalized 返却で商店保護が担保される）
  {
    pattern: /^(久世福商店)/,
    normalized: '久世福商店',
  },
];

/**
 * 末尾「〜店」を除去する。ただし「商店」は保護する。
 * - 空文字 / 1文字以下は原値返し
 * - 末尾が「店」でなければそのまま
 * - 末尾が「商店」なら保護（原値返し）
 * - それ以外は末尾「店」1文字のみ除去し trim
 */
function stripBranchSuffix(input) {
  if (!input || typeof input !== 'string') return input;
  let s = input.trim();
  if (s.length <= 1) return s;
  if (!s.endsWith('店')) return s;
  if (/商店$/.test(s)) return s;
  if (/支店$/.test(s)) return s;
  if (/本店$/.test(s)) return s;

  // 空白区切り時: 最後のトークンが「店」で終わるなら丸ごと破棄
  if (/[\s\u3000]/.test(s)) {
    const parts = s.split(/[\s\u3000]+/);
    const last = parts[parts.length - 1];
    if (last.endsWith('店') && !/商店$/.test(last) && !/支店$/.test(last) && !/本店$/.test(last)) {
      parts.pop();
      return parts.join(' ').replace(/[・\-\s\u3000]+$/, '').trim();
    }
    return s;
  }

  // 空白なし: 末尾「漢字/カナ連鎖 2-8文字 + 店」を可変長除去
  const heuristicRe = /[一-龯々〇ヶ]{2,8}店$/u;
  if (heuristicRe.test(s)) {
    return s.replace(heuristicRe, '').replace(/[・\-\s\u3000]+$/, '').trim();
  }
  // フォールバック: 末尾「店」1文字のみ除去
  return s.replace(/(?<!商)店$/, '').replace(/[・\-\s\u3000]+$/, '').trim();
}

/**
 * 店名を正規化する
 * - チェーン名部分をマップに従って統一
 * - ルールマッチ時: suffix が「店」で終わり、かつ「商店」でなければ suffix 全体を破棄し normalized のみ返す
 * - ルール非マッチ時: stripBranchSuffix で末尾「店」1文字のみ除去（商店保護）
 */
function normalizeStoreName(rawStore) {
  if (!rawStore || typeof rawStore !== 'string') return rawStore;
  const trimmed = rawStore.trim();
  for (const rule of STORE_NORMALIZATION_RULES) {
    const m = trimmed.match(rule.pattern);
    if (m) {
      const matched = m[0];
      const rawSuffix = trimmed.slice(matched.length);
      const suffix = rawSuffix.trimStart();
      const hasSep = rawSuffix.length !== suffix.length;
      // suffix 自体が末尾「店」で終わり、かつ「商店」「支店」でなければ suffix 全体を破棄
      if (suffix && /店$/.test(suffix) && !/商店$/.test(suffix) && !/支店$/.test(suffix)) {
        return rule.normalized;
      }
      return suffix ? `${rule.normalized}${hasSep ? ' ' : ''}${suffix}` : rule.normalized;
    }
  }
  return stripBranchSuffix(trimmed);
}

export { STORE_NORMALIZATION_RULES, normalizeStoreName };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth check: CRON_SECRET only
  const authHeader = req.headers['authorization'];
  const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (!isCron) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Fetch up to 10 pending receipts (oldest first)
    const { data: pendingReceipts, error: fetchError } = await supabase
      .from('receipts')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(10);

    if (fetchError) {
      throw new Error(`Fetch pending error: ${fetchError.message}`);
    }

    if (!pendingReceipts || pendingReceipts.length === 0) {
      return res.status(200).json({ processed: 0, errors: 0 });
    }

    const ids = pendingReceipts.map((r) => r.id);

    // Mark as processing
    const { error: updateError } = await supabase
      .from('receipts')
      .update({ status: 'processing' })
      .in('id', ids);

    if (updateError) {
      throw new Error(`Update to processing error: ${updateError.message}`);
    }

    const prompt = `あなたはレシート・領収書の読み取りAIです。以下のルールに厳密に従ってください。

## 【最重要・絶対遵守】店名のハルシネーション禁止
- \`store\` フィールドには、**画像に明示的に印字・印刷されている文字列のみ** を出力すること。推測・連想・補完は絶対禁止。
- ロゴや社名の文字が判読できない／ぼやけている／欠けている／部分的にしか読めない場合は、**迷わず \`store\` を null にする**。
- 業態テーブル（後述）は **category 判定の補助** であり、**store の補完に使ってはならない**。支店名・地名の断片しか読めない場合、プロンプト内で言及された任意のチェーン名で補完することは禁止。その場合は \`store\` を null にする。「○○店」「△△支店」のような支店名だけが判読でき、親ブランド名が画像上で確認できないケースも同様に null。
- 類似の社名に寄せる補正も禁止。例: 「アークランズ」が読み取れない場合に「ダークラウン」「アークスイズミ」等の近似文字列を出力しない。読み取れなければ null。
- 画像内の「知っているチェーン名」に引きずられない。判読できた文字列のみを忠実に書き写す。

## 入力の種類
入力画像は次のいずれかです。どちらであっても同じJSON形式で出力します。
1. レシートテープ形式（品目明細が並ぶタイプ）
2. 正式領収書形式（宛名・発行日・但し書き・合計金額・発行者印のみで、品目明細なし）
3. 二重構造形式（1枚の画像内に領収書と明細テープが同時に写っているタイプ。上半分が鏡像反転している場合あり）

## 二重構造・鏡像反転レシートの扱い
- 1枚の画像内にレシートが2回写っている（例: 上半分が鏡像反転で領収書、下半分が通常向きの明細テープ）場合、**判読しやすい方を優先** する。
- 両方から内容が読み取れて矛盾がある場合は、品目・日付・金額は **明細テープ側（通常向き・下半分）を信頼**、店名・宛名は領収書側（発行者欄）を参照して良い。ただし前項「店名ハルシネーション禁止」は絶対に優先。
- 鏡像反転部分を無理に読もうとして文字を誤読するくらいなら、その箇所は読み取りを諦めて該当フィールドを null にする。

## 読み取りルール
- date: 発行日を YYYY-MM-DD 形式（西暦）で出力。
  - 「2026/02/12」「2026-02-12」「2026年2月12日」「令和8年2月12日」「R8.2.12」いずれも 2026-02-12 に正規化。
  - 元号は令和=2019年を1年として西暦換算（令和N年 = 2018+N年）。
  - 領収書の右上の発行日・日付印を最優先。レジ印字日時がある場合はその日付を採用。
  - 存在しない日付（2月30日等）や、年が読み取れない場合は null。
- amount: 合計金額を数値のみで出力（カンマ・円記号・ハイフン記号は全て除去）。
  - 「税込合計」「合計」「ご請求金額」「お会計」を最優先。小計・税額・釣銭・預かり金は採用しない。
  - 「¥7,875-」のように末尾のハイフン記号は金額の一部ではない。正しくは 7875。
  - 複数の合計候補があり区別できない場合は null。
- store: 発行者（店舗・会社名）。支店名まで含める。**前述のハルシネーション禁止ルールを最優先**。
  - 正式領収書で宛名が書かれている場合（「○○ 様」「御中」）、**宛名は絶対に store に入れない**。発行者欄（社印・店舗名）を採用。
  - 宛名の典型例: 「Goodbye 様」「株式会社〇〇 御中」「上様」——これらは store ではない。
  - 発行者は、レシート下部・右下・領収書の社判欄・店舗ロゴ周辺に印字されていることが多い。社名・屋号・店舗名・支店名の順で連なる形式が典型（例: 「〇〇株式会社 △△店」）。具体チェーン名は本プロンプトには意図的に載せていない。画像に印字された文字だけを忠実に書き起こすこと。
  - 確実に読み取れなければ null。補完・類推・近似・連想は禁止。
- category: 下記「勘定科目」のいずれか1つを必ず選ぶ。原則として null にしない（※例外は「除外店舗」および store が null の場合のみ）。

## 勘定科目（この7種類から1つだけ選択）
消耗品費・交通費・接待交際費・会議費・通信費・雑費・仕入高

## 業態→勘定科目の判定テーブル（category 判定補助。store 補完には使わない）
store から業態が判別できる場合、品目明細を見る前にこの表に従ってください。

| 業態 | 特徴（画像上で判別可能なキーワード／レシート様式） | category |
|---|---|---|
| コンビニ | 24時間営業表記・ポイントカード案内・店名に「セブン」「ファミマ」「ローソン」等の一般的コンビニ表記があるもの。レシート幅が細く、品目が短い略称で並ぶ。 | 仕入高 |
| 総合スーパー・食品スーパー | 鮮魚・精肉・青果など生鮮品目が混在。割引シール「〇〇% OFF」「半額」。チェーン名に「マート」「ストア」「スーパー」が含まれがち。 | 仕入高 |
| 酒類専門 | 店名・看板・レシート上部に「酒」「リカー」「LIQUOR」「酒販」「酒類」のいずれかを含む。品目が日本酒・焼酎・ワイン・ビールに偏る。 | 仕入高 |
| 食品専門店 | 肉・魚・野菜・乾物・製菓材料など単一カテゴリの食材を主に扱う。店名に「精肉」「鮮魚」「青果」「八百屋」「製菓」「食品」等を含むか、品目が明確に食材に限定。 | 仕入高 |
| 飲食店（イートイン） | 「お通し」「席料」「サービス料」「ドリンク」「料理」「お会計」「人数」等の記載。品目が料理名・ドリンク名。 | 接待交際費 または 会議費 |
| カフェ | 「コーヒー」「ラテ」「エスプレッソ」「カフェ」の品目比率が高い。小規模で客単価が低め。 | 会議費 |
| 100円ショップ | 「100円」「税込110円」等の均一価格表記。雑貨品目。 | 消耗品費 |
| 家電量販店 | 家電・AV機器・PC 関連の品目。ポイント還元表記。 | 消耗品費 |
| ドラッグストア | 医薬品・化粧品・日用品の混在。「第〇類医薬品」表記。 | 消耗品費 |
| ホームセンター | DIY・資材・園芸・工具等の品目。大判レシート。 | 消耗品費 |
| 文具・事務用品 | 文房具・OA用品が中心。 | 消耗品費 |
| 交通系 | 「タクシー」「乗車」「発駅」「着駅」「〇〇線」「ガソリン」「給油」「駐車場」「パーキング」。 | 交通費 |
| 通信 | 「通信料」「回線」「モバイル」「送料」「宅急便」「ゆうパック」。 | 通信費 |

※ このテーブルは category 判定のみに使用。店名の補完には使わない。
※ 画像の店名文字列が上記キーワードにマッチしなくても、品目・様式から業態が明らかな場合は本テーブルに従うこと。

## 判定の優先順位（重要）
1. 店名（発行者）から**業態が特定できる場合は、上記テーブルを最優先**。品目明細の見た目（「トイレットペーパー」等が混ざっていても）に引きずられない。
2. コンビニ / スーパー / 酒屋 / 食品専門店 は **原則「仕入高」**。この事業は飲食店舗を運営しており、これらの業態での買い物は食品・飲料の仕入れが圧倒的多数。
3. 飲食店での「席に着いての飲食」は、1人あたり金額や人数の目安で 接待交際費 / 会議費 を判断。判断がつかない場合は 会議費。
4. 店名が不明瞭で業態不明、かつ品目も読み取れない場合にのみ 雑費。
5. 迷ったら「category は仕入高」を優先（ただし明確に飲食店・カフェ・交通・通信・100円ショップ・家電量販・ドラッグストアと分かるものは除く）。
6. **ただし store（店名）は絶対に補完しない**。迷っても \`store\` は null、または確実に読み取れた断片のみを出力する。category の優先ルールを store に適用してはならない。

## 正式領収書（品目明細なし）の扱い
正式領収書では品目が書かれていないため、**store（発行者）から category を推定するのが必須**。
例:
- 発行者が酒類専門店（看板や店名に「酒」「リカー」等を含む）で、宛名が「〇〇 様」、金額と日付が読める場合
  → {"date": "YYYY-MM-DD", "amount": 数値, "store": "画像に印字された店名そのまま", "category": "仕入高"}
- 発行者がタクシー会社（店名に「タクシー」を含む）
  → category は 交通費
- 発行者欄が判読困難で、宛名と金額のみ読める
  → {"date": "...", "amount": ..., "store": null, "category": null}（store 不明のため category も null）

※ 品目明細がなくても、画像内に「10%対象 ¥◯◯」「8%対象 ¥◯◯」等の税区分別サマリが印字されている場合は、後述「明細分割ルール」の**モードB（税区分サマリ分割）**に従って splits を構築してよい。品目明細なし＝必ず単一モード、ではない。

## 自信度の判断（date / amount / store のみ）
以下に該当する場合、**該当フィールドのみ** null にしてください（category は上記ルールで必ず埋める。ただし store が null の場合は category も null）：
- 文字がかすれ・にじみ・汚れで判読困難
- 一部が折れ・隠れ・切れていて見えない
- 複数の金額があり合計が特定できない
- 日付のフォーマットが不明瞭で年が確定できない
- 店名が部分的にしか読めず、既知チェーン名での補完が必要になる
- ロゴが潰れていて社名が確定できない

※ store が null の場合、category も null にする（業態判定の手がかりが無いため）。

## 除外店舗（自社・関連店舗）
自社・関連店舗の除外はコード側で事後フィルタする。本プロンプトでは具体名を列挙しない。
LLM は画像に印字された店名を忠実に書き起こすのみで良い。

## 明細分割ルール（重要・v3）
レシートには複数の商品カテゴリ・税区分が混在することがあります。以下の3モードを**この順で判定**して出力してください。

### モード判定（優先順位）
1. **モードA: 品目明細分割** — レシートテープに品目明細が列挙されている場合。各品目を画像に印字された情報のみに基づいて分類する。
2. **モードB: 税区分サマリ分割** — 品目明細がない（または読めない）が、画像内に「10%対象 ¥◯◯」と「8%対象 ¥◯◯（または軽減8%対象・軽減税率対象）」の **両方が本体額として併記** されている場合に限り発動する。片方しか印字されていない場合・税額や消費税の印字を本体額と見間違えている疑いがある場合は **必ずモードC にフォールバック** する（判定条件の詳細は後述「モードB: 税区分サマリ分割のルール」参照）。
3. **モードC: 単一モード** — 上記 A/B のいずれにも該当しない場合（品目明細なし＋税区分サマリもなし、または全品目が同一勘定科目かつ同一税区分）。

### 税区分（tax_code）
- 軽減8%(137): **飲食料品**（酒類・外食を除く）、新聞定期購読。「食品・飲料（テイクアウト/持ち帰り含む）」と読み替えて良い。
- 標準10%(136): 上記以外すべて（日用品・雑貨・酒類・外食・交通・通信 等）。

### 【絶対禁止】ハルシネーション（最重要）
分割モード（A/B）で splits を返す場合、以下は**絶対に禁止**です。違反が疑われる場合は必ず単一モード（C）にフォールバックしてください。
- 画像に印字されていない品目名・カテゴリ名を splits に出力すること。
- 画像に存在しない split 行を**追加して**差額を埋めること。金額整合は「既存の主たる科目の行の amount を最小限寄せる」端数調整のみで行う。
- 画像に書かれていない一般化ラベル（例: "日用品・雑貨", "外税商品1", "その他商品", "郵便料金"）を description に入れること。
- 店舗業態からの類推で「ありそうな品目・カテゴリ」を生成して行を増やすこと。
- 画像に実在しない税区分の split を生成すること（税区分サマリが片方しか印字されていないときは単一モードに戻す）。

### description の許容値（分割モード共通）
以下のいずれか**のみ**を使用可。それ以外は禁止:
1. 画像に明示的に印字された品目名（通常は集約されるため稀）
2. 画像に明示的に印字されたカテゴリ見出し（例: "青果", "日用品", "酒類", "アルコール飲料", "医薬品"）
3. 税区分サマリラベル: "10%対象", "8%対象", "軽減税率対象", "標準税率対象"

### モードA: 品目明細分割のルール
- 各品目を (勘定科目, tax_code) の組で分類する。
- **全品目が同一の勘定科目かつ同一の税区分なら分割しない**（モードC＝単一モードで返す）。
- 勘定科目または税区分が2種類以上混在する場合のみ splits を返す。
- splits の各行は「画像に印字された1品目」または「画像に印字された複数品目の集約（同一 category × 同一 tax_code のグループ）」のいずれかに対応させる。**画像に実在しない行を追加してはならない。**
- 少額端数（1品目 100円未満かつ総額の5%未満）は主たる科目の行に吸収してよい（新規行を立てない）。
- 明細が細かすぎる場合は最大5行程度に集約する。集約時の description は前述「description の許容値」に従う。
- 飲食店でのイートイン（接待交際費・会議費）は原則モードC。税区分は 136（10%）。

### モードB: 税区分サマリ分割のルール（v3 新設 / v3.1 条件厳格化）
品目明細がなくても、画像内に以下のような税区分別対象額サマリが**明示的に**印字されている場合はこのモードを使う:
- 「10%対象 ¥◯◯◯◯（消費税 ¥◯◯）」
- 「8%対象（軽減）¥◯◯◯◯」「軽減税率対象 ¥◯◯◯◯」
- 「標準税率対象 ¥◯◯◯◯」

**税区分サマリの必須条件（v3.1 厳格化・ALL 必要）**:
1. 画像内に **「10%対象」または「標準税率対象」** の文字列が存在する。
2. 画像内に **「8%対象」「軽減税率対象」「軽減8%対象」「8%対象（軽）」のいずれか** の文字列が存在する。
3. 上記1と2のそれぞれに対して、**独立した本体額（または税込対象額）の数値** が並記されている。
4. その2つの数値が **税額ではなく本体額（または税込対象額）** であると確信できる。
上記を1つでも満たせない場合、モードB には入らず **必ずモードC にフォールバック** する。疑わしい場合は常にモードC に倒すこと。

**税区分サマリと誤認してはいけない表記（v3.1 明示的否定リスト）**:
以下はすべて **税額側の印字** または **単一税率の補足情報** であり、モードB の根拠にしてはならない。これらを「10%対象 / 8%対象」と読み替えることは禁止:
- 「10.0% 消費税等 ¥◯◯」「8.0% 消費税等 ¥◯◯」「X% 消費税 ¥◯◯」などの **「率 × 税額」** 形式の印字（パーセンテージは税率を示すだけで、続く金額は本体額ではなく消費税額である）。
- 「外税額計 ¥◯◯」「内税額計 ¥◯◯」「消費税額計 ¥◯◯」「消費税合計 ¥◯◯」。
- 「(外税10.0% 対象額 ¥◯◯)」が **1区分しか印字されていない** 場合（これは単一税率レシートの本体額表示にすぎない）。
- 「税込額 ¥◯◯」「本体額 ¥◯◯」など税率区分が明記されていないもの。
- 「合計（税10%） ¥◯◯」のみが単独で印字されているもの（これは単一税率の合計行）。
特に、「10.0% 消費税等 ¥X / 外税額計 ¥X / 現計 ¥Y」の様式は **10% 単一税率の外税印字** なのでモードC で処理する。この様式は大型ホームセンター・家電量販店で頻出する。

このモードでの splits 構築は以下の**機械的ルール**に厳密に従う（推測禁止）:

**amount の決め方**:
- 印字された税区分別の**税込換算対象額**を採用する。
- 税込対象額が直接印字されていればそのまま使う。
- 本体価格と消費税が別行印字なら本体＋該当消費税を加算して税込化する（例: 「10%対象 本体¥8,778 消費税¥798」 → amount 9576）。
- 税込額と本体額のどちらも判別困難なら、このモードを使わず単一モード（C）に戻す。

**tax_code の決め方**:
- 10%対象 → 136
- 軽減8%対象・8%対象（軽）・軽減税率対象 → 137

**description の決め方**（固定ラベル・他は禁止）:
- "10%対象" / "8%対象" / "軽減税率対象" / "標準税率対象"

**category の決め方**:
- **store から判定した業態の category を全 split に同一適用する**（モードBは業態単一が前提）。
  - 酒類専門店（リカーマウンテン等）: 全 split が 仕入高（10%酒類と 8%食品の両方仕入れでも 仕入高 で統一）
  - 食品スーパー・コンビニ: 全 split が 仕入高
  - ドラッグストア: 全 split が 消耗品費
  - 飲食店: モードBは使わず単一モード
- 業態が category を割れさせるべき（複合業態）な場合は、画像の税区分サマリだけでは情報不足なのでモードBを諦めてモードCにフォールバックする。

**行数上限**:
- モードBは**最大2行**（10%対象＋8%対象）まで。3行以上の税区分サマリが印字されるケースは稀で、出現したら単一モード（C）にフォールバックしてよい。

### モードC: 単一モードのルール
- tax_code を1つだけ返す（食品専門店・スーパー・コンビニで食品主体なら 137、酒類専門店・飲食店・家電・ドラッグストア・交通・通信等は 136）。
- splits フィールドは出力しない。

### 金額整合性（全モード共通・最重要）
- splits を返す場合、Σ split.amount は必ず amount（総額・税込）と一致させること。
- 1円ずれる場合のみ、**既存行の amount を最小限調整する**（主たる科目の行に差分を寄せる）。**新規行の追加による調整は禁止**。
- どうしても一致できない、または「新規行を追加しないと整合しない」と判断した場合は、splits を返さず単一モード（C）にフォールバックする。
- 分割モード（A/B）の代表 category/tax_code は splits 内の最大 amount の行に合わせる。

## 出力形式（厳守）
以下のJSON1オブジェクトのみを出力。前置き・解説・コードフェンス・末尾テキストを一切付けない。

### モードC: 単一モード（分割なし）
\{"date":"YYYY-MM-DD","amount":数値,"store":"店名","category":"勘定科目","tax_code":136\}

### モードA: 品目明細分割の例
\{"date":"YYYY-MM-DD","amount":1200,"store":"店名","category":"仕入高","tax_code":137,"splits":[\{"category":"仕入高","amount":800,"tax_code":137,"description":"食品"\},\{"category":"消耗品費","amount":400,"tax_code":136,"description":"日用品"\}]\}

### モードB: 税区分サマリ分割の例
画像に「10%対象 ¥8,778（税¥798）/ 8%対象 ¥1,815（税¥134）」と印字された酒類専門店の領収書:
\{"date":"YYYY-MM-DD","amount":10593,"store":"リカーマウンテン〇〇店","category":"仕入高","tax_code":136,"splits":[\{"category":"仕入高","amount":9576,"tax_code":136,"description":"10%対象"\},\{"category":"仕入高","amount":1017,"tax_code":137,"description":"8%対象"\}]\}

※ 代表 category/tax_code はダッシュボード表示用。splits がある場合は splits が真実。
※ 分割時も tax_code フィールドは（UI 表示用に）代表値（最大 amount の split の tax_code）を入れて返すこと。
※ description には「画像に印字された品目名・カテゴリ見出し」または税区分ラベル（"10%対象"/"8%対象"/"軽減税率対象"/"標準税率対象"）のみ使用可。画像にない一般化ラベルは禁止。`;

    let processed = 0;
    let errors = 0;

    for (const receipt of pendingReceipts) {
      try {
        // Download image from Storage
        const { data: fileData, error: downloadError } = await supabase.storage
          .from('receipts')
          .download(receipt.storage_path);

        if (downloadError) {
          throw new Error(`Download error: ${downloadError.message}`);
        }

        const arrayBuffer = await fileData.arrayBuffer();
        const base64Image = Buffer.from(arrayBuffer).toString('base64');
        const mimeType = receipt.mime_type || 'image/jpeg';

        // Call Anthropic API
        const requestBody = {
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt, cache_control: { type: 'ephemeral' } },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: mimeType, data: base64Image },
                },
              ],
            },
          ],
        };

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Claude API error: ${response.status} ${errText}`);
        }

        const data = await response.json();
        const textContent = data.content?.[0]?.text;

        if (!textContent) {
          throw new Error('No content in Claude response');
        }

        // Extract JSON from response
        let jsonStr = textContent;
        const jsonMatch = textContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
        }

        const parsed = JSON.parse(jsonStr);

        // splits 正規化
        const rawSplits = Array.isArray(parsed.splits) ? parsed.splits : null;
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
            const totalAmount = typeof parsed.amount === 'number' ? parsed.amount : parseInt(parsed.amount, 10);
            const diff = totalAmount - splitSum;
            if (Math.abs(diff) <= 5 && cleaned.length > 0) {
              const idx = cleaned.reduce((maxIdx, cur, i, arr) => cur.amount > arr[maxIdx].amount ? i : maxIdx, 0);
              cleaned[idx].amount += diff;
            }
            const finalSum = cleaned.reduce((a, b) => a + b.amount, 0);
            if (finalSum === totalAmount) {
              normalizedSplits = cleaned;
            }
          }
        }

        const resultJson = {
          date: parsed.date || null,
          amount: typeof parsed.amount === 'number' ? parsed.amount : (parsed.amount ? (Number.isNaN(parseInt(parsed.amount, 10)) ? null : parseInt(parsed.amount, 10)) : null),
          store: normalizeStoreName(parsed.store) || null,
          category: parsed.category || null,
          tax_code: (parsed.tax_code === 136 || parsed.tax_code === 137) ? parsed.tax_code : 136,
        };
        if (normalizedSplits) {
          resultJson.splits = normalizedSplits;
        }

        // 除外店舗チェック（Claudeが見逃した場合のフォールバック）
        const EXCLUDED_STORES = ['吸暮', 'スーク', 'souq', 'goodbye', '金魚', 'LR', 'moumou', 'こまいぬ', 'KITUNE', 'ミヤウチ', 'キシブチ', 'ハトマ', 'ヤマト', 'シマツ'];
        if (resultJson.store) {
          const storeLower = resultJson.store.toLowerCase();
          const isExcluded = EXCLUDED_STORES.some(ex => storeLower.includes(ex.toLowerCase()));
          if (isExcluded) {
            await supabase
              .from('receipts')
              .update({ status: 'error', result_json: resultJson, error_message: `自社・関連店舗のレシートです（${resultJson.store}）` })
              .eq('id', receipt.id);
            errors++;
            continue;
          }
        }

        // 必須項目チェック: date, amount, store が取れなければエラー
        const missing = [];
        if (!resultJson.date) missing.push('日付');
        if (resultJson.amount == null) missing.push('金額');
        if (!resultJson.store) missing.push('店名');
        if (missing.length > 0) {
          await supabase
            .from('receipts')
            .update({ status: 'error', result_json: resultJson, error_message: `読み取れない項目: ${missing.join('、')}` })
            .eq('id', receipt.id);
          errors++;
          continue;
        }

        // 日付範囲チェック: 前後1年以内
        if (resultJson.date) {
          const now = new Date();
          const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
          const oneYearLater = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
          const receiptDate = new Date(resultJson.date);
          if (receiptDate < oneYearAgo || receiptDate > oneYearLater) {
            await supabase
              .from('receipts')
              .update({ status: 'error', result_json: resultJson, error_message: `日付が範囲外です（${resultJson.date}）` })
              .eq('id', receipt.id);
            errors++;
            continue;
          }
        }

        // 金額上限チェック: カテゴリ別
        if (resultJson.amount != null) {
          let isAmountOverLimit = false;
          let limitMessage = '';
          
          if (resultJson.category === '仕入高') {
            if (resultJson.amount > 100000) {
              isAmountOverLimit = true;
              limitMessage = `金額が10万円を超えています（¥${resultJson.amount.toLocaleString()}）- 手動確認が必要`;
            }
          } else {
            if (resultJson.amount > 30000) {
              isAmountOverLimit = true;
              limitMessage = `金額が3万円を超えています（¥${resultJson.amount.toLocaleString()}）- 手動確認が必要`;
            }
          }

          if (isAmountOverLimit) {
            await supabase
              .from('receipts')
              .update({ status: 'error', result_json: resultJson, error_message: limitMessage })
              .eq('id', receipt.id);
            errors++;
            continue;
          }
        }

        // Save result
        await supabase
          .from('receipts')
          .update({ status: 'done', result_json: resultJson })
          .eq('id', receipt.id);

        processed++;
      } catch (err) {
        console.error(`Process error for ${receipt.id}:`, err.message);

        await supabase
          .from('receipts')
          .update({ status: 'error', error_message: err.message })
          .eq('id', receipt.id);

        errors++;
      }
    }

    return res.status(200).json({ processed, errors });
  } catch (error) {
    console.error('Process handler error:', error.message, error.stack);
    return res.status(500).json({ error: error.message });
  }
}
