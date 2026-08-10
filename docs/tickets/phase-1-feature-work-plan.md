# Skout AI — Phase 1 Feature & Work Plan (v2)

> Supersedes-by-extension the Phase 1 definition in
> [master-prd-implementation.md §5](../master-prd-implementation.md) and the R1–R4 epics in
> [remaining-features-build-order.md](./remaining-features-build-order.md). Those epics are
> **not restarted** here — they're carried forward as Track A. This doc adds **Track B**: the
> 15 strategic items requested for Phase 1, turned into epics/stories in the same format.
>
> Status legend: ✅ done · 🟡 in progress · 🔴 not started
> Estimates in story points (SP): 1≈½ day, 2≈1 day, 3≈2 days, 5≈3–4 days, 8≈1 week, 13≈2 weeks.
>
> Last updated: 2026-08-03

---

## 1. What changed vs. the current Phase 1 definition

The repo's current Phase 1 ("Outreach loop") is scoped tightly: search → list → enroll →
send → receive reply → sequence pauses, without leaving Skout (R1–R4). That scope stands —
it's close to done and shouldn't be paused.

The 18 items below (the original 15, plus Tasks, GTM-provider import, and calls-in-sequences)
are additional strategic asks for Phase 1. Several of them (TAM builder,
signal overlays, meeting intelligence, forecasting/risk, AI copilot) were originally slotted
into Phase 3/4 in `master-prd-implementation.md`. Pulling them into Phase 1 is a real scope
expansion, not a relabeling — flagged explicitly in [§6 Risks](#6-risks--open-assumptions) so
it's a conscious call, not a scope-creep accident.

To keep this actionable, Phase 1 is now split into two parallel tracks:

- **Track A — Finish the outreach loop.** Already-defined R1–R4 epics. Keep shipping; do not
  reset priority. See [remaining-features-build-order.md](./remaining-features-build-order.md).
- **Track B — Strategic expansion.** The 15 new items, scoped down to a Phase-1-appropriate
  MVP each (not the full Phase 3/4/5 vision from the PRD).

---

## 2. Phase 1 goal & exit criteria (updated)

**Goal:** An SDR can find prospects, qualify them against a live (not static) universe,
get AI-drafted outreach reviewed and sent, see replies pause the sequence, get notified
when a deal needs attention, and have basic meeting/calendar + CRM field auto-fill working
— all without leaving Skout, and without hand-maintained static lists as the backbone.

**Exit criteria:**

| # | Criterion | Track |
|---|-----------|-------|
| 1 | SDR: search → list → enroll → send → reply → pause, in-app | A (existing) |
| 2 | Every "list" in the product is dynamic/signal-driven by default; static lists are legacy-only | B |
| 3 | Search/scoring filters include tech-stack + intent signals, not just firmographic + hiring | B |
| 4 | At least 3 high-friction manual steps are automated (draft review routing, field fill, re-scoring) | B |
| 5 | SDRs get proactive notifications (hot signal, reply, task due) instead of having to check the app | B |
| 6 | One calendar provider (Google) syncs meetings; a meeting bot can join and produce notes | B |
| 7 | Admins have a restricted CRO-level rollup view distinct from the SDR/AE workspace | B |
| 8 | A first-pass "DexterAI" agent can answer at least 3 natural-language product questions | B |
| 9 | Reps can create, assign, and manage their own tasks — not just system-generated ones | B |
| 10 | A workspace can import existing contacts/lists from Apollo.io (or another GTM tool) instead of re-building them by hand | B |
| 11 | A sequence can include a "call" step, not just email/LinkedIn/wait/task | B |

---

## 3. Where things stand today (from repo docs)

| Area | Status | Source |
|------|--------|--------|
| Search, ICP scoring, waterfall enrichment, static lists, smart lists | ✅ Shipped | `skout-ai-feature-guide.md` §3 |
| Sequences / inbox / deliverability / AI review queue | 🟡 In progress (R1–R4) | `remaining-features-build-order.md` |
| Signals (search filter only: intent score, hiring, tech stack) | 🟡 Filter exists; no dedicated store, no overlay UI, no funding/leadership signals | `skout-ai-feature-guide.md` §3.3, `remaining-features-build-order.md` R6.5 |
| Smart lists (dynamic, filter-based) | ✅ Shipped, but static `lists` still primary UX pattern | `skout-ai-feature-guide.md` §3.8–3.9 |
| AI copilot / NL control plane | 🔴 Not started | `master-prd-implementation.md` §2 |
| Meeting intelligence / calendar | 🔴 Not started | `master-prd-implementation.md` Phase 4 |
| Forecasting / risk / deal coach | 🔴 Not started | `master-prd-implementation.md` Phase 4 |
| Notifications | 🔴 No notification system exists | gap — not in any current doc |
| CRM native entities (contacts/companies/deals) | 🔴 Not started (HubSpot push only) | `master-prd-implementation.md` Phase 2 |
| Workflow automation / triggers | 🔴 Not started | `master-prd-implementation.md` Phase 5 |

---

## 4. The 18 items → epics (mapping table)

| # | Item (as given) | Interpretation | Epic |
|---|------------------|-----------------|------|
| 1 | Kill Static List | Make dynamic/signal-driven lists the default; static lists become an explicit legacy/manual mode, not the primary object | **R10** |
| 2 | Add Tech signals and not only signals | Broaden the signal taxonomy beyond intent/hiring to tech-stack changes (adopted/dropped tools), not just filter-time tech detection | **R11** |
| 3 | Sharpen Features | Quality bar / polish pass — cross-cutting, not a standalone epic | **Cross-cutting**, see §5.12 |
| 4 | Automate Things/Features | Automation core: rules/triggers that remove manual steps (re-score on ICP change, auto-route drafts, auto-activate) | **R13** |
| 5 | MOTE → moat: what makes users stay on the platform | Product moat / stickiness — deepen switching costs via unified workflow, not a generic "engagement" feature | **R14** |
| 6 | Build TAM | Total Addressable Market builder — define + size an account universe from ICP, track fill rate | **R12** |
| 7 | Overlay Signals | Visualize signals (tech, hiring, funding, intent) layered on TAM/lists/company records | **R11** |
| 8 | DexterAI agent | Named AI copilot — Phase-1 MVP scoped to a few grounded tool calls, not the full PRD copilot | **R15** |
| 9 | Meeting Bot and various Calendar Sync | Calendar OAuth sync + a bot that joins calls and produces notes/summary | **R16** |
| 10 | Notify SDR / Reminder → Notification | Notification center + reminders (task due, sequence step, reply) | **R17** |
| 11 | Risk Detection | Early deal/account risk flags from activity + signal patterns | **R18** |
| 12 | Auto filled fields | Auto-populate CRM/contact fields from enrichment, meeting notes, and email parsing | **R13** |
| 13 | CRO Copilot — Only For Admin | Admin-gated exec rollup: pipeline/team/signal summary, not the SDR workspace | **R19** |
| 14 | Auto Alert and SDR | Signal-triggered alerts routed to the owning SDR (hot lead, risk, reply) | **R17** |
| 15 | Notes and Suggestions, Calling — Sales and Marketing | Call/meeting notes capture + AI next-best-action suggestions, usable by both sales and marketing | **R20** |
| 16 | Tasks — users should be able to create tasks | Native task entity + CRUD/views, not just system-generated reminders | **R21** |
| 17 | Add Apollo.io, or other GTM provider | Import existing contacts/lists (and stretch: sequences) from Apollo.io or similar tools — Apollo is already a PAL enrichment provider; this is a separate "migrate my data in" path | **R22** |
| 18 | Calls should be present in sequences | Add "call" as a sequence step type, amending R1.1 | **R20.4** (amends R1.1) |

---

## 5. Epics & stories (Track B — new)

### R10 — Kill Static List (dynamic-by-default lists)

> Today: `lists` (static, manually curated) is the primary object; `smart_lists`
> (filter-based, dynamic) exists but is secondary. This epic flips the default.

**R10.1 — Smart lists as the default list-creation path**
Description: Change "New list" UX/API default to smart-list (filter-based) creation; static list becomes an explicit "manual/pinned list" option under an advanced toggle.
Acceptance Criteria:
- [ ] `POST /lists` default flow creates a `smart_lists` filter set, not a bare static list.
- [ ] Static list creation still available (imports, manual adds, CSV) but requires explicit opt-in.
- [ ] Existing static lists unaffected; migration is additive only.
Dependencies: none (`smart_lists` exists)
Estimate: 5 · Labels: prospecting, backend, frontend

**R10.2 — Auto-refresh cadence for dynamic lists**
Description: Dynamic lists re-run their filters on a schedule (not just on manual "run"), refreshing membership and surfacing new/dropped matches.
Acceptance Criteria:
- [ ] Configurable refresh interval per smart list (e.g. daily/weekly).
- [ ] Diff view: newly added vs. dropped members since last refresh.
- [ ] Refresh is credit-aware and skips if it would exceed budget; user notified either way.
Dependencies: R10.1, R17 (notifications)
Estimate: 8 · Labels: prospecting, backend

**R10.3 — Static-list deprecation path in UI**
Description: Surface a nudge on existing static lists ("Convert to dynamic list") and update onboarding/empty states to lead with smart lists.
Acceptance Criteria:
- [ ] Static list detail shows a one-click "Convert filters to smart list" where feasible.
- [ ] Onboarding empty state defaults to "Build a dynamic list" CTA.
Dependencies: R10.1
Estimate: 3 · Labels: prospecting, frontend

---

### R11 — Signal expansion (tech signals + overlays)

> Today: signals are a search-time filter only (intent score, hiring, tech stack), computed
> per-query. No persistent signal store, no funding/leadership signals, no overlay view.
> Builds directly on R6.5 (`remaining-features-build-order.md`).
>
> **Moat (R14.2):** signals only earn their keep by being cross-referenced against the ICP,
> score, and activity data already unified in one workspace — a downloaded contact list has no
> live signal feed to overlay on top of it.

**R11.1 — Tech-stack change signals (adopted/dropped)**
Description: Beyond static tech-stack detection at scrape time, detect and store *changes* (tool adopted, tool dropped, migration) as a typed signal with timestamp and provenance.
Acceptance Criteria:
- [ ] `signals[]` includes `tech_adopted` / `tech_dropped` with tool name, detected date, source.
- [ ] Signal generated when re-crawl detects a delta vs. last snapshot.
- [ ] Surfaced on company/prospect detail and in search filters.
Dependencies: R6.3, R6.5 (corpus/crawl pipeline)
Estimate: 8 · Labels: corpus, backend

**R11.2 — Unified signal store**
Description: Formalize a `signals` table/index (per PRD entity list) so all signal types (intent, hiring, funding, leadership, tech) live in one queryable place instead of ad hoc fields.
Acceptance Criteria:
- [ ] Single schema: `signal_type`, `entity_id`, `value`, `confidence`, `detected_at`, `provenance`.
- [ ] Existing signal sources (search filters, scraper collectors) write to it.
- [ ] `GET /api/v1/signals?entityId=` returns a normalized timeline.
Dependencies: none
Estimate: 5 · Labels: corpus, backend

**R11.3 — Signal overlay UI**
Description: Visual overlay of active signals on company records, lists, and TAM view (badges/icons: 💰 funding, 📈 hiring, 🔧 tech change, 🎯 intent spike) instead of buried in a filter panel.
Acceptance Criteria:
- [ ] Company/prospect card shows top 3 active signals as badges with recency.
- [ ] List/TAM table view supports "overlay signals" column toggle.
- [ ] Clicking a badge shows signal detail (source, date, confidence).
Dependencies: R11.2, R12 (TAM view)
Estimate: 5 · Labels: frontend, corpus

---

### R12 — Build TAM (Total Addressable Market)

> New capability: turn ICP into a sized, trackable account universe — not just an ad hoc
> search result set.
>
> **Moat (R14.2):** the TAM coverage funnel (total → activated → enriched → contacted →
> replied → deal) is only computable because enrichment, sequence, and deal data are
> cross-referenced against the same corpus universe in one place — a CSV export has no
> persistent, recomputable TAM to measure coverage against.

**R12.1 — TAM definition from ICP**
Description: Generate a TAM (count + account list) directly from the workspace ICP filters against the corpus; distinct from a one-off search — it's a saved, named universe.
Acceptance Criteria:
- [ ] `POST /tam` builds a named TAM from current ICP (or custom filter override).
- [ ] Returns total addressable account count + segment breakdown (industry/size/geo).
- [ ] TAM is persisted and re-computable (not a snapshot only).
Dependencies: ICP (existing), corpus search
Estimate: 8 · Labels: prospecting, backend

**R12.2 — TAM coverage & fill-rate tracking**
Description: Track what % of the TAM is activated / enriched / in a sequence / has a deal, so RevOps can see market penetration, not just list size.
Acceptance Criteria:
- [ ] TAM detail shows coverage funnel: total → activated → enriched → contacted → replied → deal.
- [ ] Coverage recomputes on TAM refresh.
Dependencies: R12.1, R10.2
Estimate: 5 · Labels: analytics, backend

**R12.3 — TAM view UI (map/table)**
Description: Dedicated TAM workspace view — segment table + overlay signals (R11.3) + drill into segment as a dynamic list.
Acceptance Criteria:
- [ ] Segment breakdown table with drill-down to a filtered dynamic list.
- [ ] Signal overlay toggle available.
- [ ] Export segment as CSV / push to sequence.
Dependencies: R12.1, R11.3
Estimate: 8 · Labels: frontend, prospecting

---

### R13 — Automation core (auto-actions + auto-filled fields)

> Covers items 4 (automate things) and 12 (auto-filled fields). This is the rules/trigger
> layer that later feeds the visual workflow builder (Phase 5) but ships now as fixed,
> high-value automations rather than a general builder.
>
> **Moat (R14.2):** auto-fill and auto-activation rules only have something to trigger off of
> because scoring, enrichment, signals, and CRM records already live in the same system —
> there's nothing left to automate against once that data has been exported.

**R13.1 — Auto re-score on ICP change (from R5.4)**
Description: When `workspace_icp` version bumps, auto-enqueue a batch re-score of activated prospects; credit-aware, cancelable.
Acceptance Criteria:
- [ ] ICP save triggers a background re-score job with progress + toggle to disable.
- [ ] Scores + corpus doc both updated.
Dependencies: R5.1, R5.4 (existing ticket, carried in here)
Estimate: 8 · Labels: ai, backend

**R13.2 — Auto-route AI drafts by score/segment**
Description: Rule-based routing of AI-generated drafts (R4) — e.g. auto-approve for low-risk/high-fit segments, force human review for others.
Acceptance Criteria:
- [ ] Workspace-level rule: auto-approve threshold (icpScore + confidence) vs. always-review list.
- [ ] Auto-approved drafts still logged in the review queue as "auto-approved" for audit.
Dependencies: R4.1
Estimate: 5 · Labels: ai, automation, backend

**R13.3 — Auto-filled CRM/contact fields**
Description: When enrichment, meeting notes (R16), or call notes (R20) produce structured data, auto-fill the corresponding contact/company fields instead of requiring manual entry; show provenance and let the user override.
Acceptance Criteria:
- [ ] Field auto-fill writes to `prospect_activations.snapshot` (or native `contacts`/`companies` once Phase 2 schema lands) with `source` + `confidence`.
- [ ] Auto-filled fields are visually distinguished from manually entered ones.
- [ ] User edit always wins over auto-fill on next sync.
Dependencies: enrichment (existing), R16.2 (meeting notes), R20.1 (call notes)
Estimate: 8 · Labels: automation, backend, frontend

**R13.4 — Auto-activation rules (score threshold → action)**
Description: Score threshold (or signal event) automatically triggers activation, list membership, or sequence enrollment — brought forward from Phase 3 (R3.6 in PRD mapping) as a scoped MVP.
Acceptance Criteria:
- [ ] Rule: "prospects scoring ≥ X and matching signal Y → auto-enroll in sequence Z."
- [ ] Rules workspace-scoped, max 5 active rules in Phase 1 (guardrail against runaway automation).
- [ ] Every auto-action logged and reversible (unenroll, remove from list).
Dependencies: R13.1, R1.2 (enrollment)
Estimate: 8 · Labels: automation, backend

---

### R14 — Product moat (platform stickiness)

> "MOTE" clarified as **moat**: what keeps a user in Skout instead of falling back to a
> spreadsheet + point tools. This is a strategic lens applied to specific initiatives below,
> not a single feature ticket.
>
> **Moat (R14.2):** this epic is the mechanism that makes every other epic's moat sentence
> below a checked, reviewed fact instead of an assumed one — R14.1 audits it, R14.2 gates it at
> kickoff, R14.3 measures it over time.

**R14.1 — Unified-record lock-in audit**
Description: Audit every Track A/B feature for whether it writes back to the *same* prospect/company record (per PRD anti-pattern: no parallel silos). Produce a short gap list where a feature currently exports/duplicates instead of unifying.
Acceptance Criteria:
- [ ] Written audit covering sequences, inbox, signals, TAM, meeting notes, call notes.
- [ ] Each gap has an owner + ticket if it needs a fix.
Dependencies: none
Estimate: 3 · Labels: platform, docs

**R14.2 — "Can't do this outside Skout" checklist per epic**
Description: For each new Track B epic (R11–R20), require one concrete "this data/action only exists because it's cross-referenced inside Skout" capability (e.g. TAM coverage funnel needs enrichment + sequence + deal data together) — a lightweight PRD gate, not new engineering by itself.
Acceptance Criteria:
- [x] Each epic's kickoff doc states its moat angle in one sentence. (Backfilled 2026-08-10 for
      R11–R22 as a "**Moat (R14.2):**" line under each epic header in this doc; new epics from
      here on state it at kickoff per the PR template checklist item added the same day.)
