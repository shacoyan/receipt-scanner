#!/usr/bin/env node

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeeApiFetch } from '../api/lib/freee-auth.js';
import { getSupabase } from '../api/lib/supabase.js';

// ─── CLI flags ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const isApply = argv.includes('--apply');
const idFlag = argv.find(a => a.startsWith('--id='));
const limitFlag = argv.find(a => a.startsWith('--limit='));
const idFilter = idFlag ? idFlag.split('=')[1] : null;
const limit = limitFlag ? Number(limitFlag.split('=')[1]) : null;
const mode = isApply ? 'apply' : 'dry-run';

// ─── .env loader (same as seed-freee-tokens.mjs) ───────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
} catch {}

// ─── env checks ─────────────────────────────────────────────────────────────
const FREEE_COMPANY_ID = process.env.FREEE_COMPANY_ID;
if (!FREEE_COMPANY_ID) {
  console.error('FREEE_COMPANY_ID is required');
  process.exit(1);
}
const COMPANY_ID_NUM = Number(FREEE_COMPANY_ID);

// ─── signal handling ────────────────────────────────────────────────────────
let stopping = false;
const onSignal = () => { stopping = true; };
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

// ─── helpers ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function stripNullsAndUndef(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

function buildPayload(deal) {
  const details = (deal.details || []).map(d => {
    const mapped = {
      id: d.id,
      account_item_id: d.account_item_id,
      amount: d.amount,
      description: d.description,
      section_id: d.section_id,
      tag_ids: d.tag_ids,
      item_id: d.item_id,
      segment_1_tag_id: d.segment_1_tag_id,
      segment_2_tag_id: d.segment_2_tag_id,
      segment_3_tag_id: d.segment_3_tag_id,
      entry_side: d.entry_side,
      tax_code: d.tax_code === 137 ? 163 : d.tax_code,
      // vat is intentionally omitted — freee recalculates
    };
    return stripNullsAndUndefined(mapped);
  });

  const payments = (deal.payments || []).map(p =>
    stripNullsAndUndefined({
      date: p.date,
      from_walletable_type: p.from_walletable_type,
      from_walletable_id: p.from_walletable_id,
      amount: p.amount,
    })
  );

  return stripNullsAndUndefined({
    company_id: COMPANY_ID_NUM,
    issue_date: deal.issue_date,
    type: deal.type,
    partner_id: deal.partner_id,
    ref_number: deal.ref_number,
    receipt_ids: deal.receipt_ids,
    details,
    payments: payments.length ? payments : undefined,
  });
}

// alias used inside buildPayload
function stripNullsAndUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

