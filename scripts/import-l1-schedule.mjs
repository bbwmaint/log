#!/usr/bin/env node
/**
 * BBW — import the live "L1 Schedule" from an emailed xlsx into the app.
 * ---------------------------------------------------------------------------
 * A Power Automate flow (running as you) emails the SharePoint file to the
 * maintenance mailbox whenever it changes, with a fixed subject. This job reads
 * the mailbox, takes the NEWEST such email's xlsx, parses the "Packaging
 * Schedule" sheet, and upserts the runs into bbw_schedule(id='prod') — exactly
 * what the in-app "Upload Schedules" button writes. No SharePoint auth, no admin.
 *
 * Times in the sheet are Toronto wall-clock; we read the raw Excel serials and
 * convert to UTC as America/Toronto (DST-aware), so it's correct on a UTC runner.
 *
 * Env:  IMAP_HOST IMAP_PORT(993) IMAP_USER IMAP_PASS IMAP_FOLDER(INBOX)
 *       SUPABASE_URL SUPABASE_KEY
 *       SCHEDULE_SUBJECT  (substring to match, default "L1 SCHEDULE")
 *       LOOKBACK_DAYS(7)  SYNC_DAYS_BACK(3)  SYNC_DAYS_AHEAD(60)
 * Flags: --dry-run   (parse + print, write nothing)
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import XLSX from 'xlsx';

const args = process.argv.slice(2);
const DRY  = args.includes('--dry-run');
const TZ   = 'America/Toronto';
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_KEY || '';
const IMAP_HOST = process.env.IMAP_HOST || '';
const IMAP_PORT = +(process.env.IMAP_PORT || 993);
const IMAP_USER = process.env.IMAP_USER || '';
const IMAP_PASS = process.env.IMAP_PASS || '';
const IMAP_FOLDER = process.env.IMAP_FOLDER || 'INBOX';
const SUBJECT = (process.env.SCHEDULE_SUBJECT || 'L1 SCHEDULE').toLowerCase();
const LOOKBACK = +(process.env.LOOKBACK_DAYS || 7);
const DAYS_BACK  = +(process.env.SYNC_DAYS_BACK  || 3);
const DAYS_AHEAD = +(process.env.SYNC_DAYS_AHEAD || 60);

/* ── Toronto wall-clock -> correct UTC, DST-aware ──────────────────────────── */
function torontoWallToUTC(y, mo, d, h, mi, s) {
  const asUTC = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(asUTC)).reduce((o, x) => (o[x.type] = x.value, o), {});
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return new Date(asUTC - (shown - asUTC));
}
function serialToUTC(v) {
  if (typeof v !== 'number' || !(v > 1)) return null;
  const d = new Date(Math.round((v - 25569) * 86400 * 1000));
  return torontoWallToUTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}
function parseSchedule(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  const ws = wb.Sheets['Packaging Schedule'] || wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('No "Packaging Schedule" sheet.');
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  let hdr = null, hIdx = 0;
  for (let i = 0; i < Math.min(8, rows.length); i++) {
    if (rows[i] && rows[i].some(v => v === 'StartTime' || v === 'Start Time')) { hdr = rows[i]; hIdx = i; break; }
  }
  if (!hdr) throw new Error('Header row (with "StartTime") not found.');
  const ci = { product: hdr.indexOf('Product'), canSize: hdr.indexOf('Can Size'), pkgFormat: hdr.indexOf('Pkg Format'),
    start: (hdr.indexOf('StartTime') >= 0 ? hdr.indexOf('StartTime') : hdr.indexOf('Start Time')),
    finish: hdr.indexOf('Finish Time'), cleaning: hdr.indexOf('Cleaning before') };
  if (ci.start < 0) throw new Error('No StartTime column.');
  const runs = [];
  for (let r = hIdx + 1; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    const sd = serialToUTC(row[ci.start]); if (!sd || isNaN(sd)) continue;
    const fd = serialToUTC(row[ci.finish]);
    runs.push({
      product:   row[ci.product]  != null ? String(row[ci.product]).trim()   : '',
      canSize:   row[ci.canSize]  != null ? String(row[ci.canSize]).trim()   : '',
      pkgFormat: row[ci.pkgFormat]!= null ? String(row[ci.pkgFormat]).trim() : '',
      start:     sd.toISOString(),
      finish:    (fd && !isNaN(fd)) ? fd.toISOString() : null,
      cleaning:  row[ci.cleaning] != null ? String(row[ci.cleaning]).trim()  : 'None'
    });
  }
  runs.sort((a, b) => a.start.localeCompare(b.start));
  return runs;
}

