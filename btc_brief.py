#!/usr/bin/env python3
"""Daily BTC derivatives brief → static HTML for GitHub Pages.

- No deps beyond `requests`.
- Never crashes on partial API failures; failed sections render "—".
- Reads COINGLASS_API_KEY from environment.
- Writes: btc_brief/index.html

Run:
  python btc_brief.py
"""

from __future__ import annotations

import html
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import requests


BINANCE_SPOT = "https://api.binance.com"
BINANCE_FUTURES = "https://fapi.binance.com"
BYBIT = "https://api.bybit.com"
OKX = "https://www.okx.com"
HL_INFO = "https://api.hyperliquid.xyz/info"
COINGLASS = "https://open-api.coinglass.com"

OUT_PATH = os.path.join("btc_brief", "index.html")


def http_get(url: str, *, params: Optional[dict] = None, headers: Optional[dict] = None, timeout: int = 12) -> Any:
    r = requests.get(url, params=params, headers=headers, timeout=timeout)
    r.raise_for_status()
    return r.json()


def http_post(url: str, *, json_body: Optional[dict] = None, headers: Optional[dict] = None, timeout: int = 12) -> Any:
    r = requests.post(url, json=json_body, headers=headers, timeout=timeout)
    r.raise_for_status()
    return r.json()


def f(x: Any) -> Optional[float]:
    try:
        if x is None:
            return None
        return float(x)
    except Exception:
        return None


def fmt_usd(x: Optional[float], dp: int = 0) -> str:
    if x is None:
        return "—"
    try:
        return f"${x:,.{dp}f}"
    except Exception:
        return "—"


def fmt_pct(x: Optional[float], dp: int = 2) -> str:
    if x is None:
        return "—"
    try:
        sign = "+" if x >= 0 else ""
        return f"{sign}{x:.{dp}f}%"
    except Exception:
        return "—"


def fmt_rate_8h(x_pct: Optional[float]) -> str:
    # x_pct is percent for 8h
    if x_pct is None:
        return "—"
    sign = "+" if x_pct >= 0 else ""
    return f"{sign}{x_pct:.4f}%"


def fmt_apr(x_pct: Optional[float]) -> str:
    if x_pct is None:
        return "—"
    sign = "+" if x_pct >= 0 else ""
    return f"{sign}{x_pct:.2f}%"


def cls_posneg(x: Optional[float]) -> str:
    if x is None:
        return ""
    return "pos" if x >= 0 else "neg"


@dataclass
class SpotSummary:
    price: Optional[float] = None
    chg24h_pct: Optional[float] = None
    chg7d_pct: Optional[float] = None


@dataclass
class HlPerpSummary:
    mark: Optional[float] = None
    oracle: Optional[float] = None
    oi_usd: Optional[float] = None
    funding_hourly: Optional[float] = None
    funding_8h_pct: Optional[float] = None
    funding_apr_pct: Optional[float] = None
    premium_pct: Optional[float] = None


def fetch_binance_spot(symbol: str) -> SpotSummary:
    t = http_get(f"{BINANCE_SPOT}/api/v3/ticker/24hr", params={"symbol": symbol})
    last = f(t.get("lastPrice"))
    chg24h = f(t.get("priceChangePercent"))

    kl = http_get(
        f"{BINANCE_SPOT}/api/v3/klines",
        params={"symbol": symbol, "interval": "1d", "limit": 8},
    )
    # Spec: 7d change = (lastPrice - klines[0][1]) / klines[0][1] * 100
    old_open = f(kl[0][1]) if isinstance(kl, list) and len(kl) else None
    chg7d = ((last - old_open) / old_open * 100) if (last is not None and old_open not in (None, 0)) else None

    return SpotSummary(price=last, chg24h_pct=chg24h, chg7d_pct=chg7d)


