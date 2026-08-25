# ADR 0009 — i18n / Regional TAM / sales territory (in scope)

## Status
Accepted — **in scope** (supersedes prior deferral)

## Decision
1. Onboarding collects seller **HQ location** (`company.hqCountry`) and **locale**.
2. `POST /api/v1/regional-intel` uses LLM (OpenRouter/GPT) for regional TAM + territory
   hints; output is explicitly `unverified: true` (not evidence-ledger fact).
3. Competitive win-loss (§2) remains the gate for claiming Regional TAM as validated.

## Consequences
UI copy and regional briefs are advisory until win-loss validates positioning.
