import formidable from 'formidable';
import crypto from 'crypto';
import { logger } from './lib/logger.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { getSupabase } = await import('./lib/supabase.js');
    const supabase = await getSupabase();

    const form = formidable({
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 100,
    });

    const [fields, files] = await form.parse(req);
    const receipts = files.receipts || [];
    const sectionId = fields.section_id ? fields.section_id[0] : null;

    if (receipts.length === 0) {
      return res.status(400).json({ error: 'No receipt files provided' });
    }

    const fs = await import('fs/promises');
    const path = await import('path');
    const ids = [];
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    for (const file of receipts) {
      const mimeType = file.mimetype || 'image/jpeg';

      // Validate: only image files allowed
      if (!mimeType.startsWith('image/')) {
        logger.warn('upload: skipped non-image', { fileName: file.originalFilename, mimeType });
        continue;
      }

      const id = crypto.randomUUID();
      const ext = path.extname(file.originalFilename || '').replace('.', '') || 'jpg';
      const storagePath = `${yearMonth}/${id}.${ext}`;

      // Read file and upload to Supabase Storage
      const imageBuffer = await fs.readFile(file.filepath);

      const { error: uploadError } = await supabase.storage
        .from('receipts')
        .upload(storagePath, imageBuffer, {
          contentType: mimeType,
          upsert: false,
        });

      if (uploadError) {
        logger.error('upload: storage upload failed', { err: uploadError, fileName: file.originalFilename });
        continue;
      }

      // Insert record into receipts table
      const insertData = {
        id,
        storage_path: storagePath,
        original_filename: file.originalFilename || 'unknown',
        mime_type: mimeType,
        status: 'pending',
      };
      if (sectionId) {
        insertData.section_id = sectionId;
      }
      const { error: insertError } = await supabase
        .from('receipts')
        .insert(insertData);

      if (insertError) {
        logger.error('upload: db insert failed', { err: insertError, fileName: file.originalFilename });
        continue;
      }

      ids.push(id);

      // Cleanup temp file
      try {
        await fs.unlink(file.filepath);
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    if (ids.length === 0) {
      return res.status(400).json({ error: '有効な画像ファイルがありませんでした（非画像ファイルやアップロードエラー）' });
    }

    return res.status(200).json({ success: true, count: ids.length, ids });
  } catch (error) {
    logger.error('upload: handler error', { err: error });
    return res.status(500).json({ error: error.message });
  }
}
