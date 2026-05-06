// freee認証ヘルパー
// - トークン自動リフレッシュ付きAPI呼び出し

import { logger } from './logger.js';
import { getSupabase } from './supabase.js';

const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';

async function loadTokensFromDb() {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('freee_oauth_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('id', 1)
    .single();

  if (error || !data) {
    throw new Error('freee_oauth_tokens row missing — run scripts/seed-freee-tokens.mjs first');
  }

  return data;
}

async function saveTokensToDb({ access_token, refresh_token, expires_at }) {
  const supabase = await getSupabase();
  const { error } = await supabase
    .from('freee_oauth_tokens')
    .update({ access_token, refresh_token, expires_at })
    .eq('id', 1);

  if (error) {
    throw new Error(`freee_oauth_tokens update failed: ${error.message}`);
  }
}

export async function getAccessToken() {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('freee_oauth_tokens')
    .select('access_token, expires_at')
    .eq('id', 1)
    .single();

  if (error || !data) {
    throw new Error('freee_oauth_tokens row missing — run scripts/seed-freee-tokens.mjs first');
  }

  const expiresAt = new Date(data.expires_at).getTime();
  if (expiresAt - Date.now() < 300 * 1000) {
    return refreshTokenOnce();
  }

  return data.access_token;
}

export async function refreshToken() {
  const clientId = process.env.FREEE_CLIENT_ID;
  const clientSecret = process.env.FREEE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('FREEE_CLIENT_ID, FREEE_CLIENT_SECRET が必要です');
  }

  const currentTokens = await loadTokensFromDb();
  const currentRefreshToken = currentTokens.refresh_token;

  if (!currentRefreshToken) {
    throw new Error('freee_oauth_tokens row missing refresh_token');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: currentRefreshToken,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`トークンリフレッシュ失敗: ${res.status} ${err}`);
  }

  const data = await res.json();

  if (!data.access_token) {
    throw new Error(`トークンリフレッシュ失敗: ${JSON.stringify(data)}`);
  }

  const newAccessToken = data.access_token;
  const newRefreshToken = data.refresh_token || currentRefreshToken;
  const expiresAt = new Date(Date.now() + (data.expires_in ?? 21600) * 1000).toISOString();

  await saveTokensToDb({
    access_token: newAccessToken,
    refresh_token: newRefreshToken,
    expires_at: expiresAt,
  });

  const tail4 = (t) => t.slice(-4);
  logger.info('freee: token refreshed', {
    access_token: tail4(newAccessToken),
    refresh_token: tail4(newRefreshToken),
  });

  return newAccessToken;
}

// トークンリフレッシュの重複実行を防ぐ
let _refreshPromise = null;

async function refreshTokenOnce() {
  if (_refreshPromise) {
    return _refreshPromise;
  }
  _refreshPromise = refreshToken().finally(() => {
    _refreshPromise = null;
  });
  return _refreshPromise;
}

export async function freeeApiFetch(url, options = {}) {
  const token = await getAccessToken();
  const headers = { ...options.headers };
  headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { ...options, headers });

  // 401なら1回だけリフレッシュしてリトライ
  if (res.status === 401) {
    logger.info('freee: 401 received, refreshing token');
    try {
      const newToken = await refreshTokenOnce();
      const retryHeaders = { ...options.headers };
      retryHeaders['Authorization'] = `Bearer ${newToken}`;
      return fetch(url, { ...options, headers: retryHeaders });
    } catch (e) {
      logger.error('freee: token refresh failed', { err: e });
      return res;
    }
  }

  return res;
}

export default { getAccessToken, freeeApiFetch, refreshToken };
