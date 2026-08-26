# ADR 0011: §1.2 strategic shifts — deferred domains

## Status
Accepted — 2026-08-26.

## Context
§1.2 lists six From→To shifts. Provider abstraction and evidence-backed AI (Neeraj) are
shipped in Wave 2. Three shifts complete only when Aditya-owned domains land.

## Decision
| Shift | Owner | Status |
|---|---|---|
| Separate screens → canonical graph | Neeraj D4/D16 | Eng-complete Wave 2 |
| Opaque AI → evidence-backed | Neeraj §6.1 | Eng-complete Wave 2 |
| Manual copying → observable async | Aditya D7 / D15 | Deferred |
| Provider-specific → abstractions | PAL (done) | Closed |
| Vanity dashboards → decision views | Aditya D14 | Deferred |
| Uncontrolled automation → four modes | Aditya D7 Policy Gateway | Deferred |

Neeraj §1.2 is **eng-complete / externally blocked** on D7/D14/D15 — not a backend gap in this repo.
