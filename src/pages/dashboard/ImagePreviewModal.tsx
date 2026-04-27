// receipt-scanner ダッシュボード 画像プレビューモーダル
// DashboardPage.tsx の previewUrl モーダルブロックを純粋な関数コンポーネントへ切り出し
// （Loop 4 / Engineer C）

import React from 'react';

export interface ImagePreviewModalProps {
  url: string | null;
  onClose: () => void;
}

export const ImagePreviewModal: React.FC<ImagePreviewModalProps> = ({ url, onClose }) => {
  if (!url) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="relative max-w-3xl max-h-[90vh] rounded-2xl overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70 transition"
        >
          ✕
        </button>
        <img decoding="async" src={url} alt="receipt preview" className="max-w-full max-h-[85vh] object-contain" />
      </div>
    </div>
  );
};
