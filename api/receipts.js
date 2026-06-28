import { getSupabase } from './lib/supabase.js';
import { logger } from './lib/logger.js';

// Signed URL in-memory cache (Loop A #2)
// - Module scope: persists across warm Vercel Function invocations, reset on cold start.
// - TTL 50 min < Supabase signed URL 1h to leave 10 min margin.
// - FIFO eviction at MAX_ENTRIES to prevent unbounded growth.
const SIGNED_URL_TTL_MS = 50 * 60 * 1000;
const SIGNED_URL_TTL_SEC = 60 * 60;
const SIGNED_URL_MAX_ENTRIES = 2000;
const _signedUrlCache = new Map();

async function getCachedSignedUrl(supabase, storagePath) {
  const now = Date.now();
  const hit = _signedUrlCache.get(storagePath);
  if (hit && hit.expiresAt > now) return hit.url;
  const { data, error } = await supabase.storage
    .from('receipts')
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SEC);
  if (error || !data?.signedUrl) return null;
  if (_signedUrlCache.size >= SIGNED_URL_MAX_ENTRIES) {
    const firstKey = _signedUrlCache.keys().next().value;
    _signedUrlCache.delete(firstKey);
  }
  _signedUrlCache.set(storagePath, { url: data.signedUrl, expiresAt: now + SIGNED_URL_TTL_MS });
  return data.signedUrl;
}

// ─── P2-2: counts 60s in-memory cache（Map+TTL・固定キー） ─────────────
// 7 並列 head COUNT は温存（PostgREST 制約で 1 本化困難）。warm invocation 間で
// 往復を実質削減。**全 mutation 分岐で必ず invalidateCountsCache() を呼ぶこと**
// （漏れ＝Critical）。
const COUNTS_CACHE_TTL_MS = 60 * 1000;
const COUNTS_CACHE_KEY = 'counts';
const _countsCache = new Map();

function getCountsCache() {
  const hit = _countsCache.get(COUNTS_CACHE_KEY);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  return null;
}
function setCountsCache(value) {
  _countsCache.set(COUNTS_CACHE_KEY, { value, expiresAt: Date.now() + COUNTS_CACHE_TTL_MS });
}
function invalidateCountsCache() {
  _countsCache.delete(COUNTS_CACHE_KEY);
}

// ─── P2-1: ETag 用の安定ハッシュ（JSON 文字列の単純 32bit FNV 風ハッシュ） ───
function stableHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

