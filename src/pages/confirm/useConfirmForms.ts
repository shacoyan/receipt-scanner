import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AnalysisResult, SplitItem } from '../../types/receipt';

export interface FormState {
  date: string;
  amount: number;
  store: string;
  category: string;
  memo: string;
  tax_code: 136 | 137;
  splitMode: boolean;
  splits: SplitItem[];
}

const buildPayload = (form: FormState) => {
  const base = {
    date: form.date,
    amount: form.amount,
    store: form.store,
    memo: form.memo,
  };

  if (form.splitMode && form.splits.length >= 2) {
    const maxAmountSplit = form.splits.reduce((prev, current) => (prev.amount > current.amount ? prev : current));
    return {
      ...base,
      category: maxAmountSplit.category,
      tax_code: 136,
      splits: form.splits,
    };
  } else {
    return {
      ...base,
      category: form.category,
      tax_code: form.tax_code,
    };
  }
};

const validateForm = (form: FormState): boolean => {
  if (!form.date) return false;
  if (!form.amount || form.amount <= 0) return false;

  if (form.splitMode && form.splits.length >= 2) {
    if (form.splits.some((s) => !s.amount || Number(s.amount) <= 0)) return false;
    const sum = form.splits.reduce((acc, s) => acc + Number(s.amount), 0);
    if (sum !== form.amount) return false;
  }

  return true;
};

export function useConfirmForms(analyses: AnalysisResult[] | undefined) {
  const navigate = useNavigate();

  const [forms, setForms] = useState<FormState[]>(
    analyses && analyses.length > 0
      ? analyses.map((a) => {
          const initialSplits = (a.splits && a.splits.length >= 2) ? a.splits : [];
          return {
            date: a.date ?? '',
            amount: a.amount ?? 0,
            store: a.store ?? '',
            category: a.category ?? '雑費',
            memo: a.memo ?? '',
            tax_code: a.tax_code === 137 ? 137 : 136,
            splitMode: initialSplits.length > 0,
            splits: initialSplits,
          };
        })
      : []
  );

  const [loading, setLoading] = useState(false);
  const [registered, setRegistered] = useState(0);

  const handleChange = (
    index: number,
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setForms((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        [name]: (name === 'amount' || name === 'tax_code') ? Number(value) : value,
      };
      return next;
    });
  };

  const toggleSplit = (index: number) => {
    setForms((prev) => {
      const next = [...prev];
      const form = next[index];
      const half = Math.floor(form.amount / 2);
      const remainder = form.amount - half;

      next[index] = {
        ...form,
        splitMode: true,
        splits: [
          { category: form.category, amount: remainder, tax_code: form.tax_code, description: '' },
          { category: form.category, amount: half, tax_code: form.tax_code, description: '' }
        ],
      };
      return next;
    });
  };

  const disableSplit = (index: number) => {
    setForms((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        splitMode: false,
        splits: [],
      };
      return next;
    });
  };

  const handleSplitChange = (index: number, splitIdx: number, field: string, value: string | number) => {
    setForms((prev) => {
      const next = [...prev];
      const splits = [...next[index].splits];
      splits[splitIdx] = {
        ...splits[splitIdx],
        [field]: (field === 'amount' || field === 'tax_code') ? Number(value) : value,
      };
      next[index] = {
        ...next[index],
        splits,
      };
      return next;
    });
  };

  const addSplitRow = (index: number) => {
    setForms((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        splits: [
          ...next[index].splits,
          { category: '雑費', amount: 0, tax_code: 136, description: '' }
        ],
      };
      return next;
    });
  };

  const removeSplitRow = (index: number, splitIdx: number) => {
    setForms((prev) => {
      const next = [...prev];
      const form = next[index];

      if (form.splits.length <= 2) {
        next[index] = {
          ...form,
          splitMode: false,
          splits: [],
        };
      } else {
        const splits = form.splits.filter((_, i) => i !== splitIdx);
        next[index] = {
          ...form,
          splits,
        };
      }
      return next;
    });
  };

  const autoFillLastSplit = (index: number) => {
    setForms((prev) => {
      const next = [...prev];
      const form = next[index];
      const splits = [...form.splits];

      if (splits.length > 0) {
        const otherSum = splits.slice(0, -1).reduce((sum, s) => sum + Number(s.amount), 0);
        const lastAmount = form.amount - otherSum;

        splits[splits.length - 1] = {
          ...splits[splits.length - 1],
          amount: lastAmount > 0 ? lastAmount : 0,
        };

        next[index] = {
          ...form,
          splits,
        };
      }
      return next;
    });
  };

  const handleRegisterAll = async () => {
    for (let i = 0; i < forms.length; i++) {
      if (!validateForm(forms[i])) {
        alert(`レシート ${i + 1} の内容にエラーがあります（金額や分割合計を確認してください）`);
        return;
      }
    }

    setLoading(true);
    setRegistered(0);
    try {
      for (let i = 0; i < forms.length; i++) {
        const payload = buildPayload(forms[i]);
        const res = await fetch('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!data.success) {
          alert(`レシート ${i + 1} の登録に失敗しました`);
          setLoading(false);
          return;
        }
        setRegistered(i + 1);
      }
      navigate('/complete', { state: { count: forms.length } });
    } catch {
      alert('通信エラーが発生しました');
    } finally {
      setLoading(false);
    }
  };

  const isSubmitDisabled = loading || forms.some(form => {
    if (form.splitMode && form.splits.length >= 2) {
      const sum = form.splits.reduce((acc, s) => acc + Number(s.amount), 0);
      if (sum !== form.amount) return true;
    }
    return false;
  });

  return {
    forms,
    loading,
    registered,
    isSubmitDisabled,
    handleChange,
    toggleSplit,
    disableSplit,
    handleSplitChange,
    addSplitRow,
    removeSplitRow,
    autoFillLastSplit,
    handleRegisterAll,
  };
}
