#!/usr/bin/env node
/**
 * BBW — rotation stats GATE.
 * ---------------------------------------------------------------------------
 * Cheap, dependency-free check that decides whether the weekly rotation stats
 * PDF should be sent yet. It answers one question: has the 4-day block that
 * just ended got BOTH day and night production data for ALL of its days?
 *
 * Only when that's true (or --force/--start is given) does it report
 * ready=true — and the workflow then spins up Chromium and runs
 * stats-report.mjs for that exact window. Every other poll exits in a second
 * with no heavy work.
 *
 * Uses only Node's built-in fetch — no npm install needed to run the gate.
 *
 * Env:   SUPABASE_URL  SUPABASE_KEY  ROTATION_ANCHOR(2026-08-05)  ROTATION_DAYS(4)
 * Flags: --start YYYY-MM-DD  --end YYYY-MM-DD  --days N  --force  --at ISO
 * Output: ready / start / end written to $GITHUB_OUTPUT (and printed).
 */
import { appendFileSync } from 'fs';

const args  = process.argv.slice(2);
const flag  = (n) => args.includes(`--${n}`);
const val   = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };

const TZ         = 'America/Toronto';
const SB_URL     = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY     = process.env.SUPABASE_KEY || '';
const ROT_DAYS   = +(process.env.ROTATION_DAYS || 4);
const ROT_ANCHOR = (process.env.ROTATION_ANCHOR || '2026-08-05').trim();

function torontoDate(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
}
const addDays     = (ds, n) => { const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

function sb(path) {
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    signal: AbortSignal.timeout(25000),
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
  });
}
async function sbGet(path, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await sb(path); const body = await r.text();
      if (!r.ok) throw new Error(`${r.status} ${body.slice(0, 160)}`);
      return JSON.parse(body);
    } catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 500 * (i + 1))); }
  }
  throw lastErr;
}

function setOutput(k, v) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}
function emit(ready, start, end, reason) {
  setOutput('ready', ready ? 'true' : 'false');
  setOutput('start', start || '');
  setOutput('end',   end   || '');
  console.log(`GATE ready=${ready} window=${start || '?'}\u2192${end || '?'} \u2014 ${reason}`);
}

async function main() {
  const at   = val('at') ? new Date(val('at')) : new Date();
  const days = val('days') ? Math.max(1, +val('days')) : ROT_DAYS;

  // Resolve the window: explicit --start wins; otherwise the block that just ended.
  let start = val('start'), end = val('end');
  if (start && !end)      end   = addDays(start, days - 1);
  else if (end && !start) start = addDays(end, -(days - 1));
  else if (!start && !end) {
    // The most recent block that has FULLY ended (poll-safe — runs any time of day).
    const today  = torontoDate(at);
    const curIdx = Math.floor(daysBetween(ROT_ANCHOR, today) / days);  // block containing today
    const idx    = curIdx - 1;                                         // the one before it = just ended
    start = addDays(ROT_ANCHOR, idx * days);
    end   = addDays(start, days - 1);
  }

  // --force or an explicit window bypasses the completeness check entirely.
  if (flag('force') || val('start') || val('end')) return emit(true, start, end, 'forced / explicit window');

  if (!SB_URL || !SB_KEY) return emit(false, start, end, 'SUPABASE_URL / SUPABASE_KEY missing');

  // Already sent for this window? Then there's nothing to do.
  const claimId = `STATS_${start}_${end}`;
  const seen = await sbGet('bbw_report_sent?select=id,sent_at&id=eq.' + encodeURIComponent(claimId));
  if (seen.length && seen[0].sent_at) return emit(false, start, end, 'already sent');

  // Completeness: every day in the block needs BOTH day (dHL) and night (nHL) volume.
  const data = (await sbGet('bbw_schedule?select=id,data&id=eq.tech'))[0]?.data || {};
  const missing = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    const o = data[d] || {};
    const hasDay   = o.dHL != null;
    const hasNight = o.nHL != null;
    if (!hasDay || !hasNight) missing.push(`${d}(${hasDay ? '' : 'day'}${(!hasDay && !hasNight) ? '+' : ''}${hasNight ? '' : 'night'})`);
  }
  const present = days - missing.length;

  if (missing.length === 0) return emit(true, start, end, `complete: all ${days} days have day+night data`);

  // Any shift missing production data -> do not send; wait until it's complete.
  return emit(false, start, end, `waiting \u2014 ${present}/${days} days complete; missing ${missing.join(', ')}`);
}

main().catch(e => { console.error('GATE ERROR:', e && e.message || e); setOutput('ready', 'false'); process.exit(0); });
