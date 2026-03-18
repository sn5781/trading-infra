import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

// Always load env from monitoring/.env (not the caller's cwd).
dotenv.config({ path: new URL('.env', import.meta.url) });

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

const DATA_DIR = path.resolve('./data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LATEST_PATH = path.join(DATA_DIR, 'basis-latest.json');

// Default scan cadence (quiet): every 20 minutes.
// When any dislocation is detected, temporarily increase cadence to every 5 minutes
// until the market is back within thresholds.
const POLL_MS_QUIET = 20 * 60_000;
const POLL_MS_HOT = 5 * 60_000;
const DEDUPE_MS = 10 * 60_000;

const INSTRUMENTS = [
  // Energy
  { key: 'CL', dex: 'xyz', asset: 'xyz:CL' },
  { key: 'BRENTOIL', dex: 'xyz', asset: 'xyz:BRENTOIL' },
  { key: 'USOIL', dex: 'km', asset: 'km:USOIL' },
];

const METALS_OI_HIGH_USD = 1_000_000;
const METAL_PAT = /(GOLD|SILVER|COPPER|PLATINUM|URANIUM|PALLADIUM|ALUMINIUM|PAXG|XAUT|TGLD)/i;

const COINS_LLAMA_URL = 'https://coins.llama.fi/prices/current';
const COW_QUOTE_URL = 'https://api.cow.fi/mainnet/api/v1/quote';

const CRYPTO_MAJORS = {
  // Hyperliquid perps (main dex)
  perps: [
    { key: 'BTC-PERP', dex: 'main', asset: 'BTC' },
    { key: 'ETH-PERP', dex: 'main', asset: 'ETH' },
  ],
  // On-chain wrappers (DefiLlama price endpoint)
  // Prices are on-chain token prices in USD.
  onchain: [
    { key: 'WETH', chain: 'ethereum', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', underlying: 'ETH' },
    { key: 'stETH', chain: 'ethereum', address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', underlying: 'ETH' },
    { key: 'WBTC', chain: 'ethereum', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', underlying: 'BTC' },
    { key: 'tBTC', chain: 'ethereum', address: '0x18084fbA666a33d37592fA2633fD49a74DD93a88', underlying: 'BTC' },
    // Coinbase Wrapped BTC (cbBTC) on Base
    { key: 'cbBTC', chain: 'base', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', underlying: 'BTC' },
  ],
  // Executable spot (CowSwap) 5k USDC quotes for liquidity-aware basis
  cowswap5k: {
    tradeSizeUsdc: 5000,
    usdc: { chain: 'ethereum', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    tokens: [
      { key: 'WBTC', chain: 'ethereum', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8, underlying: 'BTC' },
      { key: 'WETH', chain: 'ethereum', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, underlying: 'ETH' },
      { key: 'stETH', chain: 'ethereum', address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', decimals: 18, underlying: 'ETH' },
    ],
  },
};

// Extreme thresholds (global)
const EXTREME_BASIS_BPS = 20;
const EXTREME_FUNDING_APR_PCT = 20;

function nowUtcStamp(ms = Date.now()) {
  // e.g. 2026-03-16 21:53 UTC
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
}

function fmtCommaInt(x) {
  if (x === null || x === undefined || Number.isNaN(x) || !Number.isFinite(x)) return 'n/a';
  return Math.round(x).toLocaleString('en-US');
}

function fmtUsd0(x) {
  if (x === null || x === undefined || Number.isNaN(x) || !Number.isFinite(x)) return 'n/a';
  return `$${Math.round(x).toLocaleString('en-US')}`;
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

async function fetchHyperliquidDexMetaAndCtxs(dex) {
  // Hyperliquid info endpoint uses `dex` to select the perp dex.
  // For the first perp dex, omit `dex` entirely.
  const payload = { type: 'metaAndAssetCtxs' };
  if (dex && dex !== 'main') payload.dex = dex;
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

  return { dex: dex || 'main', universe, assetCtxs };
}

function roundTo(x, dp) {
  if (x === null || x === undefined || Number.isNaN(x) || !Number.isFinite(x)) return null;
  const m = 10 ** dp;
  return Math.round(x * m) / m;
}

function pickTopLevels(levels, n = 3) {
  const out = [];
  for (const lvl of (levels || []).slice(0, n)) {
    const px = Number.parseFloat(lvl?.px);
    const sz = Number.parseFloat(lvl?.sz);
    const nn = lvl?.n ?? null;
    out.push({ px: roundTo(px, 6), sz: roundTo(sz, 6), n: typeof nn === 'number' ? nn : null });
  }
  return out;
}

async function fetchL2Book({ coin, dex }) {
  const payload = { type: 'l2Book', coin };
  // Non-main perpdexes require dex selection (HIP-3, etc.).
  if (dex && dex !== 'main') payload.dex = dex;

  const j = await fetchJson(HL_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: 10_000,
  });

  const levels = j?.levels;
  if (!Array.isArray(levels) || levels.length < 2) throw new Error(`Unexpected l2Book response for ${coin}`);
  return { coin: j.coin, time: j.time, bids: levels[0], asks: levels[1] };
}

function summarizeBookSideToBps({ levels, refPx, side, bpsList }) {
  // levels: [{px,sz,n}, ...] ordered best->worse
  // Depth is measured within +/-bps around refPx (we use mid), but always includes the top level.
  const out = {};
  const top = (levels || [])[0];
  const topPx = top ? Number.parseFloat(top?.px) : null;
  const topSz = top ? Number.parseFloat(top?.sz) : null;
  const topN = top?.n ?? null;

  for (const bps of bpsList) {
    const limitPx = side === 'bids'
      ? refPx * (1 - bps / 10_000)
      : refPx * (1 + bps / 10_000);

    let qty = 0;
    let notional = 0;
    let nSum = 0;
    let levelsCount = 0;

    for (const lvl of levels || []) {
      const px = Number.parseFloat(lvl?.px);
      const sz = Number.parseFloat(lvl?.sz);
      const nn = typeof lvl?.n === 'number' ? lvl.n : 0;
      if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
      if (side === 'bids') {
        if (px < limitPx) break;
      } else {
        if (px > limitPx) break;
      }
      qty += sz;
      notional += px * sz;
      nSum += nn;
      levelsCount += 1;
    }

    // Ensure top-of-book is always represented even if spread > bps bucket.
    if (levelsCount === 0 && Number.isFinite(topPx) && Number.isFinite(topSz)) {
      qty = topSz;
      notional = topPx * topSz;
      nSum = typeof topN === 'number' ? topN : 0;
      levelsCount = 1;
    }

    out[`${bps}bps`] = {
      limitPx: roundTo(limitPx, 6),
      qty: roundTo(qty, 6),
      // HL px is USD-quoted in practice; keep name stable for downstream.
      notionalUsd: roundTo(notional, 2),
      levels: levelsCount,
      nSum,
    };
  }
  return out;
}

function summarizeL2Book(book, { bpsList = [10, 25, 50] } = {}) {
  const bestBid = Number.parseFloat(book?.bids?.[0]?.px);
  const bestAsk = Number.parseFloat(book?.asks?.[0]?.px);
  const bestBidSz = Number.parseFloat(book?.bids?.[0]?.sz);
  const bestAskSz = Number.parseFloat(book?.asks?.[0]?.sz);

  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
    return { coin: book?.coin || null, time: book?.time || null, error: 'missing_top' };
  }

  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = ((bestAsk - bestBid) / mid) * 10_000;

  const bidSide = {
    bestPx: roundTo(bestBid, 6),
    bestSz: Number.isFinite(bestBidSz) ? roundTo(bestBidSz, 6) : null,
    top: pickTopLevels(book.bids, 3),
    depth: summarizeBookSideToBps({ levels: book.bids, refPx: mid, side: 'bids', bpsList }),
  };

  const askSide = {
    bestPx: roundTo(bestAsk, 6),
    bestSz: Number.isFinite(bestAskSz) ? roundTo(bestAskSz, 6) : null,
    top: pickTopLevels(book.asks, 3),
    depth: summarizeBookSideToBps({ levels: book.asks, refPx: mid, side: 'asks', bpsList }),
  };

  return {
    coin: book.coin,
    time: book.time,
    mid: roundTo(mid, 6),
    spreadBps: roundTo(spreadBps, 3),
    bpsList,
    bids: bidSide,
    asks: askSide,
  };
}

async function fetchPerpDexs() {
  const payload = { type: 'perpDexs' };
  const j = await fetchJson(HL_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: 10_000,
  });

  if (!Array.isArray(j)) throw new Error('Unexpected perpDexs response shape');
  return j.slice(1); // first element is null
}

function discoverMetalAssetsFromPerpDexs(perpDexs) {
  // Returns: Map<dexName, Set<assetCode>>
  const m = new Map();
  for (const dex of perpDexs) {
    const dexName = dex?.name;
    const caps = dex?.assetToStreamingOiCap;
    if (!dexName || !Array.isArray(caps)) continue;
    for (const [asset] of caps) {
      if (typeof asset !== 'string') continue;
      if (!METAL_PAT.test(asset)) continue;
      if (!m.has(dexName)) m.set(dexName, new Set());
      m.get(dexName).add(asset);
    }
  }
  return m;
}

function discoverMetalAssetsFromUniverse(universe) {
  const out = [];
  for (const a of universe) {
    const name = a?.name;
    if (typeof name === 'string' && METAL_PAT.test(name)) out.push(name);
  }
  return out;
}

function extractAssetFromDex({ dex, universe, assetCtxs }, assetName) {
  const idx = universe.findIndex((a) => a?.name === assetName);
  if (idx === -1) {
    const sample = universe.slice(0, 20).map((a) => a?.name).filter(Boolean);
    throw new Error(`Could not find ${assetName} in Hyperliquid dex=${dex} universe (sample: ${sample.join(', ')})`);
  }

  const ctx = assetCtxs[idx];
  const markPx = Number.parseFloat(ctx?.markPx);
  const oraclePx = Number.parseFloat(ctx?.oraclePx);
  const fundingRate = Number.parseFloat(ctx?.funding);

  if (!Number.isFinite(markPx) || !Number.isFinite(oraclePx)) {
    throw new Error(`Non-numeric markPx/oraclePx for ${assetName} dex=${dex}: markPx=${ctx?.markPx} oraclePx=${ctx?.oraclePx}`);
  }

  return {
    dex,
    asset: assetName,
    markPx,
    oraclePx,
    fundingRate: Number.isFinite(fundingRate) ? fundingRate : null,
  };
}

function computeBasisBps(a, b) {
  return ((a - b) / b) * 10_000;
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

async function fetchDefiLlamaPrices(keys) {
  // keys: [{chain, address}] -> returns Map<"chain:address", price>
  const uniq = [...new Set(keys.map((k) => `${k.chain}:${k.address}`))];
  if (uniq.length === 0) return new Map();
  const url = `${COINS_LLAMA_URL}/${uniq.join(',')}`;
  const j = await fetchJson(url, { timeoutMs: 10_000 });
  const coins = j?.coins;
  if (!coins || typeof coins !== 'object') throw new Error('Unexpected DefiLlama response shape');
  const out = new Map();
  for (const [k, v] of Object.entries(coins)) {
    const p = Number.parseFloat(v?.price);
    if (Number.isFinite(p)) out.set(k, p);
  }
  return out;
}

async function fetchAllMids() {
  const payload = { type: 'allMids' };
  const j = await fetchJson(HL_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: 10_000,
  });
  if (!j || typeof j !== 'object') throw new Error('Unexpected allMids response shape');
  return j;
}

function pow10(n) {
  let x = 1n;
  for (let i = 0; i < n; i++) x *= 10n;
  return x;
}

async function cowQuoteSell({ sellToken, buyToken, sellAmountBeforeFee }) {
  const body = {
    sellToken,
    buyToken,
    receiver: '0x0000000000000000000000000000000000000000',
    from: '0x0000000000000000000000000000000000000000',
    appData: '0x' + '0'.repeat(64),
    partiallyFillable: false,
    validTo: Math.floor(Date.now() / 1000) + 600,
    kind: 'sell',
    sellAmountBeforeFee: String(sellAmountBeforeFee),
  };
  return fetchJson(COW_QUOTE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 10_000,
  });
}

async function fetchCowSwap5kInstruments({ allMids }) {
  const { tradeSizeUsdc, usdc, tokens } = CRYPTO_MAJORS.cowswap5k;
  const usdcAmount = BigInt(Math.round(tradeSizeUsdc * 10 ** usdc.decimals));

  const out = [];
  for (const t of tokens) {
    const ref = Number.parseFloat(allMids[t.underlying]);
    if (!Number.isFinite(ref)) continue;

    // BUY leg: 5k USDC -> token
    const qBuy = await cowQuoteSell({ sellToken: usdc.address, buyToken: t.address, sellAmountBeforeFee: usdcAmount });
    const buyAmountBuy = BigInt(qBuy.quote.buyAmount);
    const buyTokens = Number(buyAmountBuy) / Number(pow10(t.decimals));
    const pxBuy = tradeSizeUsdc / buyTokens;
    const basisBuyBps = computeBasisBps(pxBuy, ref);

    // SELL leg: token -> USDC, with token amount sized to ~5k notional using ref
    const sellTokensTarget = tradeSizeUsdc / ref;
    const sellAmountTokens = BigInt(Math.floor(sellTokensTarget * 10 ** t.decimals));
    const qSell = await cowQuoteSell({ sellToken: t.address, buyToken: usdc.address, sellAmountBeforeFee: sellAmountTokens });
    const buyAmountSell = BigInt(qSell.quote.buyAmount);
    const usdcOut = Number(buyAmountSell) / 10 ** usdc.decimals;
    const soldTokens = Number(sellAmountTokens) / Number(pow10(t.decimals));
    const pxSell = usdcOut / soldTokens;
    const basisSellBps = computeBasisBps(pxSell, ref);

    const dir = basisBuyBps < 0 ? 'BUY' : 'SELL';
    const execPx = dir === 'BUY' ? pxBuy : pxSell;
    const execBasisBps = dir === 'BUY' ? basisBuyBps : basisSellBps;

    out.push({
      key: `${t.key}-COW5K-${dir}`,
      dex: 'cowswap',
      asset: `${t.chain}:${t.address}`,
      markPx: execPx,
      oraclePx: ref,
      basisBps: execBasisBps,
      fundingRate: null,
      annualizedFundingPct: null,
      openInterest: null,
      oiUsd: null,
      category: 'crypto',
    });
  }

  return out;
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

function utcYyyyMmDd(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function appendEventNdjson(obj) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const p = path.join(LOG_DIR, `events-${utcYyyyMmDd(obj.E)}.ndjson`);
  await fs.appendFile(p, JSON.stringify(obj) + '\n', 'utf8');
}

async function readEventNdjsonSince(sinceMs) {
  // Read only relevant daily files (today + yesterday, plus edge case if >24h crosses date boundary).
  const days = new Set([utcYyyyMmDd(Date.now()), utcYyyyMmDd(Date.now() - 24 * 60 * 60 * 1000)]);
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
  return events;
}

function getDislocationStats(events) {
  const sinceMs = Math.min(...events.map((e) => e.E));
  const out = {
    sinceMs: Number.isFinite(sinceMs) ? sinceMs : null,
    countsByEvent: {},
    countsByKind: {},
    basis: { n: 0, avgAbsBps: null, maxAbsBps: null, top: [] },
    funding: { n: 0, avgAbsApr: null, maxAbsApr: null, top: [] },
    severe: { basis_n: 0, funding_n: 0 },
  };

  const basisMags = [];
  const fundingMags = [];

  for (const ev of events) {
    out.countsByEvent[ev.e] = (out.countsByEvent[ev.e] || 0) + 1;
    if (ev.kind) out.countsByKind[ev.kind] = (out.countsByKind[ev.kind] || 0) + 1;

    if (ev.e !== 'monitor_alert') continue;

    const inst = Array.isArray(ev.instruments) ? ev.instruments : [];
    for (const i of inst) {
      const s = i?.s;
      const basisBps = i?.basisBps !== null && i?.basisBps !== undefined ? Number.parseFloat(i.basisBps) : null;
      const fundingApr = i?.fundingAprPct !== null && i?.fundingAprPct !== undefined ? Number.parseFloat(i.fundingAprPct) : null;

      if (ev.kind === 'BASIS DISLOCATION' && Number.isFinite(basisBps)) {
        const mag = Math.abs(basisBps);
        basisMags.push(mag);
        out.basis.top.push({ mag, s, ts: ev.E, basisBps });
        if (mag >= 50) out.severe.basis_n++;
      }
      if (ev.kind === 'FUNDING DISLOCATION' && Number.isFinite(fundingApr)) {
        const mag = Math.abs(fundingApr);
        fundingMags.push(mag);
        out.funding.top.push({ mag, s, ts: ev.E, fundingAprPct: fundingApr });
        if (mag >= 50) out.severe.funding_n++;
      }
    }
  }

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const max = (arr) => (arr.length ? Math.max(...arr) : null);

  out.basis.n = basisMags.length;
  out.basis.avgAbsBps = avg(basisMags);
  out.basis.maxAbsBps = max(basisMags);
  out.basis.top.sort((a, b) => b.mag - a.mag);
  out.basis.top = out.basis.top.slice(0, 5);

  out.funding.n = fundingMags.length;
  out.funding.avgAbsApr = avg(fundingMags);
  out.funding.maxAbsApr = max(fundingMags);
  out.funding.top.sort((a, b) => b.mag - a.mag);
  out.funding.top = out.funding.top.slice(0, 5);

  return out;
}

function buildDailyDislocationSummaryText(stats, { lookbackHours = 24 } = {}) {
  const lines = [];
  lines.push(`📈 LAST ${lookbackHours}H SUMMARY ${nowUtcStamp()}`);

  lines.push('');
  lines.push('EVENT COUNTS');
  for (const [k, v] of Object.entries(stats.countsByEvent).sort()) {
    lines.push(`- ${k}: ${fmtCommaInt(v)}`);
  }

  lines.push('');
  lines.push('ALERT COUNTS (monitor_alert.kind)');
  for (const [k, v] of Object.entries(stats.countsByKind).sort()) {
    lines.push(`- ${k}: ${fmtCommaInt(v)}`);
  }

  lines.push('');
  lines.push(`BASIS DISLOCATIONS: n=${fmtCommaInt(stats.basis.n)} avg_abs=${stats.basis.avgAbsBps ? stats.basis.avgAbsBps.toFixed(1) : 'n/a'} bps max_abs=${stats.basis.maxAbsBps ? stats.basis.maxAbsBps.toFixed(1) : 'n/a'} bps`);
  lines.push(`- severe(|basis|>=50bps): ${fmtCommaInt(stats.severe.basis_n)}`);
  if (stats.basis.top.length) {
    lines.push('- top outliers:');
    for (const t of stats.basis.top) {
      lines.push(`  - ${t.s} | ${t.basisBps.toFixed(1)} bps | ${nowUtcStamp(t.ts)}`);
    }
  }

  lines.push('');
  lines.push(`FUNDING DISLOCATIONS: n=${fmtCommaInt(stats.funding.n)} avg_abs=${stats.funding.avgAbsApr ? stats.funding.avgAbsApr.toFixed(1) : 'n/a'}% max_abs=${stats.funding.maxAbsApr ? stats.funding.maxAbsApr.toFixed(1) : 'n/a'}%`);
  lines.push(`- severe(|funding|>=50%): ${fmtCommaInt(stats.severe.funding_n)}`);
  if (stats.funding.top.length) {
    lines.push('- top outliers:');
    for (const t of stats.funding.top) {
      lines.push(`  - ${t.s} | ${t.fundingAprPct.toFixed(1)}% | ${nowUtcStamp(t.ts)}`);
    }
  }

  return lines.join('\n');
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

async function sendTelegramAndLog({
  text,
  eventType,
  kind,
  category,
  instruments,
}) {
  // Binance-style-ish envelope: {e, E, s, ...}
  const E = Date.now();
  const base = {
    e: eventType, // e.g. monitor_report / monitor_alert
    E, // event time (unix ms)
    kind,
    category: categoryLabel(category),
  };

  const payload = {
    ...base,
    instruments: (instruments || []).map((i) => ({
      s: i.key,
      asset: i.asset,
      dex: i.dex,
      markPx: Number.isFinite(i.markPx) ? String(i.markPx) : null,
      refPx: Number.isFinite(i.oraclePx) ? String(i.oraclePx) : null,
      basisBps: Number.isFinite(i.basisBps) ? String(i.basisBps) : null,
      fundingRate: i.fundingRate === null || i.fundingRate === undefined || Number.isNaN(i.fundingRate) ? null : String(i.fundingRate),
      fundingAprPct: i.annualizedFundingPct === null || i.annualizedFundingPct === undefined || Number.isNaN(i.annualizedFundingPct) ? null : String(i.annualizedFundingPct),
      oiUsd: i.oiUsd === null || i.oiUsd === undefined || Number.isNaN(i.oiUsd) ? null : String(i.oiUsd),
      book: i.bookSummary || null,
    })),
  };

  try {
    await sendTelegram(text);
    await appendEventNdjson({ ...payload, status: 'sent' });
  } catch (err) {
    const msg = err?.message || String(err);
    await appendEventNdjson({ ...payload, status: 'error', error: msg.slice(0, 300) });
    throw err;
  }
}

function fundingRawStr(fundingRate) {
  if (fundingRate === null || fundingRate === undefined || Number.isNaN(fundingRate)) return 'n/a';
  return `${(fundingRate * 100).toFixed(4)}%/8h`;
}

function fmtOiUsd(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return 'n/a';
  if (!Number.isFinite(x)) return 'n/a';
  const abs = Math.abs(x);
  if (abs >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(x / 1e3).toFixed(1)}k`;
  return `$${x.toFixed(0)}`;
}

function buildInstrumentBlock({ key, dex, asset, markPx, oraclePx, basisBps, fundingRate, annualizedFundingPct, openInterest, oiUsd }) {
  const lines = [];
  lines.push(`- ${key}  (${asset} @ ${dex})`);
  lines.push(`  Mark ${fmtUsd(markPx)} | Oracle ${fmtUsd(oraclePx)} | Basis ${fmtBps(basisBps)}`);
  lines.push(`  Funding ${fundingRawStr(fundingRate)}  (${fmtPct1(annualizedFundingPct)} ann.)`);
  if (openInterest !== null && openInterest !== undefined && Number.isFinite(openInterest)) {
    lines.push(`  OI Notional ${fmtOiUsd(oiUsd)}  (OI ${openInterest.toFixed(4)})`);
  }
  return lines.join('\n');
}

function buildExecutableArbsSection(instruments) {
  const hits = instruments
    .filter(
      (i) =>
        Number.isFinite(i.basisBps) &&
        Math.abs(i.basisBps) > EXTREME_BASIS_BPS &&
        i.annualizedFundingPct !== null &&
        Number.isFinite(i.annualizedFundingPct) &&
        Math.abs(i.annualizedFundingPct) > EXTREME_FUNDING_APR_PCT
    )
    .sort((a, b) => Math.abs(b.basisBps) - Math.abs(a.basisBps));

  const lines = [];
  lines.push('Executable Arbitrages');
  if (hits.length === 0) {
    lines.push('(none)');
    return lines.join('\n');
  }

  for (const i of hits) {
    // Distinctive emoji per item.
    lines.push(`⚡ ${i.key} (${i.asset} @ ${i.dex}) | basis ${fmtBps(i.basisBps)} | funding ${fmtPct1(i.annualizedFundingPct)} ann.`);
  }

  return lines.join('\n');
}

function buildDislocationsSection(instruments) {
  const basis = instruments
    .filter((i) => Number.isFinite(i.basisBps) && Math.abs(i.basisBps) > EXTREME_BASIS_BPS)
    .sort((a, b) => Math.abs(b.basisBps) - Math.abs(a.basisBps));

  const funding = instruments
    .filter(
      (i) =>
        i.annualizedFundingPct !== null &&
        Number.isFinite(i.annualizedFundingPct) &&
        Math.abs(i.annualizedFundingPct) > EXTREME_FUNDING_APR_PCT
    )
    .sort((a, b) => Math.abs(b.annualizedFundingPct) - Math.abs(a.annualizedFundingPct));

  const lines = [];
  lines.push(`Dislocations (thresholds: |basis|>${EXTREME_BASIS_BPS}bps, |funding|>${EXTREME_FUNDING_APR_PCT}% ann.)`);

  lines.push('Basis Dislocation');
  if (basis.length === 0) {
    lines.push('(none)');
  } else {
    for (const i of basis) {
      lines.push(`- ${i.key} (${i.asset} @ ${i.dex}) | basis ${fmtBps(i.basisBps)}`);
    }
  }

  lines.push('');
  lines.push('Funding Dislocation');
  if (funding.length === 0) {
    lines.push('(none)');
  } else {
    for (const i of funding) {
      lines.push(`- ${i.key} (${i.asset} @ ${i.dex}) | funding ${fmtPct1(i.annualizedFundingPct)} ann.`);
    }
  }

  return lines.join('\n');
}

function categoryLabel(category) {
  // Keep this ASCII-friendly; some Telegram clients/font stacks can fail to render certain emoji.
  if (category === 'energy') return 'ENERGY';
  if (category === 'metals') return 'METALS';
  if (category === 'crypto') return 'CRYPTO';
  if (category === 'elevated') return 'ELEVATED';
  if (category === 'crypto-majors') return 'CRYPTO-MAJORS';
  if (category === 'summary') return 'SUMMARY';
  return 'ALL';
}

function categoryEmoji(category) {
  // Per request; these may render differently depending on client.
  if (category === 'energy') return '🛢️';
  if (category === 'metals') return '🪙';
  if (category === 'crypto') return '🧪';
  if (category === 'elevated') return '🚨';
  return '🧾';
}

function buildAlert({ kind, emoji, instruments, splitHighOi = false, category = null }) {
  const lines = [];
  lines.push(`${emoji} ${kind} ${nowUtcStamp()} | CATEGORY: ${categoryLabel(category)}`);
  lines.push('');
  lines.push(buildDislocationsSection(instruments));
  lines.push('');
  lines.push(buildExecutableArbsSection(instruments));
  lines.push('');

  if (!splitHighOi) {
    for (const inst of instruments) {
      lines.push(buildInstrumentBlock(inst));
      lines.push('');
    }
    return lines.join('\n').trim();
  }

  const withOi = instruments.map((i) => ({ ...i, oiUsd: i.oiUsd ?? null }));
  const high = withOi
    .filter((i) => i.oiUsd !== null && Math.abs(i.oiUsd) >= METALS_OI_HIGH_USD)
    .sort((a, b) => Math.abs(b.oiUsd) - Math.abs(a.oiUsd));
  const low = withOi
    .filter((i) => !(i.oiUsd !== null && Math.abs(i.oiUsd) >= METALS_OI_HIGH_USD))
    .sort((a, b) => (b.oiUsd ?? 0) - (a.oiUsd ?? 0));

  lines.push(`HIGH OI (>${fmtOiUsd(METALS_OI_HIGH_USD)})`);
  for (const inst of high) {
    lines.push(buildInstrumentBlock(inst));
    lines.push('');
  }

  lines.push('OTHER');
  for (const inst of low) {
    lines.push(buildInstrumentBlock(inst));
    lines.push('');
  }

  return lines.join('\n').trim();
}

function logCycle({ ts, key, markPx, oraclePx, basisBps, fundingRate, annualizedFundingPct, openInterest, oiUsd }) {
  const parts = [
    ts,
    key,
    `mark=${markPx.toFixed(4)}`,
    `oracle=${oraclePx.toFixed(4)}`,
    `basis_bps=${basisBps.toFixed(2)}`,
    `funding_rate=${fundingRate === null ? 'n/a' : fundingRate.toFixed(10)}`,
    `funding_ann_pct=${annualizedFundingPct === null ? 'n/a' : annualizedFundingPct.toFixed(2)}`,
    `oi=${openInterest === null || openInterest === undefined ? 'n/a' : openInterest.toFixed(4)}`,
    `oi_usd=${oiUsd === null || oiUsd === undefined ? 'n/a' : oiUsd.toFixed(2)}`,
  ];
  console.log(parts.join(' | '));
}

async function runOnce({
  forceTestAlert = false,
  alertKind = 'TEST ALERT',
  alertEmoji = '🧪',
  splitHighOi = false,
  category = null, // 'energy' | 'metals' | 'crypto' | null
  splitReports = false,
} = {}) {
  const ts = new Date().toISOString();
  const prev = await readState();

  // Build a full instrument list:
  // - fixed energy instruments
  // - discovered metals across all perpetual dexs
  const perpDexs = await fetchPerpDexs();
  const metalByDex = discoverMetalAssetsFromPerpDexs(perpDexs);

  // Always scan HL main universe too (covers e.g. PAXG if present).
  const mainDexData = await fetchHyperliquidDexMetaAndCtxs('main');
  const mainMetalAssets = discoverMetalAssetsFromUniverse(mainDexData.universe);

  // Fetch each dex once.
  const dexes = new Set(INSTRUMENTS.map((i) => i.dex));
  for (const dexName of metalByDex.keys()) dexes.add(dexName);
  dexes.add('main');

  const dexData = Object.fromEntries(
    await Promise.all(
      [...dexes].map(async (dex) => {
        const data = dex === 'main' ? mainDexData : await fetchHyperliquidDexMetaAndCtxs(dex);
        return [dex, data];
      })
    )
  );

  const instruments = [];

  // Energy instruments (explicit)
  if (category === null || category === 'energy') {
    for (const i of INSTRUMENTS) {
      const d = dexData[i.dex];
      const asset = process.env[`HL_ASSET_${i.key}`] || i.asset;
      const out = extractAssetFromDex(d, asset);
      const basisBps = computeBasisBps(out.markPx, out.oraclePx);
      const annualizedFundingPct = computeAnnualizedFundingPctFromHl(out.fundingRate);
      const openInterest = Number.parseFloat(d.assetCtxs?.[d.universe.findIndex((a) => a?.name === out.asset)]?.openInterest);
      const oi = Number.isFinite(openInterest) ? openInterest : null;
      const oiUsd = oi === null ? null : oi * out.markPx;
      instruments.push({
        key: i.key,
        dex: out.dex,
        asset: out.asset,
        markPx: out.markPx,
        oraclePx: out.oraclePx,
        basisBps,
        fundingRate: out.fundingRate,
        annualizedFundingPct,
        openInterest: oi,
        oiUsd,
        category: 'energy',
      });
    }
  }

  // Metals (discovered)
  if (category === null || category === 'metals') {
    const metalRows = [];
    for (const [dexName, assets] of metalByDex.entries()) {
      for (const asset of assets) metalRows.push({ dex: dexName, asset });
    }
    for (const asset of mainMetalAssets) metalRows.push({ dex: 'main', asset });

    // Dedup (same dex+asset)
    const seen = new Set();
    for (const m of metalRows) {
      const k = `${m.dex}|${m.asset}`;
      if (seen.has(k)) continue;
      seen.add(k);

      const d = dexData[m.dex];
      if (!d) continue;
      const out = extractAssetFromDex(d, m.asset);
      const basisBps = computeBasisBps(out.markPx, out.oraclePx);
      const annualizedFundingPct = computeAnnualizedFundingPctFromHl(out.fundingRate);
      const idx = d.universe.findIndex((a) => a?.name === out.asset);
      const openInterest = Number.parseFloat(d.assetCtxs?.[idx]?.openInterest);
      const oi = Number.isFinite(openInterest) ? openInterest : null;
      const oiUsd = oi === null ? null : oi * out.markPx;
      instruments.push({
        key: out.asset,
        dex: out.dex,
        asset: out.asset,
        markPx: out.markPx,
        oraclePx: out.oraclePx,
        basisBps,
        fundingRate: out.fundingRate,
        annualizedFundingPct,
        openInterest: oi,
        oiUsd,
        category: 'metals',
      });
    }
  }

  // Crypto majors (perps + on-chain wrappers)
  if (category === null || category === 'crypto' || category === 'crypto-majors') {
    // Perps: BTC/ETH from main dex
    const mainDex = dexData.main || mainDexData;

    // Use HL allMids for crypto reference (spot-like mid), per request.
    const mids = await fetchAllMids();
    const underlying = {
      BTC: Number.parseFloat(mids.BTC),
      ETH: Number.parseFloat(mids.ETH),
    };

    for (const p of CRYPTO_MAJORS.perps) {
      const d = dexData[p.dex] || mainDex;
      const out = extractAssetFromDex(d, p.asset);
      const ref = underlying[out.asset];
      const basisBps = Number.isFinite(ref) ? computeBasisBps(out.markPx, ref) : computeBasisBps(out.markPx, out.oraclePx);
      const annualizedFundingPct = computeAnnualizedFundingPctFromHl(out.fundingRate);
      const idx = d.universe.findIndex((a) => a?.name === out.asset);
      const openInterest = Number.parseFloat(d.assetCtxs?.[idx]?.openInterest);
      const oi = Number.isFinite(openInterest) ? openInterest : null;
      const oiUsd = oi === null ? null : oi * out.markPx;
      instruments.push({
        key: p.key,
        dex: out.dex,
        asset: out.asset,
        markPx: out.markPx,
        oraclePx: Number.isFinite(ref) ? ref : out.oraclePx,
        basisBps,
        fundingRate: out.fundingRate,
        annualizedFundingPct,
        openInterest: oi,
        oiUsd,
        category: 'crypto',
      });
    }

    // On-chain wrappers priced in USD (DefiLlama)
    const prices = await fetchDefiLlamaPrices(CRYPTO_MAJORS.onchain);

    for (const t of CRYPTO_MAJORS.onchain) {
      const k = `${t.chain}:${t.address}`;
      const px = prices.get(k) ?? null;
      const under = underlying[t.underlying];
      const basisBps = px === null ? null : computeBasisBps(px, under);
      instruments.push({
        key: t.key,
        dex: t.chain,
        asset: `${t.chain}:${t.address}`,
        markPx: px === null ? NaN : px,
        oraclePx: under,
        basisBps: basisBps === null ? NaN : basisBps,
        fundingRate: null,
        annualizedFundingPct: null,
        openInterest: null,
        oiUsd: null,
        category: 'crypto',
      });
    }

    // Executable spot (CowSwap) liquidity-aware pricing
    const cowInst = await fetchCowSwap5kInstruments({ allMids: mids });
    instruments.push(...cowInst);
  }

  for (const inst of instruments) {
    logCycle({
      ts,
      key: inst.key,
      markPx: inst.markPx,
      oraclePx: inst.oraclePx,
      basisBps: inst.basisBps,
      fundingRate: inst.fundingRate,
      annualizedFundingPct: inst.annualizedFundingPct,
      openInterest: inst.openInterest,
      oiUsd: inst.oiUsd,
    });
  }

  const state = {
    ts,
    instruments: Object.fromEntries(
      instruments.map((i) => [
        i.key,
        {
          dex: i.dex,
          asset: i.asset,
          markPx: i.markPx,
          oraclePx: i.oraclePx,
          basis_bps: i.basisBps,
          funding_rate: i.fundingRate,
          annualized_funding_pct: i.annualizedFundingPct,
          open_interest: i.openInterest,
          open_interest_usd: i.oiUsd,
        },
      ])
    ),
    alerts: prev?.alerts || {},
  };

  // Ensure dedupe keys exist.
  for (const i of instruments) {
    state.alerts[i.key] = state.alerts[i.key] || { basis_last_ms: 0, funding_last_ms: 0 };
    state.alerts[i.key].basis_last_ms = state.alerts[i.key].basis_last_ms ?? 0;
    state.alerts[i.key].funding_last_ms = state.alerts[i.key].funding_last_ms ?? 0;
  }

  const nowMs = Date.now();

  // Track whether any instrument is currently in dislocation, regardless of alert dedupe.
  const anyDislocationNow = instruments.some(
    (i) =>
      (Number.isFinite(i.basisBps) && Math.abs(i.basisBps) > EXTREME_BASIS_BPS) ||
      (i.annualizedFundingPct !== null && Number.isFinite(i.annualizedFundingPct) && Math.abs(i.annualizedFundingPct) > EXTREME_FUNDING_APR_PCT)
  );

  if (forceTestAlert) {
    const sendReport = async ({ cat, insts, splitOi }) => {
      const text = buildAlert({
        kind: alertKind,
        emoji: categoryEmoji(cat),
        instruments: insts,
        splitHighOi: splitOi,
        category: cat,
      });
      await sendTelegramAndLog({
        text,
        eventType: 'monitor_report',
        kind: alertKind,
        category: cat,
        instruments: insts,
      });
    };

    try {
      if (splitReports) {
        const energy = instruments.filter((i) => i.category === 'energy');
        const metals = instruments.filter((i) => i.category === 'metals');
        const crypto = instruments.filter((i) => i.category === 'crypto');
        const elevated = instruments.filter(
          (i) =>
            (Number.isFinite(i.basisBps) && Math.abs(i.basisBps) > EXTREME_BASIS_BPS) ||
            (i.annualizedFundingPct !== null && Number.isFinite(i.annualizedFundingPct) && Math.abs(i.annualizedFundingPct) > EXTREME_FUNDING_APR_PCT)
        );

        await sendReport({ cat: 'energy', insts: energy, splitOi: false });
        await sendReport({ cat: 'metals', insts: metals, splitOi: true });
        await sendReport({ cat: 'crypto', insts: crypto, splitOi: false });
        await sendReport({ cat: 'elevated', insts: elevated, splitOi: false });

        // Daily dump: append a 24h summary of dislocation alerts + event breakdown.
        if (alertKind === 'DAILY REPORT') {
          const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
          const events = await readEventNdjsonSince(sinceMs);
          const stats = getDislocationStats(events);
          const summaryText = buildDailyDislocationSummaryText(stats, { lookbackHours: 24 });
          await sendTelegramAndLog({
            text: summaryText,
            eventType: 'monitor_report',
            kind: 'DAILY SUMMARY',
            category: 'summary',
            instruments: [],
          });
        }
      } else {
        const text = buildAlert({ kind: alertKind, emoji: alertEmoji, instruments, splitHighOi, category });
        await sendTelegramAndLog({
          text,
          eventType: 'monitor_report',
          kind: alertKind,
          category,
          instruments,
        });
      }
      console.log(`[${ts}] Sent test alert`);
    } catch (e) {
      console.error(`[${ts}] Telegram send failed (test): ${e?.message || e}`);
    }
  } else {
    for (const inst of instruments) {
      const basisTrigger = Math.abs(inst.basisBps) > EXTREME_BASIS_BPS;
      const fundingTrigger = inst.annualizedFundingPct !== null && Math.abs(inst.annualizedFundingPct) > EXTREME_FUNDING_APR_PCT;

      if (basisTrigger && nowMs - state.alerts[inst.key].basis_last_ms > DEDUPE_MS) {
        const text = buildAlert({ kind: 'BASIS DISLOCATION', emoji: '🔴', instruments: [inst] });
        try {
          await sendTelegramAndLog({
            text,
            eventType: 'monitor_alert',
            kind: 'BASIS DISLOCATION',
            category,
            instruments: [inst],
          });
          state.alerts[inst.key].basis_last_ms = nowMs;
        } catch (e) {
          console.error(`[${ts}] Telegram send failed (basis ${inst.key}): ${e?.message || e}`);
        }
      }

      if (fundingTrigger && nowMs - state.alerts[inst.key].funding_last_ms > DEDUPE_MS) {
        const text = buildAlert({ kind: 'FUNDING DISLOCATION', emoji: '🟡', instruments: [inst] });
        try {
          // Condensed order book snapshot for later microstructure analysis.
          // Use inst.asset for HIP-3 (e.g. xyz:CL) and native perps (e.g. BTC).
          let bookSummary = null;
          try {
            const book = await fetchL2Book({ coin: inst.asset, dex: inst.dex });
            bookSummary = summarizeL2Book(book);
          } catch (e2) {
            bookSummary = { coin: inst.asset, dex: inst.dex, error: `l2Book_failed:${e2?.message || e2}`.slice(0, 160) };
          }

          await sendTelegramAndLog({
            text,
            eventType: 'monitor_alert',
            kind: 'FUNDING DISLOCATION',
            category,
            instruments: [{ ...inst, bookSummary }],
          });
          state.alerts[inst.key].funding_last_ms = nowMs;
        } catch (e) {
          console.error(`[${ts}] Telegram send failed (funding ${inst.key}): ${e?.message || e}`);
        }
      }
    }
  }

  await writeLatest(state);
  return { anyDislocationNow };
}

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const isTest = args.has('--test');
  const isDump = args.has('--dump');
  const isOnce = args.has('--once');

  let category = null;
  const catIdx = argv.findIndex((a) => a === '--category');
  if (catIdx !== -1) category = argv[catIdx + 1] || null;
  if (
    category !== null &&
    category !== 'energy' &&
    category !== 'metals' &&
    category !== 'crypto' &&
    category !== 'crypto-majors'
  ) {
    console.error(`Invalid --category '${category}'. Use 'energy', 'metals', 'crypto', or 'crypto-majors'.`);
    process.exitCode = 2;
    return;
  }

  if (isTest || isDump) {
    try {
      await runOnce({
        forceTestAlert: true,
        alertKind: isDump ? 'DAILY REPORT' : 'TEST ALERT',
        alertEmoji: isDump ? '🧾' : '🧪',
        splitHighOi: true,
        splitReports: true,
        category,
      });
    } catch (e) {
      console.error(`[${new Date().toISOString()}] ${isDump ? '--dump' : '--test'} failed: ${e?.message || e}`);
      process.exitCode = 1;
    }
    return;
  }

  if (isOnce) {
    try {
      await runOnce({ category });
    } catch (e) {
      console.error(`[${new Date().toISOString()}] --once failed: ${e?.message || e}`);
      process.exitCode = 1;
    }
    return;
  }

  let hot = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await runOnce({ category });
      hot = !!res?.anyDislocationNow;
    } catch (e) {
      console.error(`[${new Date().toISOString()}] cycle failed: ${e?.message || e}`);
      // On failure, stay on quiet cadence.
      hot = false;
    }

    const sleepMs = hot ? POLL_MS_HOT : POLL_MS_QUIET;
    await new Promise((r) => setTimeout(r, sleepMs));
  }
}

main().catch((e) => {
  console.error(`[${new Date().toISOString()}] fatal: ${e?.message || e}`);
  process.exitCode = 1;
});
