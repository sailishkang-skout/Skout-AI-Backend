# Gap: no automated sync from prospect activation to a CRM contact/company row

**Raised by:** R14.1 unified-record lock-in audit (`docs/tickets/r14-1-unified-record-audit.md`).
**Owner:** Sailish (enrichment + AI wiring — inferred from git history, confirm) + Aditya (CRM
service — inferred from git history, confirm).
**Status:** Open.

## The gap

`prospect_activations` (OLTP activation of a corpus prospect) and `contacts`/`companies` (native
CRM entities) live side by side with no confirmed sync path. `contacts.sourceProspectId` /
`companies.sourceProspectCompanyId` exist as link-back columns, but nothing currently guarantees a
`contacts` row gets created when a prospect is activated — a rep has to create the CRM contact
themselves, at which point they may or may not set `sourceProspectId`.

R13.3's enrichment auto-fill (shipped) depends on this link existing: `EnrichmentService.activate`
now looks up a linked contact by `sourceProspectId` after every snapshot upsert and auto-fills
title/email/phone when found — but if no linked contact exists yet, activation produces enriched
data that never reaches the CRM record a rep is actually looking at.

## Suggested fix

Confirm with the team whether activation should auto-create a minimal `contacts`/`companies` row
(status: lead, unlinked to a company until enrichment resolves one), or whether contact creation
should stay a deliberate rep action with activation only auto-filling once a link exists. Either
answer should be documented here and reflected in `r14-1-unified-record-audit.md`.
