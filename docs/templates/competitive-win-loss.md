# §2 Competitive / win-loss analysis

**Generated:** 2026-08-25  
**Due (generation + 15 days):** **2026-09-09**  
**Leadership decision:** **2026-08-29** — treat differentiators as **proposed** until ≥4 real deals recorded  
**Process runbook:** [`docs/ops/competitive-win-loss-process.md`](../ops/competitive-win-loss-process.md)  
**ADR:** [`docs/adr/0012-competitive-positioning-proposed-until-validated.md`](../adr/0012-competitive-positioning-proposed-until-validated.md)

**Product owner rule:** Must be a **logged-in workspace member** (owner/admin preferred). Assign via
`POST /api/v1/competitive/win-loss/assign` while authenticated — owner is taken from the session,
not free-text.

**Owner (session-assigned):** _call assign endpoint; see `GET /api/v1/competitive/win-loss`_  
**Engineering status:** Process **closed** — API + gate live  
**Validation status:** _GTM reviewing deal history — fill below_

## Positioning stance (effective 2026-08-29)

Until this workbook shows **≥4 real deals** in Skout (`GET /api/v1/competitive/win-loss` → `positioning.status: validated`):

| Differentiator | Marketing / GTM |
|----------------|-----------------|
| Regional intelligence | **Proposed** — not proven |
| Evidence-backed recommendations | **Proposed** — not proven |
| Operator control | **Proposed** — not proven |

Regional TAM Learning (§6.3): **no-go** for substantiated marketing claims.  
Product may pilot Regional TAM features against **customer need + measurable outcomes** only.

## Why real deal analysis is required (not optional)

Vision claims are **product hypotheses**. Without reviewing real won/lost deals:

1. **Roadmap risk** — we may build Regional TAM / competitive features nobody paid for.
2. **Marketing risk** — public claims without deal evidence create enterprise trust debt.
3. **Prioritization** — win-loss tells us which differentiator actually closed revenue vs. noise.
4. **§6.3 gate** — Regional TAM Learning stays **no-go** until ≥4 deals show regional/evidence claims mattered.

Invented, synthetic, or `seed-demo` rows **do not count**. Paste from CRM / Gong / Salesforce only.

## Deals reviewed (last 2–4 quarters) — min 4 rows

| Deal / account | Won/Lost | Competitors | Differentiator cited | Evidence / regional claim material? |
|----------------|----------|-------------|----------------------|-------------------------------------|
| _GTM: fill from CRM_ | | | | |
| | | | | |
| | | | | |
| | | | | |

**Deals recorded in Skout API:** _check `dealsReviewed` on GET /competitive/win-loss_

## Gap documentation (complete if &lt;4 qualifying deals)

**Gap confirmed?** ☐ Yes (&lt;4 deals) ☐ No (≥4 deals recorded)

**Period reviewed:** __________ through __________

**Why gap exists (check all that apply):**
- [ ] Early-stage — insufficient closed opportunities in period
- [ ] Deals exist but lack win/loss notes / competitor data
- [ ] Lost deals not tracked in CRM
- [ ] Other: __________

**Impact on positioning:** Differentiators remain **proposed_not_proven** until ≥4 deals entered.

## Pilot feedback (when gap documented)

| Prospect / pilot | Stage | Differentiator discussed | Buyer reaction | Pay for regional TAM? | Evidence importance (1–5) | Source |
|------------------|-------|--------------------------|----------------|----------------------|---------------------------|--------|
| | | | | | | |
| | | | | | | |

_Tag as pilot hypothesis — not validated win/loss._

## Findings

1. _GTM: summarize what buyers actually cited vs. our three hypotheses_
2. _Which differentiator (if any) correlated with wins?_
3. _Pilot feedback themes (if gap path)_

## Go / no-go for Regional TAM Learning (§6.3)

- [ ] **Validated** — ≥4 real deals + measurable criteria: _________________
- [x] **Not validated** — default until gate clears (proposed differentiators only)

## Sign-off

Product (workspace member): __________ Date: __________  
Eng lead (Neeraj): __________ Date: __________  
GTM / Leadership: __________ Date: __________
