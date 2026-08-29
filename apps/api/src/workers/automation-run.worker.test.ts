import { describe, expect, it, vi, beforeEach } from "vitest";
import { advanceAutomationRun } from "./automation-run.worker.js";
import * as runService from "../services/automation-run.service.js";
import * as registry from "../services/automation-nodes/registry.js";

const GRAPH = {
  nodes: [{ id: "n1", type: "delay" as const, config: { seconds: 1 } }],
  edges: [],
};

const RUN_ROW = { id: "run-1", automationVersionId: "v-1", workspaceId: "ws-1", isSimulation: false };

/**
 * Models the sequence of raw db.select() calls advanceAutomationRun makes directly (not the ones
 * delegated to the fully-mocked automation-run.service functions): 1) the run row lookup
 * (.where().limit()), 2) the prior-succeeded-steps lookup (.where(), awaited directly), 3+) the
 * "any steps still pending" check before marking the run finished. insert/update are permissive.
 */
function makeAdvanceDb(resultsByCall: unknown[][] = [[RUN_ROW], [], []]) {
  let call = 0;
  function terminal() {
    const arr = resultsByCall[Math.min(call, resultsByCall.length - 1)] ?? [];
    call++;
    const p = Promise.resolve(arr) as Promise<unknown[]> & { limit: () => Promise<unknown[]> };
    p.limit = () => Promise.resolve(arr);
    return p;
  }
  const select = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockImplementation(() => terminal()) }),
  }));
  const insert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  const update = vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) });
  return { select, insert, update } as any;
}

describe("advanceAutomationRun", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claims a step, runs its handler, and marks it succeeded", async () => {
    vi.spyOn(runService, "claimNextStep").mockResolvedValue({ id: "step-1", nodeId: "n1", attempt: 1, automationRunId: "run-1" } as any);
    vi.spyOn(runService, "markStepRunning").mockResolvedValue({} as any);
    vi.spyOn(runService, "completeStep").mockResolvedValue({} as any);
    vi.spyOn(registry, "getNodeHandler").mockReturnValue(async () => ({ output: { ok: true } }));

    await advanceAutomationRun(makeAdvanceDb(), {} as any, { automationRunId: "run-1", workspaceId: "ws-1" }, GRAPH);

    expect(runService.completeStep).toHaveBeenCalledWith(expect.anything(), "step-1", { ok: true });
  });

  it("calls failStep when the node handler throws", async () => {
    vi.spyOn(runService, "claimNextStep").mockResolvedValue({ id: "step-1", nodeId: "n1", attempt: 1, automationRunId: "run-1" } as any);
    vi.spyOn(runService, "markStepRunning").mockResolvedValue({} as any);
    const failSpy = vi.spyOn(runService, "failStep").mockResolvedValue({} as any);
    vi.spyOn(registry, "getNodeHandler").mockReturnValue(async () => {
      throw new Error("boom");
    });

    await advanceAutomationRun(makeAdvanceDb(), {} as any, { automationRunId: "run-1", workspaceId: "ws-1" }, GRAPH);

    expect(failSpy).toHaveBeenCalledWith(expect.anything(), "step-1", "boom");
  });

  it("does nothing when there is no pending step to claim", async () => {
    vi.spyOn(runService, "claimNextStep").mockResolvedValue(null);
    const completeSpy = vi.spyOn(runService, "completeStep");

    await advanceAutomationRun(makeAdvanceDb(), {} as any, { automationRunId: "run-1", workspaceId: "ws-1" }, GRAPH);

    expect(completeSpy).not.toHaveBeenCalled();
  });
});
