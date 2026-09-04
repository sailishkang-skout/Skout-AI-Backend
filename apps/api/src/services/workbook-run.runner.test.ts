import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@skout/db";

const getActivation = vi.fn();
const enrichProspect = vi.fn();

vi.mock("./enrichment/index.js", () => ({
  buildEnrichmentService: vi.fn(() => ({ getActivation, enrichProspect })),
  InsufficientCreditsError: class InsufficientCreditsError extends Error {
    constructor(
      public readonly required: number,
      public readonly available: number
    ) {
      super(`Insufficient credits: need ${required}, have ${available}`);
      this.name = "InsufficientCreditsError";
    }
  },
}));

const emitSkoutEvent = vi.fn(async (_db: unknown, _config: unknown, input: unknown) => ({ id: "evt-1", ...(input as object) }));
vi.mock("./skout-event.service.js", () => ({ emitSkoutEvent }));

const { InsufficientCreditsError } = await import("./enrichment/index.js");
const { runWorkbookRunJob } = await import("./workbook-run.runner.js");

const WORKSPACE = "ws-1";
const RUN_ID = "run-1";
const config = {} as never;

const WORKBOOK_ROW = {
  id: "wb-1",
  workspaceId: WORKSPACE,
  name: "wb",
  fields: ["company", "email"],
  emailQualityThreshold: null,
  budgetCreditsPerRun: null,
  status: "active",
  activatedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

function baseRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    workbookId: "wb-1",
    workspaceId: WORKSPACE,
    listId: "list-1",
    mode: "scheduled",
    targetProspectIds: ["p1", "p2", "p3"],
    batchId: null,
    status: "pending",
    totalRows: 3,
    processedRows: 0,
    succeededRows: 0,
    failedRows: 0,
    creditsBudget: null,
    creditsUsed: 0,
    rerunOfRunId: null,
    errorMessage: null,
    queuedAt: new Date(),
    startedAt: null,
    pausedAt: null,
    completedAt: null,
    ...overrides,
  };
}

/** Fake db keyed on drizzle table identity so the same select/update code path works for both tables. */
function makeFakeDb(run: ReturnType<typeof baseRun>, workbook: typeof WORKBOOK_ROW | null = WORKBOOK_ROW) {
  let runState = { ...run };
  let batchState: Record<string, unknown> | null = null;
  let batchCounter = 0;

  const db = {
    select: vi.fn((_cols?: unknown) => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          if (table === schema.enrichmentWorkbookRuns) return Promise.resolve([runState]);
          if (table === schema.enrichmentWorkbooks) return Promise.resolve(workbook ? [workbook] : []);
          return Promise.resolve([]);
        }),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((patch: Record<string, unknown>) => ({
        where: vi.fn(() => {
          if (table === schema.enrichmentWorkbookRuns) runState = { ...runState, ...patch };
          if (table === schema.enrichmentBatches && batchState) batchState = { ...batchState, ...patch };
          return Promise.resolve(undefined);
        }),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((vals: Record<string, unknown>) => ({
        returning: vi.fn(() => {
          if (table === schema.enrichmentBatches) {
            batchCounter += 1;
            batchState = { id: `batch-${batchCounter}`, ...vals };
            return Promise.resolve([batchState]);
          }
          return Promise.resolve([{ id: "x", ...vals }]);
        }),
      })),
    })),
  };
  return { db, getRunState: () => runState, getBatchState: () => batchState };
}

function okJob(prospectId: string, creditsUsed = 1) {
  return { id: `job-${prospectId}`, status: "completed", creditsUsed };
}

beforeEach(() => {
  vi.clearAllMocks();
  getActivation.mockImplementation((_ws: string, prospectId: string) =>
    Promise.resolve({ id: `act-${prospectId}`, snapshot: { companyDomain: "acme.com" } })
  );
});

