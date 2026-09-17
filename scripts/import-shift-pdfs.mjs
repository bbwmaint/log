#!/usr/bin/env node
/**
 * BBW — import BrewQM Packaging Shift Report PDFs from email into the schedule.
 * ---------------------------------------------------------------------------
 * Polls an IMAP mailbox, finds shift-report PDF attachments, reads
 * date / shift / total volume (hL) / productivity, and writes them into
 * bbw_schedule (dHL+dProd for a day report, nHL+nProd for a night one).
 *
 * Each report is applied exactly ONCE — a marker per (date, shift) is kept in
 * bbw_report_sent — so re-runs are idempotent and your later manual edits to a
 * day are never clobbered by a repeat of the same email.
 *
 * Source-agnostic: works with any IMAP mailbox — your Outlook (if IMAP is on)
 * or a dedicated Gmail relay. Only the env vars change. See the setup note.
 *
 * Env:   IMAP_HOST  IMAP_PORT(993)  IMAP_USER  IMAP_PASS  IMAP_FOLDER(INBOX)
 *        SUPABASE_URL  SUPABASE_KEY   LOOKBACK_DAYS(7)
 * Flags: --dry-run  (parse + print, write nothing)     --lookback N
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import os from 'os';
import path from 'path';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val  = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };

const DRY      = flag('dry-run');
const SB_URL   = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY   = process.env.SUPABASE_KEY || '';
const IMAP_HOST   = process.env.IMAP_HOST || '';
const IMAP_PORT   = +(process.env.IMAP_PORT || 993);
const IMAP_USER   = process.env.IMAP_USER || '';
const IMAP_PASS   = process.env.IMAP_PASS || '';
const IMAP_FOLDER = process.env.IMAP_FOLDER || 'INBOX';
const LOOKBACK    = +(val('lookback') || process.env.LOOKBACK_DAYS || 7);

/* ── extract the 4 fields (same rules as the in-app importer) ───────────────── */
function extract(t) {
  const date = (t.match(/Date\s+(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
  const sm = t.match(/Shift\s+([A-D])\s*\((day|night)\)/i);
  const dayNight = sm ? sm[2].toLowerCase() : null;
  const vm = t.match(/Totals:\s*[\d,]+\s+([\d,.]+)\s+[\d,]+/);   // cans  volHL  min
  const volHL = vm ? parseFloat(vm[1].replace(/,/g, '')) : null;
  const pm = t.match(/Productivity[\s\S]*?(\d{1,3})\s*%/);       // the report's only %
  const prodPct = pm ? +pm[1] : null;
  return { date, dayNight, volHL, prodPct };
}
function pdfText(buf) {
  const tmp = path.join(os.tmpdir(), `sr_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(tmp, buf);
  try { return execFileSync('pdftotext', ['-layout', tmp, '-'], { maxBuffer: 32 * 1024 * 1024 }).toString(); }
  finally { try { unlinkSync(tmp); } catch (e) {} }
}

/* ── supabase ──────────────────────────────────────────────────────────────── */
function sb(p, opts = {}) {
  return fetch(`${SB_URL}/rest/v1/${p}`, {
    signal: AbortSignal.timeout(25000), ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
}
async function sbGet(p) { const r = await sb(p); const b = await r.text(); if (!r.ok) throw new Error(`${r.status} ${b.slice(0, 160)}`); return JSON.parse(b); }
async function alreadyDone(id) { return (await sbGet('bbw_report_sent?select=id&id=eq.' + encodeURIComponent(id))).length > 0; }
async function markDone(id) {
  await sb('bbw_report_sent', {
    method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ id, claimed_at: new Date().toISOString(), sent_at: new Date().toISOString() })
  });
}
async function loadTechSched() {
  const r = await sbGet('bbw_schedule?select=id,data&id=eq.tech');
  return (r[0] && r[0].data && typeof r[0].data === 'object') ? r[0].data : {};
}
async function saveTechSched(data) {
  const r = await sb('bbw_schedule', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: 'tech', data })
  });
  if (!r.ok) throw new Error('schedule write failed: ' + r.status + ' ' + (await r.text()).slice(0, 160));
}

/* ── main ──────────────────────────────────────────────────────────────────── */
async function main() {
  if (!IMAP_HOST || !IMAP_USER || !IMAP_PASS) throw new Error('IMAP_HOST / IMAP_USER / IMAP_PASS are required.');
  if (!DRY && (!SB_URL || !SB_KEY)) throw new Error('SUPABASE_URL / SUPABASE_KEY are required (or use --dry-run).');

  const client = new ImapFlow({ host: IMAP_HOST, port: IMAP_PORT, secure: true, auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false });
  await client.connect();
  const found = [];
  const lock = await client.getMailboxLock(IMAP_FOLDER);
  try {
    const since = new Date(Date.now() - LOOKBACK * 86400000);
    for await (const msg of client.fetch({ since }, { uid: true, source: true })) {
      let parsed; try { parsed = await simpleParser(msg.source); } catch (e) { continue; }
      for (const att of (parsed.attachments || [])) {
        const isPdf = (att.contentType === 'application/pdf') || /\.pdf$/i.test(att.filename || '');
        if (!isPdf || !att.content) continue;
        let rec; try { rec = extract(pdfText(att.content)); } catch (e) { continue; }
        if (rec.date && rec.volHL != null) found.push({ ...rec, file: att.filename || 'report.pdf' });
      }
    }
  } finally { lock.release(); }
  await client.logout();

  console.log(`Scanned last ${LOOKBACK} days of "${IMAP_FOLDER}" — ${found.length} shift report PDF(s) parsed.`);
  if (!found.length) return;

  // Which are new? (skip anything already imported)
  let skipped = 0;
  const toApply = [];
  for (const r of found) {
    const dn = r.dayNight || 'day';
    const id = `SHIFTPDF_${r.date}_${dn}`;
    if (!DRY && await alreadyDone(id)) { skipped++; console.log(`  · already imported: ${r.date} ${dn}`); continue; }
    toApply.push({ ...r, dn, id });
  }
  // collapse duplicate (date, shift) within this batch — keep the last one seen
  const uniq = {}; toApply.forEach(r => { uniq[r.id] = r; });
  const list = Object.values(uniq);

  if (DRY) {
    console.log(`\n--- DRY RUN — nothing written ---`);
    list.forEach(r => console.log(`  ${r.date} ${r.dn}: dHL/nHL ${r.volHL} hL, prod ${r.prodPct == null ? '—' : r.prodPct + '%'}  [${r.file}]`));
    console.log(`Would apply ${list.length}, skip ${skipped}.`);
    return;
  }
  if (!list.length) { console.log(`Nothing new (skipped ${skipped}).`); return; }

  const sched = await loadTechSched();
  for (const r of list) {
    const o = sched[r.date] || {};
    if (r.dn === 'night') { o.nHL = r.volHL; if (r.prodPct != null) o.nProd = r.prodPct; }
    else                  { o.dHL = r.volHL; if (r.prodPct != null) o.dProd = r.prodPct; }
    sched[r.date] = o;
  }
  await saveTechSched(sched);
  for (const r of list) { await markDone(r.id); console.log(`  ✓ applied ${r.date} ${r.dn} — ${r.volHL} hL, ${r.prodPct == null ? '—' : r.prodPct + '%'}`); }
  console.log(`Done: applied ${list.length}, skipped ${skipped}.`);
}

main().catch(e => { console.error('FATAL:', e && e.message || e); process.exit(1); });
