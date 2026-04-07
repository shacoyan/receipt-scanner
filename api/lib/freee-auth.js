// freee認証ヘルパー
// - トークン自動リフレッシュ付きAPI呼び出し

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';

function getEnvPath() {
  // api/lib/freee-auth.js → receipt-scanner/.env
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, '../../.env');
}

export function getAccessToken() {
  return process.env.FREEE_ACCESS_TOKEN || '';
}

export async function refreshToken() {
  const clientId = process.env.FREEE_CLIENT_ID;
  const clientSecret = process.env.FREEE_CLIENT_SECRET;
  const currentRefreshToken = process.env.FREEE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !currentRefreshToken) {
    throw new Error('FREEE_CLIENT_ID, FREEE_CLIENT_SECRET, FREEE_REFRESH_TOKEN が必要です');
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

  // process.env を更新
  process.env.FREEE_ACCESS_TOKEN = data.access_token;
  if (data.refresh_token) {
    process.env.FREEE_REFRESH_TOKEN = data.refresh_token;
  }

  // .env ファイルを更新
  try {
    const envPath = getEnvPath();
    let env = readFileSync(envPath, 'utf-8');
    env = env.replace(/FREEE_ACCESS_TOKEN=.*/, `FREEE_ACCESS_TOKEN=${data.access_token}`);
    if (data.refresh_token) {
      env = env.replace(/FREEE_REFRESH_TOKEN=.*/, `FREEE_REFRESH_TOKEN=${data.refresh_token}`);
    }
    writeFileSync(envPath, env);
    console.log('freee: トークンをリフレッシュしました');
  } catch (e) {
    console.warn('freee: .envファイルの更新に失敗しました（process.envは更新済み）:', e.message);
  }

  return data.access_token;
}

export async function freeeApiFetch(url, options = {}) {
  const headers = { ...options.headers };
  headers['Authorization'] = `Bearer ${getAccessToken()}`;

  const res = await fetch(url, { ...options, headers });

  // 401なら1回だけリフレッシュしてリトライ
  if (res.status === 401) {
    console.log('freee: 401を受信、トークンをリフレッシュします...');
    try {
      const newToken = await refreshToken();
      const retryHeaders = { ...options.headers };
      retryHeaders['Authorization'] = `Bearer ${newToken}`;
      return fetch(url, { ...options, headers: retryHeaders });
    } catch (e) {
      console.error('freee: トークンリフレッシュに失敗:', e.message);
      return res;
    }
  }

  return res;
}

export default { getAccessToken, freeeApiFetch, refreshToken };
