# ADR 0011: §1.2 strategic shifts — backend closeout

## Status
Accepted — 2026-08-26 · **Updated 2026-08-26 (Wave 3)** — backend surfaces shipped.

## Context
§1.2 lists six From→To shifts. Provider abstraction and evidence-backed AI (Neeraj) shipped
in Wave 2. Wave 3 adds Policy Gateway, decision views, and observable workflow runs in this
repo so Aditya D7/D14/D15 can attach UI without reinventing contracts.

## Decision
| Shift | Owner | Status |
|---|---|---|
| Separate screens → canonical graph | Neeraj D4/D16 | Eng-complete |
| Opaque AI → evidence-backed | Neeraj §6.1 | Eng-complete |
| Manual copying → observable async | Aditya D15 + Neeraj API | **Backend:** `workflow_runs` + `/api/v1/workflows/runs*` |
| Provider-specific → abstractions | PAL | Closed |
| Vanity dashboards → decision views | Aditya D14 + Neeraj API | **Backend:** `decision_views` + `/api/v1/decisions*` |
| Uncontrolled automation → four modes | Aditya D7 + Neeraj API | **Backend:** Policy Gateway `ask\|auto\|draft\|approve` |

## APIs
- `GET/PUT /api/v1/automation-policy`, `POST /api/v1/policy/classify`, `GET /api/v1/policy/decisions`
- `GET/POST /api/v1/decisions*`, `POST /api/v1/workflows/runs*`
- §10.4 `POST /api/v1/dexter/plans*` · §10.5 `POST /api/v1/linkedin/voice/*`

## Remaining (external)
- Aditya: Dexter Orchestrator UI + Workflow Studio vs n8n product choice
- Shailpreet: decision-view front-ends
- Modes are backend-enforced; product naming locked to ask/auto/draft/approve
