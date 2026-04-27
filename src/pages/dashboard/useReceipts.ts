// receipt-scanner ダッシュボード データフェッチ Hook
// DashboardPage.tsx の Data state / fetchReceipts / fetchTabCounts / 自動更新
// useEffect / タブ切替時 reset useEffect を Hook 化（Loop 4 / Engineer A）
//
// N+1 解消: タブカウントは 6 fetch → 1 fetch に集約（GET /api/receipts?counts=1）

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Receipt, ReceiptsResponse } from '../../types/receipt';
import { AUTO_REFRESH_MS, PAGE_LIMIT, TABS } from './constants';
import type { TabKey } from './constants';

export type TabCounts = Record<TabKey, number>;

type TabCountsResponse = TabCounts;

const EMPTY_COUNTS: TabCounts = {
  all: 0, analyzing: 0, done: 0, approved: 0, sent: 0, error: 0,
};

export interface UseReceiptsResult {
  receipts: Receipt[];
  total: number;
  page: number;
  setPage: (p: number) => void;
  activeTab: TabKey;
  setActiveTab: (t: TabKey) => void;
  tabCounts: TabCounts;
  loading: boolean;
  totalPages: number;
  /** 通常フェッチ（loading フラグを立てる） */
  refetch: () => Promise<void>;
  /** auto-refresh 用（loading フラグを立てない） */
  refetchSilent: () => Promise<void>;
}

export function useReceipts(): UseReceiptsResult {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [tabCounts, setTabCounts] = useState<TabCounts>(EMPTY_COUNTS);
  const [loading, setLoading] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── クエリ文字列生成 ─────────────────────────────────────────────────
  const statusQueryParam = useCallback((): string => {
    const tab = TABS.find((t) => t.key === activeTab);
    if (!tab) return '';
    const parts: string[] = [];
    if (tab.statuses) parts.push(...tab.statuses.map((s) => `status=${s}`));
    if (tab.sent === true) parts.push('sent=true');
    if (tab.sent === false) parts.push('sent=false');
    return parts.join('&');
  }, [activeTab]);

  // ─── 一覧フェッチ ─────────────────────────────────────────────────────
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

  // ─── タブカウント フェッチ（1 リクエストに集約）────────────────────
  const fetchTabCounts = useCallback(async () => {
    try {
      const res = await fetch('/api/receipts?counts=1');
      if (!res.ok) return;
      const j = (await res.json()) as Partial<TabCountsResponse>;
      setTabCounts({
        all: j.all ?? 0,
        analyzing: j.analyzing ?? 0,
        done: j.done ?? 0,
        approved: j.approved ?? 0,
        sent: j.sent ?? 0,
        error: j.error ?? 0,
      });
    } catch {
      // ignore
    }
  }, []);

  // ─── 公開: refetch / refetchSilent ────────────────────────────────────
  const refetch = useCallback(async () => {
    await Promise.all([fetchReceipts(false), fetchTabCounts()]);
  }, [fetchReceipts, fetchTabCounts]);

  const refetchSilent = useCallback(async () => {
    await Promise.all([fetchReceipts(true), fetchTabCounts()]);
  }, [fetchReceipts, fetchTabCounts]);

  // ─── 初回 + tab/page 変更で再フェッチ ────────────────────────────────
  useEffect(() => {
    fetchReceipts();
    fetchTabCounts();
  }, [fetchReceipts, fetchTabCounts]);

  // ─── 自動更新タイマー ────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchReceipts(true);
      fetchTabCounts();
    };
    const id = setInterval(tick, AUTO_REFRESH_MS);
    timerRef.current = id;

    const onVisible = () => {
      if (!document.hidden) {
        fetchReceipts(true);
        fetchTabCounts();
      }
    };
    const onFocus = () => {
      fetchReceipts(true);
      fetchTabCounts();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [fetchReceipts, fetchTabCounts]);

  // ─── タブ切替時に page を 1 にリセット ───────────────────────────────
  useEffect(() => {
    setPage(1);
  }, [activeTab]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));

  return {
    receipts,
    total,
    page,
    setPage,
    activeTab,
    setActiveTab,
    tabCounts,
    loading,
    totalPages,
    refetch,
    refetchSilent,
  };
}
