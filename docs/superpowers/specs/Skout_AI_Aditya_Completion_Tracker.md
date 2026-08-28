### **SKOUT AI**

# **Aditya (Senior Dev)**

## **Task Completion Tracker — Enterprise Completion Plan**

_Tracks completion status of all 18 sections assigned to Aditya from the Enterprise Completion Plan. For full task specs, see [Skout_AI_Aditya_Task_List.md](./Skout_AI_Aditya_Task_List.md)._

| **Legend** | |
|---|---|
| ✅ Complete | Shipped, tested, and merged to branch |
| 🔄 In Progress | Currently being built |
| ⬜ Not Started | Not yet begun |
| 🚫 Blocked | Gated on an external dependency or decision |

---

## **Status Summary**

| Status | Count |
|---|---|
| ✅ Complete | 11 |
| 🔄 In Progress | 1 |
| ⬜ Not Started | 5 |
| 🚫 Blocked | 0 |
| 📋 Periodic | 1 |
| **Total** | **18** |

---

## **6. The Skout Intelligence Layer**

### ⬜ 6.0 — The Skout Intelligence Layer (unifying platform boundary)

**Status:** Not Started  
**Completion Criterion:** Any of the four existing intelligence fragments (ai-workspace-tools, next-best-action, activation-rules, ICP scoring) can be reimplemented as a thin caller into a shared layer without losing functionality.  
**Blocks:** §7.3, §8.7, §8.13  

---

### ✅ 6.2 — Regional and Country Intelligence