def fetch_hl_perps() -> Dict[str, HlPerpSummary]:
    data = http_post(
        HL_INFO,
        headers={"Content-Type": "application/json"},
        json_body={"type": "metaAndAssetCtxs"},
        timeout=15,
    )
    # Response: [meta, ctxs]
    meta = data[0]
    ctxs = data[1]
    uni = meta.get("universe", [])

    def get(asset: str) -> HlPerpSummary:
        idx = next(i for i, u in enumerate(uni) if u.get("name") == asset)
        c = ctxs[idx]
        mark = f(c.get("markPx"))
        oracle = f(c.get("oraclePx"))
        oi_base = f(c.get("openInterest"))
        oi_usd = (oi_base * mark) if (oi_base is not None and mark is not None) else None
        funding_h = f(c.get("funding"))
        funding_8h_pct = (funding_h * 8 * 100) if funding_h is not None else None
        funding_apr_pct = (funding_h * 8760 * 100) if funding_h is not None else None
        premium = f(c.get("premium"))
        premium_pct = (premium * 100) if premium is not None else None
        return HlPerpSummary(
            mark=mark,
            oracle=oracle,
            oi_usd=oi_usd,
            funding_hourly=funding_h,
            funding_8h_pct=funding_8h_pct,
            funding_apr_pct=funding_apr_pct,
            premium_pct=premium_pct,
        )

    return {"BTC": get("BTC"), "ETH": get("ETH")}


def fetch_funding_8h_rates() -> Dict[str, Dict[str, Optional[float]]]:
    """Return per-asset per-venue funding rates normalized to 8h %.

    Venues: Binance, Bybit, OKX, Hyperliquid.
    Assets: BTC, ETH.

    - Binance premiumIndex has lastFundingRate (per 8h) as decimal (e.g. 0.0001)
    - Bybit fundingRate is decimal (per 8h)
    - OKX fundingRate is decimal (per 8h)
    - Hyperliquid funding is hourly decimal; convert to 8h.
    """

    out: Dict[str, Dict[str, Optional[float]]] = {
        "BTC": {"Binance": None, "Bybit": None, "OKX": None, "Hyperliquid": None},
        "ETH": {"Binance": None, "Bybit": None, "OKX": None, "Hyperliquid": None},
    }

    # Binance futures
    try:
        j = http_get(f"{BINANCE_FUTURES}/fapi/v1/premiumIndex", timeout=12)
        if isinstance(j, list):
            for row in j:
                sym = row.get("symbol")
                if sym == "BTCUSDT":
                    out["BTC"]["Binance"] = (f(row.get("lastFundingRate")) or 0.0) * 100
                elif sym == "ETHUSDT":
                    out["ETH"]["Binance"] = (f(row.get("lastFundingRate")) or 0.0) * 100
    except Exception:
        pass

    # Bybit linear tickers
    try:
        for asset in ("BTC", "ETH"):
            sym = f"{asset}USDT"
            j = http_get(
                f"{BYBIT}/v5/market/tickers",
                params={"category": "linear", "symbol": sym},
                timeout=12,
            )
            rate = None
            try:
                rate = f(j["result"]["list"][0].get("fundingRate"))
            except Exception:
                rate = None
            out[asset]["Bybit"] = (rate * 100) if rate is not None else None
    except Exception:
        pass

    # OKX
    try:
        for asset in ("BTC", "ETH"):
            inst = f"{asset}-USDT-SWAP"
            j = http_get(
                f"{OKX}/api/v5/public/funding-rate",
                params={"instId": inst},
                timeout=12,
            )
            rate = None
            try:
                rate = f(j["data"][0].get("fundingRate"))
            except Exception:
                rate = None
            out[asset]["OKX"] = (rate * 100) if rate is not None else None
    except Exception:
        pass

    # Hyperliquid
    try:
        hl = fetch_hl_perps()
        for asset in ("BTC", "ETH"):
            out[asset]["Hyperliquid"] = hl[asset].funding_8h_pct
    except Exception:
        pass

    return out


def fetch_coinglass_liq_map(symbol: str, time_type: int, api_key: str) -> Tuple[Dict[float, float], Dict[float, float]]:
    """Return (short_map, long_map) as dict[price]->usd_amount."""

    j = http_get(
        f"{COINGLASS}/public/v2/liquidation/map",
        headers={"coinglassSecret": api_key, "accept": "application/json"},
        params={"symbol": symbol, "timeType": str(time_type)},
        timeout=20,
    )

    data = j.get("data") or {}
    short_map = data.get("shortLiqMap") or {}
    long_map = data.get("longLiqMap") or {}

    def parse_map(m: Any) -> Dict[float, float]:
        out: Dict[float, float] = {}
        if not isinstance(m, dict):
            return out
        for k, v in m.items():
            px = f(k)
            amt = f(v)
            if px is None or amt is None:
                continue
            out[px] = amt
        return out

    return parse_map(short_map), parse_map(long_map)


