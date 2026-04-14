#!/usr/bin/env python3
import json, math, os, sys
from datetime import date, datetime, timezone
from pathlib import Path

IBKR_LOGIN_TIME = os.environ.get('IBKR_LOGIN_TIME','2026-04-13T20:21:00-04:00')
IBKR_PORT = int(os.environ.get('IBKR_PORT','4002'))
IBKR_HOST = os.environ.get('IBKR_HOST','127.0.0.1')
CLIENT_ID  = int(os.environ.get('IBKR_CLIENT_ID','31'))
DATA_DIR = Path(__file__).parent.parent / 'data'
OUT_PATH  = DATA_DIR / 'urnm-ref.json'

def pick(t):
    b,a = t.bid, t.ask
    if b==b and a==a and b is not None and a is not None:
        m=(b+a)/2
        if math.isfinite(m) and m>0: return m,'mid'
    l=t.last
    if l is not None and l==l and math.isfinite(l) and l>0: return l,'last'
    c=t.close
    if c is not None and c==c and math.isfinite(c) and c>0: return c,'close'
    return None,None

def ns(v): return None if (v is None or v!=v) else v

def extract_vol_mcap(t):
    vol=ns(getattr(t,'volume',None))
    if vol is None: vol=ns(getattr(t,'avVolume',None))
    shares=ns(getattr(t,'sharesOutstanding',None))
    return vol,shares

def main():
    try: from ib_insync import IB, Stock
    except ImportError: print("ib_insync missing",file=sys.stderr); sys.exit(1)
    ib=IB()
    try: ib.connect(IBKR_HOST, IBKR_PORT, clientId=CLIENT_ID, timeout=10)
    except Exception as e: print(f"connect fail:{e}",file=sys.stderr); sys.exit(1)
    ib.reqMarketDataType(3)
    c=ib.qualifyContracts(Stock("URNM","SMART","USD"))[0]
    t=ib.reqMktData(c,"",False,False); ib.sleep(6); px,src=pick(t)
    vol,shares=extract_vol_mcap(t)
    mcap=round(shares*px,2) if shares is not None and px is not None else None
    out={"ts":datetime.now(timezone.utc).isoformat(),"ibkr_login_time":IBKR_LOGIN_TIME,"asset":"URNM","hl_key":"URNM","title":"Uranium Miners ETF","exchange":"ARCA","ibkr_port":IBKR_PORT,"ref_price":px,"price_source":src,"contract":{"localSymbol":c.localSymbol,"primaryExchange":c.primaryExchange,"bid":ns(t.bid),"ask":ns(t.ask),"last":ns(t.last),"close":ns(t.close),"price":px,"price_source":src},"volume_24h":vol,"shares_outstanding":shares,"market_cap_usd":mcap}
    ib.cancelMktData(c); ib.disconnect()
    DATA_DIR.mkdir(parents=True,exist_ok=True); OUT_PATH.write_text(__import__("json").dumps(out,indent=2))
    print(__import__("json").dumps(out,indent=2))

if __name__=='__main__': main()