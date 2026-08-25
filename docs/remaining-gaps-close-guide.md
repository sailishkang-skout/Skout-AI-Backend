# Remaining enterprise gaps — status (2026-08-26)

| # | Item | Status |
|---|------|--------|
| 1 | §2 Competitive win/loss | **Open** — due 2026-09-09 |
| 2 | Email-Intel forwarder | **SkoutDev live**; prod script when SkoutProd exists |
| 4 | SSO/SCIM | **Platform defaults active** — per-customer IdP in Clerk |
| 5 | Fail-closed RBAC | **SkoutDev live** (API `:173`, CRM `:88`); prod CDK ON |
| 6 | Consent | **SkoutDev live** on API `:173`; prod CDK ON |
| 7 | Datadog SLO | **Live** — `tr2-pbk-y85` |
| 8 | OTel | **Closed** — Datadog APM |
| 9–10 | Warm-Up OAuth | **Blocked** — Sailesh secrets |
| 11–12 | i18n / territory | **Shipped** |
| 13 | DSAR | **Shipped**; owner Neeraj |
| 14 | Encryption rotation | **Executed SkoutDev 2026-08-26** (9 rows); PREVIOUS cleared |

**SkoutProd:** not deployed. CDK has prod RBAC + consent flags; run forwarder + backfill on first prod deploy.