def pick_top_walls(short_map: Dict[float, float], long_map: Dict[float, float], spot: float) -> Dict[str, List[Tuple[float, float]]]:
    # spec: top 3 short above spot, top 3 long below spot
    shorts = [(px, usd) for px, usd in short_map.items() if px > spot]
    longs = [(px, usd) for px, usd in long_map.items() if px < spot]
    shorts.sort(key=lambda x: x[0])  # ascending price
    longs.sort(key=lambda x: -x[0])  # descending price

    # within 10% band matters, but acceptance says “top 3 above/below spot”; apply 10% filter for relevance
    hi = spot * 1.10
    lo = spot * 0.90
    shorts = [x for x in shorts if x[0] <= hi]
    longs = [x for x in longs if x[0] >= lo]

    shorts.sort(key=lambda x: x[1], reverse=True)
    longs.sort(key=lambda x: x[1], reverse=True)
    return {"shorts": shorts[:3], "longs": longs[:3]}


def build_funding_arb(funding: Dict[str, Dict[str, Optional[float]]]) -> List[dict]:
    rows = []
    for asset, venues in funding.items():
        # find min/max available
        avail = [(v, r) for v, r in venues.items() if r is not None]
        if len(avail) < 2:
            continue
        lo_v, lo_r = min(avail, key=lambda x: x[1])
        hi_v, hi_r = max(avail, key=lambda x: x[1])
        spread_8h = hi_r - lo_r
        spread_apr = spread_8h * 3 * 365  # approx
        rows.append(
            {
                "asset": asset,
                "spread_8h": spread_8h,
                "spread_apr": spread_apr,
                "long_leg": (lo_v, lo_r),  # pay funding (most negative) -> long perp receives? sign conventions vary; present as "long" = lower rate
                "short_leg": (hi_v, hi_r),
                "badge": spread_8h > 0.03,
            }
        )
    rows.sort(key=lambda r: r["spread_8h"], reverse=True)
    return rows


