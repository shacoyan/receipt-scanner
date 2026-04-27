// receipt-scanner ダッシュボード デスクトップ table 行
// DashboardPage.tsx の renderTableRow を純粋な関数コンポーネントへ切り出し
// （Loop 4 / Engineer C）

import React from 'react';
import type { Receipt, ReceiptResult } from '../../types/receipt';
import { SECTIONS, formatYen } from './constants';
import { CategoryCell, EditableCell, StatusBadge } from './cells';

export interface ReceiptTableRowProps {
  receipt: Receipt;
  // 編集
  isEditing: boolean;
  editDraft: ReceiptResult | null;
  editSectionId: string | null;
  setEditDraft: (d: ReceiptResult) => void;
  setEditSectionId: (s: string | null) => void;
  startEdit: (r: Receipt) => void;
  cancelEdit: () => void;
  saveEdit: () => Promise<void>;
  // 選択
  isSelected: boolean;
  toggleSelect: (id: string) => void;
  // 展開
  isExpanded: boolean;
  toggleExpand: (id: string) => void;
  // モーダル
  openSplitModal: (r: Receipt) => void;
  setPreviewUrl: (u: string | null) => void;
}

const ReceiptTableRowImpl: React.FC<ReceiptTableRowProps> = ({
  receipt: r,
  isEditing,
  editDraft,
  editSectionId,
  setEditDraft,
  setEditSectionId,
  startEdit,
  cancelEdit,
  saveEdit,
  isSelected,
  toggleSelect,
  isExpanded,
  toggleExpand,
  openSplitModal,
  setPreviewUrl,
}) => {
  const isError = r.status === 'error';
  const result = isEditing && editDraft ? editDraft : r.result_json;
  const canEdit = (r.status === 'done' || r.status === 'error') && !!r.result_json;
  const isSplit = !!(r.result_json?.splits && r.result_json.splits.length >= 2);


  return (
    <React.Fragment key={r.id}>
      <tr
        className={[
          'border-b transition',
          isEditing
            ? 'bg-indigo-50/50 border-gray-100'
            : isError
              ? 'bg-red-50/60 border-red-200 hover:bg-red-50'
              : 'border-gray-100 hover:bg-indigo-50/30',
          isSplit ? 'cursor-pointer' : '',
        ].join(' ')}
        onClick={() => isSplit && toggleExpand(r.id)}
      >
        {/* Checkbox */}
        <td className="px-3 py-3">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => toggleSelect(r.id)}
            onClick={(e) => e.stopPropagation()}
            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
        </td>

        {/* Status */}
        <td className="px-3 py-3">
          <StatusBadge status={r.status} />
          {!!r.freee_sent_at && (
            <span
              className="ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800"
              title={`送信日時: ${r.freee_sent_at}${r.freee_deal_id ? ` / 取引ID: ${r.freee_deal_id}` : ''}`}
            >
              送信済み
            </span>
          )}
        </td>

        {/* Date */}
        <td className="px-3 py-3 text-sm">
          <EditableCell
            value={result?.date || '-'}
            field="date"
            isEditing={isEditing}
            editDraft={editDraft}
            setEditDraft={setEditDraft}
          />
        </td>

        {/* Store */}
        <td className="px-3 py-3 text-sm">
          <EditableCell
            value={result?.store || '-'}
            field="store"
            isEditing={isEditing}
            editDraft={editDraft}
            setEditDraft={setEditDraft}
          />
          {isError && r.error_message && (
            <p className="mt-1 text-xs text-red-600 font-semibold truncate max-w-[220px]" title={r.error_message}>
              {r.error_message}
            </p>
          )}
        </td>

        {/* Amount */}
        <td className="px-3 py-3 text-sm font-medium">
          {isEditing
            ? (
              <EditableCell
                value={String(result?.amount ?? '')}
                field="amount"
                isEditing={true}
                editDraft={editDraft}
                setEditDraft={setEditDraft}
              />
            )
            : <span className="text-gray-700">{result?.amount != null ? formatYen(result.amount) : '-'}</span>
          }
        </td>

        {/* Category */}
        <td className="px-3 py-3 text-sm">
          <CategoryCell
            receipt={r}
            isEditing={isEditing}
            result={result}
            isSplit={isSplit}
            isExpanded={isExpanded}
            toggleExpand={toggleExpand}
            editDraft={editDraft}
            setEditDraft={setEditDraft}
          />
        </td>

        {/* Section */}
        <td className="px-3 py-3 text-sm">
          {isEditing ? (
            <select
              value={editSectionId || ''}
              onChange={(e) => setEditSectionId(e.target.value || null)}
              className="w-full border border-indigo-300 rounded px-2 py-1 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
            >
              <option value="">未設定</option>
              {SECTIONS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          ) : (
            <span className="text-gray-700">{r.section_id || '-'}</span>
          )}
        </td>

        {/* Actions (edit) */}
        <td className="px-3 py-3 text-sm">
          {canEdit && r.result_json && !isEditing && (
            <button
              onClick={(e) => { e.stopPropagation(); isSplit ? openSplitModal(r) : startEdit(r); }}
              className="text-indigo-600 hover:text-indigo-800 text-xs font-medium"
            >
              編集
            </button>
          )}
          {isEditing && (
            <div className="flex gap-1">
              <button
                onClick={saveEdit}
                className="text-green-600 hover:text-green-800 text-xs font-medium"
              >
                保存
              </button>
              <button
                onClick={cancelEdit}
                className="text-gray-500 hover:text-gray-700 text-xs font-medium"
              >
                取消
              </button>
            </div>
          )}
        </td>

        {/* Image thumbnail */}
        <td className="px-3 py-3">
          {r.image_url && (
            <button
              onClick={(e) => { e.stopPropagation(); setPreviewUrl(r.image_url); }}
              className="w-10 h-10 rounded-lg overflow-hidden border border-gray-200 hover:border-indigo-400 transition flex-shrink-0"
            >
              <img loading="lazy" decoding="async" src={r.image_url} alt="receipt" className="w-full h-full object-cover" />
            </button>
          )}
        </td>
      </tr>
      {isSplit && isExpanded && (
        <tr className="bg-indigo-50/30">
          <td colSpan={9} className="px-8 py-2">
            <div className="text-xs text-gray-500 mb-1">分割内訳</div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-xs text-left">
                  <th className="py-1 font-normal w-40">勘定科目</th>
                  <th className="py-1 font-normal w-28 text-right">金額</th>
                  <th className="py-1 font-normal w-20">税区分</th>
                  <th className="py-1 font-normal">説明</th>
                </tr>
              </thead>
              <tbody>
                {r.result_json!.splits!.map((s, i) => (
                  <tr key={i} className="border-t border-indigo-100">
                    <td className="py-1">{s.category}</td>
                    <td className="py-1 text-right tabular-nums">¥{s.amount.toLocaleString()}</td>
                    <td className="py-1">{s.tax_code === 137 ? '8軽' : '10%'}</td>
                    <td className="py-1 text-gray-600">{s.description || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-1 text-xs">
              {(() => {
                const sum = r.result_json!.splits!.reduce((a, s) => a + (Number(s.amount) || 0), 0);
                const amt = r.result_json!.amount;
                return sum === amt
                  ? <span className="text-gray-500">合計: ¥{sum.toLocaleString()} (一致 ✓)</span>
                  : <span className="text-red-600 font-semibold">合計: ¥{sum.toLocaleString()} / 総額 ¥{amt.toLocaleString()} (差額 ¥{(amt - sum).toLocaleString()})</span>;
              })()}
            </div>
          </td>
        </tr>
      )}
    </React.Fragment>
  );
};

ReceiptTableRowImpl.displayName = 'ReceiptTableRow';
export const ReceiptTableRow = React.memo(ReceiptTableRowImpl);
