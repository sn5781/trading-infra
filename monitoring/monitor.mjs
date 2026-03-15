import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

const DATA_DIR = path.resolve('./data');
const LATEST_PATH = path.join(DATA_DIR, 'basis-latest.json');

const POLL_MS = 30_000;
const DEDUPE_MS = 10 * 60_000;

const INSTRUMENTS = [
  { key: 'CL', dex: 'xyz', asset: 'xyz:CL' },
  { key: 'BRENTOIL', dex: 'xyz', asset: 'xyz:BRENTOIL' },
  { key: 'USOIL', dex: 'km', asset: 'km:USOIL' },
];

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

  return { dex, universe, assetCtxs };
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

function fundingRawStr(fundingRate) {
  if (fundingRate === null || fundingRate === undefined || Number.isNaN(fundingRate)) return 'n/a';
  return `${(fundingRate * 100).toFixed(4)}%/8h`;
}

function buildInstrumentBlock({ key, markPx, oraclePx, basisBps, fundingRate, annualizedFundingPct }) {
  const lines = [];
  lines.push(`${key}`);
  lines.push(`Mark: ${fmtUsd(markPx)} | Oracle: ${fmtUsd(oraclePx)}`);
  lines.push(`Basis: ${fmtBps(basisBps)}`);
  lines.push(`Funding: ${fundingRawStr(fundingRate)} | ${fmtPct1(annualizedFundingPct)} ann.`);
  return lines.join('\n');
}

function buildAlert({ kind, emoji, instruments }) {
  const lines = [];
  lines.push(`${emoji} ${kind} ${nowUtcHHMM()}`);
  for (const inst of instruments) {
    lines.push(buildInstrumentBlock(inst));
    lines.push('');
  }
  return lines.join('\n').trim();
}

function logCycle({ ts, key, markPx, oraclePx, basisBps, fundingRate, annualizedFundingPct }) {
  const parts = [
    ts,
    key,
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

  // Fetch each dex once.
  const dexes = [...new Set(INSTRUMENTS.map((i) => i.dex))];
  const dexData = Object.fromEntries(
    await Promise.all(
      dexes.map(async (dex) => {
        const data = await fetchHyperliquidDexMetaAndCtxs(dex);
        return [dex, data];
      })
    )
  );

  const instruments = INSTRUMENTS.map((i) => {
    const d = dexData[i.dex];
    const asset = process.env[`HL_ASSET_${i.key}`] || i.asset;
    const out = extractAssetFromDex(d, asset);
    const basisBps = computeBasisBps(out.markPx, out.oraclePx);
    const annualizedFundingPct = computeAnnualizedFundingPctFromHl(out.fundingRate);
    return {
      key: i.key,
      dex: out.dex,
      asset: out.asset,
      markPx: out.markPx,
      oraclePx: out.oraclePx,
      basisBps,
      fundingRate: out.fundingRate,
      annualizedFundingPct,
    };
  });

  for (const inst of instruments) {
    logCycle({
      ts,
      key: inst.key,
      markPx: inst.markPx,
      oraclePx: inst.oraclePx,
      basisBps: inst.basisBps,
      fundingRate: inst.fundingRate,
      annualizedFundingPct: inst.annualizedFundingPct,
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
    const text = buildAlert({ kind: 'TEST ALERT', emoji: '🧪', instruments });
    try {
      await sendTelegram(text);
      console.log(`[${ts}] Sent test alert`);
    } catch (e) {
      console.error(`[${ts}] Telegram send failed (test): ${e?.message || e}`);
    }
  } else {
    for (const inst of instruments) {
      const basisTrigger = Math.abs(inst.basisBps) > 200;
      const fundingTrigger = inst.annualizedFundingPct !== null && Math.abs(inst.annualizedFundingPct) > 50;

      if (basisTrigger && nowMs - state.alerts[inst.key].basis_last_ms > DEDUPE_MS) {
        const text = buildAlert({ kind: 'BASIS WIDE', emoji: '🔴', instruments: [inst] });
        try {
          await sendTelegram(text);
          state.alerts[inst.key].basis_last_ms = nowMs;
        } catch (e) {
          console.error(`[${ts}] Telegram send failed (basis ${inst.key}): ${e?.message || e}`);
        }
      }

      if (fundingTrigger && nowMs - state.alerts[inst.key].funding_last_ms > DEDUPE_MS) {
        const text = buildAlert({ kind: 'FUNDING EXTREME', emoji: '🟡', instruments: [inst] });
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
