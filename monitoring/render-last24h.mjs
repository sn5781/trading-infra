import fs from 'node:fs/promises';
import { readFileSync as rfs } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve('./data');
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
function fmtPx(x, d = 3) { const n = num(x); if (n === null) return "—"; return "$" + n.toFixed(d); }

function fmtM(x){const n=num(x);if(n===null)return'—';if(Math.abs(n)>=1e9)return'fp) { try { return JSON.parse(rfs(fp, "utf8")); } catch { return null; } }
function buildFuturesCard(r, l, cardTitle, exchangeLabel) {
  if (!r && !l) return "";
  const roll = r?.roll || {}; const front = r?.front || {}; const next = r?.next || {};
  const wf = num(roll.w_front); const wn = num(roll.w_next);
  const rl = (wf > 0 && wn > 0) ? "roll active" : "single-month";
  const src = r?.ref_price_source || "—";
  const lg = r?.ibkr_login_time ? r.ibkr_login_time.slice(0,16).replace("T"," ") + " UTC" : "—";
  return `
  <div class=card style="margin-bottom:14px;padding:16px">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <div class=t style="font-size:15px">🛢 ${cardTitle} — ${exchangeLabel} Reference</div>
      <div class=s>source: ${esc(exchangeLabel)} / ${esc(src)} · IBKR: ${esc(lg)}</div>
    </div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL mark</div><div class=v>${esc(fmtPx(l?.markPx,2))}</div></div>
      <div class=card><div class=k>CME ref</div><div class=v>${esc(fmtPx(roll.ref_price,3))}</div></div>
      <div class=card><div class=k>CME basis</div><div class="v ${cls(l?.cme_basis_bps)}">${esc(fmtBps(l?.cme_basis_bps))}</div></div>
      <div class=card><div class=k>Oracle basis</div><div class="v ${cls(l?.basis_bps)}">${esc(fmtBps(l?.basis_bps))}</div></div>
    </div>
    <div class=s style="margin:-4px 0 12px 0">Funding APR: <span class="${cls(l?.annualized_funding_pct)}">${esc(fmtPct(l?.annualized_funding_pct))}</span></div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL OI</div><div class=v>${esc(fmtM(l?.open_interest_usd))}</div></div>
      <div class=card><div class=k>HL 24h Vol</div><div class=v>${esc(fmtM(l?.day_ntl_vlm))}</div></div>
      <div class=card><div class=k>IBKR OI</div><div class=v>${roll.open_interest!=null?esc(fmtContracts(roll.open_interest))+' cts':'—'}</div></div>
      <div class=card><div class=k>IBKR 24h Vol</div><div class=v>${roll.volume!=null?esc(fmtContracts(roll.volume))+' cts':'—'}</div></div>
    </div>
    <div class=grid>
      <div class=card><div class=k>Roll</div><div class=v>BD${esc(String(roll.business_day??"?"))} · ${esc(rl)}</div></div>
      <div class=card><div class=k>Weights F/N</div><div class=v>${wf==null?"—":Math.round(wf*100)+"%"} / ${wn==null?"—":Math.round(wn*100)+"%"}</div></div>
      <div class=card><div class=k>Front (${esc(front.localSymbol||"?")})</div><div class=v>${esc(fmtPx(front.price,3))}</div></div>
      <div class=card><div class=k>Next (${esc(next.localSymbol||"?")})</div><div class=v>${esc(fmtPx(next.price,3))}</div></div>
    </div>
  </div>`;
}

function buildEtfCard(r, l, cardTitle, exchangeLabel) {
  if (!r && !l) return "";
  const c = r?.contract || {};
  const src = r?.price_source || c?.price_source || "—";
  const lg = r?.ibkr_login_time ? r.ibkr_login_time.slice(0,16).replace("T"," ") + " UTC" : "—";
  return `
  <div class=card style="margin-bottom:14px;padding:16px">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <div class=t style="font-size:15px">☢️ ${cardTitle} — ${exchangeLabel} ETF Reference</div>
      <div class=s>source: ${esc(exchangeLabel)} / ${esc(src)} · IBKR: ${esc(lg)}</div>
    </div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL mark</div><div class=v>${esc(fmtPx(l?.markPx,2))}</div></div>
      <div class=card><div class=k>ETF ref</div><div class=v>${esc(fmtPx(r?.ref_price,2))}</div></div>
      <div class=card><div class=k>ETF basis</div><div class="v ${cls(l?.cme_basis_bps)}">${esc(fmtBps(l?.cme_basis_bps))}</div></div>
      <div class=card><div class=k>Oracle basis</div><div class="v ${cls(l?.basis_bps)}">${esc(fmtBps(l?.basis_bps))}</div></div>
    </div>
    <div class=s style="margin:-4px 0 12px 0">Funding APR: <span class="${cls(l?.annualized_funding_pct)}">${esc(fmtPct(l?.annualized_funding_pct))}</span></div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL OI</div><div class=v>${esc(fmtM(l?.open_interest_usd))}</div></div>
      <div class=card><div class=k>HL 24h Vol</div><div class=v>${esc(fmtM(l?.day_ntl_vlm))}</div></div>
      <div class=card><div class=k>Mkt Cap</div><div class=v>${esc(fmtM(r?.market_cap_usd))}</div></div>
      <div class=card><div class=k>IBKR 24h Vol</div><div class=v>${r?.volume_24h!=null?esc(fmtContracts(r.volume_24h))+' shs':'—'}</div></div>
    </div>
    <div class=grid>
      <div class=card><div class=k>Ticker</div><div class=v>${esc(c.localSymbol||"?")}</div></div>
      <div class=card><div class=k>Venue</div><div class=v>${esc(c.primaryExchange||exchangeLabel)}</div></div>
      <div class=card><div class=k>Bid / Ask</div><div class=v>${esc(fmtPx(c.bid,2))} / ${esc(fmtPx(c.ask,2))}</div></div>
      <div class=card><div class=k>Last / Close</div><div class=v>${esc(fmtPx(c.last,2))} / ${esc(fmtPx(c.close,2))}</div></div>
    </div>
  </div>`;
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
  const clRef = loadJson(path.join(DATA_DIR, "cl-ref.json"));
  const basisLatest = loadJson(path.join(DATA_DIR, "basis-latest.json"));
  const clLatest = basisLatest?.instruments?.CL || null;
  const clCard = buildFuturesCard(clRef, clLatest, "CL (WTI)", "CME/NYMEX");
  const copperRef = loadJson(path.join(DATA_DIR, "copper-ref.json"));
  const copperLatest = basisLatest?.instruments?.["xyz:COPPER"] || basisLatest?.instruments?.["COPPER"] || null;
  const copperCard = buildFuturesCard(copperRef, copperLatest, "COPPER", "COMEX");
  const brentRef = loadJson(path.join(DATA_DIR, "brent-ref.json"));
  const brentLatest = basisLatest?.instruments?.["BRENTOIL"] || basisLatest?.instruments?.["xyz:BRENTOIL"] || null;
  const brentCard = buildFuturesCard(brentRef, brentLatest, "BRENTOIL", "ICE/NYMEX");
  const urnmRef = loadJson(path.join(DATA_DIR, "urnm-ref.json"));
  const urnmLatest = basisLatest?.instruments?.["URNM"] || basisLatest?.instruments?.["xyz:URNM"] || null;
  const urnmCard = buildEtfCard(urnmRef, urnmLatest, "URNM", "ARCA");

  const lastPulled = events.length ? Math.max(...events.map((e) => e.E || 0)) : now;
  const staleH = ((now - lastPulled) / 3600000).toFixed(1);

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
    <div class=card><div class=k>Last pulled from logs</div><div class=v>${esc(utcStamp(lastPulled))}</div></div>
    <div class=card><div class=k>Stale</div><div class=v>${esc(staleH)}h</div></div>
    <div class=card><div class=k>Sources</div><div class=v><a href="https://github.com/sn5781/trading-infra/tree/logs/logs/monitoring" target="_blank" rel="noreferrer">logs branch</a></div></div>
  </div>
  ${clCard}
  ${copperCard}
  ${brentCard}
  ${urnmCard}
  ${brentCard}
  ${urnmCard}
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
+(n/1e9).toFixed(2)+'B';if(Math.abs(n)>=1e6)return'fp) { try { return JSON.parse(rfs(fp, "utf8")); } catch { return null; } }
function buildFuturesCard(r, l, cardTitle, exchangeLabel) {
  if (!r && !l) return "";
  const roll = r?.roll || {}; const front = r?.front || {}; const next = r?.next || {};
  const wf = num(roll.w_front); const wn = num(roll.w_next);
  const rl = (wf > 0 && wn > 0) ? "roll active" : "single-month";
  const src = r?.ref_price_source || "—";
  const lg = r?.ibkr_login_time ? r.ibkr_login_time.slice(0,16).replace("T"," ") + " UTC" : "—";
  return `
  <div class=card style="margin-bottom:14px;padding:16px">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <div class=t style="font-size:15px">🛢 ${cardTitle} — ${exchangeLabel} Reference</div>
      <div class=s>source: ${esc(exchangeLabel)} / ${esc(src)} · IBKR: ${esc(lg)}</div>
    </div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL mark</div><div class=v>${esc(fmtPx(l?.markPx,2))}</div></div>
      <div class=card><div class=k>CME ref</div><div class=v>${esc(fmtPx(roll.ref_price,3))}</div></div>
      <div class=card><div class=k>CME basis</div><div class="v ${cls(l?.cme_basis_bps)}">${esc(fmtBps(l?.cme_basis_bps))}</div></div>
      <div class=card><div class=k>Oracle basis</div><div class="v ${cls(l?.basis_bps)}">${esc(fmtBps(l?.basis_bps))}</div></div>
    </div>
    <div class=s style="margin:-4px 0 12px 0">Funding APR: <span class="${cls(l?.annualized_funding_pct)}">${esc(fmtPct(l?.annualized_funding_pct))}</span></div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL OI</div><div class=v>${esc(fmtM(l?.open_interest_usd))}</div></div>
      <div class=card><div class=k>HL 24h Vol</div><div class=v>${esc(fmtM(l?.day_ntl_vlm))}</div></div>
      <div class=card><div class=k>IBKR OI</div><div class=v>${roll.open_interest!=null?esc(fmtContracts(roll.open_interest))+' cts':'—'}</div></div>
      <div class=card><div class=k>IBKR 24h Vol</div><div class=v>${roll.volume!=null?esc(fmtContracts(roll.volume))+' cts':'—'}</div></div>
    </div>
    <div class=grid>
      <div class=card><div class=k>Roll</div><div class=v>BD${esc(String(roll.business_day??"?"))} · ${esc(rl)}</div></div>
      <div class=card><div class=k>Weights F/N</div><div class=v>${wf==null?"—":Math.round(wf*100)+"%"} / ${wn==null?"—":Math.round(wn*100)+"%"}</div></div>
      <div class=card><div class=k>Front (${esc(front.localSymbol||"?")})</div><div class=v>${esc(fmtPx(front.price,3))}</div></div>
      <div class=card><div class=k>Next (${esc(next.localSymbol||"?")})</div><div class=v>${esc(fmtPx(next.price,3))}</div></div>
    </div>
  </div>`;
}

function buildEtfCard(r, l, cardTitle, exchangeLabel) {
  if (!r && !l) return "";
  const c = r?.contract || {};
  const src = r?.price_source || c?.price_source || "—";
  const lg = r?.ibkr_login_time ? r.ibkr_login_time.slice(0,16).replace("T"," ") + " UTC" : "—";
  return `
  <div class=card style="margin-bottom:14px;padding:16px">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <div class=t style="font-size:15px">☢️ ${cardTitle} — ${exchangeLabel} ETF Reference</div>
      <div class=s>source: ${esc(exchangeLabel)} / ${esc(src)} · IBKR: ${esc(lg)}</div>
    </div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL mark</div><div class=v>${esc(fmtPx(l?.markPx,2))}</div></div>
      <div class=card><div class=k>ETF ref</div><div class=v>${esc(fmtPx(r?.ref_price,2))}</div></div>
      <div class=card><div class=k>ETF basis</div><div class="v ${cls(l?.cme_basis_bps)}">${esc(fmtBps(l?.cme_basis_bps))}</div></div>
      <div class=card><div class=k>Oracle basis</div><div class="v ${cls(l?.basis_bps)}">${esc(fmtBps(l?.basis_bps))}</div></div>
    </div>
    <div class=s style="margin:-4px 0 12px 0">Funding APR: <span class="${cls(l?.annualized_funding_pct)}">${esc(fmtPct(l?.annualized_funding_pct))}</span></div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL OI</div><div class=v>${esc(fmtM(l?.open_interest_usd))}</div></div>
      <div class=card><div class=k>HL 24h Vol</div><div class=v>${esc(fmtM(l?.day_ntl_vlm))}</div></div>
      <div class=card><div class=k>Mkt Cap</div><div class=v>${esc(fmtM(r?.market_cap_usd))}</div></div>
      <div class=card><div class=k>IBKR 24h Vol</div><div class=v>${r?.volume_24h!=null?esc(fmtContracts(r.volume_24h))+' shs':'—'}</div></div>
    </div>
    <div class=grid>
      <div class=card><div class=k>Ticker</div><div class=v>${esc(c.localSymbol||"?")}</div></div>
      <div class=card><div class=k>Venue</div><div class=v>${esc(c.primaryExchange||exchangeLabel)}</div></div>
      <div class=card><div class=k>Bid / Ask</div><div class=v>${esc(fmtPx(c.bid,2))} / ${esc(fmtPx(c.ask,2))}</div></div>
      <div class=card><div class=k>Last / Close</div><div class=v>${esc(fmtPx(c.last,2))} / ${esc(fmtPx(c.close,2))}</div></div>
    </div>
  </div>`;
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
  const clRef = loadJson(path.join(DATA_DIR, "cl-ref.json"));
  const basisLatest = loadJson(path.join(DATA_DIR, "basis-latest.json"));
  const clLatest = basisLatest?.instruments?.CL || null;
  const clCard = buildFuturesCard(clRef, clLatest, "CL (WTI)", "CME/NYMEX");
  const copperRef = loadJson(path.join(DATA_DIR, "copper-ref.json"));
  const copperLatest = basisLatest?.instruments?.["xyz:COPPER"] || basisLatest?.instruments?.["COPPER"] || null;
  const copperCard = buildFuturesCard(copperRef, copperLatest, "COPPER", "COMEX");
  const brentRef = loadJson(path.join(DATA_DIR, "brent-ref.json"));
  const brentLatest = basisLatest?.instruments?.["BRENTOIL"] || basisLatest?.instruments?.["xyz:BRENTOIL"] || null;
  const brentCard = buildFuturesCard(brentRef, brentLatest, "BRENTOIL", "ICE/NYMEX");
  const urnmRef = loadJson(path.join(DATA_DIR, "urnm-ref.json"));
  const urnmLatest = basisLatest?.instruments?.["URNM"] || basisLatest?.instruments?.["xyz:URNM"] || null;
  const urnmCard = buildEtfCard(urnmRef, urnmLatest, "URNM", "ARCA");

  const lastPulled = events.length ? Math.max(...events.map((e) => e.E || 0)) : now;
  const staleH = ((now - lastPulled) / 3600000).toFixed(1);

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
    <div class=card><div class=k>Last pulled from logs</div><div class=v>${esc(utcStamp(lastPulled))}</div></div>
    <div class=card><div class=k>Stale</div><div class=v>${esc(staleH)}h</div></div>
    <div class=card><div class=k>Sources</div><div class=v><a href="https://github.com/sn5781/trading-infra/tree/logs/logs/monitoring" target="_blank" rel="noreferrer">logs branch</a></div></div>
  </div>
  ${clCard}
  ${copperCard}
  ${brentCard}
  ${urnmCard}
  ${brentCard}
  ${urnmCard}
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
+(n/1e6).toFixed(1)+'M';if(Math.abs(n)>=1e3)return'fp) { try { return JSON.parse(rfs(fp, "utf8")); } catch { return null; } }
function buildFuturesCard(r, l, cardTitle, exchangeLabel) {
  if (!r && !l) return "";
  const roll = r?.roll || {}; const front = r?.front || {}; const next = r?.next || {};
  const wf = num(roll.w_front); const wn = num(roll.w_next);
  const rl = (wf > 0 && wn > 0) ? "roll active" : "single-month";
  const src = r?.ref_price_source || "—";
  const lg = r?.ibkr_login_time ? r.ibkr_login_time.slice(0,16).replace("T"," ") + " UTC" : "—";
  return `
  <div class=card style="margin-bottom:14px;padding:16px">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <div class=t style="font-size:15px">🛢 ${cardTitle} — ${exchangeLabel} Reference</div>
      <div class=s>source: ${esc(exchangeLabel)} / ${esc(src)} · IBKR: ${esc(lg)}</div>
    </div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL mark</div><div class=v>${esc(fmtPx(l?.markPx,2))}</div></div>
      <div class=card><div class=k>CME ref</div><div class=v>${esc(fmtPx(roll.ref_price,3))}</div></div>
      <div class=card><div class=k>CME basis</div><div class="v ${cls(l?.cme_basis_bps)}">${esc(fmtBps(l?.cme_basis_bps))}</div></div>
      <div class=card><div class=k>Oracle basis</div><div class="v ${cls(l?.basis_bps)}">${esc(fmtBps(l?.basis_bps))}</div></div>
    </div>
    <div class=s style="margin:-4px 0 12px 0">Funding APR: <span class="${cls(l?.annualized_funding_pct)}">${esc(fmtPct(l?.annualized_funding_pct))}</span></div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL OI</div><div class=v>${esc(fmtM(l?.open_interest_usd))}</div></div>
      <div class=card><div class=k>HL 24h Vol</div><div class=v>${esc(fmtM(l?.day_ntl_vlm))}</div></div>
      <div class=card><div class=k>IBKR OI</div><div class=v>${roll.open_interest!=null?esc(fmtContracts(roll.open_interest))+' cts':'—'}</div></div>
      <div class=card><div class=k>IBKR 24h Vol</div><div class=v>${roll.volume!=null?esc(fmtContracts(roll.volume))+' cts':'—'}</div></div>
    </div>
    <div class=grid>
      <div class=card><div class=k>Roll</div><div class=v>BD${esc(String(roll.business_day??"?"))} · ${esc(rl)}</div></div>
      <div class=card><div class=k>Weights F/N</div><div class=v>${wf==null?"—":Math.round(wf*100)+"%"} / ${wn==null?"—":Math.round(wn*100)+"%"}</div></div>
      <div class=card><div class=k>Front (${esc(front.localSymbol||"?")})</div><div class=v>${esc(fmtPx(front.price,3))}</div></div>
      <div class=card><div class=k>Next (${esc(next.localSymbol||"?")})</div><div class=v>${esc(fmtPx(next.price,3))}</div></div>
    </div>
  </div>`;
}

function buildEtfCard(r, l, cardTitle, exchangeLabel) {
  if (!r && !l) return "";
  const c = r?.contract || {};
  const src = r?.price_source || c?.price_source || "—";
  const lg = r?.ibkr_login_time ? r.ibkr_login_time.slice(0,16).replace("T"," ") + " UTC" : "—";
  return `
  <div class=card style="margin-bottom:14px;padding:16px">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <div class=t style="font-size:15px">☢️ ${cardTitle} — ${exchangeLabel} ETF Reference</div>
      <div class=s>source: ${esc(exchangeLabel)} / ${esc(src)} · IBKR: ${esc(lg)}</div>
    </div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL mark</div><div class=v>${esc(fmtPx(l?.markPx,2))}</div></div>
      <div class=card><div class=k>ETF ref</div><div class=v>${esc(fmtPx(r?.ref_price,2))}</div></div>
      <div class=card><div class=k>ETF basis</div><div class="v ${cls(l?.cme_basis_bps)}">${esc(fmtBps(l?.cme_basis_bps))}</div></div>
      <div class=card><div class=k>Oracle basis</div><div class="v ${cls(l?.basis_bps)}">${esc(fmtBps(l?.basis_bps))}</div></div>
    </div>
    <div class=s style="margin:-4px 0 12px 0">Funding APR: <span class="${cls(l?.annualized_funding_pct)}">${esc(fmtPct(l?.annualized_funding_pct))}</span></div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL OI</div><div class=v>${esc(fmtM(l?.open_interest_usd))}</div></div>
      <div class=card><div class=k>HL 24h Vol</div><div class=v>${esc(fmtM(l?.day_ntl_vlm))}</div></div>
      <div class=card><div class=k>Mkt Cap</div><div class=v>${esc(fmtM(r?.market_cap_usd))}</div></div>
      <div class=card><div class=k>IBKR 24h Vol</div><div class=v>${r?.volume_24h!=null?esc(fmtContracts(r.volume_24h))+' shs':'—'}</div></div>
    </div>
    <div class=grid>
      <div class=card><div class=k>Ticker</div><div class=v>${esc(c.localSymbol||"?")}</div></div>
      <div class=card><div class=k>Venue</div><div class=v>${esc(c.primaryExchange||exchangeLabel)}</div></div>
      <div class=card><div class=k>Bid / Ask</div><div class=v>${esc(fmtPx(c.bid,2))} / ${esc(fmtPx(c.ask,2))}</div></div>
      <div class=card><div class=k>Last / Close</div><div class=v>${esc(fmtPx(c.last,2))} / ${esc(fmtPx(c.close,2))}</div></div>
    </div>
  </div>`;
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
  const clRef = loadJson(path.join(DATA_DIR, "cl-ref.json"));
  const basisLatest = loadJson(path.join(DATA_DIR, "basis-latest.json"));
  const clLatest = basisLatest?.instruments?.CL || null;
  const clCard = buildFuturesCard(clRef, clLatest, "CL (WTI)", "CME/NYMEX");
  const copperRef = loadJson(path.join(DATA_DIR, "copper-ref.json"));
  const copperLatest = basisLatest?.instruments?.["xyz:COPPER"] || basisLatest?.instruments?.["COPPER"] || null;
  const copperCard = buildFuturesCard(copperRef, copperLatest, "COPPER", "COMEX");
  const brentRef = loadJson(path.join(DATA_DIR, "brent-ref.json"));
  const brentLatest = basisLatest?.instruments?.["BRENTOIL"] || basisLatest?.instruments?.["xyz:BRENTOIL"] || null;
  const brentCard = buildFuturesCard(brentRef, brentLatest, "BRENTOIL", "ICE/NYMEX");
  const urnmRef = loadJson(path.join(DATA_DIR, "urnm-ref.json"));
  const urnmLatest = basisLatest?.instruments?.["URNM"] || basisLatest?.instruments?.["xyz:URNM"] || null;
  const urnmCard = buildEtfCard(urnmRef, urnmLatest, "URNM", "ARCA");

  const lastPulled = events.length ? Math.max(...events.map((e) => e.E || 0)) : now;
  const staleH = ((now - lastPulled) / 3600000).toFixed(1);

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
    <div class=card><div class=k>Last pulled from logs</div><div class=v>${esc(utcStamp(lastPulled))}</div></div>
    <div class=card><div class=k>Stale</div><div class=v>${esc(staleH)}h</div></div>
    <div class=card><div class=k>Sources</div><div class=v><a href="https://github.com/sn5781/trading-infra/tree/logs/logs/monitoring" target="_blank" rel="noreferrer">logs branch</a></div></div>
  </div>
  ${clCard}
  ${copperCard}
  ${brentCard}
  ${urnmCard}
  ${brentCard}
  ${urnmCard}
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
+(n/1e3).toFixed(0)+'K';return'fp) { try { return JSON.parse(rfs(fp, "utf8")); } catch { return null; } }
function buildFuturesCard(r, l, cardTitle, exchangeLabel) {
  if (!r && !l) return "";
  const roll = r?.roll || {}; const front = r?.front || {}; const next = r?.next || {};
  const wf = num(roll.w_front); const wn = num(roll.w_next);
  const rl = (wf > 0 && wn > 0) ? "roll active" : "single-month";
  const src = r?.ref_price_source || "—";
  const lg = r?.ibkr_login_time ? r.ibkr_login_time.slice(0,16).replace("T"," ") + " UTC" : "—";
  return `
  <div class=card style="margin-bottom:14px;padding:16px">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <div class=t style="font-size:15px">🛢 ${cardTitle} — ${exchangeLabel} Reference</div>
      <div class=s>source: ${esc(exchangeLabel)} / ${esc(src)} · IBKR: ${esc(lg)}</div>
    </div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL mark</div><div class=v>${esc(fmtPx(l?.markPx,2))}</div></div>
      <div class=card><div class=k>CME ref</div><div class=v>${esc(fmtPx(roll.ref_price,3))}</div></div>
      <div class=card><div class=k>CME basis</div><div class="v ${cls(l?.cme_basis_bps)}">${esc(fmtBps(l?.cme_basis_bps))}</div></div>
      <div class=card><div class=k>Oracle basis</div><div class="v ${cls(l?.basis_bps)}">${esc(fmtBps(l?.basis_bps))}</div></div>
    </div>
    <div class=s style="margin:-4px 0 12px 0">Funding APR: <span class="${cls(l?.annualized_funding_pct)}">${esc(fmtPct(l?.annualized_funding_pct))}</span></div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL OI</div><div class=v>${esc(fmtM(l?.open_interest_usd))}</div></div>
      <div class=card><div class=k>HL 24h Vol</div><div class=v>${esc(fmtM(l?.day_ntl_vlm))}</div></div>
      <div class=card><div class=k>IBKR OI</div><div class=v>${roll.open_interest!=null?esc(fmtContracts(roll.open_interest))+' cts':'—'}</div></div>
      <div class=card><div class=k>IBKR 24h Vol</div><div class=v>${roll.volume!=null?esc(fmtContracts(roll.volume))+' cts':'—'}</div></div>
    </div>
    <div class=grid>
      <div class=card><div class=k>Roll</div><div class=v>BD${esc(String(roll.business_day??"?"))} · ${esc(rl)}</div></div>
      <div class=card><div class=k>Weights F/N</div><div class=v>${wf==null?"—":Math.round(wf*100)+"%"} / ${wn==null?"—":Math.round(wn*100)+"%"}</div></div>
      <div class=card><div class=k>Front (${esc(front.localSymbol||"?")})</div><div class=v>${esc(fmtPx(front.price,3))}</div></div>
      <div class=card><div class=k>Next (${esc(next.localSymbol||"?")})</div><div class=v>${esc(fmtPx(next.price,3))}</div></div>
    </div>
  </div>`;
}

function buildEtfCard(r, l, cardTitle, exchangeLabel) {
  if (!r && !l) return "";
  const c = r?.contract || {};
  const src = r?.price_source || c?.price_source || "—";
  const lg = r?.ibkr_login_time ? r.ibkr_login_time.slice(0,16).replace("T"," ") + " UTC" : "—";
  return `
  <div class=card style="margin-bottom:14px;padding:16px">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <div class=t style="font-size:15px">☢️ ${cardTitle} — ${exchangeLabel} ETF Reference</div>
      <div class=s>source: ${esc(exchangeLabel)} / ${esc(src)} · IBKR: ${esc(lg)}</div>
    </div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL mark</div><div class=v>${esc(fmtPx(l?.markPx,2))}</div></div>
      <div class=card><div class=k>ETF ref</div><div class=v>${esc(fmtPx(r?.ref_price,2))}</div></div>
      <div class=card><div class=k>ETF basis</div><div class="v ${cls(l?.cme_basis_bps)}">${esc(fmtBps(l?.cme_basis_bps))}</div></div>
      <div class=card><div class=k>Oracle basis</div><div class="v ${cls(l?.basis_bps)}">${esc(fmtBps(l?.basis_bps))}</div></div>
    </div>
    <div class=s style="margin:-4px 0 12px 0">Funding APR: <span class="${cls(l?.annualized_funding_pct)}">${esc(fmtPct(l?.annualized_funding_pct))}</span></div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL OI</div><div class=v>${esc(fmtM(l?.open_interest_usd))}</div></div>
      <div class=card><div class=k>HL 24h Vol</div><div class=v>${esc(fmtM(l?.day_ntl_vlm))}</div></div>
      <div class=card><div class=k>Mkt Cap</div><div class=v>${esc(fmtM(r?.market_cap_usd))}</div></div>
      <div class=card><div class=k>IBKR 24h Vol</div><div class=v>${r?.volume_24h!=null?esc(fmtContracts(r.volume_24h))+' shs':'—'}</div></div>
    </div>
    <div class=grid>
      <div class=card><div class=k>Ticker</div><div class=v>${esc(c.localSymbol||"?")}</div></div>
      <div class=card><div class=k>Venue</div><div class=v>${esc(c.primaryExchange||exchangeLabel)}</div></div>
      <div class=card><div class=k>Bid / Ask</div><div class=v>${esc(fmtPx(c.bid,2))} / ${esc(fmtPx(c.ask,2))}</div></div>
      <div class=card><div class=k>Last / Close</div><div class=v>${esc(fmtPx(c.last,2))} / ${esc(fmtPx(c.close,2))}</div></div>
    </div>
  </div>`;
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
  const clRef = loadJson(path.join(DATA_DIR, "cl-ref.json"));
  const basisLatest = loadJson(path.join(DATA_DIR, "basis-latest.json"));
  const clLatest = basisLatest?.instruments?.CL || null;
  const clCard = buildFuturesCard(clRef, clLatest, "CL (WTI)", "CME/NYMEX");
  const copperRef = loadJson(path.join(DATA_DIR, "copper-ref.json"));
  const copperLatest = basisLatest?.instruments?.["xyz:COPPER"] || basisLatest?.instruments?.["COPPER"] || null;
  const copperCard = buildFuturesCard(copperRef, copperLatest, "COPPER", "COMEX");
  const brentRef = loadJson(path.join(DATA_DIR, "brent-ref.json"));
  const brentLatest = basisLatest?.instruments?.["BRENTOIL"] || basisLatest?.instruments?.["xyz:BRENTOIL"] || null;
  const brentCard = buildFuturesCard(brentRef, brentLatest, "BRENTOIL", "ICE/NYMEX");
  const urnmRef = loadJson(path.join(DATA_DIR, "urnm-ref.json"));
  const urnmLatest = basisLatest?.instruments?.["URNM"] || basisLatest?.instruments?.["xyz:URNM"] || null;
  const urnmCard = buildEtfCard(urnmRef, urnmLatest, "URNM", "ARCA");

  const lastPulled = events.length ? Math.max(...events.map((e) => e.E || 0)) : now;
  const staleH = ((now - lastPulled) / 3600000).toFixed(1);

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
    <div class=card><div class=k>Last pulled from logs</div><div class=v>${esc(utcStamp(lastPulled))}</div></div>
    <div class=card><div class=k>Stale</div><div class=v>${esc(staleH)}h</div></div>
    <div class=card><div class=k>Sources</div><div class=v><a href="https://github.com/sn5781/trading-infra/tree/logs/logs/monitoring" target="_blank" rel="noreferrer">logs branch</a></div></div>
  </div>
  ${clCard}
  ${copperCard}
  ${brentCard}
  ${urnmCard}
  ${brentCard}
  ${urnmCard}
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
+n.toFixed(0);}
function fmtContracts(x){const n=num(x);if(n===null)return'—';if(n>=1e6)return(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return n.toFixed(0);}
function loadJson(fp) { try { return JSON.parse(rfs(fp, "utf8")); } catch { return null; } }
function buildFuturesCard(r, l, cardTitle, exchangeLabel) {
  if (!r && !l) return "";
  const roll = r?.roll || {}; const front = r?.front || {}; const next = r?.next || {};
  const wf = num(roll.w_front); const wn = num(roll.w_next);
  const rl = (wf > 0 && wn > 0) ? "roll active" : "single-month";
  const src = r?.ref_price_source || "—";
  const lg = r?.ibkr_login_time ? r.ibkr_login_time.slice(0,16).replace("T"," ") + " UTC" : "—";
  return `
  <div class=card style="margin-bottom:14px;padding:16px">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <div class=t style="font-size:15px">🛢 ${cardTitle} — ${exchangeLabel} Reference</div>
      <div class=s>source: ${esc(exchangeLabel)} / ${esc(src)} · IBKR: ${esc(lg)}</div>
    </div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL mark</div><div class=v>${esc(fmtPx(l?.markPx,2))}</div></div>
      <div class=card><div class=k>CME ref</div><div class=v>${esc(fmtPx(roll.ref_price,3))}</div></div>
      <div class=card><div class=k>CME basis</div><div class="v ${cls(l?.cme_basis_bps)}">${esc(fmtBps(l?.cme_basis_bps))}</div></div>
      <div class=card><div class=k>Oracle basis</div><div class="v ${cls(l?.basis_bps)}">${esc(fmtBps(l?.basis_bps))}</div></div>
    </div>
    <div class=s style="margin:-4px 0 12px 0">Funding APR: <span class="${cls(l?.annualized_funding_pct)}">${esc(fmtPct(l?.annualized_funding_pct))}</span></div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL OI</div><div class=v>${esc(fmtM(l?.open_interest_usd))}</div></div>
      <div class=card><div class=k>HL 24h Vol</div><div class=v>${esc(fmtM(l?.day_ntl_vlm))}</div></div>
      <div class=card><div class=k>IBKR OI</div><div class=v>${roll.open_interest!=null?esc(fmtContracts(roll.open_interest))+' cts':'—'}</div></div>
      <div class=card><div class=k>IBKR 24h Vol</div><div class=v>${roll.volume!=null?esc(fmtContracts(roll.volume))+' cts':'—'}</div></div>
    </div>
    <div class=grid>
      <div class=card><div class=k>Roll</div><div class=v>BD${esc(String(roll.business_day??"?"))} · ${esc(rl)}</div></div>
      <div class=card><div class=k>Weights F/N</div><div class=v>${wf==null?"—":Math.round(wf*100)+"%"} / ${wn==null?"—":Math.round(wn*100)+"%"}</div></div>
      <div class=card><div class=k>Front (${esc(front.localSymbol||"?")})</div><div class=v>${esc(fmtPx(front.price,3))}</div></div>
      <div class=card><div class=k>Next (${esc(next.localSymbol||"?")})</div><div class=v>${esc(fmtPx(next.price,3))}</div></div>
    </div>
  </div>`;
}

function buildEtfCard(r, l, cardTitle, exchangeLabel) {
  if (!r && !l) return "";
  const c = r?.contract || {};
  const src = r?.price_source || c?.price_source || "—";
  const lg = r?.ibkr_login_time ? r.ibkr_login_time.slice(0,16).replace("T"," ") + " UTC" : "—";
  return `
  <div class=card style="margin-bottom:14px;padding:16px">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <div class=t style="font-size:15px">☢️ ${cardTitle} — ${exchangeLabel} ETF Reference</div>
      <div class=s>source: ${esc(exchangeLabel)} / ${esc(src)} · IBKR: ${esc(lg)}</div>
    </div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL mark</div><div class=v>${esc(fmtPx(l?.markPx,2))}</div></div>
      <div class=card><div class=k>ETF ref</div><div class=v>${esc(fmtPx(r?.ref_price,2))}</div></div>
      <div class=card><div class=k>ETF basis</div><div class="v ${cls(l?.cme_basis_bps)}">${esc(fmtBps(l?.cme_basis_bps))}</div></div>
      <div class=card><div class=k>Oracle basis</div><div class="v ${cls(l?.basis_bps)}">${esc(fmtBps(l?.basis_bps))}</div></div>
    </div>
    <div class=s style="margin:-4px 0 12px 0">Funding APR: <span class="${cls(l?.annualized_funding_pct)}">${esc(fmtPct(l?.annualized_funding_pct))}</span></div>
    <div class=grid style="margin-bottom:10px">
      <div class=card><div class=k>HL OI</div><div class=v>${esc(fmtM(l?.open_interest_usd))}</div></div>
      <div class=card><div class=k>HL 24h Vol</div><div class=v>${esc(fmtM(l?.day_ntl_vlm))}</div></div>
      <div class=card><div class=k>Mkt Cap</div><div class=v>${esc(fmtM(r?.market_cap_usd))}</div></div>
      <div class=card><div class=k>IBKR 24h Vol</div><div class=v>${r?.volume_24h!=null?esc(fmtContracts(r.volume_24h))+' shs':'—'}</div></div>
    </div>
    <div class=grid>
      <div class=card><div class=k>Ticker</div><div class=v>${esc(c.localSymbol||"?")}</div></div>
      <div class=card><div class=k>Venue</div><div class=v>${esc(c.primaryExchange||exchangeLabel)}</div></div>
      <div class=card><div class=k>Bid / Ask</div><div class=v>${esc(fmtPx(c.bid,2))} / ${esc(fmtPx(c.ask,2))}</div></div>
      <div class=card><div class=k>Last / Close</div><div class=v>${esc(fmtPx(c.last,2))} / ${esc(fmtPx(c.close,2))}</div></div>
    </div>
  </div>`;
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
  const clRef = loadJson(path.join(DATA_DIR, "cl-ref.json"));
  const basisLatest = loadJson(path.join(DATA_DIR, "basis-latest.json"));
  const clLatest = basisLatest?.instruments?.CL || null;
  const clCard = buildFuturesCard(clRef, clLatest, "CL (WTI)", "CME/NYMEX");
  const copperRef = loadJson(path.join(DATA_DIR, "copper-ref.json"));
  const copperLatest = basisLatest?.instruments?.["xyz:COPPER"] || basisLatest?.instruments?.["COPPER"] || null;
  const copperCard = buildFuturesCard(copperRef, copperLatest, "COPPER", "COMEX");
  const brentRef = loadJson(path.join(DATA_DIR, "brent-ref.json"));
  const brentLatest = basisLatest?.instruments?.["BRENTOIL"] || basisLatest?.instruments?.["xyz:BRENTOIL"] || null;
  const brentCard = buildFuturesCard(brentRef, brentLatest, "BRENTOIL", "ICE/NYMEX");
  const urnmRef = loadJson(path.join(DATA_DIR, "urnm-ref.json"));
  const urnmLatest = basisLatest?.instruments?.["URNM"] || basisLatest?.instruments?.["xyz:URNM"] || null;
  const urnmCard = buildEtfCard(urnmRef, urnmLatest, "URNM", "ARCA");

  const lastPulled = events.length ? Math.max(...events.map((e) => e.E || 0)) : now;
  const staleH = ((now - lastPulled) / 3600000).toFixed(1);

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
    <div class=card><div class=k>Last pulled from logs</div><div class=v>${esc(utcStamp(lastPulled))}</div></div>
    <div class=card><div class=k>Stale</div><div class=v>${esc(staleH)}h</div></div>
    <div class=card><div class=k>Sources</div><div class=v><a href="https://github.com/sn5781/trading-infra/tree/logs/logs/monitoring" target="_blank" rel="noreferrer">logs branch</a></div></div>
  </div>
  ${clCard}
  ${copperCard}
  ${brentCard}
  ${urnmCard}
  ${brentCard}
  ${urnmCard}
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