// body(JSON) + scope(クエリパラメータ集合) から ETag を生成し、If-None-Match 一致なら
// 304 を返す。一致しなければ通常の 200 を送る。手動 If-None-Match 方式のため no-store で
// ブラウザHTTPキャッシュを無効化し、mutation 直後の即時 refetch が stale 表示しないようにする。
function sendWithETag(req, res, scope, payload) {
  const etag = `"${stableHash(scope + '|' + JSON.stringify(payload))}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, no-store');
  const inm = req.headers['if-none-match'];
  if (inm && inm === etag) {
    return res.status(304).end();
  }
  return res.status(200).json(payload);
}

const ALLOWED_CATEGORIES = ['消耗品費', '交通費', '交際費', '通信費', '雑費', '仕入高'];
const CATEGORY_ALIAS = { '接待交際費': '交際費', '会議費': '交際費' };
const normalizeCategory = (c) => CATEGORY_ALIAS[c] ?? c;
const ALLOWED_TAX_CODES = [136, 163];
const MAX_DESCRIPTION_LENGTH = 200;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return handleGet(req, res);
  }
  if (req.method === 'PATCH') {
    return handlePatch(req, res);
  }
  if (req.method === 'DELETE') {
    return handleDelete(req, res);
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleGetCounts(req, res) {
  try {
    // P2-2: 60s cache ヒット時は DB 往復をスキップ（ETag 経路は維持）。
    const cached = getCountsCache();
    if (cached) {
      return sendWithETag(req, res, 'counts', cached);
    }

    const supabase = await getSupabase();
    const base = () => supabase.from('receipts').select('*', { count: 'exact', head: true });

    // アクティブ（deleted_at IS NULL）のみカウント。trash 枝のみゴミ箱を数える。
    const [all, analyzing, done, approvedUnsent, sent, errorCnt, trash] = await Promise.all([
      base().is('deleted_at', null),
      base().is('deleted_at', null).in('status', ['pending', 'processing']),
      base().is('deleted_at', null).in('status', ['done']),
      base().is('deleted_at', null).in('status', ['approved']).is('freee_sent_at', null),
      base().is('deleted_at', null).in('status', ['approved']).not('freee_sent_at', 'is', null),
      base().is('deleted_at', null).in('status', ['error']),
      base().not('deleted_at', 'is', null),
    ]);

    const payload = {
      all: all.count || 0,
      analyzing: analyzing.count || 0,
      done: done.count || 0,
      approved: approvedUnsent.count || 0,
      sent: sent.count || 0,
      error: errorCnt.count || 0,
      trash: trash.count || 0,
    };
    setCountsCache(payload);
    return sendWithETag(req, res, 'counts', payload);
  } catch (error) {
    logger.error('receipts: counts query failed', { err: error });
    return res.status(500).json({ error: error.message });
  }
}

async function handleGet(req, res) {
  try {
    // ─── タブカウント取得モード（N+1 解消） ─────────────────────
    if (req.query && req.query.counts === '1') {
      return handleGetCounts(req, res);
    }

    const supabase = await getSupabase();
    const { status, sent, page: pageStr, limit: limitStr, trash, deleted } = req.query || {};
    const isTrash = trash === '1' || deleted === '1';
    const page = Math.max(1, parseInt(pageStr, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(limitStr, 10) || 50));
    const offset = (page - 1) * limit;

    // Build query
    // P1-4: select('*') → 必要列の明示指定（result_json は必須＝Dashboard インライン split 表示/編集ボタンが依存）。
    let query = supabase
      .from('receipts')
      .select('id,status,result_json,error_message,section_id,created_at,freee_sent_at,freee_deal_id,storage_path', { count: 'exact' })
      .range(offset, offset + limit - 1);

    if (isTrash) {
      // ゴミ箱: 論理削除済みのみ・捨てた順（新しい順）。status/sent 分岐はスキップ。
      query = query
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false });
    } else {
      // 通常一覧: アクティブのみ・作成日降順。status/sent フィルタ温存。
      query = query
        .is('deleted_at', null)
        .order('created_at', { ascending: false });

      if (status) {
        const statuses = Array.isArray(status) ? status : [status];
        query = query.in('status', statuses);
      }

      if (sent === 'true') {
        query = query.not('freee_sent_at', 'is', null);
      } else if (sent === 'false') {
        query = query.is('freee_sent_at', null);
      }
    }

    const { data, count, error } = await query;

    if (error) {
      throw new Error(`Query error: ${error.message}`);
    }

    // Generate signed URLs for each receipt
    const dataWithUrls = await Promise.all(
      (data || []).map(async (receipt) => {
        let image_url = null;
        if (receipt.storage_path) {
          image_url = await getCachedSignedUrl(supabase, receipt.storage_path);
        }
        return { ...receipt, image_url };
      })
    );

    const payload = {
      data: dataWithUrls,
      total: count || 0,
      page,
    };
    // P2-1: ETag はクエリパラメータ込みで一意化（status/sent/page/limit/trash）。
    const scope = JSON.stringify({ status, sent, page, limit, isTrash });
    return sendWithETag(req, res, scope, payload);
  } catch (error) {
    logger.error('receipts: GET failed', { err: error });
    return res.status(500).json({ error: error.message });
  }
}

async function handlePatch(req, res) {
  try {
    const supabase = await getSupabase();

    // Parse body
    let body = req.body;
    if (typeof body === 'string') {
      body = JSON.parse(body);
    }

    const { ids, action, data, section_id } = body || {};

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }

    if (!action || !['approve', 'update', 'unapprove', 'rerun', 'markError', 'restore'].includes(action)) {
      return res.status(400).json({ error: 'action must be "approve", "unapprove", "update", "rerun", "markError", or "restore"' });
    }

    let updatePayload;
    if (action === 'approve') {
      updatePayload = { status: 'approved' };
    } else if (action === 'restore') {
      // ゴミ箱からの復元。status は変更しない（done のまま等を維持）。
      updatePayload = { deleted_at: null };
    } else if (action === 'unapprove') {
      updatePayload = { status: 'done' };
    } else if (action === 'rerun') {
      updatePayload = { status: 'pending', result_json: null, error_message: null };
    } else if (action === 'markError') {
      updatePayload = { status: 'error', error_message: '承認モードで手動エラー化' };
    } else if (action === 'update') {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return res.status(400).json({ error: 'data is required for update action' });
      }

      // Validate date
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
        return res.status(400).json({ error: 'invalid date' });
      }

      // Validate store
      if (typeof data.store !== 'string' || data.store.trim() === '') {
        return res.status(400).json({ error: 'invalid store' });
      }

      // Validate amount
      if (typeof data.amount !== 'number' || !Number.isInteger(data.amount) || data.amount <= 0) {
        return res.status(400).json({ error: 'invalid amount' });
      }

      // Normalize legacy category aliases (接待交際費・会議費 → 交際費)
      if (data.category !== undefined) {
        data.category = normalizeCategory(data.category);
      }
      if (Array.isArray(data.splits)) {
        data.splits = data.splits.map(s => {
          if (!s || typeof s !== 'object' || Array.isArray(s)) return s;
          return { ...s, category: normalizeCategory(s.category) };
        });
      }

      // Validate category (optional)
      if (data.category !== undefined && !ALLOWED_CATEGORIES.includes(data.category)) {
        return res.status(400).json({ error: 'invalid category' });
      }

      // Validate tax_code (optional)
      if (data.tax_code !== undefined && data.tax_code !== null && !ALLOWED_TAX_CODES.includes(data.tax_code)) {
        return res.status(400).json({ error: 'invalid tax_code' });
      }

      // Validate splits
      if (data.splits !== undefined) {
        if (data.splits === null) {
          // Allow splitting release
        } else if (!Array.isArray(data.splits)) {
          return res.status(400).json({ error: 'splits must be array or null' });
        } else {
          if (data.splits.length < 2) {
            return res.status(400).json({ error: 'splits must have at least 2 items' });
          }
          
          let sum = 0;
          for (let i = 0; i < data.splits.length; i++) {
            const split = data.splits[i];
            
            if (!ALLOWED_CATEGORIES.includes(split.category)) {
              return res.status(400).json({ error: `invalid category in splits[${i}]` });
            }
            if (typeof split.amount !== 'number' || !Number.isInteger(split.amount) || split.amount <= 0) {
              return res.status(400).json({ error: `invalid amount in splits[${i}]` });
            }
            if (!ALLOWED_TAX_CODES.includes(split.tax_code)) {
              return res.status(400).json({ error: `invalid tax_code in splits[${i}]` });
            }
            if (split.description !== undefined) {
              if (typeof split.description !== 'string' || split.description.length > MAX_DESCRIPTION_LENGTH) {
                return res.status(400).json({ error: `description too long in splits[${i}]` });
              }
            }
            sum += split.amount;
          }

          if (sum !== data.amount) {
            return res.status(400).json({ error: `splits sum mismatch: expected ${data.amount}, got ${sum}` });
          }
        }
      }

      updatePayload = { result_json: data };
      if (section_id !== undefined) {
        updatePayload.section_id = section_id;
      }
    }

    const { error, count } = await supabase
      .from('receipts')
      .update(updatePayload, { count: 'exact' })
      .in('id', ids);

    if (error) {
      throw new Error(`Update error: ${error.message}`);
    }

    // P2-2: 全 mutation 分岐（approve/unapprove/rerun/markError/update/restore）は
    // この単一 update を通る → ここで counts cache を無効化（漏れなし）。
    invalidateCountsCache();

    return res.status(200).json({ success: true, updated: count || 0 });
  } catch (error) {
    logger.error('receipts: PATCH failed', { err: error });
    return res.status(500).json({ error: error.message });
  }
}

async function handleDelete(req, res) {
  try {
    const supabase = await getSupabase();

    // Parse body
    let body = req.body;
    if (typeof body === 'string') {
      body = JSON.parse(body);
    }

    const { ids, permanent } = body || {};

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }

    // ─── 既定: 論理削除（ゴミ箱へ移動）。storage / 行は残す。冪等。 ──────
    if (!permanent) {
      const { error: softError, count } = await supabase
        .from('receipts')
        .update({ deleted_at: new Date().toISOString() }, { count: 'exact' })
        .in('id', ids)
        .is('deleted_at', null);

      if (softError) {
        throw new Error(`Soft delete error: ${softError.message}`);
      }

      // P2-2: soft delete で counts cache を無効化。
      invalidateCountsCache();

      return res.status(200).json({ success: true, mode: 'soft', deleted: count || 0 });
    }

    // ─── permanent: true = 物理削除（現行フロー） ────────────────────
    // 1. Get storage_path for each receipt
    const { data: receipts, error: selectError } = await supabase
      .from('receipts')
      .select('id, storage_path')
      .in('id', ids);

    if (selectError) {
      throw new Error(`Select error: ${selectError.message}`);
    }

    // 2. Delete images from Supabase Storage
    const storagePaths = (receipts || [])
      .map((r) => r.storage_path)
      .filter(Boolean);

    if (storagePaths.length > 0) {
      const { error: storageError } = await supabase.storage
        .from('receipts')
        .remove(storagePaths);

      if (storageError) {
        logger.warn('receipts: storage delete failed (continuing)', { err: storageError });
      }
    }

    // 3. Delete records from receipts table
    const { error: deleteError, count } = await supabase
      .from('receipts')
      .delete({ count: 'exact' })
      .in('id', ids);

    if (deleteError) {
      throw new Error(`Delete error: ${deleteError.message}`);
    }

    // P2-2: hard delete で counts cache を無効化。
    invalidateCountsCache();

    return res.status(200).json({ success: true, mode: 'hard', deleted: count || 0 });
  } catch (error) {
    logger.error('receipts: DELETE failed', { err: error });
    return res.status(500).json({ error: error.message });
  }
}
