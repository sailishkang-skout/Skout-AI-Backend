# Neeraj Task List — step-by-step feature test guide

**Source:** `Skout_AI_Neeraj_Task_List.pdf`  
**Environment:** SkoutDev (= production) — see `docs/ops/skoutdev-is-production.md`  
**Updated:** 2026-08-26 · image `dev-71b92ef`+

| Base | URL |
|------|-----|
| API / Web origin | `https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com` |
| App (Clerk) | `https://www.skoutai.io/app` (or same API Gateway host if web is routed there) |
| Auth | Sign in with Clerk (owner/admin recommended for admin settings) |

Mark each step **Pass / Fail** as you go. Prefer UI when a page exists; use `curl` + Bearer token (or browser DevTools) for API-only checks.

```bash
export API="https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com"
export TOKEN="<Clerk session JWT>"
# Example authenticated call:
curl -sS -H "Authorization: Bearer $TOKEN" "$API/api/v1/me" | jq .
```

---

## 0. Smoke (always first)

| # | Step | Expected |
|---|------|----------|
| 0.1 | `GET $API/api/v1/health` | `200` `{ "status": "ok" }` |
| 0.2 | `GET $API/api/v1/slo` | Targets JSON + `doc: docs/slo-targets.md` |
| 0.3 | `GET $API/api/v1/metrics` | Prometheus text incl. `skout_journey_*` (or process metrics) |
| 0.4 | Open web app → sign in | Lands in dashboard without 5xx |

---

## §2 — Competitive win/loss

**UI:** CRM / competitive surfaces (or API).  
**APIs:** `/api/v1/competitive/win-loss*`

| # | Step | Expected |
|---|------|----------|
| 2.1 | `GET /api/v1/competitive/win-loss` (auth) | List / summary without 5xx |
| 2.2 | `POST /api/v1/competitive/win-loss/deals` with a sample won/lost deal | `201/200` deal id returned |
| 2.3 | `POST /api/v1/competitive/win-loss/assign` | Owner assigned from session |
| 2.4 | Optional: `POST /api/v1/competitive/win-loss/seed-demo` | Demo deals if empty (dev helper) |
| 2.5 | `GET /api/v1/regional-tam-gate` | Gate reflects deal count (≥4 unlocks regional TAM) |

**Pass when:** At least one deal readable; regional gate returns structured status.

---

## §3 — Product principles / regional gate

| # | Step | Expected |
|---|------|----------|
| 3.1 | `GET /api/v1/regional-intel/gate` | Gate status JSON |
| 3.2 | `POST /api/v1/regional-intel` with a region/purpose | Brief **or** clear gate block if &lt;4 win/loss deals |
| 3.3 | After ≥4 deals, retry regional intel | Brief succeeds |

---

## §5 — Canonical model / Evidence Ledger

**APIs:** `/api/v1/evidence*`, CRM autofill from ledger

| # | Step | Expected |
|---|------|----------|
| 5.1 | `POST /api/v1/evidence` with attribute + value + source | Evidence row created |
| 5.2 | `GET /api/v1/evidence?…` | Latest / filtered evidence returned |
| 5.3 | Enrich a prospect (UI or `POST /prospects/:id/enrich`) | Job completes; evidence written |
| 5.4 | Edit a CRM contact field that has ledger evidence | Autofill / precedence respects ledger (manual wins) |

---

## §5.3 / Email-Intel → Evidence

| # | Step | Expected |
|---|------|----------|
| 5.3.1 | `POST /api/v1/email-intel/verify` with an email | Verification payload |
| 5.3.2 | Confirm Email-Intel forwarder path (ops) hits `POST /evidence/ingest/email-intel` | Ingest accepted when token valid |

---

## §7 — Platform plane

| # | Step | Expected |
|---|------|----------|
| 7.1 | Authenticated `GET /api/v1/me` | User + workspace context |
| 7.2 | Call any workspace-scoped API | Uses workspace tenancy (no cross-tenant data) |

---

## §8.1 — Onboarding

**UI:** `/onboarding`

