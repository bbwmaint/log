#!/usr/bin/env node
/**
 * BBW Rotation Productivity Report
 * --------------------------------
 * Runs after each rotation: reads the whole rotation window from Supabase,
 * builds a per-technician Pareto PDF (where each tech's hours went, by machine),
 * plus a team overview page, uploads the PDF to Supabase Storage, and emails a
 * link to the editors (Praful & Lahcen) through EmailJS — same proven pipeline
 * as the shift report.
 *
 * Window:  --start YYYY-MM-DD --end YYYY-MM-DD   (explicit)
 *          otherwise: last ROTATION_DAYS days ending on the Toronto date now
 *          (ROTATION_DAYS defaults to 14; override with --days N).
 * Flags:   --dry-run   print instead of send
 *          --force      re-send even if this window was already sent
 *          --at ISO     pretend "now" is this instant (testing)
 *
 * Recipients: ROTATION_TO env, comma-separated (falls back to REPORT_TO).
 */
import { buildRotationPDF, rotationFileName } from './build-rotation-pdf.mjs';

const TZ = 'America/Toronto';
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
const APP_URL  = process.env.APP_URL || 'https://bbwmaint.github.io/';
const BUCKET   = process.env.PDF_BUCKET || 'bbw-docs';
const ROT_DAYS = +(process.env.ROTATION_DAYS || 4);
// Same 4-day A-B/C-D rotation math as the app's Rotation Stats tab, which is
// anchored to Aug 5 2026 (index.html: ROT_ANCHOR = new Date(2026,7,5), ROT_LEN=4;
// even block = A-B, odd = C-D). Keeping this in lock-step means the report always
// lines up with what the Rotation Stats tab shows — don't invent a separate anchor.
const ROT_ANCHOR = (process.env.ROTATION_ANCHOR || '2026-08-05').trim();
// Label a block A-B or C-D exactly like the app's rotName().
export function rotName(idx) { return ((((idx % 2) + 2) % 2) === 0) ? 'A\u2013B' : 'C\u2013D'; }
const STALE_MIN = +(process.env.CLAIM_STALE_MINUTES || 20);
// Editors ONLY. No fallback to the maintenance inbox — if this isn't set we refuse
// to send rather than mail the wrong people.
const RECIPIENTS = (process.env.ROTATION_TO || '')
  .split(',').map(s => s.trim()).filter(Boolean);

/* ── name canonicalisation (mirrors the app's canonName) ───────────────────── */
const NAME_ALIAS = { 'Akshaylal': 'Akshay' };
const canon = (n) => { n = String(n == null ? '' : n).replace(/\u00a0/g, ' ').trim(); return NAME_ALIAS[n] || n; };

