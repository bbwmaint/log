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

export function statsFileName(start, end) {
  return `BBW_Stats_Report_${start}_to_${end}.pdf`;
}

// Build the rotation maintenance PDF for [start,end]. Returns { pdf: Buffer, stats }.
export async function buildStatsPDF(start, end, opts = {}) {
  const subtitle = opts.subtitle || `${start} to ${end}`;
  const idx = (opts.idx != null) ? opts.idx : 0;
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
      user = (typeof EDITORS !== 'undefined' && EDITORS[0]) || 'Praful';
      try { loadSchedulesFromStorage(); } catch (e) {}
      try { await loadSchedulesFromSB(); } catch (e) {}   // production / schedule (hL, productivity)
      try { await loadRequests(); } catch (e) {}          // requests received / closed

      const data = await loadReportData(r.start, r.end);
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
    }, { start, end, idx, subtitle });

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