| # | Step | Expected |
|---|------|----------|
| 8.1.1 | Open `/onboarding` as new or existing user | Wizard loads |
| 8.1.2 | Complete ICP / workspace basics | Saved; can open Discover |

---

## §8.2 — Discover / TAM / search

**UI:** `/tam`, `/prospects/search`

| # | Step | Expected |
|---|------|----------|
| 8.2.1 | Open TAM / search | Results or empty state (no 5xx) |
| 8.2.2 | Run a search / add to list | Prospect or list updates |

---

## §8.3 — Enrichment workbooks

**UI:** `/enrichment/workbooks`

| # | Step | Expected |
|---|------|----------|
| 8.3.1 | Create workbook | Appears in list |
| 8.3.2 | Activate + start a run | Run status progresses |
| 8.3.3 | Open run detail | Rows / errors visible |

---

## §8.4 — Account / Person 360

**UI:** `/crm/360`  
**APIs:** `/api/v1/account-360/:companyId`, `/api/v1/person-360/:contactId`

| # | Step | Expected |
|---|------|----------|
| 8.4.1 | Copy a company UUID from CRM | |
| 8.4.2 | Open `/crm/360` → load company | Deals, timeline, signals compose |
| 8.4.3 | Switch to Person → contact UUID | Person 360 loads |

---

## §8.5 — Signals

**UI:** `/signals`

| # | Step | Expected |
|---|------|----------|
| 8.5.1 | Open Signals | Feed or empty state |
| 8.5.2 | Open one signal | Detail without 5xx |

---

## §8.6 — Sequence Studio

**UI:** `/sequences`

| # | Step | Expected |
|---|------|----------|
| 8.6.1 | Create sequence | Saved |
| 8.6.2 | Add step(s) + enroll a contact | Enrollment created |
| 8.6.3 | Check enrollments / analytics | Counts update |

---

## §8.7 — Dexter + Policy Gateway

**UI:** `/dexter`, `/settings/automation-policy`  
**APIs:** `/api/v1/dexter/plans*`, `/automation-policy`, `/policy/*`

| # | Step | Expected |
|---|------|----------|
| 8.7.1 | Open Policy Gateway settings | Modes ask/auto/draft/approve listed |
| 8.7.2 | `PUT /automation-policy` change one action | Persists on `GET` |
| 8.7.3 | Open `/dexter` → propose plan | Plan created (pending approve) |
| 8.7.4 | Approve plan → Invoke | Invoke blocked until approve; then succeeds via gateway |
| 8.7.5 | Record learn outcome | Plan learning recorded |
| 8.7.6 | `GET /policy/decisions` | Audit entries present |

---

## §8.8 — LinkedIn (Unipile)

**UI:** Deliverability / LinkedIn connect · inbox LI surfaces

| # | Step | Expected |
|---|------|----------|
| 8.8.1 | Open LinkedIn connect UI | Hosted auth or account list |
| 8.8.2 | Connect account (if Unipile secrets set) | Account active |
| 8.8.3 | Sequence with LinkedIn step → enroll | Job queued / sent or clear `unipile_not_configured` |

---

## §8.9 — Chrome companion

**Package:** `apps/chrome-extension` / `skout-extension-v0.8.1.zip`

| # | Step | Expected |
|---|------|----------|
| 8.9.1 | Load unpacked `store-build` or zip | Extension installs |
| 8.9.2 | Sign in on Skout web → Connect in side panel | Signed-in identity |
| 8.9.3 | LinkedIn `/in/…` → Add to list | Contact appears in Skout list |

---

## §8.10 — Email intel / deliverability

**UI:** `/intelligence/email`, `/warmup`

| # | Step | Expected |
|---|------|----------|
| 8.10.1 | Verify an email in UI or API | Result + reason codes |
| 8.10.2 | Open Warm-Up UI | Status page loads (OAuth connect may be Sailesh-blocked) |

---

## §8.11 — Numbers / voice

**UI:** `/settings/calling`

| # | Step | Expected |
|---|------|----------|
| 8.11.1 | Open Calling settings | Page loads |
| 8.11.2 | If Telnyx configured: click-to-call on a contact | Bridge dial initiated |
| 8.11.3 | If not configured | Clear “not configured” message (not 5xx) |

