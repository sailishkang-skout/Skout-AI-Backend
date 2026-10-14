# COPS-09 audit: external CRM sync (connector framework, mapping, conflicts, observability)

Status: audit only. No behaviour changes in this PR. Ticket: COPS-09 (Phase 2), Bible p.26-29, 82,
Appendix E and I, epic E11. ADRs that bind it: 0009 (HubSpot bi-directional sync, accepted),
0013 (Skout wins the internal record), 0014 (external CRM sync is opt-in, proposed).

The ticket says to audit and extend existing code first and not to build a parallel system. A
good part of COPS-09 exists already for HubSpot. This document lists what is there, what the
ticket still needs, and the order in which I would build it.

## 1. What exists on develop

| Area | Where | What it does today |
|---|---|---|
| Connection record | `crm_connections` (`packages/db/src/schema/integrations.ts`) | One row per workspace and provider: status, external account id, settings, `credentials_ref`, `token_expires_at` |
| Credentials | `hubspot-credentials.store.ts` | OAuth tokens encrypted with `INTEGRATION_ENCRYPTION_KEY` inside the credentials ref; key rotation script in `packages/db/src/rotate-integration-encryption-key.ts` |
| OAuth | `hubspot.routes.ts`, `hubspot.client.ts` | `POST /crm/hubspot/connect`, `GET /crm/hubspot/callback`, `DELETE /crm/hubspot`; code exchange and refresh-token grant |
| Inbound sync | `crm-hubspot-native-sync.service.ts` | `POST /crm/hubspot/sync-native` pulls contacts and deals changed since the checkpoint into native `contacts` / `deals`. Manual-wins rule: a field a person set (field source "manual") or with stronger evidence is not overwritten. Evidence is dual-written |
| Checkpoints | `crm_sync_checkpoints`, `crm-sync-state.service.ts` | Per connection and entity: cursor, last run status, start/end, last error |
| External ids | `crm_native_links` | Skout entity id to external id, with the external updated-at. Skout ids stay primary |
| Outbound | `crm_outbound_writes`, `crm-outbound-sync.service.ts`, `workers/crm-outbound-write.worker.ts` | Changes to sync-owned fields (`CRM_SYNC_OWNED_FIELDS`: contact name, email, phone, title; deal name, amount) are queued with an idempotency key and leased by a worker; retry by lease expiry, failed after a maximum number of attempts |
| Webhook | `POST /crm/hubspot/webhook` | Verifies `X-HubSpot-Signature` (sha256 of client secret + body), then runs a bounded inbound sync |
| Health | `GET /crm/hubspot/sync-status` | Checkpoint state per entity |
| Import / export | `import-adapters/hubspot.adapter.ts`, list export | One-off prospect import and list export to HubSpot |
| Other providers | `integration.routes.ts`, `integration-providers.ts`, `workspace_integrations` | Generic API-key integrations (Apollo and others); not CRM sync |
| Frontend | `settings/integrations/page.tsx`, `src/lib/integrations.ts` | Connect and disconnect, provider list |

## 2. Ticket line by line

| Ticket line | Exists | Missing |
|---|---|---|
| OAuth lifecycle | Connect, callback, refresh, disconnect (HubSpot) | Expired or revoked grant detection that sets the connection to `needs_reauth` and alerts; one lifecycle shared by every connector instead of HubSpot-only code |
| Webhooks + signature verification | HubSpot v1 signature | HubSpot v3 signature with timestamp (replay window); provider event dedupe (no event id is stored today, so a replayed webhook reruns a sync) |
| Provider clients, retries, rate limits | HubSpot client; outbound retry by lease expiry | 429 handling with `Retry-After` and backoff in the client; per-connection rate-limit state visible in health |
| Never repeat irreversible provider actions | Outbound idempotency key per change | A check before re-sending an outbound create (search by Skout id stored on the external record) |
| Encrypted credentials | Yes | Nothing for HubSpot |
| Connector framework, refactor payment/email adapters onto it where practical | Not a framework yet: HubSpot code is called directly | A connector interface (auth, client, webhook verify/parse, object mappers) with HubSpot as the first implementation. Where practical, the payment and email adapters move onto it. Payment (`services/psp`) already has an adapter interface and needs only naming alignment. Email (`email-sender.service.ts`, `EmailTransport`) connects Google and Microsoft inboxes with OAuth: their token refresh and expired-grant handling should use the same OAuth lifecycle as the CRM connector, so a revoked inbox shows up the same way as a revoked CRM |
| Object + field mappings, direction, transforms, null behaviour, scope; versioned and testable (Appendix E) | Hard-coded: inbound field map in the sync service, outbound owned fields in `crm-sync-fields.ts` | Mappings as versioned config per connector (internal path, external object.field, direction, transform, null behaviour, conflict policy, last validated schema version), with a "test mapping" endpoint |
| Initial import then incremental (webhook/poll) | Incremental pull from checkpoint; one-off prospect import | A first full import for a new connection (paged, resumable via checkpoint), and a scheduled poll when webhooks are not set up |
| Skout-originated writes land in Skout first, then async | Yes (outbound queue) | Companies are not synced as objects (ADR 0009: deferred) |
| Checkpoints, external revisions, retry state | Checkpoints and `external_updated_at` | Per-record sync history (what was pulled or pushed, when, outcome) |
| Opt-in per workspace/account | Per workspace (connect = on) | Opt-in per account (scope), and ADR 0014 accepted |
| Conflicts: Skout wins / external wins / most-recent / manual review per field | Manual-wins only, applied by field source and evidence | The four policies per field from the mapping; protected system-derived fields (lifecycle state, commercial state, health) never overwritten; concurrent-edit detection using `external_updated_at` against Skout's change time; manual-review conflicts stored and blocking the overwrite |
| Admin conflict queue with side-by-side values | No | Table + API + screen: Skout value, external value, both timestamps, resolve as Skout / external / custom, audited |
| Health API: auth status, last sync, backlog, failed records, rate-limit state | Checkpoint status only | Auth status, backlog (queued outbound writes), failed records, rate-limit state, per connector |
| Per-record history + audited replay, DLQ | Failed outbound rows stay `failed` | A replay action (audited) for failed records; inbound failures recorded instead of only logged; the failed set is the DLQ |
| Alerts: expired grants, mapping failures, schema changes, repeated errors | No | In-app notifications to Admin through the existing routing (Datadog is skipped for now). Schema drift: compare the provider's property list with the mapping and alert instead of dropping fields |
| FE: integrations page, health dashboard, mapping editor with validation + test, conflict queue, per-record history with replay, DLQ view | Connect/disconnect page | Everything else on the list |

