// BBW Rotation Maintenance ("weekly stats") Report PDF — captured from the live app.
//
// Rather than re-implement weekStats() + reportPDF() in Node (hundreds of lines,
// including the production/schedule math) and risk drifting from the real KPIs,
// this loads the actual index.html headless and calls the app's OWN report code,
// capturing the PDF that jsPDF produces. The output is byte-identical to the PDF
// Praful generates by hand from the Rotation Stats tab, and it stays in sync
// forever — whenever the in-app report changes, the emailed one changes with it.
import { chromium } from 'playwright';
import path from 'path';

// In CI the repo is checked out, so index.html sits at the working-dir root.
// Override with APP_HTML for local testing.
const INDEX = process.env.APP_HTML || path.resolve(process.cwd(), 'index.html');

// RLS-locked tables (worklog, WOs, requests, util) are read in NODE with the
// privileged job key — the proven way past RLS. Reading them from inside the
// headless page did NOT bypass RLS, so the report used to come out all zeros.
// Production/schedule (bbw_schedule) is anon-readable, so it still loads in-page.
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_KEY || '';

async function sbGetAll(pathRel) {
  const sep = pathRel.includes('?') ? '&' : '?';
  let out = [], offset = 0; const step = 1000;
  for (;;) {
    const url = `${SB_URL}/rest/v1/${pathRel}${sep}limit=${step}&offset=${offset}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(45000),
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error(`${pathRel} -> ${r.status} ${(await r.text()).slice(0, 160)}`);
    const batch = await r.json();
    if (!Array.isArray(batch)) throw new Error(`${pathRel} -> non-array response`);
    out = out.concat(batch);
    if (batch.length < step) break;
    offset += step;
    if (offset > 300000) break;
  }
  return out;
}
async function fetchReportData(start, end) {
  const [entries, utils, requests, wos] = await Promise.all([
    sbGetAll(`bbw_worklog?select=*&date=gte.${start}&date=lte.${end}&order=date.asc`),
    sbGetAll(`bbw_util_log?select=*&date=gte.${start}&date=lte.${end}`),
    sbGetAll(`bbw_requests?select=*&order=created_at.asc`),
    sbGetAll(`bbw_wos?select=*&order=id.asc`),
  ]);
  return { entries, utils, requests, wos };
}

export function statsFileName(start, end) {
  return `BBW_Stats_Report_${start}_to_${end}.pdf`;
}

// Build the rotation maintenance PDF for [start,end]. Returns { pdf: Buffer, stats }.
export async function buildStatsPDF(start, end, opts = {}) {
  const subtitle = opts.subtitle || `${start} to ${end}`;
  const idx = (opts.idx != null) ? opts.idx : 0;
  if (!SB_URL || !SB_KEY) throw new Error('SUPABASE_URL / SUPABASE_KEY missing');

  const data = await fetchReportData(start, end);
  // Safety net on the RLS-locked core tables: both empty => the privileged read
  // failed, not a quiet week. Refuse so a zeros report is never emailed again.
  if (!data.entries.length && !data.wos.length) {
    throw new Error('report data came back empty (worklog + work orders both 0) — refusing to build a zeros report; check SUPABASE_KEY is the secret job key');
  }

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    const warns = [];
    page.on('pageerror', e => warns.push(e.message));
    await page.goto('file://' + INDEX, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    const res = await page.evaluate(async (r) => {
      // jsPDF's save() builds a Blob and "downloads" it via a blob: URL — capture it.
      const _orig = URL.createObjectURL.bind(URL);
      let captured = null;
      URL.createObjectURL = function (blob) { captured = blob; return _orig(blob); };

      // Reports are editor-gated in the app; run as an editor.
      try { user = (typeof EDITORS !== 'undefined' && EDITORS[0]) || 'Praful'; } catch (e) {}
      // Core data was already fetched in Node with the privileged key (past RLS).
      try { REQUESTS = r.data.requests || []; } catch (e) {}
      // Production/schedule is anon-readable, so load it in-page as before.
      try { loadSchedulesFromStorage(); } catch (e) {}
      try { await loadSchedulesFromSB(); } catch (e) {}   // production / schedule (hL, productivity)

      const data = r.data;
      const C = weekStats(data, r.start, r.end);
      const bounds = {
        start: r.start, end: r.end, idx: r.idx,
        sd: new Date(r.start + 'T00:00:00'), ed: new Date(r.end + 'T00:00:00')
      };
      reportPDF(C, bounds, 'ROTATION MAINTENANCE REPORT', r.subtitle, 'BBW_Stats_' + r.start);

      if (!captured) throw new Error('reportPDF produced no PDF blob');
      const bytes = new Uint8Array(await captured.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return {
        b64: btoa(bin),
        stats: {
          tasks: C.tasks, techs: C.techs,
          downHrs: C.downHrs, downEvents: C.downEvents, slowHrs: C.slowHrs,
          pmDue: C.pmDue, pmDone: C.pmDone, pmPct: C.pmPct,
          coCount: C.coCount, reqReceived: C.reqReceived, reqClosed: C.reqClosed,
          volHL: C.volHL, meanProd: C.meanProd, attain: C.attain
        }
      };
    }, { start, end, idx, subtitle, data });

    if (warns.length) console.warn('  (app warnings: ' + warns.slice(0, 3).join(' | ') + ')');
    const pdf = Buffer.from(res.b64, 'base64');
    if (pdf.length < 1000 || pdf.slice(0, 5).toString() !== '%PDF-') {
      throw new Error('captured bytes are not a valid PDF (' + pdf.length + ' bytes)');
    }
    return { pdf, stats: res.stats };
  } finally {
    await browser.close();
  }
}
