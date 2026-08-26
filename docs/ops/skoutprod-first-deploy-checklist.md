# SkoutProd — first deploy checklist

Run when the **SkoutProd** ECS cluster exists (CDK already wires prod RBAC + consent flags).

## 1. RBAC fail-closed backfill

```bash
./scripts/ecs-run-backfill-rbac.sh SkoutProd
```

Verify: `RBAC_ENFORCEMENT_ENABLED=true` on API + CRM task definitions (CDK prod profile).

## 2. Email-Intel → canonical Evidence Ledger forwarder

```bash
./infra/scripts/setup-email-intel-forwarder.sh SkoutProd <CANONICAL_EVIDENCE_INGEST_URL>
```

Token: AWS Secrets Manager key documented in `docs/ops/email-intel-forwarder.md`.

## 3. Consent enforcement

Confirm `CONSENT_ENFORCEMENT_ENABLED=true` on SkoutProd API (CDK prod ON per `enterprise-remaining-owners-ask.md`).

## 4. Encryption rotation

Repeat Tier-1 rotation per `docs/secrets-rotation-policy.md` (90-day window) or at first prod cutover.

## 5. Smoke

- `GET /api/v1/health` + `GET /api/v1/slo`
- One authenticated CRM CRUD with fine-grained permission
- Datadog dashboard `tr2-pbk-y85` receiving prod series

**Owner:** Neeraj (Ops/SRE)  
**Status:** Blocked until SkoutProd cluster exists — scripts and CDK flags are ready.
