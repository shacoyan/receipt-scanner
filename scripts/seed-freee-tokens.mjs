import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envPath = resolve(__dirname, '../.env');

try {
  const envContent = readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) return;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
} catch {
  // .env が存在しない場合は無視（プロセス環境変数のみ利用）
}

const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'FREEE_ACCESS_TOKEN',
  'FREEE_REFRESH_TOKEN'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const access_token = process.env.FREEE_ACCESS_TOKEN;
const refresh_token = process.env.FREEE_REFRESH_TOKEN;
const expires_in = Number(process.env.FREEE_TOKEN_EXPIRES_IN || 21600);

const expires_at = new Date(Date.now() + expires_in * 1000).toISOString();

const supabase = createClient(supabaseUrl, supabaseKey);

const { error } = await supabase
  .from('freee_oauth_tokens')
  .upsert(
    {
      id: 1,
      access_token,
      refresh_token,
      expires_at
    },
    { onConflict: 'id' }
  );

if (error) {
  console.error('Failed to upsert freee OAuth tokens:', error.message);
  process.exit(1);
}

console.log({
  id: 1,
  expires_at,
  access_token_tail: access_token.slice(-4),
  refresh_token_tail: refresh_token.slice(-4)
});
