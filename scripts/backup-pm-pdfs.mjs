#!/usr/bin/env node
/**
 * BBW — back up PM Completion Report PDFs to OneDrive (via email → Power Automate).
 * ---------------------------------------------------------------------------
 * For every PM work order completed since the last run, this re-creates the exact
 * PM Completion Report PDF the app produces (loaded headless from the live
 * index.html — same technique as the weekly machine report) and:
 *   1. uploads it to Supabase Storage (bbw-docs/pm-reports/) — an immediate,
 *      durable copy, reusing the bucket the shift/machine reports already use;
 *   2. emails it as an attachment to a mailbox a no-code Power Automate flow
 *      watches, which drops the attachment into the shared OneDrive folder.
 * This is the exact mirror of the L1 schedule import (Power Automate bridges
 * OneDrive/SharePoint and email; the Action just uses the mailbox) — only here
 * the Action SENDS via SMTP and Power Automate WRITES to OneDrive. No Microsoft
 * Graph, no Azure app registration.
 *
 * Idempotent: each completion is backed up exactly once (marker
 * PMBK_<woId>_<completedDate> in bbw_report_sent). Re-runs never duplicate.
 *
 * Secrets you already have:  SUPABASE_URL  SUPABASE_KEY   (+ IMAP_USER/IMAP_PASS,
 *   reused as the SMTP login when SMTP_* aren't set)
 * New (repo variable, not secret):  PM_BACKUP_TO  = the mailbox Power Automate watches
 * SMTP (defaults to the IMAP_* mailbox):  SMTP_HOST  SMTP_PORT(465)  SMTP_USER
 *   SMTP_PASS  SMTP_SECURE  PM_BACKUP_FROM
 * Optional env:  PM_BACKUP_SUBJECT('BBW PM Backup')  PDF_BUCKET('bbw-docs')
 *                APP_HTML('./index.html')  LOOKBACK_DAYS(30)  MAX_ATTACH(8)  MAX_PER_RUN(60)
 *                STORAGE_BACKUP('1' on; '0' to skip the Supabase copy)
 * Flags: --dry-run (render + save PDFs locally, send/store/mark nothing)
 *        --force (ignore markers)  --lookback N  --since YYYY-MM-DD  --limit N
 */
import { chromium } from 'playwright';
import nodemailer from 'nodemailer';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val  = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };

const DRY    = flag('dry-run');
const FORCE  = flag('force');
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_KEY || '';
const INDEX  = process.env.APP_HTML || path.resolve(process.cwd(), 'index.html');
const LOOKBACK = +(val('lookback') || process.env.LOOKBACK_DAYS || 30);
const SINCE  = val('since') || null;
const LIMIT  = +(val('limit') || process.env.MAX_PER_RUN || 60);
const MAX_ATTACH = +(process.env.MAX_ATTACH || 30);              // ~30 × 0.47 MB ≈ 14 MB — safe under Gmail's 25 MB
const BUCKET = process.env.PDF_BUCKET || 'bbw-docs';
const STORE  = !/^(0|false|no)$/i.test(process.env.STORAGE_BACKUP || '1');

