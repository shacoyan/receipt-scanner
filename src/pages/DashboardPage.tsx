import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import SplitEditModal from '../components/SplitEditModal';

// ─── Types ────────────────────────────────────────────────────────────────────
type ReceiptStatus = 'pending' | 'processing' | 'done' | 'approved' | 'error';

interface ReceiptResult {
  date: string;
  amount: number;
  store: string;
  category: string;
  tax_code?: number | null;
  splits?: Array<{
    category: string;
    amount: number;
    tax_code: number;
    description?: string;
  }> | null;
}

interface Receipt {
  id: string;
  image_url: string;
  status: ReceiptStatus;
  result_json: ReceiptResult | null;
  error_message: string | null;
  section_id: string | null;
  created_at: string;
  freee_sent_at: string | null;
  freee_deal_id: string | null;
}

interface ReceiptsResponse {
  data: Receipt[];
  total: number;
  page: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const CATEGORIES = ['消耗品費', '交通費', '接待交際費', '会議費', '通信費', '雑費', '仕入高'];
const SECTIONS = ['スーク', '金魚', 'KITUNE', 'Goodbye', 'LR', '狛犬', 'moumou', 'SABABA HQ', '大輝HQ'];
const PAGE_LIMIT = 50;
const AUTO_REFRESH_MS = 10_000;

type TabKey = 'all' | 'analyzing' | 'done' | 'approved' | 'sent' | 'error';

const TABS: { key: TabKey; label: string; statuses: ReceiptStatus[] | null; sent: boolean | null }[] = [
  { key: 'all', label: '全て', statuses: null, sent: null },
  { key: 'analyzing', label: '解析中', statuses: ['pending', 'processing'], sent: null },
  { key: 'done', label: '解析済み', statuses: ['done'], sent: null },
  { key: 'approved', label: '承認済み', statuses: ['approved'], sent: false },
  { key: 'sent', label: '送信済み', statuses: ['approved'], sent: true },
  { key: 'error', label: 'エラー', statuses: ['error'], sent: null },
];

const STATUS_BADGE: Record<ReceiptStatus, { bg: string; text: string; label: string }> = {
  pending: { bg: 'bg-gray-100 text-gray-700', text: 'text-gray-500', label: '待機中' },
  processing: { bg: 'bg-yellow-100 text-yellow-800', text: 'text-yellow-600', label: '解析中' },
  done: { bg: 'bg-blue-100 text-blue-800', text: 'text-blue-600', label: '解析済み' },
  approved: { bg: 'bg-green-100 text-green-800', text: 'text-green-600', label: '承認済み' },
  error: { bg: 'bg-red-100 text-red-800', text: 'text-red-600', label: 'エラー' },
};

// ─── Helper ───────────────────────────────────────────────────────────────────
const formatYen = (n: number) =>
  `¥${n.toLocaleString('ja-JP')}`;

// ─── Component ────────────────────────────────────────────────────────────────
const DashboardPage: React.FC = () => {
  const navigate = useNavigate();

  // Data state
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [tabCounts, setTabCounts] = useState<Record<TabKey, number>>({
    all: 0, analyzing: 0, done: 0, approved: 0, sent: 0, error: 0,
  });

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Inline editing
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ReceiptResult | null>(null);
  const [editSectionId, setEditSectionId] = useState<string | null>(null);

  // Image preview modal
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Split editing
  const [splitModalReceipt, setSplitModalReceipt] = useState<Receipt | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Loading / sending
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Fetch ────────────────────────────────────────────────────────────────
  const statusQueryParam = useCallback((): string => {
    const tab = TABS.find((t) => t.key === activeTab);
    if (!tab) return '';
    const parts: string[] = [];
    if (tab.statuses) parts.push(...tab.statuses.map((s) => `status=${s}`));
    if (tab.sent === true) parts.push('sent=true');
    if (tab.sent === false) parts.push('sent=false');
    return parts.join('&');
  }, [activeTab]);

  const fetchReceipts = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const statusParam = statusQueryParam();
      const url = `/api/receipts?${statusParam ? statusParam + '&' : ''}page=${page}&limit=${PAGE_LIMIT}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('fetch failed');
      const json: ReceiptsResponse = await res.json();
      setReceipts(json.data);
      setTotal(json.total);
    } catch {
      // silently ignore for auto-refresh
    } finally {
      if (!silent) setLoading(false);
    }
  }, [page, statusQueryParam]);

  const fetchTabCounts = useCallback(async () => {
    try {
      const res = await fetch('/api/receipts?page=1&limit=1');
      if (!res.ok) return;
      const allJson: ReceiptsResponse = await res.json();

      const countFor = async (statuses: ReceiptStatus[], opts?: { sent?: boolean }): Promise<number> => {
        const parts: string[] = statuses.map((s) => `status=${s}`);
        if (opts?.sent === true) parts.push('sent=true');
        if (opts?.sent === false) parts.push('sent=false');
        const q = parts.join('&');
        const r = await fetch(`/api/receipts?${q}&page=1&limit=1`);
        if (!r.ok) return 0;
        const j: ReceiptsResponse = await r.json();
        return j.total;
      };

      const [analyzing, doneCnt, approvedUnsent, sent, errorCnt] = await Promise.all([
        countFor(['pending', 'processing']),
        countFor(['done']),
        countFor(['approved'], { sent: false }),
        countFor(['approved'], { sent: true }),
        countFor(['error']),
      ]);

      setTabCounts({
        all: allJson.total,
        analyzing,
        done: doneCnt,
        approved: approvedUnsent,
        sent,
        error: errorCnt,
      });
    } catch {
      // ignore
    }
  }, []);

  // Initial + tab/page change
  useEffect(() => {
    fetchReceipts();
    fetchTabCounts();
  }, [fetchReceipts, fetchTabCounts]);

  // Auto refresh
  useEffect(() => {
    timerRef.current = setInterval(() => {
      fetchReceipts(true);
      fetchTabCounts();
    }, AUTO_REFRESH_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchReceipts, fetchTabCounts]);

  // Reset page on tab change
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
    setEditingId(null);
  }, [activeTab]);

  // Reset expanded on tab/page change
  useEffect(() => { setExpandedIds(new Set()); }, [activeTab, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));

  // ─── Selection helpers ────────────────────────────────────────────────────
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === receipts.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(receipts.map((r) => r.id)));
    }
  };

  // ─── Expand / Split Modal helpers ─────────────────────────────────────────
  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const openSplitModal = (r: Receipt) => {
    setSplitModalReceipt(r);
  };

  // ─── Inline edit ──────────────────────────────────────────────────────────
  const startEdit = (r: Receipt) => {
    if ((r.status !== 'done' && r.status !== 'error') || !r.result_json) return;
    setEditingId(r.id);
    setEditDraft({ ...r.result_json });
    setEditSectionId(r.section_id || null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft(null);
    setEditSectionId(null);
  };

  const saveEdit = async () => {
    if (!editingId || !editDraft) return;
    try {
      const res = await fetch('/api/receipts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [editingId], action: 'update', data: editDraft, section_id: editSectionId }),
      });
      if (!res.ok) throw new Error();
      await fetchReceipts();
      await fetchTabCounts();
      cancelEdit();
    } catch {
      alert('保存に失敗しました');
    }
  };

  // ─── Bulk approve ─────────────────────────────────────────────────────────
  const approveSelected = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    try {
      const res = await fetch('/api/receipts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: 'approve' }),
      });
      if (!res.ok) throw new Error();
      setSelected(new Set());
      await fetchReceipts();
      await fetchTabCounts();
    } catch {
      alert('承認に失敗しました');
    }
  };

  // ─── Bulk delete ──────────────────────────────────────────────────────────
  const deleteSelected = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!window.confirm(`選択した${ids.length}件のレシートを削除しますか？\nこの操作は元に戻せません。`)) return;
    try {
      const res = await fetch('/api/receipts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error();
      setSelected(new Set());
      await fetchReceipts();
      await fetchTabCounts();
    } catch {
      alert('削除に失敗しました');
    }
  };

  // ─── Bulk unapprove ──────────────────────────────────────────────────────
  const unapproveSelected = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    try {
      const res = await fetch('/api/receipts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: 'unapprove' }),
      });
      if (!res.ok) throw new Error();
      setSelected(new Set());
      await fetchReceipts();
      await fetchTabCounts();
    } catch {
      alert('承認取消に失敗しました');
    }
  };

  // ─── Bulk rerun ──────────────────────────────────────────────────────────
  const rerunSelected = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!window.confirm(`選択中の${ids.length}件を再判定します。\n\n注意: すでにfreee登録済みのレシートも再判定対象に含まれる場合、再判定後に再度freee登録すると重複する可能性があります。\n\n続行しますか？`)) return;
    try {
      const res = await fetch('/api/receipts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: 'rerun' }),
      });
      if (!res.ok) throw new Error();
      setSelected(new Set());
      await fetchReceipts();
      await fetchTabCounts();
    } catch {
      alert('再判定に失敗しました');
    }
  };

  // ─── Send to freee ────────────────────────────────────────────────────────
  const sendToFreee = async () => {
    const targets = receipts.filter(
      (r) => r.status === 'approved' && r.result_json && !r.freee_sent_at
    );
    if (targets.length === 0) {
      alert('送信可能な承認済みレシートがありません');
      return;
    }
    setSending(true);
    let ok = 0;
    let ng = 0;
    const failMsgs: string[] = [];
    for (const r of targets) {
      try {
        const res = await fetch('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...r.result_json, receipt_id: r.id, section_id: r.section_id }),
        });
        if (res.ok) {
          ok++;
        } else {
          ng++;
          const err = await res.json().catch(() => ({}));
          failMsgs.push(`${r.result_json?.store || '不明'}: ${(err as {error?: string}).error || '送信失敗'}`);
        }
      } catch {
        ng++;
        failMsgs.push(`${r.result_json?.store || '不明'}: 通信エラー`);
      }
    }
    setSending(false);
    let msg = `freee送信完了: 成功 ${ok}件`;
    if (ng > 0) {
      msg += `\n失敗 ${ng}件:\n${failMsgs.join('\n')}`;
    }
    alert(msg);
    await fetchReceipts();
    await fetchTabCounts();
  };

  // ─── Render helpers ───────────────────────────────────────────────────────
  const renderStatusBadge = (status: ReceiptStatus) => {
    const badge = STATUS_BADGE[status];
    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${badge.bg}`}>
        {badge.label}
      </span>
    );
  };

  const renderTaxBadge = (taxCode?: number | null) => {
    if (taxCode == null) return null;
    // 137 = 8%軽減 (8軽)、136 = 10%標準
    const label = taxCode === 137 ? '8%軽減' : '10%';
    return <span className="ml-1 text-xs text-gray-400">{label}</span>;
  };

  const renderCategoryCell = (r: Receipt, isEditing: boolean, result: ReceiptResult | null, isSplit: boolean) => {
    const splits = r.result_json?.splits;
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
              onClick={(e) => { e.stopPropagation(); toggleExpand(r.id); }}
              className="ml-1 text-xs text-indigo-600 hover:text-indigo-800"
            >
              分割{splits.length}件 {expandedIds.has(r.id) ? '▾' : '▸'}
            </button>
          )}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center">
        {renderEditableCell(result?.category || '-', 'category', isEditing)}
        {!isEditing && renderTaxBadge(result?.tax_code)}
      </span>
    );
  };

  const renderEditableCell = (
    value: string,
    field: keyof ReceiptResult,
    isEditing: boolean,
  ) => {
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

  // ─── Desktop table row ────────────────────────────────────────────────────
  const renderTableRow = (r: Receipt) => {
    const isEditing = editingId === r.id;
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
              checked={selected.has(r.id)}
              onChange={() => toggleSelect(r.id)}
              onClick={(e) => e.stopPropagation()}
              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
          </td>

          {/* Status */}
          <td className="px-3 py-3">
            {renderStatusBadge(r.status)}
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
            {renderEditableCell(result?.date || '-', 'date', isEditing)}
          </td>

          {/* Store */}
          <td className="px-3 py-3 text-sm">
            {renderEditableCell(result?.store || '-', 'store', isEditing)}
            {isError && r.error_message && (
              <p className="mt-1 text-xs text-red-600 font-semibold truncate max-w-[220px]" title={r.error_message}>
                {r.error_message}
              </p>
            )}
          </td>

          {/* Amount */}
          <td className="px-3 py-3 text-sm font-medium">
            {isEditing
              ? renderEditableCell(String(result?.amount ?? ''), 'amount', true)
              : <span className="text-gray-700">{result?.amount != null ? formatYen(result.amount) : '-'}</span>
            }
          </td>

          {/* Category */}
          <td className="px-3 py-3 text-sm">
            {renderCategoryCell(r, isEditing, result, isSplit)}
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
                <img src={r.image_url} alt="receipt" className="w-full h-full object-cover" />
              </button>
            )}
          </td>
        </tr>
        {isSplit && expandedIds.has(r.id) && (
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

  // ─── Mobile card ──────────────────────────────────────────────────────────
  const renderMobileCard = (r: Receipt) => {
    const isEditing = editingId === r.id;
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
              checked={selected.has(r.id)}
              onChange={() => toggleSelect(r.id)}
              onClick={(e) => e.stopPropagation()}
              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            {renderStatusBadge(r.status)}
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
                <img src={r.image_url} alt="receipt" className="w-full h-full object-cover" />
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
                <div>{renderEditableCell(result?.date || '-', 'date', isEditing)}</div>
              </div>
              <div>
                <span className="text-gray-400 text-xs">店名</span>
                <div>{renderEditableCell(result?.store || '-', 'store', isEditing)}</div>
              </div>
              <div>
                <span className="text-gray-400 text-xs">金額</span>
                <div>
                  {isEditing
                    ? renderEditableCell(String(result?.amount ?? ''), 'amount', true)
                    : <span className="font-medium text-gray-700">{result?.amount != null ? formatYen(result.amount) : '-'}</span>
                  }
                </div>
              </div>
              <div>
                <span className="text-gray-400 text-xs">勘定科目</span>
                <div>{renderCategoryCell(r, isEditing, result, isSplit)}</div>
              </div>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-gray-400 text-xs">日付</span>
              <div>{renderEditableCell(result?.date || '-', 'date', isEditing)}</div>
            </div>
            <div>
              <span className="text-gray-400 text-xs">店名</span>
              <div>{renderEditableCell(result?.store || '-', 'store', isEditing)}</div>
            </div>
            <div>
              <span className="text-gray-400 text-xs">金額</span>
              <div>
                {isEditing
                  ? renderEditableCell(String(result?.amount ?? ''), 'amount', true)
                  : <span className="font-medium text-gray-700">{result?.amount != null ? formatYen(result.amount) : '-'}</span>
                }
              </div>
            </div>
            <div>
              <span className="text-gray-400 text-xs">勘定科目</span>
              <div>{renderCategoryCell(r, isEditing, result, isSplit)}</div>
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

        {isSplit && expandedIds.has(r.id) && (
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

  // ─── Main render ──────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50 py-6 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <span>🧾</span> レシート管理
          </h1>
          <button
            onClick={() => navigate('/')}
            className="text-sm bg-indigo-600 text-white rounded-md px-4 py-2 hover:bg-indigo-700 transition font-medium"
          >
            アップロードへ →
          </button>
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap gap-2 mb-4">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 rounded-full text-sm font-medium transition ${
                activeTab === tab.key
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'bg-white/80 text-gray-600 hover:bg-indigo-100'
              }`}
            >
              {tab.label}({tabCounts[tab.key]})
            </button>
          ))}
        </div>

        {/* Bulk actions */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <button
            onClick={approveSelected}
            disabled={selected.size === 0}
            className={`px-4 py-2 rounded-md text-sm font-medium transition ${
              selected.size > 0
                ? 'bg-green-600 text-white hover:bg-green-700 shadow-sm'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            選択した{selected.size}件を承認
          </button>
          <button
            onClick={deleteSelected}
            disabled={selected.size === 0}
            className={`px-4 py-2 rounded-md text-sm font-medium transition ${
              selected.size > 0
                ? 'bg-red-600 text-white hover:bg-red-700 shadow-sm'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            選択した{selected.size}件を削除
          </button>
          <button
            onClick={unapproveSelected}
            disabled={selected.size === 0}
            className={`px-4 py-2 rounded-md text-sm font-medium transition ${
              selected.size > 0
                ? 'bg-yellow-500 text-white hover:bg-yellow-600 shadow-sm'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            選択した{selected.size}件を解析済みに戻す
          </button>
          <button
            onClick={rerunSelected}
            disabled={selected.size === 0}
            className={`px-4 py-2 rounded-md text-sm font-medium transition ${
              selected.size > 0
                ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            選択した{selected.size}件を再判定
          </button>
          <div className="flex-1" />
          <button
            onClick={sendToFreee}
            disabled={sending || receipts.filter((r) => r.status === 'approved' && !r.freee_sent_at).length === 0}
            className="px-4 py-2 rounded-md text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? '送信中...' : '承認済みをfreeeに送信'}
          </button>
        </div>

        {/* Content card */}
        <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-xl overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
              <span className="ml-3 text-gray-500">読み込み中...</span>
            </div>
          ) : receipts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-400">
              <svg className="w-12 h-12 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p>レシートがありません</p>
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-gray-50/80 border-b border-gray-200">
                      <th className="px-3 py-3 text-left">
                        <input
                          type="checkbox"
                          checked={receipts.length > 0 && selected.size === receipts.length}
                          onChange={toggleSelectAll}
                          className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                        />
                      </th>
                      <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">ステータス</th>
                      <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">日付</th>
                      <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">店名</th>
                      <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">金額</th>
                      <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">勘定科目</th>
                      <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">部門</th>
                      <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider"></th>
                      <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">画像</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receipts.map(renderTableRow)}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="md:hidden p-4 space-y-3">
                {receipts.map(renderMobileCard)}
              </div>
            </>
          )}

          {/* Pagination */}
          {total > PAGE_LIMIT && (
            <div className="flex items-center justify-center gap-4 py-4 border-t border-gray-100">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                ← 前へ
              </button>
              <span className="text-sm text-gray-500">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                次へ →
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Image preview modal */}
      {previewUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setPreviewUrl(null)}
        >
          <div
            className="relative max-w-3xl max-h-[90vh] rounded-2xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setPreviewUrl(null)}
              className="absolute top-3 right-3 z-10 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70 transition"
            >
              ✕
            </button>
            <img src={previewUrl} alt="receipt preview" className="max-w-full max-h-[85vh] object-contain" />
          </div>
        </div>
      )}
      {splitModalReceipt && (
        <SplitEditModal
          receipt={splitModalReceipt as React.ComponentProps<typeof SplitEditModal>['receipt']}
          onClose={() => setSplitModalReceipt(null)}
          onSaved={async () => {
            setSplitModalReceipt(null);
            await fetchReceipts();
            await fetchTabCounts();
          }}
          categories={CATEGORIES}
          sections={SECTIONS}
        />
      )}
    </div>
  );
};

export default DashboardPage;
