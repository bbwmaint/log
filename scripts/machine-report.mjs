#!/usr/bin/env node
/**
 * BBW Weekly Machine Report  (automated)
 * --------------------------------------
 * Runs Monday morning: builds the machine-downtime PDF (machine down + partial,
 * by machine, daily trend, PM completion, requests) for the week that just ended
 * (last Monday–Sunday), straight from the live app via machineWeekStats()/
 * machineWeekPDF(), uploads it to Supabase Storage, and emails a link.
 * Same proven pipeline as the shift / rotation / stats reports.
 *
 * Window:  --start YYYY-MM-DD --end YYYY-MM-DD (explicit) else the LAST complete
 *          Monday–Sunday week relative to "now" (Toronto).
 * Flags:   --dry-run  print instead of send   --force  re-send   --at ISO  fake "now"
 * Recipients: MACHINE_TO env (comma-separated); defaults to the maintenance inbox.
 */
import { buildMachinePDF, machineFileName } from './build-machine-pdf.mjs';

const TZ   = 'America/Toronto';
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val  = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };

const DRY   = flag('dry-run');
const FORCE = flag('force');
const SB_URL   = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY   = process.env.SUPABASE_KEY || '';
const EJS_PUB  = process.env.EMAILJS_PUBLIC_KEY  || '';
const EJS_PRIV = process.env.EMAILJS_PRIVATE_KEY || '';
const EJS_SVC  = process.env.EMAILJS_SERVICE  || 'service_q7rtzse';
const EJS_TPL  = process.env.EMAILJS_TEMPLATE || 'template_i01whhv';
const EJS_API  = process.env.EMAILJS_ENDPOINT || 'https://api.emailjs.com/api/v1.0/email/send';
const APP_URL  = process.env.APP_URL || 'https://bbwmaint.github.io/log/';
const BUCKET   = process.env.PDF_BUCKET || 'bbw-docs';
const STALE_MIN = +(process.env.CLAIM_STALE_MINUTES || 20);
const RECIPIENTS = (process.env.MACHINE_TO || 'maintenancebbw@brunswickbierworks.com')
  .split(',').map(s => s.trim()).filter(Boolean);

/* ── dates (Monday–Sunday weeks, matching the in-app report) ───────────────── */
function torontoDate(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
}
function addDays(ds, n) { const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekMonSun(ds) {                          // the Mon–Sun week containing ds
  const d = new Date(ds + 'T12:00:00Z'), dow = d.getUTCDay(), back = (dow + 6) % 7;
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - back);
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  return { start: mon.toISOString().slice(0, 10), end: sun.toISOString().slice(0, 10) };
}
function prettyDate(ds) { const d = new Date(ds + 'T12:00:00Z'); return d.toLocaleDateString('en-CA', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }); }

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
    try { const r = await sb(path); const b = await r.text(); if (!r.ok) throw new Error(`${r.status} ${b.slice(0, 160)}`); return JSON.parse(b); }
    catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 500 * (i + 1))); }
  }
  throw lastErr;
}
async function claim(id) {
  const rows = await sbGet('bbw_report_sent?select=id,sent_at,claimed_at&id=eq.' + encodeURIComponent(id));
  const row = rows[0];
  if (row) {
    if (row.sent_at && !FORCE) { console.log(`Already sent at ${row.sent_at} — nothing to do.`); return false; }
    if (!row.sent_at && row.claimed_at && !FORCE) {
      const ageMin = (Date.now() - new Date(row.claimed_at).getTime()) / 60000;
      if (ageMin < STALE_MIN) { console.log(`Another run claimed this ${Math.round(ageMin)} min ago — leaving it.`); return false; }
    }
    const u = await sb('bbw_report_sent?id=eq.' + encodeURIComponent(id), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ claimed_at: new Date().toISOString(), sent_at: null }) });
    if (!u.ok) throw new Error(`could not re-claim: ${u.status}`); return true;
  }
  const ins = await sb('bbw_report_sent', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify({ id, claimed_at: new Date().toISOString() }) });
  if (!ins.ok) throw new Error(`claim failed: ${ins.status}`);
  const made = await ins.json();
  if (!Array.isArray(made) || !made.length) { console.log('Another run claimed it a moment ago — leaving it.'); return false; }
  return true;
}
async function confirmSent(id) { const r = await sb('bbw_report_sent?id=eq.' + encodeURIComponent(id), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ sent_at: new Date().toISOString() }) }); if (!r.ok) console.warn(`WARNING: email sent but could not record it (${r.status}).`); }
async function release(id) { try { await sb('bbw_report_sent?id=eq.' + encodeURIComponent(id), { method: 'DELETE' }); console.log('Released — next run will retry.'); } catch (e) { console.warn('could not release the claim:', e.message); } }

