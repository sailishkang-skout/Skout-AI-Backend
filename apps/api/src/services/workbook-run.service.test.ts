import { beforeEach, describe, expect, it, vi } from "vitest";

const getListMemberIds = vi.fn();
const getActivation = vi.fn();
const getCredits = vi.fn();
const enqueueWorkbookRunJob = vi.fn().mockResolvedValue(undefined);

vi.mock("./enrichment/index.js", () => ({
  buildEnrichmentService: vi.fn(() => ({ getListMemberIds, getActivation, getCredits })),
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

vi.mock("../workers/workbook-run.queue.js", () => ({ enqueueWorkbookRunJob }));

const { InsufficientCreditsError } = await import("./enrichment/index.js");
const {
  getWorkbookRun,
  pauseWorkbookRun,
  rerunFailedRows,
  resumeWorkbookRun,
  startWorkbookRun,
} = await import("./workbook-run.service.js");
const { HttpError } = await import("../utils/http.js");

const WORKSPACE = "ws-1";
const WORKBOOK_ID = "wb-1";
const LIST_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "run-1";
const config = {} as never;

function selectChain(result: unknown[], terminal: "where" | "limit" = "where") {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = terminal === "where" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  return c;
}

function insertReturning(result: unknown[]) {
  return { values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) };
}

function updateReturning(result: unknown[]) {
  return {
    set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) }),
  };
}

const DRAFT_WORKBOOK_ROW = {
  id: WORKBOOK_ID,
  workspaceId: WORKSPACE,
  name: "wb",
  fields: ["company", "email"],
  emailQualityThreshold: null,
  budgetCreditsPerRun: null,
  status: "draft",
  activatedAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const ACTIVE_WORKBOOK_ROW = { ...DRAFT_WORKBOOK_ROW, status: "active", activatedAt: new Date("2026-01-02T00:00:00Z") };

const RUN_ROW = {
  id: RUN_ID,
  workbookId: WORKBOOK_ID,
  workspaceId: WORKSPACE,
  listId: LIST_ID,
  mode: "scheduled",
  targetProspectIds: ["p1", "p2"],
  batchId: "batch-1",
  status: "running",
  totalRows: 2,
  processedRows: 0,
  succeededRows: 0,
  failedRows: 0,
  creditsBudget: null,
  creditsUsed: 0,
  rerunOfRunId: null,
  errorMessage: null,
  queuedAt: new Date("2026-01-01T00:00:00Z"),
  startedAt: null,
  pausedAt: null,
  completedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  enqueueWorkbookRunJob.mockResolvedValue(undefined);
});

