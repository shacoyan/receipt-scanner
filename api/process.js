export const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 60,
};

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

## 入力の種類
入力画像は次のいずれかです。どちらであっても同じJSON形式で出力します。
1. レシートテープ形式（品目明細が並ぶタイプ）
2. 正式領収書形式（宛名・発行日・但し書き・合計金額・発行者印のみで、品目明細なし）

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
- store: 発行者（店舗・会社名）。支店名まで含める。
  - 正式領収書で宛名が書かれている場合（「○○ 様」「御中」）、**宛名は絶対に store に入れない**。発行者欄（社印・店舗名）を採用。
  - 宛名の典型例: 「Goodbye 様」「株式会社〇〇 御中」「上様」——これらは store ではない。
  - 発行者例: 右下/下部の社判・店舗ロゴ・「リカーマウンテン畳屋町店」等。
- category: 下記「勘定科目」のいずれか1つを必ず選ぶ。原則として null にしない（※例外は「除外店舗」のみ）。

## 勘定科目（この7種類から1つだけ選択）
消耗品費・交通費・接待交際費・会議費・通信費・雑費・仕入高

## 業態→勘定科目の判定テーブル（最優先ルール）
store から業態が判別できる場合、品目明細を見る前にこの表に従ってください。

| 業態 | 代表チェーン・店名キーワード | category |
|---|---|---|
| コンビニ | セブンイレブン / セブン-イレブン / ファミリーマート / ファミマ / ローソン / LAWSON / ミニストップ / デイリーヤマザキ / ポプラ / セイコーマート | 仕入高 |
| 総合スーパー・食品スーパー | イオン / イオンフードスタイル / まいばすけっと / ライフ / 万代 / 阪急オアシス / 西友 / SEIYU / ダイエー / 関西スーパー / 業務スーパー / A-PRICE / ロピア / コストコ / COSTCO | 仕入高 |
| 酒類専門 | リカーマウンテン / カクヤス / やまや / 河内屋 / 酒のビッグ / なんでも酒やカクヤス | 仕入高 |
| 食品専門店 | 久世福商店 / 成城石井 / 神戸スパイス / 肉の〇〇 / 〇〇精肉店 / 〇〇鮮魚 / 〇〇青果 / 八百屋 / 製菓材料店 / 富澤商店 | 仕入高 |
| 飲食店（イートイン） | レストラン / 居酒屋 / バー / ラウンジ / 寿司 / 焼肉 / 焼鳥 / ラーメン / 定食屋 | 接待交際費 または 会議費 |
| カフェ | スターバックス / スタバ / ドトール / タリーズ / コメダ / 上島珈琲 / ブルーボトル | 会議費 |
| 100円ショップ | ダイソー / DAISO / セリア / キャンドゥ / Seria / Can★Do | 消耗品費 |
| 家電量販店 | エディオン / EDION / ヨドバシ / ビックカメラ / ヤマダ電機 / ケーズデンキ | 消耗品費 |
| ドラッグストア | マツモトキヨシ / マツキヨ / ウエルシア / スギ薬局 / ツルハ / ココカラファイン / サンドラッグ | 消耗品費 |
| ホームセンター | コーナン / カインズ / DCM / ナフコ / ビバホーム | 消耗品費 |
| 文具・事務用品 | アスクル / ロフト / 東急ハンズ / 無印良品（文具用途） | 消耗品費 |
| 交通系 | JR / 私鉄各社 / タクシー / Uber / 駐車場 / コインパーキング / ガソリンスタンド（ENEOS/出光/コスモ/昭和シェル） | 交通費 |
| 通信 | NTT / docomo / au / SoftBank / 楽天モバイル / 郵便局（送料） / ヤマト運輸 / 佐川 | 通信費 |

## 判定の優先順位（重要）
1. 店名（発行者）から**業態が特定できる場合は、上記テーブルを最優先**。品目明細の見た目（「トイレットペーパー」等が混ざっていても）に引きずられない。
2. コンビニ / スーパー / 酒屋 / 食品専門店 は **原則「仕入高」**。この事業は飲食店舗を運営しており、これらの業態での買い物は食品・飲料の仕入れが圧倒的多数。
3. 飲食店での「席に着いての飲食」は、1人あたり金額や人数の目安で 接待交際費 / 会議費 を判断。判断がつかない場合は 会議費。
4. 店名が不明瞭で業態不明、かつ品目も読み取れない場合にのみ 雑費。
5. 迷ったら「仕入高」を優先（ただし明確に飲食店・カフェ・交通・通信・100円ショップ・家電量販・ドラッグストアと分かるものは除く）。

## 正式領収書（品目明細なし）の扱い
正式領収書では品目が書かれていないため、**store（発行者）から category を推定するのが必須**。
例:
- 発行者「リカーマウンテン畳屋町店」・宛名「Goodbye 様」・「¥7,875-（内消費税 ¥583-）」・「2026/02/12」
  → {"date": "2026-02-12", "amount": 7875, "store": "リカーマウンテン畳屋町店", "category": "仕入高"}
- 発行者「株式会社〇〇タクシー」
  → category は 交通費

## 自信度の判断（date / amount / store のみ）
以下に該当する場合、**該当フィールドのみ** null にしてください（category は上記ルールで必ず埋める）：
- 文字がかすれ・にじみ・汚れで判読困難
- 一部が折れ・隠れ・切れていて見えない
- 複数の金額があり合計が特定できない
- 日付のフォーマットが不明瞭で年が確定できない

※ store が null の場合に限り、category も null にしてよい（業態判定の手がかりが無いため）。

## 除外店舗（自社・関連店舗）
以下の店舗名を store として読み取った場合は、store を null にしてください（自社レシートのため）：
吸暮、スーク、souq、goodbye、金魚、LR、moumou、こまいぬ、KITUNE、ミヤウチ、キシブチ、ハトマ、ヤマト、シマツ
※部分一致で該当（例: 「スーク西心斎橋」→ null）
※ただし「Goodbye 様」のように**宛名として書かれている場合は除外対象ではない**。宛名は元々 store に入れない。

## 出力形式（厳守）
以下のJSON1オブジェクトのみを出力。前置き・解説・コードフェンス・末尾テキストを一切付けない：
{"date": "YYYY-MM-DD", "amount": 数値, "store": "店名", "category": "勘定科目"}`;

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
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: mimeType, data: base64Image },
                },
                { type: 'text', text: prompt },
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
        const resultJson = {
          date: parsed.date || null,
          amount: typeof parsed.amount === 'number' ? parsed.amount : (parsed.amount ? (Number.isNaN(parseInt(parsed.amount, 10)) ? null : parseInt(parsed.amount, 10)) : null),
          store: parsed.store || null,
          category: parsed.category || null,
        };

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
