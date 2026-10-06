import { describe, expect, it } from "vitest";
import { copsOutboxUpdateToSet } from "./cops-outbox-relay.worker.js";

describe("copsOutboxUpdateToSet", () => {
  it("stamps published_at on success", () => {
    const at = new Date("2026-10-06T10:00:00.000Z");
    expect(copsOutboxUpdateToSet({ kind: "published", publishedAt: at })).toEqual({ publishedAt: at });
  });

  it("writes the retry schedule and error on failure", () => {
    const next = new Date("2026-10-06T10:00:02.000Z");
    expect(
      copsOutboxUpdateToSet({ kind: "retry", attempts: 2, nextAttemptAt: next, lastError: "down" })
    ).toEqual({ attempts: 2, nextAttemptAt: next, lastError: "down" });
  });

  it("dead-letters without changing next_attempt_at", () => {
    const at = new Date("2026-10-06T10:00:00.000Z");
    const set = copsOutboxUpdateToSet({ kind: "dead_letter", attempts: 8, deadLetteredAt: at, lastError: "x" });
    expect(set).toEqual({ attempts: 8, deadLetteredAt: at, lastError: "x" });
    expect(set).not.toHaveProperty("nextAttemptAt");
  });
});
