// freee認証ヘルパー
// - トークン自動リフレッシュ (CAS UPDATE で Lambda 間 race 防止)
// - invalid_grant 救済 (他 Lambda が rotation 済みの場合 DB から最新を再取得)
// - 401 retry 失敗時の明示 Error throw + 構造化ログ

import { logger } from './logger.js';
import { getSupabase } from './supabase.js';

const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';
const REFRESH_MARGIN_MS = 300 * 1000;

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
  if (expiresAt - Date.now() < REFRESH_MARGIN_MS) {
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

  // 1. 現在のトークンを読む (CAS key として保持)
  const before = await loadTokensFromDb();
  const oldRefreshToken = before.refresh_token;
  if (!oldRefreshToken) throw new Error('freee_oauth_tokens row missing refresh_token');

  // 2. freee に POST
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: oldRefreshToken,
    }),
  });

  if (!res.ok) {
    // §3.3 構造化ログ
    const raw = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
    const errCode = parsed?.error ?? 'unknown';
    const errDesc = parsed?.error_description ?? raw;
    logger.error('freee: token refresh API failed', {
      status: res.status,
      error: errCode,
      description: errDesc,
      refresh_token_tail4: oldRefreshToken.slice(-4),
    });

    // §3.1 invalid_grant 救済
    if (res.status === 400 && errCode === 'invalid_grant') {
      const after = await loadTokensFromDb();
      const afterExpires = new Date(after.expires_at).getTime();
      if (after.refresh_token !== oldRefreshToken && afterExpires - Date.now() > REFRESH_MARGIN_MS) {
        logger.info('freee: invalid_grant detected, other lambda already refreshed — using fresh token', {
          new_refresh_token_tail4: after.refresh_token.slice(-4),
        });
        return after.access_token;
      }
    }

    throw new Error(`トークンリフレッシュ失敗: ${res.status} ${errCode}: ${errDesc}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`トークンリフレッシュ失敗: ${JSON.stringify(data)}`);
  }

  const newAccessToken = data.access_token;
  const newRefreshToken = data.refresh_token || oldRefreshToken;
  const expiresAt = new Date(Date.now() + (data.expires_in ?? 21600) * 1000).toISOString();

  // 3. CAS UPDATE
  const supabase = await getSupabase();
  const { data: updated, error: updateError } = await supabase
    .from('freee_oauth_tokens')
    .update({ access_token: newAccessToken, refresh_token: newRefreshToken, expires_at: expiresAt })
    .eq('id', 1)
    .eq('refresh_token', oldRefreshToken)   // ★ CAS condition
    .select()
    .maybeSingle();

  if (!updateError && !updated) {
    // 0 rows returned → CAS 失敗
    logger.warn('freee: CAS conflict on token update — re-reading latest tokens', {
      old_tail4: oldRefreshToken.slice(-4),
    });
    const latest = await loadTokensFromDb();
    const latestExpires = new Date(latest.expires_at).getTime();
    if (latest.refresh_token !== oldRefreshToken && latestExpires - Date.now() > REFRESH_MARGIN_MS) {
      return latest.access_token;
    }
    throw new Error('freee: CAS conflict but no fresh token found');
  }

  if (updateError) {
    throw new Error(`freee_oauth_tokens update failed: ${updateError.message}`);
  }

  logger.info('freee: token refreshed (CAS success)', {
    access_token: newAccessToken.slice(-4),
    refresh_token: newRefreshToken.slice(-4),
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

  if (res.status === 401) {
    logger.info('freee: 401 received, refreshing token');
    try {
      const newToken = await refreshTokenOnce();
      const retryHeaders = { ...options.headers };
      retryHeaders['Authorization'] = `Bearer ${newToken}`;
      const retry = await fetch(url, { ...options, headers: retryHeaders });
      if (!retry.ok) {
        const body = await retry.text();
        logger.error('freee: 401 retry still failed', {
          status: retry.status,
          body: body.slice(0, 500),
          url,
        });
        throw new Error(`freee API 401 retry failed: ${retry.status} ${body.slice(0, 500)}`);
      }
      return retry;
    } catch (e) {
      logger.error('freee: token refresh failed during 401 retry', {
        err: e.message,
        stack: e.stack,
        url,
      });
      if (e instanceof Error && e.message.startsWith('freee API 401 retry failed:')) {
        throw e;
      }
      throw new Error(`freee 認証失敗 (refresh): ${e.message}`);
    }
  }

  return res;
}

export default { getAccessToken, freeeApiFetch, refreshToken };
