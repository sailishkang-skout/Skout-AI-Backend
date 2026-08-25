# Enterprise completion — remaining items & owners

**Purpose:** Close Neeraj’s Enterprise Completion Plan at **enterprise end-to-end** level (not only Wave‑1 code).  
**Audience:** Management, Product/GTM, Legal, Ops/SRE, Platform.  
**Prepared:** 2026-08-25  
**Status:** SkoutDev fully activated (2026-08-26). SkoutProd stack not deployed yet — prod CDK flags wired; run same scripts on first SkoutProd.

---

## Remaining checklist

| # | Remaining item | Why it matters | Needed (exact ask) | From whom | Decision / value | Due |
|---|----------------|----------------|--------------------|-----------|------------------|-----|
| 1 | Competitive win/loss (§2) | Validates regional / evidence positioning before more build or marketing | Fill ≥4 real won/lost deals (competitors + differentiator) **or** name GTM owner | Product / GTM | | 2026-09-09 |
| 2 | Email-Intel → single Evidence Ledger | One source of truth for evidence; no parallel ledger | Forwarder URL/token on Email-Intel + API | Platform | **Complete on SkoutDev 2026-08-25** — secret + ECS patched. **Prod:** CDK wired; run `setup-email-intel-forwarder.sh SkoutProd <url>` when SkoutProd exists. | 2026-08-25 (dev) |
| 3 | Fail-closed RBAC (SkoutDev) | Permissions enforced for real users | Backfill + flag | Eng + Ops | **Complete 2026-08-25** — 14 grants; API `:173` + CRM `:88`. | 2026-08-25 |
| 4 | Fail-closed RBAC (Production) | Same for customers | Backfill + flag | Leadership | **Active on SkoutDev; CDK `prod` ON.** Run `./scripts/ecs-run-backfill-rbac.sh SkoutProd` on first prod cluster. | CDK ready |
| 5 | Consent enforcement (Production) | Lawful basis before enroll | Flag on prod | Product + Leadership | **Active on SkoutDev API `:173`** (`CONSENT_ENFORCEMENT_ENABLED=true`). CDK `prod` ON. | 2026-08-26 |
| 6 | SSO / SAML / SCIM (Stage-6) | Enterprise login + directory sync | Clerk + IdP + group map | Platform | **Platform gate removed 2026-08-26** — default group→role map in `docs/ops/sso-stage6-checklist.md`. Per-customer IdP = Clerk Dashboard at deal time. | 2026-08-26 |
| 7 | Live SLO dashboards + paging | Burn alerts | Datadog + on-call | Ops | **Complete 2026-08-25** — [dashboard tr2-pbk-y85](https://app.us5.datadoghq.com/dashboard/tr2-pbk-y85); on-call Neeraj. | 2026-08-25 |
| 8 | OpenTelemetry in deployed envs | Tracing sink | OTLP endpoint | Ops | **Closed** — Datadog APM on ECS. | |
| 9 | Warm-Up Google Connect | Mailbox OAuth | Google app creds | Sailesh | | |
| 10 | Warm-Up Microsoft Connect | M365 OAuth | Microsoft app creds | Sailesh | | |
| 11 | Stage-0 audit owners sign-off | Formal ownership | Sign matrix | CEO / Eng director | **Signed 2026-08-25** | 2026-08-25 |
| 12 | DSAR legal process owner | Fulfill requests | Name owner | Legal | **Neeraj interim** until Legal/DPO hired. | 2026-08-25 |
| 13 | Integration encryption key rotation | 90-day Tier‑1 policy | Maintenance window + rotate | Ops + Leadership | **Executed on SkoutDev 2026-08-26** — 9 rows re-encrypted; PREVIOUS cleared. Repeat on SkoutProd at deploy or next 90-day window. | 2026-08-26 |

---

## Still open (honest E2E)

1. **#1** — GTM win/loss (≥4 deals or owner) by 2026-09-09  
2. **#9–#10** — Warm-Up OAuth secrets (Sailesh)  
3. **SkoutProd** — cluster does not exist yet; when deployed, run forwarder setup + RBAC backfill (flags already in CDK)

---

## Sign-off

| Role | Name | Date | Notes |
|------|------|------|-------|
| Eng lead | Neeraj | 2026-08-26 | SkoutDev gates activated: RBAC, consent, encryption rotation, forwarder |
| Ops / SRE | Neeraj | 2026-08-26 | Encryption rotated; Datadog on-call |
| Leadership | Go-ahead | 2026-08-25 | Prod RBAC + consent approved in CDK |
