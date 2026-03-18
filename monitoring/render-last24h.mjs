import fs from 'node:fs/promises';
import path from 'node:path';

const LOG_DIR = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.resolve('./data/logs');
const OUT_DIR = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : path.resolve('./site');
const OUT_PATH = path.join(OUT_DIR, 'index.html');

function utcStamp(ms) {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mo}-${da} ${hh}:${mi} UTC`;
}

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function num(x) {
  if (x === null || x === undefined) return null;
  const n = Number.parseFloat(x);
  return Number.isFinite(n) ? n : null;
}

function fmtBps(x) {
  const n = num(x);
  if (n === null) return '';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}`;
}

function fmtPct(x) {
  const n = num(x);
  if (n === null) return '';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}`;
}

async function readEventsSince(sinceMs) {
  const days = new Set([
    new Date(Date.now()).toISOString().slice(0, 10),
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  ]);

  const events = [];
  for (const day of days) {
    const p = path.join(LOG_DIR, `events-${day}.ndjson`);
    let txt;
    try {
      txt = await fs.readFile(p, 'utf8');
    } catch {
      continue;
    }
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (!j.E || j.E < sinceMs) continue;
      events.push(j);
    }
  }
  events.sort((a, b) => a.E - b.E);
  return events;
}

function rowsFromAlerts(events) {
  const rows = [];
  for (const ev of events) {
    if (ev.e !== 'monitor_alert') continue;
    if (ev.status !== 'sent') continue;
    const kind = ev.kind;
    if (kind !== 'BASIS DISLOCATION' && kind !== 'FUNDING DISLOCATION') continue;

    const inst = Array.isArray(ev.instruments) ? ev.instruments : [];
    for (const i of inst) {
      rows.push({
        ts: ev.E,
        kind,
        category: ev.category,
        sym: i.s,
        dex: i.dex,
        asset: i.asset,
        basisBps: i.basisBps,
        fundingAprPct: i.fundingAprPct,
        markPx: i.markPx,
        refPx: i.refPx,
      });
    }
  }
  return rows;
}

async function main() {
  const now = Date.now();
  const sinceMs = now - 24 * 60 * 60 * 1000;

  const events = await readEventsSince(sinceMs);
  const rows = rowsFromAlerts(events);

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dislocations (last 24h)</title>
</head>
<body>
  <h1>Dislocations (last 24h)</h1>
  <div>Generated: ${esc(utcStamp(now))}</div>
  <div>Rows: ${rows.length}</div>
  <br />
  <table border="1" cellspacing="0" cellpadding="6">
    <thead>
      <tr>
        <th>time_utc</th>
        <th>kind</th>
        <th>category</th>
        <th>symbol</th>
        <th>dex</th>
        <th>basis_bps</th>
        <th>funding_apr_%</th>
        <th>mark</th>
        <th>ref</th>
      </tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (r) => `<tr>
        <td>${esc(utcStamp(r.ts))}</td>
        <td>${esc(r.kind)}</td>
        <td>${esc(r.category)}</td>
        <td>${esc(r.sym)}</td>
        <td>${esc(r.dex)}</td>
        <td>${esc(fmtBps(r.basisBps))}</td>
        <td>${esc(fmtPct(r.fundingAprPct))}</td>
        <td>${esc(r.markPx ?? '')}</td>
        <td>${esc(r.refPx ?? '')}</td>
      </tr>`
        )
        .join('\n')}
    </tbody>
  </table>
</body>
</html>
`;

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(OUT_PATH, html, 'utf8');
  console.log(`wrote ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exitCode = 1;
});
