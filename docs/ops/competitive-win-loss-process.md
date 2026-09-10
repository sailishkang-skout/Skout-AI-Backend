# §2 Competitive win/loss — GTM process (closed)

**Leadership decision:** 2026-08-29  
**Review window:** last 2–4 quarters through **2026-09-09**  
**Engineering:** API + Postgres + Regional TAM gate — **live**  
**Policy:** ADR [0012](../adr/0012-competitive-positioning-proposed-until-validated.md)

## Positioning rule (effective now)

Until **≥4 real won/lost deals** are recorded in Skout:

| Differentiator | Status |
|----------------|--------|
| Regional intelligence | **Proposed** — not a proven advantage |
| Evidence-backed recommendations | **Proposed** — not a proven advantage |
| Operator control | **Proposed** — not a proven advantage |

**Marketing:** only claims you can substantiate with product facts or recorded deal evidence.  
**Regional TAM Learning (§6.3):** **no-go** for go-to-market claims until gate clears.  
**Product:** assess Regional TAM builds against **customer need + pilot metrics**, not assumptions.

Check gate any time:

```bash
curl -H "Authorization: Bearer $TOKEN" -H "X-Workspace-Id: $WS" \
  https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com/api/v1/competitive/win-loss
```

`positioning.status` → `proposed_not_proven` | `validated`

---

## Step 1 — Assign product owner (once per workspace)

Logged-in workspace member (owner/admin):

```bash
curl -X POST .../api/v1/competitive/win-loss/assign \
  -H "Authorization: Bearer $TOKEN" -H "X-Workspace-Id: $WS"
```

---

## Step 2 — Review deal history (GTM)

Sources: CRM, Salesforce, HubSpot export, Gong notes, spreadsheets — **last 2–4 quarters**.

For each deal capture:

- Account name  
- Won or lost  
- Competitors evaluated  
- Differentiator cited (if any)  
- Did regional or evidence claims **materially** affect the decision? (Y/N)  
- Notes / link to source

**Do not** use `POST /competitive/win-loss/seed-demo` for GTM sign-off — demo rows are for engineering tests only.

---

## Step 3A — If ≥4 qualifying deals exist

Record each deal:

```bash
curl -X POST .../api/v1/competitive/win-loss/deals \
  -H "Authorization: Bearer $TOKEN" -H "X-Workspace-Id: $WS" \
  -H "Content-Type: application/json" \
  -d '{
    "accountName": "Acme Corp",
    "outcome": "won",
    "competitors": "Apollo, Outreach",
    "differentiatorCited": "Operator control / Policy Gateway",
    "evidenceOrRegionalMaterial": true,
    "notes": "Source: Salesforce opp 00Q… — buyer cited audit trail"
  }'
```

When `dealsReviewed >= 4`, `status` → `complete` and `positioning.status` → `validated`.

Fill **Findings** + **Go** on `docs/templates/competitive-win-loss.md` and sign off.

---

## Step 3B — If fewer than 4 deals (gap path)

1. Complete the **Gap documentation** section in `docs/templates/competitive-win-loss.md`.  
2. Keep `positioning.status` = `proposed_not_proven`.  
3. Do **not** unlock Regional TAM marketing claims.  
4. Run **pilot feedback** (below) to gather hypothesis signal until real deals exist.

---

## Pilot feedback (when gap documented)

Use when closed-won/lost history is thin. **Not a substitute** for win/loss rows.

| Field | Capture |
|-------|---------|
| Prospect / pilot name | |
| Stage | discovery / pilot / churned |
| Differentiator discussed | regional / evidence / operator control / other |
| Buyer reaction | positive / neutral / negative / N/A |
| Would pay for regional TAM? | Y / N / unknown |
| Evidence / provenance importance | 1–5 |
| Source | call date, email, survey |

Store in CRM notes or attach summary to the template **Findings** section. Tag as `pilot_hypothesis`, not `validated_deal`.

---

## Engineering gates (automatic)

| Surface | Behavior when not validated |
|---------|----------------------------|
| `POST /regional-intel` `purpose=tam\|competitive` | **422** — gate blocked |
| `POST /regional-intel` `purpose=onboarding\|territory` | Allowed; response `unverified: true` |
| `GET /regional-intel/gate` | `gate: not_validated` |
| Marketing copy | **Manual** — follow policy above |

---

## Sign-off checklist

- [ ] Product owner assigned via API  
- [ ] Deal history reviewed (2–4 quarters)  
- [ ] Either ≥4 deals in API **or** gap documented + pilot track started  
- [ ] Template `competitive-win-loss.md` updated  
- [ ] Findings reviewed with Eng lead  
- [ ] Marketing briefed on proposed vs validated stance  

**Template:** [`docs/templates/competitive-win-loss.md`](../templates/competitive-win-loss.md)