Acceptance criteria and how each will be proven:

- Connect and disconnect never corrupt internal records: disconnect keeps every native record and its `crm_native_links`; a reconnect resumes from the checkpoint. Test.
- Round-trip sync is idempotent, replay creates no duplicates: pull, push and pull again changes nothing; replaying a webhook or a failed record is a no-op the second time. Tests.
- 429 backs off without data loss: client test with a 429 then success; checkpoint only advances after a page is applied.
- Schema drift raises an alert instead of silently dropping fields: mapping validation against the provider's properties. Test.
- Each conflict policy tested; manual-review conflicts block overwrite until resolved. Tests.

## 3. Things in the existing code to know before extending it

1. **Native CRM tables are owned by apps/crm.** The inbound sync in apps/api writes `contacts` and `deals` directly. COPS-08 hit the same rule for renewals and it was accepted through ADR 0003. COPS-09 will need the same kind of entry, or the writes go through apps/crm. Decision needed (see 6).
2. **Companies are matched by domain during contact sync, not synced as objects** (ADR 0009 item 5).
3. **The webhook endpoint takes `workspaceId` from the query string (or the body).** The v1
   signature covers only the client secret and the body, not the URL. So a signed body replayed
   with another workspace id in the query starts a sync for that workspace. It does not expose
   data (the sync pulls that workspace's own HubSpot account), but anyone holding one signed
   request can trigger syncs for any connected workspace. The workspace should come from the
   HubSpot portal id on the connection, with the v3 signature (which covers the URL and a
   timestamp). I would fix this first, as its own small PR.
4. **No provider event dedupe** on the HubSpot webhook (see 2).

## 4. Proposed build order (small PRs, each with tests)

1. This audit, plus the OpenAPI contract for the new endpoints.
2. Webhook hardening: resolve the workspace from the portal id, v3 signature with replay window, event dedupe.
3. Connector interface with HubSpot as the first implementation; 429/backoff; grant-expiry detection (`needs_reauth`) with an in-app alert.
4. Versioned mappings as config, with validation and a test endpoint; inbound and outbound read from them. Same behaviour as today on the default mapping.
5. Conflict policies per field, protected fields, the conflict table and resolve API.
6. Per-record history, failed-record replay (DLQ), health API with backlog and rate-limit state, schema-drift alert.
7. Initial import and scheduled poll; per-account opt-in.
8. Frontend: integrations page with health, mapping editor, conflict queue, record history with replay, DLQ view.

### Progress

- **Step 2 done (webhook hardening).** The workspace now comes from each event's `portalId`
  (the URL's `workspaceId` is ignored), v3 signatures are checked with their timestamp when
  HubSpot sends them (needs `API_PUBLIC_URL`), v1 otherwise, and each event id runs once
  (`cops_processed_events`, consumer `hubspot-webhook`; no migration). Found on the way: the OAuth
  callback stored an HMAC of the access token as the portal id, so no event could be matched to a
  workspace. The callback now stores HubSpot's real `hub_id`, and connections made before the fix
  get it on their next sync.

## 5. Out of scope

- A second connector (Salesforce, Pipedrive, Zoho, Dynamics). The framework is built so one can be added, but only HubSpot ships here.
- Moving the payment and e-sign adapters onto the connector interface beyond naming. The email inboxes share the OAuth lifecycle only (see section 2); their sending code stays where it is.

## 6. Open questions for Aditya

1. Confirm HubSpot as the first connector (epic open question 4).
2. A HubSpot developer test account and its app credentials (client id, client secret, app id) in the encrypted env files. Is the current HubSpot app reusable for this?
3. Native CRM writes from apps/api (see 3.1): an ADR 0003 entry, or route the writes through apps/crm?
4. Accept ADR 0014 (opt-in per workspace/account), and is per-account scope wanted in this ticket?
5. Default conflict policy per field. My suggestion: Skout wins for fields a person set in Skout, most-recent for the rest, manual review for amount and stage.
6. COPS-09 is Phase 2. The Phase 1 gates are still open (#127, #194, #193, pilot sign-off). Confirm it is fine to build now, as with COPS-08.
