import formidable from 'formidable';
import crypto from 'crypto';
import sharp from 'sharp';
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

      // Read file
      const imageBuffer = await fs.readFile(file.filepath);

      // ── リサイズ: 長辺2000px / JPEG q85 / EXIF除去（.rotate()でEXIF向き反映後にメタ落ち）──
      //    失敗時は元バッファ・元拡張子・元MIMEにフォールバック（3要素を一貫させる）。
      let outBuffer = imageBuffer;
      let outExt = ext;
      let outMime = mimeType;
      try {
        outBuffer = await sharp(imageBuffer)
          .rotate()
          .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
        outExt = 'jpg';
        outMime = 'image/jpeg';
      } catch (resizeErr) {
        logger.warn('upload: sharp resize failed (using original)', { err: resizeErr, fileName: file.originalFilename });
        outBuffer = imageBuffer;
        outExt = ext;
        outMime = mimeType;
      }

      const storagePath = `${yearMonth}/${id}.${outExt}`;

      // Upload to Supabase Storage
      const { error: uploadError } = await supabase.storage
        .from('receipts')
        .upload(storagePath, outBuffer, {
          contentType: outMime,
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
        mime_type: outMime,
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
