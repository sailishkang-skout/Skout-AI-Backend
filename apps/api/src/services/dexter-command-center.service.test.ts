import { describe, expect, it, vi } from "vitest";
import { schema } from "@skout/db";

vi.mock("./policy-gateway.service.js", () => ({
  listPolicies: vi.fn(async () => []),
  listDecisions: vi.fn(async () => []),
}));
vi.mock("./decision-workflow.service.js", () => ({
  listDecisionViews: vi.fn(async () => []),
}));

const computeDexterPlanMetrics = vi.fn();
const computeWorkspaceEvaluationSummary = vi.fn(async (..._args: unknown[]) => ({
  acceptedCount: 1,
  rejectedCount: 1,
  pendingCount: 0,
  acceptedRate: 0.5,
}));
vi.mock("./dexter-evaluation-loop.service.js", () => ({
  computeDexterPlanMetrics: (...args: unknown[]) => computeDexterPlanMetrics(...args),
  computeWorkspaceEvaluationSummary: (...args: unknown[]) => computeWorkspaceEvaluationSummary(...args),
}));

const { getDexterCommandCenter } = await import("./dexter-command-center.service.js");

const WORKSPACE = "ws-1";

function makeDb(plans: Record<string, unknown>[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(table === schema.dexterPlans ? plans : [])),
          })),
        })),
      })),
    })),
  } as never;
}

describe("getDexterCommandCenter — Evaluation Loop wiring", () => {
  it("attaches decision/replyRate/meetingRate per plan and the workspace summary", async () => {
    computeDexterPlanMetrics.mockResolvedValueOnce({
      decision: "accepted",
      decidedAt: new Date(),
      linkedSequenceIds: ["seq-1"],
      enrollmentCount: 10,
      replyRate: 0.4,
      meetingRate: 0.1,
    });

    const plan = {
      id: "plan-1",
      brief: "Q4 outbound",
      status: "invoked",
      policyMode: "approve",
      proposal: {},
      createdAt: new Date(),
      approvedAt: new Date(),
      invokedAt: new Date(),
      rejectedAt: null,
    };
    const db = makeDb([plan]);

    const result = await getDexterCommandCenter(db, WORKSPACE);

    expect(result.plans[0]).toMatchObject({ id: "plan-1", decision: "accepted", replyRate: 0.4, meetingRate: 0.1 });
    expect(result.summary.evaluation).toEqual({ acceptedCount: 1, rejectedCount: 1, pendingCount: 0, acceptedRate: 0.5 });
  });

  it("falls back to pending/null when a plan has no computed metrics", async () => {
    computeDexterPlanMetrics.mockResolvedValueOnce(null);
    const plan = {
      id: "plan-2",
      brief: "Cold outreach",
      status: "proposed",
      policyMode: "ask",
      proposal: {},
      createdAt: new Date(),
      approvedAt: null,
      invokedAt: null,
      rejectedAt: null,
    };
    const db = makeDb([plan]);

    const result = await getDexterCommandCenter(db, WORKSPACE);

    expect(result.plans[0]).toMatchObject({ decision: "pending", replyRate: null, meetingRate: null });
  });
});