def render_html(
    *,
    ts_utc: str,
    spot: Dict[str, SpotSummary],
    hl: Dict[str, HlPerpSummary],
    liq: Optional[Dict[str, List[Tuple[float, float]]]],
    funding: Dict[str, Dict[str, Optional[float]]],
    arb: List[dict],
    errors: Dict[str, str],
) -> str:

    btc = spot.get("BTC") or SpotSummary()
    eth = spot.get("ETH") or SpotSummary()
    hl_b = hl.get("BTC") or HlPerpSummary()
    hl_e = hl.get("ETH") or HlPerpSummary()

    def esc(s: str) -> str:
        return html.escape(s, quote=True)

    def rate_span(x: Optional[float]) -> str:
        c = cls_posneg(x)
        return f'<span class="{c}">{esc(fmt_rate_8h(x))}</span>'

    def usd_span(x: Optional[float], dp: int = 0) -> str:
        return esc(fmt_usd(x, dp))

    def pct_span(x: Optional[float], dp: int = 2) -> str:
        c = cls_posneg(x)
        return f'<span class="{c}">{esc(fmt_pct(x, dp))}</span>'

    def small_err(name: str) -> str:
        e = errors.get(name)
        if not e:
            return ""
        return f'<div class="err">{esc(e)}</div>'

    spot_btc = btc.price

    shorts = liq.get("shorts") if liq else []
    longs = liq.get("longs") if liq else []

    def liq_rows(arr: List[Tuple[float, float]]) -> str:
        if not arr:
            return '<div class="muted">—</div>'
        out = []
        for px, usd in arr:
            out.append(
                f'<div class="row"><div class="k">{esc(fmt_usd(px,0))}</div><div class="v">{esc(fmt_usd(usd,0))}</div></div>'
            )
        return "".join(out)

    # Funding table
    venues = ["Binance", "Bybit", "OKX", "Hyperliquid"]

    def funding_table() -> str:
        head = "".join([f"<th>{esc(v)}</th>" for v in venues])

        def tr(asset: str) -> str:
            tds = "".join([f"<td>{rate_span(funding.get(asset, {}).get(v))}</td>" for v in venues])
            return f"<tr><td class=asset>{esc(asset)}</td>{tds}</tr>"

        return f"""
        <table class=tbl>
          <thead><tr><th></th>{head}</tr></thead>
          <tbody>
            {tr('BTC')}
            {tr('ETH')}
          </tbody>
        </table>
        """

    def arb_table() -> str:
        if not arb:
            return '<div class="muted">—</div>'
        rows = []
        for r in arb:
            badge = '<span class="badge">SPREAD</span>' if r.get("badge") else ""
            lv, lr = r["long_leg"]
            sv, sr = r["short_leg"]
            rows.append(
                "<tr>"
                f"<td class=asset>{esc(r['asset'])}</td>"
                f"<td><span class=mono>{esc(fmt_rate_8h(r['spread_8h']))}</span> <span class=muted>({esc(fmt_apr(r['spread_apr']))} APR)</span> {badge}</td>"
                f"<td class=mono>{esc(lv)} {esc(fmt_rate_8h(lr))}</td>"
                f"<td class=mono>{esc(sv)} {esc(fmt_rate_8h(sr))}</td>"
                "</tr>"
            )
        return f"""
        <table class=tbl>
          <thead>
            <tr><th>Asset</th><th>Spread</th><th>Long leg</th><th>Short leg</th></tr>
          </thead>
          <tbody>
            {''.join(rows)}
          </tbody>
        </table>
        """

    # HL perps table (8h/APR/premium)
    def hl_table() -> str:
        def tr(asset: str, p: HlPerpSummary) -> str:
            return (
                "<tr>"
                f"<td class=asset>{esc(asset)}</td>"
                f"<td>{rate_span(p.funding_8h_pct)}</td>"
                f"<td><span class=mono>{esc(fmt_apr(p.funding_apr_pct))}</span></td>"
                f"<td><span class=mono>{esc(fmt_pct(p.premium_pct, 4))}</span></td>"
                "</tr>"
            )

        return f"""
        <table class=tbl>
          <thead><tr><th></th><th>8h</th><th>APR</th><th>Premium (mark vs oracle)</th></tr></thead>
          <tbody>
            {tr('BTC', hl_b)}
            {tr('ETH', hl_e)}
          </tbody>
        </table>
        """

    css = """
    :root{--bg:#0a0e1a;--panel:#0f172a;--muted:#94a3b8;--fg:#e5e7eb;--pos:#4ade80;--neg:#f87171;--line:#1f2a44;}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--fg);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,\"Liberation Mono\",\"Courier New\",monospace;}
    .wrap{max-width:1200px;margin:0 auto;padding:20px}
    .top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:16px}
    .title{font-size:18px;font-weight:700}
    .stamp{color:var(--muted);font-size:12px}
    .bar{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:16px}
    .kv{padding:6px 8px;border-radius:10px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.04)}
    .k{color:var(--muted);font-size:11px;margin-bottom:4px}
    .v{font-size:16px;font-weight:700}
    .pos{color:var(--pos)}
    .neg{color:var(--neg)}
    .muted{color:var(--muted)}
    .mono{font-variant-numeric:tabular-nums}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    @media (max-width:860px){.grid{grid-template-columns:1fr}.bar{grid-template-columns:repeat(2,1fr)}}
    .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}
    .h{font-size:14px;font-weight:700;margin:0 0 10px 0}
    .subgrid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    @media (max-width:860px){.subgrid{grid-template-columns:1fr}}
    .row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px dashed rgba(148,163,184,0.2)}
    .row:last-child{border-bottom:none}
    .tbl{width:100%;border-collapse:collapse}
    .tbl th,.tbl td{border-bottom:1px solid rgba(148,163,184,0.15);padding:8px 8px;text-align:left;vertical-align:top}
    .tbl th{color:var(--muted);font-weight:700;font-size:12px}
    .asset{font-weight:700}
    .badge{display:inline-block;margin-left:8px;padding:2px 6px;border-radius:999px;background:rgba(74,222,128,0.15);border:1px solid rgba(74,222,128,0.25);color:var(--pos);font-size:11px}
    .err{margin-top:10px;color:#fbbf24;font-size:12px;white-space:pre-wrap}
    """

    html_out = f"""<!doctype html>
<html lang=en>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<title>BTC Brief</title>
<style>{css}</style>
</head>
<body>
  <div class=wrap>
    <div class=top>
      <div class=title>BTC Derivatives Brief</div>
      <div class=stamp>Updated: {esc(ts_utc)}</div>
    </div>

    <div class=bar>
      <div class=kv><div class=k>BTC (Binance)</div><div class=v>{esc(fmt_usd(btc.price, 2))}</div></div>
      <div class=kv><div class=k>BTC 24h</div><div class=v>{pct_span(btc.chg24h_pct, 2)}</div></div>
      <div class=kv><div class=k>BTC 7d</div><div class=v>{pct_span(btc.chg7d_pct, 2)}</div></div>
      <div class=kv><div class=k>BTC OI (HL)</div><div class=v>{esc(fmt_usd(hl_b.oi_usd, 0))}</div></div>
      <div class=kv><div class=k>ETH (Binance)</div><div class=v>{esc(fmt_usd(eth.price, 2))}</div></div>
      <div class=kv><div class=k>ETH OI (HL)</div><div class=v>{esc(fmt_usd(hl_e.oi_usd, 0))}</div></div>
    </div>

    <div class=grid>
      <div class=card>
        <div class=h>Liquidation & Perps</div>
        <div class=subgrid>
          <div>
            <div class=muted style="margin-bottom:6px">Short liq walls above spot (30d)</div>
            {liq_rows(shorts)}
          </div>
          <div>
            <div class=muted style="margin-bottom:6px">Long liq walls below spot (30d)</div>
            {liq_rows(longs)}
          </div>
        </div>
        {small_err('coinglass')}
        <div style="height:10px"></div>
        <div class=muted style="margin-bottom:6px">Hyperliquid funding</div>
        {hl_table()}
        {small_err('hyperliquid')}
      </div>

      <div class=card>
        <div class=h>Funding Arb Alerts</div>
        <div class=muted style="margin-bottom:6px">Funding rates (8h %)</div>
        {funding_table()}
        {small_err('funding')}
        <div style="height:10px"></div>
        <div class=muted style="margin-bottom:6px">Arb spreads (max - min)</div>
        {arb_table()}
      </div>
    </div>

    <div class=stamp style="margin-top:14px">Sources: Binance · Hyperliquid · CoinGlass · Bybit · OKX</div>
  </div>
</body>
</html>
"""

    return html_out


