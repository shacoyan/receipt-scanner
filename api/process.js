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

## 読み取りルール
- 日付: YYYY-MM-DD形式。西暦で出力。存在しない日付（2月30日等）はnull。
- 金額: 合計金額を数値のみで出力。税込合計を優先。
- 店名: 正式な店舗名・会社名を出力。支店名も含める。
- 勘定科目: 以下の7種類から最も適切なものを1つ選択。
  消耗品費・交通費・接待交際費・会議費・通信費・雑費・仕入高

## 勘定科目の判定ルール
- 仕入高: 店舗運営のための食材・飲料・材料・商品仕入れ
  - スーパー（イオン、ライフ、万代、阪急オアシス、西友 等）での食品・飲料購入
  - 業務スーパー、コストコ での仕入れ
  - 酒屋・カクヤス・やまや での酒類仕入れ
  - 八百屋、肉屋、魚屋、市場 での生鮮仕入れ
  - コンビニ（セブン、ローソン、ファミマ）での食品・飲料購入
  - 製菓材料店、調味料・スパイス専門店
- 接待交際費 / 交際費: 取引先・顧客・関係者との飲食・贈答
  - レストラン、居酒屋、バー、ラウンジでの飲食（接待目的）
  - 手土産、贈答品
- 会議費: 社内会議・打合せでの飲食・会議室利用
  - カフェ（スタバ、ドトール等）での打合せ
  - 会議室・貸スペース利用料
  - 打合せ時のテイクアウト飲食
- 消耗品費: 文具、清掃用品、小物備品（食品以外の消耗品）
- 交通費: タクシー、電車、バス、ガソリン、駐車場
- 通信費: 携帯、インターネット、郵送料
- 雑費: 上記いずれにも該当しないもの

## 判定の優先順位（重要）
以下の優先順位に従って勘定科目を判定してください：
1. 飲食店・居酒屋・カフェでの「席に着いての飲食」→ 接待交際費 or 会議費
2. スーパー・業務スーパー・酒屋・コンビニでの「持ち帰り食品/飲料購入」→ 仕入高
3. 迷う場合は店舗業態を優先（「カクヤス」「業務スーパー」「ライフ」等のチェーン名が取れたら仕入高）

## 自信度の判断（重要）
以下に該当する場合、該当項目は必ずnullにしてください：
- 文字がかすれ・にじみ・汚れで判読困難
- 一部が折れ・隠れ・切れていて見えない
- 複数の金額があり合計が特定できない（小計・税額・合計が混在）
- 印字が薄く数字や文字の識別に自信がない
- 日付のフォーマットが不明瞭（年と月日の区別がつかない等）

少しでも迷ったらnullにしてください。誤った情報を出力するよりnullの方が良いです。

## 除外店舗（自社・関連店舗）
以下の店舗名を読み取った場合は、storeをnullにしてください（自社レシートのため）：
吸暮、スーク、souq、goodbye、金魚、LR、moumou、こまいぬ、KITUNE、ミヤウチ、キシブチ、ハトマ、ヤマト、シマツ
※部分一致でも該当します（例: 「スーク西心斎橋」→ null）

## 出力形式
以下のJSON形式のみで出力してください。余計な説明は不要です:
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