async function upsertProd(prodSer) {
  const r = await fetch(`${SB_URL}/rest/v1/bbw_schedule`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: 'prod', data: prodSer })
  });
  if (!r.ok) throw new Error('Supabase upsert failed (' + r.status + '): ' + (await r.text()).slice(0, 300));
}

async function main() {
  if (!IMAP_HOST || !IMAP_USER || !IMAP_PASS) throw new Error('IMAP_HOST / IMAP_USER / IMAP_PASS are required.');
  console.log(`IMAP ${IMAP_USER}@${IMAP_HOST}:${IMAP_PORT} folder="${IMAP_FOLDER}" subject~"${SUBJECT}" lookback=${LOOKBACK}d`);

  const client = new ImapFlow({ host: IMAP_HOST, port: IMAP_PORT, secure: true, auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false });
  await client.connect();
  let best = null;  // { date, buf, file }
  const lock = await client.getMailboxLock(IMAP_FOLDER);
  try {
    const since = new Date(Date.now() - LOOKBACK * 86400000);
    for await (const msg of client.fetch({ since }, { uid: true, source: true, internalDate: true })) {
      let parsed; try { parsed = await simpleParser(msg.source); } catch { continue; }
      const subj = (parsed.subject || '').toLowerCase();
      if (subj.indexOf(SUBJECT) < 0) continue;
      const att = (parsed.attachments || []).find(a => /\.xlsx$/i.test(a.filename || '') ||
        (a.contentType || '').indexOf('spreadsheet') >= 0);
      if (!att || !att.content) continue;
      const when = parsed.date || msg.internalDate || new Date(0);
      if (!best || when > best.date) best = { date: when, buf: att.content, file: att.filename || 'schedule.xlsx' };
    }
  } finally { lock.release(); }
  await client.logout();

  if (!best) { console.log(`No "${SUBJECT}" email with an .xlsx found in the last ${LOOKBACK} days.`); return; }
  console.log(`Using newest "${SUBJECT}" email — ${best.file}, dated ${best.date.toISOString()}.`);

  const all = parseSchedule(best.buf);
  const now = Date.now(), lo = now - DAYS_BACK * 86400000, hi = now + DAYS_AHEAD * 86400000;
  const runs = all.filter(r => { const t = Date.parse(r.start); return t >= lo && t <= hi; });
  console.log(`Parsed ${all.length} runs; keeping ${runs.length} in window [-${DAYS_BACK}d, +${DAYS_AHEAD}d].`);
  if (runs.length) console.log('  first', runs[0].start, '·', runs[0].product.slice(0, 32), '| last', runs[runs.length - 1].start);

  if (DRY) { console.log('\n--- DRY RUN — nothing written. Sample:\n', JSON.stringify(runs.slice(0, 3), null, 2)); return; }
  if (!SB_URL || !SB_KEY) throw new Error('SUPABASE_URL / SUPABASE_KEY required (or use --dry-run).');
  await upsertProd(runs);
  console.log(`✓ Synced ${runs.length} runs to bbw_schedule(prod).`);
}
main().catch(e => { console.error('FATAL:', (e && e.stack) || e); process.exit(1); });
