import { getSupabase } from './lib/supabase.js';
import { logger } from './lib/logger.js';

// Signed URL in-memory cache (Loop A #2)
// - Module scope: persists across warm Vercel Function invocations, reset on cold start.
// - TTL 50 min < Supabase signed URL 1h to leave 10 min margin.
// - FIFO eviction at MAX_ENTRIES to prevent unbounded growth.
const SIGNED_URL_TTL_MS = 50 * 60 * 1000;
const SIGNED_URL_TTL_SEC = 60 * 60;
const SIGNED_URL_MAX_ENTRIES = 500;
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

const ALLOWED_CATEGORIES = ['消耗品費', '交通費', '接待交際費', '会議費', '通信費', '雑費', '仕入高'];
const ALLOWED_TAX_CODES = [136, 137];
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

async function handleGetCounts(_req, res) {
  try {
    const supabase = await getSupabase();
    const base = () => supabase.from('receipts').select('*', { count: 'exact', head: true });

    const [all, analyzing, done, approvedUnsent, sent, errorCnt] = await Promise.all([
      base(),
      base().in('status', ['pending', 'processing']),
      base().in('status', ['done']),
      base().in('status', ['approved']).is('freee_sent_at', null),
      base().in('status', ['approved']).not('freee_sent_at', 'is', null),
      base().in('status', ['error']),
    ]);

    return res.status(200).json({
      all: all.count || 0,
      analyzing: analyzing.count || 0,
      done: done.count || 0,
      approved: approvedUnsent.count || 0,
      sent: sent.count || 0,
      error: errorCnt.count || 0,
    });
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
    const { status, sent, page: pageStr, limit: limitStr } = req.query || {};
    const page = Math.max(1, parseInt(pageStr, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(limitStr, 10) || 50));
    const offset = (page - 1) * limit;

    // Build query
    let query = supabase
      .from('receipts')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      const statuses = Array.isArray(status) ? status : [status];
      query = query.in('status', statuses);
    }

    if (sent === 'true') {
      query = query.not('freee_sent_at', 'is', null);
    } else if (sent === 'false') {
      query = query.is('freee_sent_at', null);
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

    return res.status(200).json({
      data: dataWithUrls,
      total: count || 0,
      page,
    });
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

    if (!action || !['approve', 'update', 'unapprove', 'rerun', 'markError'].includes(action)) {
      return res.status(400).json({ error: 'action must be "approve", "unapprove", "update", "rerun", or "markError"' });
    }

    let updatePayload;
    if (action === 'approve') {
      updatePayload = { status: 'approved' };
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

    const { ids } = body || {};

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }

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

    return res.status(200).json({ success: true, deleted: count || 0 });
  } catch (error) {
    logger.error('receipts: DELETE failed', { err: error });
    return res.status(500).json({ error: error.message });
  }
}