def main() -> int:
    errors: Dict[str, str] = {}
    ts_utc = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())

    # Prices
    spot: Dict[str, SpotSummary] = {"BTC": SpotSummary(), "ETH": SpotSummary()}
    try:
        spot["BTC"] = fetch_binance_spot("BTCUSDT")
        spot["ETH"] = fetch_binance_spot("ETHUSDT")
    except Exception as e:
        errors["binance"] = f"Binance fetch failed: {e}"

    # Hyperliquid perps
    hl: Dict[str, HlPerpSummary] = {"BTC": HlPerpSummary(), "ETH": HlPerpSummary()}
    try:
        hl = fetch_hl_perps()
    except Exception as e:
        errors["hyperliquid"] = f"Hyperliquid fetch failed: {e}"

    # Funding (multi-venue)
    funding: Dict[str, Dict[str, Optional[float]]] = {
        "BTC": {"Binance": None, "Bybit": None, "OKX": None, "Hyperliquid": None},
        "ETH": {"Binance": None, "Bybit": None, "OKX": None, "Hyperliquid": None},
    }
    try:
        funding = fetch_funding_8h_rates()
    except Exception as e:
        errors["funding"] = f"Funding fetch failed: {e}"

    arb = build_funding_arb(funding)

    # CoinGlass liquidation walls
    liq = None
    try:
        key = os.environ.get("COINGLASS_API_KEY")
        if key:
            spot_btc = spot["BTC"].price
            if spot_btc is not None:
                short_map, long_map = fetch_coinglass_liq_map("BTC", time_type=3, api_key=key)
                liq = pick_top_walls(short_map, long_map, spot_btc)
            else:
                raise RuntimeError("missing BTC spot for wall filtering")
        else:
            raise RuntimeError("COINGLASS_API_KEY not set")
    except Exception as e:
        errors["coinglass"] = f"CoinGlass liq map failed: {e}"

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    out = render_html(ts_utc=ts_utc, spot=spot, hl=hl, liq=liq, funding=funding, arb=arb, errors=errors)

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(out)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
