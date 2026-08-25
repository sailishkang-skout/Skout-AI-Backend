# Enterprise completion — remaining items & owners

**Purpose:** Close Neeraj’s Enterprise Completion Plan at **enterprise end-to-end** level (not only Wave‑1 code).  
**Audience:** Management, Product/GTM, Legal, Ops/SRE, Platform.  
**Prepared:** 2026-08-25  
**Status:** Engineering buildable work is largely complete; items below need decisions, credentials, or named owners.

---

## How to use this doc

1. Each row is **still required** for an honest “enterprise complete” claim.  
2. **Owner** = who must decide or deliver.  
3. **Engineering** can execute once the “Needed” column is filled.  
4. Reply in the **Decision / value** column (or attach answers in email/Slack).

---

## Remaining checklist

| # | Remaining item | Why it matters | Needed (exact ask) | From whom | Decision / value | Due |
|---|----------------|----------------|--------------------|-----------|------------------|-----|
| 1 | Competitive win/loss (§2) | Validates regional / evidence positioning before more build or marketing | Fill ≥4 real won/lost deals (competitors + differentiator) **or** name GTM owner | Product / GTM | | 2026-09-09 |
| 2 | Email-Intel → single Evidence Ledger | One source of truth for evidence; no parallel ledger | **Local done** (secret + smoke 201). SkoutDev/prod: set same URL/token on Email-Intel ECS + API key/workspace. Drop old table later | Platform / you for AWS secrets | **SkoutDev done 2026-08-25** — `SkoutDev/email-intel-forwarder` set (shared token + URL `https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com`); IAM granted; API + Email-Intel ECS patched. **Prod:** no `SkoutProd` stack yet — run `infra/scripts/setup-email-intel-forwarder.sh SkoutProd <api-url>` on first prod deploy. Drop old table later (Product sign-off). | Staging done; prod on first SkoutProd |
| 3 | Fail-closed RBAC (SkoutDev) | Permissions enforced for real users, not only local | Approve yes/no; run backfill; set `RBAC_ENFORCEMENT_ENABLED=true` | Eng lead + Ops | **Complete 2026-08-25** — Yes. Backfill: 14 tenants / 14 member grants. `RBAC_ENFORCEMENT_ENABLED=true` on SkoutDev API `:171` + CRM `:86`. | 2026-08-25 |
| 4 | Fail-closed RBAC (Production) | Same as above for customers | Approve yes/no; backfill; set flag | Eng lead + Ops + Leadership | **Yes approved 2026-08-25.** CDK sets `RBAC_ENFORCEMENT_ENABLED=true` for `prod`. **Execute on first SkoutProd deploy:** `./scripts/ecs-run-backfill-rbac.sh SkoutProd` then bring API up (flag already in CDK). No SkoutProd cluster yet. | First SkoutProd deploy |
| 5 | Consent enforcement (Production) | Lawful basis recorded before sequence enroll | Approve `CONSENT_ENFORCEMENT_ENABLED=true` on prod (yes/no) | Product + Compliance / Leadership | **Yes approved 2026-08-25.** CDK sets `CONSENT_ENFORCEMENT_ENABLED=true` for `prod` (+ SkoutDev parity). Live when SkoutProd deploys. | First SkoutProd deploy |
| 6 | SSO / SAML / SCIM (Stage-6) | Enterprise login + directory sync | (a) Clerk Enterprise includes SSO+SCIM? (b) First IdP name (c) Group → `owner`/`admin`/`member` map | Leadership + Platform + first customer IT | **(a) Yes** — Clerk Enterprise includes SSO + SCIM. **(b)(c)** Deferred until first enterprise SSO deal: IdP name + group → `owner`/`admin`/`member` map from customer IT. Execute `docs/ops/sso-stage6-checklist.md` then. | When first enterprise SSO deal needs it |
| 7 | Live SLO dashboards + paging | Targets exist in code; no live burn alerts without Datadog | Datadog access or `DD_API_KEY` + import dashboard; name on-call owner | Ops / SRE | **Complete 2026-08-25** — On-call: Neeraj. Dashboard imported via API: [Skout API SLO — starter](https://app.us5.datadoghq.com/dashboard/tr2-pbk-y85) (`tr2-pbk-y85`). | 2026-08-25 |
| 8 | OpenTelemetry in deployed envs | Local tracing works; staging/prod need a sink | Per-env `OTEL_EXPORTER_OTLP_ENDPOINT` (+ headers if required) | Ops / Platform | **Defer OTel sink** — use **Datadog APM** (`DD_API_KEY` on ECS) as the deployed tracing path. No separate OTLP collector required. Local OTel optional for dev only. | |
| 9 | Warm-Up Google Connect | Mailbox OAuth cannot complete without app credentials | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` on Warm-Up ECS | Sailesh / Platform | | |
| 10 | Warm-Up Microsoft Connect | Same for M365 | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI` on Warm-Up ECS | Sailesh / Platform | | |
| 11 | Stage-0 audit owners sign-off (§13/§18) | Formal ownership, not interim names only | Sign owner matrix + backup names + dates | CEO / Eng director | **Signed 2026-08-25** — matrix in `docs/templates/stage0-audit-owners.md` accepted (owner Neeraj; backups + due dates as listed). | 2026-08-25 |
| 12 | DSAR legal process owner (§16) | Intake API exists; someone must fulfill real requests | Name Legal / DPO / privacy owner (SLA = 30 days) | Legal / Leadership | **Neeraj (Lead)** named privacy/DSAR process owner (SLA = 30 days). Hand off to hired Legal/DPO when available; until then Eng Lead fulfills via `docs/ops/dsar-fulfillment.md`. | 2026-08-25 |
| 13 | Integration encryption key rotation (prod) | 90-day Tier‑1 policy; script ready; prod window not run | Approve maintenance window + old/new keys for that env | Ops + Leadership | **Window approved** for target **2026-11-23**. Ops generates new key at window; set `INTEGRATION_ENCRYPTION_KEY_PREVIOUS` = current, then new current; redeploy; run rotate script (`docs/ops/encryption-key-rotation.md`). | Target 2026-11-23 |

---

## By role (who owes what)

### Leadership / CEO / Eng director
- [#4] ~~Prod RBAC yes/no~~ **approved** — execute on first SkoutProd  
- [#5] ~~Prod consent yes/no~~ **approved** — CDK wired for prod  
- [#6] ~~Clerk Enterprise SSO+SCIM~~ **done (yes)**; go/no-go + IdP when first SSO deal  
- [#11] ~~Sign audit owners matrix~~ **done (2026-08-25)**  
- [#12] ~~Assign Legal/DPO for DSAR~~ **done** — Neeraj until Legal/DPO hired  
- [#13] ~~Approve encryption rotation window~~ **done** — target 2026-11-23; Ops executes then  

### Product / GTM
- [#1] Win/loss deals or named owner  
- [#5] ~~Consent enforcement product readiness~~ **approved for prod**  

### Platform / Sailesh / Infra
- [#2] ~~Email-Intel forwarder env (SkoutDev)~~ **done**; prod on first SkoutProd  
- [#6] Clerk plan confirmed (SSO+SCIM); IdP wiring when first SSO deal lands  
- [#8] ~~OTel endpoints~~ **deferred** — Datadog APM covers deployed tracing  
- [#9][#10] Warm-Up Google + Microsoft OAuth secrets  

### Ops / SRE
- [#3] ~~RBAC SkoutDev~~ **done**  
- [#4] Prod RBAC backfill on first SkoutProd  
- [#7] ~~On-call named (Neeraj)~~; ~~SLO dashboard imported~~ (`tr2-pbk-y85`)  
- [#8] ~~OTel collector~~ **deferred** (Datadog APM)  
- [#13] Execute key rotation in the approved window  

### Legal / Privacy
- [#12] Own DSAR fulfillment process — **Neeraj (interim Legal/privacy)** until dedicated Legal/DPO hired  

### Engineering (already ready to execute once above is filled)
- ~~Run `backfill-rbac` and flip flags (SkoutDev)~~ **done**  
- ~~Wire Email-Intel forwarder (SkoutDev)~~ **done**  
- Import Datadog dashboard JSON (UI or with `DD_APP_KEY`)  
- Execute SSO Stage-6 checklist once Clerk + IdP confirmed  
- Deploy Warm-Up secrets once provided  
- Run encryption rotation script in the approved window  
- On first SkoutProd: forwarder script + RBAC backfill (flags already in CDK)  

---

## What is *not* remaining as “missing Backend features”

These are already in code / process for Wave‑1 (local or repo):

- Canonical entities, Evidence Ledger APIs, AI claim pinning  
- CRM Intelligence rename + BuyingCommittee  
- Consent capture UI + enroll `consentBasis` (local enforce on)  
- DSAR intake + auto/manual modes + 30-day SLA fields  
- Journey E2E contracts, DoD PR checklist, ADRs  
- Regional onboarding location + LLM regional brief API  
- RBAC fail-closed **locally** + **SkoutDev**  
- OTel **local** collector  

Enterprise E2E = **activate and staff** the rows in the checklist above.

---

## Related artifacts

| Artifact | Path |
|----------|------|
| This tracker (ops) | `docs/remaining-gaps-close-guide.md` |
| Win/loss template | `docs/templates/competitive-win-loss.md` |
| Audit owners template | `docs/templates/stage0-audit-owners.md` |
| SSO checklist | `docs/ops/sso-stage6-checklist.md` |
| RBAC enable | `docs/ops/rbac-fail-closed.md` |
| Email-Intel forwarder | `docs/ops/email-intel-forwarder.md` |
| Datadog / OTel | `docs/ops/datadog-slo-import.md` |
| Warm-Up OAuth keys | `docs/ops/warmup-oauth-secrets.md` |
| DSAR runbook | `docs/ops/dsar-fulfillment.md` |
| Encryption rotation | `docs/ops/encryption-key-rotation.md` |

---

## Sign-off

| Role | Name | Date | Notes |
|------|------|------|-------|
| Eng lead | Neeraj | 2026-08-25 | SkoutDev RBAC + Email-Intel forwarder executed; owns DSAR + Datadog on-call until handoff |
| Product | | | Confirms §2; consent approved for prod |
| Ops / SRE | Neeraj (interim on-call) | 2026-08-25 | Datadog on-call; imports SLO dashboard via UI; executes encryption rotation on 2026-11-23 |
| Legal | Neeraj (interim) | 2026-08-25 | DSAR owner until dedicated Legal/DPO named |
| Leadership | Go-ahead (workspace) | 2026-08-25 | Audit matrix signed; DSAR owner named; encryption window approved (~2026-11-23); prod RBAC + consent approved |

**Definition of done for this doc:** every row in the checklist has a filled **Decision / value** (or explicit “defer with date”), and Engineering has executed the corresponding activation steps in the target environments.
