#!/usr/bin/env python3
"""Daily BTC derivatives brief → static HTML for GitHub Pages.
Deps: requests only. Env: COINGLASS_API_KEY (optional). Output: btc_brief/index.html
All sections degrade gracefully ("—") on failure.
"""

import html, os, time, requests

BIN_SPOT="https://api.binance.com"; BIN_SPOT_FALLBACK="https://data-api.binance.vision"  # common mirror
BIN_FUT="https://fapi.binance.com"; BIN_FUT_FALLBACK="https://fapi.binance.com"  # keep slot for future mirrors
BYBIT="https://api.bybit.com"; OKX="https://www.okx.com"; HL="https://api.hyperliquid.xyz/info";
COINGLASS_V2="https://open-api.coinglass.com"; COINGLASS_V4="https://open-api-v4.coinglass.com";
OUT=os.path.join("btc_brief","index.html")

UA={"User-Agent":"btc-brief/1.0","accept":"application/json"}

def g(url,params=None,headers=None,timeout=12):
  h=dict(UA); 
  if headers: h.update(headers)
  r=requests.get(url,params=params,headers=h,timeout=timeout)
  r.raise_for_status(); return r.json()

def p(url,body=None,headers=None,timeout=12): r=requests.post(url,json=body,headers=headers,timeout=timeout); r.raise_for_status(); return r.json()

def f(x):
  try: return float(x)
  except Exception: return None

def usd(x,dp=0): return "—" if x is None else f"${x:,.{dp}f}"

def pct(x,dp=2):
  if x is None: return "—"
  return ("+" if x>=0 else "")+f"{x:.{dp}f}%"

def r8(x):
  if x is None: return "—"
  return ("+" if x>=0 else "")+f"{x:.4f}%"

def cls(x): return "" if x is None else ("pos" if x>=0 else "neg")

def safe(errs,k,fn):
  try: return fn()
  except Exception as e: errs[k]=str(e); return None

def bin_spot(sym):
  # Binance sometimes blocks GH Actions IPs. Try main host then a common mirror.
  bases=[BIN_SPOT,BIN_SPOT_FALLBACK]
  last=ch24=ch7=None
  last_err=None
  for base in bases:
    try:
      t=g(f"{base}/api/v3/ticker/24hr",params={"symbol":sym}); last=f(t.get("lastPrice")); ch24=f(t.get("priceChangePercent"))
      kl=g(f"{base}/api/v3/klines",params={"symbol":sym,"interval":"1d","limit":8}); old=f(kl[0][1]) if isinstance(kl,list) and kl else None
      ch7=((last-old)/old*100) if (last is not None and old not in (None,0)) else None
      return {"price":last,"24h":ch24,"7d":ch7}
    except Exception as e:
      last_err=e
  raise last_err

def hl_ctx():
  meta,ctxs=p(HL,body={"type":"metaAndAssetCtxs"},headers={"Content-Type":"application/json"},timeout=15); uni=meta.get("universe",[])
  def one(name):
    i=next(i for i,u in enumerate(uni) if u.get("name")==name); c=ctxs[i]
    mark,oracle=f(c.get("markPx")),f(c.get("oraclePx")); oi=f(c.get("openInterest")); fh=f(c.get("funding")); prem=f(c.get("premium"))
    return {"oi_usd":(oi*mark) if (oi is not None and mark is not None) else None, "fund_8h":(fh*8*100) if fh is not None else None, "apr":(fh*8760*100) if fh is not None else None, "prem":(prem*100) if prem is not None else None}
  return {"BTC":one("BTC"),"ETH":one("ETH")}

def funding(hl):
  out={a:{"Binance":None,"Bybit":None,"OKX":None,"Hyperliquid":(hl.get(a) or {}).get("fund_8h")} for a in ("BTC","ETH")}

  # Binance futures (try main host; keep fallback slot)
  last_err=None
  for base in (BIN_FUT,BIN_FUT_FALLBACK):
    try:
      j=g(f"{base}/fapi/v1/premiumIndex",timeout=12)
      if isinstance(j,list):
        for r in j:
          if r.get("symbol")=="BTCUSDT": out["BTC"]["Binance"]=(f(r.get("lastFundingRate")) or 0.0)*100
          if r.get("symbol")=="ETHUSDT": out["ETH"]["Binance"]=(f(r.get("lastFundingRate")) or 0.0)*100
      break
    except Exception as e:
      last_err=e

  # Bybit / OKX (best-effort)
  for a in ("BTC","ETH"):
    try:
      jb=g(f"{BYBIT}/v5/market/tickers",params={"category":"linear","symbol":f"{a}USDT"},timeout=12)
      out[a]["Bybit"]=(f(((jb.get("result") or {}).get("list") or [{}])[0].get("fundingRate"))*100) if jb else None
    except Exception:
      pass
    try:
      jo=g(f"{OKX}/api/v5/public/funding-rate",params={"instId":f"{a}-USDT-SWAP"},timeout=12)
      out[a]["OKX"]=(f(((jo.get("data") or [{}])[0].get("fundingRate"))*100) if jo else None)
    except Exception:
      pass

  return out

