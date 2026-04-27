import React from 'react';
import type { SplitItem } from '../../types/receipt';

interface SplitTableProps {
  splits: SplitItem[];
  categories: string[];
  onUpdateSplit: (i: number, patch: Partial<SplitItem>) => void;
  onAddRow: () => void;
  onRemoveRow: (i: number) => void;
}

const SplitTable: React.FC<SplitTableProps> = ({
  splits,
  categories,
  onUpdateSplit,
  onAddRow,
  onRemoveRow,
}) => {
  return (
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
                      onUpdateSplit(i, { category: e.target.value })
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
                      onUpdateSplit(i, { amount: Number(e.target.value) || 0 })
                    }
                    className="border border-gray-300 rounded-md px-2 py-1 text-sm w-full focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </td>
                <td className="px-2 py-2">
                  <select
                    value={s.tax_code}
                    onChange={(e) =>
                      onUpdateSplit(i, {
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
                      onUpdateSplit(i, { description: e.target.value })
                    }
                    className="border border-gray-300 rounded-md px-2 py-1 text-sm w-full focus:ring-indigo-500 focus:border-indigo-500"
                    placeholder="説明（任意）"
                  />
                </td>
                <td className="px-2 py-2 text-center">
                  <button
                    onClick={() => onRemoveRow(i)}
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
        onClick={onAddRow}
        className="self-start text-indigo-600 hover:text-indigo-700 text-sm font-medium mt-1"
      >
        ＋ 行を追加
      </button>
    </div>
  );
};

export default SplitTable;
