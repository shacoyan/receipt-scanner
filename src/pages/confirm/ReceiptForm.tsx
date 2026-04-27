import React from 'react';
import type { FormState } from './useConfirmForms';
import { CATEGORIES, TAX_OPTIONS } from './constants';
import SplitRows from './SplitRows';

interface ReceiptFormProps {
  index: number;
  form: FormState;
  total: number;
  onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void;
  onToggleSplit: () => void;
  onDisableSplit: () => void;
  onSplitChange: (splitIdx: number, field: string, value: string | number) => void;
  onAddSplitRow: () => void;
  onRemoveSplitRow: (splitIdx: number) => void;
  onAutoFillLastSplit: () => void;
}

const ReceiptForm: React.FC<ReceiptFormProps> = ({
  index,
  form,
  total,
  onChange,
  onToggleSplit,
  onDisableSplit,
  onSplitChange,
  onAddSplitRow,
  onRemoveSplitRow,
  onAutoFillLastSplit,
}) => {
  const splitSum = form.splits.reduce((acc, s) => acc + Number(s.amount), 0);
  const splitMismatch = form.splitMode && form.splits.length >= 2 && splitSum !== form.amount;

  return (
    <div className="bg-white rounded-xl shadow-md p-8">
      <h2 className="text-lg font-semibold text-gray-800 mb-5">
        レシート {index + 1} / 合計{total}
      </h2>

      <div className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">日付</label>
          <input
            type="date"
            name="date"
            value={form.date}
            onChange={onChange}
            className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">金額</label>
          <input
            type="number"
            name="amount"
            value={form.amount}
            onChange={onChange}
            className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">店舗</label>
          <input
            type="text"
            name="store"
            value={form.store}
            onChange={onChange}
            className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">カテゴリ</label>
          <select
            name="category"
            value={form.category}
            onChange={onChange}
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
            onChange={onChange}
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
            onClick={onToggleSplit}
            className="mt-2 text-sm text-indigo-600 hover:text-indigo-800 underline"
          >
            分割する
          </button>
        ) : (
          <SplitRows
            index={index}
            form={form}
            splitSum={splitSum}
            splitMismatch={splitMismatch}
            onSplitChange={onSplitChange}
            onAddSplitRow={onAddSplitRow}
            onRemoveSplitRow={onRemoveSplitRow}
            onAutoFillLastSplit={onAutoFillLastSplit}
            onDisableSplit={onDisableSplit}
          />
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">メモ</label>
          <textarea
            name="memo"
            value={form.memo}
            onChange={onChange}
            rows={3}
            className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>
      </div>
    </div>
  );
};

export default ReceiptForm;
