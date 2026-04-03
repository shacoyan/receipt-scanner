import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

interface AnalysisResult {
  date: string | null;
  amount: number | null;
  store: string | null;
  category: string | null;
  memo: string | null;
}

interface FormState {
  date: string;
  amount: number;
  store: string;
  category: string;
  memo: string;
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
];

const ConfirmPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as LocationState;

  const analyses = state?.analyses;

  const [forms, setForms] = useState<FormState[]>(
    analyses && analyses.length > 0
      ? analyses.map((a) => ({
          date: a.date ?? '',
          amount: a.amount ?? 0,
          store: a.store ?? '',
          category: a.category ?? '雑費',
          memo: a.memo ?? '',
        }))
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
        [name]: name === 'amount' ? Number(value) : value,
      };
      return next;
    });
  };

  const handleRegisterAll = async () => {
    setLoading(true);
    setRegistered(0);
    try {
      for (let i = 0; i < forms.length; i++) {
        const res = await fetch('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(forms[i]),
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

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold text-indigo-700 mb-2">解析結果の確認</h1>
        <p className="text-gray-500 mb-8">{forms.length}件のレシートを確認してください</p>

        <div className="space-y-6">
          {forms.map((form, index) => (
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
          ))}
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
            disabled={loading}
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
