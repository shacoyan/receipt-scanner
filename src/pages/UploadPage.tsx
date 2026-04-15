import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import DropZone from '../components/DropZone';

const SECTIONS = ['スーク', '金魚', 'KITUNE', 'Goodbye', 'LR', '狛犬', 'moumou', 'SABABA HQ', '大輝HQ'];

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.7;
const BATCH_SIZE = 5;

/**
 * 画像を Canvas API で圧縮し、JPEG Blob を返す。
 * - 長辺が MAX_DIMENSION を超える場合のみリサイズ
 * - 元が JPEG/PNG/WebP いずれでも出力は JPEG
 * - 圧縮後のファイル名は元のファイル名を維持（拡張子は .jpg に変更）
 */
async function compressImage(file: File): Promise<File> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;

      // 長辺が MAX_DIMENSION 以下ならリサイズ不要だが、JPEG再圧縮はする
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        if (width > height) {
          height = Math.round(height * (MAX_DIMENSION / width));
          width = MAX_DIMENSION;
        } else {
          width = Math.round(width * (MAX_DIMENSION / height));
          height = MAX_DIMENSION;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas context の取得に失敗しました'));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('画像の圧縮に失敗しました'));
            return;
          }
          // 元のファイル名から拡張子を .jpg に置換
          const newName = file.name.replace(/\.[^.]+$/, '.jpg');
          resolve(new File([blob], newName, { type: 'image/jpeg' }));
        },
        'image/jpeg',
        JPEG_QUALITY
      );
    };
    img.onerror = () => reject(new Error(`画像の読み込みに失敗: ${file.name}`));
    img.src = URL.createObjectURL(file);
  });
}

const UploadPage: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [uploadCount, setUploadCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [sectionId, setSectionId] = useState<string>('');

  const handleFiles = async (files: File[]) => {
    setLoading(true);
    setError(null);
    setDone(false);
    setUploadCount(files.length);

    try {
      // Step 1: 全画像を圧縮
      const compressed = await Promise.all(files.map(compressImage));

      // Step 2: BATCH_SIZE 枚ずつに分割
      const batches: File[][] = [];
      for (let i = 0; i < compressed.length; i += BATCH_SIZE) {
        batches.push(compressed.slice(i, i + BATCH_SIZE));
      }

      // Step 3: バッチごとに順次送信（並列だとサーバー負荷が高いため直列）
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const formData = new FormData();
        for (const file of batch) {
          formData.append('receipts', file);
        }
        if (sectionId) {
          formData.append('section_id', sectionId);
        }

        const response = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          throw new Error(
            `サーバーエラー: ${response.status}（バッチ ${i + 1}/${batches.length}）`
          );
        }
      }

      setDone(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'アップロード中にエラーが発生しました'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setDone(false);
    setUploadCount(null);
    setError(null);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50">
      <div className="max-w-2xl mx-auto px-4 py-12">
        {/* Header */}
        <div className="relative text-center mb-10">
          <Link
            to="/dashboard"
            className="absolute right-0 top-1 text-sm text-indigo-500 hover:text-indigo-700 transition font-medium"
          >
            管理画面 &rarr;
          </Link>
          <h1 className="text-4xl font-bold text-indigo-900 tracking-tight">
            {'\u{1F9FE}'} レシートスキャナー
          </h1>
          <p className="mt-3 text-gray-500 text-lg">
            レシート画像をアップロードしてAI分析
          </p>
        </div>

        {/* Section select + DropZone (hide when done) */}
        {!done && (
          <>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">部門（必須）</label>
              <select
                value={sectionId}
                onChange={(e) => setSectionId(e.target.value)}
                className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 focus:outline-none bg-white"
              >
                <option value="">部門を選択してください</option>
                {SECTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div className={`bg-white/80 backdrop-blur-sm rounded-3xl shadow-xl shadow-indigo-100/50 p-8 ${!sectionId ? 'opacity-50 pointer-events-none' : ''}`}>
              <DropZone onFiles={handleFiles} />
            </div>
          </>
        )}

        {/* Loading */}
        {loading && uploadCount && (
          <div className="mt-8 flex flex-col items-center gap-4">
            <div className="relative w-12 h-12">
              <div className="absolute inset-0 rounded-full border-4 border-indigo-100"></div>
              <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-indigo-600 animate-spin"></div>
            </div>
            <p className="text-indigo-600 font-medium animate-pulse">
              アップロード中... {uploadCount}枚
            </p>
          </div>
        )}

        {/* Success */}
        {done && uploadCount && (
          <div className="bg-white/80 backdrop-blur-sm rounded-3xl shadow-xl shadow-indigo-100/50 p-8">
            <div className="text-center">
              <div className="mx-auto w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-6">
                <svg
                  className="w-8 h-8 text-green-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
              <p className="text-lg font-semibold text-indigo-900 mb-2">
                {'\u2705'} {uploadCount}枚のレシートをアップロードしました！
              </p>
              <p className="text-gray-500 mb-8">
                解析はバックグラウンドで進行中です。
              </p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <button
                  onClick={() => navigate('/dashboard')}
                  className="px-6 py-3 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition shadow-lg shadow-indigo-200"
                >
                  管理画面へ
                </button>
                <button
                  onClick={handleReset}
                  className="px-6 py-3 bg-white text-indigo-600 border border-indigo-200 rounded-xl font-medium hover:bg-indigo-50 transition"
                >
                  続けてアップロード
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mt-6 p-4 bg-red-50 border border-red-200 rounded-xl">
            <p className="text-red-600 text-center text-sm font-medium">
              {'\u26A0\uFE0F'} {error}
            </p>
          </div>
        )}

        {/* Footer */}
        {!done && (
          <p className="mt-8 text-center text-xs text-gray-400">
            対応形式: JPEG, PNG, WebP（複数枚同時選択可）
          </p>
        )}
      </div>
    </div>
  );
};

export default UploadPage;
