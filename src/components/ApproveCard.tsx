import React, { useState } from 'react';

type ReceiptStatus = 'pending' | 'processing' | 'done' | 'approved' | 'error';

interface ReceiptResult {
  date: string;
  amount: number;
  store: string;
  category: string;
  tax_code?: number | null;
  splits?: Array<{ category: string; amount: number; tax_code: number; description?: string; }> | null;
  uncertainty_reason?: string | null;
}

interface Receipt {
  id: string;
  image_url: string;
  status: ReceiptStatus;
  result_json: ReceiptResult | null;
  error_message: string | null;
  section_id: string | null;
  created_at: string;
  freee_sent_at: string | null;
  freee_deal_id: string | null;
}

interface ApproveCardProps {
  receipt: Receipt;
  progress: string;
  remaining: number;
  processing: boolean;
  onApprove: () => void;
  onMarkError: () => void;
  onSkip: () => void;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
}

const ApproveCard: React.FC<ApproveCardProps> = ({
  receipt,
  progress,
  remaining,
  processing,
  onApprove,
  onMarkError,
  onSkip,
  onPrev,
  onNext,
  canPrev,
  canNext,
}) => {
  const [imgError, setImgError] = useState<boolean>(false);

  const formatAmount = (amount: number): string => {
    return `\u00A5${amount.toLocaleString()}`;
  };

  const result = receipt.result_json;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50 py-6 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">承認モード</h1>
            <p className="text-sm text-gray-600 mt-1">
              残り {remaining} 件 (進捗 {progress})
            </p>
          </div>
          <a
            href="/dashboard"
            className="text-indigo-600 hover:text-indigo-800 font-medium transition"
          >
            ダッシュボードに戻る
          </a>
        </div>

        <div className="rounded-2xl shadow-lg bg-white overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-2 lg:h-[75vh]">
            <div className="relative bg-gray-50 flex items-center justify-center p-2 aspect-[3/4] lg:aspect-auto lg:h-[75vh] overflow-hidden">
              {!imgError ? (
                <img
                  src={receipt.image_url}
                  alt="Receipt"
                  className="max-h-full max-w-full object-contain cursor-pointer"
                  onClick={() => window.open(receipt.image_url, '_blank')}
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                    setImgError(true);
                  }}
                />
              ) : (
                <div className="flex items-center justify-center w-full h-64 text-gray-500">
                  画像を取得できません
                </div>
              )}
            </div>

            <div className="p-6 space-y-4 overflow-y-auto lg:h-[75vh]">
              <h2 className="text-xl font-semibold text-gray-800 border-b pb-2 mb-4">
                読み取りデータ
              </h2>
              
              {result ? (
                <>
                  <div className="grid grid-cols-3 gap-y-3 text-lg">
                    <dt className="font-medium text-gray-500">店名</dt>
                    <dd className="col-span-2 text-3xl font-bold text-gray-900">{result.store}</dd>

                    <dt className="font-medium text-gray-500">日付</dt>
                    <dd className="col-span-2 text-gray-900">{result.date}</dd>

                    <dt className="font-medium text-gray-500">金額</dt>
                    <dd className="col-span-2 text-5xl font-bold text-gray-900">
                      {formatAmount(result.amount)}
                    </dd>

                    <dt className="font-medium text-gray-500">勘定科目</dt>
                    <dd className="col-span-2 text-gray-900">{result.category}</dd>

                    <dt className="font-medium text-gray-500">税区分</dt>
                    <dd className="col-span-2 text-gray-900">
                      {result.tax_code != null ? String(result.tax_code) : '-'}
                    </dd>

                    <dt className="font-medium text-gray-500">部門</dt>
                    <dd className="col-span-2 text-gray-900">
                      {receipt.section_id ?? '-'}
                    </dd>
                  </div>

                  {result.splits && result.splits.length > 0 && (
                    <div className="pt-4 border-t">
                      <h3 className="text-base font-semibold text-gray-700 mb-2">分割内訳</h3>
                      <ul className="space-y-2">
                        {result.splits.map((split, idx) => (
                          <li key={idx} className="bg-gray-50 rounded-md p-3 text-base">
                            <div className="flex justify-between items-center font-medium text-gray-800">
                              <span>{split.category}</span>
                              <span>{formatAmount(split.amount)}</span>
                            </div>
                            <div className="text-xs text-gray-500 mt-1">
                              税区分: {split.tax_code}
                              {split.description && (
                                <span className="ml-2">- {split.description}</span>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {result.uncertainty_reason && (
                    <div className="bg-amber-50 border border-amber-200 rounded-md p-4 text-base text-amber-700">
                      <span className="font-bold">注意:</span> {result.uncertainty_reason}
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-center justify-center h-40 text-gray-400">
                  読み取り結果なし
                </div>
              )}
            </div>
          </div>

          <div className="border-t px-6 py-4 bg-gray-50 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={onPrev}
              disabled={!canPrev}
              className="rounded-md px-4 py-2 font-medium border border-gray-300 bg-white text-gray-700 transition hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              &larr; 前へ (&larr;)
            </button>
            <button
              type="button"
              onClick={onApprove}
              disabled={processing}
              className="rounded-md px-4 py-2 font-medium bg-green-600 text-white transition hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              承認 (A)
            </button>
            <button
              type="button"
              onClick={onMarkError}
              disabled={processing}
              className="rounded-md px-4 py-2 font-medium bg-red-600 text-white transition hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              エラー (E)
            </button>
            <button
              type="button"
              onClick={onSkip}
              disabled={processing}
              className="rounded-md px-4 py-2 font-medium bg-gray-500 text-white transition hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              スキップ (S)
            </button>
            <button
              type="button"
              onClick={onNext}
              disabled={!canNext}
              className="rounded-md px-4 py-2 font-medium border border-gray-300 bg-white text-gray-700 transition hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              次へ &rarr; (&rarr;)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ApproveCard;
