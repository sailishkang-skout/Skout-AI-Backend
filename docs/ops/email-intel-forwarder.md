# Email-Intel → canonical Evidence Ledger

## Enable forwarder (drop old table later — approved)

### API (Backend)
```bash
EMAIL_INTEL_EXTERNAL_API_KEY=<shared-secret>
EVIDENCE_INGEST_DEFAULT_WORKSPACE_ID=<workspace-uuid>
```
Ingest route: `POST /api/v1/evidence/ingest/email-intel`  
Optional header: `x-skout-workspace-id: <uuid>`

### Email-Intel service
```bash
SKOUT_CANONICAL_EVIDENCE_URL=http://host.docker.internal:3001   # or https://api...
SKOUT_CANONICAL_EVIDENCE_TOKEN=<same shared-secret as EMAIL_INTEL_EXTERNAL_API_KEY>
```

### SkoutDev (done 2026-08-25)
```bash
./infra/scripts/setup-email-intel-forwarder.sh SkoutDev https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com
python3 ./infra/scripts/patch-ecs-email-intel-forwarder.py SkoutDev
# IAM: EmailIntelForwarderSecretRead on API + Email-Intel execution roles (also in CDK grantRead)
```
Secret: `SkoutDev/email-intel-forwarder`. API + Email-Intel services steady.

### Prod
No SkoutProd stack yet. On first deploy:
```bash
./infra/scripts/setup-email-intel-forwarder.sh SkoutProd https://<prod-api-host>
python3 ./infra/scripts/patch-ecs-email-intel-forwarder.py SkoutProd
```

After 48h parity in staging, enable prod. **Do not drop** Email-Intel’s local ledger until Product signs off.
