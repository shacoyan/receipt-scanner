// freee OAuthトークン取得スクリプト
// 使い方: node get-token.mjs

import http from 'http';
import { exec } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

const CLIENT_ID = '697691806595039';
const CLIENT_SECRET = 'BD8AMM9kYBF3RAZG1pOaVL1N8tTHLay0bol7TN10N1rpKOVUJsmkCJp0TNnX9pIhcbuBn2QWBCk-zj0gUFZmlw';
const REDIRECT_URI = 'http://localhost:3000/callback';
const AUTH_URL = `https://accounts.secure.freee.co.jp/public_api/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=read+write`;

console.log('\n🚀 freee認証を開始します...');
console.log('ブラウザが開きます。freeeでログイン・承認してください。\n');

// 一時サーバーを起動してcallbackを受け取る
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3000');
  const code = url.searchParams.get('code');

  if (!code) {
    res.end('コードが取得できませんでした');
    return;
  }

  console.log('✅ 認証コードを取得しました。トークンを取得中...');

  try {
    const tokenRes = await fetch('https://accounts.secure.freee.co.jp/public_api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      throw new Error(JSON.stringify(tokenData));
    }

    // .envに書き込む
    let env = readFileSync('.env', 'utf-8');
    env = env.replace(/FREEE_ACCESS_TOKEN=.*/, `FREEE_ACCESS_TOKEN=${tokenData.access_token}`);
    writeFileSync('.env', env);

    console.log('✅ アクセストークンを .env に保存しました！');
    console.log('\n次に会社IDを取得します...');

    // 会社IDを自動取得
    const companyRes = await fetch('https://api.freee.co.jp/api/1/companies', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const companyData = await companyRes.json();
    const companies = companyData.companies ?? [];

    if (companies.length > 0) {
      const company = companies[0];
      env = readFileSync('.env', 'utf-8');
      env = env.replace(/FREEE_COMPANY_ID=.*/, `FREEE_COMPANY_ID=${company.id}`);
      writeFileSync('.env', env);
      console.log(`✅ 会社ID「${company.display_name}（ID: ${company.id}）」を .env に保存しました！`);
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>✅ 認証完了！</h1><p>ターミナルを確認してください。このページは閉じて大丈夫です。</p>');

    console.log('\n🎉 セットアップ完了！アプリを起動できます。');
    server.close();
  } catch (e) {
    console.error('❌ エラー:', e.message);
    res.end('エラーが発生しました: ' + e.message);
    server.close();
  }
});

server.listen(3000, () => {
  // ブラウザを開く
  const cmd = process.platform === 'darwin' ? `open "${AUTH_URL}"` : `start "${AUTH_URL}"`;
  exec(cmd);
});
