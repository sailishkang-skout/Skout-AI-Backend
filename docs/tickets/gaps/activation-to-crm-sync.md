# Gap: no automated sync from prospect activation to a CRM contact/company row

**Raised by:** R14.1 unified-record lock-in audit (`docs/tickets/r14-1-unified-record-audit.md`).
**Owner:** Neeraj (backend link) + Shailpreet (UI).
**Status:** Backend eng-complete 2026-08-26 — `ensureContactLinkedToProspect` on sequence enroll.

## The gap (original)

`prospect_activations` and `contacts`/`companies` lived side by side with no sync path.

## Shipped (Wave 2)

- `apps/api/src/services/prospect-crm-link.service.ts` — resolve-or-create contact with
  `sourceProspectId`, optional company, evidence audit row.
- Called from `SequenceService.enroll` after each successful enrollment insert (best-effort).
- Enrichment autofill continues to use `sourceProspectId` for title/email/phone.

## Still open (UI / product)

- Whether activation itself should always auto-create a contact (vs enroll-time only).
- Merge review UI for prospect↔CRM probabilistic matches (Shailpreet).
