#!/usr/bin/env node
/**
 * BBW — daily OVERDUE REQUESTS digest.
 * ---------------------------------------------------------------------------
 * The sibling of overdue-digest.mjs (which nags about overdue PMs). This one
 * reads the barcode work requests from Supabase (bbw_requests), finds the ones
 * still OPEN after sitting longer than the stale threshold, groups them by the
 * assigned tech, and emails one digest to the shared maintenance inbox so a
 * request can't quietly rot without anyone chasing it.
 *
 * "Open" = any status except done/cancelled. Forklift requests are left out —
 * they're routed to the forklift team, not maintenance. A request counts as
 * OVERDUE once it is at least REQUEST_STALE_DAYS old (default 4). The status is
 * shown on every line (New / In progress / Parts ordered) so the reader can
 * tell a forgotten "New" from one that's legitimately waiting on a part.
 *
 * Sent once per day (claim id OVERDUEREQ_<toronto-date> in bbw_report_sent) and
 * only when something is actually overdue — an empty email every day just
 * trains people to ignore it.
 *
 * Uses only Node's built-in fetch — no npm packages needed to run it.
 *
 * Env:   SUPABASE_URL  SUPABASE_KEY
 *        EMAILJS_PUBLIC_KEY  EMAILJS_PRIVATE_KEY  EMAILJS_SERVICE  EMAILJS_TEMPLATE
 *        DIGEST_TO(maintenancebbw@…)  REQUEST_STALE_DAYS(4)  APP_URL
 * Flags: --dry-run (print, send nothing)  --force (skip dedup)
 *        --at ISO (fake "now")  --always (send even when nothing is overdue)
 */

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val  = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };

const DRY    = flag('dry-run');
const FORCE  = flag('force');
const ALWAYS = flag('always');
const TZ         = 'America/Toronto';
const SB_URL     = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY     = process.env.SUPABASE_KEY || '';
const EJS_PUB    = process.env.EMAILJS_PUBLIC_KEY  || '';
const EJS_PRIV   = process.env.EMAILJS_PRIVATE_KEY || '';
const EJS_SVC    = process.env.EMAILJS_SERVICE  || 'service_q7rtzse';
const EJS_TPL    = process.env.EMAILJS_TEMPLATE || 'template_i01whhv';
const EJS_API    = process.env.EMAILJS_ENDPOINT || 'https://api.emailjs.com/api/v1.0/email/send';
const APP_URL    = process.env.APP_URL || 'https://bbwmaint.github.io/log/';
const STALE_DAYS = +(process.env.REQUEST_STALE_DAYS || 4);   // open this many days -> overdue
const RECIPIENTS = (process.env.DIGEST_TO || 'maintenancebbw@brunswickbierworks.com')
  .split(',').map(s => s.trim()).filter(Boolean);

/* ── dates ─────────────────────────────────────────────────────────────────── */
function torontoParts(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}
function ageDays(iso, now) {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return 0;
  const n = Math.floor((now.getTime() - t) / 86400000);
  return n > 0 ? n : 0;
}
function prettyDate(ds) { try { return new Date(ds + 'T12:00:00Z').toLocaleDateString('en-CA', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return ds; } }

/* ── supabase ──────────────────────────────────────────────────────────────── */
function sb(path, opts = {}) {
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    signal: AbortSignal.timeout(25000), ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
}
async function sbGet(path, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { const r = await sb(path); const body = await r.text(); if (!r.ok) throw new Error(`${r.status} ${body.slice(0, 160)}`); return JSON.parse(body); }
    catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 500 * (i + 1))); }
  }
  throw lastErr;
}
async function claim(id) {
  const rows = await sbGet('bbw_report_sent?select=id,sent_at&id=eq.' + encodeURIComponent(id));
  if (rows[0] && rows[0].sent_at) { console.log(`Already sent today (${rows[0].sent_at}).`); return false; }
  const ins = await sb('bbw_report_sent', {
    method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ id, claimed_at: new Date().toISOString() })
  });
  if (!ins.ok) throw new Error(`claim failed: ${ins.status}`);
  const made = await ins.json();
  if ((!Array.isArray(made) || !made.length) && !rows.length) { console.log('Another run claimed it a moment ago.'); return false; }
  return true;
}
async function confirmSent(id) {
  const r = await sb('bbw_report_sent?id=eq.' + encodeURIComponent(id), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ sent_at: new Date().toISOString() }) });
  if (!r.ok) console.warn(`WARNING: email sent but could not record it (${r.status}).`);
}
async function release(id) { try { await sb('bbw_report_sent?id=eq.' + encodeURIComponent(id), { method: 'DELETE' }); } catch (e) {} }

/* ── email ─────────────────────────────────────────────────────────────────── */
async function sendEmailTo(to, subject, text, extra) {
  const r = await fetch(EJS_API, {
    signal: AbortSignal.timeout(25000), method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: 'https://bbwmaint.github.io' },
    body: JSON.stringify({
      service_id: EJS_SVC, template_id: EJS_TPL, user_id: EJS_PUB, accessToken: EJS_PRIV,
      template_params: Object.assign({ to_email: to, subject, message: text, reporter: 'BBW Maintenance App', asset_name: 'Overdue Requests', photos: '' }, extra || {})
    })
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`EmailJS ${r.status}: ${body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 220)}`);
}

