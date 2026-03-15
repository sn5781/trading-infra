import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const LORIS_FUNDING_URL = 'https://api.loris.tools/funding';

const DATA_DIR = path.resolve('./data');
const LATEST_PATH = path.join(DATA_DIR, 'basis-latest.json');

const POLL_MS = 30_000;
const DEDUPE_MS = 10 * 60_000;

function nowUtcHHMM() {
  const d = new Date();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

function fmtUsd(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return 'n/a';
  return `$${x.toFixed(2)}`;
}

function fmtBps(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return 'n/a';
  const sign = x >= 0 ? '+' : '';
  return `${sign}${Math.round(x)} bps`;
}

function fmtPct1(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return 'n/a';
  return `${x.toFixed(1)}%`;
}

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 10_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchHyperliquidAsset() {
  // CL is a HIP-3 market on the "xyz" perp dex.
  // Hyperliquid info endpoint uses `dex` (not `perpDex`) to select the perp dex.
  const dex = process.env.HL_DEX || 'xyz';
  const payload = { type: 'metaAndAssetCtxs', dex };
  const j = await fetchJson(HL_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: 10_000,
  });

  if (!Array.isArray(j) || j.length < 2) throw new Error('Unexpected Hyperliquid response shape');
  const [meta, assetCtxs] = j;
  const universe = meta?.universe;
  if (!Array.isArray(universe) || !Array.isArray(assetCtxs)) throw new Error('Unexpected Hyperliquid meta/universe shape');

  const envAsset = process.env.HL_ASSET;
  const defaultAsset = `${dex}:CL`;
  const wanted = [envAsset, defaultAsset, 'CL'].filter(Boolean);

  let idx = -1;
  let foundName = null;
  for (const name of wanted) {
    idx = universe.findIndex((a) => a?.name === name);
    if (idx !== -1) {
      foundName = name;
      break;
    }
  }
  if (idx === -1) {
    const sample = universe.slice(0, 20).map((a) => a?.name).filter(Boolean);
    throw new Error(
      `Could not find ${wanted.join('/')} in Hyperliquid universe. ` +
        `Set HL_ASSET to override. (sample: ${sample.join(', ')})`
    );
  }

  const ctx = assetCtxs[idx];
  const markPx = Number.parseFloat(ctx?.markPx);
  const oraclePx = Number.parseFloat(ctx?.oraclePx);
  const fundingRate = Number.parseFloat(ctx?.funding);

  if (!Number.isFinite(markPx) || !Number.isFinite(oraclePx)) {
    throw new Error(`Non-numeric markPx/oraclePx for ${foundName}: markPx=${ctx?.markPx} oraclePx=${ctx?.oraclePx}`);
  }

  return {
    symbol: foundName,
    markPx,
    oraclePx,
    fundingRate: Number.isFinite(fundingRate) ? fundingRate : null,
  };
}

async function fetchLorisFundingHyperliquid(symbols = ['CL', 'WTI']) {
  const j = await fetchJson(LORIS_FUNDING_URL, { timeoutMs: 10_000 });
  const fr = j?.funding_rates;
  if (!fr || typeof fr !== 'object') throw new Error('Unexpected Loris response shape (funding_rates missing)');

  const hl = fr?.hyperliquid;
  if (!hl || typeof hl !== 'object') {
    // Loris may be down-leveling or changing schema.
    return { fundingRateRaw: null, fundingSymbol: null };
  }

  for (const sym of symbols) {
    if (Object.prototype.hasOwnProperty.call(hl, sym)) {
      const fundingRateRaw = Number.parseFloat(hl[sym]);
      return {
        fundingRateRaw: Number.isFinite(fundingRateRaw) ? fundingRateRaw : null,
        fundingSymbol: sym,
      };
    }
  }

  return { fundingRateRaw: null, fundingSymbol: null };
}

function computeBasisBps(markPx, oraclePx) {
  return ((markPx - oraclePx) / oraclePx) * 10_000;
}

function computeAnnualizedFundingPctFromLoris(fundingRateRaw) {
  // Loris funding_rate is multiplied by 10,000 for precision.
  // annualized_funding = (funding_rate / 10000) * 3 * 365 * 100
  const unit = lorisFundingRateToUnit(fundingRateRaw);
  if (unit === null) return null;
  return unit * 3 * 365 * 100;
}

function lorisFundingRateToUnit(fundingRateRaw) {
  if (fundingRateRaw === null || fundingRateRaw === undefined || Number.isNaN(fundingRateRaw)) return null;
  return fundingRateRaw / 10_000;
}

function computeAnnualizedFundingPctFromHl(fundingRate) {
  // Hyperliquid assetCtxs `funding` is already a unit rate (e.g. 0.0000125), not x1e4.
  // Hyperliquid funding is paid 3x/day (8h), so annualization matches the spec: rate * 3 * 365 * 100.
  if (fundingRate === null || fundingRate === undefined || Number.isNaN(fundingRate)) return null;
  return fundingRate * 3 * 365 * 100;
}

async function readState() {
  try {
    const txt = await fs.readFile(LATEST_PATH, 'utf8');
    return JSON.parse(txt);
  } catch {
    return {};
  }
}

async function writeLatest(obj) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${LATEST_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, LATEST_PATH);
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };

  await fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 10_000,
  });
}

