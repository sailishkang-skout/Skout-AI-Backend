# Email-Intel → canonical Evidence Ledger — local status

**Completed locally:** 2026-08-25

| Side | Variable | Status |
|------|----------|--------|
| Backend API `.env` | `EMAIL_INTEL_EXTERNAL_API_KEY` | set (generated) |
| Backend API `.env` | `EVIDENCE_INGEST_DEFAULT_WORKSPACE_ID` | set to a real local workspace |
| Email-Intel `.env` | `SKOUT_CANONICAL_EVIDENCE_URL` | `http://127.0.0.1:3001` |
| Email-Intel `.env` | `SKOUT_CANONICAL_EVIDENCE_TOKEN` | matches API key |
| Email-Intel | loads `.env` via `src/load-env.ts` | shipped |
| Smoke test | `POST /api/v1/evidence/ingest/email-intel` | **201 OK** |

## Still not done (needs AWS / deploy — cannot invent cloud secrets from here)
- SkoutDev + prod: put the **same two vars** on Email-Intel ECS and the matching key + workspace UUID on API ECS
- Do **not** drop Email-Intel’s old ledger table until staging parity looks good

## Restart
Restart local API and Email-Intel so both processes load the new `.env` values (API if it was started before the key was written).
