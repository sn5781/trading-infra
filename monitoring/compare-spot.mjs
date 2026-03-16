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
  const mids = await fetchAllMids();

  const usdcAmount = BigInt(Math.round(TRADE_SIZE_USDC * 1e6));

  const rows = [];
  for (const a of ASSETS) {
    const t = TOKENS[a];
    const under = t.underlying;
    const hlMid = Number.parseFloat(mids[under]);

    const q = await cowQuoteSell({
      sellToken: TOKENS.USDC.address,
      buyToken: t.address,
      sellAmountBeforeFee: usdcAmount,
    });

    const buyAmount = BigInt(q.quote.buyAmount);
    const buyTokens = Number(buyAmount) / Number(pow10(t.decimals));
    const cowPx = TRADE_SIZE_USDC / buyTokens;

    const dBps = Number.isFinite(hlMid) ? basisBps(cowPx, hlMid) : NaN;

    rows.push({
      asset: a,
      hl_mid: fmtUsd(hlMid),
      cow_5k_usdc: fmtUsd(cowPx),
      diff_bps: fmtBps(dBps),
      buy_amount: fmt(buyTokens, 8),
    });
  }

  const out = [
    `Spot price comparison (CowSwap executable quote: sell ${TRADE_SIZE_USDC} USDC)`,
    `Reference: Hyperliquid allMids (BTC/ETH)`,
    '',
    renderTable(rows),
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
