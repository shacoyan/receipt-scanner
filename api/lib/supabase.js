// api/lib/supabase.js
// Supabase Service Role クライアントの共通生成ヘルパ
// 全 API ハンドラから import { getSupabase } で利用する

let _client = null;

/**
 * Service Role 権限の Supabase クライアントを取得（シングルトン）
 * @returns {Promise<import('@supabase/supabase-js').SupabaseClient>}
 */
export async function getSupabase() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Supabase env vars missing: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  }

  const { createClient } = await import('@supabase/supabase-js');
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}
