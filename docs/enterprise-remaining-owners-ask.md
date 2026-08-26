# Enterprise completion — remaining items & owners

**Purpose:** Close Neeraj’s Enterprise Completion Plan at **enterprise end-to-end** level (not only Wave‑1 code).  
**Audience:** Management, Product/GTM, Legal, Ops/SRE, Platform.  
**Prepared:** 2026-08-25 · **Updated:** 2026-08-26  
**Status:** SkoutDev fully activated. Engineering closeout for §2/§3/§5/§7/§10/§11.2/§13.2/§16 docs + APIs shipped 2026-08-26. SkoutProd stack not deployed yet.

---

## Remaining checklist

| # | Remaining item | Why it matters | Needed (exact ask) | From whom | Decision / value | Due |
|---|----------------|----------------|--------------------|-----------|------------------|-----|
| 1 | Competitive win/loss (§2) | Validates regional / evidence positioning | **API + DB ready.** Enter ≥4 real deals via `POST /competitive/win-loss/deals` **or** assign owner via `/assign` | Product / GTM | Engineering complete 2026-08-26 | 2026-09-09 |
| 2 | Email-Intel → single Evidence Ledger | One source of truth for evidence | Forwarder URL/token on Email-Intel + API | Platform | **Complete on SkoutDev 2026-08-25** — Wave 2 autofill precedence in progress | 2026-08-25 (dev) |
| 3 | Fail-closed RBAC (SkoutDev) | Permissions enforced for real users | Backfill + flag | Eng + Ops | **Complete 2026-08-25** | 2026-08-25 |
| 4 | Fail-closed RBAC (Production) | Same for customers | Backfill + flag | Leadership | CDK `prod` ON. Run `./scripts/ecs-run-backfill-rbac.sh SkoutProd` — see `docs/ops/skoutprod-first-deploy-checklist.md` | First prod deploy |
| 5 | Consent enforcement (Production) | Lawful basis before enroll | Flag on prod | Product + Leadership | **SkoutDev live**; CDK `prod` ON | 2026-08-26 |
| 6 | SSO / SAML / SCIM (Stage-6) | Enterprise login + directory sync | Per-customer IdP in Clerk Dashboard | Platform | **Platform defaults active 2026-08-26** — `docs/ops/sso-stage6-checklist.md` | At deal time |
| 7 | Live SLO dashboards + paging | Burn alerts | Datadog + on-call | Ops | **Complete 2026-08-25** — [dashboard tr2-pbk-y85](https://app.us5.datadoghq.com/dashboard/tr2-pbk-y85) | 2026-08-25 |
| 8 | OpenTelemetry in deployed envs | Tracing sink | OTLP endpoint | Ops | **Closed** — Datadog APM on ECS | |
| 9 | Warm-Up Google Connect | Mailbox OAuth | Google app creds | Sailesh | | |
| 10 | Warm-Up Microsoft Connect | M365 OAuth | Microsoft app creds | Sailesh | | |
| 11 | Stage-0 audit owners sign-off | Formal ownership | Sign matrix | CEO / Eng director | **Signed 2026-08-25** | 2026-08-25 |
| 12 | DSAR legal process owner | Fulfill requests | Name owner | Legal | **Neeraj interim** | 2026-08-25 |
| 13 | Integration encryption key rotation | 90-day Tier‑1 policy | Maintenance window + rotate | Ops + Leadership | **Executed SkoutDev 2026-08-26** | Repeat on SkoutProd at deploy |

---

## Engineering closed 2026-08-26 (Neeraj scope)

| § | Item | Artifact |
|---|---|---|
| 2 | Win/loss | `competitive_win_loss_*` + `/api/v1/competitive/win-loss*` |
| 3 | Product principles | architecture-review-checklist (8/8 hooks) |
| 5 | Canonical operating model | `docs/api-crm-internal-contract.md` + `/internal/v1` |
| 5.3 | Evidence Ledger Wave 2 | ledger SoT autofill; call-note dual-write; NBA stats |
| 7 | Platform plane | `loadPlatformContext` + `docs/platform-plane.md` |
| 8.12 | HubSpot bi-di | webhook + deal sync — ADR 0009 |
| 10 | Cross-domain journeys | journeys.e2e J8–J14 + journey metrics |
| 11.2 | SLOs locked | `docs/slo-targets.md` + `GET /api/v1/slo` |
| 11.3 | Journey metrics | `skout_journey_*` on `/metrics` |
| 13.2 | Reconciliation matrix | `docs/reconciliation-matrix.md` |
| 16 | Missing areas | `docs/missing-areas-triage.md` |
| 11.1 | SSO/SCIM | Platform gate removed; per-customer = Clerk at deal time |
| SkoutProd | RBAC + forwarder | `docs/ops/skoutprod-first-deploy-checklist.md` |
| 1.2 / 10 / 3 | Policy Gateway, decisions, workflows, §10 HTTP, regional gate | Wave 3 2026-08-26 — migration 0069 + `dexter-platform.e2e.test.ts` |

**Not Neeraj’s (Aditya/Shailpreet):** §8.1–8.11, §8.13–8.15 product domains.

---

## Still open (honest E2E)

1. **#1** — GTM ≥4 **production** win/loss deals by 2026-09-09  
2. **#9–#10** — Warm-Up OAuth secrets (Sailesh)  
3. **SkoutProd first deploy** — needs `AWS_DEPLOY_ROLE_ARN_PROD` + secrets (checklist + SSO APIs ready)  
4. **Telnyx number marketplace KYC** (§8.11 residual)

§8 domains + Dexter/decision/workflow UIs + Account 360 + SSO stage-6 APIs: **eng-complete** 2026-08-26.

---

## Sign-off

| Role | Name | Date | Notes |
|------|------|------|-------|
| Eng lead | Neeraj | 2026-08-26 | Wave 3: Policy Gateway, decisions, workflows, §10 HTTP E2E, regional gate |
| Ops / SRE | Neeraj | 2026-08-26 | SLO targets locked; SkoutProd checklist ready |
