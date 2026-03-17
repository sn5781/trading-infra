import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('.env', import.meta.url) });

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const COW_QUOTE_URL = 'https://api.cow.fi/mainnet/api/v1/quote';

const DATA_DIR = path.resolve('./data');
const LATEST_PATH = path.join(DATA_DIR, 'tbtc-arb-latest.json');

const USDC = { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 };
const TBTC = { address: '0x18084fbA666a33d37592fA2633fD49a74DD93a88', decimals: 18 };

const SIZES_USD = [100_000, 500_000, 1_000_000];

const CFG = {
  // fee bps
  hlPerpTakerFeeBps: Number.parseFloat(process.env.HL_PERP_TAKER_FEE_BPS ?? '2.0'),
  hlSpotTakerFeeBps: Number.parseFloat(process.env.HL_SPOT_TAKER_FEE_BPS ?? '2.0'),
  lighterPerpTakerFeeBps: Number.parseFloat(process.env.LIGHTER_PERP_TAKER_FEE_BPS ?? '2.0'),
  lighterSpotTakerFeeBps: Number.parseFloat(process.env.LIGHTER_SPOT_TAKER_FEE_BPS ?? '2.0'),

  // execution assumptions
  includePerpRoundtrip: true, // open + close

  // Lighter optional config
  lighter: {
    enabled: (process.env.LIGHTER_ENABLED ?? '0') === '1',
    baseUrl: process.env.LIGHTER_BASE_URL ?? '',
  },
};

function utcStamp(ms = Date.now()) {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mo}-${da} ${hh}:${mi} UTC`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtUsd(n, { decimals = 2 } = {}) {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  const s = n.toFixed(decimals);
  const [i, f] = s.split('.');
  const withCommas = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decimals === 0 ? `$${withCommas}` : `$${withCommas}.${f}`;
}

function fmtBps(n, { decimals = 2 } = {}) {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(decimals)} bps`;
}

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 12_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
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
  });
}

async function cowBuyTbtcWithUsdc(usdcNotional) {
  // sell USDC, buy tBTC
  const sellAmt = BigInt(Math.floor(usdcNotional * 10 ** USDC.decimals));
  const q = await cowQuoteSell({ sellToken: USDC.address, buyToken: TBTC.address, sellAmountBeforeFee: sellAmt });
  const buyAmt = BigInt(q.quote.buyAmount);
  const qty = Number(buyAmt) / Number(pow10(TBTC.decimals));
  const px = usdcNotional / qty;
  return { px, qty, quote: q };
}

async function hlL2Book(coin) {
  const j = await fetchJson(HL_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'l2Book', coin }),
  });
  const levels = j?.levels;
  if (!Array.isArray(levels) || levels.length < 2) throw new Error(`Bad l2Book shape for ${coin}`);
  return { bids: levels[0], asks: levels[1] };
}

function calcVwapFromBids(levels, targetNotionalUsd) {
  // Walk bids (we are selling into bids).
  let filledQty = 0;
  let proceeds = 0;
  for (const lvl of levels) {
    const px = Number.parseFloat(lvl?.px);
    const sz = Number.parseFloat(lvl?.sz);
    if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
    const levelNotional = px * sz;
    const remaining = targetNotionalUsd - proceeds;
    if (levelNotional >= remaining) {
      const partialSz = remaining / px;
      filledQty += partialSz;
      proceeds += remaining;
      break;
    }
    filledQty += sz;
    proceeds += levelNotional;
  }
  if (proceeds < targetNotionalUsd) return null;
  return { vwap: proceeds / filledQty, filledQty, filledNotional: proceeds };
}

