import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

// Always load env from monitoring/.env (not the caller's cwd).
dotenv.config({ path: new URL('.env', import.meta.url) });

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

const DATA_DIR = path.resolve('./data');
const LATEST_PATH = path.join(DATA_DIR, 'basis-latest.json');

const POLL_MS = 15 * 60_000;
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
};

// Extreme thresholds (global)
const EXTREME_BASIS_BPS = 20;
const EXTREME_FUNDING_APR_PCT = 20;

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
  if (category === 'crypto-majors') return 'CRYPTO-MAJORS';
  return 'ALL';
}

function buildAlert({ kind, emoji, instruments, splitHighOi = false, category = null }) {
  const lines = [];
  lines.push(`${emoji} ${kind} ${nowUtcHHMM()} | CATEGORY: ${categoryLabel(category)}`);
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
  category = null, // 'energy' | 'metals' | null
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
  if (category === null || category === 'crypto-majors') {
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
        category: 'crypto-majors',
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
        category: 'crypto-majors',
      });
    }
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

  if (forceTestAlert) {
    const text = buildAlert({ kind: alertKind, emoji: alertEmoji, instruments, splitHighOi, category });
    try {
      await sendTelegram(text);
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
          await sendTelegram(text);
          state.alerts[inst.key].basis_last_ms = nowMs;
        } catch (e) {
          console.error(`[${ts}] Telegram send failed (basis ${inst.key}): ${e?.message || e}`);
        }
      }

      if (fundingTrigger && nowMs - state.alerts[inst.key].funding_last_ms > DEDUPE_MS) {
        const text = buildAlert({ kind: 'FUNDING DISLOCATION', emoji: '🟡', instruments: [inst] });
        try {
          await sendTelegram(text);
          state.alerts[inst.key].funding_last_ms = nowMs;
        } catch (e) {
          console.error(`[${ts}] Telegram send failed (funding ${inst.key}): ${e?.message || e}`);
        }
      }
    }
  }

  await writeLatest(state);
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
  if (category !== null && category !== 'energy' && category !== 'metals' && category !== 'crypto-majors') {
    console.error(`Invalid --category '${category}'. Use 'energy', 'metals', or 'crypto-majors'.`);
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
