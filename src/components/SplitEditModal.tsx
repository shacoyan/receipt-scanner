import React, { useState, useEffect, useMemo, useCallback } from 'react';

interface SplitItem {
  category: string;
  amount: number;
  tax_code: 136 | 137;
  description?: string;
}

interface SplitEditModalProps {
  receipt: {
    id: string;
    image_url: string | null;
    section_id: string | null;
    result_json: {
      date: string;
      store: string;
      amount: number;
      category: string;
      tax_code?: number | null;
      splits?: SplitItem[] | null;
    } | null;
  };
  categories: string[];
  sections: string[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

function formatYen(n: number): string {
  return '¥' + n.toLocaleString('ja-JP');
}

const SplitEditModal: React.FC<SplitEditModalProps> = ({
  receipt,
  categories,
  sections,
  onClose,
  onSaved,
}) => {
  const [date, setDate] = useState(receipt.result_json?.date ?? '');
  const [store, setStore] = useState(receipt.result_json?.store ?? '');
  const [sectionId, setSectionId] = useState<string>(receipt.section_id ?? '');
  const [splits, setSplits] = useState<SplitItem[]>(
    receipt.result_json?.splits ?? []
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalAmount = receipt.result_json?.amount ?? 0;
  const sum = splits.reduce((a, s) => a + (Number(s.amount) || 0), 0);
  const diff = totalAmount - sum;
  const isMatched = diff === 0 && splits.length >= 2;

  const canSave = useMemo(() => {
    if (!isMatched) return false;
    if (date === '') return false;
    if (store === '') return false;
    if (splits.length === 0) return false;
    return splits.every((s) => {
      if (!categories.includes(s.category)) return false;
      if (!Number.isInteger(s.amount) || s.amount <= 0) return false;
      if (s.tax_code !== 136 && s.tax_code !== 137) return false;
      if (s.description !== undefined && s.description.length > 200) return false;
      return true;
    });
  }, [isMatched, date, store, splits, categories]);

  const initialSnapshot = useMemo(() => {
    return JSON.stringify({
      date: receipt.result_json?.date ?? '',
      store: receipt.result_json?.store ?? '',
      sectionId: receipt.section_id ?? '',
      splits: receipt.result_json?.splits ?? [],
    });
  }, [receipt]);

  const hasUnsavedChanges = useMemo(() => {
    const current = JSON.stringify({ date, store, sectionId, splits });
    return current !== initialSnapshot;
  }, [date, store, sectionId, splits, initialSnapshot]);

  const updateSplit = (i: number, patch: Partial<SplitItem>) => {
    setSplits((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  };

  const addRow = () => {
    setSplits((prev) => [
      ...prev,
      {
        category: categories[0] ?? '',
        amount: 0,
        tax_code: 136,
        description: '',
      },
    ]);
  };

  const removeRow = (i: number) => {
    setSplits((prev) => prev.filter((_, idx) => idx !== i));
  };

  const handleClose = useCallback(() => {
    if (hasUnsavedChanges) {
      if (!window.confirm('変更が保存されていません。閉じてよろしいですか?')) {
        return;
      }
    }
    onClose();
  }, [hasUnsavedChanges, onClose]);

  const handleSave = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        ids: [receipt.id],
        action: 'update' as const,
        data: {
          date,
          store,
          amount: totalAmount,
          category: splits[0]?.category ?? receipt.result_json?.category ?? '',
          tax_code: splits[0]?.tax_code ?? receipt.result_json?.tax_code ?? null,
          splits: splits.map((s) => ({
            category: s.category,
            amount: Number(s.amount),
            tax_code: s.tax_code,
            description: s.description || undefined,
          })),
        },
        section_id: sectionId,
      };
      const res = await fetch('/api/receipts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as any));
        throw new Error(data.error ?? '保存に失敗しました');
      }
      await onSaved();
    } catch (e: any) {
      setError(e.message ?? '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    document.addEventListener('keydown', escHandler);
    return () => {
      document.removeEventListener('keydown', escHandler);
    };
  }, [handleClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="max-w-5xl w-full max-h-[90vh] bg-white rounded-2xl shadow-2xl overflow-hidden grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        {/* Left column: Image */}
        <div className="hidden md:flex items-center justify-center bg-gray-50">
          {receipt.image_url ? (
            <img
              src={receipt.image_url}
              alt="Receipt"
              className="w-full h-full object-contain bg-gray-50 max-h-[80vh]"
            />
          ) : (
            <span className="text-gray-400 text-sm">画像なし</span>
          )}
        </div>

        {/* Right column: Form */}
        <div className="overflow-y-auto p-6 flex flex-col gap-4 max-h-[90vh] md:max-h-none">
          {/* Header */}
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-gray-900">分割伝票を編集</h2>
            <button
              onClick={handleClose}
              className="text-gray-400 hover:text-gray-600 text-xl font-bold leading-none"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* Common fields */}
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-700">日付</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-700">店名</label>
              <input
                type="text"
                value={store}
                onChange={(e) => setStore(e.target.value)}
                className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-700">部門</label>
              <select
                value={sectionId}
                onChange={(e) => setSectionId(e.target.value)}
                className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
              >
                <option value="">未設定</option>
                {sections.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-700">総額</label>
              <div className="border border-gray-200 rounded-md px-3 py-2 text-sm bg-gray-50 text-gray-700 font-medium">
                {formatYen(totalAmount)}
              </div>
            </div>
          </div>

          {/* Split table */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-gray-800">分割内訳</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border border-gray-200 rounded-md">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-500 w-8">#</th>
                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-500">勘定科目</th>
                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-500 w-28">金額</th>
                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-500 w-24">税区分</th>
                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-500">説明</th>
                    <th className="px-2 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {splits.map((s, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="px-2 py-2 text-gray-500">{i + 1}</td>
                      <td className="px-2 py-2">
                        <select
                          value={s.category}
                          onChange={(e) =>
                            updateSplit(i, { category: e.target.value })
                          }
                          className="border border-gray-300 rounded-md px-2 py-1 text-sm w-full focus:ring-indigo-500 focus:border-indigo-500"
                        >
                          {categories.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="number"
                          step={1}
                          min={1}
                          value={s.amount || ''}
                          onChange={(e) =>
                            updateSplit(i, { amount: Number(e.target.value) || 0 })
                          }
                          className="border border-gray-300 rounded-md px-2 py-1 text-sm w-full focus:ring-indigo-500 focus:border-indigo-500"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <select
                          value={s.tax_code}
                          onChange={(e) =>
                            updateSplit(i, {
                              tax_code: Number(e.target.value) as 136 | 137,
                            })
                          }
                          className="border border-gray-300 rounded-md px-2 py-1 text-sm w-full focus:ring-indigo-500 focus:border-indigo-500"
                        >
                          <option value={136}>10%</option>
                          <option value={137}>8%軽減</option>
                        </select>
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="text"
                          maxLength={200}
                          value={s.description ?? ''}
                          onChange={(e) =>
                            updateSplit(i, { description: e.target.value })
                          }
                          className="border border-gray-300 rounded-md px-2 py-1 text-sm w-full focus:ring-indigo-500 focus:border-indigo-500"
                          placeholder="説明（任意）"
                        />
                      </td>
                      <td className="px-2 py-2 text-center">
                        <button
                          onClick={() => removeRow(i)}
                          className="text-red-500 hover:text-red-700 font-bold"
                          aria-label="Remove row"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              onClick={addRow}
              className="self-start text-indigo-600 hover:text-indigo-700 text-sm font-medium mt-1"
            >
              ＋ 行を追加
            </button>
          </div>

          {/* Total match display */}
          <div className="text-sm">
            {isMatched ? (
              <span className="text-green-700 font-medium">
                合計: {formatYen(sum)} / 総額: {formatYen(totalAmount)} (一致 ✓)
              </span>
            ) : (
              <span className="text-red-600 font-medium">
                合計: {formatYen(sum)} / 総額: {formatYen(totalAmount)}{' '}
                {splits.length < 2 ? (
                  <span>← 2行以上必要です</span>
                ) : (
                  <span>
                    差額 {formatYen(Math.abs(diff))} ← 修正してください
                  </span>
                )}
              </span>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="text-sm text-red-600 mb-2">{error}</div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 mt-2">
            <button
              onClick={handleClose}
              className="bg-white border border-gray-300 text-gray-700 rounded-md px-4 py-2 hover:bg-gray-50 text-sm font-medium"
            >
              キャンセル
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave || saving}
              className={
                canSave && !saving
                  ? 'bg-indigo-600 text-white rounded-md px-4 py-2 hover:bg-indigo-700 text-sm font-medium shadow-md'
                  : 'bg-indigo-600 text-white rounded-md px-4 py-2 text-sm font-medium opacity-50 cursor-not-allowed'
              }
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SplitEditModal;
