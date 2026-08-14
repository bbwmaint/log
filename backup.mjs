#!/usr/bin/env node
/*
 * BBW Work Log — daily Supabase backup.
 * Fetches every row of every table and writes a dated JSON snapshot into ./backups.
 * Runs in GitHub Actions (see .github/workflows/backup.yml) or locally:
 *     node backup.mjs
 * The Supabase URL + anon key are baked in as defaults (the anon key is already
 * public in index.html), so no secrets are required — but you can override them
 * with the SB_URL / SB_KEY environment variables if you prefer.
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const SB  = process.env.SB_URL || 'https://klrxecmasfrwowdhplfn.supabase.co';
const KEY = process.env.SB_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtscnhlY21hc2Zyd293ZGhwbGZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1OTY3NjgsImV4cCI6MjA5NjE3Mjc2OH0.bav6VMyGrOeRgf1q0eMA2ZvnVmPdF64FTlBa7BPhO6o';

const TABLES = ['bbw_worklog', 'bbw_util_log', 'bbw_pm_overrides', 'bbw_schedule'];
const PAGE = 1000;

// Fetch with retry. Supabase occasionally returns a transient gateway error as PLAIN TEXT
// ("upstream connect error … delayed connect error: 111"), which is not JSON and was crashing
// the daily backup. Retry a few times with backoff; never JSON.parse a non-OK / non-JSON body.
async function sbGet(url, range) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(30000),
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: range },
      });
      const text = await res.text();
      if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      try { return JSON.parse(text); }
      catch { throw new Error(`non-JSON response: ${text.slice(0, 160)}`); }
    } catch (e) {
      lastErr = e;
      console.log(`  retry ${attempt}/4 after: ${String(e.message).slice(0, 120)}`);
      if (attempt < 4) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

async function columnsExceptPhotos(table) {
  // Read one row to learn the column names, then drop the base64 photo columns.
  const rows = await sbGet(`${SB}/rest/v1/${table}?select=*`, '0-0');
  const one = rows[0];
  return one ? Object.keys(one).filter(k => k !== 'photos' && k !== 'photo').join(',') : '*';
}

async function fetchAll(table) {
  // bbw_worklog stores base64 photos inline; SELECT * on them exceeds Supabase's statement
  // timeout (error 57014). Back up every column EXCEPT the photos (which still live in
  // Supabase). Columns are discovered live so a schema change won't break this.
  const select = (table === 'bbw_worklog') ? await columnsExceptPhotos(table) : '*';
  let rows = [], from = 0;
  for (;;) {
    const batch = await sbGet(`${SB}/rest/v1/${table}?select=${select}`, `${from}-${from + PAGE - 1}`);
    rows = rows.concat(batch);
    if (batch.length < PAGE) break; // last page reached
    from += PAGE;
  }
  return rows;
}

const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
const snapshot = { generated: new Date().toISOString(), source: SB, tables: {} };
let total = 0;

for (const t of TABLES) {
  const rows = await fetchAll(t);
  if (t === 'bbw_worklog') {
    // Drop inline base64 photos from the snapshot. They made the file ~34 MB and were
    // bloating the git repo daily, which is what broke the push. Photos still live in Supabase.
    for (const r of rows) { delete r.photos; delete r.photo; }
  }
  snapshot.tables[t] = rows;
  total += rows.length;
  console.log(`  ${t}: ${rows.length} rows`);
}

mkdirSync('backups', { recursive: true });
const json = JSON.stringify(snapshot); // minified — was pretty-printed, which inflated size ~35%
writeFileSync(`backups/bbw-backup-${date}.json`, json);
writeFileSync('backups/latest.json', json); // always-current copy for quick restore
console.log(`Backup ${date} complete — ${total} rows across ${TABLES.length} tables.`);
