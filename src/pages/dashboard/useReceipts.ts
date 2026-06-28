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
  all: 0, analyzing: 0, done: 0, approved: 0, sent: 0, error: 0, trash: 0,
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

  // P2-1: query キー別に直近 ETag を保持し If-None-Match で送出（304 で帯域節約）
  const etagRef = useRef<Map<string, string>>(new Map());
  // P1-2: 前回レスポンス body(JSON 文字列)を保持し、一致なら setState を skip（参照同一性維持で re-render 抑止）
  const lastBodyRef = useRef<Map<string, string>>(new Map());

  // ─── ETag 対応 fetch（304 / body 同一なら applier を呼ばず false を返す）────
  const fetchWithETag = useCallback(
    async (url: string, key: string): Promise<{ json: unknown; changed: boolean } | null> => {
      const headers: Record<string, string> = {};
      const prevEtag = etagRef.current.get(key);
      if (prevEtag) headers['If-None-Match'] = prevEtag;
      const res = await fetch(url, { headers });
      // 304: 変化なし → 現在の state を保持
      if (res.status === 304) return { json: null, changed: false };
      if (!res.ok) throw new Error('fetch failed');
      const etag = res.headers.get('ETag');
      if (etag) etagRef.current.set(key, etag);
      const text = await res.text();
      // body 同一なら（ETag 未対応/プロキシ剥がし等の保険）skip
      if (lastBodyRef.current.get(key) === text) {
        return { json: null, changed: false };
      }
      lastBodyRef.current.set(key, text);
      return { json: text ? JSON.parse(text) : null, changed: true };
    },
    [],
  );

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
      const activeDef = TABS.find((t) => t.key === activeTab);
      let url: string;
      if (activeDef?.trash) {
        url = `/api/receipts?trash=1&page=${page}&limit=${PAGE_LIMIT}`;
      } else {
        const statusParam = statusQueryParam();
        url = `/api/receipts?${statusParam ? statusParam + '&' : ''}page=${page}&limit=${PAGE_LIMIT}`;
      }
      const result = await fetchWithETag(url, `list:${url}`);
      // 304 / body 同一 → state を保持して re-render を抑止
      if (result && result.changed) {
        const json = result.json as ReceiptsResponse;
        setReceipts(json.data);
        setTotal(json.total);
      }
    } catch {
      // silently ignore for auto-refresh
    } finally {
      if (!silent) setLoading(false);
    }
  }, [page, statusQueryParam, activeTab, fetchWithETag]);

  // ─── タブカウント フェッチ（1 リクエストに集約）────────────────────
  const fetchTabCounts = useCallback(async () => {
    try {
      const result = await fetchWithETag('/api/receipts?counts=1', 'counts');
      // 304 / body 同一 → 現在の tabCounts を保持して re-render を抑止
      if (!result || !result.changed) return;
      const j = result.json as Partial<TabCountsResponse>;
      setTabCounts({
        all: j.all ?? 0,
        analyzing: j.analyzing ?? 0,
        done: j.done ?? 0,
        approved: j.approved ?? 0,
        sent: j.sent ?? 0,
        error: j.error ?? 0,
        trash: j.trash ?? 0,
      });
    } catch {
      // ignore
    }
  }, [fetchWithETag]);

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

  // ─── 自動更新タイマー（P1-1: hidden 時は張らない / clearInterval）─────────
  useEffect(() => {
    const refetchSilently = () => {
      fetchReceipts(true);
      fetchTabCounts();
    };

    // P1-1: 可視時のみ setInterval を張り、hidden になったら clearInterval して
    // タイマー自体を止める（tick 内 early-return では JS タイマーが生き続ける）。
    const startTimer = () => {
      if (timerRef.current !== null) return;
      timerRef.current = setInterval(refetchSilently, AUTO_REFRESH_MS);
    };
    const stopTimer = () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    // P1-2: focus + visibilitychange の dedup（直近実行 ts で ~500ms collapse）
    let lastEventRefetch = 0;
    const onEventRefetch = () => {
      const now = Date.now();
      if (now - lastEventRefetch < 500) return; // 重複イベントを 1 回に collapse
      lastEventRefetch = now;
      refetchSilently();
    };

    const onVisibility = () => {
      if (document.hidden) {
        stopTimer(); // hidden 中は 0 リクエスト
      } else {
        startTimer();
        onEventRefetch(); // タブ復帰で 1 回だけ refetch
      }
    };
    const onFocus = () => {
      onEventRefetch();
    };

    // 初期状態: 可視ならタイマー起動
    if (typeof document === 'undefined' || !document.hidden) startTimer();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);

    return () => {
      stopTimer();
      document.removeEventListener('visibilitychange', onVisibility);
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
