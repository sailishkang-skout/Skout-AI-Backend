import { describe, expect, it } from "vitest";
import { applyPolicy, parseNextBestActionResponse } from "./intelligence-layer.service.js";
import type { ActivationRuleDto } from "./activation-rules.service.js";

function rule(overrides: Partial<ActivationRuleDto> = {}): ActivationRuleDto {
  return {
    id: "rule-1",
    workspaceId: "ws-1",
    name: "test rule",
    scoreThreshold: 80,
    signalType: null,
    targetAction: "add_to_list",
    targetId: "list-1",
    enabled: true,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("applyPolicy — step 7 of the Intelligence Layer pipeline", () => {
  it("excludes a disabled rule regardless of score/signal match", () => {
    const matches = applyPolicy([rule({ enabled: false })], 100, []);
    expect(matches).toHaveLength(0);
  });

  it("excludes a rule when the prospect score is below its threshold", () => {
    const matches = applyPolicy([rule({ scoreThreshold: 90 })], 89, []);
    expect(matches).toHaveLength(0);
  });

  it("includes a rule when the score meets its threshold exactly", () => {
    const matches = applyPolicy([rule({ scoreThreshold: 90 })], 90, []);
    expect(matches).toHaveLength(1);
  });

  it("excludes a signal-typed rule when the prospect has no matching active signal", () => {
    const matches = applyPolicy([rule({ signalType: "hiring" })], 100, []);
    expect(matches).toHaveLength(0);
  });

  it("includes a signal-typed rule once the signal is active", () => {
    const matches = applyPolicy([rule({ signalType: "hiring" })], 100, ["hiring", "funding"]);
    expect(matches).toHaveLength(1);
  });

  it("score-only rules (signalType null) are unaffected by the active-signal list either way", () => {
    const matches = applyPolicy([rule({ signalType: null })], 100, []);
    expect(matches).toHaveLength(1);
  });

  it("evaluates multiple rules independently, returning only the ones that match", () => {
    const matches = applyPolicy(
      [
        rule({ id: "r1", scoreThreshold: 90 }),
        rule({ id: "r2", enabled: false }),
        rule({ id: "r3", signalType: "funding" }),
      ],
      95,
      ["funding"]
    );
    expect(matches.map((r) => r.id)).toEqual(["r1", "r3"]);
  });
});

describe("parseNextBestActionResponse — step 6 of the Intelligence Layer pipeline", () => {
  const validActionTypes = ["call", "email", "meeting", "wait", "task"] as const;

  it("parses a well-formed suggestion", () => {
    const raw = JSON.stringify({
      actionType: "call",
      headline: "Call about the paused pilot",
      rationale: "No activity in 14 days despite a hiring signal",
      draftMessage: undefined,
    });
    const result = parseNextBestActionResponse(raw, validActionTypes);
    expect(result).toEqual({
      actionType: "call",
      headline: "Call about the paused pilot",
      rationale: "No activity in 14 days despite a hiring signal",
      draftMessage: undefined,
    });
  });

  it("includes draftMessage when the model provides one", () => {
    const raw = JSON.stringify({ actionType: "email", headline: "h", rationale: "r", draftMessage: "Hi there" });
    const result = parseNextBestActionResponse(raw, validActionTypes);
    expect(result.draftMessage).toBe("Hi there");
  });

  it("falls back to wait/could-not-parse on malformed JSON, truncating the raw text into rationale", () => {
    const raw = "not json" + "x".repeat(400);
    const result = parseNextBestActionResponse(raw, validActionTypes);
    expect(result.actionType).toBe("wait");
    expect(result.headline).toBe("Could not parse a suggestion");
    expect(result.rationale).toHaveLength(300);
  });

  it("falls back actionType to wait when the model emits a value outside the valid set", () => {
    const raw = JSON.stringify({ actionType: "sing_a_song", headline: "h", rationale: "r" });
    const result = parseNextBestActionResponse(raw, validActionTypes);
    expect(result.actionType).toBe("wait");
  });

  it("defaults headline/rationale to safe strings when the model omits them", () => {
    const raw = JSON.stringify({ actionType: "task" });
    const result = parseNextBestActionResponse(raw, validActionTypes);
    expect(result.headline).toBe("Review this record");
    expect(result.rationale).toBe("");
  });
});
