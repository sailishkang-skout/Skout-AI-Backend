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

After 48h parity in staging, enable prod. **Do not drop** Email-Intel’s local ledger until Product signs off.
