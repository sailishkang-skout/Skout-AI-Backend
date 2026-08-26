# ADR 0010: Prompt-injection defense for untrusted content (§6.1)

## Status
Accepted — Wave 2 (2026-08-26).

## Context
§6.1 requires treating prompt injection and untrusted web content as data, never instructions.
Web-research paths are not built yet; the defense must exist as a shared helper before those
paths land so it is not an afterthought.

## Decision
Ship `treatUntrustedContentAsData()` in `@skout/shared` (`evidence-contract.ts`). Any future
scraper / web-research / email-body-as-context path MUST wrap untrusted strings with this
helper before prompt concatenation. AI claim surfaces continue to use `pinAiClaim` /
`assertEvidenced` (fail-closed).

## Consequences
- No behavior change until web-research adopts the helper.
- Suggest-reply / chat / score / draft / sequence-generate already pin or mark unverified.
