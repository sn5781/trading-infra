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
function fmtBps(x) { const n = num(x); if (n === null) return '—'; return `${n >= 0 ? '+' : ''}${n.toFixed(1)} bps`; }
function fmtPct(x) { const n = num(x); if (n === null) return '—'; return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`; }
function cls(x) { const n = num(x); return n === null ? '' : (n >= 0 ? 'pos' : 'neg'); }

async function readEventsSince(sinceMs) {
  const days = new Set([
    new Date(Date.now()).toISOString().slice(0, 10),
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  ]);
  const events = [];
  for (const day of days) {
    const p = path.join(LOG_DIR, `events-${day}.ndjson`);
    let txt;
    try { txt = await fs.readFile(p, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (!j.E || j.E < sinceMs) continue;
        events.push(j);
      } catch {}
    }
  }
  events.sort((a, b) => a.E - b.E);
  return events;
}

function rowsFromAlerts(events) {
  const rows = [];
  for (const ev of events) {
    if (ev.e !== 'monitor_alert' || ev.status !== 'sent') continue;
    if (ev.kind !== 'BASIS DISLOCATION' && ev.kind !== 'FUNDING DISLOCATION') continue;
    for (const i of Array.isArray(ev.instruments) ? ev.instruments : []) {
      rows.push({
        ts: ev.E,
        kind: ev.kind,
        category: ev.category,
        sym: i.s || i.asset || i.key,
        dex: i.dex,
        basisBps: i.basisBps,
        fundingAprPct: i.fundingAprPct,
        markPx: i.markPx,
        refPx: i.refPx,
        score: Math.max(Math.abs(num(i.basisBps) ?? 0), Math.abs(num(i.fundingAprPct) ?? 0)),
      });
    }
  }
  rows.sort((a, b) => b.score - a.score || b.ts - a.ts);
  return rows;
}

async function main() {
  const now = Date.now();
  const sinceMs = now - 24 * 60 * 60 * 1000;
  const events = await readEventsSince(sinceMs);
  const rows = rowsFromAlerts(events);
  const newest = rows[0]?.ts ?? now;
  const staleH = ((now - newest) / 3600000).toFixed(1);

  const css = `
  :root{--bg:#0a0e1a;--p:#0f172a;--m:#94a3b8;--fg:#e5e7eb;--pos:#4ade80;--neg:#f87171;--ln:#1f2a44}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,Liberation Mono,Courier New,monospace}
  .w{max-width:1280px;margin:0 auto;padding:20px}.top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}.t{font-weight:700;font-size:18px}.s{color:var(--m);font-size:12px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}@media(max-width:860px){.grid{grid-template-columns:repeat(2,1fr)}}
  .card{background:var(--p);border:1px solid var(--ln);border-radius:12px;padding:12px}.k{color:var(--m);font-size:11px}.v{font-size:16px;font-weight:700}.tbl{width:100%;border-collapse:collapse;background:var(--p);border:1px solid var(--ln);border-radius:12px;overflow:hidden}.tbl th,.tbl td{border-bottom:1px solid rgba(148,163,184,.15);padding:8px;text-align:left}.tbl th{color:var(--m);font-size:12px}.pos{color:var(--pos)}.neg{color:var(--neg)} a{color:#cbd5e1}
  `;

  const html = `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Dislocations (last 24h)</title><style>${css}</style></head><body><div class=w>
  <div class=top><div class=t>Dislocations (last 24h)</div><div class=s>Generated: ${esc(utcStamp(now))}</div></div>
  <div class=grid>
    <div class=card><div class=k>Rows</div><div class=v>${rows.length}</div></div>
    <div class=card><div class=k>Latest event</div><div class=v>${esc(utcStamp(newest))}</div></div>
    <div class=card><div class=k>Stale</div><div class=v>${esc(staleH)}h</div></div>
    <div class=card><div class=k>Sources</div><div class=v><a href="https://github.com/sn5781/trading-infra/tree/logs/logs/monitoring" target="_blank" rel="noreferrer">logs branch</a></div></div>
  </div>
  <div class=s style="margin-bottom:12px">Data sources: local monitor NDJSON on the <b>logs</b> branch, sourced from Hyperliquid / DefiLlama / CowSwap flows already captured by the monitoring stack. BTC brief has a shortcut link to this page.</div>
  <table class=tbl><thead><tr><th>time_utc</th><th>kind</th><th>category</th><th>symbol</th><th>dex</th><th>basis</th><th>funding APR</th><th>mark</th><th>ref</th></tr></thead><tbody>
  ${rows.map(r => `<tr><td>${esc(utcStamp(r.ts))}</td><td>${esc(r.kind)}</td><td>${esc(r.category)}</td><td>${esc(r.sym)}</td><td>${esc(r.dex)}</td><td class="${cls(r.basisBps)}">${esc(fmtBps(r.basisBps))}</td><td class="${cls(r.fundingAprPct)}">${esc(fmtPct(r.fundingAprPct))}</td><td>${esc(r.markPx ?? '')}</td><td>${esc(r.refPx ?? '')}</td></tr>`).join('')}
  </tbody></table>
  <div class=s style="margin-top:12px">Canonical page for 24h dislocations. Root app and BTC brief should link here.</div>
  </div></body></html>`;

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(OUT_PATH, html, 'utf8');
  console.log(`wrote ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exitCode = 1;
});
