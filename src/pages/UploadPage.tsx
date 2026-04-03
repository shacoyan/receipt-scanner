import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DropZone from '../components/DropZone';

interface AnalysisResult {
  date: string | null;
  amount: number | null;
  store: string | null;
  category: string | null;
  memo: string | null;
}

const UploadPage: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = async (files: File[]) => {
    setLoading(true);
    setError(null);
    setProgress({ current: 0, total: files.length });
    const results: AnalysisResult[] = [];

    try {
      for (let i = 0; i < files.length; i++) {
        setProgress({ current: i + 1, total: files.length });

        const formData = new FormData();
        formData.append('receipt', files[i]);

        const response = await fetch('/api/analyze', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          throw new Error(`サーバーエラー: ${response.status}（${i + 1}枚目）`);
        }

        const result = await response.json();
        results.push(result);
      }

      navigate('/confirm', { state: { analyses: results } });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : '分析中にエラーが発生しました'
      );
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50">
      <div className="max-w-2xl mx-auto px-4 py-12">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold text-indigo-900 tracking-tight">
            🧾 レシートスキャナー
          </h1>
          <p className="mt-3 text-gray-500 text-lg">
            レシート画像をアップロードしてAI分析
          </p>
        </div>

        {/* DropZone */}
        <div className="bg-white/80 backdrop-blur-sm rounded-3xl shadow-xl shadow-indigo-100/50 p-8">
          <DropZone onFiles={handleFiles} />
        </div>

        {/* Loading */}
        {loading && progress && (
          <div className="mt-8 flex flex-col items-center gap-4">
            <div className="relative w-12 h-12">
              <div className="absolute inset-0 rounded-full border-4 border-indigo-100"></div>
              <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-indigo-600 animate-spin"></div>
            </div>
            <p className="text-indigo-600 font-medium animate-pulse">
              {progress.current}/{progress.total}枚目を分析中...
            </p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mt-6 p-4 bg-red-50 border border-red-200 rounded-xl">
            <p className="text-red-600 text-center text-sm font-medium">
              ⚠️ {error}
            </p>
          </div>
        )}

        {/* Footer */}
        <p className="mt-8 text-center text-xs text-gray-400">
          対応形式: JPEG, PNG, WebP（複数枚同時選択可）
        </p>
      </div>
    </div>
  );
};

export default UploadPage;
