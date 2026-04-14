#!/usr/bin/env python3
import json, math, os, sys
from datetime import date, datetime, timezone
from pathlib import Path

ROLL_WEIGHTS = {1:(1.,0.),2:(1.,0.),3:(1.,0.),4:(1.,0.),5:(1.,0.),6:(.8,.2),7:(.6,.4),8:(.4,.6),9:(.2,.8)}
IBKR_LOGIN_TIME = os.environ.get('IBKR_LOGIN_TIME','2026-04-13T20:21:00-04:00')
IBKR_PORT = int(os.environ.get('IBKR_PORT','4002'))
IBKR_HOST = os.environ.get('IBKR_HOST','127.0.0.1')
CLIENT_ID  = int(os.environ.get('IBKR_CLIENT_ID','31'))
DATA_DIR = Path(__file__).parent.parent / 'data'
OUT_PATH  = DATA_DIR / 'copper-ref.json'

def bd_of_month(d):
    return sum(1 for day in range(1, d.day+1) if date(d.year, d.month, day).weekday() < 5)

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

def main():
    try: from ib_insync import IB, Future
    except ImportError: print('ib_insync missing',file=sys.stderr); sys.exit(1)
    ib=IB()
    try: ib.connect(IBKR_HOST, IBKR_PORT, clientId=CLIENT_ID, timeout=10)
    except Exception as e: print(f'connect fail:{e}',file=sys.stderr); sys.exit(1)
    ib.reqMarketDataType(3)
    today=date.today(); ts=today.strftime('%Y%m%d')
    cds=ib.reqContractDetails(Future(symbol='HG',exchange='COMEX'))
    valid=sorted([cd.contract for cd in cds if cd.contract.lastTradeDateOrContractMonth>=ts],
                 key=lambda c: c.lastTradeDateOrContractMonth)
    if len(valid)<2: print('need 2+ HG',file=sys.stderr); ib.disconnect(); sys.exit(1)
    CODES='FGHJKMNQUVXZ'
    COPPER_SCHED=['H','H','K','K','N','N','U','U','Z','Z','Z','H']
    fc=COPPER_SCHED[today.month-1]; nc=CODES[(CODES.index(fc)+1)%12]
    flist=[c for c in valid if (c.localSymbol or '').endswith(fc)]
    front=flist[0] if flist else valid[0]
    after=[c for c in valid if c.lastTradeDateOrContractMonth>front.lastTradeDateOrContractMonth]
    nlist=[c for c in after if (c.localSymbol or '').endswith(nc)]; next_c=nlist[0] if nlist else (after[0] if after else None)
    if next_c is None: print('no next HG',file=sys.stderr); ib.disconnect(); sys.exit(1)
    res={}
    for lbl,c in [('front',front),('next',next_c)]:
        t=ib.reqMktData(c,'',False,False); ib.sleep(5); px,src=pick(t)
        res[lbl]={'localSymbol':c.localSymbol,'expiry':c.lastTradeDateOrContractMonth,
                  'bid':ns(t.bid),'ask':ns(t.ask),'last':ns(t.last),'close':ns(t.close),
                  'price':px,'price_source':src}
        ib.cancelMktData(c)
    ib.disconnect()
    bd=bd_of_month(today); wf,wn=ROLL_WEIGHTS.get(bd,(0.,1.))
    fp,np_=res['front']['price'],res['next']['price']
    ref=(wf*fp+wn*np_) if fp is not None and np_ is not None else (fp if fp is not None and wf>0 else (np_ if np_ is not None else None))
    out={'ts':datetime.now(timezone.utc).isoformat(),'ibkr_login_time':IBKR_LOGIN_TIME,
         'asset':'COPPER','hl_key':'COPPER','title':'Copper','exchange':'COMEX',
         'ibkr_port':IBKR_PORT,
         'roll':{'business_day':bd,'roll_active':bd>=6,'w_front':wf,'w_next':wn,'ref_price':ref},
         'front':res['front'],'next':res['next']}
    DATA_DIR.mkdir(parents=True,exist_ok=True); OUT_PATH.write_text(json.dumps(out,indent=2))
    print(json.dumps(out,indent=2))

if __name__=='__main__': main()
