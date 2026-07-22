#!/usr/bin/env node
/**
 * BBW — automatic shift report.
 * Runs on a schedule (GitHub Actions), reads the shift's entries straight from
 * Supabase and emails the report. No phone or open app required.
 *
 * Usage:
 *   node scripts/send-shift-report.mjs                  # send the shift that just ended
 *   node scripts/send-shift-report.mjs --dry-run        # print the email, send nothing
 *   node scripts/send-shift-report.mjs --at 2026-07-21T08:05  # pretend it is this local time
 *   node scripts/send-shift-report.mjs --date 2026-07-20 --shift Night   # send a specific shift
 */

import { buildReportPDF, reportFileName, reportSummaryLines } from './build-report-pdf.mjs';

const TZ = 'America/Toronto';
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val  = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };

const DRY       = flag('dry-run');
const SB_URL    = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY    = process.env.SUPABASE_KEY || '';
const EJS_PRIV  = process.env.EMAILJS_PRIVATE_KEY || '';
const EJS_PUB   = process.env.EMAILJS_PUBLIC_KEY  || '';
const EJS_SVC   = process.env.EMAILJS_SERVICE  || 'service_q7rtzse';
const EJS_TPL   = process.env.EMAILJS_TEMPLATE || 'template_i01whhv';
const TO_EMAIL  = process.env.REPORT_TO || 'maintenance@brunswickbierworks.com';
const APP_URL   = process.env.APP_URL || 'https://bbwmaint.github.io/';
const BREVO_KEY  = process.env.BREVO_API_KEY || '';
const BREVO_FROM = process.env.BREVO_FROM || '';
const BREVO_API  = process.env.BREVO_ENDPOINT || 'https://api.brevo.com/v3/smtp/email';
const EJS_API   = process.env.EMAILJS_ENDPOINT || 'https://api.emailjs.com/api/v1.0/email/send';

/* ── time helpers (shift anchoring must match the app exactly) ───────────────
   A night shift runs 19:00 -> 07:00 and belongs to the date it STARTED on.    */
export function localParts(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute };
}
export function addDays(ds, n) {
  const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** The shift that has most recently finished at the given local time. */
export function lastEndedShift({ date, hour }) {
  if (hour < 7)  return { date: addDays(date, -1), shift: 'Day'   }; // day ended 19:00 yesterday
  if (hour < 19) return { date: addDays(date, -1), shift: 'Night' }; // night ended 07:00 today
  return { date, shift: 'Day' };                                     // day ended 19:00 today
}
export function shiftWindow({ date, shift }) {
  return shift === 'Day'
    ? `${date} 07:00 → 19:00`
    : `${date} 19:00 → ${addDays(date, 1)} 07:00`;
}

/* ── supabase ───────────────────────────────────────────────────────────── */
async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  return r;
}

