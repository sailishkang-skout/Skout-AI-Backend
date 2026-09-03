import { describe, expect, it } from "vitest";
import { evaluateRetentionFlags } from "./retention-workflow.service.js";

const now = new Date("2026-09-03T00:00:00.000Z");
const base = {
  now,
  contractEndDate: null,
  latestPositiveSignalAt: null,
  latestExpansionSignalAt: null,
  inactivityDays: 30,
  renewalWindowDays: 90,
  positiveSignalDays: 30,
  expansionSignalDays: 30,
  expansionScore: 0,
};

describe("evaluateRetentionFlags", () => {
  it("flags disengagement without recent activity and clears it for recent activity", () => {
    expect(evaluateRetentionFlags({ ...base, lastActivityAt: new Date("2026-07-01T00:00:00.000Z") }).map((f) => f.signalType)).toContain(
      "retention_disengagement"
    );
    expect(evaluateRetentionFlags({ ...base, lastActivityAt: new Date("2026-08-20T00:00:00.000Z") }).map((f) => f.signalType)).not.toContain(
      "retention_disengagement"
    );
  });

  it("flags an approaching renewal without a recent positive signal", () => {
    const flags = evaluateRetentionFlags({
      ...base,
      lastActivityAt: new Date("2026-08-20T00:00:00.000Z"),
      contractEndDate: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(flags.map((f) => f.signalType)).toContain("retention_renewal_risk");
  });

  it("does not flag renewal risk when a positive signal is recent", () => {
    const flags = evaluateRetentionFlags({
      ...base,
      lastActivityAt: new Date("2026-08-20T00:00:00.000Z"),
      contractEndDate: new Date("2026-10-01T00:00:00.000Z"),
      latestPositiveSignalAt: new Date("2026-08-25T00:00:00.000Z"),
    });
    expect(flags.map((f) => f.signalType)).not.toContain("retention_renewal_risk");
  });

  it("flags expansion when a recent hiring or funding score is available", () => {
    const flags = evaluateRetentionFlags({
      ...base,
      lastActivityAt: now,
      latestExpansionSignalAt: new Date("2026-08-25T00:00:00.000Z"),
      expansionScore: 42,
    });
    expect(flags.find((f) => f.signalType === "retention_expansion")).toMatchObject({ score: 42 });
  });
});