---

## §8.12 — CRM Intelligence / HubSpot

**UI:** `/crm/intelligence`

| # | Step | Expected |
|---|------|----------|
| 8.12.1 | Open CRM Intelligence | Views load |
| 8.12.2 | HubSpot connect (if creds) | Connection listed under `/crm/connections` |
| 8.12.3 | `POST /crm/hubspot/sync-native` | Sync summary (contacts/deals) |

---

## §8.13 — AI command bar / copilots

**UI:** Dexter chat FAB · `/admin/cro`

| # | Step | Expected |
|---|------|----------|
| 8.13.1 | Open chat FAB → ask a workspace question | Reply streams / returns |
| 8.13.2 | Open CRO admin | Forecast / board views load |

---

## §8.14 — Automation / workflows / policy

**UI:** `/workflows`, activation rules, `/settings/automation-policy`

| # | Step | Expected |
|---|------|----------|
| 8.14.1 | `POST /workflows/runs` (e.g. enrich/score style) | Run `running` |
| 8.14.2 | `POST /workflows/runs/:id/complete` | Run `completed` |
| 8.14.3 | Open `/workflows` UI | Runs listed |

---

## §8.15 — Reporting / GTM learning

**UI:** `/admin/cro`, reporting surfaces

| # | Step | Expected |
|---|------|----------|
| 8.15.1 | Open CRO / reporting | Charts or empty states |
| 8.15.2 | Dexter learn step (8.7.5) visible in learning trail | Outcome stored |

---

## §10 — Cross-domain journeys / decision views

**UI:** `/decisions`  
**APIs:** `/api/v1/decisions*`

| # | Step | Expected |
|---|------|----------|
| 10.1 | `POST /decisions/from-nba` (or create from UI) | Decision created |
| 10.2 | Open `/decisions` | Queue shows item |
| 10.3 | Decide or dismiss | Status updates |
| 10.4 | LinkedIn voice (if used): `POST /linkedin/voice/*` | Draft / approve path works |

---

## §11.1 — Security / tenancy / SSO

| # | Step | Expected |
|---|------|----------|
| 11.1.1 | Confirm RBAC: member without permission hits restricted CRM write | `403` (fail-closed) |
| 11.1.2 | Owner can invite (`POST /team/invites`) | `201` |
| 11.1.3 | Consent: `POST /consents` + enroll path | Consent enforced when flag on |
| 11.1.4 | `GET /api/v1/sso/stage6/status` | `platformReady: true` |
| 11.1.5 | `PUT /sso/workspaces/current` with clerkOrgId + idpProvider | Binding saved |
| 11.1.6 | `POST /sso/workspaces/current/activate` | Status active |
| 11.1.7 | `POST /sso/scim/sync-members` with `dryRun: true` | Preview roles; no crash |

---

## §11.2 / §11.3 — SLOs + journey metrics

| # | Step | Expected |
|---|------|----------|
| 11.2.1 | `GET /api/v1/slo` | Matches `docs/slo-targets.md` |
| 11.3.1 | `GET /api/v1/metrics` | Journey counters present after journey traffic |

---

## §13.2 / §16 — Reconciliation / missing areas (docs)

| # | Step | Expected |
|---|------|----------|
| 13.2.1 | Open `docs/reconciliation-matrix.md` | Matrix current |
| 16.1 | Open `docs/missing-areas-triage.md` | Triage recorded |

---

## External (not eng-complete — skip or note)

| Item | How to note |
|------|-------------|
| GTM ≥4 **real** win/loss deals | Enter via §2 until count ≥4 |
| Warm-Up Google/Microsoft OAuth | Blocked on Sailesh app credentials |
| Chrome Web Store publisher submit | Package ready; optional Product click |
| Customer IdP metadata in Clerk | Deal-time ops; APIs already tested in §11.1 |

---

## Sign-off

| Tester | Date | Overall |
|--------|------|---------|
| | | Pass / Fail / Partial |

**Related:** `docs/neeraj-task-list-status.md` · `docs/section-8-domains-status.md` · `docs/ops/skoutdev-is-production.md`