- [x] Reviewed at epic planning, not shipped as a separate deliverable. (Gate now lives in
      `.github/PULL_REQUEST_TEMPLATE.md`'s "Definition of sharp" checklist, so it's reviewed at
      PR time for any PR that opens a new epic — not a standalone deliverable.)
Dependencies: none
Estimate: 1 · Labels: platform, docs

**R14.3 — Switching-cost dashboard (internal)**
Description: Internal metric: % of workspace revenue workflow that lives natively in Skout vs. still round-tripping to HubSpot/CSV (export rate, import rate, manual CSV usage). Track over time as a leading indicator of moat strength.
Acceptance Criteria:
- [ ] Weekly metric: HubSpot export volume, CSV export volume, % of contacted prospects with a Skout-native deal/sequence link.
- [ ] Visible to product/leadership, not customer-facing.
Dependencies: R7.1 (analytics pipeline) recommended, not blocking
Estimate: 5 · Labels: analytics, platform

---

### R15 — DexterAI agent (Phase 1 MVP)

> Full AI Copilot orchestration is Phase 4 in the PRD mapping. This epic ships a narrow,
> grounded MVP under the "DexterAI" name — a few tool calls, not general NL platform control.
>
> **Moat (R14.2):** DexterAI's answers and actions are grounded in live workspace data
> (prospects, sequences, credits, CRO rollups) it queries directly through the tool registry —
> a general-purpose chatbot bolted onto an exported dataset has nothing live to ground itself in.

