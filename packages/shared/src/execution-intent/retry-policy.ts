/** Shared across every execution-intent adopter — a crash-reclaimed attempt counts toward the
 * same ceiling as a classified retry, matching Warm-Up-Tool's reference implementation. */
export const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5 * 60_000;

export interface RetryDecision {
  shouldRetry: boolean;
  delayMs?: number;
  reason: string;
}

/** Exponential backoff capped at 5 minutes, jittered into [cap/2, cap] so a delay never
 * collapses toward zero. */
export function computeBackoffDelay(attempt: number, random: () => number = Math.random): number {
  const exponential = BASE_DELAY_MS * 2 ** attempt;
  const cap = Math.min(exponential, MAX_DELAY_MS);
  return Math.round(cap / 2 + (cap / 2) * random());
}

/** `retryable` is the caller's own domain-specific classification (HTTP status, provider error
 * code, etc.) — this function only owns the attempt-cap/backoff-math part of the decision. */
export function classifyRetry(
  retryable: boolean,
  attemptCount: number,
  random: () => number = Math.random
): RetryDecision {
  if (!retryable) {
    return { shouldRetry: false, reason: "outcome is not retryable" };
  }
  if (attemptCount >= MAX_ATTEMPTS) {
    return { shouldRetry: false, reason: `maximum attempts (${MAX_ATTEMPTS}) reached` };
  }
  return { shouldRetry: true, delayMs: computeBackoffDelay(attemptCount, random), reason: "retryable failure, attempts remain" };
}
