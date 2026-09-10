import { beforeEach, describe, expect, it, vi } from "vitest";

const computeCroRollup = vi.fn();
vi.mock("./cro-summary.service.js", () => ({ computeCroRollup }));

const {
  computeActionAcceptance,
  computeCalibration,
  computeFairnessDrift,
  computeOverrideRate,
  computePrecision,
  getModelPerformanceReport,
  recordDecisionEvent,
} = await import("./model-performance.service.js");

const WORKSPACE = "ws-1";
const config = {} as never;

/** A chainable, "thenable" fake — every chain method returns itself, and awaiting the chain at
 * any point (after .where(), .orderBy(), .groupBy(), or none of them) resolves to `result`. Avoids
 * having to know exactly which method the real query chain calls last. */
function selectChain(result: unknown[]) {
  const c: Record<string, unknown> = {
    then: (resolve: (v: unknown[]) => void) => resolve(result),
  };
  c.from = vi.fn().mockReturnValue(c);
  c.innerJoin = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockReturnValue(c);
  c.groupBy = vi.fn().mockReturnValue(c);
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recordDecisionEvent", () => {
  it("inserts a decision event row", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn().mockReturnValue({ values }) };

    await recordDecisionEvent(db as never, {
      workspaceId: WORKSPACE,
      surface: "reply_classification",
      suggestedValue: "positive",
      outcome: "accepted",
      confidence: 0.4,
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE, surface: "reply_classification", outcome: "accepted" })
    );
  });
});

describe("computeActionAcceptance / computeOverrideRate", () => {
  it("computes acceptance and override rates from the same grouped event counts", async () => {
    const db = {
      select: vi
        .fn()
        .mockReturnValue(
          selectChain([{ outcome: "accepted", count: 7 }, { outcome: "overridden", count: 3 }])
        ),
    };

    const acceptance = await computeActionAcceptance(db as never, WORKSPACE);
    expect(acceptance).toEqual({
      surface: "reply_classification",
      total: 10,
      accepted: 7,
      overridden: 3,
      actionAcceptanceRate: 0.7,
      overrideRate: 0.3,
    });

    const override = await computeOverrideRate(db as never, WORKSPACE);
    expect(override.overrideRate).toBe(0.3);
  });

  it("returns zeroed stats when there are no events yet", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };
    const result = await computeActionAcceptance(db as never, WORKSPACE);
    expect(result.total).toBe(0);
    expect(result.actionAcceptanceRate).toBe(0);
    expect(result.overrideRate).toBe(0);
  });
});

describe("computeCalibration", () => {
  it("buckets scores and compares against the real reply rate per bucket", async () => {
    const scores = [
      { prospectId: "p1", score: 10 },
      { prospectId: "p2", score: 85 },
      { prospectId: "p3", score: 90 },
    ];
    const db = {
      select: vi.fn().mockReturnValueOnce(selectChain(scores)),
      selectDistinct: vi.fn().mockReturnValue(selectChain([{ prospectId: "p2" }])),
    };

    const buckets = await computeCalibration(db as never, WORKSPACE);
    const low = buckets.find((b) => b.bucket === "0-20")!;
    const high = buckets.find((b) => b.bucket === "80-100")!;

    expect(low.count).toBe(1);
    expect(low.actualReplyRate).toBe(0);
    expect(high.count).toBe(2);
    expect(high.repliedCount).toBe(1);
    expect(high.actualReplyRate).toBe(0.5);
  });
});

describe("computePrecision", () => {
  it("computes the reply rate among prospects flagged ready", async () => {
    const db = {
      select: vi.fn().mockReturnValueOnce(selectChain([{ prospectId: "p1" }, { prospectId: "p2" }])),
      selectDistinct: vi.fn().mockReturnValue(selectChain([{ prospectId: "p1" }])),
    };

    const result = await computePrecision(db as never, WORKSPACE);
    expect(result).toEqual({ readyCount: 2, readyAndReplied: 1, precision: 0.5 });
  });

  it("returns zero precision when nothing is flagged ready", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])), selectDistinct: vi.fn().mockReturnValue(selectChain([])) };
    const result = await computePrecision(db as never, WORKSPACE);
    expect(result.precision).toBe(0);
  });
});

describe("computeFairnessDrift", () => {
  it("splits scored prospects into an older/newer half and compares average score", async () => {
    const scored = [
      { prospectId: "p1", score: 20, scoredAt: new Date("2026-01-01") },
      { prospectId: "p2", score: 40, scoredAt: new Date("2026-02-01") },
      { prospectId: "p3", score: 80, scoredAt: new Date("2026-03-01") },
      { prospectId: "p4", score: 90, scoredAt: new Date("2026-04-01") },
    ];
    const activations = [
      { prospectId: "p1", snapshot: { industry: "SaaS" } },
      { prospectId: "p2", snapshot: { industry: "SaaS" } },
      { prospectId: "p3", snapshot: { industry: "Retail" } },
      { prospectId: "p4", snapshot: { industry: "Retail" } },
    ];
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain(scored))
        .mockReturnValueOnce(selectChain(activations)),
    };

    const result = await computeFairnessDrift(db as never, WORKSPACE);

    expect(result.temporal.olderAvgScore).toBe(30); // (20+40)/2
    expect(result.temporal.newerAvgScore).toBe(85); // (80+90)/2
    expect(result.temporal.delta).toBe(55);
    expect(result.temporal.sampleSize).toBe(4);

    const saas = result.byIndustry.find((b) => b.industry === "SaaS")!;
    const retail = result.byIndustry.find((b) => b.industry === "Retail")!;
    expect(saas.avgScore).toBe(30);
    expect(retail.avgScore).toBe(85);
  });
});

describe("getModelPerformanceReport", () => {
  it("bundles all 6 dimensions into one report", async () => {
    computeCroRollup.mockResolvedValue({ pipelineValue: 1000 });
    const db = {
      select: vi.fn().mockReturnValue(selectChain([])),
      selectDistinct: vi.fn().mockReturnValue(selectChain([])),
    };

    const report = await getModelPerformanceReport(db as never, config, WORKSPACE);

    expect(report).toHaveProperty("precision");
    expect(report).toHaveProperty("calibration");
    expect(report).toHaveProperty("overrideRate");
    expect(report).toHaveProperty("actionAcceptance");
    expect(report).toHaveProperty("downstreamOutcome");
    expect(report).toHaveProperty("fairnessDrift");
    expect(report.downstreamOutcome).toEqual({ pipelineValue: 1000 });
  });
});