**R15.1 — DexterAI chat surface + tool registry (v0)**
Description: A chat entry point (web) wired to a small, fixed tool registry: `search_prospects`, `summarize_list`, `explain_score`. No open-ended write actions yet.
Acceptance Criteria:
- [ ] `POST /ai/dexter/query` routes NL input to one of the registered tools via LLM function-calling.
- [ ] Every response cites which tool/data it used (no ungrounded answers).
- [ ] Unsupported requests get an honest "not yet supported" response, not a hallucinated action.
Dependencies: existing scoring/search services
Estimate: 8 · Labels: ai, ai-service, backend

**R15.2 — DexterAI write actions (guarded)**
Description: Extend the tool registry to one write action — "enroll this list in sequence X" — behind an explicit confirm step (human-in-the-loop, per PRD guardrails).
Acceptance Criteria:
- [ ] Write actions require a rendered confirmation card before executing.
- [ ] Action logged to an AI audit trail (actor = DexterAI, on-behalf-of = user).
Dependencies: R15.1, R1.2
Estimate: 5 · Labels: ai, backend

**R15.3 — DexterAI UI + onboarding**
Description: Persistent chat affordance in the app shell; first-run examples ("Show me my strongest leads this week").
Acceptance Criteria:
- [ ] Chat panel accessible from any workspace page.
- [ ] 3 example prompts shown on first open; empty/error states handled.
Dependencies: R15.1
Estimate: 5 · Labels: ai, frontend