/* ── dates ─────────────────────────────────────────────────────────────────── */
export function torontoDate(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
}
export function addDays(ds, n) {
  const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function prettyDate(ds) {
  const d = new Date(ds + 'T12:00:00Z');
  return d.toLocaleDateString('en-CA', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

/* ── labour hours from start/end (mirrors the app) ─────────────────────────── */
function labHrs(s, e) {
  const p = t => { const m = String(t == null ? '' : t).match(/^(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };
  const a = p(s), b = p(e); if (a == null || b == null) return 0;
  let d = b - a; if (d < 0) d += 1440; if (d <= 0 || d > 1440) return 0; return d / 60;
}
const isPM       = t => t === 'pm';
const isParts    = t => t === 'parts' || t === 'part';
const isReactive = t => ['done', 'completed', 'ongoing', 'issue', 'pending', 'followup', 'followup_done'].includes(t);

/* ── asset → area classifier (keyword-based; tune the lists as needed) ──────── */
const AREA_RULES = [
  ['Packaging',  /filler|seamer|depal|palet|pallet|variopac|ra ?j(ones)?\b|rajones|meridian|krones|line ?\d|pasteur|nordson|labeler|labeller|checkmat|videojet|shrink|wrapper|baler|can |carton|lantech|air rinser|keg|conveyor/i],
  ['Brewhouse',  /lauter|mash|kettle|whirlpool|brewhouse|wort|hlt|clt|hot liquor|cold liquor|malt|mill|grain|spent grain/i],
  ['Cellar',     /tank|cellar|hose|cip|centrifuge|tetrahop|bright|ferment|fv |uni ?tank|dosing|rtd|blending/i],
  ['Utilities',  /boiler|air ?compressor|compressor|glycol|chiller|hvac|rtu|drum fan|pump|utilit|steam|spirax|batter|sewage|waste/i],
  ['Filtration', /carbon|\bro\b|reverse osmosis|\buv\b|membrane|pentair|donaldson|strainer|100 ?mesh|filter/i],
  ['QA / Lab',   /\blab\b|laborator|turbidity|ph probe|clean bench|laminar|hepa/i],
];
function areaOf(name) {
  const n = String(name || '');
  for (const [area, re] of AREA_RULES) if (re.test(n)) return area;
  return 'Other';
}

/* ── aggregation ───────────────────────────────────────────────────────────── */
/**
 * Build the rotation report object from raw worklog rows.
 * Team totals reconcile with the per-tech leaderboard (both are person-hours:
 * a job shared by two techs credits hours to each, matching the app's widgets).
 */
export function buildRotation(fromISO, toISO, rows) {
  const techMap = {};   // canonical name -> tech aggregate
  const ensure = (name) => (techMap[name] = techMap[name] || {
    tech: name, hours: 0, pmHours: 0, reactiveHours: 0, partsHours: 0, coMins: 0,
    pms: 0, reactive: 0, parts: 0, downtime: 0,
    byMachine: {}, topAssets: {}
  });

  (rows || []).forEach(r => {
    // Request-derived logs ("Reported by …") are counted elsewhere in the app; skip.
    if (/^Reported by/i.test(r.description || '')) return;
    const lh   = labHrs(r.start_time, r.end_time);
    const type = r.type || '';
    const asset = (r.asset_name || '').trim() || 'General';
    const dt   = (r.machine_down === 'yes' || r.machine_down === 'partial') ? (+r.downtime_hrs || 0) : 0;
    const co   = +r.co_mins || 0;

    // credit both the primary logger and any "worked with" partner
    const people = [...new Set([canon(r.who), canon(r.with_who)].filter(Boolean))];
    people.forEach(name => {
      const T = ensure(name);
      T.hours += lh;
      if (isPM(type))            { T.pmHours += lh; T.pms++; }
      else if (isParts(type))    { T.partsHours += lh; T.parts++; }
      else if (isReactive(type)) { T.reactiveHours += lh; T.reactive++; }
      T.coMins += co;
      T.downtime += dt;
      T.byMachine[asset] = (T.byMachine[asset] || 0) + lh;
      // keep the busiest description per asset for the "top assets" list
      const cur = T.topAssets[asset] || { hours: 0, desc: '' };
      cur.hours += lh;
      if (lh >= 0 && (r.issue || r.description)) {
        if (!cur.desc) cur.desc = String(r.issue || r.description || '').slice(0, 46);
      }
      T.topAssets[asset] = cur;
    });
  });

  const techs = Object.values(techMap)
    .filter(t => t.hours > 0.01 || t.pms || t.reactive || t.parts)
    .sort((a, b) => b.hours - a.hours);

  // team rollups (person-hours, so they reconcile with the leaderboard)
  const totalLabour  = techs.reduce((a, t) => a + t.hours, 0);
  const pmHours      = techs.reduce((a, t) => a + t.pmHours, 0);
  const reactiveH    = techs.reduce((a, t) => a + t.reactiveHours, 0);
  const downtime     = techs.reduce((a, t) => a + t.downtime, 0);

  // team hours by area (from each tech's byMachine, so it stays person-hours)
  const areaMap = {};
  techs.forEach(t => Object.entries(t.byMachine).forEach(([m, h]) => {
    const a = areaOf(m); areaMap[a] = (areaMap[a] || 0) + h;
  }));

  // shape per-tech pareto data: top 8 machines (descending). The long tail is
  // kept as a note, NOT folded into an "Other" bar (which could out-rank the
  // named machines and break the Pareto). Cumulative is measured vs the tech's
  // true total hours, so a spread-out tech honestly shows < 80% in the top few.
  techs.forEach(t => {
    const entries = Object.entries(t.byMachine).sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, 8);
    const tail = entries.slice(8);
    t.pareto = top.map(([m, h]) => ({ label: m, hours: h }));
    t.tailCount = tail.length;
    t.tailHours = tail.reduce((a, x) => a + x[1], 0);
    t.topList = Object.entries(t.topAssets).sort((a, b) => b[1].hours - a[1].hours)
      .slice(0, 4).map(([m, v]) => ({ asset: m, hours: v.hours, desc: v.desc }));
  });

  return {
    from: fromISO, to: toISO, fromLabel: prettyDate(fromISO), toLabel: prettyDate(toISO),
    techs,
    team: {
      techCount: techs.length,
      totalLabour,
      pmPct: (pmHours + reactiveH) > 0 ? Math.round(pmHours / (pmHours + reactiveH) * 100) : 0,
      reactivePct: (pmHours + reactiveH) > 0 ? Math.round(reactiveH / (pmHours + reactiveH) * 100) : 0,
      downtime,
      byArea: Object.entries(areaMap).sort((a, b) => b[1] - a[1]).map(([label, hours]) => ({ label, hours })),
    },
  };
}

/* ── supabase (paginated — the table exceeds the silent 1000-row cap) ───────── */
function sb(path, opts = {}) {
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    signal: AbortSignal.timeout(25000),
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
               'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
}
async function sbGet(path, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await sb(path);
      const body = await r.text();
      if (!r.ok) throw new Error(`${r.status} ${body.slice(0, 160)}`);
      try { return JSON.parse(body); }
      catch { throw new Error(`non-JSON body: ${body.slice(0, 120)}`); }
    } catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 500 * (i + 1))); }
  }
  throw lastErr;
}
const COLS = 'id,date,type,who,with_who,asset_name,asset_code,issue,description,start_time,end_time,downtime_hrs,machine_down,co_mins,co_type,part_name,part_qty,logged_at';
async function fetchWindow(fromISO, toISO) {
  const page = 1000; let offset = 0, all = [];
  for (;;) {
    const q = `bbw_worklog?select=${COLS}&date=gte.${fromISO}&date=lte.${toISO}` +
              `&order=logged_at.asc&limit=${page}&offset=${offset}`;
    const rows = await sbGet(q);
    if (!Array.isArray(rows) || !rows.length) break;
    all = all.concat(rows);
    if (rows.length < page) break;
    offset += page;
    if (offset > 100000) break;   // safety
  }
  return all;
}