def coinglass_walls_v2(spot):
  key=os.environ.get("COINGLASS_API_KEY")
  if not key: raise RuntimeError("COINGLASS_API_KEY not set")
  j=g(f"{COINGLASS_V2}/public/v2/liquidation/map",headers={"coinglassSecret":key},params={"symbol":"BTC","timeType":"3"},timeout=20)
  d=j.get("data") or {}; sm, lm=d.get("shortLiqMap") or {}, d.get("longLiqMap") or {}
  def parse(m):
    if not isinstance(m,dict): return []
    out=[]
    for k,v in m.items():
      px,amt=f(k),f(v)
      if px is not None and amt is not None: out.append((px,amt))
    return out
  shorts=[(px,amt) for px,amt in parse(sm) if spot<px<=spot*1.10]; longs=[(px,amt) for px,amt in parse(lm) if spot*0.90<=px<spot]
  shorts.sort(key=lambda x:x[1],reverse=True); longs.sort(key=lambda x:x[1],reverse=True)
  return {"shorts":shorts[:3],"longs":longs[:3]}

def coinglass_walls_v4(spot):
  key=os.environ.get("COINGLASS_API_KEY")
  if not key: raise RuntimeError("COINGLASS_API_KEY not set")
  # v4 expects CG-API-KEY; free keys may return {code:401,msg:"Upgrade plan"}
  j=g(f"{COINGLASS_V4}/api/futures/liquidation/map",headers={"CG-API-KEY":key},params={"symbol":"BTC","time_type":"3"},timeout=25)
  # v4 often returns {code,msg,data}
  if isinstance(j,dict) and str(j.get("code")) != "0":
    raise RuntimeError(j.get("msg") or f"CoinGlass v4 error code {j.get('code')}")
  data=j.get("data") or {}
  sm, lm=data.get("shortLiqMap") or {}, data.get("longLiqMap") or {}
  def parse(m):
    if not isinstance(m,dict): return []
    out=[]
    for k,v in m.items():
      px,amt=f(k),f(v)
      if px is not None and amt is not None: out.append((px,amt))
    return out
  shorts=[(px,amt) for px,amt in parse(sm) if spot<px<=spot*1.10]; longs=[(px,amt) for px,amt in parse(lm) if spot*0.90<=px<spot]
  shorts.sort(key=lambda x:x[1],reverse=True); longs.sort(key=lambda x:x[1],reverse=True)
  return {"shorts":shorts[:3],"longs":longs[:3]}

def okx_realized_liq_clusters(spot, *, limit=100):
  # Public realized liquidation events; we build a proxy "walls" histogram.
  j=g(f"{OKX}/api/v5/public/liquidation-orders",params={"instType":"SWAP","mgnMode":"isolated","uly":"BTC-USDT","state":"filled","limit":str(limit)},timeout=15)
  details=((j.get("data") or [{}])[0].get("details") or []) if isinstance(j,dict) else []
  bucket=100.0
  agg_long={}; agg_short={}
  for d in details:
    px=f(d.get("bkPx")); sz=f(d.get("sz"))
    if px is None or sz is None: continue
    notional=px*sz
    b=round(px/bucket)*bucket
    # OKX: posSide short + side buy = short got liquidated (buy to cover) => SHORT liq
    pos=str(d.get("posSide") or "").lower(); side=str(d.get("side") or "").lower()
    if pos=="short" and side=="buy":
      agg_short[b]=agg_short.get(b,0.0)+notional
    elif pos=="long" and side=="sell":
      agg_long[b]=agg_long.get(b,0.0)+notional

  shorts=[(px,amt) for px,amt in agg_short.items() if spot<px<=spot*1.10]
  longs=[(px,amt) for px,amt in agg_long.items() if spot*0.90<=px<spot]
  shorts.sort(key=lambda x:x[1],reverse=True); longs.sort(key=lambda x:x[1],reverse=True)
  return {"shorts":shorts[:3],"longs":longs[:3]}

def arb(fr):
  rows=[]
  for a,vs in fr.items():
    av=[(v,r) for v,r in vs.items() if r is not None]
    if len(av)<2: continue
    lo_v,lo_r=min(av,key=lambda x:x[1]); hi_v,hi_r=max(av,key=lambda x:x[1]); spr=hi_r-lo_r
    rows.append({"a":a,"spr":spr,"apr":spr*3*365,"lo":(lo_v,lo_r),"hi":(hi_v,hi_r),"badge":spr>0.03})
  rows.sort(key=lambda r:r["spr"],reverse=True); return rows

