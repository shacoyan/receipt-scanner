import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AnalysisResult, SplitItem } from '../types/receipt';

interface FormState {
  date: string;
  amount: number;
  store: string;
  category: string;
  memo: string;
  tax_code: 136 | 137;
  splitMode: boolean;
  splits: SplitItem[];
}

interface LocationState {
  analyses: AnalysisResult[];
}

const CATEGORIES = [
  '消耗品費',
  '交通費',
  '接待交際費',
  '会議費',
  '通信費',
  '雑費',
  '仕入高',
];

const TAX_OPTIONS = [
  { value: 136, label: '10% 標準' },
  { value: 137, label: '8% 軽減（食品）' },
];

const buildPayload = (form: FormState) => {
  const base = {
    date: form.date,
    amount: form.amount,
    store: form.store,
    memo: form.memo,
  };

  if (form.splitMode && form.splits.length >= 2) {
    const maxAmountSplit = form.splits.reduce((prev, current) => (prev.amount > current.amount ? prev : current));
    return {
      ...base,
      category: maxAmountSplit.category,
      tax_code: 136,
      splits: form.splits,
    };
  } else {
    return {
      ...base,
      category: form.category,
      tax_code: form.tax_code,
    };
  }
};

const validateForm = (form: FormState): boolean => {
  if (!form.date) return false;
  if (!form.amount || form.amount <= 0) return false;
  
  if (form.splitMode && form.splits.length >= 2) {
    if (form.splits.some((s) => !s.amount || Number(s.amount) <= 0)) return false;
    const sum = form.splits.reduce((acc, s) => acc + Number(s.amount), 0);
    if (sum !== form.amount) return false;
  }
  
  return true;
};

const ConfirmPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as LocationState;

  const analyses = state?.analyses;

  const [forms, setForms] = useState<FormState[]>(
    analyses && analyses.length > 0
      ? analyses.map((a) => {
          const initialSplits = (a.splits && a.splits.length >= 2) ? a.splits : [];
          return {
            date: a.date ?? '',
            amount: a.amount ?? 0,
            store: a.store ?? '',
            category: a.category ?? '雑費',
            memo: a.memo ?? '',
            tax_code: a.tax_code === 137 ? 137 : 136,
            splitMode: initialSplits.length > 0,
            splits: initialSplits,
          };
        })
      : []
  );

  const [loading, setLoading] = useState(false);
  const [registered, setRegistered] = useState(0);

  const handleChange = (
    index: number,
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setForms((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        [name]: (name === 'amount' || name === 'tax_code') ? Number(value) : value,
      };
      return next;
    });
  };

  const toggleSplit = (index: number) => {
    setForms((prev) => {
      const next = [...prev];
      const form = next[index];
      const half = Math.floor(form.amount / 2);
      const remainder = form.amount - half;
      
      next[index] = {
        ...form,
        splitMode: true,
        splits: [
          { category: form.category, amount: remainder, tax_code: form.tax_code, description: '' },
          { category: form.category, amount: half, tax_code: form.tax_code, description: '' }
        ],
      };
      return next;
    });
  };

  const disableSplit = (index: number) => {
    setForms((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        splitMode: false,
        splits: [],
      };
      return next;
    });
  };

  const handleSplitChange = (index: number, splitIdx: number, field: string, value: string | number) => {
    setForms((prev) => {
      const next = [...prev];
      const splits = [...next[index].splits];
      splits[splitIdx] = {
        ...splits[splitIdx],
        [field]: (field === 'amount' || field === 'tax_code') ? Number(value) : value,
      };
      next[index] = {
        ...next[index],
        splits,
      };
      return next;
    });
  };

  const addSplitRow = (index: number) => {
    setForms((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        splits: [
          ...next[index].splits,
          { category: '雑費', amount: 0, tax_code: 136, description: '' }
        ],
      };
      return next;
    });
  };

  const removeSplitRow = (index: number, splitIdx: number) => {
    setForms((prev) => {
      const next = [...prev];
      const form = next[index];
      
      if (form.splits.length <= 2) {
        next[index] = {
          ...form,
          splitMode: false,
          splits: [],
        };
      } else {
        const splits = form.splits.filter((_, i) => i !== splitIdx);
        next[index] = {
          ...form,
          splits,
        };
      }
      return next;
    });
  };

  const autoFillLastSplit = (index: number) => {
    setForms((prev) => {
      const next = [...prev];
      const form = next[index];
      const splits = [...form.splits];
      
      if (splits.length > 0) {
        const otherSum = splits.slice(0, -1).reduce((sum, s) => sum + Number(s.amount), 0);
        const lastAmount = form.amount - otherSum;
        
        splits[splits.length - 1] = {
          ...splits[splits.length - 1],
          amount: lastAmount > 0 ? lastAmount : 0,
        };
        
        next[index] = {
          ...form,
          splits,
        };
      }
      return next;
    });
  };

  const handleRegisterAll = async () => {
    for (let i = 0; i < forms.length; i++) {
      if (!validateForm(forms[i])) {
        alert(`レシート ${i + 1} の内容にエラーがあります（金額や分割合計を確認してください）`);
        return;
      }
    }

    setLoading(true);
    setRegistered(0);
    try {
      for (let i = 0; i < forms.length; i++) {
        const payload = buildPayload(forms[i]);
        const res = await fetch('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!data.success) {
          alert(`レシート ${i + 1} の登録に失敗しました`);
          setLoading(false);
          return;
        }
        setRegistered(i + 1);
      }
      navigate('/complete', { state: { count: forms.length } });
    } catch {
      alert('通信エラーが発生しました');
    } finally {
      setLoading(false);
    }
  };

  if (!analyses || analyses.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">データがありません</p>
      </div>
    );
  }

  const isSubmitDisabled = loading || forms.some(form => {
    if (form.splitMode && form.splits.length >= 2) {
      const sum = form.splits.reduce((acc, s) => acc + Number(s.amount), 0);
      if (sum !== form.amount) return true;
    }
    return false;
  });

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold text-indigo-700 mb-2">解析結果の確認</h1>
        <p className="text-gray-500 mb-8">{forms.length}件のレシートを確認してください</p>

        <div className="space-y-6">
          {forms.map((form, index) => {
            const splitSum = form.splits.reduce((acc, s) => acc + Number(s.amount), 0);
            const splitMismatch = form.splitMode && form.splits.length >= 2 && splitSum !== form.amount;
            
            return (
              <div key={index} className="bg-white rounded-xl shadow-md p-8">
                <h2 className="text-lg font-semibold text-gray-800 mb-5">
                  レシート {index + 1} / 合計{forms.length}
                </h2>

                <div className="space-y-5">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">日付</label>
                    <input
                      type="date"
                      name="date"
                      value={form.date}
                      onChange={(e) => handleChange(index, e)}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-indigo-500 focus:border-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">金額</label>
                    <input
                      type="number"
                      name="amount"
                      value={form.amount}
                      onChange={(e) => handleChange(index, e)}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-indigo-500 focus:border-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">店舗</label>
                    <input
                      type="text"
                      name="store"
                      value={form.store}
                      onChange={(e) => handleChange(index, e)}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-indigo-500 focus:border-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">カテゴリ</label>
                    <select
                      name="category"
                      value={form.category}
                      onChange={(e) => handleChange(index, e)}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-indigo-500 focus:border-indigo-500"
                    >
                      {CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">税区分</label>
                    <select
                      name="tax_code"
                      value={form.tax_code}
                      onChange={(e) => handleChange(index, e)}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-indigo-500 focus:border-indigo-500"
                    >
                      {TAX_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {!form.splitMode ? (
                    <button
                      type="button"
                      onClick={() => toggleSplit(index)}
                      className="mt-2 text-sm text-indigo-600 hover:text-indigo-800 underline"
                    >
                      分割する
                    </button>
                  ) : (
                    <div className="mt-4 pt-4 border-t border-gray-200">
                      <div className="flex justify-between items-center mb-4">
                        <h3 className="text-md font-semibold text-gray-700">分割入力</h3>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => autoFillLastSplit(index)}
                            className="text-sm bg-gray-200 text-gray-700 px-3 py-1 rounded hover:bg-gray-300"
                          >
                            残額を自動按分
                          </button>
                          <button
                            type="button"
                            onClick={() => disableSplit(index)}
                            className="text-sm bg-red-100 text-red-700 px-3 py-1 rounded hover:bg-red-200"
                          >
                            分割を解除
                          </button>
                        </div>
                      </div>

                      <div className="space-y-3 mb-4">
                        {form.splits.map((split, splitIdx) => (
                          <div key={splitIdx} className="border rounded p-3 bg-gray-50">
                            <div className="grid grid-cols-6 gap-2 items-end">
                              <div className="col-span-1">
                                <label className="block text-xs text-gray-500 mb-1">金額</label>
                                <input
                                  type="number"
                                  value={split.amount}
                                  onChange={(e) => handleSplitChange(index, splitIdx, 'amount', e.target.value)}
                                  className="w-full border border-gray-300 rounded-md px-2 py-1 text-sm"
                                />
                              </div>
                              <div className="col-span-2">
                                <label className="block text-xs text-gray-500 mb-1">科目</label>
                                <select
                                  value={split.category}
                                  onChange={(e) => handleSplitChange(index, splitIdx, 'category', e.target.value)}
                                  className="w-full border border-gray-300 rounded-md px-2 py-1 text-sm"
                                >
                                  {CATEGORIES.map((cat) => (
                                    <option key={cat} value={cat}>{cat}</option>
                                  ))}
                                </select>
                              </div>
                              <div className="col-span-1">
                                <label className="block text-xs text-gray-500 mb-1">税区分</label>
                                <select
                                  value={split.tax_code}
                                  onChange={(e) => handleSplitChange(index, splitIdx, 'tax_code', e.target.value)}
                                  className="w-full border border-gray-300 rounded-md px-2 py-1 text-sm"
                                >
                                  {TAX_OPTIONS.map((opt) => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                  ))}
                                </select>
                              </div>
                              <div className="col-span-1">
                                <label className="block text-xs text-gray-500 mb-1">摘要</label>
                                <input
                                  type="text"
                                  value={split.description}
                                  onChange={(e) => handleSplitChange(index, splitIdx, 'description', e.target.value)}
                                  className="w-full border border-gray-300 rounded-md px-2 py-1 text-sm"
                                />
                              </div>
                              <div className="col-span-1 flex justify-end">
                                <button
                                  type="button"
                                  onClick={() => removeSplitRow(index, splitIdx)}
                                  className="p-1 text-red-500 hover:text-red-700"
                                  aria-label="削除"
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>

                      <button
                        type="button"
                        onClick={() => addSplitRow(index)}
                        className="text-sm text-indigo-600 hover:text-indigo-800 underline"
                      >
                        + 行を追加
                      </button>

                      <div className={`mt-4 text-sm font-medium ${splitMismatch ? 'text-red-600' : 'text-green-600'}`}>
                        {splitMismatch ? (
                          <span className="text-red-600">
                            合計: ¥{splitSum.toLocaleString()} / ¥{form.amount.toLocaleString()} (差額: ¥{(form.amount - splitSum).toLocaleString()})
                          </span>
                        ) : (
                          <span className="text-green-600 flex items-center gap-1">
                            ✓ 合計: ¥{splitSum.toLocaleString()} / ¥{form.amount.toLocaleString()} (一致)
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">メモ</label>
                    <textarea
                      name="memo"
                      value={form.memo}
                      onChange={(e) => handleChange(index, e)}
                      rows={3}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-indigo-500 focus:border-indigo-500"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-8 flex gap-4">
          <button
            onClick={() => navigate('/')}
            className="flex-1 py-2 px-4 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100 transition"
          >
            戻る
          </button>
          <button
            onClick={handleRegisterAll}
            disabled={isSubmitDisabled}
            className="flex-1 py-2 px-4 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 transition flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full inline-block" />
                <span>{registered}/{forms.length}件登録中...</span>
              </>
            ) : (
              `${forms.length}件をまとめて登録`
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmPage;
