// receipt-scanner ダッシュボード本体（Loop 4 / Engineer D で大幅スリム化）
// 旧: 992 行のモノリシック実装
// 新: ~250 行 — useReceipts / useBulkActions Hook と
//     ReceiptTableRow / ReceiptMobileCard / ImagePreviewModal 子コンポーネントを組み立てるだけ

import React, { lazy, Suspense, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CATEGORIES,
  SECTIONS,
  TABS,
  PAGE_LIMIT,
} from './dashboard/constants';
import { useReceipts } from './dashboard/useReceipts';
import { useBulkActions } from './dashboard/useBulkActions';
import { ReceiptTableRow } from './dashboard/ReceiptTableRow';
import { ReceiptMobileCard } from './dashboard/ReceiptMobileCard';
import { ImagePreviewModal } from './dashboard/ImagePreviewModal';
const SplitEditModal = lazy(() => import('../components/SplitEditModal'));

const DashboardPage: React.FC = () => {
  const navigate = useNavigate();

  // ─── データ層 ─────────────────────────────────────────────────────────
  const {
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
  } = useReceipts();

  // ─── 操作層 ───────────────────────────────────────────────────────────
  const b = useBulkActions({ receipts, onMutate: refetch });

  // タブ切替時に選択 / 編集 / 展開 を全てリセット
  useEffect(() => {
    b.clearSelection();
    b.cancelEdit();
    b.resetExpanded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // ページ送り時: 展開のみリセット（旧仕様 [activeTab, page] と同等）
  useEffect(() => {
    b.resetExpanded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // 行コンポーネントへ流し込む共通 props
  const rowProps = {
    editingId: b.editingId,
    editDraft: b.editDraft,
    editSectionId: b.editSectionId,
    setEditDraft: b.setEditDraft,
    setEditSectionId: b.setEditSectionId,
    startEdit: b.startEdit,
    cancelEdit: b.cancelEdit,
    saveEdit: b.saveEdit,
    selected: b.selected,
    toggleSelect: b.toggleSelect,
    expandedIds: b.expandedIds,
    toggleExpand: b.toggleExpand,
    openSplitModal: b.openSplitModal,
    setPreviewUrl: b.setPreviewUrl,
  };

  const approvedUnsentCount = receipts.filter(
    (r) => r.status === 'approved' && !r.freee_sent_at,
  ).length;

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50 py-6 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <span>🧾</span> レシート管理
          </h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate('/approve')}
              className="text-sm bg-green-600 text-white rounded-md px-4 py-2 hover:bg-green-700 transition font-medium"
            >
              承認モードへ →
            </button>
            <button
              onClick={() => navigate('/')}
              className="text-sm bg-indigo-600 text-white rounded-md px-4 py-2 hover:bg-indigo-700 transition font-medium"
            >
              アップロードへ →
            </button>
          </div>
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
            onClick={b.approveSelected}
            disabled={b.selected.size === 0}
            className={`px-4 py-2 rounded-md text-sm font-medium transition ${
              b.selected.size > 0
                ? 'bg-green-600 text-white hover:bg-green-700 shadow-sm'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            選択した{b.selected.size}件を承認
          </button>
          <button
            onClick={b.deleteSelected}
            disabled={b.selected.size === 0}
            className={`px-4 py-2 rounded-md text-sm font-medium transition ${
              b.selected.size > 0
                ? 'bg-red-600 text-white hover:bg-red-700 shadow-sm'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            選択した{b.selected.size}件を削除
          </button>
          <button
            onClick={b.unapproveSelected}
            disabled={b.selected.size === 0}
            className={`px-4 py-2 rounded-md text-sm font-medium transition ${
              b.selected.size > 0
                ? 'bg-yellow-500 text-white hover:bg-yellow-600 shadow-sm'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            選択した{b.selected.size}件を解析済みに戻す
          </button>
          <button
            onClick={b.rerunSelected}
            disabled={b.selected.size === 0}
            className={`px-4 py-2 rounded-md text-sm font-medium transition ${
              b.selected.size > 0
                ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            選択した{b.selected.size}件を再判定
          </button>
          <div className="flex-1" />
          <button
            onClick={b.sendToFreee}
            disabled={b.sending || approvedUnsentCount === 0}
            className="px-4 py-2 rounded-md text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {b.sending ? '送信中...' : '承認済みをfreeeに送信'}
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
                          checked={receipts.length > 0 && b.selected.size === receipts.length}
                          onChange={b.toggleSelectAll}
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
                    {receipts.map((r) => (
                      <ReceiptTableRow key={r.id} receipt={r} {...rowProps} />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="md:hidden p-4 space-y-3">
                {receipts.map((r) => (
                  <ReceiptMobileCard key={r.id} receipt={r} {...rowProps} />
                ))}
              </div>
            </>
          )}

          {/* Pagination */}
          {total > PAGE_LIMIT && (
            <div className="flex items-center justify-center gap-4 py-4 border-t border-gray-100">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page <= 1}
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                ← 前へ
              </button>
              <span className="text-sm text-gray-500">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
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
      <ImagePreviewModal url={b.previewUrl} onClose={() => b.setPreviewUrl(null)} />

      {/* Split edit modal */}
      <Suspense fallback={null}>
        {b.splitModalReceipt && (
          <SplitEditModal
            receipt={b.splitModalReceipt as React.ComponentProps<typeof SplitEditModal>['receipt']}
            onClose={b.closeSplitModal}
            onSaved={async () => {
              b.closeSplitModal();
              await refetch();
            }}
            categories={[...CATEGORIES]}
            sections={[...SECTIONS]}
          />
        )}
      </Suspense>
    </div>
  );
};

export default DashboardPage;