/* ── PDF hosting + email ───────────────────────────────────────────────────── */
async function uploadPDF(pdf, filename) {
  const path = `reports/${filename}`;
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
    signal: AbortSignal.timeout(35000), method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/pdf', 'x-upsert': 'true' }, body: pdf
  });
  if (!r.ok) throw new Error(`upload failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return `${SB_URL}/storage/v1/object/public/${BUCKET}/${encodeURI(path)}`;
}
function emailBody(s, start, end, pdfUrl) {
  const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const lines = [
    `Machine down: ${s.fullMin} min (${s.fullN} event${s.fullN === 1 ? '' : 's'}) \u00b7 partial: ${s.partMin} min (${s.partN}).`,
    `${s.machineCount} machine${s.machineCount === 1 ? '' : 's'} affected${s.worst ? ` \u00b7 worst: ${s.worst} (${s.worstMin} min)` : ''}.`,
    `PM completion: ${s.pmPct == null ? '\u2014' : s.pmPct + '%'} (${s.pmDone}/${s.pmDue}) \u00b7 Requests: ${s.reqClosed}/${s.reqReceived} closed.`
  ];
  const range = `${prettyDate(start)} \u2013 ${prettyDate(end)}  \u00b7  Mon\u2013Sun`;
  const html =
`<div style="font:400 14px system-ui;color:#1e1f22;max-width:640px">
<h2 style="font:700 18px system-ui;margin:0 0 2px">Weekly Machine Report</h2>
<div style="font:400 13px system-ui;color:#6b7078;margin-bottom:14px">${range}</div>
<div style="background:#f6f7f9;border-left:3px solid #d84a42;padding:12px 14px;border-radius:4px">
<ul style="margin:0;padding-left:18px;font:400 13.5px/1.6 system-ui">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>
<p style="font:400 13px/1.5 system-ui;color:#42474f;margin:14px 0 4px">The attached PDF has the full breakdown — downtime by machine (full + partial), the daily trend, PM completion, requests, and every downtime event with its day and note.</p>
${pdfUrl ? `<p style="margin:18px 0 6px"><a href="${pdfUrl}" style="display:inline-block;background:#1e1f22;color:#fff;text-decoration:none;font:600 14px system-ui;padding:11px 20px;border-radius:6px">Download the PDF report</a></p>` : ''}
<p style="font:400 13px system-ui;color:#6b7078;margin-top:14px">More detail in the app: <a href="${APP_URL}">${APP_URL}</a></p>
<p style="font:400 12px system-ui;color:#9aa0a8">Automated message — please do not reply.<br>— Brunswick Bierworks Maintenance</p>
</div>`;
  const text = `Weekly Machine Report — ${range}\n\n`
    + lines.map(l => '  \u2022 ' + l).join('\n')
    + (pdfUrl ? `\n\nPDF report:\n${pdfUrl}` : '')
    + `\n\nMore detail in the app: ${APP_URL}\n\nAutomated message — please do not reply.\n— Brunswick Bierworks Maintenance`;
  return { html, text, subject: `BBW Weekly Machine Report — ${range}` };
}
async function sendEmailTo(to, { subject, text }) {
  const r = await fetch(EJS_API, {
    signal: AbortSignal.timeout(25000), method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: 'https://bbwmaint.github.io' },
    body: JSON.stringify({ service_id: EJS_SVC, template_id: EJS_TPL, user_id: EJS_PUB, accessToken: EJS_PRIV,
      template_params: { to_email: to, subject, message: text, reporter: 'BBW Maintenance App', asset_name: 'Weekly Machine Report', photos: '' } })
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`EmailJS ${r.status}: ${body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 220)}`);
}

/* ── main ──────────────────────────────────────────────────────────────────── */
async function main() {
  const at = val('at') ? new Date(val('at')) : new Date();
  let start = val('start'), end = val('end');
  if (start && !end)      end   = weekMonSun(start).end;
  else if (end && !start) start = weekMonSun(end).start;
  else if (!start && !end) {
    const w = weekMonSun(addDays(torontoDate(at), -1));   // the week that just ended (yesterday = Sunday on a Monday run)
    start = w.start; end = w.end;
  }
  const claimId = `MACHINE_${start}_${end}`;
  console.log(`Machine week : ${start} \u2192 ${end}  (Mon\u2013Sun)`);
  console.log(`Recipients   : ${RECIPIENTS.join(', ') || '(none)'}`);

  if (!DRY) {
    if (!RECIPIENTS.length) throw new Error('MACHINE_TO is empty — refusing to send.');
    if (!SB_URL || !SB_KEY) throw new Error('SUPABASE_URL / SUPABASE_KEY missing');
    if (!EJS_PUB || !EJS_PRIV) throw new Error('EMAILJS_PUBLIC_KEY / EMAILJS_PRIVATE_KEY missing');
    if (!(await claim(claimId))) return;
  }

  try {
    const fname = machineFileName(start, end);
    let pdf = null, stats = {};
    try { const out = await buildMachinePDF(start, end); pdf = out.pdf; stats = out.stats;
      console.log(`PDF: ${fname} (${pdf.length} bytes) \u00b7 ${stats.fullMin}min down, ${stats.machineCount} machines, PM ${stats.pmPct}%`);
    } catch (e) { console.warn('PDF build failed:', e.message); if (!DRY) throw e; }

    let pdfUrl = null;
    if (pdf && SB_URL && SB_KEY && !DRY) { try { pdfUrl = await uploadPDF(pdf, fname); console.log(`PDF hosted: ${pdfUrl}`); } catch (e) { console.warn(`Could not upload the PDF: ${e.message}`); } }

    const mail = emailBody(stats, start, end, pdfUrl);
    if (DRY) { console.log(`\n--- DRY RUN — nothing sent ---\nTo: ${RECIPIENTS.join(', ')}\nSubject: ${mail.subject}\nPDF: ${pdf ? `${fname} (${pdf.length} bytes)` : 'none'}\n\n${mail.text}`); return; }
    for (const to of RECIPIENTS) { await sendEmailTo(to, mail); console.log(`SENT to ${to}`); }
    await confirmSent(claimId);
    console.log(`Done${pdfUrl ? ' (PDF linked)' : ''}.`);
  } catch (err) { if (!DRY) await release(claimId); throw err; }
}

main().catch(e => { console.error('FATAL:', e && e.message || e); process.exit(1); });
