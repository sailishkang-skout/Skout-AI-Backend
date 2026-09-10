import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../lib/redis.js", () => ({
  isRedisAvailable: vi.fn().mockResolvedValue(true),
  redisBullMqConnection: vi.fn().mockReturnValue({ host: "localhost", port: 6379 }),
}));
vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) })),
}));
vi.mock("@skout/db", () => ({
  createDb: vi.fn().mockReturnValue({ db: {}, sql: { end: vi.fn().mockResolvedValue(undefined) } }),
  schema: { automationRuns: {}, automationVersions: {}, automationRunSteps: {} },
}));
vi.mock("@skout/shared", () => ({
  reclaimExpiredLeases: vi.fn().mockResolvedValue({ requeuedIds: [], failedIds: [] }),
  // advanceAutomationRun's own tests below don't exercise real lease renewal — the handler
  // resolves synchronously in these tests, so just run the wrapped work directly.
  withLeaseHeartbeat: vi.fn((_db, _table, _id, _workerId, _leaseMs, work) => work()),
  buildIdempotencyKey: vi.fn((...parts: string[]) => parts.join(":")),
  LeaseLostError: class LeaseLostError extends Error {},
}));
vi.mock("./automation-run.queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./automation-run.queue.js")>();
  return { ...actual, enqueueAutomationRunAdvance: vi.fn().mockResolvedValue(undefined) };
});

