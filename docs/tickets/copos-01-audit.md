# COPS-01 audit-and-extend findings

This is the required existing-code audit for COPS-01. The backend already owns CRM, billing,
notifications, tenancy/RBAC, audit history, and the Skout event spine. COPS-01 extends those
systems and adds only the missing transactional-outbox and idempotency capabilities.

## Existing capabilities reused

| Bible area | Existing implementation | COPS-01 integration |
|---|---|---|
| CRM and Customer 360 | `packages/db/src/schema/crm.ts`, `apps/api/src/routes/crm-native.routes.ts`, `account-360.routes.ts`, `apps/crm` | Keep existing resources and routes; link from the existing dashboard navigation. COPS-02 owns CRM changes. |
| Credits and billing | `packages/db/src/schema/credits.ts`, `billing.ts`, `apps/api/src/routes/billing.routes.ts`, `entitlements.routes.ts` | Keep existing ledger and billing APIs; no second billing model in COPS-01. |
| Sequences and automation | `packages/db/src/schema/sequences.ts`, `automation.ts`, `automations.ts`, existing sequence/automation routes | Reuse existing sequences and workflows; COPS-05/10 own customer-lifecycle automation. |
| Event log and event transport | `packages/db/src/schema/events.ts` (`skout_events`), `packages/shared/src/event-envelope.ts`, `apps/api/src/services/skout-event.service.ts`, existing BullMQ/webhook dispatch | Keep the existing event spine. It is durable best-effort logging, not an atomic outbox, so COPS-01 adds a transactional outbox for new lifecycle writes rather than replacing the current event API. |
| Audit | `packages/db/src/schema/audit.ts` (`audit_logs`), `apps/crm/src/services/audit.service.ts`, `packages/auth` step-up audit writes | Extend `audit_logs` with Appendix D context and write through one shared COPS audit helper. Do not create a parallel `cops_audit_events` table. |
| Incidents | `packages/db/src/schema/incidents.ts`, existing incident routes | Reuse for incident state; COPS-06 owns ticket/incident lifecycle integration. |
| RBAC | `workspace_member_roles`, `roles`, `role_permissions`, `permissions`, `packages/auth/src/require-permission.ts`, `packages/db/src/backfill-rbac.ts` | Seed COPS permission keys and system-role grants into the existing catalog; use `getMemberPermissions` server-side. Never trust client-only visibility checks. |
| Notifications and preferences | `packages/db/src/schema/notifications.ts`, `apps/api/src/services/notifications.service.ts`, `notification.routes.ts`, dashboard `NotificationBell`, `/settings/notifications` | Reuse the existing center, settings, delivery service, and endpoints. Do not add a second notification page or provider service. |
| Integrations and SSO | `packages/db/src/schema/integrations.ts`, HubSpot and SSO/SCIM routes | Retain existing integrations and configuration. |
| AI / recommendations | `apps/ai`, `next-best-action.ts`, activation-rule routes | Keep AI recommendation and approval boundaries in their existing modules. |

## COPS-01 additions that were actually missing

- A Postgres transactional outbox, typed COPS event schemas, relay retry/dead-letter handling,
  idempotent-consumer primitives, and audited replay by event ids or time range. The existing `skout_events`
  table is an event log and cannot atomically commit with a business write.
- The existing CRM deal service now writes the `OpportunityQualified` outbox event in the same
  transaction as the deal-stage update and existing audit row; the relay uses the existing
  `skout-dexter-event` queue and worker.
- The six independent lifecycle dimensions and their allowed-transition rules. Opportunity
  `won` does not imply onboarding `activated`.
- An audited lifecycle projection rebuild from the ordered `LifecycleTransitioned` outbox history;
  opportunity qualification is also used as the opportunity dimension's initial-state event.
- The COPS verb/resource permission catalog and role grants, layered onto the existing RBAC
  tables. `Engineering` is deliberately not granted commercial or legal reads.
- Persisted idempotency outcomes for mutating endpoints.
- A workspace-scoped, permission-checked audit query and an audit helper that writes to the
  existing `audit_logs` table.
- The OpenAPI contract and the audit-log view. The existing dashboard navigation is extended to
  link the view only when the server-reported permission allows it.
- COPS event-to-role notification defaults and workspace overrides, implemented through the
  existing notification API, worker, preferences, and delivery service rather than a second
  notification center.

## Contract and rollout notes

- The global API error body now includes the Bible contract fields
  `{code, message, details, request_id, retryable}` and keeps the legacy `ok`, `error`, and
  `statusCode` aliases for current clients.
- `GET /api/v1/me` returns the authenticated user's permission keys from the existing RBAC
  service. The audit navigation item is hidden until `admin:read` is granted; the API still
  enforces that permission independently.
- Run the existing `@skout/db backfill-rbac` command after deploying the permission-catalog
  update. It is idempotent and creates the COPS system roles/grants for future assignment.
- Notification delivery remains on the current notification service. The existing bell is the
  notification center; `/settings/notifications` remains the preferences and channel setup page.
- `GET/PUT /api/v1/notifications/cops-routes` manages audited workspace overrides; `DELETE
  /api/v1/notifications/cops-routes/{eventType}` restores the built-in default and also requires
  an audited reason. `/settings/notifications` exposes the editor only to users with
  `admin:admin`; users can view/edit recipient roles and restore defaults. The existing bell/feed
  remains the notification center. Event receipts and in-app notification inserts share one
  transaction; `(workspace, user, event_id)` uniqueness prevents duplicate notices on replay.
  Existing user preferences and email/Slack delivery are reused.
