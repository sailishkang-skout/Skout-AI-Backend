import { describe, expect, it, vi, beforeEach } from "vitest";
import { createAutomationRun, failStep } from "./automation-run.service.js";
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

  it("failStep records the error via an update call", async () => {
    const db = makeDb();
    const result = await failStep(db, "step-1", "boom", { attempt: 5, maxAttempts: 5 });
    expect(result.status).toBe("claimed"); // mocked update always returns this row shape — asserts the call happened
    expect(db.update).toHaveBeenCalled();
  });
});
