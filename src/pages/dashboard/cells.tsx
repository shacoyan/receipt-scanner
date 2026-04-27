// receipt-scanner ダッシュボード 共通セル系コンポーネント
// DashboardPage.tsx の renderStatusBadge / renderTaxBadge / renderEditableCell / renderCategoryCell
// を純粋な関数コンポーネントへ切り出し（Loop 4 / Engineer C）

import React from 'react';
import type { Receipt, ReceiptResult } from '../../types/receipt';
import { CATEGORIES, STATUS_BADGE } from './constants';

// ─── StatusBadge ──────────────────────────────────────────────────────────
export const StatusBadge: React.FC<{ status: Receipt['status'] }> = ({ status }) => {
  const badge = STATUS_BADGE[status];
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${badge.bg}`}>
      {badge.label}
    </span>
  );
};

// ─── TaxBadge ─────────────────────────────────────────────────────────────
export const TaxBadge: React.FC<{ taxCode?: number | null }> = ({ taxCode }) => {
  if (taxCode == null) return null;
  // 137 = 8%軽減 (8軽)、136 = 10%標準
  const label = taxCode === 137 ? '8%軽減' : '10%';
  return <span className="ml-1 text-xs text-gray-400">{label}</span>;
};

// ─── EditableCell ─────────────────────────────────────────────────────────
export interface EditableCellProps {
  value: string;
  field: keyof ReceiptResult;
  isEditing: boolean;
  editDraft: ReceiptResult | null;
  setEditDraft: (d: ReceiptResult) => void;
}

export const EditableCell: React.FC<EditableCellProps> = ({
  value,
  field,
  isEditing,
  editDraft,
  setEditDraft,
}) => {
  if (!isEditing || !editDraft) {
    return <span className="text-gray-700">{value || '-'}</span>;
  }

  if (field === 'category') {
    return (
      <select
        value={editDraft.category}
        onChange={(e) => setEditDraft({ ...editDraft, category: e.target.value })}
        className="w-full border border-indigo-300 rounded px-2 py-1 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
      >
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
    );
  }

  if (field === 'amount') {
    return (
      <input
        type="number"
        value={editDraft.amount}
        onChange={(e) => setEditDraft({ ...editDraft, amount: Number(e.target.value) })}
        className="w-20 border border-indigo-300 rounded px-2 py-1 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
      />
    );
  }

  return (
    <input
      type={field === 'date' ? 'date' : 'text'}
      value={editDraft[field] as string}
      onChange={(e) => setEditDraft({ ...editDraft, [field]: e.target.value })}
      className="w-full border border-indigo-300 rounded px-2 py-1 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
    />
  );
};

// ─── CategoryCell ─────────────────────────────────────────────────────────
export interface CategoryCellProps {
  receipt: Receipt;
  isEditing: boolean;
  result: ReceiptResult | null;
  isSplit: boolean;
  expandedIds: Set<string>;
  toggleExpand: (id: string) => void;
  editDraft: ReceiptResult | null;
  setEditDraft: (d: ReceiptResult) => void;
}

export const CategoryCell: React.FC<CategoryCellProps> = ({
  receipt,
  isEditing,
  result,
  isSplit,
  expandedIds,
  toggleExpand,
  editDraft,
  setEditDraft,
}) => {
  const splits = receipt.result_json?.splits;
  if (splits && splits.length >= 2) {
    const tooltip = splits
      .map((s) => `${s.category}: ¥${(s.amount ?? 0).toLocaleString()}`)
      .join(' / ');
    const main = splits.reduce((m, s) => ((s.amount ?? 0) > (m.amount ?? 0) ? s : m), splits[0]);
    const rest = splits.length - 1;
    return (
      <span className="inline-flex items-center">
        <span className="text-gray-700" title={tooltip}>{main.category}</span>
        {rest > 0 && <span className="text-gray-400 text-xs ml-1">他{rest}件</span>}
        {isSplit && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleExpand(receipt.id); }}
            className="ml-1 text-xs text-indigo-600 hover:text-indigo-800"
          >
            分割{splits.length}件 {expandedIds.has(receipt.id) ? '▾' : '▸'}
          </button>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center">
      <EditableCell
        value={result?.category || '-'}
        field="category"
        isEditing={isEditing}
        editDraft={editDraft}
        setEditDraft={setEditDraft}
      />
      {!isEditing && <TaxBadge taxCode={result?.tax_code} />}
    </span>
  );
};