- Teams delivery uses the Microsoft Teams Workflows incoming-webhook contract, configured per
  workspace through owner/admin settings; the API restricts URLs to HTTPS Microsoft webhook
  hosts. Delivery failures retry and are reported without failing in-app notification creation.
  A configured Teams environment and production alert routing are not verified.

## Acceptance verification (2026-10-06)

| Acceptance item | Status | Evidence / remaining work |
|---|---|---|
| Outbox crash safety and duplicate-event no-op | ✅ | In-memory crash/consumer tests pass; the real-Postgres process-kill test passed 2/2 with `COPS_TEST_DATABASE_URL` and is committed as `81f9c61`. |
| Illegal lifecycle transitions return 409; won does not imply activated | ✅ | Independent dimensions and transition tables; lifecycle/error unit tests pass. |
| Derived lifecycle state can be rebuilt from events | ✅ | Admin-only, reason-required recompute endpoint validates ordered transition continuity and transactionally rebuilds the projection with an audit row. CRM qualification events restore the initial `qualified` state. |
| Permission matrix; Engineering denied commercial/legal reads | ✅ | Full role-permission matrix passed against the seeded local Postgres catalog. Engineering lacks `commercial:read` and `legal:read`. Production/staging rollout must run the idempotent backfill before enforcement is enabled. |
| Overrides require a reason and create audit records | ✅ | Shared audit validation rejects overrides without a reason; lifecycle/replay writes persist audit records transactionally. Each later ticket must assert its own override audit write. |
| Notification routing, provider retries, and outage isolation | ✅ | COPS events create deduped in-app notifications; admins have an audited role-route editor. Email/Slack/Teams adapters retry and report exhausted failures without failing in-app writes. Per-channel successes are checkpointed; COPS BullMQ retries recover an event committed before provider delivery and Sentry captures final exhaustion. Production alert routing and Teams credentials still require environment verification. |
| Permission-aware frontend; no raw 403 screen | ⚠️ Partial | Audit navigation is gated on `admin:read`; the routing editor is gated on `admin:admin`, with API-side checks retained. Audit page renders a user-facing forbidden state. Full CustomerOps nav sections remain owned by their corresponding capability tickets. |
| 422 field errors and retryable/429 handling | ⚠️ Partial | API returns `details.fields[]`; audit-page integration and Playwright tests verify a mocked 422 field alert. Playwright uses local E2E auth bypass; authenticated browser verification against a real API response remains pending. |
| OpenAPI contract and existing-code audit | ✅ | Contract: `docs/api/copos-01-platform-foundation.openapi.yaml`; findings recorded above. |
| Six Bible p.10 ADRs | ✅ | All six decisions are documented and linked below. ADRs are proposed pending reviewer sign-off; provider selections are correctly deferred to the tickets that integrate them. |
| Commercial / Engineering navigation | ⏭ | Deliberately deferred to COPS-03 / COPS-06. |

Focused verification run before the latest local-only extensions: backend COPS shared tests **67/67 passed**; seeded COPS role grant and
Postgres matrix tests **4/4 passed**; frontend COPS error, fetch, navigation-helper, audit-viewer,
and audit-page integration tests **20/20 passed**; COPS Playwright browser tests **2/2 passed**;
notification provider retry, Sentry-capture, and fallback tests **7/7 passed**. The RBAC backfill
was run and queried only in the local `skout_test` database; no shared or production database was
modified.

Latest local-only validation: lifecycle projection tests **8/8 passed**; focused API notification,
routing, worker, lifecycle, and notification delivery tests **24/24 passed**; Teams webhook URL
validation **8/8 passed**; API/DB TypeScript checks passed.
Frontend typecheck passed and COPS audit, notification-center, and routing-editor tests **6/6
passed**. Provider recovery tests additionally cover duplicate event delivery after the in-app
transaction. All changes remain uncommitted and undeployed.
Local `skout_test` migration application previously stopped at `0079_whatsapp_outreach_jobs.sql`
because its table already existed; that migration is now safe to re-run when the table is present.
The DB migrations have not been re-applied, so runtime DB validation still requires applying
`0101`/`0102` after reconciling the local migration history.

## Operational follow-up (not a COPS-01 code acceptance blocker)

- Run the idempotent RBAC backfill in each target environment before enabling
  `RBAC_ENFORCEMENT_ENABLED`.
- Confirm the target Sentry project has notification-provider failure alerts routed to the
  on-call channel.
- Obtain reviewer sign-off on the six proposed decision ADRs before treating them as formally
  approved policy.

### Product Bible v2 p.10 decision ADRs

- [ADR 0013 — Skout Internal CRM is canonical](../adr/0013-internal-crm-canonical.md)
- [ADR 0014 — External CRM sync is opt-in](../adr/0014-external-crm-sync-opt-in.md)
- [ADR 0015 — Skout generates commercial documents; signatures are delegated](../adr/0015-commercial-docs-esign-delegated.md)
- [ADR 0016 — PSP processes payments; Skout stores references and status only](../adr/0016-payments-via-psp-references-only.md)
- [ADR 0017 — Event-driven workflows with idempotency and replay](../adr/0017-event-driven-idempotent-replayable-workflows.md)
- [ADR 0018 — AI recommends; permissioned humans approve](../adr/0018-ai-recommends-humans-approve.md)
