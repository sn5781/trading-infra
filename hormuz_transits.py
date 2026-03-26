#!/usr/bin/env python3
"""Render Strait of Hormuz transit dashboard to hormuz_transits/index.html.

Data approach:
- Seeded historical rows from directly citable source pages/search-confirmed daily reports.
- Daily updater tries Windward daily pages and extracts previous-day transit counts + up to 3 transit-specific notes.
- Publishes a simple dark dashboard to GitHub Pages.
"""
from __future__ import annotations
import datetime as dt, html, json, os, re, requests

OUT = os.path.join('hormuz_transits', 'index.html')
SEED = os.path.join('hormuz_transits', 'seed.json')
UA = {'User-Agent': 'hormuz-transits/1.0', 'accept': 'text/html,application/json'}


def get(url, timeout=20):
    r = requests.get(url, headers=UA, timeout=timeout)
    r.raise_for_status()
    return r.text


def fetch_json(url, timeout=20):
    r = requests.get(url, headers=UA, timeout=timeout)
    r.raise_for_status()
    return r.json()


def load_seed():
    with open(SEED, 'r', encoding='utf-8') as f:
        return json.load(f)


def windward_url(report_day: dt.date) -> str:
    month = report_day.strftime('%B').lower()
    return f'https://windward.ai/blog/{month}-{report_day.day}-maritime-intelligence-daily/'


def fetch_windward(report_day: dt.date):
    try:
        txt = get(windward_url(report_day))
    except Exception:
        return None
    if 'Iran War Maritime Intelligence Daily' not in txt:
        return None
    plain = re.sub(r'<[^>]+>', ' ', txt)
    plain = re.sub(r'\s+', ' ', plain)
    target_day = report_day - dt.timedelta(days=1)
    target_s = f"{target_day.strftime('%B')} {target_day.day}"
    pats = [
        rf"On {re.escape(target_s)}, only (\d+) [A-Z]*-?(?:transmitting )?(?:commercial )?(?:vessel )?crossings",
        rf"On {re.escape(target_s)}, (\d+) [A-Z]*-?(?:transmitting )?vessels were recorded transiting",
        rf"On {re.escape(target_s)}, Windward recorded (\d+) (?:total )?crossings",
        rf"{re.escape(target_s)}[^.]*?only (\d+) [A-Z]*-?(?:visible|confirmed)? ?crossings",
        rf"{re.escape(target_s)}[^.]*?(\d+) AIS-transmitting vessels were recorded transiting",
        rf"{re.escape(target_s)}[^.]*?(\d+) AIS-transmitting vessels crossed the Strait",
        rf"{re.escape(target_s)}[^.]*?(\d+) total crossings",
        rf"{re.escape(target_s)}[^.]*?(\d+) outbound and (\d+) inbound",
    ]
    count = None
    for pat in pats:
        m = re.search(pat, plain, re.I)
        if m:
            nums = [int(x) for x in m.groups() if x and x.isdigit()]
            count = sum(nums) if len(nums) > 1 else nums[0]
            break
    if count is None:
        return None
    notes = []
    for pat in [
        rf"On {re.escape(target_s)}[^.]*?([^.]*northern corridor[^.]*)\.",
        rf"On {re.escape(target_s)}[^.]*?([^.]*Iranian territorial waters[^.]*)\.",
        rf"On {re.escape(target_s)}[^.]*?([^.]*standard commercial lanes remained empty[^.]*)\.",
        rf"On {re.escape(target_s)}[^.]*?([^.]*one inbound and .*? outbound[^.]*)\.",
        rf"On {re.escape(target_s)}[^.]*?([^.]*all vessels followed a northern routing pattern[^.]*)\.",
    ]:
        m = re.search(pat, plain, re.I)
        if m:
            note = m.group(1).strip()
            if note and note not in notes:
                notes.append(note)
    if len(notes) < 3:
        bullets = re.findall(r'At a Glance (.*?) Operational Overview', plain, re.I)
        if bullets:
            bl = bullets[0]
            for chunk in re.split(r' - | • ', bl):
                chunk = chunk.strip(' .-')
                if not chunk:
                    continue
                lc = chunk.lower()
                if 'transit' in lc or 'crossing' in lc or 'corridor' in lc or 'territorial waters' in lc or 'commercial lanes' in lc:
                    if chunk not in notes:
                        notes.append(chunk)
                if len(notes) >= 3:
                    break
    return {
        'date': target_day.isoformat(),
        'vessels': count,
        'notes': notes[:3],
        'source': 'Windward Maritime Intelligence',
        'source_url': windward_url(report_day),
    }


def merge_rows(seed_rows, fetched_rows):
    by_date = {r['date']: r for r in seed_rows}
    for r in fetched_rows:
        if not r:
            continue
        if r['date'] not in by_date:
            by_date[r['date']] = r
    rows = list(by_date.values())
    rows.sort(key=lambda r: r['date'])
    return rows


