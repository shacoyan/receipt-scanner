import React from 'react';
import type { SplitEditTarget } from '../types/receipt';
import { useSplitEditState } from './splitEdit/useSplitEditState';
import SplitEditFields from './splitEdit/SplitEditFields';
import SplitTable from './splitEdit/SplitTable';

interface SplitEditModalProps {
  receipt: SplitEditTarget;
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
  const state = useSplitEditState(receipt, categories, onClose, onSaved);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) state.handleClose();
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
            <div className="flex items-center gap-3">
              <button
                onClick={state.handleRelease}
                disabled={state.releasing || state.saving || state.splits.length === 0}
                className="text-xs font-medium text-red-600 hover:text-red-700 underline disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {state.releasing ? '解除中…' : '分割を解除して保存'}
              </button>
              <button
                onClick={state.handleClose}
                className="text-gray-400 hover:text-gray-600 text-xl font-bold leading-none"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Common fields */}
          <SplitEditFields
            date={state.date}
            store={state.store}
            sectionId={state.sectionId}
            totalAmount={state.totalAmount}
            sections={sections}
            onChangeDate={state.setDate}
            onChangeStore={state.setStore}
            onChangeSection={state.setSectionId}
            onChangeTotalAmount={state.setTotalAmount}
          />

          {/* Split table */}
          <SplitTable
            splits={state.splits}
            categories={categories}
            onUpdateSplit={state.updateSplit}
            onAddRow={state.addRow}
            onRemoveRow={state.removeRow}
          />

          {/* Total match display */}
          <div className="text-sm">
            {state.isMatched ? (
              <span className="text-green-700 font-medium">
                合計: {formatYen(state.sum)} / 総額: {formatYen(state.totalAmount)} (一致 ✓)
              </span>
            ) : (
              <span className="text-red-600 font-medium">
                合計: {formatYen(state.sum)} / 総額: {formatYen(state.totalAmount)}{' '}
                {state.splits.length < 2 ? (
                  <span>← 2行以上必要です</span>
                ) : (
                  <span>
                    差額 {formatYen(Math.abs(state.diff))} ← 修正してください
                  </span>
                )}
              </span>
            )}
          </div>

          {/* Error */}
          {state.error && (
            <div className="text-sm text-red-600 mb-2">{state.error}</div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 mt-2">
            <button
              onClick={state.handleClose}
              className="bg-white border border-gray-300 text-gray-700 rounded-md px-4 py-2 hover:bg-gray-50 text-sm font-medium"
            >
              キャンセル
            </button>
            <button
              onClick={state.handleSave}
              disabled={!state.canSave || state.saving}
              className={
                state.canSave && !state.saving
                  ? 'bg-indigo-600 text-white rounded-md px-4 py-2 hover:bg-indigo-700 text-sm font-medium shadow-md'
                  : 'bg-indigo-600 text-white rounded-md px-4 py-2 text-sm font-medium opacity-50 cursor-not-allowed'
              }
            >
              {state.saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SplitEditModal;
