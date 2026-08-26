# SkoutProd — first deploy checklist

Run when leadership is ready to create the **SkoutProd** ECS cluster (CDK `env=prod`).

## 0. Prerequisites (cannot invent)

- [ ] GitHub `production` environment + `AWS_DEPLOY_ROLE_ARN_PROD` OIDC role
- [ ] Secrets Manager / env: DB, Redis, Clerk, OpenRouter, Datadog, etc.
- [ ] Optional: `PROD_DOMAIN_NAME` for custom domains

## 1. Deploy stack

```bash
# Preferred: GitHub Actions → Deploy Production (workflow_dispatch on main)
# Or local (requires prod AWS role):
cd infra && pnpm deploy:prod
```

## 2. RBAC fail-closed backfill

```bash
./scripts/ecs-run-backfill-rbac.sh SkoutProd
```

Verify: `RBAC_ENFORCEMENT_ENABLED=true` on API + CRM (CDK prod profile).

## 3. Email-Intel → Evidence Ledger forwarder

```bash
./infra/scripts/setup-email-intel-forwarder.sh SkoutProd <CANONICAL_EVIDENCE_INGEST_URL>
```

## 4. Consent enforcement

Confirm `CONSENT_ENFORCEMENT_ENABLED=true` on SkoutProd API.

## 5. SSO / SCIM (Stage-6) — per customer

Platform endpoints live: `GET /api/v1/sso/stage6/status`, `POST /api/v1/sso/scim/sync-members`.

Per-customer IdP bind remains **Clerk Dashboard at deal time** — see `docs/ops/sso-stage6-checklist.md`.

## 6. Encryption rotation

Repeat Tier-1 rotation per `docs/secrets-rotation-policy.md`.

## 7. Smoke

- `GET /api/v1/health` + `GET /api/v1/slo`
- `GET /api/v1/sso/stage6/status`
- One authenticated CRM CRUD with fine-grained permission
- Datadog dashboard receiving prod series

**Owner:** Neeraj (Ops/SRE)  
**Status:** Engineering ready — **blocked only on AWS prod role/secrets + first `deploy-prod` run**.
