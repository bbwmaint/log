#!/usr/bin/env node
/**
 * BBW — automatic shift report.
 *
 * Reads the shift's entries from Supabase, builds the PDF, uploads it to
 * Supabase Storage, and emails the report through EmailJS (which relays via the
 * company's own Outlook — the only route that reaches the inbox on this tenant).
 *
 * A shift is only marked as sent once the email has actually gone out. If the
 * send fails, the claim is released and the next scheduled run tries again.
 *
 * Usage:
 *   node scripts/send-shift-report.mjs                       # the shift that just ended
 *   node scripts/send-shift-report.mjs --dry-run             # print it, send nothing
 *   node scripts/send-shift-report.mjs --date 2026-07-23 --shift Night
 *   node scripts/send-shift-report.mjs --at 2026-07-24T07:10 # pretend it is this local time
 *   node scripts/send-shift-report.mjs --force               # re-send even if already sent
 */

import { buildReportPDF, reportFileName, reportSummaryLines } from './build-report-pdf.mjs';

const TZ = 'America/Toronto';
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val  = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };

const DRY      = flag('dry-run');
const FORCE    = flag('force');
const SB_URL   = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY   = process.env.SUPABASE_KEY || '';
const EJS_PUB  = process.env.EMAILJS_PUBLIC_KEY  || '';
const EJS_PRIV = process.env.EMAILJS_PRIVATE_KEY || '';
const EJS_SVC  = process.env.EMAILJS_SERVICE  || 'service_q7rtzse';
const EJS_TPL  = process.env.EMAILJS_TEMPLATE || 'template_i01whhv';
const EJS_API  = process.env.EMAILJS_ENDPOINT || 'https://api.emailjs.com/api/v1.0/email/send';
const TO_EMAIL = (process.env.REPORT_TO || 'maintenance@brunswickbierworks.com').trim();
const APP_URL  = process.env.APP_URL || 'https://bbwmaint.github.io/';
const BUCKET   = process.env.PDF_BUCKET || 'bbw-docs';
/** A claim older than this is treated as abandoned (previous run died mid-way). */
const STALE_MIN = +(process.env.CLAIM_STALE_MINUTES || 20);