/* ── claim / dedup (reuses bbw_report_sent, same as the shift report) ───────── */
async function claim(id) {
  const rows = await sbGet('bbw_report_sent?select=id,sent_at,claimed_at&id=eq.' + encodeURIComponent(id));
  const row = rows[0];
  if (row) {
    if (row.sent_at && !FORCE) { console.log(`Already sent at ${row.sent_at} — nothing to do.`); return false; }
    if (!row.sent_at && row.claimed_at && !FORCE) {
      const ageMin = (Date.now() - new Date(row.claimed_at).getTime()) / 60000;
      if (ageMin < STALE_MIN) { console.log(`Another run claimed this ${Math.round(ageMin)} min ago — leaving it.`); return false; }
    }
    const u = await sb('bbw_report_sent?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ claimed_at: new Date().toISOString(), sent_at: null })
    });
    if (!u.ok) throw new Error(`could not re-claim: ${u.status}`);
    return true;
  }
  const ins = await sb('bbw_report_sent', {
    method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ id, claimed_at: new Date().toISOString() })
  });
  if (!ins.ok) throw new Error(`claim failed: ${ins.status}`);
  const made = await ins.json();
  if (!Array.isArray(made) || !made.length) { console.log('Another run claimed it a moment ago — leaving it.'); return false; }
  return true;
}
async function confirmSent(id) {
  const r = await sb('bbw_report_sent?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ sent_at: new Date().toISOString() })
  });
  if (!r.ok) console.warn(`WARNING: email sent but could not record it (${r.status}).`);
}
async function release(id) {
  try { await sb('bbw_report_sent?id=eq.' + encodeURIComponent(id), { method: 'DELETE' }); console.log('Released — next run will retry.'); }
  catch (e) { console.warn('could not release the claim:', e.message); }
}

