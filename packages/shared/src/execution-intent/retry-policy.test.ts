import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, classifyRetry, computeBackoffDelay } from "./retry-policy.js";

describe("computeBackoffDelay", () => {
  it("grows exponentially with attempt number", () => {
    const fixedRandom = () => 0; // pins jitter to the low end of [cap/2, cap]
    expect(computeBackoffDelay(0, fixedRandom)).toBe(500); // cap=1000, cap/2=500
    expect(computeBackoffDelay(1, fixedRandom)).toBe(1000); // cap=2000, cap/2=1000
    expect(computeBackoffDelay(2, fixedRandom)).toBe(2000); // cap=4000, cap/2=2000
  });

  it("caps at 5 minutes even for large attempt numbers", () => {
    const fixedRandom = () => 0;
    expect(computeBackoffDelay(20, fixedRandom)).toBe(150_000); // cap=300_000, cap/2=150_000
  });

  it("jitter never collapses toward zero — always within [cap/2, cap]", () => {
    const delay = computeBackoffDelay(3, () => 1); // cap=8000
    expect(delay).toBe(8000);
    const delayLow = computeBackoffDelay(3, () => 0);
    expect(delayLow).toBe(4000);
  });
});

describe("classifyRetry", () => {
  it("does not retry when the outcome is not retryable, regardless of attempt count", () => {
    const decision = classifyRetry(false, 0);
    expect(decision).toEqual({ shouldRetry: false, reason: "outcome is not retryable" });
  });

  it("retries a retryable outcome under the attempt cap", () => {
    const decision = classifyRetry(true, 0, () => 0);
    expect(decision.shouldRetry).toBe(true);
    expect(decision.delayMs).toBe(500);
  });

  it("stops retrying once attemptCount reaches MAX_ATTEMPTS", () => {
    const decision = classifyRetry(true, MAX_ATTEMPTS);
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toContain("maximum attempts");
  });

  it("still allows one more retry one attempt below the cap", () => {
    const decision = classifyRetry(true, MAX_ATTEMPTS - 1, () => 0);
    expect(decision.shouldRetry).toBe(true);
  });
});
