// receipt-scanner ダッシュボード共通定数 + 型
// DashboardPage.tsx から切り出し（Loop 4 / Engineer A 先行作成）
// 子コンポーネント・Hook はここから import する

import type { ReceiptStatus } from '../../types/receipt';

// ─── タブ ─────────────────────────────────────────────────────────────────
export type TabKey = 'all' | 'analyzing' | 'done' | 'approved' | 'sent' | 'error';

export interface TabDef {
  key: TabKey;
  label: string;
  statuses: ReceiptStatus[] | null;
  sent: boolean | null;
}

export const TABS: TabDef[] = [
  { key: 'all', label: '全て', statuses: null, sent: null },
  { key: 'analyzing', label: '解析中', statuses: ['pending', 'processing'], sent: null },
  { key: 'done', label: '解析済み', statuses: ['done'], sent: null },
  { key: 'approved', label: '承認済み', statuses: ['approved'], sent: false },
  { key: 'sent', label: '送信済み', statuses: ['approved'], sent: true },
  { key: 'error', label: 'エラー', statuses: ['error'], sent: null },
];

// ─── カテゴリ / セクション ────────────────────────────────────────────────
export const CATEGORIES = [
  '消耗品費', '交通費', '接待交際費', '会議費', '通信費', '雑費', '仕入高',
] as const;

export const SECTIONS = [
  'スーク', '金魚', 'KITUNE', 'Goodbye', 'LR', '狛犬', 'moumou', 'SABABA HQ', '大輝HQ',
] as const;

// ─── ページング / 自動更新 ────────────────────────────────────────────────
export const PAGE_LIMIT = 50;
export const AUTO_REFRESH_MS = 10_000;

// ─── ステータスバッジ ─────────────────────────────────────────────────────
export const STATUS_BADGE: Record<ReceiptStatus, { bg: string; text: string; label: string }> = {
  pending: { bg: 'bg-gray-100 text-gray-700', text: 'text-gray-500', label: '待機中' },
  processing: { bg: 'bg-yellow-100 text-yellow-800', text: 'text-yellow-600', label: '解析中' },
  done: { bg: 'bg-blue-100 text-blue-800', text: 'text-blue-600', label: '解析済み' },
  approved: { bg: 'bg-green-100 text-green-800', text: 'text-green-600', label: '承認済み' },
  error: { bg: 'bg-red-100 text-red-800', text: 'text-red-600', label: 'エラー' },
};

// ─── ヘルパ ───────────────────────────────────────────────────────────────
export const formatYen = (n: number): string => `¥${n.toLocaleString('ja-JP')}`;
