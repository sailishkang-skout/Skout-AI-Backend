# LinkedIn enrichment — release gates and sign-off (ENR-06)

The feature is **internal** until every gate below is closed. In production the API enforces
that: with `ENRICHMENT_RELEASE_STAGE=internal`, only workspaces holding the
`enrichment.internal_access` entitlement can use capture, research, provider jobs or campaigns.
`general` takes effect only when `ENRICHMENT_LEGAL_APPROVAL_REF` names the recorded approval.

**Current state (2026-10-12): internal. Gates 2 and 3 are open.**

## Gate 1 — ENR-01..05 acceptance, no critical tenant-isolation or security defect

Each manual acceptance case from the engineering handoff has an automated test at the API and
at the UI. The API suite is `apps/api/src/routes/enrichment-acceptance.routes.test.ts`; the UI
suite is the frontend's `e2e/enrichment-acceptance.spec.ts`.

| # | Case | Automated | Manual run on UAT (who / date) |
| --- | --- | --- | --- |
| 1 | Capture and review a current public person profile | API + UI | |
| 2 | Company with About/People tabs | API + UI | |
| 3 | Eight-page Sales Navigator search; a lead without a public link stays a Sales lead | API (183 leads, 8 pages) + UI | |
| 4 | Repeat a department search: no duplicate people | API + UI | |
| 5 | Attach a public URL to a lead; candidate vs verified employee correct | API + UI | |
| 6 | CSV export, delete and re-enrich | API + UI | |
| 7 | Restart backend and extension during a queued job: state recovers, failures visible | API + UI | |
| 8 | Campaign with sandbox recipients only | API + UI | |

The automated tests replace neither the browser nor LinkedIn: they post the payloads the
extension would post. **Cases 1–5 and 7 must also be run by a person with the packaged
extension against real LinkedIn pages on UAT**, because only that exercises the page readers.
Fill in the last column. Case 8 must be run with a sandbox mailbox, never a real recipient.

Tenant isolation: the acceptance suite requests every enrichment endpoint from a second
workspace and expects `404` or an empty list. Security: `enrichment-capture.routes.test.ts` and
`enrichment.routes.test.ts` cover unauthenticated access, permission denials and audit writes.

- [x] Automated acceptance suite passes in CI
- [ ] Manual UAT run of cases 1–8 recorded above
- [ ] No open critical/high defect tagged tenant-isolation or security

## Gate 2 — Legal and Product approval of LinkedIn data use and vendor terms

Not an engineering decision. Until it is recorded here, the release stays internal.

| # | Question | Decision | By | Date |
| --- | --- | --- | --- | --- |
| 1 | May Skout offer user-initiated capture of LinkedIn pages through a browser extension, given LinkedIn's User Agreement and its published position on extensions that scrape or automate? | | | |
| 2 | Which customers and regions may use it; is a customer-facing disclosure or contract term needed? | | | |
| 3 | Lawful basis for storing captured profile data (currently recorded as legitimate interest, purpose sales research) | | | |
| 4 | Retention: 365 days for evidence, 90 days for raw provider responses | | | |
| 5 | Unipile for profile retrieval: terms, DPA, sub-processors, residency (see `docs/enrichment-provider-policy.md`) | | | |
| 6 | May contact details from a LinkedIn profile's contact section be stored at all | | | |
| 7 | Contact-data providers already in use: rights, DPA and retention confirmed | | | |
| 8 | Outreach built on captured evidence: consent/legitimate-interest position per region | | | |
| 9 | What to do, and who decides, if LinkedIn warns or restricts a customer's account | | | |

- [ ] All rows decided
- [ ] Approval reference recorded: `__________` → set as `ENRICHMENT_LEGAL_APPROVAL_REF`
- [ ] Provider status updated in `provider-policy.ts` for each approved provider

`docs/ops/linkedin-compliance-signoff.md` (2026-08-26) covers LinkedIn *sending* through Unipile.
It does not cover capture or profile retrieval and is not this approval.

## Gate 3 — Dashboards and alerts live; rollback plan documented

- [x] Metrics exported on `/api/v1/metrics`; alert rules evaluated by the ops worker
- [x] Rollback plan: `docs/runbooks/enrichment.md` → Rollback
- [ ] Datadog monitors created from the table in the runbook, routed to on-call
- [ ] Dashboard created with the enrichment gauges
- [ ] A page-severity alert fired in UAT and reached the on-call channel (test by stopping the
      API with a job queued)

## Opening the release

1. Close gates 1–3 above and commit this file with the boxes ticked and the table filled in.
2. Set `ENRICHMENT_LEGAL_APPROVAL_REF` and `ENRICHMENT_RELEASE_STAGE=general` in production.
3. Deploy. Confirm the start-up log says `release stage: general`.
4. To go back: set the stage to `internal`. No code deploy is needed.

To give one production workspace internal access:
`buildEntitlementsService(db).set(workspaceId, "enrichment.internal_access", true)` through the
entitlements admin path, recorded in the release ticket.

## Known limits carried into release

- The backend has no linter configured (`lint` is a placeholder in `apps/api` and `apps/crm`).
  CI runs typecheck, tests, migration validation, secret scan and dependency audit.
- 43 high-severity dependency advisories are open in production dependencies (0 critical). CI
  reports them and blocks only on critical.
- No Unipile field mapping is verified against a live payload, so provider jobs end `PARTIAL`.