**Status:** Complete  
**Completed:** 2026-08-26  
**Branch:** `feature/6.2-6.3-regional-intelligence`  
**PR:** [Frontend #43](https://github.com/sailishkang-skout/Skout-AI-Frontend/pull/43) · [Backend #58](https://github.com/sailishkang-skout/Skout-AI-Backend/pull/58)

**Delivered:**
- `regions`, `countries`, `countryAliases` schema tables (250 countries, 15 sub-regions)
- Versioned knowledge rows (source / effective_date / confidence / uncertainty)
- Per-country channel policy, compliance, business practice, telecom, explainability fields
- Self-healing standard country/region provisioning (CI-safe)
- Full Drizzle migration (`0069_regional_brief_aliases_and_tam.sql`)

---

### ✅ 6.3 — Regional TAM Learning System

**Status:** Complete  
**Completed:** 2026-08-26  
**Branch:** `feature/6.2-6.3-regional-intelligence`  
**PR:** [Frontend #43](https://github.com/sailishkang-skout/Skout-AI-Frontend/pull/43) · [Backend #58](https://github.com/sailishkang-skout/Skout-AI-Backend/pull/58)

**Delivered:**
- `countryIndustryTam` table (versioned TAM rows, NAICS 20-sector model)
- `regionalBriefSlots` + `regionalBriefVersions` tables (layered brief: global → region → country → industry → tenant)
- US Census SUSB + UK ONS BPE baseline seed (162,006 establishments / NAICS 51 US)
- Interactive TAM calculator UI (frontend `tam/[id]` page)
- Admin brief management UI (`settings/regional-brief` page)
- `regional-brief.service.ts`, `country-industry-tam.service.ts`, REST routes
- Full test suite: 39/39 tests passing

---

## **7. Target Platform Architecture**

### 🔄 7.2 — Asynchronous Execution Standard

**Status:** In Progress — shared library + automation-run-step adoption complete; LinkedIn outreach and sequence-enrollment adoption are separate follow-up plans (per the design doc's own rollout order).  
**Completed (this slice):** 2026-08-28  
**Branch:** `feature/7.2-async-execution-standard`  
**Design doc:** `docs/superpowers/specs/2026-08-28-async-execution-standard-design.md`  
**Plan (1 of 3):** `docs/superpowers/plans/2026-08-28-execution-intent-automation-run.md`

**Delivered:**
- Shared claim/heartbeat/reclaim/backoff/idempotency execution-intent library at `packages/shared/src/execution-intent/` (`claimNext`, `withLeaseHeartbeat`/`renewLease`, `reclaimExpiredLeases`, `recordResult`, `classifyRetry`/`computeBackoffDelay`, `buildIdempotencyKey`) — generic over a structural `ExecutionIntentTable` TS interface, no `sql.raw()`/string-interpolated identifiers anywhere (uses Drizzle's typed `.for("update", {skipLocked:true})` inside a transaction, plus narrow documented `as` casts on real column/table objects only).
- Corrected the original task-list premise: Warm-Up-Tool's execution-intent state machine lives in a sibling repo (`Skout-Warm-Up-Tool`), not this one, and — confirmed by reading it directly — isn't even shared *there* (a second module hand-rolled a near-duplicate). This library is the first place the pattern is actually generalized into one reusable implementation.
- `automation_run_steps` (§8.14) retrofitted as the first adopter: migration `0074_automation_run_steps_execution_intent.sql` adds `idempotency_key`/`lease_owner`/`lease_expires_at`/`attempt_count`, drops the now-superseded `attempt`/`claimed_at`/`claimed_by_worker`/`heartbeat_at`/`next_retry_at`. `automation-run.service.ts` and `automation-run.worker.ts` retrofitted onto the shared library.
- Fixed the two live bugs found during design research: `heartbeatStep` was dead code (zero call sites) — replaced with a genuinely-wired `withLeaseHeartbeat` around every step execution; there was no lease-timeout reclaim at all — added a 30s sweep (`reclaimExpiredLeases`) in the worker's startup loop.
- New `outcome_unknown` reconciliation status wired end-to-end for the HTTP action node: a 5xx response or a network/timeout error is now routed to manual reconciliation instead of being silently retried or misclassified as a clean failure (`AmbiguousOutcomeError`, `NodeHandlerResult.outcome`).
- Tests: 98/98 in `@skout/shared` (incl. real-Postgres concurrency/reclaim/lease-renewal integration tests proving exclusive claiming under concurrent callers), 57/57 in `apps/api`'s automation slice. Full workspace typecheck clean.

**Reference implementation (verified, not assumed):** the real Warm-Up-Tool `warmup_execution_intents` state machine (`PENDING→CLAIMED→SENDING→SENT/FAILED/SEND_UNKNOWN`, lease-based `FOR UPDATE SKIP LOCKED` claiming, `SEND_UNKNOWN` as a structurally-excluded-from-retry ambiguous state) — read directly from the sibling repo during design, confirmed to match the task list's description, and used as this library's design reference.

**Not in this slice:** LinkedIn outreach adoption (fixes a real bug found during design research — `claimJob`'s hot path never actually claims before sending, allowing a re-claim race) and sequence-enrollment adoption (consolidates two existing ad hoc retry systems) are scoped as 2 separate follow-up plans. Calling jobs are explicitly out of scope for §7.2 entirely (see design doc's Non-goals) — calling is fully synchronous today with no queue/intent record at all; bringing it onto this library requires first making it asynchronous, a separate architectural decision.  
**Prerequisite for:** §9.0 (once fully adopted)

---

### ⬜ 7.3 — Dexter AI SDR Service Architecture

**Status:** Not Started  
**Completion Criterion:** Orchestrator + Policy & Approval Gateway built; event spine (`icp.approved`, `tam.approved`, `regional_brief.approved`) wired at existing approval points; decision made on BullMQ vs event bus.  
**Prerequisite for:** §8.7, §10.4  
**Note:** §12 event envelope (`SkoutEvent<T>`) is now ready for Dexter to consume.

---

## **8. Detailed Product Domains**

### ✅ 8.6 — Outreach and Sequence Studio

**Status:** Complete  
**Completed:** Pre-existing + audit pass completed 2026-08-25  
**Branch:** `feature/6.2-6.3-regional-intelligence`

**Delivered / Confirmed:**
- A/B/C execution modes with Mode C ("God Mode") enforced approval gate
- 11 branch conditions wired end-to-end
- Merge-tag validation
- `sequence.service.ts` + `sequence-enrollment.worker.ts` confirmed complete

---

### ⬜ 8.7 — Dexter AI SDR — Separate Service and Customer-Facing AI

**Status:** Not Started  
**Completion Criterion:** Command center UI surfacing approved versions, reasoning, pending approvals, spend, experiments, policy blocks. Autonomy modes configurable per tenant/segment/channel/action/risk.  
**Blocked by:** §7.3 Orchestrator + Policy Gateway  

---

### ✅ 8.8 — LinkedIn Workspace

**Status:** Complete  
**Completed:** 2026-08-26 (PR opened + hardened 2026-08-27/28)  
**Branch:** `feature/8.8-10.5-linkedin-workspace-voice`  
**PR:** [Backend #61](https://github.com/sailishkang-skout/Skout-AI-Backend/pull/61)

**Delivered:**
- `linkedin-outreach.js` Voyager-API path verified dead code & marked formally deprecated with audit note.
- Confirmed all LinkedIn actions (invites, messaging, chats, relations) route through Unipile backend.
- Passive DOM scraping scripts audited for legal sign-off workflow.
- LinkedIn Voice Studio (`/linkedin/voice`) — Create → Review → mobile handoff → manual confirm (no auto-send).
- Follow-up commit on the same branch: dedicated `linkedin-voice.service.ts`, 1st-degree gate with no client bypass, CRM timeline writeback, `/linkedin/voice/h/[token]` handoff page.
- Frontend: 4-step wizard UI (`voice-wizard.tsx`) + mobile handoff page (`voice-handoff-client.tsx`) on `Skout-AI-Frontend@feature/8.8-10.5-linkedin-workspace-voice`.

**Bug fixes found dogfooding the branch end-to-end (all on PR #61):**
- Unipile DSN normalization — Unipile's dashboard shows the DSN without a scheme; a schemeless value crashed `fetch()` before reaching Unipile, surfacing as opaque `provider_validation_failed`.
- Wrong account id sent to Unipile's relations API — was passing Skout's internal `linkedin_accounts.id` instead of `unipileAccountId`, so a real 1st-degree connection would 404 and never resolve as eligible. Regression test added.
- Missing `/app` basePath on the mobile handoff URL — every other backend-generated frontend link already accounted for Next's `basePath: "/app"`; the voice handoff link was the one outlier, so the QR code 404'd on a real phone.
- CI's §7.1 architecture gate flagged `linkedin-voice.service.ts`'s direct `contacts`/`activities` reads — documented as an ADR 0003 exception (confirmLinkedinVoiceSent's synchronous CRM-timeline writeback on the rep's confirm click).

---

### ✅ 8.10 — Email Intelligence, Mailbox and Deliverability

**Status:** Complete  
**Completed:** Pre-existing (confirmed complete during audit 2026-08-25)

**Delivered / Confirmed:**
- Dead Email-Intelligence-Tool warmup engine removed (zero importers confirmed)
- Typo-suggestion UX wired (`INVALID` + suggested correction)
- Send guard never bypassed
- Warm-Up-Tool verified as reference implementation

---

### ✅ 8.11 — Global Numbers and Voice

**Status:** Complete (marketplace slice; live copilot deferred)  
**Completed:** 2026-08-28  
**Branch:** `feature/8.11-9-telnyx-marketplace`  
**PR:** [Backend #62](https://github.com/sailishkang-skout/Skout-AI-Backend/pull/62)  
**Unblocked:** 2026-08-27 — Telnyx KYC enrollment confirmed.  
**Already shipped pre-marketplace:** Click-to-call + SMS via `telnyx.service.ts` / `/settings/calling`.

**Delivered:**
- Live Telnyx inventory search (`GET /numbers/available`) by country/type/area code/city/capability
- Regulatory requirements lookup (`GET /numbers/requirements`), document upload (`POST /numbers/requests/:id/documents`), requirement-group fulfillment, compliance submission/review
- Order placement via `/number_orders` onto `TELNYX_CONNECTION_ID`, with poll/refresh
- Active marketplace-provisioned DID now used as click-to-call caller ID (`TELNYX_PHONE_NUMBER` env remains the fallback)
- Frontend: `/settings/numbers` page (search, request, workspace-requests tracker) on `Skout-AI-Frontend@feature/8.11-9-telnyx-marketplace`

**Bug fixes found dogfooding the branch (all on PR #62):**
- E.164 validation gap on the click-to-call agent phone (`user.routes.ts`) — the save regex made the leading `+` optional, so a bare national number passed validation and Twilio later rejected it outright on the first call leg with an opaque error.
- Country/Area code/City search fields used a native `<datalist>` that overlapped neighboring fields regardless of layout; replaced with a self-contained scoped combobox (frontend).
- "Request" button gave no feedback on click (frontend) — now shows a per-row pending label, an inline error, and auto-scrolls to the result on success.
- CI's §1 architecture gate required the PR description to formally answer whether `numberRequests`/`numberRequestEvents` fork existing canonical state (they don't — genuinely new state per §9.0/§9.1).

**Not in this slice:** Live copilot for calling (deferred per the vision doc, "Live copilot stays later").

---

### ⬜ 8.13 — AI Command Bar and Copilots

**Status:** Not Started  
**Completion Criterion:** Pre-action preview step built into the tool-calling framework (scope / assumptions / affected record count / credit-cost / external side effects + explicit confirmation for non-trivial actions). Four copilots converged onto one shared evidence ledger once §6.0 lands.  
**Blocked by (soft):** §6.0 shared evidence ledger (for copilot convergence only; preview step is independent)

---

### ✅ 8.14 — Automation and Integrations

**Status:** Complete  
**Completed:** 2026-08-28  
**Decision:** Replaced n8n with a native Workflow Studio (ReactFlow-based visual block editor), not retain-and-embed.  
**Backend branch:** `feature/8.14-workflow-studio` (Skout-AI-Backend) — 5 new tables (`automations`, `automationVersions`, `automationRuns`, `automationRunSteps`, `automationSecrets`; named "automation" not "workflow" to avoid a collision with D15's existing `workflowRuns`/`workflow_runs`), draft/publish versioning matching `sequence.service.ts`'s pattern, a claim/heartbeat/complete/fail run-step engine on BullMQ, and 8 node-type handlers (trigger, condition, delay, action_http, action_notification, action_crm_writeback, action_sequence_enroll, approval — the last via the existing Policy Gateway). Routes registered at `/automations` (not `/workflows`, same collision reason). 1198 tests passing.  
**Frontend branch:** `feature/8.14-workflow-studio` (Skout-AI-Frontend) — `reactflow` canvas with a per-node-type config panel, and the `/workflows` + `/workflows/[id]` pages replaced (the old page was an explicit D15 stopgap wrapping `workflow_runs`; the pre-existing sidebar/tour entries needed no changes). 111 tests passing; `next build` verified for both routes.  
**Completion criterion (per the vision doc):** Visual block editor compiling to a versioned execution definition, test/simulation mode before publish, per-step input/output visibility with masked secrets, native integrations for the highest-volume connectors with n8n-equivalent generic webhook connectors for the long tail — met for this slice's 8 node types; simulation mode runs the same graph with `isSimulation: true` on the run record, real per-node connectors (LinkedIn, AI, enrichment) explicitly deferred (see design doc's Non-goals).  
**Note:** `activation-rules.service.ts`'s bounded-autonomy engine didn't need rework — this is a new UI/execution-definition layer on top of it.  
**Design doc:** `docs/superpowers/specs/2026-08-28-workflow-studio-design.md`  
**Not yet dogfooded live in a browser** — verified via unit tests, typecheck, lint, and a production `next build`; still needs a manual click-through with the backend + Postgres + Redis running before merging.

---

## **9. Global Number Provisioning State Model**

### ✅ 9.0 — Global Number Provisioning State Model

**Status:** Complete  
**Completed:** 2026-08-28  
**Branch:** `feature/8.11-9-telnyx-marketplace` (ships with §8.11)  
**PR:** [Backend #62](https://github.com/sailishkang-skout/Skout-AI-Backend/pull/62)  
**Delivered:** 11-state machine in `number-request.service.ts` — `requested → selected → requirements_pending → compliance_submitted → compliance_review → ordering → provisioning → active / failed / expired / cancelled`, with an explicit `ALLOWED_TRANSITIONS` table so an illegal transition is a defined error, not a silent overwrite. 13 tests covering legal/illegal transitions and full lifecycle.

---

### ✅ 9.1 — Minimum Request Data

**Status:** Complete  
**Completed:** 2026-08-28  
**Branch:** `feature/8.11-9-telnyx-marketplace`  
**PR:** [Backend #62](https://github.com/sailishkang-skout/Skout-AI-Backend/pull/62)  
**Delivered:** `number_requests` table (~25 fields — tenant/workspace/requester, country/region/city/area_code, number_type, quantity, requested_capabilities, provider IDs, phone_number, status, compliance_status, requirement_snapshot, required_documents, submitted_document_versions, failure/rejection reason, assignment, timestamps, idempotency_key) plus a companion `number_request_events` table logging every state transition for audit. Migrations `0072_number_requests.sql` / `0073_number_request_requirement_group.sql`.

---

## **10. Cross-Domain Workflows**

### ⬜ 10.4 — Dexter Approval-to-Learning Lifecycle

**Status:** Not Started  
**Blocked by:** §7.3 Orchestrator + Policy Gateway  
**Completion Criterion:** Outcomes attach to original hypothesis via shared event spine; learning-update recommendations require explicit evidence/sample-size threshold; material changes require human approval.

---

### ✅ 10.5 — LinkedIn AI Voice Message

**Status:** Complete  
**Completed:** 2026-08-26 (follow-up hardening 2026-08-27)  
**Branch:** `feature/8.8-10.5-linkedin-workspace-voice`

**Delivered:**
- Flow: eligibility → regional-aware script draft → personal voice (default) or optional TTS preview → mobile handoff → user sends in LinkedIn app → confirm → timeline
- No background / Unipile send of voice notes
- Synthetic audio is cadence preview only; it is never uploaded to LinkedIn

---

## **12. API, Event and Integration Standards**

### ✅ 12.0 — API, Event and Integration Standards

**Status:** Complete  
**Completed:** 2026-08-26  
**Branch:** `feature/12-api-event-integration-standards`

**Delivered:**
- **Versioned Event Envelope** (`packages/shared/src/event-envelope.ts`)
  - `SkoutEvent<T>` interface: `id` / `type` / `version` / `tenantId` / `aggregateId` / `correlationId` / `occurredAt` / `data`
  - `createEvent()` factory with auto-UUID and correlation chain threading
  - `isSkoutEvent()` type guard with version-mismatch rejection
  - Exported from `@skout/shared`
- **Event Type Registry** (`SKOUT_EVENT_TYPES`, `DEXTER_EVENT_TYPES`, `SEQUENCE_EVENT_TYPES`)
  - 16 canonical event types (3 sequence + 13 Dexter event spine)
  - `webhook.service.ts` `WEBHOOK_EVENT_TYPES` expanded to include full Dexter spine
- **Inbound Webhook Verification** (`apps/api/src/lib/inbound-webhook-verify.ts`)
  - `verifySkoutInboundSignature()` — Skout-native HMAC-SHA256 with 5-min replay window
  - `verifyTelnyxWebhook()` — Telnyx HMAC verification, soft enforcement for TeXML callbacks
  - `verifyGenericHmacWebhook()` — configurable verifier for any `<timestamp>.<body>` provider
  - Timing-safe comparison, stateless horizontal scaling, logging on all failures
- **Wired into routes**:
  - `call.routes.ts`: Telnyx status callbacks now verified (soft enforcement)
  - `unipile-webhook.routes.ts`: audit comment + verification ready for Unipile signing when available
- **Tests:** 22 tests — 10 event envelope + 12 inbound verify — all passing

---

## **19. Source Notes**

### 📋 19.0 — Source Notes (periodic verification task)

**Status:** Periodic (not a one-time build)  
**Action:** Re-verify LinkedIn API terms + Telnyx regulatory documentation at the start of each Phase 4/6 build sprint.  
**Last verified:** 2026-08-25 (kickoff). LinkedIn product path used Unipile (no Voyager send) for §8.8/§10.5.  
**Last verified:** 2026-08-27 (marketplace slice). Telnyx v2: `GET /available_phone_numbers` (country_code required), `GET /requirements`, `POST/GET /number_orders`.  
**Last verified:** 2026-08-28 — Requirement Groups and document upload shipped; §8.11/§9.0/§9.1 marketplace slice complete end to end (PR #62).

---

## **Recommended Build Sequence (remaining)**

| # | Task | Reason |
|---|---|---|
| 1 | ~~§12.0 Event Standards~~ ✅ | Done |
| 2 | ~~§8.8 + §10.5~~ LinkedIn & Voice Handoff ✅ | Done |
| 3 | ~~§8.11 + §9.0 + §9.1~~ Telephony Marketplace ✅ | Done |
| 4 | ~~§8.14~~ Automation & Integrations — native Workflow Studio ✅ | Done — needs a live browser dogfooding pass before merge |
| 5 | 🔄 §7.2 Async Execution Standard — library + automation-run-step | Shared claim/heartbeat done; done |
| 6 | **§7.2** LinkedIn outreach adoption (plan 2 of 3) | Fixes a real claim-race bug found during design |
| 7 | **§7.2** Sequence-enrollment adoption (plan 3 of 3) | Consolidates 2 existing ad hoc retry systems |
| 8 | **§7.3** Dexter Orchestrator & Policy Gateway | Unlocks §8.7, §10.4 |
| 9 | **§8.7** Dexter Command Center UI | Requires §7.3 |
| 10 | **§10.4** Approval-to-Learning Lifecycle | Requires §7.3 |
| 11 | **§6.0** Intelligence Layer Boundary | Unlocks §8.13 copilot convergence |
| 12 | **§8.13** AI Command Bar | Preview step is independent; convergence needs §6.0 |
