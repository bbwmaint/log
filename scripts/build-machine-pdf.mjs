// BBW Weekly Machine Report PDF.
//
// Data is read in NODE via direct REST with the privileged job key — the proven
// way past RLS (same as the green check-db-access workflow). Reading from INSIDE
// the headless page (reassigning SBKEY) did NOT actually bypass RLS, so the
// emailed report came out all zeros. Now the page is used ONLY to render: we hand
// it the already-fetched rows and call the app's own machineWeekStats() +
// weekStats() + machineWeekPDF(), so the PDF stays byte-identical to the in-app
// one while the numbers are real.
import { chromium } from 'playwright';
import path from 'path';

const INDEX  = process.env.APP_HTML || path.resolve(process.cwd(), 'index.html');
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_KEY || '';

// Page past PostgREST's 1000-row cap with limit/offset.
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

export function machineFileName(start, end) {
  return `BBW_Machine_Week_${start}_to_${end}.pdf`;
}

// Build the weekly machine (downtime) PDF for [start,end]. Returns { pdf, stats }.
export async function buildMachinePDF(start, end) {
  if (!SB_URL || !SB_KEY) throw new Error('SUPABASE_URL / SUPABASE_KEY missing');

  const data = await fetchReportData(start, end);
  // Safety net keyed on the RLS-LOCKED core tables (worklog + work orders) — the
  // anon key can still read a few forklift requests, so requests is NOT a reliable
  // signal. A plant always has work orders and logs daily, so both of these being
  // empty means the privileged read failed (bad key / RLS), not a quiet week.
  // Refuse, so a zeros report is never emailed to the team again.
  if (!data.entries.length && !data.wos.length) {
    throw new Error('report data came back empty (worklog + work orders both 0) — refusing to build a zeros report; check SUPABASE_KEY is the secret job key');
  }

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    const warns = [];
    page.on('pageerror', e => warns.push(e.message));
    await page.goto('file://' + INDEX, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    const res = await page.evaluate(async (r) => {
      const _o = URL.createObjectURL.bind(URL);
      let cap = null;
      URL.createObjectURL = function (b) { cap = b; return _o(b); };

      try { user = (typeof EDITORS !== 'undefined' && EDITORS[0]) || 'Praful'; } catch (e) {}
      try { REQUESTS = r.data.requests || []; } catch (e) {}   // global weekStats reads for reqClosed

      const data = r.data;                                     // already fetched in Node
      const C = machineWeekStats(data.entries, r.start, r.end);
      try {
        const Wk = weekStats(data, r.start, r.end);
        C.pmDue = Wk.pmDue; C.pmDone = Wk.pmDone; C.pmPct = Wk.pmPct;
        C.reqReceived = Wk.reqReceived; C.reqClosed = Wk.reqClosed;
      } catch (e) {}
      machineWeekPDF(C, r.start, r.end);

      if (!cap) throw new Error('machineWeekPDF produced no PDF blob');
      const bytes = new Uint8Array(await cap.arrayBuffer());
      let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return {
        b64: btoa(bin),
        stats: {
          fullMin: Math.round((C.totFull || 0) * 60), fullN: C.totFullN,
          partMin: Math.round((C.totPart || 0) * 60), partN: C.totPartN,
          machineCount: C.machineCount,
          worst: C.worst ? C.worst.asset : null,
          worstMin: C.worst ? Math.round(C.worst.total * 60) : 0,
          pmDue: C.pmDue, pmDone: C.pmDone, pmPct: C.pmPct,
          reqReceived: C.reqReceived, reqClosed: C.reqClosed
        }
      };
    }, { start, end, data });

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