function edgeBps({ sellPx, buyPx }) {
  // positive if sellPx > buyPx
  return ((sellPx - buyPx) / buyPx) * 10_000;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function main() {
  const ts = utcStamp();

  // CowSwap leg (buy tBTC)
  const cows = {};
  for (const n of SIZES_USD) {
    // small delay to be polite
    if (n !== SIZES_USD[0]) await sleep(800);
    cows[n] = await cowBuyTbtcWithUsdc(n);
  }

  // HL perps book (BTC) bid-side only, used for both "HL perp" and a proxy for "HL spot".
  // NOTE: Hyperliquid spot orderbook is not exposed via l2Book; we treat BTC l2Book as the executable bid.
  const hlBook = await hlL2Book('BTC');

  const venues = [];
  venues.push({ name: 'HL_PERP', feeOpenBps: CFG.hlPerpTakerFeeBps, feeCloseBps: CFG.hlPerpTakerFeeBps });
  venues.push({ name: 'HL_SPOT', feeOpenBps: CFG.hlSpotTakerFeeBps, feeCloseBps: 0 });

  // Lighter placeholders (optional)
  if (CFG.lighter.enabled) {
    venues.push({ name: 'LIGHTER_PERP', feeOpenBps: CFG.lighterPerpTakerFeeBps, feeCloseBps: CFG.lighterPerpTakerFeeBps });
    venues.push({ name: 'LIGHTER_SPOT', feeOpenBps: CFG.lighterSpotTakerFeeBps, feeCloseBps: 0 });
  }

  const results = [];

  for (const v of venues) {
    for (const n of SIZES_USD) {
      const cowPx = cows[n].px;

      let sellPx;
      let sellDetail = null;

      if (v.name.startsWith('HL_')) {
        const vwap = calcVwapFromBids(hlBook.bids, n);
        if (!vwap) {
          results.push({ venue: v.name, notional: n, ok: false, reason: 'HL_DEPTH' });
          continue;
        }
        sellPx = vwap.vwap;
        sellDetail = { hlBidVwap: sellPx, hlFilledQty: vwap.filledQty };
      } else {
        // Lighter not implemented without a known public endpoint: keep as unavailable.
        results.push({ venue: v.name, notional: n, ok: false, reason: 'LIGHTER_NOT_CONFIGURED' });
        continue;
      }

      const gross = edgeBps({ sellPx, buyPx: cowPx });
      const fees = v.feeOpenBps + (CFG.includePerpRoundtrip ? v.feeCloseBps : 0);
      const net = gross - fees;
      const pnl = (net / 10_000) * n;

      results.push({
        venue: v.name,
        notional: n,
        cowBuyPx: cowPx,
        venueSellPx: sellPx,
        grossBps: gross,
        feeBps: fees,
        netBps: net,
        netProfitUsd: pnl,
        ok: true,
        detail: sellDetail,
      });
    }
  }

  const snapshot = { ts, sizesUsd: SIZES_USD, cowswap: Object.fromEntries(Object.entries(cows).map(([k, v]) => [k, { px: v.px, qty: v.qty }])), results, config: CFG };
  await ensureDir(DATA_DIR);
  await fs.writeFile(LATEST_PATH, JSON.stringify(snapshot, null, 2));

  // Build alert
  const lines = [];
  lines.push(`📊 tBTC DISCOUNT SCAN ${ts}`);
  lines.push(`Sizes: ${SIZES_USD.map((x) => fmtUsd(x, { decimals: 0 })).join(', ')}`);
  lines.push('');

  for (const v of venues) {
    lines.push(`${v.name}`);
    for (const n of SIZES_USD) {
      const r = results.find((x) => x.venue === v.name && x.notional === n);
      if (!r || !r.ok) {
        lines.push(`  ${fmtUsd(n, { decimals: 0 })} | n/a | ${r?.reason || 'missing'}`);
        continue;
      }
      lines.push(
        `  ${fmtUsd(n, { decimals: 0 })} | CowSwap buy ${fmtUsd(r.cowBuyPx)} | sell ${fmtUsd(r.venueSellPx)} | gross ${fmtBps(r.grossBps)} | fees ${fmtBps(r.feeBps)} | net ${fmtBps(r.netBps)} | pnl ${fmtUsd(r.netProfitUsd)}`
      );
    }
    lines.push('');
  }

  const alertText = lines.join('\n').trimEnd();
  console.log(alertText);
  await sendTelegram(alertText);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exitCode = 1;
});