def render(ts,spot,hl,liq,okxliq,fr,ar,errs):
  e=lambda s: html.escape(str(s),quote=True)
  css=":root{--bg:#0a0e1a;--p:#0f172a;--m:#94a3b8;--fg:#e5e7eb;--pos:#4ade80;--neg:#f87171;--ln:#1f2a44}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,Liberation Mono,Courier New,monospace}.w{max-width:1200px;margin:0 auto;padding:20px}.top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}.t{font-weight:700}.s{color:var(--m);font-size:12px}.bar{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;background:var(--p);border:1px solid var(--ln);border-radius:12px;padding:12px;margin-bottom:14px}.kv{padding:6px 8px;border-radius:10px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.04)}.k{color:var(--m);font-size:11px}.v{font-size:16px;font-weight:700}.pos{color:var(--pos)}.neg{color:var(--neg)}.muted{color:var(--m)}.g{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:860px){.g{grid-template-columns:1fr}.bar{grid-template-columns:repeat(2,1fr)}}.c{background:var(--p);border:1px solid var(--ln);border-radius:12px;padding:14px}.h{font-weight:700;margin:0 0 10px 0}.sg{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:860px){.sg{grid-template-columns:1fr}}.row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px dashed rgba(148,163,184,.2)}.row:last-child{border-bottom:none}.tbl{width:100%;border-collapse:collapse}.tbl th,.tbl td{border-bottom:1px solid rgba(148,163,184,.15);padding:8px;text-align:left;vertical-align:top}.tbl th{color:var(--m);font-size:12px}.badge{display:inline-block;margin-left:8px;padding:2px 6px;border-radius:999px;background:rgba(74,222,128,.15);border:1px solid rgba(74,222,128,.25);color:var(--pos);font-size:11px}.err{margin-top:8px;color:#fbbf24;font-size:12px;white-space:pre-wrap}.tip{color:var(--m);cursor:help;user-select:none}"
  btc,eth=spot["BTC"],spot["ETH"]; hlb,hle=hl["BTC"],hl["ETH"]; venues=["Binance","Bybit","OKX","Hyperliquid"]
  def cell(k,v): return f'<div class=kv><div class=k>{e(k)}</div><div class=v>{v}</div></div>'
  def sp(x,txt): return f'<span class={cls(x)}>{e(txt)}</span>'
  def liq_rows(arr):
    if not arr: return '<div class="muted">—</div>'
    return "".join([f'<div class=row><div class=k>{e(usd(px,0))}</div><div class=v>{e(usd(amt,0))}</div></div>' for px,amt in arr])
  def err(k): return f'<div class=err>{e(k+": "+errs[k])}</div>' if k in errs else ""
  def rt(x): return f'<span class={cls(x)}>{e(r8(x))}</span>'
  rate_tbl=("<tr><td><b>BTC</b></td>"+"".join([f"<td>{rt(fr['BTC'][v])}</td>" for v in venues])+"</tr>"+
            "<tr><td><b>ETH</b></td>"+"".join([f"<td>{rt(fr['ETH'][v])}</td>" for v in venues])+"</tr>")
  arb_html='<div class="muted">—</div>'
  if ar:
    rows=[]
    for r in ar:
      b='<span class=badge>SPREAD</span>' if r["badge"] else ""; lv,lr=r["lo"]; sv,sr=r["hi"]
      rows.append(f"<tr><td><b>{e(r['a'])}</b></td><td>{e(r8(r['spr']))} <span class=muted>({e(pct(r['apr'],2))} APR)</span> {b}</td><td>{e(lv)} {e(r8(lr))}</td><td>{e(sv)} {e(r8(sr))}</td></tr>")
    arb_html="<table class=tbl><thead><tr><th>Asset</th><th>Spread</th><th>Long leg</th><th>Short leg</th></tr></thead><tbody>"+"".join(rows)+"</tbody></table>"
  return f"""<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>BTC Brief</title><style>{css}</style></head><body><div class=w>
<div class=top><div class=t>BTC Derivatives Brief</div><div class=s>Updated: {e(ts)}</div></div>
<div class=bar>
{cell('BTC (Binance)',e(usd(btc['price'],2)))}{cell('BTC 24h',sp(btc['24h'],pct(btc['24h'],2)))}{cell('BTC 7d',sp(btc['7d'],pct(btc['7d'],2)))}{cell('BTC OI (HL)',e(usd(hlb['oi_usd'],0)))}{cell('ETH (Binance)',e(usd(eth['price'],2)))}{cell('ETH OI (HL)',e(usd(hle['oi_usd'],0)))}
</div>
<div class=g>
  <div class=c><div class=h>Liquidation &amp; Perps</div><div class=sg>
    <div><div class=muted style=\"margin-bottom:6px\">Source: CoinGlass (liq map, 30d)</div>
      <div class=muted style=\"margin-bottom:6px\">Short above spot</div>{liq_rows((liq or {}).get('shorts'))}
      <div class=muted style=\"margin-bottom:6px; margin-top:8px\">Long below spot</div>{liq_rows((liq or {}).get('longs'))}
    </div>
    <div>
      <div class=muted style=\"margin-bottom:6px\">Source: OKX (realized liquidations) — proxy clusters <span class=tip title=\"Proxy method (step-by-step):\n1) Pull OKX public liquidation orders for BTC-USDT SWAP (isolated, state=filled, last 100).\n2) For each event: take bkPx (bankruptcy price) and sz (BTC size).\n3) Approx USD notional = bkPx * sz.\n4) Bin bkPx into $100 buckets.\n5) Aggregate USD notional per bucket, split by side:\n   - posSide=short & side=buy => SHORT liquidation\n   - posSide=long & side=sell => LONG liquidation\n6) Show top 3 buckets within +/-10% of spot (above=shorts, below=longs).\nNote: This is realized liq flow, not a predictive liquidation heatmap.\">[?]</span></div>
      <div class=muted style=\"margin-bottom:6px\">Short above spot</div>{liq_rows((okxliq or {}).get('shorts'))}
      <div class=muted style=\"margin-bottom:6px; margin-top:8px\">Long below spot</div>{liq_rows((okxliq or {}).get('longs'))}
    </div>
  </div>{err('coinglass')}<div style=\"height:10px\"></div><div class=muted style=\"margin-bottom:6px\">Hyperliquid funding</div>
  <table class=tbl><thead><tr><th></th><th>8h</th><th>APR</th><th>Premium</th></tr></thead><tbody>
    <tr><td><b>BTC</b></td><td>{rt(hlb['fund_8h'])}</td><td>{e(pct(hlb['apr'],2))}</td><td>{e(pct(hlb['prem'],4))}</td></tr>
    <tr><td><b>ETH</b></td><td>{rt(hle['fund_8h'])}</td><td>{e(pct(hle['apr'],2))}</td><td>{e(pct(hle['prem'],4))}</td></tr>
  </tbody></table>{err('hyperliquid')}</div>
  <div class=c><div class=h>Funding Arb Alerts</div><div class=muted style=\"margin-bottom:6px\">Funding rates (8h %)</div>
  <table class=tbl><thead><tr><th></th>"""+"".join([f"<th>{e(v)}</th>" for v in venues])+f"""</tr></thead><tbody>{rate_tbl}</tbody></table>{err('funding')}
  <div style=\"height:10px\"></div><div class=muted style=\"margin-bottom:6px\">Arb spreads (max - min)</div>{arb_html}</div>
</div><div class=s style=\"margin-top:12px\">Sources: Binance · Hyperliquid · CoinGlass · Bybit · OKX</div>
</div></body></html>"""

