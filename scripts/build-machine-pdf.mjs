// BBW Weekly Machine Report PDF — captured from the live app (machineWeekPDF).
//
// Same approach as build-stats-pdf.mjs: rather than re-implement the report in
// Node, load the actual index.html headless and call the app's own
// machineWeekStats() + machineWeekPDF(), capturing the PDF jsPDF produces. The
// emailed PDF is byte-identical to the one Praful makes from More → Weekly
// Machine Report, and stays in sync whenever the in-app report changes.
import { chromium } from 'playwright';
import path from 'path';

const INDEX = process.env.APP_HTML || path.resolve(process.cwd(), 'index.html');

export function machineFileName(start, end) {
  return `BBW_Machine_Week_${start}_to_${end}.pdf`;
}

// Build the weekly machine (downtime) PDF for [start,end]. Returns { pdf, stats }.
export async function buildMachinePDF(start, end) {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    const warns = [];
    page.on('pageerror', e => warns.push(e.message));
    await page.goto('file://' + INDEX, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    const res = await page.evaluate(async (r) => {
      const _o = URL.createObjectURL.bind(URL);
      let cap = null;
      URL.createObjectURL = function (b) { cap = b; return _o(b); };

      user = (typeof EDITORS !== 'undefined' && EDITORS[0]) || 'Praful';  // reports are editor-gated
      try { loadSchedulesFromStorage(); } catch (e) {}
      try { await loadSchedulesFromSB(); } catch (e) {}
      try { await loadRequests(); } catch (e) {}                          // for the Requests bar

      const data = await loadReportData(r.start, r.end);
      const C = machineWeekStats(data.entries, r.start, r.end);
      try {                                                               // PM completion + requests
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
    }, { start, end });

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