import { createDb } from "@skout/db";
import { reclaimExpiredLeases, LeaseLostError } from "@skout/shared";
import { advanceAutomationRun, startAutomationRunWorker } from "./automation-run.worker.js";
import { enqueueAutomationRunAdvance } from "./automation-run.queue.js";
import * as runService from "../services/automation-run.service.js";
import * as registry from "../services/automation-nodes/registry.js";
import { AmbiguousOutcomeError } from "../services/automation-nodes/types.js";

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
  const insert = vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }) });
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

    expect(runService.completeStep).toHaveBeenCalledWith(expect.anything(), "step-1", expect.any(String), { ok: true });
  });

  it("calls failStep when the node handler throws", async () => {
    vi.spyOn(runService, "claimNextStep").mockResolvedValue({ id: "step-1", nodeId: "n1", attempt: 1, automationRunId: "run-1" } as any);
    vi.spyOn(runService, "markStepRunning").mockResolvedValue({} as any);
    const failSpy = vi.spyOn(runService, "failStep").mockResolvedValue({} as any);
    vi.spyOn(registry, "getNodeHandler").mockReturnValue(async () => {
      throw new Error("boom");
    });

    await advanceAutomationRun(makeAdvanceDb(), {} as any, { automationRunId: "run-1", workspaceId: "ws-1" }, GRAPH);

    expect(failSpy).toHaveBeenCalledWith(expect.anything(), "step-1", expect.any(String), "boom", "failed");
  });

  it("does nothing when there is no pending step to claim", async () => {
    vi.spyOn(runService, "claimNextStep").mockResolvedValue(null);
    const completeSpy = vi.spyOn(runService, "completeStep");

    await advanceAutomationRun(makeAdvanceDb(), {} as any, { automationRunId: "run-1", workspaceId: "ws-1" }, GRAPH);

    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("routes a resolved ambiguous outcome to failStep(..., \"outcome_unknown\") instead of completeStep", async () => {
    vi.spyOn(runService, "claimNextStep").mockResolvedValue({ id: "step-1", nodeId: "n1", attempt: 1, automationRunId: "run-1" } as any);
    vi.spyOn(runService, "markStepRunning").mockResolvedValue({} as any);
    const completeSpy = vi.spyOn(runService, "completeStep").mockResolvedValue({} as any);
    const failSpy = vi.spyOn(runService, "failStep").mockResolvedValue({} as any);
    vi.spyOn(registry, "getNodeHandler").mockReturnValue(async () => ({ output: {}, outcome: "ambiguous" }));

    await advanceAutomationRun(makeAdvanceDb(), {} as any, { automationRunId: "run-1", workspaceId: "ws-1" }, GRAPH);

    expect(failSpy).toHaveBeenCalledWith(expect.anything(), "step-1", expect.any(String), expect.any(String), "outcome_unknown");
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("routes a thrown AmbiguousOutcomeError to failStep(..., \"outcome_unknown\")", async () => {
    vi.spyOn(runService, "claimNextStep").mockResolvedValue({ id: "step-1", nodeId: "n1", attempt: 1, automationRunId: "run-1" } as any);
    vi.spyOn(runService, "markStepRunning").mockResolvedValue({} as any);
    const completeSpy = vi.spyOn(runService, "completeStep").mockResolvedValue({} as any);
    const failSpy = vi.spyOn(runService, "failStep").mockResolvedValue({} as any);
    vi.spyOn(registry, "getNodeHandler").mockReturnValue(async () => {
      throw new AmbiguousOutcomeError("fetch failed: timeout");
    });

    await advanceAutomationRun(makeAdvanceDb(), {} as any, { automationRunId: "run-1", workspaceId: "ws-1" }, GRAPH);

    expect(failSpy).toHaveBeenCalledWith(expect.anything(), "step-1", expect.any(String), "fetch failed: timeout", "outcome_unknown");
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("stands down without touching run/step status when completeStep loses its lease", async () => {
    vi.spyOn(runService, "claimNextStep").mockResolvedValue({ id: "step-1", nodeId: "n1", attempt: 1, automationRunId: "run-1" } as any);
    vi.spyOn(runService, "markStepRunning").mockResolvedValue({} as any);
    const failSpy = vi.spyOn(runService, "failStep").mockResolvedValue({} as any);
    vi.spyOn(runService, "completeStep").mockRejectedValue(new LeaseLostError("step-1"));
    vi.spyOn(registry, "getNodeHandler").mockReturnValue(async () => ({ output: { ok: true } }));

    const db = makeAdvanceDb();
    await advanceAutomationRun(db, {} as any, { automationRunId: "run-1", workspaceId: "ws-1" }, GRAPH);

    // Another worker already owns this step — this worker must not call failStep (that would
    // fight the new owner) or update the run's status.
    expect(failSpy).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("logs and stands down (without throwing) when failStep's own recovery call loses its lease", async () => {
    vi.spyOn(runService, "claimNextStep").mockResolvedValue({ id: "step-1", nodeId: "n1", attempt: 1, automationRunId: "run-1" } as any);
    vi.spyOn(runService, "markStepRunning").mockResolvedValue({} as any);
    vi.spyOn(runService, "failStep").mockRejectedValue(new LeaseLostError("step-1"));
    vi.spyOn(registry, "getNodeHandler").mockReturnValue(async () => {
      throw new Error("boom");
    });

    const db = makeAdvanceDb();
    // Must not throw — the secondary LeaseLostError from failStep's own call has to be caught,
    // not escape advanceAutomationRun uncaught.
    await expect(advanceAutomationRun(db, {} as any, { automationRunId: "run-1", workspaceId: "ws-1" }, GRAPH)).resolves.toBeUndefined();
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("startAutomationRunWorker — reclaim sweep", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts a reclaim sweep interval and stops it on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const stop = await startAutomationRunWorker({ DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" } as never);
      await vi.advanceTimersByTimeAsync(31_000); // > the 30s sweep interval
      expect(reclaimExpiredLeases).toHaveBeenCalled();
      await stop();
      const callsBeforeStop = vi.mocked(reclaimExpiredLeases).mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.mocked(reclaimExpiredLeases).mock.calls.length).toBe(callsBeforeStop); // no more calls after stop
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-enqueues an advance job for every run affected by a requeue, but not a failure", async () => {
    vi.mocked(reclaimExpiredLeases).mockResolvedValue({
      requeuedIds: ["step-1", "step-2"],
      failedIds: ["step-3"],
    });
    const affectedRuns = [
      { automationRunId: "run-1", workspaceId: "ws-1" },
      { automationRunId: "run-2", workspaceId: "ws-2" },
    ];
    const where = vi.fn().mockResolvedValue(affectedRuns);
    const innerJoin = vi.fn().mockReturnValue({ where });
    const from = vi.fn().mockReturnValue({ innerJoin });
    const selectDistinct = vi.fn().mockReturnValue({ from });
    vi.mocked(createDb).mockReturnValueOnce({
      db: { selectDistinct },
      sql: { end: vi.fn().mockResolvedValue(undefined) },
    } as any);

    vi.useFakeTimers();
    try {
      const stop = await startAutomationRunWorker({ DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" } as never);
      await vi.advanceTimersByTimeAsync(31_000);

      expect(selectDistinct).toHaveBeenCalled();
      expect(enqueueAutomationRunAdvance).toHaveBeenCalledWith(expect.anything(), { automationRunId: "run-1", workspaceId: "ws-1" });
      expect(enqueueAutomationRunAdvance).toHaveBeenCalledWith(expect.anything(), { automationRunId: "run-2", workspaceId: "ws-2" });
      expect(enqueueAutomationRunAdvance).toHaveBeenCalledTimes(2); // failedIds' run never re-enqueued from here

      await stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not query for affected runs when nothing was requeued", async () => {
    vi.mocked(reclaimExpiredLeases).mockResolvedValue({ requeuedIds: [], failedIds: ["step-3"] });
    const selectDistinct = vi.fn();
    vi.mocked(createDb).mockReturnValueOnce({
      db: { selectDistinct },
      sql: { end: vi.fn().mockResolvedValue(undefined) },
    } as any);

    vi.useFakeTimers();
    try {
      const stop = await startAutomationRunWorker({ DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" } as never);
      await vi.advanceTimersByTimeAsync(31_000);

      expect(selectDistinct).not.toHaveBeenCalled();
      expect(enqueueAutomationRunAdvance).not.toHaveBeenCalled();

      await stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