/* ── request helpers ───────────────────────────────────────────────────────── */
const STATUS_LABEL = { new: 'New', in_progress: 'In progress', parts_ordered: 'Parts ordered', done: 'Done', cancelled: 'Cancelled' };
function ownerOf(r) {
  const a = (r.assignee || '').trim();
  if (!a || /^technicians$/i.test(a)) return 'Unassigned';
  return a;
}
const isOpen  = (r) => r && r.status !== 'done' && r.status !== 'cancelled';
const isMaint = (r) => r && r.kind !== 'forklift';            // forklift goes to its own team
function reqAsset(r) { return (r.asset_name || r.department || r.asset_code || '').trim(); }
function reqText(r)  { return (((r.work || '') + '').trim()) || 'Work request'; }
function clip(s, n)  { s = s || ''; return s.length > n ? s.slice(0, n - 1).trim() + '…' : s; }

/* ── build the digest text ─────────────────────────────────────────────────── */
function buildDigest(stale, openCount, now) {
  const { date: today } = torontoParts(now);
  const SEP = '='.repeat(46), DIV = '-'.repeat(30);
  const L = [];
  L.push('BBW MAINTENANCE — OVERDUE REQUESTS');
  L.push(prettyDate(today));
  L.push('');
  L.push(`⚠ ${stale.length} overdue (open >${STALE_DAYS}d)   ·   ${openCount} open in total`);
  L.push(SEP); L.push('');

  const by = {};
  stale.forEach(r => { const o = ownerOf(r); (by[o] = by[o] || []).push(r); });
  const names = Object.keys(by).sort((a, b) => {
    if (a === 'Unassigned') return 1; if (b === 'Unassigned') return -1;
    return by[b].length - by[a].length || a.localeCompare(b);
  });
  names.forEach(nm => {
    const items = by[nm].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '')); // oldest first
    L.push(`${nm} (${items.length})`);
    items.forEach(r => {
      const d = ageDays(r.created_at, now);
      const asset = reqAsset(r);
      const txt = reqText(r);
      const st = STATUS_LABEL[r.status] || r.status || 'Open';
      L.push(`  • ${txt}${asset ? ' — ' + asset : ''}`);
      L.push(`      ${st} · opened ${(r.created_at || '').slice(0, 10)} · ${d} day${d === 1 ? '' : 's'} open`);
    });
    L.push('');
  });

  L.push('Open the app to action these: ' + APP_URL);
  L.push('');
  L.push('This is an automated nudge — please do not reply.');
  L.push('— Brunswick Bierworks Maintenance');
  return L.join('\n');
}

/* ── main ──────────────────────────────────────────────────────────────────── */
async function main() {
  const now = val('at') ? new Date(val('at')) : new Date();
  const { date: today } = torontoParts(now);
  console.log(`Overdue requests · ${today} · stale=${STALE_DAYS}d · dry=${DRY}`);

  if (!SB_URL || !SB_KEY) throw new Error('SUPABASE_URL / SUPABASE_KEY missing');

  const all = await sbGet('bbw_requests?select=id,status,kind,asset_name,asset_code,department,work,assignee,reporter,created_at&order=created_at.asc&limit=8000');
  const open  = (all || []).filter(r => isMaint(r) && isOpen(r));
  const stale = open.filter(r => ageDays(r.created_at, now) >= STALE_DAYS);

  console.log(`Open maintenance requests: ${open.length} · overdue (>=${STALE_DAYS}d): ${stale.length}`);

  if (!stale.length && !ALWAYS) { console.log('Nothing overdue — no email sent.'); return; }

  const subject = `BBW Maintenance — ${stale.length} request${stale.length === 1 ? '' : 's'} overdue (${today})`;
  const text = buildDigest(stale, open.length, now);

  // Structured fields for the branded template (falls back to `text` if not updated).
  const CAP = 15;
  const items = stale.slice(0, CAP).map(r => {
    const d = ageDays(r.created_at, now);
    const asset = reqAsset(r);
    const txt = reqText(r);
    const st = STATUS_LABEL[r.status] || r.status || 'Open';
    return {
      title: (asset ? asset + ' — ' : '') + clip(txt, 90),
      sub: st + ' · opened ' + (r.created_at || '').slice(0, 10) + ' · ' + ownerOf(r) + ' · ' + d + ' day' + (d === 1 ? '' : 's') + ' open'
    };
  });
  const digestExtra = {
    structured: true,
    kicker: 'Overdue requests · ' + prettyDate(today),
    has_rows: true,
    rows: [
      { label: 'Overdue', value: String(stale.length) + ' (open >' + STALE_DAYS + 'd)' },
      { label: 'Open total', value: String(open.length) }
    ],
    has_items: items.length > 0,
    items,
    more: Math.max(0, stale.length - CAP),
    cta_url: APP_URL,
    cta_label: 'Open the Maintenance Log'
  };

  if (DRY) { console.log(`\n--- DRY RUN — nothing sent ---\nTo: ${RECIPIENTS.join(', ')}\nSubject: ${subject}\n\n${text}`); return; }
  if (!RECIPIENTS.length) throw new Error('DIGEST_TO is empty — refusing to send.');
  if (!EJS_PUB || !EJS_PRIV) throw new Error('EMAILJS_PUBLIC_KEY / EMAILJS_PRIVATE_KEY missing');

  const claimId = `OVERDUEREQ_${today}`;
  if (!FORCE && !(await claim(claimId))) return;

  try {
    for (const to of RECIPIENTS) { await sendEmailTo(to, subject, text, digestExtra); console.log(`SENT to ${to}`); }
    if (!FORCE) await confirmSent(claimId);
    console.log(`Done: ${stale.length} overdue request${stale.length === 1 ? '' : 's'}.`);
  } catch (err) {
    if (!FORCE) await release(claimId);
    throw err;
  }
}

main().catch(e => { console.error('FATAL:', (e && e.stack) || e); process.exit(1); });
