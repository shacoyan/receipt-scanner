import { useCallback, useState } from 'react';
import type { Receipt, ReceiptResult } from '../../types/receipt';

export interface UseBulkActionsParams {
  receipts: Receipt[];
  onMutate: () => Promise<void>;
}

export interface UseBulkActionsResult {
  // Selection
  selected: Set<string>;
  toggleSelect: (id: string) => void;
  toggleSelectAll: () => void;
  clearSelection: () => void;

  // Inline edit
  editingId: string | null;
  editDraft: ReceiptResult | null;
  editSectionId: string | null;
  setEditDraft: (d: ReceiptResult | null) => void;
  setEditSectionId: (s: string | null) => void;
  startEdit: (r: Receipt) => void;
  cancelEdit: () => void;
  saveEdit: () => Promise<void>;

  // Bulk
  approveSelected: () => Promise<void>;
  deleteSelected: () => Promise<void>;
  unapproveSelected: () => Promise<void>;
  rerunSelected: () => Promise<void>;

  // freee
  sending: boolean;
  sendToFreee: () => Promise<void>;

  // Expand
  expandedIds: Set<string>;
  toggleExpand: (id: string) => void;
  resetExpanded: () => void;

  // Image preview
  previewUrl: string | null;
  setPreviewUrl: (u: string | null) => void;

  // Split modal
  splitModalReceipt: Receipt | null;
  openSplitModal: (r: Receipt) => void;
  closeSplitModal: () => void;
}

export function useBulkActions(params: UseBulkActionsParams): UseBulkActionsResult {
  const { receipts, onMutate } = params;

  // ─── State ────────────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ReceiptResult | null>(null);
  const [editSectionId, setEditSectionId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [splitModalReceipt, setSplitModalReceipt] = useState<Receipt | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  // ─── Selection helpers ────────────────────────────────────────────────────
  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      if (prev.size === receipts.length) {
        return new Set();
      }
      return new Set(receipts.map((r) => r.id));
    });
  }, [receipts]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
  }, []);

  // ─── Expand / Split Modal helpers ─────────────────────────────────────────
  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const resetExpanded = useCallback(() => {
    setExpandedIds(new Set());
  }, []);

  const openSplitModal = useCallback((r: Receipt) => {
    setSplitModalReceipt(r);
  }, []);

  const closeSplitModal = useCallback(() => {
    setSplitModalReceipt(null);
  }, []);

  // ─── Inline edit ──────────────────────────────────────────────────────────
  const startEdit = useCallback((r: Receipt) => {
    if ((r.status !== 'done' && r.status !== 'error') || !r.result_json) return;
    setEditingId(r.id);
    setEditDraft({ ...r.result_json });
    setEditSectionId(r.section_id || null);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditDraft(null);
    setEditSectionId(null);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingId || !editDraft) return;
    try {
      const res = await fetch('/api/receipts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [editingId], action: 'update', data: editDraft, section_id: editSectionId }),
      });
      if (!res.ok) throw new Error();
      await onMutate();
      setEditingId(null);
      setEditDraft(null);
      setEditSectionId(null);
    } catch {
      alert('保存に失敗しました');
    }
  }, [editingId, editDraft, editSectionId, onMutate]);

  // ─── Bulk approve ─────────────────────────────────────────────────────────
  const approveSelected = useCallback(async () => {
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
      await onMutate();
    } catch {
      alert('承認に失敗しました');
    }
  }, [selected, onMutate]);

  // ─── Bulk delete ──────────────────────────────────────────────────────────
  const deleteSelected = useCallback(async () => {
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
      await onMutate();
    } catch {
      alert('削除に失敗しました');
    }
  }, [selected, onMutate]);

  // ─── Bulk unapprove ──────────────────────────────────────────────────────
  const unapproveSelected = useCallback(async () => {
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
      await onMutate();
    } catch {
      alert('承認取消に失敗しました');
    }
  }, [selected, onMutate]);

  // ─── Bulk rerun ──────────────────────────────────────────────────────────
  const rerunSelected = useCallback(async () => {
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
      await onMutate();
    } catch {
      alert('再判定に失敗しました');
    }
  }, [selected, onMutate]);

  // ─── Send to freee ────────────────────────────────────────────────────────
  const sendToFreee = useCallback(async () => {
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
          failMsgs.push(`${r.result_json?.store || '不明'}: ${(err as { error?: string }).error || '送信失敗'}`);
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
    await onMutate();
  }, [receipts, onMutate]);

  return {
    selected,
    toggleSelect,
    toggleSelectAll,
    clearSelection,

    editingId,
    editDraft,
    editSectionId,
    setEditDraft,
    setEditSectionId,
    startEdit,
    cancelEdit,
    saveEdit,

    approveSelected,
    deleteSelected,
    unapproveSelected,
    rerunSelected,

    sending,
    sendToFreee,

    expandedIds,
    toggleExpand,
    resetExpanded,

    previewUrl,
    setPreviewUrl,

    splitModalReceipt,
    openSplitModal,
    closeSplitModal,
  };
}
