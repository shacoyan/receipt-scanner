import { freeeApiFetch } from './lib/freee-auth.js';
import {
  CATEGORY_MAP,
  DEFAULT_ACCOUNT_ITEM_ID,
  TAX_CODE,
  uploadReceiptToFreee,
  findOrCreatePartner,
  createDealAndMarkReceipt,
  buildDetails,
  resolveSectionId,
  validateSplitsFromDb,
} from './lib/freee.js';
import { getSupabase } from './lib/supabase.js';

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

    // 単一モード時の tax_code フォールバック
    const singleTaxCode = (effectiveTaxCode === 136 || effectiveTaxCode === 137) ? effectiveTaxCode : TAX_CODE;

    // 2. 取引先（partner）を検索 or 新規作成
    const partnerResult = await findOrCreatePartner(companyId, store);
    if (partnerResult.error) {
      const body = { error: partnerResult.error };
      if (partnerResult.detail) body.detail = partnerResult.detail;
      return response.status(500).json(body);
    }
    const partnerId = partnerResult.partnerId;

    // 3. 部門IDの解決
    const sectionName = section_id || (receipt_id && receipt ? receipt.section_id : null);
    const freeeSectionId = resolveSectionId(sectionName);

    // 4. details の構築
    const details = buildDetails({
      splits: effectiveSplits,
      category,
      amount,
      store,
      singleTaxCode,
      freeeSectionId,
    });

    // 5. 取引を作成 + receipts 反映
    const dealResult = await createDealAndMarkReceipt({
      companyId,
      date,
      details,
      amount,
      partnerId,
      freeeReceiptId,
      receiptId: receipt_id,
      getSupabase,
    });

    if (dealResult.ok) {
      return response.status(200).json({
        success: true,
        deal_id: dealResult.dealId,
        receipt_uploaded: dealResult.receiptUploaded,
      });
    } else {
      const body = { error: dealResult.error };
      if (dealResult.detail) body.detail = dealResult.detail;
      return response.status(dealResult.status || 500).json(body);
    }
  } catch (e) {
    console.error('register error:', e.message);
    return response.status(500).json({ error: `freee登録に失敗しました: ${e.message}` });
  }
}
