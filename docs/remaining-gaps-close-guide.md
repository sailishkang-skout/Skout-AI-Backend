# Remaining enterprise gaps — status after Untitled-2 decisions (2026-08-25)

| # | Item | Decision applied | Status |
|---|------|------------------|--------|
| 1 | §2 Competitive | Why documented; due **2026-09-09**; owner = logged-in workspace via `POST /competitive/win-loss/assign` | **Process closed**; deals still need CRM paste |
| 4 | SSO/SCIM | Stage-6 via Clerk; checklist waiting plan/IdP confirmation | **Blocked on Clerk Enterprise + IdP** |
| 5 | Fail-closed RBAC | Local ON; backfill needs documented below | **Local done**; SkoutDev/prod await approve |
| 6 | Consent | Capture UI + enroll `consentBasis`; flag ON locally | **Local done** |
| 7 | Datadog SLO | Import JSON + `DD_*` agent vars | **Artifacts ready**; needs Datadog key/access |
| 8 | OTel | Local collector + `OTEL_EXPORTER_OTLP_ENDPOINT` | **Local done**; prod endpoint TBD |
| 9 | Email-Intel forwarder | Auth path for ingest + env recipe | **Enable when you set URL+token** |
| 10 | Warm-Up OAuth | Exact key names documented | **Blocked on secrets from Sailesh** |
| 11–12 | i18n / territory | Onboarding HQ+locale; `POST /regional-intel` LLM | **Shipped** |
| 13 | DSAR | `manual` \| `auto` + 30-day SLA | **Shipped** |
| 14 | Encryption rotation | 90-day Tier-1 policy (already) + runbook | **Policy closed**; prod window TBD |

## What RBAC backfill needs (item 5)

`pnpm --filter @skout/db backfill-rbac` reads existing:

| Source table | Uses |
|--------------|------|
| `workspaces` | Creates matching `tenants` + `tenant_workspaces` |
| `workspace_members` (`workspaceId`, `userId`, `role`) | Maps role text → system `owner`/`admin`/`member` grants in `workspace_member_roles` |

Also seeds `permissions`, `roles`, `role_permissions` catalogs. **Does not need** new CSV uploads — only a migrated DB with members already present.

## Warm-Up OAuth keys required (item 10)

| Env var | Provider |
|---------|----------|
| `GOOGLE_CLIENT_ID` | Google |
| `GOOGLE_CLIENT_SECRET` | Google |
| `GOOGLE_REDIRECT_URI` | e.g. `https://<warmup-host>/api/v1/oauth/google/callback` |
| `MICROSOFT_CLIENT_ID` | Microsoft |
| `MICROSOFT_CLIENT_SECRET` | Microsoft |
| `MICROSOFT_REDIRECT_URI` | e.g. `https://<warmup-host>/api/v1/oauth/microsoft/callback` |

Inject on **Warm-Up ECS**, not Deliverability.

## Email-Intel forwarder enable (item 9)

On API: set `EMAIL_INTEL_EXTERNAL_API_KEY` + `EVIDENCE_INGEST_DEFAULT_WORKSPACE_ID=<uuid>`.

On Email-Intel service:
```bash
SKOUT_CANONICAL_EVIDENCE_URL=https://<api-host>
SKOUT_CANONICAL_EVIDENCE_TOKEN=<same as EMAIL_INTEL_EXTERNAL_API_KEY>
# Optional per-request: header x-skout-workspace-id
```

Drop of Email-Intel’s own ledger table = later (approved deferred).
