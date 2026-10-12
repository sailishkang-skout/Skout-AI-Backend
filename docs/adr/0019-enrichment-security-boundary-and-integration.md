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