---

### R16 — Meeting bot + calendar sync

> **Moat (R14.2):** meeting summaries and extracted fields post straight to the same prospect
> activity timeline and auto-fill pipeline that enrichment and call notes already write to — a
> standalone meeting-notes tool has no CRM record to attach itself to.

**R16.1 — Calendar OAuth sync (Google first)**
Description: Connect Google Calendar (Outlook stretch); pull upcoming meetings tied to a prospect/company by attendee email match.
Acceptance Criteria:
- [ ] OAuth connect flow stores encrypted tokens (same pattern as R3.1 inbox connect).
- [ ] Meetings matched to a prospect by attendee email; shown on prospect/company detail.
- [ ] Two-way basic sync (meeting created in Skout appears on calendar) is stretch, not required for v1.
Dependencies: none
Estimate: 8 · Labels: platform, backend, infra

**R16.2 — Meeting bot join + notes**
Description: A bot (e.g. via a meeting-bot provider API) joins a scheduled call, records/transcribes, and produces a summary + action items attached to the prospect timeline.
Acceptance Criteria:
- [ ] Bot auto-joins meetings tagged for a Skout prospect (opt-in per meeting or per workspace).
- [ ] Transcript summary + action items posted to activity timeline within N minutes of call end.
- [ ] Recording/transcript storage complies with consent requirements (disclosure banner).
Dependencies: R16.1
Estimate: 13 · Labels: ai, backend, infra

