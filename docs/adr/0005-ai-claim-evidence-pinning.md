# ADR 0005: AI claim evidence pinning (§6.1)

## Status
Accepted — Enterprise Completion Plan gap-closure pass (25 Aug 2026).

## Context
§6.1 requires every factual/AI-generated claim to cite an `evidence_id` (or be explicitly
unverified). Next-best-action already enforced this; generate-email, score, chat, drafts,
suggest-reply, and personalize did not.

## Decision
Introduce `pinAiClaim()` (`apps/api/src/services/ai-evidence.service.ts`) as the shared
write+assert boundary:

1. Optionally resolve active `ModelVersion` / `PromptVersion` by logical name.
2. Insert `evidence_ledger` with `freshnessExpiresAt` (default 7 days).
3. Call `assertEvidenced` — fail closed if the write did not produce an id.

Call sites: `/ai/generate-email`, `/ai/chat`, `/ai/drafts` (when AI generates),
`/inbox/.../suggest-reply`, `/enrichment/personalize`, `/enrichment/score` (prospect-scoped).

Ephemeral scores without `prospectId` remain explicitly `unverified`.

## Consequences
- Clients should expect `evidenceId` (and often `modelVersionId`) on AI responses.
- Missing ModelVersion catalog rows do not block generation — pin proceeds with null version.
- Prompt-injection defense for future web-research remains a separate build requirement.
