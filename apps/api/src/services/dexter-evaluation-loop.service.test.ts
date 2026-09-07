import { describe, expect, it } from "vitest";
import { schema } from "@skout/db";
import { computeDexterPlanMetrics, computeWorkspaceEvaluationSummary } from "./dexter-evaluation-loop.service.js";

const WORKSPACE = "ws-1";
const PLAN_ID = "plan-1";

/** In-memory fake db keyed on drizzle table identity, mirroring the pattern used elsewhere in
 * this repo (e.g. workbook-run.runner.test.ts) — supports the exact select-chain shapes this
 * service issues (select([cols]).from(table).where(...) with no further chaining). */
function makeFakeDb(fixtures: {
  plan?: Record<string, unknown> | null;
  sequences?: { id: string }[];
  enrollments?: { id: string }[];
  threads?: { enrollmentId: string | null; status: string }[];
}) {
  const { plan = null, sequences: seqRows = [], enrollments = [], threads = [] } = fixtures;
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === schema.dexterPlans) {
            // computeWorkspaceEvaluationSummary has no .limit(); computeDexterPlanMetrics does.
            const result = plan ? [plan] : [];
            return Object.assign(Promise.resolve(result), { limit: () => Promise.resolve(result) });
          }
          if (table === schema.sequences) return Promise.resolve(seqRows);
          if (table === schema.sequenceEnrollments) return Promise.resolve(enrollments);
          if (table === schema.inboxThreads) return Promise.resolve(threads);
          return Promise.resolve([]);
        },
      }),
    }),
  } as never;
}

function basePlan(overrides: Record<string, unknown> = {}) {
  return {
    id: PLAN_ID,
    workspaceId: WORKSPACE,
    status: "proposed",
    approvedAt: null,
    rejectedAt: null,
    ...overrides,
  };
}

describe("computeDexterPlanMetrics", () => {
  it("returns null when the plan does not exist", async () => {
    const db = makeFakeDb({ plan: null });
    expect(await computeDexterPlanMetrics(db, WORKSPACE, "missing")).toBeNull();
  });

  it("maps a proposed plan to decision 'pending' with no rates (no linked sequence)", async () => {
    const db = makeFakeDb({ plan: basePlan({ status: "proposed" }) });
    const metrics = await computeDexterPlanMetrics(db, WORKSPACE, PLAN_ID);
    expect(metrics).toMatchObject({ decision: "pending", enrollmentCount: 0, replyRate: null, meetingRate: null });
  });

  it("maps rejected/approved/invoked/learned to the right decision", async () => {
    const rejected = await computeDexterPlanMetrics(
      makeFakeDb({ plan: basePlan({ status: "rejected", rejectedAt: new Date() }) }),
      WORKSPACE,
      PLAN_ID
    );
    expect(rejected?.decision).toBe("rejected");
    expect(rejected?.decidedAt).toBeInstanceOf(Date);

    for (const status of ["approved", "invoked", "learned"]) {
      const metrics = await computeDexterPlanMetrics(
        makeFakeDb({ plan: basePlan({ status, approvedAt: new Date() }) }),
        WORKSPACE,
        PLAN_ID
      );
      expect(metrics?.decision).toBe("accepted");
    }
  });

  it("returns null rates when a sequence is linked but has zero enrollments yet", async () => {
    const db = makeFakeDb({
      plan: basePlan({ status: "invoked" }),
      sequences: [{ id: "seq-1" }],
      enrollments: [],
    });
    const metrics = await computeDexterPlanMetrics(db, WORKSPACE, PLAN_ID);
    expect(metrics).toMatchObject({ linkedSequenceIds: ["seq-1"], enrollmentCount: 0, replyRate: null, meetingRate: null });
  });

  it("computes reply and meeting rate from the linked sequence's enrollment threads", async () => {
    const db = makeFakeDb({
      plan: basePlan({ status: "invoked" }),
      sequences: [{ id: "seq-1" }],
      enrollments: [{ id: "enr-1" }, { id: "enr-2" }, { id: "enr-3" }, { id: "enr-4" }],
      threads: [
        { enrollmentId: "enr-1", status: "replied" },
        { enrollmentId: "enr-2", status: "meeting_booked" },
        { enrollmentId: "enr-3", status: "bounced" },
        { enrollmentId: "enr-4", status: "new" },
      ],
    });
    const metrics = await computeDexterPlanMetrics(db, WORKSPACE, PLAN_ID);
    expect(metrics?.enrollmentCount).toBe(4);
    expect(metrics?.replyRate).toBe(0.5); // enr-1 (replied) + enr-2 (meeting_booked) out of 4
    expect(metrics?.meetingRate).toBe(0.25); // enr-2 only
  });

  it("does not double-count an enrollment with multiple threads", async () => {
    const db = makeFakeDb({
      plan: basePlan({ status: "invoked" }),
      sequences: [{ id: "seq-1" }],
      enrollments: [{ id: "enr-1" }],
      threads: [
        { enrollmentId: "enr-1", status: "bounced" },
        { enrollmentId: "enr-1", status: "replied" },
      ],
    });
    const metrics = await computeDexterPlanMetrics(db, WORKSPACE, PLAN_ID);
    expect(metrics?.replyRate).toBe(1);
  });
});

describe("computeWorkspaceEvaluationSummary", () => {
  it("returns a null acceptedRate when nothing has been decided yet", async () => {
    // dexterPlans select in the summary has no .limit(), so the fixture's "plan" list needs to
    // come back as an array directly — reuse makeFakeDb's dexterPlans branch by passing an array.
    const db = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              { status: "proposed" },
              { status: "proposed" },
            ]),
        }),
      }),
    } as never;

    const summary = await computeWorkspaceEvaluationSummary(db, WORKSPACE);
    expect(summary).toEqual({ acceptedCount: 0, rejectedCount: 0, pendingCount: 2, acceptedRate: null });
  });

  it("computes acceptedRate across a mix of decided and pending plans", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              { status: "approved" },
              { status: "invoked" },
              { status: "learned" },
              { status: "rejected" },
              { status: "proposed" },
            ]),
        }),
      }),
    } as never;

    const summary = await computeWorkspaceEvaluationSummary(db, WORKSPACE);
    expect(summary).toEqual({ acceptedCount: 3, rejectedCount: 1, pendingCount: 1, acceptedRate: 0.75 });
  });
});