def color_class(v):
    if v is None:
        return 'na'
    if v >= 40:
        return 'green'
    if v >= 15:
        return 'yellow'
    if v >= 5:
        return 'orange'
    return 'red'


def render(rows):
    updated = dt.datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')
    known = [r['vessels'] for r in rows if isinstance(r.get('vessels'), int)]
    latest = rows[-1]['date'] if rows else '—'
    avg = (sum(known) / len(known)) if known else None
    maxv = max(known) if known else None
    minv = min(known) if known else None
    esc = lambda s: html.escape(str(s), quote=True)

    trs = []
    for r in reversed(rows):
        v = r.get('vessels')
        notes = ''.join(f'<li>{esc(n)}</li>' for n in (r.get('notes') or [])[:3]) or '<li>—</li>'
        src = f'<a href="{esc(r.get("source_url","#"))}" target="_blank" rel="noreferrer">{esc(r.get("source","source"))}</a>'
        trs.append(
            f"<tr>"
            f"<td>{esc(r['date'])}</td>"
            f"<td><span class='pill {color_class(v)}'>{esc(v if v is not None else '—')}</span></td>"
            f"<td><ul>{notes}</ul></td>"
            f"<td>{src}</td>"
            f"</tr>"
        )

    return f"""<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>
<title>Hormuz Transits</title>
<style>
:root{{--bg:#0b1220;--panel:#111827;--muted:#94a3b8;--fg:#e5e7eb;--line:#1f2937;--green:#22c55e;--yellow:#eab308;--orange:#f97316;--red:#ef4444;}}
*{{box-sizing:border-box}} body{{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}}
.wrap{{max-width:1200px;margin:0 auto;padding:20px}} .top{{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}}
.title{{font-size:20px;font-weight:700}} .sub{{color:var(--muted);font-size:12px}} .grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}} @media(max-width:900px){{.grid{{grid-template-columns:repeat(2,1fr)}}}} @media(max-width:640px){{.grid{{grid-template-columns:1fr}}}}
.card{{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px}} .k{{color:var(--muted);font-size:11px;margin-bottom:6px}} .v{{font-size:18px;font-weight:700}} .tbl{{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}} .tbl th,.tbl td{{padding:12px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}} .tbl th{{color:var(--muted);font-size:12px}} .tbl ul{{margin:0;padding-left:18px}} .pill{{display:inline-block;min-width:56px;text-align:center;padding:4px 8px;border-radius:999px;color:#081018;font-weight:700}} .green{{background:var(--green)}} .yellow{{background:var(--yellow)}} .orange{{background:var(--orange)}} .red{{background:var(--red)}} .na{{background:#64748b}} a{{color:#cbd5e1}} .legend{{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 16px;color:var(--muted)}} .lg span{{display:inline-block;width:10px;height:10px;border-radius:999px;margin-right:6px}} .note{{color:var(--muted);font-size:12px;margin-top:10px}}
</style></head><body><div class=wrap>
<div class=top><div><div class=title>Hormuz Transits</div><div class=sub>Daily vessel transits through the Strait of Hormuz — UTC day table with transit-specific notes.</div></div><div class=sub>Updated: {esc(updated)} · Latest day in table: {esc(latest)}</div></div>
<div class=grid>
<div class=card><div class=k>Rows</div><div class=v>{len(rows)}</div></div>
<div class=card><div class=k>Known-count avg</div><div class=v>{'—' if avg is None else f'{avg:.1f}'}</div></div>
<div class=card><div class=k>Known-count max</div><div class=v>{'—' if maxv is None else maxv}</div></div>
<div class=card><div class=k>Known-count min</div><div class=v>{'—' if minv is None else minv}</div></div>
</div>
<div class=legend>
<div class=lg><span style='background:var(--green)'></span>40+ normalizing</div>
<div class=lg><span style='background:var(--yellow)'></span>15–39 constrained</div>
<div class=lg><span style='background:var(--orange)'></span>5–14 severely constrained</div>
<div class=lg><span style='background:var(--red)'></span>0–4 near-stop</div>
</div>
<table class=tbl><thead><tr><th>UTC day</th><th>Vessels</th><th>Transit notes (max 3)</th><th>Source</th></tr></thead><tbody>{''.join(trs)}</tbody></table>
<div class=note>Sources used in current build: Windward Maritime Intelligence daily reports, Lloyd’s List / regional-briefing search corroboration, and PIB/regional context where relevant. The daily updater attempts to add the latest UTC day within 24h of day-end by parsing the next available Windward daily report.</div>
</div></body></html>"""


def main():
    seed_rows = load_seed()
    today = dt.datetime.utcnow().date()
    fetched = []
    for back in range(1, 16):
        fetched.append(fetch_windward(today - dt.timedelta(days=back)))
    rows = merge_rows(seed_rows, fetched)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(render(rows))


if __name__ == '__main__':
    main()
