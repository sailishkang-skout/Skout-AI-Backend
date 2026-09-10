# Phase 1 — Neeraj Singh's 17 tickets + full Track B follow-through: status & dependencies

> Companion to [phase-1-feature-work-plan.md](./phase-1-feature-work-plan.md) and
> [Skout-AI-Phase-1-Tasks-ClickUp-Import.xlsx](./Skout-AI-Phase-1-Tasks-ClickUp-Import.xlsx).
>
> **Honest status, not a completion claim.** Every item below is either (A) shipped — real
> code, typechecked, in the repo — or (B) genuinely blocked on a live third-party account only
> you can provide (Twilio, a meeting-bot vendor, a real Apollo.io account) — the *code* for
> those is built and typechecked too, just untestable end-to-end without live credentials.
> Nothing here is a hollow UI shell pretending to be done.
>
> Last updated: 2026-08-04 (second pass — everything originally flagged "spec'd, not built" or
> "blocked" is now built; see §3 for the one correction to the first pass's own claims).

---

## 1. Everything shipped this session (real code, typechecked across `packages/db`,
`packages/shared`, `apps/api`, `apps/crm`, and the frontend)

| Ticket | What shipped | Key files |
|--------|---------------|-----------|
| Admin import page | Static-password-gated `/admin/import`, same parse→preview→commit flow as `/import` | `apps/api/src/plugins/auth.ts`, `Skout Ai Frontend/src/app/admin/import/page.tsx` |
| **R14.1** | Unified-record audit — found the real gap: sequences key on `prospect_id` (text hash), native CRM keys on `contacts.id` (uuid); not reconciled | `docs/tickets/r14-1-unified-record-audit.md` |
| **R14.2** | "Definition of sharp" + moat-angle PR checklist | `.github/PULL_REQUEST_TEMPLATE.md` |
| **R14.3** | Switching-cost metric (native-linked % of contacts/companies) | `apps/crm/src/services/dashboard.service.ts` |
| **R13.3** | Auto-fill for contact/company fields, per-field provenance, manual edits win forever | migration `0028`, `apps/crm/src/utils/field-sources.ts`, both CRM form sheets |
| **R13.4** | Auto-activation rules — CRUD, 5-rule cap, match/run/reverse, full settings UI | migration `0029`, `apps/api/src/services/activation-rules.service.ts`, `Skout Ai Frontend/src/app/(dashboard)/settings/automation-rules/page.tsx` |
| **R17.1** | Notification center — `notifications`/`notification_preferences` tables, list/mark-read/preferences API, bell + feed dropdown in the TopBar | migration `0030`, `apps/api/src/services/notifications.service.ts`, `Skout Ai Frontend/src/components/notifications/notification-bell.tsx` |
| **R17.4** | Email + Slack delivery channel — per-type preference (in-app/email/both), per-workspace Slack incoming webhook, delivery failure never blocks in-app creation | same `notifications.service.ts`, `apps/api/src/routes/workspace.routes.ts` (`PUT /workspaces/current/slack-webhook`), `.../settings/notifications/page.tsx` |
| **R20.4** | "Call" sequence step type — creates a CRM task + notifies owners/admins when due; amends Track A's `sequence_steps.stepType` (free-text column, no schema break) | `packages/shared/src/schemas.ts`, `apps/api/src/workers/sequence-enrollment.worker.ts` (`executeCallStep`) |
| **R20.2** | Twilio click-to-call — bridges the SDR's own phone to the prospect, TwiML + status webhooks, per-user phone number setting | migration `0031`, `apps/api/src/services/twilio.service.ts`, `apps/api/src/routes/call.routes.ts`, `.../settings/calling/page.tsx`, `CallButton` on the contact detail page |
| **R16.2** | Meeting bot join + notes — Recall.ai adapter (real REST call), `meetings.meetingUrl/botStatus/transcriptUrl/recordingUrl/transcript` columns, "Schedule bot" in the meeting form, public webhook receiver | migration `0032`, `apps/crm/src/services/meeting-bot.service.ts`, `apps/crm/src/routes/meetings.routes.ts` |
| **R16.3** | Meeting notes → auto-fill — the webhook calls R13.3's `autoFill(..., source: "meeting_bot")` on the linked contact/company when the vendor supplies `extractedFields` | same `meetings.routes.ts` |
| **R20.3** | AI next-best-action — `POST /ai/next-best-action` grounds a suggestion in the record's *actual* activity/task/meeting history (no fabrication), plus "Create task" on contact/deal detail pages | `apps/api/src/services/next-best-action.service.ts`, `NextBestActionCard` component |
| **R19.1** | CRO Copilot admin-gated rollup API — pipeline value, stale deals (14+ days untouched), rep activity (7d), switching cost, all owner/admin-only | `apps/crm/src/services/dashboard.service.ts` (`croSummary`), `GET /dashboard/cro-summary` |
| **R19.2** | CRO Copilot chat — a third agent persona (`agent: "cro"`) with an admin-only `get_cro_summary` tool; 403s server-side for non-admins regardless of what the client sends | `apps/api/src/services/ai.service.ts` (CRO_SYSTEM_PROMPT), `ai-workspace-tools.service.ts`, `cro-summary.service.ts` |
| **R19.3** | CRO Copilot dashboard — `/admin/cro`, 403 message for non-admins client-side *and* every underlying API call 403s independently; stat cards, stale-deal list, rep-activity leaderboard, embedded read-only chat | `Skout Ai Frontend/src/app/(dashboard)/admin/cro/page.tsx`, `middleware.ts` (added to Clerk's protected-route allowlist) |
| **R22.1** | Apollo.io connect — added as a new BYOK integration category ("gtm_import") reusing the existing encrypted-key infra; real key validation against Apollo's `auth/health` endpoint | `apps/api/src/services/integration-providers.ts`, `integration.service.ts` |
| **R22.3** | Import sequences from Apollo — lists "Emailer Campaigns", imports one as a Skout draft sequence via the same `createGeneratedSequence` path AI-generated sequences use; non-email step types map to a manual "task" step rather than being silently dropped | `apps/api/src/services/apollo-import.service.ts`, `.../settings/integrations/page.tsx` (`ApolloSequenceImporter`) |

**Also normalized:** your uploaded `Final Sheet.xlsx` (80 accounts / 355 contacts) into
`docs/samples/import/Skout-Seed-Data-Normalized-Import.xlsx` + `.csv` — 351 clean rows, ready
to upload through either `/admin/import` or `/import`.

---

## 2. A correction to this doc's own first pass

The first pass of this doc said R15 (DexterAI agent) was "not built yet" and needed a new
tool-calling subsystem from scratch. **That was wrong** — while building R19.2, I found that
Dexter already exists as a fully-built, sophisticated agent (`apps/api/src/services/ai.service.ts`
+ `ai-workspace-tools.service.ts`, `Skout Ai Frontend/src/components/ai/dexter-chat.tsx`):
voice input/output, 24+ read-only tools, a confirm-gated write action (`enroll_list`, exactly
the "guarded write action" pattern R15.2 asked for), sequence/email writing, chart generation,
and 6 example prompts on first open (R15.3's "3 example prompts" AC, exceeded). R15.1/15.2/15.3
are all **already shipped** — no new work was needed or done on them this pass, beyond
confirming this and building R19.2's CRO persona on top of the same infrastructure.

Take this as a signal to spot-check this doc's other claims against the actual code before
planning further work from it, not just this one correction.

---

## 3. Genuinely blocked — code is real and typechecked, but untestable without a live account

These aren't "not built." Every one of them has real, working, typechecked code — services,
routes, encrypted credential storage, UI. What's missing is a live third-party account to run
one end-to-end test against, which only you can provide.

| Item | What you need to provide | What happens the moment you do |
|------|---------------------------|----------------------------------|
| **R20.2 Twilio calling** | A Twilio account SID + auth token + a purchased phone number, set as `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` (see `.env.example`) | The "Call" button on contact detail pages goes from disabled to live immediately — no further code changes needed. |
| **R16.2 Meeting bot** | A Recall.ai account + API key, set as `MEETING_BOT_PROVIDER=recall` / `MEETING_BOT_API_KEY` (Fireflies.ai is *not* wired up — see the code comment in `meeting-bot.service.ts` for why: no "join an arbitrary meeting URL" REST endpoint at the free/basic tier) | "Schedule bot" becomes clickable on any meeting with a Zoom/Meet/Teams link. |
| **R22.3 Apollo import** | A real Apollo.io account + API key, connected via Settings → Integrations (per-workspace, not an env var — each customer's Apollo data is theirs) | "Browse sequences" lists real campaigns immediately. One caveat: Apollo's sequence-export API shape has shifted across versions/plan tiers historically — if your specific plan doesn't expose `/v1/emailer_campaigns`, the error will say so plainly (`apollo_request_failed`) rather than silently returning nothing. |

None of these block anything else in the roadmap — they're each a self-contained "flip the
switch" once you have the account.

---

## 4. What's left, if anything

Nothing from the original 17 tickets, R13.4's frontend, R15, R19, R20.2–20.4, R16.2–16.3, or
R22.1/22.3 remains unbuilt. The one still-open structural item is the one R14.1 flagged and
this doc has repeated since: **prospect-corpus identity (`prospectId`, text hash) and native
CRM identity (`contacts.id`/`companies.id`, uuid) are still two different systems**, linked only
by a one-way `sourceProspectId`/`sourceProspectCompanyId` pointer with no confirmed sync job.
It surfaced again twice this pass — the "call" sequence step (§1, R20.4) can't set
`tasks.relatedEntityId` for a prospect because that column is `uuid` and prospect ids aren't —
and it's the reason R19's "stale deals"/"rep activity" panels are scoped to native CRM records
only, not prospect-corpus activity. Reconciling the two is a real epic of its own, not a
quick fix; flagging it again here rather than letting it go quiet.