function buildAlert({ kind, emoji, markPx, oraclePx, basisBps, fundingRate, annualizedFundingPct }) {
  const lines = [];
  lines.push(`${emoji} ${kind} ${nowUtcHHMM()}`);
  lines.push(`Mark: ${fmtUsd(markPx)} | Oracle: ${fmtUsd(oraclePx)}`);
  lines.push(`Basis: ${fmtBps(basisBps)}`);

  const fundingRaw =
    fundingRate === null || fundingRate === undefined || Number.isNaN(fundingRate)
      ? 'n/a'
      : `${(fundingRate * 100).toFixed(4)}%/8h`;
  lines.push(`Funding: ${fundingRaw} | ${fmtPct1(annualizedFundingPct)} ann.`);

  return lines.join('\n');
}

function logCycle({ ts, markPx, oraclePx, basisBps, fundingRate, annualizedFundingPct }) {
  const parts = [
    ts,
    `mark=${markPx.toFixed(4)}`,
    `oracle=${oraclePx.toFixed(4)}`,
    `basis_bps=${basisBps.toFixed(2)}`,
    `funding_rate=${fundingRate === null ? 'n/a' : fundingRate.toFixed(10)}`,
    `funding_ann_pct=${annualizedFundingPct === null ? 'n/a' : annualizedFundingPct.toFixed(2)}`,
  ];
  console.log(parts.join(' | '));
}

async function runOnce({ forceTestAlert = false } = {}) {
  const ts = new Date().toISOString();
  const prev = await readState();

  const { symbol, markPx, oraclePx, fundingRate: hlFundingRate } = await fetchHyperliquidAsset();
  const basisBps = computeBasisBps(markPx, oraclePx);

  // Primary funding source: Hyperliquid assetCtxs `funding`.
  const fundingRate = hlFundingRate;
  const annualizedFundingPct = computeAnnualizedFundingPctFromHl(fundingRate);

  // Secondary (optional) funding source: Loris. Kept for inspection but not used for alerts/annualization.
  let lorisFundingRateRaw = null;
  let lorisFundingSymbol = null;
  try {
    const fr = await fetchLorisFundingHyperliquid(['CL', 'WTI', symbol].filter(Boolean));
    lorisFundingRateRaw = fr.fundingRateRaw;
    lorisFundingSymbol = fr.fundingSymbol;
  } catch (e) {
    console.error(`[${ts}] Loris funding fetch failed: ${e?.message || e}`);
  }

  logCycle({ ts, markPx, oraclePx, basisBps, fundingRate, annualizedFundingPct });

  const state = {
    ts,
    symbol,
    markPx,
    oraclePx,
    basis_bps: basisBps,

    // Hyperliquid funding
    funding_rate: fundingRate,
    annualized_funding_pct: annualizedFundingPct,

    // Loris (optional)
    loris_funding_rate_raw: lorisFundingRateRaw,
    loris_funding_symbol: lorisFundingSymbol,
    loris_annualized_funding_pct: computeAnnualizedFundingPctFromLoris(lorisFundingRateRaw),

    alerts: {
      basis_last_ms: prev?.alerts?.basis_last_ms ?? 0,
      funding_last_ms: prev?.alerts?.funding_last_ms ?? 0,
    },
  };

  const nowMs = Date.now();

  const basisTrigger = Math.abs(basisBps) > 200;
  const fundingTrigger = annualizedFundingPct !== null && Math.abs(annualizedFundingPct) > 50;

  if (forceTestAlert) {
    const text = buildAlert({
      kind: 'TEST ALERT',
      emoji: '🧪',
      markPx,
      oraclePx,
      basisBps,
      fundingRate,
      annualizedFundingPct,
    });
    try {
      await sendTelegram(text);
      console.log(`[${ts}] Sent test alert`);
    } catch (e) {
      console.error(`[${ts}] Telegram send failed (test): ${e?.message || e}`);
    }
  } else {
    if (basisTrigger && nowMs - state.alerts.basis_last_ms > DEDUPE_MS) {
      const text = buildAlert({
        kind: 'BASIS WIDE',
        emoji: '🔴',
        markPx,
        oraclePx,
        basisBps,
        fundingRate,
        annualizedFundingPct,
      });
      try {
        await sendTelegram(text);
        state.alerts.basis_last_ms = nowMs;
      } catch (e) {
        console.error(`[${ts}] Telegram send failed (basis): ${e?.message || e}`);
      }
    }

    if (fundingTrigger && nowMs - state.alerts.funding_last_ms > DEDUPE_MS) {
      const text = buildAlert({
        kind: 'FUNDING EXTREME',
        emoji: '🟡',
        markPx,
        oraclePx,
        basisBps,
        fundingRate,
        annualizedFundingPct,
      });
      try {
        await sendTelegram(text);
        state.alerts.funding_last_ms = nowMs;
      } catch (e) {
        console.error(`[${ts}] Telegram send failed (funding): ${e?.message || e}`);
      }
    }
  }

  await writeLatest(state);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const isTest = args.has('--test');

  if (isTest) {
    try {
      await runOnce({ forceTestAlert: true });
    } catch (e) {
      console.error(`[${new Date().toISOString()}] --test failed: ${e?.message || e}`);
      process.exitCode = 1;
    }
    return;
  }

  let running = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!running) {
      running = true;
      runOnce()
        .catch((e) => {
          console.error(`[${new Date().toISOString()}] cycle failed: ${e?.message || e}`);
        })
        .finally(() => {
          running = false;
        });
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(`[${new Date().toISOString()}] fatal: ${e?.message || e}`);
  process.exitCode = 1;
});
