import React from 'react';
import type { FormState } from './useConfirmForms';
import { CATEGORIES, TAX_OPTIONS } from './constants';

interface SplitRowsProps {
  index: number;
  form: FormState;
  splitSum: number;
  splitMismatch: boolean;
  onSplitChange: (splitIdx: number, field: string, value: string | number) => void;
  onAddSplitRow: () => void;
  onRemoveSplitRow: (splitIdx: number) => void;
  onAutoFillLastSplit: () => void;
  onDisableSplit: () => void;
}

const SplitRows: React.FC<SplitRowsProps> = ({
  form,
  splitSum,
  splitMismatch,
  onSplitChange,
  onAddSplitRow,
  onRemoveSplitRow,
  onAutoFillLastSplit,
  onDisableSplit,
}) => {
  return (
    <div className="mt-4 pt-4 border-t border-gray-200">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-md font-semibold text-gray-700">分割入力</h3>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onAutoFillLastSplit}
            className="text-sm bg-gray-200 text-gray-700 px-3 py-1 rounded hover:bg-gray-300"
          >
            残額を自動按分
          </button>
          <button
            type="button"
            onClick={onDisableSplit}
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
                  onChange={(e) => onSplitChange(splitIdx, 'amount', e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-2 py-1 text-sm"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-gray-500 mb-1">科目</label>
                <select
                  value={split.category}
                  onChange={(e) => onSplitChange(splitIdx, 'category', e.target.value)}
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
                  onChange={(e) => onSplitChange(splitIdx, 'tax_code', e.target.value)}
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
                  onChange={(e) => onSplitChange(splitIdx, 'description', e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-2 py-1 text-sm"
                />
              </div>
              <div className="col-span-1 flex justify-end">
                <button
                  type="button"
                  onClick={() => onRemoveSplitRow(splitIdx)}
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
        onClick={onAddSplitRow}
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
  );
};

export default SplitRows;
