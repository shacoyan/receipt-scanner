import { RECEIPT_PROMPT_V35 } from './lib/prompt.js';
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
    pattern: /^(セブン[‐ー\-–—−]?イレブン|7[-\s]?Eleven|SEVEN[-\s]?ELEVEN|アブゾー?イレブン|アブ[・･]?セブン[‐ー\-–—−]?イレブン|アクセブン[ー\-]?イレブン)/i,
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
    const { getSupabase } = await import('./lib/supabase.js');
    const supabase = await getSupabase();

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

    const prompt = RECEIPT_PROMPT_V35;

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
          confidence: (parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low') ? parsed.confidence : null,
          uncertainty_reason: typeof parsed.uncertainty_reason === 'string' ? parsed.uncertainty_reason : null,
        };
        if (normalizedSplits) {
          resultJson.splits = normalizedSplits;
        }

        // 除外店舗チェック（Claudeが見逃した場合のフォールバック）
        const DEFAULT_EXCLUDED_STORES = ['吸暮', 'スーク', 'souq', 'goodbye', '金魚', 'LR', 'moumou', 'こまいぬ', 'KITUNE', 'ミヤウチ', 'キシブチ', 'ハトマ', 'ヤマト', 'シマツ'];
        const EXCLUDED_STORES = process.env.EXCLUDED_STORES_CSV
          ? process.env.EXCLUDED_STORES_CSV.split(',').map(s => s.trim()).filter(Boolean)
          : DEFAULT_EXCLUDED_STORES;
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

        // splits 合計整合性チェック（v3.2）
        if (Array.isArray(resultJson.splits) && resultJson.splits.length > 0) {
          const splitsSum = resultJson.splits.reduce((s, x) => s + (Number(x.amount) || 0), 0);
          if (splitsSum !== resultJson.amount) {
            await supabase
              .from('receipts')
              .update({
                status: 'error',
                result_json: resultJson,
                error_message: `splits合計(${splitsSum})と総額(${resultJson.amount})が不一致`,
              })
              .eq('id', receipt.id);
            errors++;
            continue;
          }

          // splits 長さチェック（v3.2）
          if (resultJson.splits.length === 1) {
            await supabase
              .from('receipts')
              .update({
                status: 'error',
                result_json: resultJson,
                error_message: `splitsが1件のみ。分割の妥当性が疑わしい`,
              })
              .eq('id', receipt.id);
            errors++;
            continue;
          }

          // d. splits 整合性: 10%本体 × 0.1 ≈ 8%側金額 のパターン検出（v3.3 追加）
          //    「10% 本体額」と「8% 本体額」として分割された splits のうち、
          //    「8%側金額」が「10%側金額 × 0.1」とほぼ等しい場合、それは税額を本体額と
          //    誤認している疑いが濃厚（アークランズ ¥26,472 型）。
          //    このパターンは単一10% 税率レシートなのでエラーに倒す。
          if (resultJson.splits.length >= 2) {
            // 全 136/137 ペアで疑い検査（複数 split 構成でも漏れなく）
            const splits136 = resultJson.splits.filter(s => s.tax_code === 136);
            const splits137 = resultJson.splits.filter(s => s.tax_code === 137);
            let suspectFound = null;
            for (const s10 of splits136) {
              for (const s8 of splits137) {
                const a10 = Number(s10.amount) || 0;
                const a8  = Number(s8.amount)  || 0;
                if (a10 > 0 && a8 > 0) {
                  const ratio = a8 / a10;
                  if (ratio >= 0.095 && ratio <= 0.105) {
                    suspectFound = { a10, a8 };
                    break;
                  }
                }
              }
              if (suspectFound) break;
            }
            if (suspectFound) {
              await supabase
                .from('receipts')
                .update({
                  status: 'error',
                  result_json: resultJson,
                  error_message: `外税比（税額/本体≈10%）検出により単一税率と判定。splits疑い: 8%側(${suspectFound.a8})が10%側(${suspectFound.a10})の約10%。税額を本体額と誤認した可能性のためerror化`,
                })
                .eq('id', receipt.id);
              errors++;
              continue;
            }
          }
        }

        // e. モードB 見落とし疑い検出（v3.4 追加）
        //    酒販店などで splits が省略されている場合、1 行併記型の見落としを疑い
        //    手動確認要フラグで error 化する。d-check の直後、日付範囲チェックの直前に配置。
        {
          const isNoSplits = !Array.isArray(resultJson.splits) || resultJson.splits.length <= 1;
          const storeIsLiquor = /リカーマウンテン|リカー|Liquor\s*Mountain|酒類|酒販/i.test(resultJson.store || '');
          const reason = resultJson.uncertainty_reason || '';
          const reasonHints8 = /10\s*%\s*対象|8\s*%\s*対象|税区分|1\s*行\s*併記|併記|8\s*%|軽減/.test(reason);
          const amtOk = typeof resultJson.amount === 'number' && resultJson.amount >= 1000;
          if (isNoSplits && amtOk && (storeIsLiquor || reasonHints8)) {
            await supabase
              .from('receipts')
              .update({
                status: 'error',
                result_json: resultJson,
                error_message: `モードB疑い: 店舗(${resultJson.store})で splits なしの ¥${resultJson.amount.toLocaleString()} レシート。1行併記型見落とし可能性のため手動確認要`,
              })
              .eq('id', receipt.id);
            errors++;
            continue;
          }
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
