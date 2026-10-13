# Enrichment provider policy

Which external providers Skout may call to enrich a person or company, and on what terms.
The machine-readable half of this document is
`apps/api/src/services/enrichment/provider-policy.ts`; the two must agree.

**Status: no provider is approved for LinkedIn profile enrichment.** Legal review is open (see
"Open decisions"). Until it closes, every provider job that would call a provider ends
`ACTION_REQUIRED / PROVIDER_NOT_PERMITTED` and makes no external request.

## How a provider becomes usable

A provider is called only when both are true:

1. `legalStatus` for it in `provider-policy.ts` is `approved`. This is a code change and goes
   through review like any other; the pull request links the Legal sign-off.
2. The environment lists it in `ENRICHMENT_PERMITTED_PROVIDERS` (comma-separated ids).

Either one alone does nothing. Removing a provider from the environment variable turns it off
without a deploy.

## Providers

| Provider | Used for | Legal status | States a verification status for contact data | Raw response kept |
| --- | --- | --- | --- | --- |
| Unipile (API v2) | LinkedIn person / company profile through a workspace-connected LinkedIn account | **Pending legal review** | No | 90 days |

The contact waterfall (Hunter, MillionVerifier, ZeroBounce, NeverBounce, People Data Labs,
Datagma, Kaspr, Lusha, ContactOut) predates this document and is unchanged by ENR-04. Those
providers are configured per workspace under Settings → Integrations. They are listed under
"Open decisions" so Legal can confirm them in the same pass.

## Rules that hold for every provider

- **Provenance.** Every value a provider returns is stored with the provider's name, the job
  that fetched it (job id and correlation id), and the time. A value with no provenance is not
  shown.
- **Verification status.** An email is `valid`, `invalid`, `catch_all`, `risky` or `unknown`
  only when a verification service said so about that exact address; otherwise it is
  `unverified`. Phone providers in the waterfall return no verification status, so phone
  numbers are `unverified`.
- **Nothing is guessed.** When no provider returns a value, the field is absent. A
  pattern-built address is not contact data until the verification service has confirmed that
  address, and it is then labelled as pattern-built. Stub providers (development only) and
  provider sample payloads are never shown.
- **Unverified mappings stay evidence.** A provider's raw response is kept as evidence on the
  job attempt. A field is read out of it into the Evidence Ledger only through a mapping that a
  recorded live payload proves (`__fixtures__/unipile/README.md`). Contact details in a
  LinkedIn profile response are never promoted: the provider states no verification status for
  them.
- **Secrets.** Provider credentials live in the encrypted integration store
  (`workspace_integrations`) or server configuration. A provider connection stores an account
  id and a reference to the credential, not the credential. No API returns a secret.
- **Bounded use.** One job per LinkedIn URL at a time, at most three attempts per job with
  backoff, a per-workspace daily job limit (entitlement `enrichment.provider_daily_job_limit`,
  default 200), no proxy rotation and no retry of a refusal.

## Consent and purpose

Provider-retrieved data is recorded with `permitted_purpose = sales_research` and
`consent_basis = legitimate_interest`, as capture evidence is (ADR 0019). It is a research
input. It does not make a person contactable: suppression, consent and the can-contact checks
apply at send time, unchanged.

## Retention and deletion

| Data | Kept for | Removed by |
| --- | --- | --- |
| Raw provider response (`enrichment_attempts.response_output`) | 90 days | Daily retention worker; the attempt row stays, without the payload |
| Ledger facts from a verified mapping | Workspace evidence retention (default 365 days) | Daily retention worker |
| Job and attempt rows | Life of the person / company record | Deleting the record |
| Contact results (`enrichment_results`) | Life of the person record | Deleting the record |

Deleting a person or a company through the enrichment area deletes its jobs, attempts and raw
responses in the same transaction. A data-subject deletion therefore reaches provider data
through the existing person delete.

## Open decisions (Legal)

These are not engineering decisions and are not made in this change.

| # | Decision | Needed for |
| --- | --- | --- |
| 1 | May Skout retrieve LinkedIn profiles through a member's Unipile-connected account, given LinkedIn's User Agreement and its position on automated access? | Approving Unipile |
| 2 | Unipile DPA, sub-processors and data residency acceptable? | Approving Unipile |
| 3 | May contact details from a profile's contact section be stored at all, even as raw evidence? If not, the adapter must strip `emails` / `phone_numbers` before the response is stored. | Approving Unipile |
| 4 | Is 90 days the right retention for raw responses? | Approving Unipile |
| 5 | Confirm rights, DPA and retention for each contact-waterfall provider already in use. | Recording them here as approved |

Record each decision in this table with the date and who made it, then change `legalStatus` in
`provider-policy.ts` in the same pull request.

## Verifying the Unipile mapping

The adapter's field map is written from Unipile's published v2 schema and has not been checked
against a live response. Every mapping is `unverified`, so today a successful job ends
`PARTIAL`: the raw response is stored, the job lists which fields it saw, and nothing is added
to the person or company. To verify a mapping, record a live payload as described in
`apps/api/src/services/enrichment/__fixtures__/unipile/README.md`; the contract test then
allows that mapping to be marked `verified`.

Also unconfirmed until a live call is made: the v2 base URL (set `UNIPILE_V2_BASE_URL` if it
differs from the account DSN) and the company profile path.