/* ── PDF hosting + email ───────────────────────────────────────────────────── */
async function uploadPDF(pdf, filename) {
  const path = `reports/${filename}`;
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
    signal: AbortSignal.timeout(35000), method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
    body: pdf
  });
  if (!r.ok) throw new Error(`upload failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return `${SB_URL}/storage/v1/object/public/${BUCKET}/${encodeURI(path)}`;
}
export function emailBody(R, pdfUrl) {
  const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const top = R.techs.slice(0, 3).map(t => `${t.tech} (${t.hours.toFixed(0)}h)`).join(', ');
  const lines = [
    `${R.team.techCount} technicians · ${R.team.totalLabour.toFixed(0)} h logged this rotation.`,
    `PM vs reactive: ${R.team.pmPct}% / ${R.team.reactivePct}%. Downtime handled: ${R.team.downtime.toFixed(1)} h.`,
    R.team.byArea.length ? `Busiest area: ${R.team.byArea[0].label} (${R.team.byArea[0].hours.toFixed(0)} h).` : '',
    top ? `Top hours: ${top}.` : '',
  ].filter(Boolean);
  const html =
`<div style="font:400 14px system-ui;color:#1e1f22;max-width:640px">
<h2 style="font:700 18px system-ui;margin:0 0 2px">Rotation Productivity Report</h2>
<div style="font:400 13px system-ui;color:#6b7078;margin-bottom:14px">${R.fromLabel} – ${R.toLabel}</div>
<div style="background:#f6f7f9;border-left:3px solid #4f46e5;padding:12px 14px;border-radius:4px">
<ul style="margin:0;padding-left:18px;font:400 13.5px/1.6 system-ui">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>
<p style="font:400 13px/1.5 system-ui;color:#42474f;margin:14px 0 4px">The attached PDF has one Pareto page per technician — where each person's hours went, by machine — plus a team overview.</p>
${pdfUrl ? `<p style="margin:18px 0 6px"><a href="${pdfUrl}" style="display:inline-block;background:#1e1f22;color:#fff;text-decoration:none;font:600 14px system-ui;padding:11px 20px;border-radius:6px">Download the full PDF report</a></p>` : ''}
<p style="font:400 13px system-ui;color:#6b7078;margin-top:14px">More detail in the app: <a href="${APP_URL}">${APP_URL}</a></p>
<p style="font:400 12px system-ui;color:#9aa0a8">Automated message — please do not reply.<br>— Brunswick Bierworks Maintenance</p>
</div>`;
  const text = `Rotation Productivity Report — ${R.fromLabel} – ${R.toLabel}\n\n`
    + lines.map(l => '  • ' + l).join('\n')
    + (pdfUrl ? `\n\nFull PDF report:\n${pdfUrl}` : '')
    + `\n\nMore detail in the app: ${APP_URL}\n\nAutomated message — please do not reply.\n— Brunswick Bierworks Maintenance`;
  return { html, text, subject: `BBW Rotation Report — ${R.fromLabel} to ${R.toLabel}` };
}
async function sendEmailTo(to, { subject, text }) {
  const r = await fetch(EJS_API, {
    signal: AbortSignal.timeout(25000), method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: 'https://bbwmaint.github.io' },
    body: JSON.stringify({
      service_id: EJS_SVC, template_id: EJS_TPL, user_id: EJS_PUB, accessToken: EJS_PRIV,
      template_params: { to_email: to, subject, message: text,
                         reporter: 'BBW Maintenance App', asset_name: 'Rotation Report', photos: '' }
    })
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`EmailJS ${r.status}: ${body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 220)}`);
}

/* ── main ──────────────────────────────────────────────────────────────────── */
async function main() {
  const at    = val('at') ? new Date(val('at')) : new Date();
  const days  = val('days') ? Math.max(1, +val('days')) : ROT_DAYS;
  let start = val('start'), end = val('end');
  if (start && !end)      end   = addDays(start, days - 1);
  else if (end && !start) start = addDays(end, -(days - 1));
  else if (!start && !end) {
    // the rotation that just ended = the one that contains yesterday, aligned to the anchor
    const yesterday = addDays(torontoDate(at), -1);
    const idx = Math.floor(daysBetween(ROT_ANCHOR, yesterday) / days);
    start = addDays(ROT_ANCHOR, idx * days);
    end   = addDays(start, days - 1);
  }
  const claimId = `ROT_${start}_${end}`;

  console.log(`Rotation window : ${start} → ${end}  (${days} days, anchor ${ROT_ANCHOR})`);
  console.log(`Recipients      : ${RECIPIENTS.join(', ') || '(none — ROTATION_TO not set)'}`);

  if (!DRY) {
    if (!RECIPIENTS.length) throw new Error('ROTATION_TO is not set — refusing to send (no maintenance-inbox fallback).');
    if (!SB_URL || !SB_KEY) throw new Error('SUPABASE_URL / SUPABASE_KEY missing');
    if (!EJS_PUB || !EJS_PRIV) throw new Error('EMAILJS_PUBLIC_KEY / EMAILJS_PRIVATE_KEY missing');
    if (!(await claim(claimId))) return;
  }

  try {
    let rows = [];
    if (SB_URL && SB_KEY) {
      try { rows = await fetchWindow(start, end); }
      catch (e) { if (!DRY) throw e; console.warn('Could not reach Supabase (dry run):', e.message); }
    }
    const R = buildRotation(start, end, rows);
    // block index + A-B/C-D label, aligned to the app's Rotation Stats tab
    R.blockIdx = Math.floor(daysBetween(ROT_ANCHOR, start) / days);
    R.rotName  = (days === 4) ? rotName(R.blockIdx) : null;
    console.log(`Rows: ${rows.length}  ·  Technicians: ${R.techs.length}  ·  Total: ${R.team.totalLabour.toFixed(1)} h${R.rotName ? `  ·  Shift ${R.rotName}` : ''}`);

    let pdf = null; const fname = rotationFileName(R);
    try { pdf = buildRotationPDF(R); console.log(`PDF: ${fname} (${pdf.length} bytes)`); }
    catch (e) { console.warn('PDF build failed:', e.message); if (!DRY) throw e; }

    let pdfUrl = null;
    if (pdf && SB_URL && SB_KEY && !DRY) {
      try { pdfUrl = await uploadPDF(pdf, fname); console.log(`PDF hosted: ${pdfUrl}`); }
      catch (e) { console.warn(`Could not upload the PDF: ${e.message}`); }
    }

    const mail = emailBody(R, pdfUrl);
    if (DRY) {
      console.log(`\n--- DRY RUN — nothing sent ---\nTo: ${RECIPIENTS.join(', ')}\nSubject: ${mail.subject}\nPDF: ${pdf ? `${fname} (${pdf.length} bytes)` : 'none'}\n\n${mail.text}`);
      return;
    }

    for (const to of RECIPIENTS) { await sendEmailTo(to, mail); console.log(`SENT to ${to}`); }
    await confirmSent(claimId);
    console.log(`Done${pdfUrl ? ' (PDF linked)' : ''}.`);
  } catch (err) {
    if (!DRY) await release(claimId);
    throw err;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
}
