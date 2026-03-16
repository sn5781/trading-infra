import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

// Always load env from monitoring/.env (not the caller's cwd).
dotenv.config({ path: new URL('.env', import.meta.url) });

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const COW_QUOTE_URL = 'https://api.cow.fi/mainnet/api/v1/quote';

const TOKENS = {
  USDC: { chain: 'ethereum', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  WETH: { chain: 'ethereum', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, underlying: 'ETH' },
  stETH: { chain: 'ethereum', address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', decimals: 18, underlying: 'ETH' },
  WBTC: { chain: 'ethereum', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8, underlying: 'BTC' },
};

const ASSETS = ['WBTC', 'WETH', 'stETH'];
const TRADE_SIZE_USDC = 5_000;

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 10_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

async function fetchAllMids() {
  return fetchJson(HL_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'allMids' }),
  });
}

async function fetchPerpCtxs() {
  const j = await fetchJson(HL_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });
  const universe = j?.[0]?.universe;
  const ctxs = j?.[1];
  if (!Array.isArray(universe) || !Array.isArray(ctxs)) throw new Error('Unexpected HL metaAndAssetCtxs shape');

  function getMid(sym) {
    const idx = universe.findIndex((a) => a?.name === sym);
    if (idx === -1) return null;
    const mid = Number.parseFloat(ctxs[idx]?.midPx);
    return Number.isFinite(mid) ? mid : null;
  }

  return {
    BTC: getMid('BTC'),
    ETH: getMid('ETH'),
  };
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

function fmt(n, d = 4) {
  if (n === null || n === undefined || Number.isNaN(n) || !Number.isFinite(n)) return 'n/a';
  return n.toFixed(d);
}

function fmtUsd(n) {
  if (n === null || n === undefined || Number.isNaN(n) || !Number.isFinite(n)) return 'n/a';
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  return n.toFixed(4);
}

function fmtBps(n) {
  if (n === null || n === undefined || Number.isNaN(n) || !Number.isFinite(n)) return 'n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}`;
}

function basisBps(a, b) {
  return ((a - b) / b) * 10_000;
}

function renderTable(rows) {
  const headers = ['asset', 'hl_mid', 'cow_5k_usdc', 'diff_bps', 'buy_amount'];
  const table = [headers, ...rows.map((r) => [r.asset, r.hl_mid, r.cow_5k_usdc, r.diff_bps, r.buy_amount])];
  const widths = headers.map((_, i) => Math.max(...table.map((row) => String(row[i]).length)));
  const lines = table.map((row, idx) =>
    row
      .map((cell, i) => String(cell).padEnd(widths[i]))
      .join(' | ')
      .trimEnd()
  );
  // add separator after header
  lines.splice(1, 0, widths.map((w) => '-'.repeat(w)).join('-+-'));
  return lines.join('\n');
}

async function main() {
  const spotMids = await fetchAllMids();
  const perpMids = await fetchPerpCtxs();

  const usdcAmount = BigInt(Math.round(TRADE_SIZE_USDC * 1e6));

  const rows = [];
  for (const a of ASSETS) {
    const t = TOKENS[a];
    const under = t.underlying;

    const hlSpotMid = Number.parseFloat(spotMids[under]);
    const hlPerpMid = perpMids[under];

    if (!Number.isFinite(hlSpotMid)) throw new Error(`Missing HL spot mid (allMids) for ${under}`);

    // Quote both directions so we can choose the executable direction based on basis sign.
    // If basis negative => BUY token with 5k USDC.
    // If basis positive => SELL token for ~5k USDC notional.

    // BUY leg: 5k USDC -> token
    const qBuy = await cowQuoteSell({
      sellToken: TOKENS.USDC.address,
      buyToken: t.address,
      sellAmountBeforeFee: usdcAmount,
    });
    const buyAmountBuy = BigInt(qBuy.quote.buyAmount);
    const buyTokens = Number(buyAmountBuy) / Number(pow10(t.decimals));
    const pxBuy = TRADE_SIZE_USDC / buyTokens; // USDC per token
    const basisBuyBps = basisBps(pxBuy, hlSpotMid);

    // SELL leg: token -> USDC, with token amount sized to ~5k notional using HL spot mid.
    const sellTokensTarget = TRADE_SIZE_USDC / hlSpotMid;
    const sellAmountTokens = BigInt(Math.floor(sellTokensTarget * 10 ** t.decimals));
    const qSell = await cowQuoteSell({
      sellToken: t.address,
      buyToken: TOKENS.USDC.address,
      sellAmountBeforeFee: sellAmountTokens,
    });
    const buyAmountSell = BigInt(qSell.quote.buyAmount);
    const usdcOut = Number(buyAmountSell) / 1e6;
    const soldTokens = Number(sellAmountTokens) / Number(pow10(t.decimals));
    const pxSell = usdcOut / soldTokens;
    const basisSellBps = basisBps(pxSell, hlSpotMid);

    const direction = basisBuyBps < 0 ? 'BUY' : 'SELL';
    const execPx = direction === 'BUY' ? pxBuy : pxSell;
    const execBasisBps = direction === 'BUY' ? basisBuyBps : basisSellBps;
    const execQty = direction === 'BUY' ? buyTokens : soldTokens;

    rows.push({
      asset: a,
      hl_spot_mid: fmtUsd(hlSpotMid),
      hl_perp_mid: hlPerpMid === null ? 'n/a' : fmtUsd(hlPerpMid),
      cow_5k_usdc_swap: fmtUsd(execPx),
      dir: direction,
      diff_bps: fmtBps(execBasisBps),
      qty: fmt(execQty, 8),
    });
  }

  const headers = ['asset', 'hl_spot_mid', 'hl_perp_mid', 'cow_5k_usdc_swap', 'dir', 'diff_bps', 'qty'];
  function render(rows) {
    const table = [headers, ...rows.map((r) => headers.map((h) => r[h]))];
    const widths = headers.map((_, i) => Math.max(...table.map((row) => String(row[i]).length)));
    const lines = table.map((row) => row.map((cell, i) => String(cell).padEnd(widths[i])).join(' | ').trimEnd());
    lines.splice(1, 0, widths.map((w) => '-'.repeat(w)).join('-+-'));
    return lines.join('\n');
  }

  const out = [
    `Spot execution vs HL mids (CowSwap sim with ${TRADE_SIZE_USDC} USDC notional)`,
    `- If basis<0 => BUY with 5k USDC`,
    `- If basis>0 => SELL ~5k notional`,
    `All basis vs HL_SPOT_MID (allMids)`,
    '',
    render(rows),
  ].join('\n');

  console.log(out);

  // Optional: send to Telegram if env present
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (token && chatId) {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetchJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: out, disable_web_page_preview: true }),
    });
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exitCode = 1;
});
