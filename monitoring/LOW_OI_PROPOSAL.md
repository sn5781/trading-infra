# Low-OI exclusion proposal (review)

This file is informational only.

Using the synced NDJSON logs on the `logs` branch (events-2026-03-16 .. 2026-03-24), these markets had **p90(open_interest_usd) < $100,000** in the logged samples.

Suggested candidates for exclusion (in addition to `hyna:SILVER`, which is consistently 0 OI):
- xyz:ALUMINIUM (p90 = 0)
- xyz:URANIUM (p90 = 0)
- vntl:GOLDJM (p90 = 0)
- vntl:SILVERJM (p90 = 0)

Notes:
- This analysis is based on `oiUsd` fields present in logged events; it is not a full per-cycle census.
- Recommend re-checking after a week; if still dormant, exclude permanently.