**R16.3 — Meeting notes → auto-fill (feeds R13.3)**
Description: Structured extraction from meeting summary (next steps, stated budget/timeline, stakeholders mentioned) feeding the auto-fill pipeline.
Acceptance Criteria:
- [ ] Extraction produces typed fields (not raw text dump) with confidence.
- [ ] Feeds `R13.3` auto-fill with `source = meeting_bot`.
Dependencies: R16.2, R13.3
Estimate: 5 · Labels: ai, backend

---

### R17 — Notifications, SDR reminders & auto-alerts

> Covers items 10 and 14. No notification system exists today — this is new platform
> infrastructure that R10.2 (list refresh), R11 (signals), R18 (risk) all depend on.
>
> **Moat (R14.2):** alerts fire off signals, scores, and sequence/task state that only exist
> because they're unified in one workspace — a spreadsheet has nothing to watch and nothing to
> alert on.

**R17.1 — Notification center (in-app)**
Description: Central notification store + UI (bell icon, unread count, feed) as the landing surface for all downstream alert types.
Acceptance Criteria:
- [ ] `notifications` table: type, entity ref, read/unread, created_at, workspace/user scope.
- [ ] In-app bell + feed with mark-read, filter by type.
- [ ] Extensible `type` enum so new alert types (below) plug in without schema changes.
Dependencies: none
Estimate: 8 · Labels: platform, backend, frontend

**R17.2 — Task/sequence reminders**
Description: Reminders for due tasks, sequence steps needing manual action (e.g. LinkedIn step), and stale review-queue items.
Acceptance Criteria:
- [ ] Reminder generated N hours before/at due time; configurable per workspace.
- [ ] Reminder resolves automatically when the underlying task completes.
Dependencies: R17.1
Estimate: 5 · Labels: platform, backend

**R17.3 — Signal-triggered SDR alerts (auto-alert)**
Description: A qualifying signal (funding event, tech adoption, intent spike) on an SDR's owned account automatically fires a notification + optional email digest.
Acceptance Criteria:
- [ ] Alert rule: signal type + threshold → notify owning SDR.
- [ ] Digest option (real-time vs. daily rollup) per user preference.
- [ ] Alert links directly to the account/signal detail.
Dependencies: R17.1, R11.2
Estimate: 5 · Labels: platform, ai, backend

**R17.4 — Email/Slack delivery channel**
Description: Deliver high-priority notifications outside the app (email at minimum; Slack if workspace has it connected) so SDRs aren't required to be logged in to catch a hot signal.
Acceptance Criteria:
- [ ] Per-notification-type channel preference (in-app / email / both).
- [ ] Delivery failure doesn't block in-app notification creation.
Dependencies: R17.1
Estimate: 5 · Labels: platform, backend

---

### R18 — Risk detection

> Scoped-down MVP of "deal coach" risk signals (Phase 4 in the PRD mapping), limited to
> account/engagement-level risk since native `deals` don't exist yet (Phase 2).
>
> **Moat (R14.2):** risk flags are computed from engagement and signal data already unified
> across sequences, inbox, and enrichment on one record — there's no equivalent signal to
> compute risk from once that activity is fragmented across separate point tools.

**R18.1 — Engagement-decay risk flag**
Description: Flag accounts/prospects with declining engagement (no opens/replies/activity over a rolling window) as at-risk, using existing activity data (sequence steps, inbox, enrichment).
Acceptance Criteria:
- [ ] Risk score computed from recency/frequency of engagement events.
- [ ] Flag surfaced on prospect/company detail + feeds R17.3 alerting.
Dependencies: R1.3 (tracking), R2.2 (thread state)
Estimate: 8 · Labels: ai, backend

**R18.2 — Negative-signal risk flag**
Description: Detect risk-indicating signals (leadership departure at target account, negative sentiment in a reply per R2.2, budget-freeze language) and surface as a distinct risk type from engagement decay.
Acceptance Criteria:
- [ ] At least 2 risk signal types beyond engagement decay live.
- [ ] Each risk flag includes a plain-language reason, not just a score.
Dependencies: R11.2, R2.2
Estimate: 8 · Labels: ai, backend

---

### R19 — CRO Copilot (Admin-only)

> A restricted, exec-facing rollup — explicitly gated to `owner`/`admin` roles, distinct from
> the SDR-facing DexterAI (R15). Read-only in Phase 1; no write actions.
>
> **Moat (R14.2):** the exec rollup is only possible because pipeline, activity, signal, and
> switching-cost data are all cross-referenced in one place — no exported dataset gives you a
> live, cross-rep pipeline view without someone manually stitching it back together.

