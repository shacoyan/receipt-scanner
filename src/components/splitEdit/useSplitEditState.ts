import { useState, useEffect, useMemo, useCallback } from 'react';
import type { SplitItem, SplitEditTarget } from '../../types/receipt';

export interface SplitEditState {
  date: string;
  setDate: (v: string) => void;
  store: string;
  setStore: (v: string) => void;
  sectionId: string;
  setSectionId: (v: string) => void;
  splits: SplitItem[];
  totalAmount: number;
  setTotalAmount: (v: number) => void;
  saving: boolean;
  releasing: boolean;
  error: string | null;
  sum: number;
  diff: number;
  isMatched: boolean;
  canSave: boolean;
  hasUnsavedChanges: boolean;
  updateSplit: (i: number, patch: Partial<SplitItem>) => void;
  addRow: () => void;
  removeRow: (i: number) => void;
  handleSave: () => Promise<void>;
  handleRelease: () => Promise<void>;
  handleClose: () => void;
}

export function useSplitEditState(
  receipt: SplitEditTarget,
  categories: string[],
  onClose: () => void,
  onSaved: () => void | Promise<void>,
): SplitEditState {
  const [date, setDate] = useState(receipt.result_json?.date ?? '');
  const [store, setStore] = useState(receipt.result_json?.store ?? '');
  const [sectionId, setSectionId] = useState<string>(receipt.section_id ?? '');
  const [splits, setSplits] = useState<SplitItem[]>(
    (receipt.result_json?.splits as SplitItem[] | undefined) ?? []
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalAmount, setTotalAmount] = useState(receipt.result_json?.amount ?? 0);
  const [releasing, setReleasing] = useState(false);

  const sum = splits.reduce((a, s) => a + (Number(s.amount) || 0), 0);
  const diff = totalAmount - sum;
  const isMatched = diff === 0 && splits.length >= 2;

  const canSave = useMemo(() => {
    if (!Number.isInteger(totalAmount) || totalAmount <= 0) return false;
    if (!isMatched) return false;
    if (date === '') return false;
    if (store === '') return false;
    if (splits.length === 0) return false;
    return splits.every((s) => {
      if (!categories.includes(s.category)) return false;
      if (!Number.isInteger(s.amount) || s.amount <= 0) return false;
      if (s.tax_code !== 136 && s.tax_code !== 137) return false;
      if (s.description !== undefined && s.description.length > 200) return false;
      return true;
    });
  }, [isMatched, date, store, splits, categories, totalAmount]);

  const initialSnapshot = useMemo(() => {
    return JSON.stringify({
      date: receipt.result_json?.date ?? '',
      store: receipt.result_json?.store ?? '',
      sectionId: receipt.section_id ?? '',
      amount: receipt.result_json?.amount ?? 0,
      splits: receipt.result_json?.splits ?? [],
    });
  }, [receipt]);

  const hasUnsavedChanges = useMemo(() => {
    const current = JSON.stringify({ date, store, sectionId, amount: totalAmount, splits });
    return current !== initialSnapshot;
  }, [date, store, sectionId, splits, initialSnapshot, totalAmount]);

  const updateSplit = (i: number, patch: Partial<SplitItem>) => {
    setSplits((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  };

  const addRow = () => {
    setSplits((prev) => [
      ...prev,
      {
        category: categories[0] ?? '',
        amount: 0,
        tax_code: 136,
        description: '',
      },
    ]);
  };

  const removeRow = (i: number) => {
    setSplits((prev) => prev.filter((_, idx) => idx !== i));
  };

  const handleClose = useCallback(() => {
    if (hasUnsavedChanges) {
      if (!window.confirm('変更が保存されていません。閉じてよろしいですか?')) {
        return;
      }
    }
    onClose();
  }, [hasUnsavedChanges, onClose]);

  const handleSave = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        ids: [receipt.id],
        action: 'update' as const,
        data: {
          date,
          store,
          amount: totalAmount,
          category: splits[0]?.category ?? receipt.result_json?.category ?? '',
          tax_code: splits[0]?.tax_code ?? receipt.result_json?.tax_code ?? null,
          splits: splits.map((s) => ({
            category: s.category,
            amount: Number(s.amount),
            tax_code: s.tax_code,
            description: s.description || undefined,
          })),
        },
        section_id: sectionId,
      };
      const res = await fetch('/api/receipts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as any));
        throw new Error(data.error ?? '保存に失敗しました');
      }
      await onSaved();
    } catch (e: any) {
      setError(e.message ?? '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  const handleRelease = async () => {
    if (releasing || saving) return;
    if (!Number.isInteger(totalAmount) || totalAmount <= 0) {
      setError('総額が正しくありません');
      return;
    }
    if (!date || !store.trim()) {
      setError('日付・店名を入力してください');
      return;
    }
    if (!window.confirm('分割設定を解除して単一レシートに戻します。よろしいですか？')) return;
    setReleasing(true);
    setError(null);
    try {
      const payload = {
        ids: [receipt.id],
        action: 'update' as const,
        data: {
          date,
          store,
          amount: totalAmount,
          category: splits[0]?.category ?? receipt.result_json?.category ?? '',
          tax_code: splits[0]?.tax_code ?? receipt.result_json?.tax_code ?? null,
          splits: null,
        },
        section_id: sectionId,
      };
      const res = await fetch('/api/receipts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as any));
        throw new Error(data.error ?? '解除に失敗しました');
      }
      await onSaved();
    } catch (e: any) {
      setError(e.message ?? '解除に失敗しました');
    } finally {
      setReleasing(false);
    }
  };

  useEffect(() => {
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    document.addEventListener('keydown', escHandler);
    return () => {
      document.removeEventListener('keydown', escHandler);
    };
  }, [handleClose]);

  return {
    date,
    setDate,
    store,
    setStore,
    sectionId,
    setSectionId,
    splits,
    totalAmount,
    setTotalAmount,
    saving,
    releasing,
    error,
    sum,
    diff,
    isMatched,
    canSave,
    hasUnsavedChanges,
    updateSplit,
    addRow,
    removeRow,
    handleSave,
    handleRelease,
    handleClose,
  };
}
