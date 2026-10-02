#!/usr/bin/env node
/**
 * BBW — daily OVERDUE PM digest.
 * ---------------------------------------------------------------------------
 * Reads open work orders from Supabase, buckets them into OVERDUE (past the
 * 7-day grace buffer — same rule the app uses to colour them red) and DUE
 * (due on/before today but still inside the buffer), groups by technician, and
 * emails one plain-text digest to the shared maintenance inbox. The whole team
 * plus the supervisor see the same list every morning.
 *
 * Sent once per day (claim id OVERDUE_<toronto-date> in bbw_report_sent), and
 * only when there is something to report — an empty "all caught up" email every
 * day just trains people to ignore it.
 *
 * Uses only Node's built-in fetch — no npm packages needed to run it.
 *
 * Env:   SUPABASE_URL  SUPABASE_KEY
 *        EMAILJS_PUBLIC_KEY  EMAILJS_PRIVATE_KEY  EMAILJS_SERVICE  EMAILJS_TEMPLATE
 *        DIGEST_TO(maintenancebbw@…)  PM_BUFFER_DAYS(7)  SEND_HOUR(7)  APP_URL
 * Flags: --dry-run (print, send nothing)  --force (skip hour-gate + dedup)
 *        --at ISO (fake "now")  --always (send even when nothing is due)
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
const BUFFER     = +(process.env.PM_BUFFER_DAYS || 7);   // keep in lock-step with the app
const SEND_HOUR  = +(process.env.SEND_HOUR || 7);        // fire only in this Toronto hour (dedup pins one/day)
const RECIPIENTS = (process.env.DIGEST_TO || 'maintenancebbw@brunswickbierworks.com')
  .split(',').map(s => s.trim()).filter(Boolean);

/* ── dates (match the app) ─────────────────────────────────────────────────── */
function torontoParts(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}
const addDays = (ds, n) => { const d = new Date(ds + 'T00:00:00'); d.setDate(d.getDate() + n); return isoOf(d); };
function isoOf(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
const graceEnd    = (ds) => addDays(ds, BUFFER);
const isOverdue   = (ds, today) => !!ds && today > graceEnd(ds);
function overdueDays(ds, today) {
  if (!ds) return 0;
  const a = new Date(graceEnd(ds) + 'T00:00:00'), b = new Date(today + 'T00:00:00');
  const n = Math.round((b - a) / 86400000); return n > 0 ? n : 0;
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
async function sendEmailTo(to, subject, text) {
  const r = await fetch(EJS_API, {
    signal: AbortSignal.timeout(25000), method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: 'https://bbwmaint.github.io' },
    body: JSON.stringify({
      service_id: EJS_SVC, template_id: EJS_TPL, user_id: EJS_PUB, accessToken: EJS_PRIV,
      template_params: { to_email: to, subject, message: text, reporter: 'BBW Maintenance App', asset_name: 'Overdue PM Digest', photos: '' }
    })
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`EmailJS ${r.status}: ${body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 220)}`);
}

/* ── who owns it ───────────────────────────────────────────────────────────── */
function ownerOf(w) {
  const a = (w.assignee || '').trim();
  if (!a || /^technicians$/i.test(a)) return 'Unassigned';
  return a;
}
const isOpen = (w) => { const s = w && w.status; return !(s === 'completed' || s === 'closed_incomplete' || s === 'cancelled'); };

/* ── build the digest text ─────────────────────────────────────────────────── */
function buildDigest(overdue, dueSoon, today) {
  const SEP = '='.repeat(46), DIV = '-'.repeat(30);
  const L = [];
  L.push('BBW MAINTENANCE — OVERDUE PM DIGEST');
  L.push(prettyDate(today));
  L.push('');
  L.push(`⚠ ${overdue.length} OVERDUE   ·   ${dueSoon.length} due (grace period)`);
  L.push(SEP); L.push('');

  function groupBlock(title, list, withDays) {
    if (!list.length) return;
    L.push(title); L.push(DIV);
    const by = {};
    list.forEach(w => { const o = ownerOf(w); (by[o] = by[o] || []).push(w); });
    // techs with the most first; Unassigned last
    const names = Object.keys(by).sort((a, b) => {
      if (a === 'Unassigned') return 1; if (b === 'Unassigned') return -1;
      return by[b].length - by[a].length || a.localeCompare(b);
    });
    names.forEach(nm => {
      const items = by[nm].sort((a, b) => (a.due_date || '').localeCompare(b.due_date || '')); // oldest/most-overdue first
      L.push(`${nm} (${items.length})`);
      items.forEach(w => {
        const asset = (w.asset || w.asset_code || '').trim();
        const desc  = (w.description || w.pm_code || w.wo_code || 'PM').trim();
        const tail  = withDays ? `${overdueDays(w.due_date, today)}d overdue (due ${w.due_date})` : `due ${w.due_date}`;
        L.push(`  • ${desc}${asset ? ' — ' + asset : ''}  ·  ${tail}`);
      });
      L.push('');
    });
  }
  groupBlock('OVERDUE (past ' + BUFFER + '-day buffer)', overdue, true);
  groupBlock('DUE — clock ticking (within buffer)', dueSoon, false);

  L.push('Open the app to clear these: ' + APP_URL);
  L.push('');
  L.push('This is an automated nudge — please do not reply.');
  L.push('— Brunswick Bierworks Maintenance');
  return L.join('\n');
}

/* ── main ──────────────────────────────────────────────────────────────────── */
async function main() {
  const now = val('at') ? new Date(val('at')) : new Date();
  const { date: today, hour } = torontoParts(now);
  console.log(`Overdue digest · ${today} · Toronto hour=${hour} · buffer=${BUFFER}d · dry=${DRY}`);

  // No hour-gate: the cron fires twice (11:00 & 12:00 UTC) so a morning run always lands
  // in both DST and EST. The once-per-day dedup lock below (claim OVERDUE_<date>) makes the
  // FIRST run send and the SECOND log "Already sent today" and exit — so it sends exactly
  // once per day without the confusing "wrong hour, exiting" run that looked like a failure.

  if (!SB_URL || !SB_KEY) throw new Error('SUPABASE_URL / SUPABASE_KEY missing');

  const all = await sbGet('bbw_wos?select=wo_code,pm_code,description,asset,asset_code,assignee,status,priority,due_date&limit=8000');
  const open = (all || []).filter(w => w && isOpen(w) && w.due_date);
  const overdue = open.filter(w => isOverdue(w.due_date, today));
  const dueSoon = open.filter(w => !isOverdue(w.due_date, today) && w.due_date <= today);

  console.log(`Open WOs: ${open.length} · overdue ${overdue.length} · due-in-grace ${dueSoon.length}`);

  if (!overdue.length && !dueSoon.length && !ALWAYS) { console.log('Nothing overdue or due — no email sent.'); return; }

  const subject = `BBW Maintenance — ${overdue.length} overdue · ${dueSoon.length} due (${today})`;
  const text = buildDigest(overdue, dueSoon, today);

  if (DRY) { console.log(`\n--- DRY RUN — nothing sent ---\nTo: ${RECIPIENTS.join(', ')}\nSubject: ${subject}\n\n${text}`); return; }
  if (!RECIPIENTS.length) throw new Error('DIGEST_TO is empty — refusing to send.');
  if (!EJS_PUB || !EJS_PRIV) throw new Error('EMAILJS_PUBLIC_KEY / EMAILJS_PRIVATE_KEY missing');

  const claimId = `OVERDUE_${today}`;
  if (!FORCE && !(await claim(claimId))) return;

  try {
    for (const to of RECIPIENTS) { await sendEmailTo(to, subject, text); console.log(`SENT to ${to}`); }
    if (!FORCE) await confirmSent(claimId);
    console.log(`Done: ${overdue.length} overdue, ${dueSoon.length} due.`);
  } catch (err) {
    if (!FORCE) await release(claimId);
    throw err;
  }
}

main().catch(e => { console.error('FATAL:', (e && e.stack) || e); process.exit(1); });
