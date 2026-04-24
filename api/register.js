import { freeeApiFetch } from './lib/freee-auth.js';

const CATEGORY_MAP = {
  '消耗品費': 929160659,
  '接待交際費': 929160653,
  '交際費': 929160653,
  '会議費': 929160654,
  '雑費': 929160680,
  '仕入高': 929160634,
  '交通費': 929160680,   // TODO: freeeに科目追加後に更新
  '通信費': 929160680,   // TODO: freeeに科目追加後に更新
};

const SECTION_MAP = {
  'スーク': 3415042,
  '金魚': 3449507,
  'KITUNE': 3415041,
  'Goodbye': 3448649,
  'LR': 3423764,
  '狛犬': 3834777,
  'moumou': 3450115,
  'SABABA HQ': 3923010,
  '大輝HQ': 3923009,
};

const DEFAULT_ACCOUNT_ITEM_ID = 929160680; // 雑費
const TAX_CODE = 136; // 課対仕入10%
const WALLET_ID = 6815911;

async function getSupabase() {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function validateSplitsFromDb(arr, amount) {
  if (!Array.isArray(arr) || arr.length < 2) return false;
  let sum = 0;
  for (const split of arr) {
    if (typeof split.category !== 'string' || !CATEGORY_MAP[split.category]) return false;
    if (typeof split.amount !== 'number' || split.amount <= 0) return false;
    if (split.tax_code !== 136 && split.tax_code !== 137) return false;
    sum += split.amount;
  }
  if (sum !== amount) return false;
  return true;
}

async function uploadReceiptToFreee(companyId, receiptData, mimeType, filename) {
  const { FormData, Blob } = await import('node:buffer').then(() => globalThis).catch(() => ({}));

  const formData = new FormData();
  formData.append('company_id', String(companyId));
  formData.append('receipt', new Blob([receiptData], { type: mimeType }), filename);

  const res = await freeeApiFetch('https://api.freee.co.jp/api/1/receipts', {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('freee receipt upload error:', err);
    return null;
  }

  const data = await res.json();
  return data.receipt?.id || null;
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const { date, amount, store, category, receipt_id, section_id, splits, tax_code } = request.body;

  // splits モードチェック
  const explicitSplits = request.body.splits !== undefined && request.body.splits !== null;
  const hasSplits = Array.isArray(splits) && splits.length >= 2;

  // splits バリデーション
  if (hasSplits) {
    let splitsAmountSum = 0;
    for (const split of splits) {
      if (!CATEGORY_MAP[split.category]) {
        return response.status(400).json({ error: '分割項目に未対応のカテゴリが含まれています' });
      }
      if (typeof split.amount !== 'number' || split.amount <= 0) {
        return response.status(400).json({ error: '分割項目の金額が不正です' });
      }
      if (split.tax_code !== 136 && split.tax_code !== 137) {
        return response.status(400).json({ error: '分割項目の税コードが不正です' });
      }
      splitsAmountSum += split.amount;
    }
    if (splitsAmountSum !== amount) {
      return response.status(400).json({ error: '分割金額の合計が総額と一致しません' });
    }
  } else if (explicitSplits) {
    return response.status(400).json({ error: '分割項目は2行以上指定してください' });
  }

  // バリデーション: 必須項目チェック
  const errors = [];
  if (!date) errors.push('日付が未取得');
  if (!amount && amount !== 0) errors.push('金額が未取得');
  if (!store) errors.push('店名が未取得');
  if (!hasSplits && !category) errors.push('勘定科目が未取得');

  // 日付の妥当性チェック
  if (date) {
    const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dateMatch) {
      errors.push('日付の形式が不正です');
    } else {
      const [, yearStr, monthStr, dayStr] = dateMatch;
      const year = parseInt(yearStr, 10);
      const month = parseInt(monthStr, 10);
      const day = parseInt(dayStr, 10);
      const now = new Date();
      const currentYear = now.getFullYear();

      // 年が古すぎる・未来すぎる
      if (year < currentYear - 2 || year > currentYear + 1) {
        errors.push(`日付の年が不正です（${year}年）`);
      }
      // 月が1-12の範囲外
      if (month < 1 || month > 12) {
        errors.push(`日付の月が不正です（${month}月）`);
      }
      // 日が存在するか確認
      if (month >= 1 && month <= 12) {
        const lastDay = new Date(year, month, 0).getDate();
        if (day < 1 || day > lastDay) {
          errors.push(`日付の日が不正です（${month}月${day}日は存在しません）`);
        }
      }
    }
  }

  // 金額の妥当性チェック
  if (amount != null) {
    if (typeof amount !== 'number' || amount <= 0) {
      errors.push('金額が不正です（0以下）');
    }
    if (amount > 10000000) {
      errors.push('金額が異常に高額です（1000万円超）');
    }
  }

  // 店名の妥当性チェック
  if (store) {
    if (store.length < 1) {
      errors.push('店名が空です');
    }
  }

  if (errors.length > 0) {
    return response.status(400).json({
      error: `データに問題があります: ${errors.join('、')}`,
    });
  }

  const companyId = Number(process.env.FREEE_COMPANY_ID);
  if (!companyId || Number.isNaN(companyId)) {
    return response.status(500).json({ error: 'FREEE_COMPANY_ID が設定されていません' });
  }
  const accountItemId = CATEGORY_MAP[category] || DEFAULT_ACCOUNT_ITEM_ID;

  try {
    // 1. Supabaseからレシート画像を取得してfreeeにアップロード
    let freeeReceiptId = null;
    let receipt = null;
    let result_json = null;
    
    if (receipt_id) {
      const supabase = await getSupabase();
      const { data: receiptData, error: receiptSelectError } = await supabase
        .from('receipts')
        .select('storage_path, mime_type, original_filename, section_id, result_json')
        .eq('id', receipt_id)
        .single();

      if (receiptSelectError) {
        console.error('Receipt select error:', receiptSelectError.message);
      }
      receipt = receiptData;
      if (receipt) {
        result_json = receipt.result_json;
        
        const { data: fileData, error: downloadError } = await supabase.storage
          .from('receipts')
          .download(receipt.storage_path);

        if (downloadError) {
          console.error('Receipt download error:', downloadError.message);
        }

        if (fileData) {
          const buffer = Buffer.from(await fileData.arrayBuffer());
          freeeReceiptId = await uploadReceiptToFreee(
            companyId,
            buffer,
            receipt.mime_type || 'image/jpeg',
            receipt.original_filename || 'receipt.jpg'
          );
          if (!freeeReceiptId) {
            return response.status(500).json({ error: 'レシート画像のfreeeアップロードに失敗しました' });
          }
        }
      }
    }

    // splits, tax_code 補完
    const dbSplits = Array.isArray(result_json?.splits) && result_json.splits.length >= 2 ? result_json.splits : undefined;
    let effectiveSplits = hasSplits ? splits : undefined;
    
    if (!hasSplits && !explicitSplits && dbSplits) {
      if (validateSplitsFromDb(dbSplits, amount)) {
        effectiveSplits = dbSplits;
      } else {
        console.warn('result_json.splits validation failed, falling back to single mode.');
      }
    }

    const effectiveTaxCode = tax_code ?? result_json?.tax_code ?? TAX_CODE;
    const effectiveHasSplits = Array.isArray(effectiveSplits) && effectiveSplits.length >= 2;

    // 単一モード時の tax_code フォールバック
    const singleTaxCode = (effectiveTaxCode === 136 || effectiveTaxCode === 137) ? effectiveTaxCode : TAX_CODE;

    // 2. 取引先（partner）を検索 or 新規作成
    let partnerId = null;
    const searchRes = await freeeApiFetch(
      `https://api.freee.co.jp/api/1/partners?company_id=${companyId}&keyword=${encodeURIComponent(store)}`
    );
    if (!searchRes.ok) {
      return response.status(500).json({ error: '取引先の検索に失敗しました' });
    }
    const searchData = await searchRes.json();
    const exact = (searchData.partners || []).find((p) => p.name === store);
    if (exact) {
      partnerId = exact.id;
    } else {
      // 完全一致なし → 新規作成
      const createRes = await freeeApiFetch('https://api.freee.co.jp/api/1/partners', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ company_id: companyId, name: store }),
      });
      if (!createRes.ok) {
        const err = await createRes.text();
        console.error('Partner create failed:', err);
        return response.status(500).json({ error: '取引先の作成に失敗しました', detail: err });
      } else {
        const createData = await createRes.json();
        partnerId = createData.partner?.id || null;
      }
    }

    // 3. 部門IDの解決
    const sectionName = section_id || (receipt_id && receipt ? receipt.section_id : null);
    const freeSectionId = sectionName ? SECTION_MAP[sectionName] : null;

    // 4. details の構築
    const buildDetail = (item) => {
      return {
        account_item_id: CATEGORY_MAP[item.category] ?? DEFAULT_ACCOUNT_ITEM_ID,
        amount: item.amount,
        description: item.description || store || '',
        tax_code: (item.tax_code === 136 || item.tax_code === 137) ? item.tax_code : 136,
      };
    };

    let details;
    if (effectiveHasSplits) {
      details = effectiveSplits.map(split => {
        const detail = buildDetail(split);
        return detail;
      });
    } else {
      const singleItem = {
        category: category,
        amount: amount,
        description: store || '',
        tax_code: singleTaxCode,
      };
      details = [buildDetail(singleItem)];
    }

    if (freeSectionId) {
      details.forEach(d => d.section_id = freeSectionId);
    }

    // 5. 取引を作成
    const dealBody = {
      company_id: companyId,
      issue_date: date,
      type: 'expense',
      details,
      payments: [
        {
          date,
          from_walletable_type: 'wallet',
          from_walletable_id: WALLET_ID,
          amount,
        },
      ],
    };

    if (partnerId) {
      dealBody.partner_id = partnerId;
    }

    if (freeeReceiptId) {
      dealBody.receipt_ids = [freeeReceiptId];
    }

    const res = await freeeApiFetch('https://api.freee.co.jp/api/1/deals', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(dealBody),
    });

    if (res.ok) {
      const data = await res.json();
      
      if (receipt_id) {
        try {
          const supabase = await getSupabase();
          const { error: updateError } = await supabase
            .from('receipts')
            .update({
              freee_sent_at: new Date().toISOString(),
              freee_deal_id: data.deal?.id ? String(data.deal.id) : null,
            })
            .eq('id', receipt_id);
            
          if (updateError) {
            console.error('freee_sent_at update error:', updateError.message);
          }
        } catch (e) {
          console.error('freee_sent_at update exception:', e.message);
        }
      }

      return response.status(200).json({
        success: true,
        deal_id: data.deal?.id,
        receipt_uploaded: !!freeeReceiptId,
      });
    } else {
      const err = await res.text();
      console.error('freee API error:', err);
      return response.status(500).json({ error: '取引の登録に失敗しました', detail: err });
    }
  } catch (e) {
    console.error('register error:', e.message);
    return response.status(500).json({ error: `freee登録に失敗しました: ${e.message}` });
  }
}
