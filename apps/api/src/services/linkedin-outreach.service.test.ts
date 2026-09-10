import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@skout/shared", () => ({
  claimNext: vi.fn(),
  recordResult: vi.fn(),
  LeaseLostError: class LeaseLostError extends Error {},
}));
vi.mock("../workers/sequence-enrollment.queue.js", () => ({
  enqueueSequenceAdvanceJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./notifications.service.js", () => ({
  resolveNotificationsForEntity: vi.fn().mockResolvedValue(undefined),
}));

import { claimNext, recordResult } from "@skout/shared";
import { resolveNotificationsForEntity } from "./notifications.service.js";
import { LinkedinOutreachService } from "./linkedin-outreach.service.js";

const WORKSPACE_ID = "ws-1";
const JOB_ROW = {
  id: "job-1",
  workspaceId: WORKSPACE_ID,
  enrollmentId: "enr-1",
  enrollmentStepId: "step-1",
  prospectId: "prospect-1",
  status: "pending",
};

function makeDb(selectResult: unknown[] = [JOB_ROW]) {
  const limit = vi.fn().mockResolvedValue(selectResult);
  // `.where(...)` itself must be awaitable (Drizzle's query builder is thenable even before
  // `.limit()` is chained), while still exposing `.limit()` for callers that chain it explicitly
  // (e.g. the enrollment lookup's `.limit(1)`).
  const where = vi.fn().mockReturnValue({
    limit,
    then: (resolve: (value: unknown) => void) => resolve(selectResult),
  });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });
  return { select, update } as any;
}

describe("LinkedinOutreachService — execution-intent delegation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claimJob delegates to claimNext scoped to the specific job id", async () => {
    vi.mocked(claimNext).mockResolvedValue({ ...JOB_ROW, status: "claimed" } as never);
    const db = makeDb([JOB_ROW]);
    const svc = new LinkedinOutreachService(db, {} as never);

    const result = await svc.claimJob(WORKSPACE_ID, "job-1");

    expect(claimNext).toHaveBeenCalledWith(db, expect.anything(), expect.any(String), 60_000, expect.anything());
    expect(result.status).toBe("claimed");
  });

  it("claimJob returns the pre-claim job row when claimNext finds nothing to claim (already claimed elsewhere)", async () => {
    vi.mocked(claimNext).mockResolvedValue(undefined);
    const db = makeDb([JOB_ROW]);
    const svc = new LinkedinOutreachService(db, {} as never);

    const result = await svc.claimJob(WORKSPACE_ID, "job-1");

    expect(result).toEqual(JOB_ROW);
  });

  it("completeJob delegates to recordResult with status succeeded", async () => {
    vi.mocked(recordResult).mockResolvedValue({ ...JOB_ROW, status: "succeeded" } as never);
    const db = makeDb([JOB_ROW]);
    const svc = new LinkedinOutreachService(db, {} as never);

    await svc.completeJob(WORKSPACE_ID, "job-1");

    expect(recordResult).toHaveBeenCalledWith(
      db,
      expect.anything(),
      "job-1",
      expect.any(String),
      expect.objectContaining({ status: "succeeded" })
    );
  });

  it("failJob delegates to recordResult with status failed", async () => {
    vi.mocked(recordResult).mockResolvedValue({ ...JOB_ROW, status: "failed" } as never);
    const db = makeDb([JOB_ROW]);
    const svc = new LinkedinOutreachService(db, {} as never);

    await svc.failJob(WORKSPACE_ID, "job-1", "boom");

    expect(recordResult).toHaveBeenCalledWith(
      db,
      expect.anything(),
      "job-1",
      expect.any(String),
      expect.objectContaining({ status: "failed", failureReason: "boom" })
    );
  });

  it("recordOutcomeUnknown delegates to recordResult with status outcome_unknown", async () => {
    vi.mocked(recordResult).mockResolvedValue({ ...JOB_ROW, status: "outcome_unknown" } as never);
    const db = makeDb([JOB_ROW]);
    const svc = new LinkedinOutreachService(db, {} as never);

    await svc.recordOutcomeUnknown(WORKSPACE_ID, "job-1", "unipile timeout");

    expect(recordResult).toHaveBeenCalledWith(
      db,
      expect.anything(),
      "job-1",
      expect.any(String),
      expect.objectContaining({ status: "outcome_unknown", failureReason: "unipile timeout" })
    );
  });

  it("failJob resolves the step's open notifications (a real failure no longer needs a human)", async () => {
    vi.mocked(recordResult).mockResolvedValue({ ...JOB_ROW, status: "failed" } as never);
    const db = makeDb([JOB_ROW]);
    const svc = new LinkedinOutreachService(db, {} as never);

    await svc.failJob(WORKSPACE_ID, "job-1", "boom");

    expect(resolveNotificationsForEntity).toHaveBeenCalledWith(db, "sequence_enrollment_step", "step-1");
  });

  it("recordOutcomeUnknown does NOT resolve the step's open notifications — ambiguous outcomes still need human reconciliation", async () => {
    vi.mocked(recordResult).mockResolvedValue({ ...JOB_ROW, status: "outcome_unknown" } as never);
    const db = makeDb([JOB_ROW]);
    const svc = new LinkedinOutreachService(db, {} as never);

    await svc.recordOutcomeUnknown(WORKSPACE_ID, "job-1", "unipile timeout");

    expect(resolveNotificationsForEntity).not.toHaveBeenCalled();
  });
});