describe("startWorkbookRun", () => {
  it("allows a sample run on a draft (not-yet-activated) workbook", async () => {
    getListMemberIds.mockResolvedValue(["p1", "p2", "p3"]);
    getCredits.mockResolvedValue(1000);
    const db = {
      select: vi.fn().mockReturnValueOnce(selectChain([DRAFT_WORKBOOK_ROW])),
      insert: vi.fn().mockReturnValue(insertReturning([RUN_ROW])),
    };

    const run = await startWorkbookRun(db as never, config, WORKSPACE, WORKBOOK_ID, {
      listId: LIST_ID,
      mode: "sample",
    });

    expect(run.id).toBe(RUN_ID);
    expect(enqueueWorkbookRunJob).toHaveBeenCalledWith(config, { runId: RUN_ID, workspaceId: WORKSPACE });
  });

  it("rejects a non-sample run on a draft workbook — activation is required", async () => {
    const db = { select: vi.fn().mockReturnValueOnce(selectChain([DRAFT_WORKBOOK_ROW])) };
    await expect(
      startWorkbookRun(db as never, config, WORKSPACE, WORKBOOK_ID, { listId: LIST_ID, mode: "scheduled" })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(enqueueWorkbookRunJob).not.toHaveBeenCalled();
  });

  it("throws InsufficientCreditsError before creating a run when balance can't cover even the floor estimate", async () => {
    getListMemberIds.mockResolvedValue(["p1", "p2", "p3"]);
    getCredits.mockResolvedValue(1);
    const db = { select: vi.fn().mockReturnValueOnce(selectChain([ACTIVE_WORKBOOK_ROW])), insert: vi.fn() };

    await expect(
      startWorkbookRun(db as never, config, WORKSPACE, WORKBOOK_ID, { listId: LIST_ID, mode: "scheduled" })
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(db.insert).not.toHaveBeenCalled();
    expect(enqueueWorkbookRunJob).not.toHaveBeenCalled();
  });

  it("rejects mode 'selected' with no ids, and with ids that aren't list members", async () => {
    getListMemberIds.mockResolvedValue(["p1", "p2"]);
    const db = { select: vi.fn().mockReturnValue(selectChain([ACTIVE_WORKBOOK_ROW])) };

    await expect(
      startWorkbookRun(db as never, config, WORKSPACE, WORKBOOK_ID, { listId: LIST_ID, mode: "selected" })
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      startWorkbookRun(db as never, config, WORKSPACE, WORKBOOK_ID, {
        listId: LIST_ID,
        mode: "selected",
        selectedProspectIds: ["not-a-member"],
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("throws workbook_not_found when the workbook doesn't exist", async () => {
    const db = { select: vi.fn().mockReturnValueOnce(selectChain([])) };
    await expect(
      startWorkbookRun(db as never, config, WORKSPACE, WORKBOOK_ID, { listId: LIST_ID, mode: "sample" })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("pauseWorkbookRun / resumeWorkbookRun", () => {
  it("pauses a running run", async () => {
    const paused = { ...RUN_ROW, status: "paused", pausedAt: new Date("2026-01-03T00:00:00Z") };
    const db = {
      select: vi.fn().mockReturnValue(selectChain([RUN_ROW])),
      update: vi.fn().mockReturnValue(updateReturning([paused])),
    };
    const result = await pauseWorkbookRun(db as never, WORKSPACE, RUN_ID);
    expect(result.status).toBe("paused");
  });

  it("rejects pausing a run that's already completed", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([{ ...RUN_ROW, status: "completed" }])) };
    await expect(pauseWorkbookRun(db as never, WORKSPACE, RUN_ID)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("resumes a paused run and re-enqueues it", async () => {
    const pausedRow = { ...RUN_ROW, status: "paused", pausedAt: new Date() };
    const resumedRow = { ...RUN_ROW, status: "running", pausedAt: null };
    const db = {
      select: vi.fn().mockReturnValue(selectChain([pausedRow])),
      update: vi.fn().mockReturnValue(updateReturning([resumedRow])),
    };
    const result = await resumeWorkbookRun(db as never, config, WORKSPACE, RUN_ID);
    expect(result.status).toBe("running");
    expect(enqueueWorkbookRunJob).toHaveBeenCalledWith(config, { runId: RUN_ID, workspaceId: WORKSPACE });
  });

  it("rejects resuming a run that isn't paused", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([RUN_ROW])) };
    await expect(resumeWorkbookRun(db as never, config, WORKSPACE, RUN_ID)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe("rerunFailedRows", () => {
  const FINISHED_RUN = { ...RUN_ROW, status: "partial", failedRows: 1, processedRows: 2, succeededRows: 1 };

  it("rejects when there are no failed rows", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([{ ...FINISHED_RUN, failedRows: 0 }])) };
    await expect(rerunFailedRows(db as never, config, WORKSPACE, RUN_ID)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("creates a new 'selected' run scoped to only the prospects without a completed job", async () => {
    getCredits.mockResolvedValue(1000);
    const completedJobRows = [{ prospectId: "p1" }]; // p2 never got a completed job
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([FINISHED_RUN])) // getWorkbookRun
        .mockReturnValueOnce(selectChain(completedJobRows)) // completed enrichmentJobs for batchId
        .mockReturnValueOnce(selectChain([ACTIVE_WORKBOOK_ROW])), // getWorkbook
      insert: vi.fn().mockReturnValue(insertReturning([{ ...RUN_ROW, id: "run-2", mode: "selected", rerunOfRunId: RUN_ID }])),
    };

    const result = await rerunFailedRows(db as never, config, WORKSPACE, RUN_ID);

    expect(result.id).toBe("run-2");
    const insertCall = (db.insert as ReturnType<typeof vi.fn>).mock.results[0]?.value.values.mock.calls[0][0];
    expect(insertCall).toMatchObject({ mode: "selected", targetProspectIds: ["p2"], rerunOfRunId: RUN_ID });
  });
});
