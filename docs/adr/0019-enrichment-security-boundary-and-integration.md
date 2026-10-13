# ADR 0019: Enrichment integration, tenancy, and security boundary

## Status

Accepted — ENR-01.

## Context

`EnrichmentTool` is a prototype with an independent Express/Prisma API, dashboard
authentication, and an extension API-key path. Skout already runs a pnpm monorepo with a
Fastify API, Drizzle/PostgreSQL schema and migrations, workspace membership/RBAC, a Next.js
dashboard, and a Chrome extension that obtains a short-lived Bearer token from a signed-in
Skout web session. Running a second API/database/auth boundary would duplicate identity,
tenancy, evidence, and operational controls.

Captured LinkedIn information is source evidence, not verified truth. Discovery cards remain
distinct from verified employment; records and histories must never cross workspace
boundaries.

## Decision

1. Integrate through the existing `Skout-AI-Backend` monorepo (`apps/api`, `packages/db`,
   existing workers/services) and `Skout-AI-Frontend` shell. Do not deploy the prototype API
   or dashboard as standalone applications.
2. Reconcile the Prisma entities to existing workspace-owned tables wherever possible:

   | Prototype entity | Skout representation |
   | --- | --- |
   | `Person` | `contacts` (workspace-owned canonical CRM record); capture-only fields remain in snapshot JSON |
   | `Company` | `companies` (workspace-owned canonical CRM record) |
   | `CompanyPersonDiscovery` | `company_person_discoveries` with `workspace_id`; it is not verified employment |
   | `PersonSnapshot`, `CompanySnapshot` | `enrichment_snapshots` with workspace, entity kind, entity key, hashes, source, actor, and raw capture |
   | `ChangeEvent` | `enrichment_change_events` with workspace-scoped entity key and job-change marker |
   | `EvidenceObservation` | canonical `evidence_ledger` |
   | `ProviderConnection` | existing `workspace_integrations` / `linkedin_accounts`; credentials are references or server-side encrypted values only |
   | `EnrichmentJob` | existing workspace-owned `enrichment_jobs` / `async_jobs` |
   | `LeadEmail`, `CompanyEmailPattern` | existing `email_verifications` / `company_email_patterns` |
3. Every new enrichment table has a non-null `workspace_id` foreign key. API reads, mutations,
   jobs, evidence, and audit writes derive workspace identity from verified Skout auth and
   include workspace scope. Cross-workspace objects are reported as not found.
4. Authenticate extension requests with the Skout account's existing Bearer session. Do not
   add per-user API keys. Provider credentials stay server-side and are resolved through the
   existing integration/secret boundary; never return credentials to the dashboard or bundle.
5. Enforce the enrichment permission verbs `read`, `capture`, `enrich`, `export`, `delete`,
   and `admin` in API handlers. Keep existing role grants compatible during migration; use
   owner/admin for export, deletion, and provider administration, and make narrower permissions
   available for workspace members.
6. Keep CORS as the API's configured origin allowlist, with credentials only for the app's
   configured origins. Preserve global and operation-specific rate limits. Cookie-authenticated
   mutations continue to require the existing double-submit CSRF token. Record capture,
   re-enrichment, export, delete, and provider-connection changes in the canonical audit log.
7. Mount the enrichment navigation in the existing authenticated dashboard shell. The shell
   may hide unavailable actions for usability, but the API remains authoritative for permission
   checks and forbidden responses.
8. Request only the production Skout API host as a required extension host permission. Local
   development origins remain optional; LinkedIn page access remains user-triggered and the
   extension continues to send its Skout Bearer token.

## Consequences

- Skout's workspace, membership, auth, RBAC, CRM, evidence, job, and audit systems remain the
  system of record; the prototype database and auth assumptions are retired.
- The additive Drizzle migration preserves existing CRM and evidence data. Historical prototype
  data is not implicitly copied; any later import must be workspace-attributed and audited.
- `company_person_discoveries` records candidate relationships only. A discovery card does not
  create or imply verified employment.
- Extension and manual captures continue to activate the existing `prospect_activations` record,
  then link it through `contacts.source_prospect_id` to the workspace CRM contact and company.
  Captures write person/company snapshots and a `company_person_discoveries` candidate edge;
  contact employment remains `discovery_candidate` until independently verified.
- The existing integration tables remain authoritative for credentials and external accounts;
  no provider key is exposed as browser-readable configuration.