// Send through the SAME maintenance mailbox the L1 / shift imports already read
// from — SMTP this time instead of IMAP. Defaults to the IMAP_* creds, so for a
// Gmail relay (app password works for both) there are no new secrets; for Outlook
// set SMTP_HOST (smtp.office365.com) + SMTP_PORT 587.
const IMAP_HOST = process.env.IMAP_HOST || '';
const SMTP_HOST = process.env.SMTP_HOST || (IMAP_HOST ? IMAP_HOST.replace(/^imap\./i, 'smtp.') : '');
const SMTP_PORT = +(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || process.env.IMAP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || process.env.IMAP_PASS || '';
const SMTP_SECURE = /^(1|true|yes)$/i.test(process.env.SMTP_SECURE || (SMTP_PORT === 465 ? 'true' : 'false'));
const FROM    = process.env.PM_BACKUP_FROM || SMTP_USER;
const TO      = (process.env.PM_BACKUP_TO || '').split(',').map(s => s.trim()).filter(Boolean);
const SUBJECT = process.env.PM_BACKUP_SUBJECT || 'BBW PM Backup';

function isoOf(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
// Readable, SharePoint-safe filename led by the asset so files group by machine in the
// folder, e.g. "PALLETIZER - Monthly Lubrication (SM184) - 2026-10-08.pdf".
function _san(s){ return String(s == null ? '' : s).replace(/[\\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function _cap(s, n){ s = _san(s); return s.length > n ? s.slice(0, n).trim() : s; }
function pmFileName(w, date) {
  const asset = _cap(w.asset || w.asset_code || 'Unknown asset', 60);
  const name  = _cap(w.description || w.pm_code || 'PM', 80);
  const code  = _san(w.pm_code || '');
  const base  = `${asset} - ${name}${code ? ` (${code})` : ''} - ${date}`;
  return base.slice(0, 180).trim() + '.pdf';
}

/* ── supabase ─────────────────────────────────────────────────────────────── */
function sb(p, opts = {}) {
  return fetch(`${SB_URL}/rest/v1/${p}`, {
    signal: AbortSignal.timeout(25000), ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
}
async function sbGet(p, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { const r = await sb(p); const b = await r.text(); if (!r.ok) throw new Error(`${r.status} ${b.slice(0,160)}`); return JSON.parse(b); }
    catch (e) { last = e; await new Promise(s => setTimeout(s, 500 * (i + 1))); }
  }
  throw last;
}
async function pageAll(p) {
  let all = [], from = 0;
  for (;;) {
    const r = await sb(p, { headers: { Range: `${from}-${from + 999}` } });
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error('bad rows: ' + JSON.stringify(rows).slice(0, 160));
    all = all.concat(rows); if (rows.length < 1000) break; from += 1000;
  }
  return all;
}
async function markerExists(id) {
  const rows = await sbGet('bbw_report_sent?select=id&id=eq.' + encodeURIComponent(id));
  return !!(rows && rows.length);
}
async function recordMarker(id) {
  const now = new Date().toISOString();
  const r = await sb('bbw_report_sent', {
    method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ id, claimed_at: now, sent_at: now })
  });
  if (!r.ok) console.warn(`WARNING: backed up but could not record marker ${id} (${r.status}).`);
}
async function uploadToStorage(filename, buf) {
  const p = `pm-reports/${filename}`;
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${encodeURI(p)}`, {
    signal: AbortSignal.timeout(30000), method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
    body: buf
  });
  if (!r.ok) throw new Error(`storage ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return `${SB_URL}/storage/v1/object/public/${BUCKET}/${encodeURI(p)}`;
}

/* ── render all target PDFs in one headless session ───────────────────────── */
async function renderPDFs(targets) {
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'], proxy });
  const out = [];
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    const warns = []; page.on('pageerror', e => warns.push(e.message));
    await page.goto('file://' + INDEX, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.jspdf && window.jspdf.jsPDF, { timeout: 30000 }).catch(() => {});
    await page.evaluate(async () => {
      user = (typeof EDITORS !== 'undefined' && EDITORS[0]) || 'Praful';
      try { loadSchedulesFromStorage && loadSchedulesFromStorage(); } catch (e) {}
      try { await loadCMMS(true); } catch (e) {}
      try { await loadWOs(true); } catch (e) {}
    });
    for (const w of targets) {
      const res = await page.evaluate(async (wo) => {
        try {
          var pm = (CMMS_PMS || []).filter(x => x.code === wo.pm_code)[0] || {};
          var pl = {
            code: wo.pm_code, asset: wo.asset, assetCode: wo.asset_code,
            name: wo.description || pm.description, type: wo.wo_type || pm.pm_type,
            desc: pm.description, tasks: (typeof pmTasksFor === 'function' ? pmTasksFor(wo.pm_code) : []),
            who: wo.completed_by, date: ('' + (wo.completed_at || '')).slice(0, 10),
            hours: wo.hours_spent, notes: wo.notes
          };
          var _JS = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
          if (!_JS) return { err: 'jsPDF not loaded' };
          var buf = null;
          function Wrapped() { var inst = new _JS(...arguments); inst.save = function () { try { buf = inst.output('arraybuffer'); } catch (e) {} return inst; }; return inst; }
          Wrapped.prototype = _JS.prototype;
          if (window.jspdf) window.jspdf.jsPDF = Wrapped; window.jsPDF = Wrapped;
          pmCompletionPDF(pl);
          if (window.jspdf) window.jspdf.jsPDF = _JS; window.jsPDF = _JS;
          if (!buf) return { err: 'no bytes' };
          var bytes = new Uint8Array(buf), bin = ''; for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          return { b64: btoa(bin) };
        } catch (e) { return { err: e.message }; }
      }, w);
      if (res.err) { console.warn(`  ! ${w.pm_code} WO#${w.id}: ${res.err}`); continue; }
      const date = ('' + (w.completed_at || '')).slice(0, 10);
      out.push({ wo: w, filename: pmFileName(w, date), buf: Buffer.from(res.b64, 'base64') });
    }
    if (warns.length) console.warn('  (app warnings: ' + warns.slice(0, 3).join(' | ') + ')');
  } finally { await browser.close(); }
  return out;
}

/* ── email a batch of PDFs as attachments (SMTP via the maintenance mailbox) ─ */
async function sendBatch(pdfs) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE, auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  const names = pdfs.map(p => p.filename);
  const text = 'Automated backup of completed PM reports.\n\n' + names.map(n => ' - ' + n).join('\n') +
               '\n\nThese are filed into the shared OneDrive folder by Power Automate.';
  await transporter.sendMail({
    from: FROM, to: TO.join(', '),
    subject: `${SUBJECT}: ${pdfs.length} PM report${pdfs.length === 1 ? '' : 's'} · ${isoOf(new Date())}`,
    text,
    attachments: pdfs.map(p => ({ filename: p.filename, content: p.buf, contentType: 'application/pdf' }))
  });
}

/* ── main ─────────────────────────────────────────────────────────────────── */
(async () => {
  if (!SB_URL || !SB_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_KEY'); process.exit(1); }
  const since = SINCE || isoOf(new Date(Date.now() - LOOKBACK * 86400000));
  console.log(`PM-PDF backup — completions on/after ${since}${DRY ? '  [DRY RUN]' : ''}`);

  const wos = await pageAll(
    'bbw_wos?select=id,pm_code,asset,asset_code,description,wo_type,completed_by,completed_at,hours_spent,notes,status' +
    '&status=eq.completed&pm_code=not.is.null&completed_at=gte.' + encodeURIComponent(since + 'T00:00:00') +
    '&order=completed_at.asc'
  );
  console.log(`Completed PM work orders in window: ${wos.length}`);

  const todo = [];
  for (const w of wos) {
    const date = ('' + (w.completed_at || '')).slice(0, 10);
    w._marker = `PMBK_${w.id}_${date}`;
    if (!FORCE && await markerExists(w._marker)) continue;
    todo.push(w);
    if (todo.length >= LIMIT) break;
  }
  console.log(`New completions to back up: ${todo.length}${todo.length >= LIMIT ? ` (capped at ${LIMIT})` : ''}`);
  if (!todo.length) { console.log('Nothing to do.'); return; }

  const pdfs = await renderPDFs(todo);
  console.log(`Rendered ${pdfs.length} PDF${pdfs.length === 1 ? '' : 's'}.`);
  if (!pdfs.length) { console.log('No PDFs rendered — nothing sent.'); return; }

  if (DRY) {
    const dir = path.resolve(process.cwd(), 'pm-backup-dryrun');
    mkdirSync(dir, { recursive: true });
    pdfs.forEach(p => writeFileSync(path.join(dir, p.filename), p.buf));
    console.log(`[DRY RUN] wrote ${pdfs.length} PDF(s) to ${dir}. Nothing stored, emailed, or marked.`);
    return;
  }

  // 1) durable copy in Supabase Storage (independent of the OneDrive hop)
  if (STORE) {
    for (const p of pdfs) {
      try { await uploadToStorage(p.filename, p.buf); } catch (e) { console.warn(`  storage: ${p.filename} ${e.message}`); }
    }
    console.log(`Stored ${pdfs.length} in ${BUCKET}/pm-reports/.`);
  }

  // 2) email as attachments → Power Automate files them into OneDrive
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !TO.length) {
    console.log('SMTP_* / PM_BACKUP_TO not all set — skipping the email step.' +
      (STORE ? ' PDFs are still saved in Supabase Storage.' : '') + ' (Markers not written, so it retries once configured.)');
    return;
  }
  for (let i = 0; i < pdfs.length; i += MAX_ATTACH) {
    const batch = pdfs.slice(i, i + MAX_ATTACH);
    await sendBatch(batch);
    for (const p of batch) await recordMarker(p.wo._marker);
    console.log(`Emailed + recorded ${batch.length} (${Math.min(i + MAX_ATTACH, pdfs.length)}/${pdfs.length}).`);
  }
  console.log('Done.');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