**R19.1 — Admin-gated rollup API**
Description: Aggregate endpoint(s) for team-level pipeline/activity/signal summary, restricted to `owner`/`admin` role (existing role model).
Acceptance Criteria:
- [ ] `GET /api/v1/cro/summary` returns team-level metrics (activation, response rate, top risk accounts, TAM coverage) — 403 for `member` role.
- [ ] No per-rep write actions in Phase 1 (read-only rollup).
Dependencies: R12.2 (TAM coverage), R18 (risk), existing role model
Estimate: 8 · Labels: ai, backend, platform

**R19.2 — CRO Copilot chat (NL over the rollup)**
Description: Reuse the DexterAI tool-calling pattern (R15.1) but scoped to admin-only aggregate tools — e.g. "which reps are behind on pipeline this week."
Acceptance Criteria:
- [ ] Shares infra with R15.1 but with an admin-only tool set and role check on every call.
- [ ] Answers grounded in R19.1 data; no team member sees another's data without admin role.
Dependencies: R19.1, R15.1
Estimate: 5 · Labels: ai, backend

**R19.3 — CRO dashboard UI**
Description: Admin-only dashboard route (`/admin/cro`) — pipeline rollup, top risk accounts, TAM coverage, moat metrics from R14.3.
Acceptance Criteria:
- [ ] Route hidden/403 for non-admin roles at both API and nav level.
- [ ] Pulls from R19.1 + R14.3.
Dependencies: R19.1, R14.3
Estimate: 5 · Labels: frontend, platform

---

### R20 — Notes, suggestions & calling (Sales + Marketing)

> **Moat (R14.2):** call notes, dispositions, and next-best-action suggestions write straight
> into the same activity timeline and scoring pipeline every other channel already uses — a
> standalone dialer app has no unified record to log against or score/signal context to suggest
> from.

**R20.1 — Call notes capture**
Description: Manual + (where available) auto-transcribed notes attached to a prospect/company timeline for phone calls, usable by both sales and marketing users (not sequence-specific).
Acceptance Criteria:
- [ ] Note entity supports `channel = call`, free text + optional structured tags (outcome, next step).
- [ ] Visible on the unified activity timeline alongside emails/meetings.
Dependencies: none (can ship ahead of dialer integration)
Estimate: 5 · Labels: platform, backend, frontend

**R20.2 — Dialer/calling integration (Twilio, per PRD MVP integration list)**
Description: Click-to-call from a prospect record via Twilio; call metadata (duration, outcome) auto-logged as an activity.
Acceptance Criteria:
- [ ] Click-to-call initiates via Twilio; call logged with duration + disposition.
- [ ] Recording (where legally permitted) attached to the note.
Dependencies: R20.1
Estimate: 8 · Labels: platform, backend, infra

**R20.3 — AI next-best-action suggestions**
Description: After a note/call/meeting is logged, surface an AI-suggested next action (follow-up email, task, add to sequence) — usable in both sales and marketing contexts.
Acceptance Criteria:
- [ ] Suggestion generated from note content + prospect score/signals.
- [ ] One-click accept converts suggestion into a task or sequence enrollment.
- [ ] Suggestions logged for acceptance-rate measurement (feeds product metrics).
Dependencies: R20.1, R13.4
Estimate: 8 · Labels: ai, backend, frontend

**R20.4 — Call step type in sequences (amends R1.1)**
Description: Add `stepType = "call"` to the sequence step builder (today: email/linkedin/wait/task, per `remaining-features-build-order.md` R1.1). A call step materializes as a due task (R21) at its scheduled point in the cadence and, where Twilio is connected (R20.2), offers a one-click "Call now" action; the outcome is logged as a note (R20.1) and can branch the sequence like a reply/bounce does today.
Acceptance Criteria:
- [ ] `sequence_steps.stepType` accepts `call` alongside the existing enum values.
- [ ] Enrollment scheduler (R1.2) materializes a call step as a due task at the right point in the cadence, same pattern already used for the `task` step type.
- [ ] If R20.2 (Twilio) is connected, the step surfaces "Call now"; the call is logged automatically on completion.
- [ ] If Twilio isn't connected, the step still works as a manual task with a disposition field (connected / no answer / voicemail / bad number).
- [ ] Call disposition can branch or advance the sequence, reusing the branching model R1.2 already applies to reply/bounce.
Dependencies: R1.1, R1.2 (Track A) · R20.1, R20.2 · R21.1
Estimate: 5 · Labels: outreach, backend, frontend

---

### R21 — Tasks

> No native `tasks` entity exists today — `Task` is listed as a core PRD entity but Phase 1
> only has implicit, system-generated reminders (R17.2). This epic adds user-created,
> manually manageable tasks as a first-class object, which R17 (reminders), R20.4 (call
> steps), and R20.3 (AI suggestions → task) all build on.
>
> **Moat (R14.2):** every task links back to the same prospect/company/deal record every other
> feature writes to, so a task's context (score, signals, activity history) is always one click
> away — a generic to-do app has no such record to link a task to.