def main():
  errs={}; ts=time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())
  spot={"BTC":{"price":None,"24h":None,"7d":None},"ETH":{"price":None,"24h":None,"7d":None}}
  b=safe(errs,"binance",lambda:bin_spot("BTCUSDT")); e=safe(errs,"binance",lambda:bin_spot("ETHUSDT"))
  if b: spot["BTC"]=b
  if e: spot["ETH"]=e
  hl=safe(errs,"hyperliquid",hl_ctx) or {"BTC":{"oi_usd":None,"fund_8h":None,"apr":None,"prem":None},"ETH":{"oi_usd":None,"fund_8h":None,"apr":None,"prem":None}}
  fr=safe(errs,"funding",lambda:funding(hl)) or {a:{"Binance":None,"Bybit":None,"OKX":None,"Hyperliquid":None} for a in ("BTC","ETH")}
  liq=None; okxliq=None
  if spot["BTC"]["price"] is not None:
    spotpx=spot["BTC"]["price"]
    # Keep old CoinGlass section but prefer v4 (gives definitive "Upgrade plan" when gated).
    liq=safe(errs,"coinglass",lambda: coinglass_walls_v4(spotpx))
    if liq is None:
      # If v4 fails for non-plan reasons, fall back to v2 (may 500).
      liq=safe(errs,"coinglass_v2",lambda: coinglass_walls_v2(spotpx)) or liq
    # Alt feed always attempted (free)
    okxliq=safe(errs,"okx_liq",lambda: okx_realized_liq_clusters(spotpx))

  os.makedirs(os.path.dirname(OUT), exist_ok=True)
  with open(OUT,"w",encoding="utf-8") as fp: fp.write(render(ts,spot,hl,liq,okxliq,fr,arb(fr),errs))

if __name__=="__main__": main()