/* ── time: a night shift runs 19:00→07:00 and belongs to the date it STARTED ── */
export function localParts(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24, minute: +p.minute };
}
export function addDays(ds, n) {
  const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function lastEndedShift({ date, hour }) {
  if (hour < 7)  return { date: addDays(date, -1), shift: 'Day'   };
  if (hour < 19) return { date: addDays(date, -1), shift: 'Night' };
  return { date, shift: 'Day' };
}
export function shiftWindow({ date, shift }) {
  return shift === 'Day' ? `${date} 07:00 → 19:00`
                         : `${date} 19:00 → ${addDays(date, 1)} 07:00`;
}

/* ── supabase ─────────────────────────────────────────────────────────────── */
function sb(path, opts = {}) {
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    signal: AbortSignal.timeout(20000),
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
               'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
}

/**
 * Try to take responsibility for sending this shift.
 *  - never sent, no claim      -> we take it
 *  - already sent              -> skip (unless --force)
 *  - claimed recently          -> another run is working on it, skip
 *  - claimed but gone stale    -> the previous run died, take it over
 */
async function claim(id) {
  const r = await sb('bbw_report_sent?select=id,sent_at,claimed_at&id=eq.' + encodeURIComponent(id));
  if (!r.ok) throw new Error(`claim lookup failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const rows = await r.json();
  const row  = rows[0];

  if (row) {
    if (row.sent_at && !FORCE) { console.log(`Already sent at ${row.sent_at} — nothing to do.`); return false; }
    if (!row.sent_at && row.claimed_at && !FORCE) {
      const ageMin = (Date.now() - new Date(row.claimed_at).getTime()) / 60000;
      if (ageMin < STALE_MIN) {
        console.log(`Another run claimed this ${Math.round(ageMin)} min ago and has not finished — leaving it. ` +
                    `It becomes retryable after ${STALE_MIN} min.`);
        return false;
      }
      console.log(`Previous attempt is ${Math.round(ageMin)} min old and never completed — retrying it now.`);
    }
    const u = await sb('bbw_report_sent?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ claimed_at: new Date().toISOString(), sent_at: null })
    });
    if (!u.ok) throw new Error(`could not re-claim: ${u.status}`);
    return true;
  }

  const ins = await sb('bbw_report_sent', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ id, claimed_at: new Date().toISOString() })
  });
  if (!ins.ok) throw new Error(`claim failed: ${ins.status} ${(await ins.text()).slice(0, 200)}`);
  const made = await ins.json();
  if (!Array.isArray(made) || !made.length) { console.log('Another run claimed it a moment ago — leaving it.'); return false; }
  return true;
}

/** Mark it genuinely sent. Only called after the email has gone out. */
async function confirmSent(id) {
  const r = await sb('bbw_report_sent?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ sent_at: new Date().toISOString() })
  });
  if (!r.ok) console.warn(`WARNING: email sent but could not record it (${r.status}). It may send again next run.`);
}

/** Hand the shift back so the next scheduled run retries it. */
async function release(id) {
  try {
    await sb('bbw_report_sent?id=eq.' + encodeURIComponent(id), { method: 'DELETE' });
    console.log('Released this shift — the next scheduled run will try again.');
  } catch (e) { console.warn('could not release the claim:', e.message); }
}

async function fetchEntries(date, shift) {
  const r = await sb(`bbw_worklog?date=eq.${date}&shift=eq.${encodeURIComponent(shift)}&order=logged_at.asc`);
  if (!r.ok) throw new Error(`worklog fetch failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

/* ── report ───────────────────────────────────────────────────────────────── */
/** Shape rows exactly like the app's computeShiftReport() so the PDF matches. */
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

export function emailBody(R, pdfUrl) {
  const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const lines = reportSummaryLines(R);
  const notes = [...new Set(R.se.map(e => e.shiftNote).filter(Boolean))];
  const block = (title, list, fmt) => list.length
    ? `<h3 style="font:600 14px system-ui;color:#1e1f22;margin:18px 0 6px">${title} (${list.length})</h3>`
    + `<ul style="font:400 13.5px/1.55 system-ui;color:#333;margin:0;padding-left:20px">`
    + list.map(x => `<li>${esc(fmt(x))}</li>`).join('') + `</ul>` : '';

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
${notes.length ? `<h3 style="font:600 14px system-ui;margin:18px 0 6px">Shift notes</h3><ul style="font:400 13.5px/1.55 system-ui;margin:0;padding-left:20px">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
${pdfUrl ? `<p style="margin:20px 0 6px"><a href="${pdfUrl}" style="display:inline-block;background:#1e1f22;color:#fff;text-decoration:none;font:600 14px system-ui;padding:11px 20px;border-radius:6px">Download the full PDF report</a></p>` : ''}
<p style="font:400 13px system-ui;color:#6b7078;margin-top:14px">More detail in the app: <a href="${APP_URL}">${APP_URL}</a></p>
<p style="font:400 12px system-ui;color:#9aa0a8">This is an automated message — please do not reply to this email.<br>— Brunswick Bierworks Maintenance</p>
</div>`;

  const text = `${R.shift} Shift Report — ${R.date}\nTechnicians: ${R.techs.join(', ') || '—'}\n\n`
    + lines.map(l => '  • ' + l).join('\n')
    + (pdfUrl ? `\n\nFull PDF report:\n${pdfUrl}` : '')
    + `\n\nMore detail in the app: ${APP_URL}`
    + `\n\nThis is an automated message — please do not reply to this email.\n— Brunswick Bierworks Maintenance`;

  return { html, text, subject: `BBW Maintenance Report — ${R.date} ${R.shift} Shift` };
}

/* ── PDF hosting ──────────────────────────────────────────────────────────── */
async function uploadPDF(pdf, filename) {
  const path = `reports/${filename}`;
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
    signal: AbortSignal.timeout(30000),
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
               'Content-Type': 'application/pdf', 'x-upsert': 'true' },
    body: pdf
  });
  if (!r.ok) throw new Error(`upload failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return `${SB_URL}/storage/v1/object/public/${BUCKET}/${encodeURI(path)}`;
}

/* ── email ────────────────────────────────────────────────────────────────── */
async function sendEmail({ subject, text }) {
  const r = await fetch(EJS_API, {
    signal: AbortSignal.timeout(25000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: 'https://bbwmaint.github.io' },
    body: JSON.stringify({
      service_id: EJS_SVC, template_id: EJS_TPL, user_id: EJS_PUB, accessToken: EJS_PRIV,
      template_params: { to_email: TO_EMAIL, subject, message: text,
                         reporter: 'BBW Maintenance App', asset_name: 'Shift Report', photos: '' }
    })
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`EmailJS ${r.status}: ${body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 220)}`);
  return body;
}

/* ── main ─────────────────────────────────────────────────────────────────── */
async function main() {
  const at    = val('at') ? new Date(val('at')) : new Date();
  const parts = localParts(at);
  const target = (val('date') && val('shift'))
    ? { date: val('date'), shift: val('shift') }
    : lastEndedShift(parts);
  const claimId = `${target.date}_${target.shift}`;

  console.log(`Toronto time: ${parts.date} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`);
  console.log(`Target shift: ${target.date} ${target.shift}  (${shiftWindow(target)})`);
  console.log(`Sending to  : ${TO_EMAIL} via EmailJS`);

  if (!DRY) {
    if (!SB_URL || !SB_KEY) throw new Error('SUPABASE_URL / SUPABASE_KEY missing');
    if (!EJS_PUB || !EJS_PRIV) throw new Error('EMAILJS_PUBLIC_KEY / EMAILJS_PRIVATE_KEY missing');
    if (!(await claim(claimId))) return;
  }

  try {
    let rows = [];
    if (SB_URL && SB_KEY) {
      try { rows = await fetchEntries(target.date, target.shift); }
      catch (e) { if (!DRY) throw e; console.warn('Could not reach Supabase (dry run):', e.message); }
    }
    const R = buildR(target.date, target.shift, rows);
    console.log(`Entries: ${R.se.length}`);

    let pdf = null; const fname = reportFileName(R);
    try { pdf = buildReportPDF(R); console.log(`PDF: ${fname} (${pdf.length} bytes)`); }
    catch (e) { console.warn('PDF build failed:', e.message); }

    let pdfUrl = null;
    if (pdf && SB_URL && SB_KEY && !DRY) {
      try { pdfUrl = await uploadPDF(pdf, fname); console.log(`PDF hosted: ${pdfUrl}`); }
      catch (e) { console.warn(`Could not upload the PDF: ${e.message}`); }
    }

    const mail = emailBody(R, pdfUrl);

    if (DRY) {
      console.log(`\n--- DRY RUN — nothing sent ---\nTo: ${TO_EMAIL}\nSubject: ${mail.subject}\nPDF: ${pdf ? `${fname} (${pdf.length} bytes)` : 'none'}\n\n${mail.text}`);
      return;
    }

    await sendEmail(mail);
    await confirmSent(claimId);
    console.log(`SENT to ${TO_EMAIL}${pdfUrl ? ' with a link to the PDF' : ''}`);

  } catch (err) {
    // Nothing was sent — hand the shift back so the next run retries it.
    if (!DRY) await release(claimId);
    throw err;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
}