**R21.1 — Task entity + CRUD API**
Description: Native `tasks` table: type (call/email/follow-up/custom), due date, owner, optional link to a prospect/company/deal, status (`open → done | skipped`).
Acceptance Criteria:
- [ ] `POST/PATCH/DELETE /tasks`, workspace-scoped and owner-assignable.
- [ ] A task can optionally link to a prospect/company (`entityType` + `entityId`).
- [ ] Status lifecycle `open → done | skipped`; `completedAt` recorded.
Dependencies: none
Estimate: 5 · Labels: platform, backend

**R21.2 — Task views (My Tasks, due today/overdue)**
Description: A rep-facing "My Tasks" list across all prospects, plus a dashboard widget for tasks due today/overdue; manual "Add task" available from any prospect/company detail page.
Acceptance Criteria:
- [ ] "My Tasks" page: filter by status, due date, and linked entity.
- [ ] Dashboard widget shows tasks due today + overdue count.
- [ ] "Add task" action available from prospect/company detail and from within a sequence step.
Dependencies: R21.1
Estimate: 5 · Labels: platform, frontend

**R21.3 — Tasks feed the notification/reminder system**
Description: Wire task due dates into R17.2 so creating/editing a task automatically schedules a reminder, instead of tasks and reminders being two disconnected systems.
Acceptance Criteria:
- [ ] Creating or editing a task's due date auto-schedules an R17.1 notification.
- [ ] Completing or skipping a task cancels its pending reminder.
Dependencies: R21.1, R17.1, R17.2
Estimate: 3 · Labels: platform, backend

---

### R22 — GTM platform import (Apollo.io + others)

> Apollo.io is already used today as a PAL enrichment-waterfall data provider (see
> `data-enrichment-strategy.md` — `internal_graph → apollo → hunter → prospeo → scraper`).
> This epic is a **different** capability: letting a user migrate their *existing* contacts,
> lists, and (stretch) sequences **out of** Apollo.io/Outreach/Salesloft/similar tools and
> **into** Skout — the same shape as the HubSpot import path (feature guide §3.10) but for
> GTM/prospecting tools rather than a CRM.
>
> **Moat (R14.2):** imported contacts and sequences land in the same unified prospect/CRM
> identity space as everything else in the workspace (never auto-activated — always a draft for
> review) — they don't sit in a separate imported-data silo the way a raw CSV import would.

**R22.1 — Apollo.io connect + contact/list import**
Description: Connect a user's Apollo.io account (API key, matching Apollo's own auth model) and import their contacts/saved lists into Skout — activate + add to a chosen Skout list, same shape as HubSpot import.
Acceptance Criteria:
- [ ] Connect flow stores the Apollo API key encrypted (same pattern as BYOK integrations, §3.11).
- [ ] Import pulls contacts/saved lists → activates in Skout → adds to a chosen Skout list.
- [ ] Prospects matched against existing `prospect_id` identity — no duplicate activations on re-import.
Dependencies: none (reuses BYOK + activation patterns)
Estimate: 8 · Labels: platform, backend, integrations

**R22.2 — Generic GTM-provider import framework**
Description: Generalize the import path (HubSpot §3.10 + Apollo R22.1) behind a shared adapter interface so a third provider (Outreach.io, Salesloft, Snov.io) can be added without rebuilding the import pipeline each time.
Acceptance Criteria:
- [ ] Shared `ImportAdapter` interface: `listContacts()`, `listLists()`, `mapToProspectCandidate()`.
- [ ] HubSpot and Apollo both implement it; adding a third provider requires no core pipeline changes.
Dependencies: R22.1
Estimate: 5 · Labels: platform, backend

**R22.3 — Import sequences/cadences from Apollo (stretch)**
Description: Where the source platform's API exposes it, import existing sequence/cadence step structure — not just contacts — as a starting draft for a Skout sequence, reducing re-authoring cost for switchers.
Acceptance Criteria:
- [ ] Apollo sequence steps mapped to `sequence_steps` (email/wait steps at minimum; call steps map to R20.4 if present).
- [ ] Imported sequence lands in `draft` status for review before activation — never auto-activates.
Dependencies: R22.1, R1.1 (Track A)
Estimate: 8 · Labels: platform, backend

---

### 5.12 — Cross-cutting: "Sharpen features" (item 3)

Not a standalone epic — a quality bar applied to every epic above and to Track A. Before any
epic above is marked done:

- Acceptance criteria in this doc are met (not just "it demos").
- Existing adjacent feature isn't regressed (e.g. R10 dynamic-list default doesn't break CSV import users rely on).
- Empty/error/loading states designed, not just the happy path.
- If AI-generated, output includes a confidence/source per the PRD AI guardrails (§ AI capabilities, master-prd-summary.md).

Recommend a lightweight "definition of sharp" checklist added to the PR template rather than a
separate ticket queue.

---

## 6. Build sequencing (updated)

Critical path for Track A is unchanged: **R3.1 → R3.2 → R1.1 → R1.2 → R1.3 → R2.1 → R2.3**
(see `remaining-features-build-order.md`). Track B sequencing, prioritizing low-effort/high-leverage
first and respecting dependencies:

1. **R21.1 (task entity)** + **R17.1 (notification center)** — foundational; R21.3, R20.4, R10.2, R11.3, R17.3 and others all depend on one or both.
2. **R10.1–R10.2 (kill static list)** + **R11.2 (signal store)** — leverage existing smart-list/signal-filter work, biggest "sharpened core product" win.
3. **R13.1 (auto re-score)** — already spec'd as R5.4; cheap to land now.
4. **R21.2–R21.3 (task views + reminders)** — closes the loop on R21.1, cheap once tasks exist.
5. **R17.3–R17.4 (signal alerts + delivery)** — depends on R11.2 + R17.1, closes the "notify SDR" loop.
6. **R22.1–R22.2 (Apollo.io import + generic adapter)** — no new infra beyond BYOK/activation patterns; unblocks switchers early.
7. **R12 (TAM builder)** — depends on ICP + corpus, no new infra; strong differentiation win.
8. **R11.1, R11.3 (tech signals + overlay)** — depends on corpus pipeline (R6.x in Track A's backlog); coordinate with corpus team.
9. **R18 (risk detection)** — depends on engagement + signal data landing first.
10. **R13.3–R13.4 (auto-fill, auto-activation)** — depends on enrichment + signals + notifications all being live.
11. **R20.1–R20.2 (call notes + Twilio)** — needed before **R20.4 (call step in sequences)**, which is the one Track B story that directly amends a Track A epic (R1.1) — coordinate timing with whoever owns R1.
12. **R16 (meeting bot + calendar)** — largest new infra lift (calendar OAuth, meeting-bot API); start integration spikes early even though it lands later.
13. **R15 (DexterAI MVP)** — needs a stable tool surface (search/score/enroll) to be trustworthy; sequence after R1–R4 (Track A) are solid.
14. **R19 (CRO Copilot)** — depends on R12.2, R18, R14.3, and reuses R15's infra — naturally last.
15. **R22.3 (import sequences from Apollo)** — stretch; do only after R22.1 and Track A's R1.1 are both stable.
16. **R14 (moat)** — R14.1/R14.2 are lightweight and should run in parallel throughout (audits, not builds); R14.3 depends on analytics (R7.1 in Track A).

---

## 7. Success metrics

| Epic | Metric |
|------|--------|
| R10 | % of new lists created as dynamic vs. static |
| R11 | Signal coverage: % of activated accounts with ≥1 stored signal |
| R12 | TAM defined per workspace; coverage funnel completion rate |
| R13 | Auto-filled field acceptance rate (not overridden by user) |
| R14 | Switching-cost dashboard trend (export rate ↓, native-link rate ↑) |
| R15 | DexterAI query success rate (grounded answer, no fallback) |
| R16 | % of calendar meetings with a bot-generated summary |
| R17 | Notification → action rate (opened → acted within 24h) |
| R18 | Risk flags raised vs. confirmed accurate (precision, sampled) |
| R19 | CRO Copilot weekly active admins |
| R20 | Note → AI suggestion acceptance rate; % of call steps completed via one-click dial (R20.4) |
| R21 | Task completion rate; % of tasks completed on/before due date |
| R22 | Contacts/lists imported via Apollo.io (or other GTM adapter) per workspace; import → activation success rate |

---

## 8. Risks & open assumptions

- **Scope expansion risk:** items 6, 8, 9, 11, 13 pull work forward from Phase 3/4/5 in the
  original roadmap. Recommend treating Track B as parallel-track, resourced separately from
  Track A, so the near-complete outreach loop doesn't stall.
- **"MOTE" interpreted as *moat*** (confirmed) — competitive defensibility/stickiness, not a
  generic engagement-loop feature. R14 is written as an audit/metric lens, not new UI.
- **DexterAI** assumed to be the working name for the AI copilot; confirm before it ships
  publicly (naming/trademark check).
- **CRO Copilot** assumed admin/owner-role-gated, read-only in Phase 1 (no write actions on
  other reps' records) — confirm this matches the intended admin permission model.
- **New third-party dependencies:** meeting-bot provider, calendar OAuth (Google/Microsoft),
  Twilio — each needs a vendor decision + credentials before R16/R20 can start (not yet in
  `docs/enrichment-credentials.md` or `docs/secrets-setup.md`).
- **Native CRM entities** (`contacts`, `companies`, `deals`) don't exist yet (Phase 2 in the
  original roadmap). R13.3 auto-fill and R18 risk detection target `prospect_activations.snapshot`
  in the interim and should be revisited once Phase 2 schema lands.
- **R20.4 amends Track A, not just Track B.** Adding a `call` step type touches `sequence_steps`
  and the enrollment scheduler owned by R1.1/R1.2 in `remaining-features-build-order.md`. Whoever
  is finishing Track A should sign off on this before it's built, so it doesn't land as an
  uncoordinated schema change mid-sprint.
- **Apollo.io has two, unrelated roles in this plan.** It's already a live PAL enrichment
  provider (`data-enrichment-strategy.md`) *and* now a proposed import source (R22). These are
  separate integrations with separate credentials — don't conflate the existing `APOLLO_API_KEY`
  enrichment usage with the new import connect flow when scoping R22.1.
- **Tasks (R21) is new core schema**, not a UI-only feature — `Task` was listed as a PRD entity
  but never implemented. R17 (reminders), R20.4 (call steps), and R20.3 (AI suggestions) all
  assume R21.1 exists, so it should land early despite being "just" a CRUD epic.

---

## 9. References

- [master-prd-summary.md](../master-prd-summary.md)
- [master-prd-implementation.md](../master-prd-implementation.md)
- [remaining-features-build-order.md](./remaining-features-build-order.md) — Track A (R1–R9) source
- [skout-ai-feature-guide.md](../skout-ai-feature-guide.md)
- [data-enrichment-implementation-status.md](../data-enrichment-implementation-status.md)