describe("runWorkbookRunJob", () => {
  it("processes every target row and marks the run completed", async () => {
    enrichProspect.mockImplementation((_ws: string, snap: { prospectId: string }) =>
      Promise.resolve(okJob(snap.prospectId))
    );
    const { db, getRunState, getBatchState } = makeFakeDb(baseRun());

    await runWorkbookRunJob(db as never, config, RUN_ID, WORKSPACE);

    const state = getRunState();
    expect(state.status).toBe("completed");
    expect(state.processedRows).toBe(3);
    expect(state.succeededRows).toBe(3);
    expect(state.failedRows).toBe(0);
    expect(state.creditsUsed).toBe(3);
    expect(state.completedAt).toBeInstanceOf(Date);
    expect(getBatchState()?.status).toBe("completed");
    expect(enrichProspect).toHaveBeenCalledTimes(3);
    expect(emitSkoutEvent).toHaveBeenCalledWith(
      db,
      config,
      expect.objectContaining({
        type: "enrichment.completed",
        tenantId: WORKSPACE,
        aggregateId: RUN_ID,
        data: expect.objectContaining({ runId: RUN_ID, status: "completed", succeededRows: 3 }),
      })
    );
  });

  it("counts a missing activation as a failed row without calling enrichProspect", async () => {
    getActivation.mockImplementation((_ws: string, prospectId: string) =>
      Promise.resolve(prospectId === "p2" ? null : { id: `act-${prospectId}`, snapshot: {} })
    );
    enrichProspect.mockImplementation((_ws: string, snap: { prospectId: string }) =>
      Promise.resolve(okJob(snap.prospectId))
    );
    const { db, getRunState } = makeFakeDb(baseRun());

    await runWorkbookRunJob(db as never, config, RUN_ID, WORKSPACE);

    const state = getRunState();
    expect(state.status).toBe("partial");
    expect(state.succeededRows).toBe(2);
    expect(state.failedRows).toBe(1);
    expect(enrichProspect).toHaveBeenCalledTimes(2);
  });

  it("marks the run failed when every row fails", async () => {
    getActivation.mockResolvedValue(null);
    const { db, getRunState } = makeFakeDb(baseRun());

    await runWorkbookRunJob(db as never, config, RUN_ID, WORKSPACE);

    expect(getRunState().status).toBe("failed");
  });

  it("stops at the next row boundary when paused mid-run, leaving processedRows accurate for resume", async () => {
    let calls = 0;
    const fake = makeFakeDb(baseRun());
    enrichProspect.mockImplementation((_ws: string, snap: { prospectId: string }) => {
      calls += 1;
      // Simulate a pause request landing while row 1 (p1) is in flight — p1 still
      // finishes (the status check already passed for it), but the loop sees
      // "paused" at the top of the next iteration and stops before touching p2.
      if (calls === 1) fake.getRunState().status = "paused";
      return Promise.resolve(okJob(snap.prospectId));
    });

    await runWorkbookRunJob(fake.db as never, config, RUN_ID, WORKSPACE);

    const state = fake.getRunState();
    expect(state.status).toBe("paused"); // left as paused, not overwritten to completed/partial
    expect(state.processedRows).toBe(1); // only row 1 (p1) actually completed before the pause was seen
    expect(state.completedAt).toBeNull();
    expect(enrichProspect).toHaveBeenCalledTimes(1);
  });

  it("resumes from processedRows and never reprocesses earlier rows", async () => {
    enrichProspect.mockImplementation((_ws: string, snap: { prospectId: string }) =>
      Promise.resolve(okJob(snap.prospectId))
    );
    const { db, getRunState } = makeFakeDb(
      baseRun({ status: "running", processedRows: 1, succeededRows: 1, batchId: "batch-existing" })
    );

    await runWorkbookRunJob(db as never, config, RUN_ID, WORKSPACE);

    expect(enrichProspect).toHaveBeenCalledTimes(2); // only p2, p3
    expect(enrichProspect.mock.calls.map((c) => (c[1] as { prospectId: string }).prospectId)).toEqual(["p2", "p3"]);
    expect(getRunState().processedRows).toBe(3);
    expect(getRunState().status).toBe("completed");
  });

  it("stops early once the workbook's per-run credit budget is spent, leaving the run partial", async () => {
    enrichProspect.mockImplementation((_ws: string, snap: { prospectId: string }) =>
      Promise.resolve(okJob(snap.prospectId, 5))
    );
    const { db, getRunState } = makeFakeDb(baseRun({ creditsBudget: 5 }));

    await runWorkbookRunJob(db as never, config, RUN_ID, WORKSPACE);

    const state = getRunState();
    expect(state.status).toBe("partial");
    expect(state.errorMessage).toBe("budget_exhausted");
    expect(state.processedRows).toBe(1); // stopped right after the row that hit the budget
    expect(enrichProspect).toHaveBeenCalledTimes(1);
  });

  it("stops the whole run (not just one row) when the workspace runs out of credits", async () => {
    enrichProspect.mockImplementation((_ws: string, snap: { prospectId: string }) => {
      if (snap.prospectId === "p2") return Promise.reject(new InsufficientCreditsError(10, 0));
      return Promise.resolve(okJob(snap.prospectId));
    });
    const { db, getRunState } = makeFakeDb(baseRun());

    await runWorkbookRunJob(db as never, config, RUN_ID, WORKSPACE);

    const state = getRunState();
    expect(state.status).toBe("partial");
    expect(state.errorMessage).toBe("insufficient_credits");
    expect(state.processedRows).toBe(1); // p1 succeeded; p2's failed attempt isn't counted as processed
    expect(enrichProspect).toHaveBeenCalledTimes(2); // never reaches p3
  });

  it("does nothing when re-entered for a run that's already paused (guards against a stale enqueue)", async () => {
    const { db } = makeFakeDb(baseRun({ status: "paused" }));
    await runWorkbookRunJob(db as never, config, RUN_ID, WORKSPACE);
    expect(enrichProspect).not.toHaveBeenCalled();
  });

  it("marks the run failed when the workbook backing it no longer exists", async () => {
    const { db, getRunState } = makeFakeDb(baseRun(), null);
    await runWorkbookRunJob(db as never, config, RUN_ID, WORKSPACE);
    expect(getRunState().status).toBe("failed");
    expect(getRunState().errorMessage).toBe("workbook_not_found");
  });
});
