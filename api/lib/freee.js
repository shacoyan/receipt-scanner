// freee API 呼び出しヘルパ
// - register.js から抽出した freee 連携ロジック群
// - Supabase クライアントは引数注入 (getSupabase) で受け取り、本ファイルは @supabase/supabase-js を import しない

import { freeeApiFetch } from './freee-auth.js';

// ─── 定数 ────────────────────────────────────────────────

export const CATEGORY_MAP = {
  '消耗品費': 929160659,
  '接待交際費': 929160653,
  '交際費': 929160653,
  '会議費': 929160654,
  '雑費': 929160680,
  '仕入高': 929160634,
  '交通費': 929160680,   // TODO: freeeに科目追加後に更新
  '通信費': 929160680,   // TODO: freeeに科目追加後に更新
};

export const SECTION_MAP = {
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

export const DEFAULT_ACCOUNT_ITEM_ID = 929160680; // 雑費
export const TAX_CODE = 136; // 課対仕入10%
export const WALLET_ID = 6815911;

// ─── 関数 ────────────────────────────────────────────────

export function validateSplitsFromDb(arr, amount) {
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

export async function uploadReceiptToFreee(companyId, receiptData, mimeType, filename) {
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

/**
 * 取引先 (partner) を keyword で検索。完全一致が無ければ新規作成。
 * @returns { partnerId: number | null, error?: string, detail?: string }
 */
export async function findOrCreatePartner(companyId, store) {
  const searchRes = await freeeApiFetch(
    `https://api.freee.co.jp/api/1/partners?company_id=${companyId}&keyword=${encodeURIComponent(store)}`
  );
  if (!searchRes.ok) {
    return { partnerId: null, error: '取引先の検索に失敗しました' };
  }
  const searchData = await searchRes.json();
  const exact = (searchData.partners || []).find((p) => p.name === store);
  if (exact) {
    return { partnerId: exact.id };
  }
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
    return { partnerId: null, error: '取引先の作成に失敗しました', detail: err };
  }
  const createData = await createRes.json();
  return { partnerId: createData.partner?.id || null };
}

/**
 * SECTION_MAP から freee section_id を引く。null セーフ。
 */
export function resolveSectionId(sectionName) {
  return sectionName ? (SECTION_MAP[sectionName] ?? null) : null;
}

/**
 * 1 行分の details オブジェクトを構築。
 */
export function buildDetail(item, store) {
  return {
    account_item_id: CATEGORY_MAP[item.category] ?? DEFAULT_ACCOUNT_ITEM_ID,
    amount: item.amount,
    description: item.description || store || '',
    tax_code: (item.tax_code === 136 || item.tax_code === 137) ? item.tax_code : 136,
  };
}

/**
 * splits 配列から freee details 配列を構築。
 * splits 未指定時は単一 detail を返す。
 */
export function buildDetails({ splits, category, amount, store, singleTaxCode, freeeSectionId }) {
  const hasSplits = Array.isArray(splits) && splits.length >= 2;
  let details;
  if (hasSplits) {
    details = splits.map(split => {
      const detail = buildDetail(split, store);
      return detail;
    });
  } else {
    const singleItem = {
      category: category,
      amount: amount,
      description: store || '',
      tax_code: singleTaxCode,
    };
    details = [buildDetail(singleItem, store)];
  }

  if (freeeSectionId) {
    details.forEach(d => d.section_id = freeeSectionId);
  }
  return details;
}

/**
 * deal を作成し、成功時は receipts テーブルに freee_sent_at / freee_deal_id を反映。
 */
export async function createDealAndMarkReceipt({
  companyId, date, details, amount,
  partnerId, freeeReceiptId, receiptId, getSupabase,
}) {
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

    if (receiptId) {
      try {
        const supabase = await getSupabase();
        const { error: updateError } = await supabase
          .from('receipts')
          .update({
            freee_sent_at: new Date().toISOString(),
            freee_deal_id: data.deal?.id ? String(data.deal.id) : null,
          })
          .eq('id', receiptId);

        if (updateError) {
          console.error('freee_sent_at update error:', updateError.message);
        }
      } catch (e) {
        console.error('freee_sent_at update exception:', e.message);
      }
    }

    return {
      ok: true,
      dealId: data.deal?.id,
      receiptUploaded: !!freeeReceiptId,
    };
  } else {
    const err = await res.text();
    console.error('freee API error:', err);
    return { ok: false, status: 500, error: '取引の登録に失敗しました', detail: err };
  }
}
