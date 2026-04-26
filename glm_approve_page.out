import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import ApproveCard from '../components/ApproveCard';

type ReceiptStatus = 'pending' | 'processing' | 'done' | 'approved' | 'error';
interface ReceiptResult {
  date: string;
  amount: number;
  store: string;
  category: string;
  tax_code?: number | null;
  splits?: Array<{ category: string; amount: number; tax_code: number; description?: string; }> | null;
  uncertainty_reason?: string | null;
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
interface ReceiptsResponse { data: Receipt[]; total: number; page: number; }

const ApprovePage: React.FC = () => {
  const navigate = useNavigate();
  const [queue, setQueue] = useState<Receipt[]>([]);
  const [index, setIndex] = useState(0);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);

  const fetchQueue = useCallback(async (pageNum: number): Promise<Receipt[]> => {
    const res = await fetch(`/api/receipts?status=done&page=${pageNum}&limit=50`);
    if (!res.ok) throw new Error('fetch failed');
    const json: ReceiptsResponse = await res.json();
    return json.data;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const data = await fetchQueue(1);
        if (cancelled) return;
        setQueue(data);
        setIndex(0);
        setReachedEnd(data.length === 0);
      } catch {
        if (!cancelled) alert('データの取得に失敗しました');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [fetchQueue]);

  const removeFromQueue = useCallback((receiptId: string) => {
    setQueue(prev => prev.filter(r => r.id !== receiptId));
  }, []);

  const handleApprove = useCallback(() => {
    const receipt = queue[index];
    if (!receipt || processing) return;
    setProcessing(true);
    fetch('/api/receipts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [receipt.id], action: 'approve' })
    })
    .then(async res => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || 'Approve failed');
      }
      removeFromQueue(receipt.id);
    })
    .catch(err => {
      alert(err.message || '承認処理に失敗しました');
    })
    .finally(() => setProcessing(false));
  }, [index, queue, processing, removeFromQueue]);

  const handleMarkError = useCallback(() => {
    const receipt = queue[index];
    if (!receipt || processing) return;
    setProcessing(true);
    fetch('/api/receipts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [receipt.id], action: 'markError' })
    })
    .then(async res => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || 'Mark error failed');
      }
      removeFromQueue(receipt.id);
    })
    .catch(err => {
      alert(err.message || 'エラーマーク処理に失敗しました');
    })
    .finally(() => setProcessing(false));
  }, [index, queue, processing, removeFromQueue]);

  const handleSkip = useCallback(() => {
    if (index < queue.length - 1) {
      setIndex(prev => prev + 1);
    }
  }, [index, queue.length]);

  const handlePrev = useCallback(() => {
    if (index > 0) {
      setIndex(prev => prev - 1);
    }
  }, [index]);

  const handleNext = useCallback(() => {
    if (index < queue.length - 1) {
      setIndex(prev => prev + 1);
    }
  }, [index, queue.length]);

  // Automatically fetch the next page when index reaches end of queue
  useEffect(() => {
    if (queue.length === 0 && loading) return;
    
    const needsFetch = queue.length === 0 || index >= queue.length;
    
    if (needsFetch && !reachedEnd) {
      let cancelled = false;
      setLoading(true);

      fetchQueue(1)
        .then(newData => {
          if (cancelled) return;
          if (newData.length === 0) {
            setReachedEnd(true);
          } else {
            setQueue(newData);
            setIndex(0);
          }
        })
        .catch(err => {
          if (!cancelled) alert(err.message || '次ページの取得に失敗しました');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });

      return () => { cancelled = true; };
    }
  }, [index, queue.length, reachedEnd, loading, fetchQueue]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const key = e.key.toLowerCase();
      if (key === 'a') { e.preventDefault(); handleApprove(); }
      else if (key === 'e') { e.preventDefault(); handleMarkError(); }
      else if (key === 's') { e.preventDefault(); handleSkip(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); handlePrev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); handleNext(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleApprove, handleMarkError, handleSkip, handlePrev, handleNext]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        読み込み中...
      </div>
    );
  }

  if (reachedEnd && queue.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100">
        <div className="bg-white rounded-lg shadow-xl p-12 text-center max-w-md mx-auto">
          <div className="mb-6">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-gray-800">承認待ちのレシートがありません</h2>
          </div>
          <p className="text-gray-500 mb-8">すべてのレシートの処理が完了しました。</p>
          <button
            onClick={() => navigate('/dashboard')}
            className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-colors"
          >
            ダッシュボードに戻る
          </button>
        </div>
      </div>
    );
  }

  if (!queue[index]) return null;

  return (
    <ApproveCard
      key={queue[index].id}
      receipt={queue[index]}
      progress={`${index + 1} / ${queue.length}`}
      remaining={queue.length - index}
      processing={processing}
      onApprove={handleApprove}
      onMarkError={handleMarkError}
      onSkip={handleSkip}
      onPrev={handlePrev}
      onNext={handleNext}
      canPrev={index > 0}
      canNext={index < queue.length - 1}
    />
  );
};

export default ApprovePage;