/** Give the shift back so the next hourly run retries it. */
async function unclaim(id) {
  try { await sb(`bbw_report_sent?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  catch (e) { console.warn('could not release claim:', e.message); }
}

/** Atomically claim this shift. Returns false if another run already sent it. */
async function claim(id) {
  const r = await sb('bbw_report_sent', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ id })
  });
  if (!r.ok) throw new Error(`claim failed: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;      // [] => already claimed
}

async function fetchEntries(date, shift) {
  const r = await sb(`bbw_worklog?date=eq.${date}&shift=eq.${encodeURIComponent(shift)}&order=logged_at.asc`);
  if (!r.ok) throw new Error(`worklog fetch failed: ${r.status} ${await r.text()}`);
  return await r.json();
}

/* ── report ─────────────────────────────────────────────────────────────── */
/** Shape the rows exactly like the app's computeShiftReport() so the shared
 *  PDF builder renders an identical report. */
export function buildR(date, shift, rows) {
  const se = rows.map(r => ({
    type: r.type, who: r.who || '', assetName: r.asset_name || '', assetCode: r.asset_code || '',
    issue: r.issue || '', desc: r.description || '', start: r.start_time || '', end: r.end_time || '',
    dt: +r.downtime_hrs || 0, machineDown: r.machine_down || '', coMins: +r.co_mins || 0,
    coType: r.co_type || '', partName: r.part_name || '', partQty: r.part_qty || '1',
    shiftNote: r.shift_note || '', loggedAt: r.logged_at, photo: r.photo || '', photos: []
  })).sort((a, b) => String(a.loggedAt || '').localeCompare(String(b.loggedAt || '')));

  const dtEvents = se.filter(e => (e.machineDown === 'yes' || e.machineDown === 'partial') && e.dt > 0);
  const coEvents = se.filter(e => e.coMins > 0);
  return {
    date, shift, se,
    techs: [...new Set(se.map(e => e.who))].filter(Boolean),
    dtEvents, totalDT: dtEvents.reduce((a, e) => a + e.dt, 0),
    coEvents, totalCO: coEvents.reduce((a, e) => a + e.coMins, 0),
    coTypes: [...new Set(coEvents.map(e => e.coType).filter(Boolean))],
    done:    se.filter(e => ['done', 'pm', 'completed'].includes(e.type)),
    ongoing: se.filter(e => e.type === 'ongoing'),
    issues:  se.filter(e => ['issue', 'pending'].includes(e.type)),
    parts:   se.filter(e => ['part', 'parts'].includes(e.type))
  };
}

export function emailBody(R) {
  const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const lines = reportSummaryLines(R);
  const notes = [...new Set(R.se.map(e => e.shiftNote).filter(Boolean))];
  const rowsOf = (list, fmt) => list.map(x => `<li>${esc(fmt(x))}</li>`).join('');
  const block = (title, list, fmt) => list.length
    ? `<h3 style="font:600 14px system-ui;color:#1e1f22;margin:18px 0 6px">${title} (${list.length})</h3><ul style="font:400 13.5px/1.55 system-ui;color:#333;margin:0;padding-left:20px">${rowsOf(list, fmt)}</ul>` : '';
  const html =
`<div style="font:400 14px system-ui;color:#1e1f22;max-width:640px">
<h2 style="font:700 18px system-ui;margin:0 0 2px">${R.shift} Shift Report — ${R.date}</h2>
<div style="font:400 13px system-ui;color:#6b7078;margin-bottom:14px">${R.shift === 'Day' ? '07:00 – 19:00' : '19:00 – 07:00'} &middot; ${esc(R.techs.join(', ') || '—')}</div>
<div style="background:#f6f7f9;border-left:3px solid #c4a04a;padding:12px 14px;border-radius:4px">
<ul style="margin:0;padding-left:18px;font:400 13.5px/1.6 system-ui">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>
${block('Pending issues — next shift must action', R.issues, x => `${x.assetName || '?'}${x.issue ? ` (${x.issue})` : ''}${x.desc ? ` — ${x.desc}` : ''}${x.who ? ` [${x.who}]` : ''}`)}
${block('Ongoing', R.ongoing, x => `${x.assetName || '?'} — ${x.desc || ''}${x.who ? ` [${x.who}]` : ''}`)}
${block('Completed', R.done, x => `${x.assetName || '?'} — ${x.desc || ''}${x.who ? ` [${x.who}]` : ''}`)}
${block('Parts to order', R.parts, x => `${x.partName || x.assetName} x${x.partQty}${x.who ? ` [${x.who}]` : ''}`)}
${notes.length ? `<h3 style="font:600 14px system-ui;margin:18px 0 6px">Shift notes</h3><ul style="font:400 13.5px/1.55 system-ui;margin:0;padding-left:20px">${rowsOf(notes, n => n)}</ul>` : ''}
<p style="font:400 13px system-ui;color:#6b7078;margin-top:20px">The full report is attached as a PDF. More detail in the app: <a href="${APP_URL}">${APP_URL}</a></p>
<p style="font:400 12px system-ui;color:#9aa0a8">This is an automated message — please do not reply to this email.<br>— Brunswick Bierworks Maintenance</p>
</div>`;
  const text = `${R.shift} Shift Report — ${R.date}\nTechnicians: ${R.techs.join(', ') || '—'}\n\n` +
    lines.map(l => '  • ' + l).join('\n') +
    `\n\nFull report attached as PDF.\n${APP_URL}\n\nThis is an automated message — please do not reply to this email.\n— Brunswick Bierworks Maintenance`;
  return { html, text, subject: `BBW Maintenance Report — ${R.date} ${R.shift} Shift` };
}

/* ── email ──────────────────────────────────────────────────────────────── */
async function sendBrevo({ subject, html, text }, pdf, filename) {
  const body = {
    sender: { name: 'BBW Maintenance', email: BREVO_FROM },
    to: [{ email: TO_EMAIL }],
    subject, htmlContent: html, textContent: text
  };
  if (pdf) body.attachment = [{ name: filename, content: pdf.toString('base64') }];
  const r = await fetch(BREVO_API, {
    method: 'POST',
    headers: { 'api-key': BREVO_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body)
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Brevo ${r.status}: ${txt}`);
  // Print what Brevo actually returned — the messageId is what you search their logs for.
  console.log(`Brevo accepted (HTTP ${r.status}): ${txt}`);
  console.log(`  from: ${BREVO_FROM}   to: ${TO_EMAIL}`);
  return txt;
}

async function sendEmailJS({ subject, text }) {
  const r = await fetch(EJS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: 'https://bbwmaint.github.io' },
    body: JSON.stringify({
      service_id: EJS_SVC, template_id: EJS_TPL, user_id: EJS_PUB, accessToken: EJS_PRIV,
      template_params: { to_email: TO_EMAIL, subject, message: text, reporter: 'BBW Maintenance App', asset_name: 'Shift Report', photos: '' }
    })
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`EmailJS ${r.status}: ${txt}`);
  return txt;
}


/* ── diagnostics: ask Brevo about the key the workflow is actually using ──── */
async function brevoGet(path) {
  const r = await fetch(`https://api.brevo.com/v3/${path}`, { headers: { 'api-key': BREVO_KEY, accept: 'application/json' } });
  const t = await r.text();
  return { status: r.status, body: t };
}
async function diagnose() {
  if (!BREVO_KEY) { console.log('No BREVO_API_KEY set.'); return; }
  console.log('=== Which Brevo account does this API key belong to? ===');
  const acct = await brevoGet('account');
  if (acct.status !== 200) console.log(`  account lookup failed (${acct.status}): ${acct.body}`);
  else {
    try {
      const a = JSON.parse(acct.body);
      console.log(`  login email : ${a.email}`);
      console.log(`  company     : ${a.companyName}`);
      const plan = (a.plan || []).map(p => `${p.type}${p.credits != null ? ` credits=${p.credits}` : ''}`).join(', ');
      console.log(`  plan        : ${plan || '(none listed)'}`);
      console.log('  ^ log in as THIS account to see the logs.');
    } catch { console.log('  ' + acct.body.slice(0, 300)); }
  }

  console.log('\n=== Verified senders on this account ===');
  const snd = await brevoGet('senders');
  if (snd.status !== 200) console.log(`  senders lookup failed (${snd.status}): ${snd.body}`);
  else {
    try {
      const list = (JSON.parse(snd.body).senders) || [];
      if (!list.length) console.log('  NONE — nothing is verified, so nothing can be sent.');
      list.forEach(x => console.log(`  ${x.active ? 'VERIFIED  ' : 'NOT ACTIVE'}  ${x.email}   (name: ${x.name})`));
      const want = BREVO_FROM.toLowerCase();
      const hit = list.find(x => (x.email || '').toLowerCase() === want);
      console.log(`\n  BREVO_FROM is ${BREVO_FROM}`);
      console.log(hit ? (hit.active ? '  -> matches a VERIFIED sender. Good.'
                                    : '  -> matches a sender that is NOT verified yet. Click the link Brevo emailed to it.')
                      : '  -> NOT in the list above. That is why nothing sends.');
    } catch { console.log('  ' + snd.body.slice(0, 300)); }
  }

  console.log('\n=== Recent transactional events on this account ===');
  const ev = await brevoGet('smtp/statistics/events?limit=10&sort=desc');
  if (ev.status !== 200) console.log(`  events lookup failed (${ev.status}): ${ev.body}`);
  else {
    try {
      const evs = (JSON.parse(ev.body).events) || [];
      if (!evs.length) console.log('  none — Brevo has no delivery activity for this account at all.');
      evs.forEach(e => console.log(`  ${e.date}  ${e.event.toUpperCase().padEnd(10)} ${e.email}  ${e.reason || ''}`));
    } catch { console.log('  ' + ev.body.slice(0, 300)); }
  }
}

/* ── main ───────────────────────────────────────────────────────────────── */
async function main() {
  if (flag('diagnose')) { await diagnose(); return; }
  const at    = val('at') ? new Date(val('at')) : new Date();
  const parts = localParts(at);
  const target = (val('date') && val('shift'))
    ? { date: val('date'), shift: val('shift') }
    : lastEndedShift(parts);

  console.log(`Toronto time: ${parts.date} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`);
  console.log(`Target shift: ${target.date} ${target.shift}  (${shiftWindow(target)})`);
  console.log(`Sender: ${BREVO_FROM || '(BREVO_FROM not set!)'}  ->  ${TO_EMAIL}`);
  if (BREVO_KEY && !BREVO_FROM && !DRY) {
    throw new Error('BREVO_FROM is not set. Add a repository VARIABLE named BREVO_FROM ' +
                    'containing the exact address you verified in Brevo (Settings -> ' +
                    'Secrets and variables -> Actions -> Variables tab). Refusing to send ' +
                    'from a guessed address.');
  }

  const claimId = `${target.date}_${target.shift}`;
  if (!DRY) {
    if (!SB_URL || !SB_KEY) throw new Error('SUPABASE_URL / SUPABASE_KEY missing');
    const got = await claim(claimId);
    if (!got) { console.log('Already sent by an earlier run — nothing to do.'); return; }
  }

  let rows = [];
  if (SB_URL && SB_KEY) {
    try { rows = await fetchEntries(target.date, target.shift); }
    catch (e) { if (!DRY) throw e; console.warn('Could not reach Supabase (dry run, continuing with no entries):', e.message); }
  }
  const R    = buildR(target.date, target.shift, rows);
  const mail = emailBody(R);
  console.log(`Entries: ${R.se.length}`);

  let pdf = null, fname = reportFileName(R);
  try { pdf = buildReportPDF(R); console.log(`PDF: ${fname} (${pdf.length} bytes)`); }
  catch (e) { console.warn('PDF build failed, sending without attachment:', e.message); }

  if (DRY) {
    console.log(`\n--- DRY RUN ---\nTo: ${TO_EMAIL}\nSubject: ${mail.subject}\nAttachment: ${pdf ? `${fname} (${pdf.length} bytes)` : 'none'}\n\n${mail.text}`);
    if (pdf && val('save-pdf')) { const { writeFileSync } = await import('node:fs'); writeFileSync(val('save-pdf'), pdf); console.log(`Saved ${val('save-pdf')}`); }
    return;
  }

  if (!BREVO_KEY && !(EJS_PRIV && EJS_PUB)) {
    await unclaim(claimId);
    throw new Error('No email provider configured — set BREVO_API_KEY (recommended) or EMAILJS_* keys');
  }

  try {
    if (!BREVO_KEY) throw new Error('no Brevo key');
    await sendBrevo(mail, pdf, fname);
    console.log(`Sent to ${TO_EMAIL} via Brevo${pdf ? ' with PDF attached' : ''}`);
  } catch (brevoErr) {
    if (BREVO_KEY) console.error(`Brevo failed: ${brevoErr.message}`);
    // Rather than lose the report, fall back to the text-only route if it is set up.
    if (EJS_PRIV && EJS_PUB) {
      try {
        await sendEmailJS(mail);
        console.log(`Sent to ${TO_EMAIL} via EmailJS fallback (no attachment). Fix Brevo to get the PDF back.`);
        return;
      } catch (ejsErr) { console.error(`EmailJS fallback failed: ${ejsErr.message}`); }
    }
    // Nothing got through — hand the shift back so the next run tries again.
    await unclaim(claimId);
    throw new Error(`could not send the report: ${brevoErr.message}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
}
