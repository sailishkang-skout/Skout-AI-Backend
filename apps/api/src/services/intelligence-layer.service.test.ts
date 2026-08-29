import { describe, expect, it } from "vitest";
import { applyPolicy } from "./intelligence-layer.service.js";
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