// ─── retry wrapper ──────────────────────────────────────────────────────────
async function putDealWithRetry(dealId, payload) {
  const url = `https://api.freee.co.jp/api/1/deals/${dealId}`;
  const opts = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };

  // 429 handler
  const tryOnce = async () => freeeApiFetch(url, opts);

  // exponential backoff for 5xx / network
  const backoff = [5000, 15000, 45000];
  for (let i = 0; i <= 3; i++) {
    try {
      const res = await tryOnce();
      if (res.status === 200 || res.status === 201) return res;
      if (res.status === 429) {
        const ra = res.headers.get('Retry-After');
        const wait = ra ? Number(ra) * 1000 : 60000;
        console.log(`  429 → sleeping ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (res.status >= 500 && res.status <= 504 && i < 3) {
        console.log(`  ${res.status} → retry ${i + 1}/3`);
        await sleep(backoff[i]);
        continue;
      }
      if (res.status >= 400 && res.status < 500) {
        const body = await res.text();
        return { status: res.status, body, _failed: true };
      }
      return { status: res.status, body: await res.text(), _failed: true };
    } catch (err) {
      if (i < 3) {
        console.log(`  network error → retry ${i + 1}/3`);
        await sleep(backoff[i]);
        continue;
      }
      return { status: 0, err: err.message, _failed: true };
    }
  }
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = new Date().toISOString();
  const log = { startedAt, finishedAt: null, mode, limit, idFilter, summary: { ok: 0, skipped: 0, failed: 0, total: 0 }, ok: [], skipped: [], failed: [] };
  const supabase = await getSupabase();

  // migration 003 check
  const { error: colErr } = await supabase
    .from('receipts')
    .select('freee_corrected_at')
    .limit(0);
  if (colErr) {
    console.error('[fatal] receipts.freee_corrected_at column missing. Apply migration 003 first.', colErr);
    process.exit(1);
  }

  // fetch targets
  let query = supabase.from('receipts').select('id, freee_deal_id, freee_sent_at, freee_corrected_at, result_json');
  if (idFilter) {
    query = query.eq('id', idFilter);
  } else {
    query = query.not('freee_deal_id', 'is', null).is('freee_corrected_at', null)
      .order('freee_sent_at', { ascending: true });
  }
  if (limit) query = query.limit(limit);

  const { data: rawReceipts, error: fetchErr } = await query;
  if (fetchErr) {
    console.error('Supabase fetch error:', fetchErr);
    process.exit(1);
  }

  // client-side filtering for tax_code 163
  let receipts;
  if (idFilter) {
    receipts = rawReceipts;
  } else {
    receipts = rawReceipts.filter(r =>
      r.result_json?.tax_code === 163 || (Array.isArray(r.result_json?.splits) && r.result_json.splits.some(s => s.tax_code === 163))
    );
  }

  log.summary.total = receipts.length;
  let consecutiveFails = 0;

  for (let i = 0; i < receipts.length; i++) {
    if (stopping) break;
    const r = receipts[i];
    const dealId = r.freee_deal_id;

    try {
      // GET deal
      let deal;
      try {
        const gr = await freeeApiFetch(
          `https://api.freee.co.jp/api/1/deals/${dealId}?company_id=${FREEE_COMPANY_ID}&accruals=with`
        );
        const gj = await gr.json();
        deal = gj.deal;
      } catch (e) {
        log.failed.push({ receiptId: r.id, dealId, status: 0, err: e.message });
        log.summary.failed++;
        consecutiveFails++;
        if (consecutiveFails >= 5) { console.error('5 consecutive failures — aborting'); await finalize(log); process.exit(2); }
        continue;
      }

      const hits = (deal.details || []).filter(d => d.tax_code === 137);
      if (!hits.length) {
        if (isApply) {
          await supabase.from('receipts').update({ freee_corrected_at: new Date().toISOString() }).eq('id', r.id);
        }
        log.skipped.push({ receiptId: r.id, dealId, reason: 'no_137_detail', status: 'skipped_already_corrected' });
        log.summary.skipped++;
        console.log(`[SKIP] dealId=${dealId} reason=no_137_detail`);
        consecutiveFails = 0;
        continue;
      }

      const before = hits.map(d => ({ detailId: d.id, tax_code: d.tax_code }));
      const payload = buildPayload(deal);
      const after = payload.details
        .filter(d => hits.some(h => h.id === d.id))
        .map(d => ({ detailId: d.id, tax_code: d.tax_code }));

      if (mode === 'dry-run') {
        log.ok.push({ receiptId: r.id, dealId, dryRun: true, before, after, durationMs: 0 });
        log.summary.ok++;
        console.log(`[DRY-RUN] dealId=${dealId} would change 137→163 (${hits.length} detail)`);
        consecutiveFails = 0;
        continue;
      }

      // apply mode
      const t0 = Date.now();
      const res = await putDealWithRetry(dealId, payload);
      const dur = Date.now() - t0;

      if (res._failed) {
        log.failed.push({ receiptId: r.id, dealId, status: res.status, body: res.body, err: res.err });
        log.summary.failed++;
        console.log(`[FAIL] dealId=${dealId} status=${res.status}`);
        consecutiveFails++;
        if (consecutiveFails >= 5) { console.error('5 consecutive failures — aborting'); await finalize(log); process.exit(2); }
        continue;
      }

      // success — mark corrected
      await supabase.from('receipts').update({ freee_corrected_at: new Date().toISOString() }).eq('id', r.id);
      log.ok.push({ receiptId: r.id, dealId, applied: true, before, after, durationMs: dur });
      log.summary.ok++;
      console.log(`[OK] dealId=${dealId} 137→163 (${dur}ms)`);
      consecutiveFails = 0;
    } finally {
      if (!stopping) await sleep(1500);
    }
  }

  await finalize(log);
  process.exit(log.summary.failed > 0 ? 1 : 0);
}

async function finalize(log) {
  log.finishedAt = new Date().toISOString();
  const outDir = join(__dirname, 'output');
  mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/:/g, '-');
  const outPath = join(outDir, `fix-freee-tax-codes-${ts}.json`);
  writeFileSync(outPath, JSON.stringify(log, null, 2));
  const s = log.summary;
  console.log(`\nDone. ok=${s.ok} skipped=${s.skipped} failed=${s.failed} total=${s.total} → ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