- Campaign authoring/sending remains part of Skout's existing sequences/campaign workflow;
  this integration does not introduce the prototype's standalone sending engine.

## Rollout

Apply the additive migration, run the idempotent RBAC backfill to seed the enrichment verbs and
role grants, then deploy API, dashboard, and extension updates. Verify workspace-isolation,
unauthenticated access, permission denials, audit writes, and extension host permissions before
enabling capture for production workspaces.

## ENR-02 addendum: capture pipeline

- Reviewed captures enter through `POST /api/v1/enrichment/ingest/{person,company,sales-search}`
  (Zod-validated, strict shape, 1 MB body limit, `enrichment:capture`). The older
  `/prospects/activate` path stays for the extension's add-to-list actions.
- **Canonical identity** lives in `enrichment_identities` (`workspace_id`, entity kind, key →
  `contacts.id` / `companies.id`): `in:<public-id>`, `sales-lead:<opaque-id>`,
  `company:<public-id>`, `company-member:<member-id>`. Several keys may point at one record, so a
  Sales lead that later shows its public link, or a company seen by slug and by numeric id,
  resolves to the same row. A key is never derived from another key. CRM tables gain no columns.
- A search or discovery card never overwrites fields from a full profile capture, never creates a
  company, and leaves `employment_status` as `discovery_candidate`. Only a capture of the person's
  own profile sets `verified_employment`.
- **Capture runs** (`enrichment_capture_runs`) record who, when, source, page and lead counts, and
  a terminal status (`completed`, `stopped`, `failed`, `halted`, `rejected`). A single-request
  ingest is its own run and returns it already terminal; multi-request runs use
  `POST /enrichment/capture/runs` and `…/finish`. Runs left `running` for two hours are closed as
  `failed/abandoned`. One audit-log entry is written per run.
- **Limits**, enforced before anything is written: 10 pages and 250 leads per run, and a per-user
  daily lead limit (default 1,000; entitlement `enrichment.capture_daily_lead_limit`).
- **Kill switch**: entitlement `enrichment.capture_kill_switch`, set through
  `PUT /enrichment/capture/settings` (`enrichment:admin`, audited). It is read from the database
  on every capture request, so the next request after it is turned on is refused with
  `403 capture_disabled` and its run is closed as `halted`. `/prospects/activate` refuses
  LinkedIn-sourced prospects while it is on.
- Not carried over from the prototype: automatic merging/deletion of duplicate company rows.
  A capture matches an existing company by LinkedIn id, then domain, then name plus
  industry/headquarters, or adopts the single name-only placeholder; it never deletes a CRM
  company.

## ENR-03 addendum: identity resolution, evidence ledger, change detection, research API

