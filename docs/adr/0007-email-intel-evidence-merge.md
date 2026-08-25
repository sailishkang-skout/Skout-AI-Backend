# ADR 0007: Email-Intel evidence → canonical ledger merge

## Status
Accepted — gap-closure pass (25 Aug 2026).

## Context
Email-Intelligence-Tool stores verification observations in its own `evidence_ledger`
(email/domain scoped, no workspaceId). Skout Backend has a workspace-scoped canonical
`evidence_ledger` (§5.3). Full table replacement across repos is high-risk; dual-write +
ingest is the merge path.

## Decision
1. **On Skout verify paths:** dual-write mapped observations into canonical ledger
   (`email-verification.service`, `POST /email-intel/verify`).
2. **Ingest API:** `POST /api/v1/evidence/ingest/email-intel` accepts Email-Intel row shape.
3. **Email-Intel forwarder (optional):** after `appendEvidence`, if
   `SKOUT_CANONICAL_EVIDENCE_URL` + `SKOUT_CANONICAL_EVIDENCE_TOKEN` are set, POST to ingest.
4. Mapper: `apps/api/src/services/email-intel-evidence-map.ts`.

## Consequences
Both ledgers may coexist during cutover. Ops can backfill historical Email-Intel rows via
batch ingest. Deleting Email-Intel's table is a later milestone after traffic is fully dual-written.
