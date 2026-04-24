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

async function getSupabase() {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function handleGet(req, res) {
  try {
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
          const { data: signedData } = await supabase.storage
            .from('receipts')
            .createSignedUrl(receipt.storage_path, 3600); // 1 hour
          image_url = signedData?.signedUrl || null;
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
    console.error('Receipts GET error:', error.message, error.stack);
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

    if (!action || !['approve', 'update', 'unapprove', 'rerun'].includes(action)) {
      return res.status(400).json({ error: 'action must be "approve", "unapprove", "update", or "rerun"' });
    }

    let updatePayload;
    if (action === 'approve') {
      updatePayload = { status: 'approved' };
    } else if (action === 'unapprove') {
      updatePayload = { status: 'done' };
    } else if (action === 'rerun') {
      updatePayload = { status: 'pending', result_json: null, error_message: null };
    } else {
      // action === 'update'
      if (!data) {
        return res.status(400).json({ error: 'data is required for update action' });
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
    console.error('Receipts PATCH error:', error.message, error.stack);
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
        console.error('Storage delete error (continuing):', storageError.message);
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
    console.error('Receipts DELETE error:', error.message, error.stack);
    return res.status(500).json({ error: error.message });
  }
}
