// receipt-scanner ダッシュボード モバイル用カード
// DashboardPage.tsx の renderMobileCard を純粋な関数コンポーネントへ切り出し
// （Loop 4 / Engineer C）

import React from 'react';
import type { Receipt, ReceiptResult } from '../../types/receipt';
import { SECTIONS, formatYen } from './constants';
import { CategoryCell, EditableCell, StatusBadge } from './cells';

export interface ReceiptMobileCardProps {
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

const ReceiptMobileCardImpl: React.FC<ReceiptMobileCardProps> = ({
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
    <div key={r.id} className={[
      'backdrop-blur-sm rounded-xl shadow-md p-4 transition',
      isEditing
        ? 'bg-white/80 ring-2 ring-indigo-300'
        : isError
          ? 'bg-red-50/80 border border-red-300 shadow-red-100'
          : 'bg-white/80',
    ].join(' ')}
      onClick={() => isSplit && toggleExpand(r.id)}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => toggleSelect(r.id)}
            onClick={(e) => e.stopPropagation()}
            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          <StatusBadge status={r.status} />
          {!!r.freee_sent_at && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800"
              title={`送信日時: ${r.freee_sent_at}${r.freee_deal_id ? ` / 取引ID: ${r.freee_deal_id}` : ''}`}
            >
              送信済み
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canEdit && !isEditing && (
            <button
              onClick={(e) => { e.stopPropagation(); isSplit ? openSplitModal(r) : startEdit(r); }}
              className="text-indigo-600 text-xs font-medium"
            >
              編集
            </button>
          )}
          {isEditing && (
            <>
              <button onClick={saveEdit} className="text-green-600 text-xs font-medium">保存</button>
              <button onClick={cancelEdit} className="text-gray-500 text-xs font-medium">取消</button>
            </>
          )}
          {r.image_url && (
            <button
              onClick={(e) => { e.stopPropagation(); setPreviewUrl(r.image_url); }}
              className="w-10 h-10 rounded-lg overflow-hidden border border-gray-200"
            >
              <img loading="lazy" decoding="async" src={r.image_url} alt="receipt" className="w-full h-full object-cover" />
            </button>
          )}
        </div>
      </div>

      {(r.status === 'pending' || r.status === 'processing') ? (
        <p className="text-gray-400 italic text-sm">解析中...</p>
      ) : r.status === 'error' && !r.result_json ? (
        <p className="text-red-600 font-semibold text-sm">{r.error_message || '読取失敗'}</p>
      ) : r.status === 'error' && r.result_json ? (
        <>
          <p className="text-red-600 font-semibold text-xs mb-2">{r.error_message || 'エラー'}</p>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-gray-400 text-xs">日付</span>
              <div>
                <EditableCell
                  value={result?.date || '-'}
                  field="date"
                  isEditing={isEditing}
                  editDraft={editDraft}
                  setEditDraft={setEditDraft}
                />
              </div>
            </div>
            <div>
              <span className="text-gray-400 text-xs">店名</span>
              <div>
                <EditableCell
                  value={result?.store || '-'}
                  field="store"
                  isEditing={isEditing}
                  editDraft={editDraft}
                  setEditDraft={setEditDraft}
                />
              </div>
            </div>
            <div>
              <span className="text-gray-400 text-xs">金額</span>
              <div>
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
                  : <span className="font-medium text-gray-700">{result?.amount != null ? formatYen(result.amount) : '-'}</span>
                }
              </div>
            </div>
            <div>
              <span className="text-gray-400 text-xs">勘定科目</span>
              <div>
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
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <span className="text-gray-400 text-xs">日付</span>
            <div>
              <EditableCell
                value={result?.date || '-'}
                field="date"
                isEditing={isEditing}
                editDraft={editDraft}
                setEditDraft={setEditDraft}
              />
            </div>
          </div>
          <div>
            <span className="text-gray-400 text-xs">店名</span>
            <div>
              <EditableCell
                value={result?.store || '-'}
                field="store"
                isEditing={isEditing}
                editDraft={editDraft}
                setEditDraft={setEditDraft}
              />
            </div>
          </div>
          <div>
            <span className="text-gray-400 text-xs">金額</span>
            <div>
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
                : <span className="font-medium text-gray-700">{result?.amount != null ? formatYen(result.amount) : '-'}</span>
              }
            </div>
          </div>
          <div>
            <span className="text-gray-400 text-xs">勘定科目</span>
            <div>
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
            </div>
          </div>
          <div className="col-span-2">
            <span className="text-gray-400 text-xs">部門</span>
            <div>
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
            </div>
          </div>
        </div>
      )}

      {isSplit && isExpanded && (
        <div className="mt-3 pt-3 border-t border-gray-200">
          <div className="text-xs text-gray-500 mb-1">分割内訳</div>
          <div className="space-y-1">
            {r.result_json!.splits!.map((s, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <div className="flex-1 min-w-0">
                  <div className="truncate">{s.category} <span className="text-xs text-gray-400">{s.tax_code === 137 ? '8軽' : '10%'}</span></div>
                  {s.description && <div className="text-xs text-gray-500 truncate">{s.description}</div>}
                </div>
                <div className="tabular-nums text-right ml-2">¥{s.amount.toLocaleString()}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-xs">
            {(() => {
              const sum = r.result_json!.splits!.reduce((a, s) => a + (Number(s.amount) || 0), 0);
              const amt = r.result_json!.amount;
              return sum === amt
                ? <span className="text-gray-500">合計: ¥{sum.toLocaleString()} (一致 ✓)</span>
                : <span className="text-red-600 font-semibold">差額 ¥{(amt - sum).toLocaleString()}</span>;
            })()}
          </div>
        </div>
      )}
    </div>
  );
};

ReceiptMobileCardImpl.displayName = 'ReceiptMobileCard';
export const ReceiptMobileCard = React.memo(ReceiptMobileCardImpl);
