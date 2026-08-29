import { describe, expect, it, vi, beforeEach } from "vitest";
vi.mock("@skout/shared", () => ({
  claimNext: vi.fn(),
  recordResult: vi.fn(),
  buildIdempotencyKey: vi.fn((...parts: string[]) => parts.join(":")),
}));
import { claimNext, recordResult } from "@skout/shared";
import { createAutomationRun, claimNextStep, completeStep, failStep, retryFailedSteps } from "./automation-run.service.js";
import { HttpError } from "../utils/http.js";
import type { AutomationGraph } from "./automation-graph.js";

const WORKSPACE_ID = "ws-1";
const GRAPH: AutomationGraph = {
  nodes: [{ id: "n1", type: "delay", config: {} }],
  edges: [],
};

function makeDb() {
  const runReturning = vi.fn().mockResolvedValue([{ id: "run-1", automationId: "auto-1", status: "pending", idempotencyKey: "k1" }]);
  const runValues = vi.fn().mockReturnValue({ returning: runReturning });
  const stepReturning = vi.fn().mockResolvedValue([{ id: "step-1", nodeId: "n1", status: "pending" }]);
  const stepValues = vi.fn().mockReturnValue({ returning: stepReturning });
  const insert = vi.fn((..._args: unknown[]) => {
    return { values: insert.mock.calls.length === 1 ? runValues : stepValues };
  });
  const limit = vi.fn().mockResolvedValue([]);
  const where = vi.fn().mockReturnValue({ limit, orderBy: vi.fn().mockReturnValue({ limit }) });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const setReturning = vi.fn().mockResolvedValue([{ id: "step-1", status: "claimed" }]);
  const set = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: setReturning }) });
  const update = vi.fn().mockReturnValue({ set });
  return { insert, select, update } as any;
}

describe("automation-run.service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("createAutomationRun inserts a run row with status=pending", async () => {
    const db = makeDb();
    const run = await createAutomationRun(db, {
      automationId: "auto-1",
      automationVersionId: "v-1",
      workspaceId: WORKSPACE_ID,
      triggerType: "manual",
      graph: GRAPH,
      idempotencyKey: "k1",
    });
    expect(run.status).toBe("pending");
    expect(db.insert).toHaveBeenCalled();
  });

  describe("retryFailedSteps", () => {
    function makeRetryDb(existingRun: Record<string, unknown> | null) {
      const runSelectLimit = vi.fn().mockResolvedValue(existingRun ? [existingRun] : []);
      const runSelectWhere = vi.fn().mockReturnValue({ limit: runSelectLimit });
      const select = vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: runSelectWhere }) });

      const stepsUpdateWhere = vi.fn().mockResolvedValue(undefined);
      const stepsUpdateSet = vi.fn().mockReturnValue({ where: stepsUpdateWhere });

      const runUpdateReturning = vi.fn().mockResolvedValue([{ ...existingRun, status: "running", finishedAt: null }]);
      const runUpdateWhere = vi.fn().mockReturnValue({ returning: runUpdateReturning });
      const runUpdateSet = vi.fn().mockReturnValue({ where: runUpdateWhere });

      let updateCalls = 0;
      const update = vi.fn(() => {
        updateCalls += 1;
        return { set: updateCalls === 1 ? stepsUpdateSet : runUpdateSet };
      });

      return { select, update } as any;
    }

    it("throws 404 when the run doesn't exist", async () => {
      const db = makeRetryDb(null);
      await expect(retryFailedSteps(db, WORKSPACE_ID, "run-missing")).rejects.toThrow(HttpError);
    });

    it("throws 422 when the run isn't in a failed state", async () => {
      const db = makeRetryDb({ id: "run-1", workspaceId: WORKSPACE_ID, status: "succeeded" });
      await expect(retryFailedSteps(db, WORKSPACE_ID, "run-1")).rejects.toThrow(HttpError);
    });

    it("resets failed steps to pending and reopens the run", async () => {
      const db = makeRetryDb({ id: "run-1", workspaceId: WORKSPACE_ID, status: "failed" });
      const updated = await retryFailedSteps(db, WORKSPACE_ID, "run-1");
      expect(updated.status).toBe("running");
      expect(db.update).toHaveBeenCalledTimes(2);
    });
  });
});

describe("automation-run.service — execution-intent delegation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claimNextStep delegates to claimNext with a 60s lease", async () => {
    vi.mocked(claimNext).mockResolvedValue({ id: "step-1", status: "claimed" } as never);
    const result = await claimNextStep({} as never, "run-1", "worker-1");
    expect(claimNext).toHaveBeenCalledWith(expect.anything(), expect.anything(), "worker-1", 60_000, expect.anything());
    expect(result).toEqual({ id: "step-1", status: "claimed" });
  });

  it("completeStep delegates to recordResult with status succeeded", async () => {
    vi.mocked(recordResult).mockResolvedValue({ id: "step-1", status: "succeeded" } as never);
    const result = await completeStep({} as never, "step-1", "worker-1", { ok: true });
    expect(recordResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "step-1",
      "worker-1",
      expect.objectContaining({ status: "succeeded", output: { ok: true } })
    );
    expect(result.status).toBe("succeeded");
  });

  it("failStep delegates to recordResult with status failed", async () => {
    vi.mocked(recordResult).mockResolvedValue({ id: "step-1", status: "failed" } as never);
    const result = await failStep({} as never, "step-1", "worker-1", "boom");
    expect(recordResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "step-1",
      "worker-1",
      expect.objectContaining({ status: "failed", error: "boom" })
    );
    expect(result.status).toBe("failed");
  });
});
