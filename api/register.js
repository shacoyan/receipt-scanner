import { freeeApiFetch } from './lib/freee-auth.js';

const CATEGORY_MAP = {
  '消耗品費': 929160659,
  '接待交際費': 929160653,
  '交際費': 929160653,
  '会議費': 929160654,
  '雑費': 929160680,
  '交通費': 929160680,   // TODO: freeeに科目追加後に更新
  '通信費': 929160680,   // TODO: freeeに科目追加後に更新
};

const DEFAULT_ACCOUNT_ITEM_ID = 929160680; // 雑費
const TAX_CODE = 136; // 課対仕入10%
const WALLET_ID = 6815911;

async function getSupabase() {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
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

  const { date, amount, store, category, memo, receipt_id } = request.body;

  // バリデーション: 必須項目チェック
  const errors = [];
  if (!date) errors.push('日付が未取得');
  if (!amount && amount !== 0) errors.push('金額が未取得');
  if (!store) errors.push('店名が未取得');
  if (!category) errors.push('勘定科目が未取得');

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
    if (store.length <= 2) {
      errors.push('店名が短すぎます');
    }
  }

  if (errors.length > 0) {
    return response.status(400).json({
      error: `データに問題があります: ${errors.join('、')}`,
    });
  }

  const companyId = Number(process.env.FREEE_COMPANY_ID);
  const accountItemId = CATEGORY_MAP[category] || DEFAULT_ACCOUNT_ITEM_ID;

  try {
    // 1. Supabaseからレシート画像を取得してfreeeにアップロード
    let freeeReceiptId = null;
    if (receipt_id) {
      const supabase = await getSupabase();
      const { data: receipt } = await supabase
        .from('receipts')
        .select('storage_path, mime_type, original_filename')
        .eq('id', receipt_id)
        .single();

      if (receipt) {
        const { data: fileData } = await supabase.storage
          .from('receipts')
          .download(receipt.storage_path);

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
        console.warn('Partner create failed (続行します):', err);
        // 権限不足等で作成失敗してもpartnerIdなしで続行
      } else {
        const createData = await createRes.json();
        partnerId = createData.partner?.id || null;
      }
    }

    // 3. 取引を作成
    const dealBody = {
      company_id: companyId,
      issue_date: date,
      type: 'expense',
      details: [
        {
          account_item_id: accountItemId,
          amount,
          description: `${store || ''} ${memo || ''}`.trim(),
          tax_code: TAX_CODE,
        },
      ],
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
