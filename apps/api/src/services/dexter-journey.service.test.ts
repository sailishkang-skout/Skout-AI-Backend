import { describe, expect, it, vi, beforeEach } from "vitest";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";

vi.mock("./policy-gateway.service.js", () => ({
  classifyAndRecord: vi.fn(async () => ({ mode: "approve", outcome: "allowed", decisionId: "decision-1" })),
  assertAllowed: vi.fn(async () => ({ mode: "approve", outcome: "allowed", decisionId: "decision-1" })),
}));
vi.mock("./journey-metrics.js", () => ({ incrJourneyMetric: vi.fn() }));
vi.mock("./intelligence-layer.service.js", () => ({
  captureFeedback: vi.fn((f: unknown) => f),
}));
vi.mock("./decision-workflow.service.js", () => ({
  startWorkflowRun: vi.fn(async () => ({ id: "workflow-1", steps: [] })),
}));
const emitSkoutEvent = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("./skout-event.service.js", () => ({
  emitSkoutEvent: (...args: unknown[]) => emitSkoutEvent(...args),
}));

const { rejectDexterPlan, approveDexterPlan, invokeDexterPlan } = await import("./dexter-journey.service.js");

const config = {} as Env;
const WORKSPACE = "ws-1";
const PLAN_ID = "plan-1";

beforeEach(() => {
  vi.clearAllMocks();
});

function basePlan(overrides: Record<string, unknown> = {}) {
  return {
    id: PLAN_ID,
    workspaceId: WORKSPACE,
    brief: "Enroll cold accounts in Q4 outbound",
    proposal: { steps: [] },
    status: "proposed",
    policyMode: "approve",
    policyDecisionId: null,
    outcome: null,
    approvedAt: null,
    invokedAt: null,
    rejectedAt: null,
    rejectedBy: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/** Fake db dispatching on drizzle table identity, mirroring the pattern used elsewhere in this
 * repo's tests (e.g. workbook-run.runner.test.ts) for services that touch more than one table. */
function makeFakeDb(opts: {
  plan: ReturnType<typeof basePlan> | null;
  sequenceExists?: boolean;
  updatedPlanPatch?: Record<string, unknown>;
}) {
  const { plan, sequenceExists = true, updatedPlanPatch = {} } = opts;
  let planState = plan ? { ...plan } : null;
  const sequenceUpdateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

  const db = {
    select: vi.fn((cols?: unknown) => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(() =>
            Promise.resolve(
              table === schema.dexterPlans ? (planState ? [planState] : []) : sequenceExists ? [{ id: "seq-1" }] : []
            )
          ),
        })),
      })),
    })),
    update: vi.fn((table: unknown) => {
      if (table === schema.sequences) return { set: sequenceUpdateSet };
      return {
        set: vi.fn((patch: Record<string, unknown>) => ({
          where: vi.fn(() => ({
            returning: vi.fn(() => {
              planState = { ...(planState as object), ...patch, ...updatedPlanPatch } as typeof planState;
              return Promise.resolve([planState]);
            }),
          })),
        })),
      };
    }),
  };
  return { db: db as never, sequenceUpdateSet };
}

describe("rejectDexterPlan", () => {
  it("declines a proposed plan and emits dexter.plan.rejected", async () => {
    const { db } = makeFakeDb({ plan: basePlan() });

    const updated = await rejectDexterPlan(db, config, WORKSPACE, PLAN_ID, "user-1", "not relevant right now");

    expect(updated.status).toBe("rejected");
    expect(updated.rejectedAt).toBeInstanceOf(Date);
    expect(emitSkoutEvent).toHaveBeenCalledWith(
      db,
      config,
      expect.objectContaining({
        type: "dexter.plan.rejected",
        tenantId: WORKSPACE,
        aggregateId: PLAN_ID,
        data: expect.objectContaining({ planId: PLAN_ID, reason: "not relevant right now" }),
      })
    );
  });

  it("404s when the plan does not exist", async () => {
    const { db } = makeFakeDb({ plan: null });
    await expect(rejectDexterPlan(db, config, WORKSPACE, "missing")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("422s when the plan is not in 'proposed' status", async () => {
    const { db } = makeFakeDb({ plan: basePlan({ status: "approved" }) });
    await expect(rejectDexterPlan(db, config, WORKSPACE, PLAN_ID)).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("invokeDexterPlan", () => {
  it("invokes an approved plan without a sequenceId exactly as before (backward compatible)", async () => {
    const { db, sequenceUpdateSet } = makeFakeDb({ plan: basePlan({ status: "approved" }) });

    const result = await invokeDexterPlan(db, config, WORKSPACE, PLAN_ID, "user-1");

    expect(result.plan.status).toBe("invoked");
    expect(sequenceUpdateSet).not.toHaveBeenCalled();
  });

  it("links the named sequence to the plan when sequenceId is provided", async () => {
    const { db, sequenceUpdateSet } = makeFakeDb({ plan: basePlan({ status: "approved" }), sequenceExists: true });

    await invokeDexterPlan(db, config, WORKSPACE, PLAN_ID, "user-1", { sequenceId: "seq-1" });

    expect(sequenceUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ dexterPlanId: PLAN_ID }));
  });

  it("404s when the given sequenceId does not belong to the workspace", async () => {
    const { db, sequenceUpdateSet } = makeFakeDb({ plan: basePlan({ status: "approved" }), sequenceExists: false });

    await expect(
      invokeDexterPlan(db, config, WORKSPACE, PLAN_ID, "user-1", { sequenceId: "someone-elses-seq" })
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(sequenceUpdateSet).not.toHaveBeenCalled();
  });

  it("422s when the plan is not approved yet", async () => {
    const { db } = makeFakeDb({ plan: basePlan({ status: "proposed" }) });
    await expect(invokeDexterPlan(db, config, WORKSPACE, PLAN_ID)).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("approveDexterPlan (regression check)", () => {
  it("still approves a proposed plan", async () => {
    const { db } = makeFakeDb({ plan: basePlan() });
    const updated = await approveDexterPlan(db, config, WORKSPACE, PLAN_ID);
    expect(updated.status).toBe("approved");
  });
});