- **Evidence.** Every fact a capture stores is also written to `evidence_ledger`
  (`capture-evidence.ts`): entity `prospect` (keyed by prospect id) or `company`, one row per
  attribute, with `source`, the new `source_url` column, `observed_at`, `retrieved_at` (capture
  time), `method`, `confidence`, and `validation` holding the state `verified` (read on the
  subject's own page) or `discovery` (read on a search card).

  | Source | Confidence | State |
  | --- | --- | --- |
  | `linkedin_public_profile` | 0.9 | verified |
  | `linkedin_company_page` | 0.85 | verified |
  | `sales_navigator_search_result`, `linkedin_company_people_result` | 0.5 | discovery |
  | `manual_linkedin_url` (a teammate attached or entered the URL) | 1.0 | verified |

  Values the extension infers from a title (`seniority`, `jobFunction`) are capped at 0.6 with
  method `inferred_from_title`. No capture source is given confidence 1: LinkedIn content is
  observed and often self-reported. Capturing an unchanged value refreshes its row
  (`retrieved_at`, freshness, `corroboration_count`) instead of adding one.
- **Employment is its own fact** (`employment`): `verified` only when read on the person's own
  profile and matched to a saved company; a card match is `discovery`. An employer name shared
  by several saved companies is recorded as `ambiguous_company_name` with no company link.
- **Retention and purpose.** Rows carry `permitted_purpose = sales_research`,
  `consent_basis = legitimate_interest`, `freshness_expires_at` (90 days) and `retention_until`
  (365 days; entitlement `enrichment.evidence_retention_days`). A daily worker
  (`enrichment-evidence-retention.worker.ts`) deletes capture-derived rows past
  `retention_until`. Deleting a person or company deletes its capture-derived evidence at once.
- **Identity.** A Sales lead is merged into a public-profile record only when a real public URL
  is visible on a capture or attached by a person (`POST /enrichment/people/:id/public-url`);
  each such merge writes an `identity_merge_events` row. A company capture that shares only its
  name with saved companies is not merged: it becomes a pending `identity_merge_proposals` row
  for the existing reviewed-merge flow. Company name matching compares normalized names, so
  "Acme" and "Acme Inc." count as the same name (and as ambiguous when both are saved).
- **Change detection.** `is_job_change` is set only when the set of current employer + title
  pairs changes; tenure text, descriptions and headline edits do not count. Job changes have a
  review state (`reviewed_at`, `reviewed_by`). Nothing is enrolled, messaged or queued by a
  detected change.
- **Read contract for sequence drafting (ENR-05).** `GET /enrichment/evidence/prospects/:id`
  (`ProspectEvidence`) and `GET /enrichment/evidence/accounts/:id` (`AccountEvidence`),
  `schemaVersion: 1`. Each fact has `source`, `sourceUrl`, `observedAt`, `capturedAt`,
  `confidence`, `state`, `stale` and `usableForClaims` (verified and fresh). Per attribute the
  verified observation wins over a discovery card, then the newest.
- **Delete.** Person delete removes identity keys, evidence, snapshots, change events,
  discovery edges, jobs and list memberships. The CRM contact is soft-deleted only when the
  capture created it and it has no email, phone or lifecycle progress; otherwise it is kept and
  unlinked. Company delete also clears the employer link and verified state of its people.

## ENR-04 addendum: provider jobs, provider connections, contact data

- **Jobs are rows.** A LinkedIn provider job is an `enrichment_jobs` row with
  `kind = linkedin_profile`; the contact waterfall keeps `kind = contact_waterfall`. New columns
  carry the correlation id, idempotency key, attempt count and limit, next attempt time, worker
  lease, error code and result. `activation_id` is nullable because a company job has no
  prospect activation. Statuses: `queued`, `running`, `partial`, `action_required`, `failed`,
  `completed` (shown as `done`); all but the first two are terminal.
- **Durability.** The queue message only asks a worker to look at a job. A worker claims the
  row with one conditional update, holds a five-minute lease, and writes the terminal status
  itself; a write is refused once the lease has been lost. A recovery pass (every 30 seconds and
  at start-up) re-queues running jobs whose lease ran out, fails them as `WORKER_LOST` when no
  attempt is left, hands over queued jobs the queue dropped, and fails waterfall jobs left
  unfinished for 30 minutes by a process that died. Without Redis the same pass runs jobs
  in-process.
- **Retries.** At most three attempts per job, with exponential backoff from 30 seconds (or the
  provider's `Retry-After`), and only for timeouts, 5xx and rate limits. A rejected credential,
  an unreadable account, a missing connection and a provider that is not permitted end
  `action_required` with the reason; a missing profile ends `failed`.
- **Provider connections** are `enrichment_provider_connections` rows: provider, external
  account id and a `credential_ref` (`workspace_integration:<provider>` or
  `platform:<provider>`) pointing at the existing secret boundary. This is a new table rather
  than a reuse of `linkedin_accounts`, which models outreach sending (daily send limits, default
  sender): connecting an account for messaging is not consent to use it for profile retrieval.
  Connect, check and disconnect need `enrichment:admin` and are audited. Disconnect keeps the
  row as `revoked` so past jobs still name it.
- **Evidence.** The provider's raw response is stored on the attempt and read back only through
  an audited `enrichment:admin` endpoint. Fields reach the Evidence Ledger only through a
  mapping verified against a recorded live payload, as source `linkedin_provider_profile`
  (confidence 0.8, state `discovery`). No mapping is verified yet.
- **Contact data** is a read model over `enrichment_results`, `email_verifications` and the CRM
  contact: each value has a provider, provenance and a verification status, or the field is
  absent. Verification goes through the Email Intelligence service when configured, otherwise
  the workspace's verifier from the waterfall; the stub verifier is refused.
- **Test mode.** `LINKEDIN_ENRICHMENT_TEST_MODE=true` runs a job to a terminal `partial`,
  recording the submitted URL and nothing else. It is ignored when `NODE_ENV=production`.
- **Provider policy** is in `docs/enrichment-provider-policy.md` and
  `services/enrichment/provider-policy.ts`. No provider is approved yet.

## ENR-05 addendum: audience, composer, approval, launch

- **Audiences** (`enrichment_audiences`) are saved filters over captured people: role,
  department, seniority, location, company (industry, size), evidence state (verified employment
  or discovery card) and freshness. Saving one writes its members to an ordinary static list.
  An audience is capped at 500 people so every recipient can be reviewed.
- **Claims come only from evidence.** The composer (`campaign-composer.ts`) words a sentence
  about a person or company from exactly one Evidence Ledger fact, so a claim without a
  reference cannot be produced. Verified, fresh facts become usable claims; discovery-only or
  stale facts are flagged for the reviewer and kept out of copy. Wording is rule-based, not
  generated by a language model: the same evidence always gives the same sentence. Company
  facts are attached only to a person whose employer is itself verified.
- **A campaign** reuses `enrichment_campaigns` (new columns) with recipients in
  `enrichment_campaign_recipients` and decisions in `enrichment_campaign_reviews`. Statuses:
  `draft → pending_review → approved → launched`, plus `rejected`, `changes_required`,
  `dismissed`.
- **Approval is a record, and it covers an exact state.** Approving needs `sequences:send`,
  re-reads eligibility and evidence, and stores a hash of the copy on the campaign and, per
  included recipient, a hash of their address and the evidence behind their claims. Editing
  the copy or the recipients afterwards withdraws it. At launch and before the first email, a
  changed hash sends the campaign back to `changes_required`. A recipient who has since become
  uncontactable is not a change to review: they are skipped.
- **Launch uses the existing path.** It creates a normal sequence, enrolls through
  `SequenceService.enroll` after `gateEnrollConsent`, and stores each recipient's step-1 copy as
  an approved `ai_drafts` row for their enrollment step — the mechanism the worker already has
  for reviewed copy. The shared step template never contains a claim. The prototype's SMTP/IMAP
  engine is not ported.
- **Who can be enrolled:** an email the verification service confirmed as valid, that passes the
  central `canContact` gate (suppression list, do-not-contact channel, hard bounce, send
  eligibility). Consent is shown per recipient; the approver records a lawful basis for those
  without a consent record, which is required when `CONSENT_ENFORCEMENT_ENABLED` is on.
- **Send-time gate.** Before every email the sequence worker calls `campaignSendGate`. Ordinary
  enrollments pass. A campaign enrollment needs a standing approval, the approved and still
  verified address, unchanged evidence until step 1 has gone, and — outside production — a
  recipient on `ENRICHMENT_CAMPAIGN_SANDBOX_RECIPIENTS`. With no list set, campaigns send
  nothing outside production.
- **Hard bounce suppresses.** A bounce signal now adds the address to the suppression list for
  every enrollment, not only campaign ones.
- **Outcomes.** The worker reports sent, replied and bounced; unsubscribes are read from the
  suppression list. They are stored per recipient, written to the ledger as
  `email_deliverability` evidence (a bounce also marks the verification invalid), and counted on
  the audience the campaign came from.
- **Job changes** create a one-person draft campaign with `trigger = job_change`, listed in the
  review queue. It is created unsubmitted and unapproved; only a person can take it further.

## ENR-06 addendum: release gate, observability, CI

- **Release gate.** Capture, research, provider and campaign routes sit behind
  `guardWithReleaseGate`. In production with `ENRICHMENT_RELEASE_STAGE=internal` (the default) a
  workspace needs the `enrichment.internal_access` entitlement; `general` applies only when
  `ENRICHMENT_LEGAL_APPROVAL_REF` is set. The gate is not enforced outside production. The older
  enrichment features (credits, scoring, the contact waterfall) are not gated. Gates and sign-off
  are in `docs/ops/enrichment-release-gates.md`.
- **Observability** is read from the database, so it is identical on every instance and
  survives restarts: `ops.service.ts` produces one bounded snapshot (statuses and error codes
  only), exported as gauges on `/metrics` and evaluated into named alerts by
  `enrichment-ops.worker.ts`, which also closes capture runs nobody finished.
- **CI** gained migration validation (`scripts/check-migrations.mjs`), a secret and data-leak
  scan, a dependency audit and Chrome package validation. Runbook: `docs/runbooks/enrichment.md`.

