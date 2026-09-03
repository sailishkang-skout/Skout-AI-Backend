import { describe, expect, it, vi, beforeEach } from "vitest";

// Hoisted mocks — must appear before any imports that transitively load these modules
vi.mock("../lib/redis.js", () => ({
  isRedisAvailable: vi.fn().mockResolvedValue(true),
  redisBullMqConnection: vi.fn().mockReturnValue({ host: "localhost", port: 6379 }),
  getRedis: vi.fn().mockReturnValue(null),
  closeRedis: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@skout/db", () => ({
  createDb: vi.fn().mockReturnValue({
    db: {},
    sql: { end: vi.fn().mockResolvedValue(undefined) },
  }),
  // Every mocked `.where()`/`.leftJoin()`/`.innerJoin()` call in this file ignores its
  // argument's actual content (see e.g. makeThreadDb below) — these just need to exist as
  // callable functions so building the real scopedTo(...)/scopedById(...) call sites in
  // sequence-enrollment.worker.ts doesn't throw "not a function".
  scopedTo: (...args: unknown[]) => ({ __scopedTo: args }),
  scopedById: (...args: unknown[]) => ({ __scopedById: args }),
  schema: {
    sequenceEnrollments: "sequenceEnrollments",
    sequenceEnrollmentSteps: "sequenceEnrollmentSteps",
    sequenceSteps: "sequenceSteps",
    inboxThreads: "inboxThreads",
    inboxMessages: "inboxMessages",
    prospectActivations: { workspaceId: "workspace_id", prospectId: "prospect_id", snapshot: "snapshot" },
    aiDrafts: "aiDrafts",
    contacts: "contacts",
    tasks: { id: "id", disposition: "disposition", sequenceEnrollmentStepId: "sequence_enrollment_step_id" },
    sequenceStepVariants: "sequenceStepVariants",
    sequenceTrackingEvents: "sequenceTrackingEvents",
    linkedinOutreachJobs: "linkedinOutreachJobs",
    whatsappOutreachJobs: "whatsappOutreachJobs",
    sequenceVersions: "sequenceVersions",
    sequenceEvents: "sequenceEvents",
  },
}));

vi.mock("./sequence-enrollment.queue.js", () => ({
  SEQUENCE_ENROLLMENT_QUEUE: "skout-sequence-enrollment",
  enqueueSequenceAdvanceJob: vi.fn().mockResolvedValue(undefined),
  getSequenceEnrollmentQueue: vi.fn().mockReturnValue({
    add: vi.fn().mockResolvedValue({}),
  }),
}));

vi.mock("../utils/scheduling.js", () => ({
  isBusinessHour: vi.fn().mockReturnValue(true),
  nextBusinessHour: vi.fn().mockReturnValue(new Date("2026-01-01T09:00:00Z")),
}));

vi.mock("../services/prospect-resolver.service.js", () => ({
  resolveProspectFields: vi.fn(),
}));

vi.mock("../services/suppression.service.js", () => ({
  isSuppressed: vi.fn(),
  buildUnsubscribeUrl: vi.fn().mockReturnValue("https://api.skout.ai/api/v1/unsubscribe/tok"),
}));

vi.mock("../services/inbox-rotation.service.js", () => ({
  pickNextInbox: vi.fn(),
  markInboxUsed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/template-render.service.js", () => ({
  renderTemplate: vi.fn((template: string) => template),
}));

vi.mock("../services/tracking.service.js", () => ({
  injectTracking: vi.fn().mockReturnValue({ html: "<p>tracked</p>", text: "plain" }),
}));

vi.mock("../services/email-sender.service.js", () => ({
  buildEmailSenderFromInbox: vi.fn(),
}));

vi.mock("../services/webhook.service.js", () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
  WEBHOOK_EVENT_TYPES: ["prospect.enrolled", "sequence.step.completed", "reply.received"],
}));

vi.mock("../lib/redis.js", () => ({
  isRedisAvailable: vi.fn().mockResolvedValue(true),
  redisBullMqConnection: vi.fn().mockReturnValue({
    host: "localhost",
    port: 6379,
  }),
}));

vi.mock("../services/sequence-events.js", () => ({
  recordSequenceEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/notifications.service.js", () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  resolveNotificationsForEntity: vi.fn().mockResolvedValue(undefined),
}));

// LinkedIn send path — mocked wholesale (like the other services above) so the claimNext
// race-guard wiring in executeLinkedinStep can be exercised without a real Unipile call or a
// real LinkedinOutreachService/LinkedinAccountService touching the db beyond what advanceEnrollment
// itself queries. The mock objects are shared via vi.hoisted so both the mock factory (which must
// return the same instance from every `new LinkedinOutreachService(...)` / `new
// LinkedinAccountService(...)` call) and the test bodies (which configure/assert on them) see the
// same vi.fn() references.
const linkedinOutreachMocks = vi.hoisted(() => ({
  ensureJobForStep: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  recordOutcomeUnknown: vi.fn(),
}));

vi.mock("../services/linkedin-outreach.service.js", () => ({
  LinkedinOutreachService: vi.fn().mockImplementation(() => linkedinOutreachMocks),
}));

// WhatsApp send path — same wholesale-mock treatment as LinkedIn above, so
// executeWhatsappStep's claimNext race guard can be exercised the same way.
const whatsappOutreachMocks = vi.hoisted(() => ({
  ensureJobForStep: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  recordOutcomeUnknown: vi.fn(),
}));

vi.mock("../services/whatsapp-outreach.service.js", () => ({
  WhatsappOutreachService: vi.fn().mockImplementation(() => whatsappOutreachMocks),
}));

const linkedinAccountMocks = vi.hoisted(() => ({
  isConfiguredForWorkspace: vi.fn(),
  pickNextAccount: vi.fn(),
  markUsed: vi.fn(),
  markError: vi.fn(),
}));

vi.mock("../services/linkedin-account.service.js", () => ({
  LinkedinAccountService: vi.fn().mockImplementation(() => linkedinAccountMocks),
  sendLinkedinOutreach: vi.fn(),
  sendWhatsappOutreach: vi.fn(),
}));

vi.mock("@skout/shared", () => ({
  claimNext: vi.fn(),
  reclaimExpiredLeases: vi.fn().mockResolvedValue({ requeuedIds: [], failedIds: [] }),
  recordResult: vi.fn(),
  // Real implementation runs `work()` under a renewal interval — for these unit tests the
  // interval itself is irrelevant, only that the wrapped work still actually executes and its
  // result/rejection still propagates to the caller.
  withLeaseHeartbeat: vi.fn((_db: unknown, _table: unknown, _id: unknown, _workerId: unknown, _ms: unknown, work: () => unknown) => work()),
  LeaseLostError: class LeaseLostError extends Error {},
}));

import {
  startSequenceEnrollmentWorker,
  retryTransientFailure,
  countTrackingEvents,
  hasMeetingBookedThread,
} from "./sequence-enrollment.worker.js";
import { recordSequenceEvent } from "../services/sequence-events.js";
import { enqueueSequenceAdvanceJob } from "./sequence-enrollment.queue.js";
import { Worker } from "bullmq";
import { createDb } from "@skout/db";
import { isBusinessHour } from "../utils/scheduling.js";
import { resolveProspectFields } from "../services/prospect-resolver.service.js";
import { isSuppressed } from "../services/suppression.service.js";
import { pickNextInbox, markInboxUsed } from "../services/inbox-rotation.service.js";
import { buildEmailSenderFromInbox } from "../services/email-sender.service.js";
import { renderTemplate } from "../services/template-render.service.js";
import { sendLinkedinOutreach, sendWhatsappOutreach } from "../services/linkedin-account.service.js";
import { UnipileError } from "../services/unipile.client.js";
import { claimNext, reclaimExpiredLeases, recordResult, withLeaseHeartbeat } from "@skout/shared";
import { resolveNotificationsForEntity } from "../services/notifications.service.js";
import { isRedisAvailable } from "../lib/redis.js";

const BASE_CONFIG = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
} as any;

describe("startSequenceEnrollmentWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Worker).mockImplementation((() => ({
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    })) as any);
    vi.mocked(createDb).mockReturnValue({
      db: {} as any,
      sql: { end: vi.fn().mockResolvedValue(undefined) } as any,
    });
  });

  it("returns a noop shutdown when DATABASE_URL is falsy", async () => {
    const stop = await startSequenceEnrollmentWorker({ ...BASE_CONFIG, DATABASE_URL: undefined } as any);
    await expect(stop()).resolves.toBeUndefined();
    expect(Worker).not.toHaveBeenCalled();
    expect(createDb).not.toHaveBeenCalled();
  });

  it("returns a noop shutdown when Redis is unavailable", async () => {
    vi.mocked(isRedisAvailable).mockResolvedValueOnce(false);
    const stop = await startSequenceEnrollmentWorker(BASE_CONFIG);
    await expect(stop()).resolves.toBeUndefined();
    expect(Worker).not.toHaveBeenCalled();
    expect(createDb).not.toHaveBeenCalled();
  });

  it("creates a Worker with the correct queue name", async () => {
    await startSequenceEnrollmentWorker(BASE_CONFIG);
    expect(Worker).toHaveBeenCalledWith(
      "skout-sequence-enrollment",
      expect.any(Function),
      expect.any(Object)
    );
  });

  it("creates a Worker with concurrency 5", async () => {
    await startSequenceEnrollmentWorker(BASE_CONFIG);
    expect(Worker).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ concurrency: 5 })
    );
  });

  it("calls createDb with DATABASE_URL", async () => {
    await startSequenceEnrollmentWorker(BASE_CONFIG);
    expect(createDb).toHaveBeenCalledWith(BASE_CONFIG.DATABASE_URL);
  });

  it("shutdown function closes the worker", async () => {
    const mockClose = vi.fn().mockResolvedValue(undefined);
    vi.mocked(Worker).mockImplementationOnce((() => ({
      on: vi.fn(),
      close: mockClose,
    })) as any);

    const stop = await startSequenceEnrollmentWorker(BASE_CONFIG);
    await stop();

    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("shutdown function ends the DB connection", async () => {
    const mockEnd = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createDb).mockReturnValueOnce({
      db: {} as any,
      sql: { end: mockEnd } as any,
    });

    const stop = await startSequenceEnrollmentWorker(BASE_CONFIG);
    await stop();

    expect(mockEnd).toHaveBeenCalledOnce();
  });

  it("registers a 'failed' event listener on the worker", async () => {
    const mockOn = vi.fn();
    vi.mocked(Worker).mockImplementationOnce((() => ({
      on: mockOn,
      close: vi.fn().mockResolvedValue(undefined),
    })) as any);

    await startSequenceEnrollmentWorker(BASE_CONFIG);

    expect(mockOn).toHaveBeenCalledWith("failed", expect.any(Function));
  });
});

describe("startSequenceEnrollmentWorker — reclaim sweep", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts a reclaim sweep interval, re-enqueues advances for requeued jobs, and stops on shutdown", async () => {
    vi.mocked(reclaimExpiredLeases).mockResolvedValue({ requeuedIds: ["job-1"], failedIds: [] });

    // linkedin_outreach_jobs.enrollmentId doesn't carry sequenceId directly — the sweep looks
    // up the affected jobs' distinct (enrollmentId, workspaceId, prospectId) first, then joins
    // out to sequenceEnrollments per enrollment to find sequenceId.
    const affectedJobs = [{ enrollmentId: "enr-1", workspaceId: "ws-1", prospectId: "prospect-1" }];
    const selectDistinctWhere = vi.fn().mockResolvedValue(affectedJobs);
    const selectDistinctFrom = vi.fn().mockReturnValue({ where: selectDistinctWhere });
    const selectDistinct = vi.fn().mockReturnValue({ from: selectDistinctFrom });

    const selectLimit = vi.fn().mockResolvedValue([{ sequenceId: "seq-1" }]);
    const selectWhere = vi.fn().mockReturnValue({ limit: selectLimit });
    const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
    const select = vi.fn().mockReturnValue({ from: selectFrom });

    vi.mocked(createDb).mockReturnValueOnce({
      db: { selectDistinct, select } as any,
      sql: { end: vi.fn().mockResolvedValue(undefined) } as any,
    });

    vi.useFakeTimers();
    try {
      const stop = await startSequenceEnrollmentWorker({ DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" } as never);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(reclaimExpiredLeases).toHaveBeenCalled();
      expect(enqueueSequenceAdvanceJob).toHaveBeenCalledWith(
        expect.anything(),
        { enrollmentId: "enr-1", workspaceId: "ws-1", prospectId: "prospect-1", sequenceId: "seq-1" },
        0,
        false
      );
      await stop();
      const callsBeforeStop = vi.mocked(reclaimExpiredLeases).mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.mocked(reclaimExpiredLeases).mock.calls.length).toBe(callsBeforeStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not query selectDistinct (the requeued-jobs lookup) when nothing was requeued", async () => {
    vi.mocked(reclaimExpiredLeases).mockResolvedValue({ requeuedIds: [], failedIds: [] });
    const selectDistinct = vi.fn();
    vi.mocked(createDb).mockReturnValueOnce({
      db: { selectDistinct } as any,
      sql: { end: vi.fn().mockResolvedValue(undefined) } as any,
    });

    vi.useFakeTimers();
    try {
      const stop = await startSequenceEnrollmentWorker({ DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" } as never);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(reclaimExpiredLeases).toHaveBeenCalled();
      expect(selectDistinct).not.toHaveBeenCalled();
      expect(enqueueSequenceAdvanceJob).not.toHaveBeenCalled();
      await stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the enrollment step failed and re-enqueues an advance when a job hits MAX_ATTEMPTS during reclaim (failedIds)", async () => {
    // reclaimExpiredLeases is shared by both the LinkedIn and WhatsApp sweep timers (both fire on
    // the same 30s interval) — key the mock on the table argument so the WhatsApp sweep (which
    // runs in the same tick) resolves empty and doesn't consume this test's LinkedIn-scoped
    // db.select() mock queue.
    vi.mocked(reclaimExpiredLeases).mockImplementation((_db: unknown, table: unknown) => {
      if (table === "linkedinOutreachJobs") {
        return Promise.resolve({ requeuedIds: [], failedIds: ["job-2"] });
      }
      return Promise.resolve({ requeuedIds: [], failedIds: [] });
    });

    // Sweep looks up the stranded jobs' (enrollmentId, enrollmentStepId, workspaceId,
    // prospectId) directly (no selectDistinct — one row per failed job id), marks the step
    // failed, resolves any open notification for it, then joins out to sequenceEnrollments
    // for sequenceId the same way the requeuedIds branch does.
    const strandedJobs = [
      { enrollmentId: "enr-1", enrollmentStepId: "estep-1", workspaceId: "ws-1", prospectId: "prospect-1" },
    ];
    const jobsSelectWhere = vi.fn().mockResolvedValue(strandedJobs);
    const jobsSelectFrom = vi.fn().mockReturnValue({ where: jobsSelectWhere });

    const enrollmentSelectLimit = vi.fn().mockResolvedValue([{ sequenceId: "seq-1" }]);
    const enrollmentSelectWhere = vi.fn().mockReturnValue({ limit: enrollmentSelectLimit });
    const enrollmentSelectFrom = vi.fn().mockReturnValue({ where: enrollmentSelectWhere });

    // First select() call in the failedIds branch is the stranded-jobs lookup (no .limit()
    // chained), the second is the per-enrollment sequenceId lookup (.limit(1) chained).
    const select = vi.fn();
    select.mockReturnValueOnce({ from: jobsSelectFrom });
    select.mockReturnValueOnce({ from: enrollmentSelectFrom });

    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const update = vi.fn().mockReturnValue({ set: updateSet });

    vi.mocked(createDb).mockReturnValueOnce({
      db: { select, update } as any,
      sql: { end: vi.fn().mockResolvedValue(undefined) } as any,
    });

    vi.useFakeTimers();
    try {
      const stop = await startSequenceEnrollmentWorker({ DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" } as never);
      await vi.advanceTimersByTimeAsync(31_000);

      expect(update).toHaveBeenCalledWith("sequenceEnrollmentSteps");
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed", failureReason: "lease_reclaim_exhausted" })
      );
      expect(resolveNotificationsForEntity).toHaveBeenCalledWith(
        expect.anything(),
        "sequence_enrollment_step",
        "estep-1"
      );
      expect(enqueueSequenceAdvanceJob).toHaveBeenCalledWith(
        expect.anything(),
        { enrollmentId: "enr-1", workspaceId: "ws-1", prospectId: "prospect-1", sequenceId: "seq-1" },
        0,
        false
      );
      await stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("startSequenceEnrollmentWorker — WhatsApp reclaim sweep", () => {
  beforeEach(() => vi.clearAllMocks());

  it("re-enqueues an advance for requeued WhatsApp jobs, and marks failed jobs' steps failed with an advance too", async () => {
    // reclaimExpiredLeases is shared by both the LinkedIn and WhatsApp sweep timers (both fire on
    // the same 30s interval) — distinguish by the table argument so the LinkedIn sweep (which
    // runs in the same tick) resolves empty and does nothing, while the WhatsApp sweep gets the
    // requeued+failed result under test.
    vi.mocked(reclaimExpiredLeases).mockImplementation((_db: unknown, table: unknown) => {
      if (table === "whatsappOutreachJobs") {
        return Promise.resolve({ requeuedIds: ["wjob-1"], failedIds: ["wjob-2"] });
      }
      return Promise.resolve({ requeuedIds: [], failedIds: [] });
    });

    // requeuedIds branch: selectDistinct the affected (enrollmentId, workspaceId, prospectId),
    // then look up sequenceId per enrollment.
    const requeuedJobs = [{ enrollmentId: "enr-2", workspaceId: "ws-2", prospectId: "prospect-2" }];
    const selectDistinctWhere = vi.fn().mockResolvedValue(requeuedJobs);
    const selectDistinctFrom = vi.fn().mockReturnValue({ where: selectDistinctWhere });
    const selectDistinct = vi.fn().mockReturnValue({ from: selectDistinctFrom });

    // 1st db.select(): enrollment sequenceId lookup for the requeued job (select/from/where/limit).
    const requeuedEnrollmentLimit = vi.fn().mockResolvedValue([{ sequenceId: "seq-2" }]);
    const requeuedEnrollmentWhere = vi.fn().mockReturnValue({ limit: requeuedEnrollmentLimit });
    const requeuedEnrollmentFrom = vi.fn().mockReturnValue({ where: requeuedEnrollmentWhere });

    // 2nd db.select(): the stranded (failed) jobs lookup — select/from/where resolves directly,
    // no .limit() chained (mirrors the LinkedIn failedIds test's shape).
    const failedJobs = [
      { enrollmentStepId: "westep-1", enrollmentId: "enr-3", workspaceId: "ws-3", prospectId: "prospect-3" },
    ];
    const failedJobsWhere = vi.fn().mockResolvedValue(failedJobs);
    const failedJobsFrom = vi.fn().mockReturnValue({ where: failedJobsWhere });

    // 3rd db.select(): enrollment sequenceId lookup for the failed job.
    const failedEnrollmentLimit = vi.fn().mockResolvedValue([{ sequenceId: "seq-3" }]);
    const failedEnrollmentWhere = vi.fn().mockReturnValue({ limit: failedEnrollmentLimit });
    const failedEnrollmentFrom = vi.fn().mockReturnValue({ where: failedEnrollmentWhere });

    const select = vi.fn();
    select.mockReturnValueOnce({ from: requeuedEnrollmentFrom });
    select.mockReturnValueOnce({ from: failedJobsFrom });
    select.mockReturnValueOnce({ from: failedEnrollmentFrom });

    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const update = vi.fn().mockReturnValue({ set: updateSet });

    vi.mocked(createDb).mockReturnValueOnce({
      db: { selectDistinct, select, update } as any,
      sql: { end: vi.fn().mockResolvedValue(undefined) } as any,
    });

    vi.useFakeTimers();
    try {
      const stop = await startSequenceEnrollmentWorker({ DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" } as never);
      await vi.advanceTimersByTimeAsync(31_000);

      expect(reclaimExpiredLeases).toHaveBeenCalledWith(expect.anything(), "whatsappOutreachJobs");

      // requeuedIds branch — re-enqueues an advance, no step mutation.
      expect(enqueueSequenceAdvanceJob).toHaveBeenCalledWith(
        expect.anything(),
        { enrollmentId: "enr-2", workspaceId: "ws-2", prospectId: "prospect-2", sequenceId: "seq-2" },
        0,
        false
      );

      // failedIds branch — marks the sequenceEnrollmentSteps row failed, resolves its
      // notifications, and ALSO re-enqueues an advance so the enrollment isn't stranded.
      expect(update).toHaveBeenCalledWith("sequenceEnrollmentSteps");
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed", failureReason: "lease_reclaim_exhausted" })
      );
      expect(resolveNotificationsForEntity).toHaveBeenCalledWith(
        expect.anything(),
        "sequence_enrollment_step",
        "westep-1"
      );
      expect(enqueueSequenceAdvanceJob).toHaveBeenCalledWith(
        expect.anything(),
        { enrollmentId: "enr-3", workspaceId: "ws-3", prospectId: "prospect-3", sequenceId: "seq-3" },
        0,
        false
      );

      // Disposer clears the WhatsApp sweep timer alongside the LinkedIn one — no leak.
      await stop();
      const callsBeforeStop = vi.mocked(reclaimExpiredLeases).mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.mocked(reclaimExpiredLeases).mock.calls.length).toBe(callsBeforeStop);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// executeEmailStep dispatch — invoked indirectly via the captured BullMQ
// processor function, since advanceEnrollment/executeEmailStep aren't exported.
// ---------------------------------------------------------------------------

function selectChain(result: unknown[]) {
  const c = {} as Record<string, ReturnType<typeof vi.fn>>;
  c.from = vi.fn().mockReturnValue(c);
  c.innerJoin = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockReturnValue(c);
  c.limit = vi.fn().mockResolvedValue(result);
  return c;
}

const PAST_DATE = new Date("2020-01-01T00:00:00Z");
const ENROLLMENT_ROW = { id: "enr-1", workspaceId: "ws-1", status: "active", enrolledAt: PAST_DATE };
const EMAIL_STEP_ROW = {
  enrollmentStepId: "estep-1",
  stepId: "step-1",
  scheduledAt: PAST_DATE,
  stepOrder: 1,
  stepType: "email",
  subject: "Hi {{firstName}}",
  bodyTemplate: "Hello {{firstName}}, visit https://example.com {{unsubscribeUrl}}",
};

function makeWorkerDb(opts: {
  pendingStep?: unknown;
  txInsertThread?: { id: string };
  approvedDraft?: { id: string; subject: string; body: string };
}) {
  const select = vi.fn();
  select.mockReturnValueOnce(selectChain([ENROLLMENT_ROW])); // load enrollment
  select.mockReturnValueOnce(selectChain([])); // bounced check
  select.mockReturnValueOnce(selectChain([])); // reply check
  select.mockReturnValueOnce(selectChain([])); // awaiting call disposition (none)
  select.mockReturnValueOnce(selectChain(opts.pendingStep ? [opts.pendingStep] : [])); // pending step
  select.mockReturnValueOnce(selectChain([])); // A/B/C variants (none → use step template)
  // approved-draft lookup (executeEmailStep) — only reached once the step actually sends
  select.mockReturnValueOnce(selectChain(opts.approvedDraft ? [opts.approvedDraft] : []));
  // pending-draft HITL check (skipped when approved draft exists, but mock still reserved)
  if (!opts.approvedDraft) {
    select.mockReturnValueOnce(selectChain([]));
  }
  select.mockReturnValueOnce(selectChain([])); // next pending step (none → completed)

  const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  const txInsertValues = vi.fn();
  const txUpdateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  const tx = {
    insert: vi.fn().mockImplementation(() => ({
      values: txInsertValues.mockReturnValueOnce({
        returning: vi.fn().mockResolvedValue([opts.txInsertThread ?? { id: "thread-1" }]),
      }),
    })),
    update: vi.fn().mockReturnValue({ set: txUpdateSet }),
  };
  const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx));

  return { select, update, transaction, updateSet, tx };
}

async function getProcessor(db: unknown): Promise<(job: { data: unknown; attemptsMade: number }) => Promise<void>> {
  vi.mocked(createDb).mockReturnValueOnce({
    db: db as any,
    sql: { end: vi.fn().mockResolvedValue(undefined) } as any,
  });
  await startSequenceEnrollmentWorker(BASE_CONFIG);
  const call = vi.mocked(Worker).mock.calls[0]!;
  return call[1] as (job: { data: unknown; attemptsMade: number }) => Promise<void>;
}

const JOB_PAYLOAD = { enrollmentId: "enr-1", workspaceId: "ws-1", prospectId: "p-1", sequenceId: "seq-1" };

describe("sequence-enrollment worker — email step execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Worker).mockImplementation((() => ({
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    })) as any);
    vi.mocked(isBusinessHour).mockReturnValue(true);
  });

  it("sends the email through the rotated inbox and marks the step executed", async () => {
    vi.mocked(resolveProspectFields).mockResolvedValue({
      prospectId: "p-1",
      email: "prospect@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    });
    vi.mocked(isSuppressed).mockResolvedValue(false);
    vi.mocked(pickNextInbox).mockResolvedValue({
      id: "inbox-1",
      emailAddress: "sender@example.com",
      displayName: "Sender",
    } as any);
    const send = vi.fn().mockResolvedValue({ externalId: "msg-1" });
    vi.mocked(buildEmailSenderFromInbox).mockResolvedValue({ send });

    const { select, update, transaction, tx } = makeWorkerDb({ pendingStep: EMAIL_STEP_ROW });
    const db = { select, update, transaction };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "prospect@example.com", from: "sender@example.com" })
    );
    expect(markInboxUsed).toHaveBeenCalledWith(db, "inbox-1");
    expect(tx.update).toHaveBeenCalledWith("sequenceEnrollmentSteps");
    // A genuine send reports "action_sent" — this is the only step-execution path allowed to.
    expect(recordSequenceEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "action_sent" })
    );
  });

  it("sends an APPROVED ai draft's content instead of the step template and consumes it", async () => {
    vi.mocked(resolveProspectFields).mockResolvedValue({
      prospectId: "p-1",
      email: "prospect@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    });
    vi.mocked(isSuppressed).mockResolvedValue(false);
    vi.mocked(pickNextInbox).mockResolvedValue({
      id: "inbox-1",
      emailAddress: "sender@example.com",
      displayName: "Sender",
    } as any);
    const send = vi.fn().mockResolvedValue({ externalId: "msg-1" });
    vi.mocked(buildEmailSenderFromInbox).mockResolvedValue({ send });

    const { select, update, transaction, tx } = makeWorkerDb({
      pendingStep: EMAIL_STEP_ROW,
      approvedDraft: { id: "draft-1", subject: "Approved subject", body: "Approved body" },
    });
    const db = { select, update, transaction };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    // renderTemplate is mocked to echo its input — the draft subject must win over the template.
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ subject: "Approved subject" }));
    // The draft is linked/consumed inside the send transaction.
    expect(tx.update).toHaveBeenCalledWith("aiDrafts");
  });

  it("marks the step failed (no retry) when the prospect has no resolvable email", async () => {
    vi.mocked(resolveProspectFields).mockResolvedValue({
      prospectId: "p-1",
      email: undefined,
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    });

    const { select, update, updateSet } = makeWorkerDb({ pendingStep: EMAIL_STEP_ROW });
    const db = { select, update, transaction: vi.fn() };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(isSuppressed).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith("sequenceEnrollmentSteps");
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", failureReason: "prospect_email_not_found" })
    );
    // Regression guard for the bug in TAM_Sequence_Testing_Report.docx: a step that never sent
    // anything must never log "action_sent" — Activity showed "Step sent" for this exact case
    // while Analytics correctly showed it as failed and Gmail showed nothing sent.
    expect(recordSequenceEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "action_sent" })
    );
    expect(recordSequenceEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "action_failed", reason: "prospect_email_not_found" })
    );
  });

  it("marks the step skipped (no retry) when the prospect email is suppressed", async () => {
    vi.mocked(resolveProspectFields).mockResolvedValue({
      prospectId: "p-1",
      email: "suppressed@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    });
    vi.mocked(isSuppressed).mockResolvedValue(true);

    const { select, update, updateSet } = makeWorkerDb({ pendingStep: EMAIL_STEP_ROW });
    const db = { select, update, transaction: vi.fn() };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(pickNextInbox).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped", failureReason: "suppressed" })
    );
  });

  it("marks the step skipped (no retry) when another contact at the account already replied positively", async () => {
    // Golden rule regression test (condition-engine spec §48.1): this must trip even though no
    // "account_has_positive_reply" condition step was authored into this sequence — it's a
    // universal gate now, not opt-in.
    vi.mocked(resolveProspectFields).mockResolvedValue({
      prospectId: "p-1",
      email: "prospect@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
      companyDomain: "acme.com",
    });
    vi.mocked(isSuppressed).mockResolvedValue(false);

    const select = vi.fn();
    select.mockReturnValueOnce(selectChain([ENROLLMENT_ROW])); // load enrollment
    select.mockReturnValueOnce(selectChain([])); // bounced check
    select.mockReturnValueOnce(selectChain([])); // reply check
    select.mockReturnValueOnce(selectChain([])); // awaiting call disposition (none)
    select.mockReturnValueOnce(selectChain([EMAIL_STEP_ROW])); // pending step
    select.mockReturnValueOnce(selectChain([])); // A/B/C variants (none)
    select.mockReturnValueOnce(selectChain([{ id: "thread-other-contact" }])); // hasPositiveReplyAtAccount: found
    select.mockReturnValueOnce(selectChain([])); // next pending step (none → completed)
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const update = vi.fn().mockReturnValue({ set: updateSet });
    const db = { select, update, transaction: vi.fn() };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(pickNextInbox).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped", failureReason: "account_already_engaged" })
    );
  });

  it("marks the step failed (no retry) when no active inbox is available", async () => {
    vi.mocked(resolveProspectFields).mockResolvedValue({
      prospectId: "p-1",
      email: "prospect@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    });
    vi.mocked(isSuppressed).mockResolvedValue(false);
    vi.mocked(pickNextInbox).mockResolvedValue(null);

    const { select, update, updateSet } = makeWorkerDb({ pendingStep: EMAIL_STEP_ROW });
    const db = { select, update, transaction: vi.fn() };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(buildEmailSenderFromInbox).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", failureReason: "no_active_inbox" })
    );
    expect(recordSequenceEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "action_sent" })
    );
    expect(recordSequenceEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "action_failed", reason: "no_active_inbox" })
    );
  });

  it("marks the step failed (no retry) when buildEmailSenderFromInbox throws missing-credentials", async () => {
    vi.mocked(resolveProspectFields).mockResolvedValue({
      prospectId: "p-1",
      email: "prospect@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    });
    vi.mocked(isSuppressed).mockResolvedValue(false);
    vi.mocked(pickNextInbox).mockResolvedValue({
      id: "inbox-1",
      emailAddress: "sender@example.com",
      displayName: "Sender",
    } as any);
    vi.mocked(buildEmailSenderFromInbox).mockRejectedValueOnce(
      new Error("inbox_missing_smtp_credentials")
    );

    const { select, update, updateSet } = makeWorkerDb({ pendingStep: EMAIL_STEP_ROW });
    const db = { select, update, transaction: vi.fn() };

    const processor = await getProcessor(db);
    // Must NOT re-throw — the step is terminal, not retryable
    await expect(processor({ data: JOB_PAYLOAD, attemptsMade: 1 })).resolves.toBeUndefined();

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", failureReason: "inbox_missing_smtp_credentials" })
    );
    // Transaction (email send + thread/message insert) must NOT be called
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("throws when the inbox thread insert returns no row, so BullMQ retries", async () => {
    vi.mocked(resolveProspectFields).mockResolvedValue({
      prospectId: "p-1",
      email: "prospect@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    });
    vi.mocked(isSuppressed).mockResolvedValue(false);
    vi.mocked(pickNextInbox).mockResolvedValue({
      id: "inbox-1",
      emailAddress: "sender@example.com",
      displayName: "Sender",
    } as any);
    const send = vi.fn().mockResolvedValue({ externalId: "msg-1" });
    vi.mocked(buildEmailSenderFromInbox).mockResolvedValue({ send });

    // Override the thread insert to return an empty array (simulates DB returning no row)
    const { select, update } = makeWorkerDb({ pendingStep: EMAIL_STEP_ROW, txInsertThread: undefined });
    const tx = {
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]), // no row returned
        }),
      })),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn() }) }),
    };
    const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx));
    const db = { select, update, transaction };

    const processor = await getProcessor(db);
    await expect(processor({ data: JOB_PAYLOAD, attemptsMade: 1 })).rejects.toThrow(
      "inboxThreads insert returned no row"
    );
  });

  it("propagates a transport send failure so BullMQ retries the job", async () => {
    vi.mocked(resolveProspectFields).mockResolvedValue({
      prospectId: "p-1",
      email: "prospect@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    });
    vi.mocked(isSuppressed).mockResolvedValue(false);
    vi.mocked(pickNextInbox).mockResolvedValue({
      id: "inbox-1",
      emailAddress: "sender@example.com",
      displayName: "Sender",
    } as any);
    const send = vi.fn().mockRejectedValue(new Error("smtp_connection_failed"));
    vi.mocked(buildEmailSenderFromInbox).mockResolvedValue({ send });

    const { select, transaction } = makeWorkerDb({ pendingStep: EMAIL_STEP_ROW });
    const db = { select, update: vi.fn(), transaction };

    const processor = await getProcessor(db);
    await expect(processor({ data: JOB_PAYLOAD, attemptsMade: 1 })).rejects.toThrow("smtp_connection_failed");

    expect(transaction).not.toHaveBeenCalled();
    expect(markInboxUsed).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// advanceEnrollment's "!pending" terminal branch (final-review Finding 1 regression test).
// This is the branch a re-enqueued advance hits after a WhatsApp/LinkedIn step's own async
// completeJob() re-enqueue finds no more "scheduled" steps — as opposed to the "!nextPending"
// branch, which handles email/task/condition steps completing inline in the same tick. Both
// branches must set the same stopReason/event, or a sequence whose LAST step is WhatsApp/
// LinkedIn completes with stopReason NULL and no sequence_completed event.
// ---------------------------------------------------------------------------

describe("sequence-enrollment worker — advanceEnrollment terminal completion (no pending step at all)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Worker).mockImplementation((() => ({
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    })) as any);
    vi.mocked(isBusinessHour).mockReturnValue(true);
  });

  it("sets stopReason SEQUENCE_COMPLETED and records sequence_completed when no step is scheduled — the path a WhatsApp/LinkedIn step's re-enqueued advance takes", async () => {
    // No pendingStep passed → the "pending step" select resolves empty, hitting the !pending
    // branch immediately (mirrors the re-enqueued advance BullMQ job that runs after
    // WhatsappOutreachService/LinkedinOutreachService's completeJob() re-enqueues one).
    const { select, update, updateSet } = makeWorkerDb({});
    const db = { select, update, transaction: vi.fn() };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(update).toHaveBeenCalledWith("sequenceEnrollments");
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", stopReason: "SEQUENCE_COMPLETED" })
    );
    expect(recordSequenceEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        enrollmentId: "enr-1",
        workspaceId: "ws-1",
        prospectId: "p-1",
        eventType: "sequence_completed",
        reason: "SEQUENCE_COMPLETED",
      })
    );
  });
});

// ---------------------------------------------------------------------------
// executeLinkedinStep's claimNext race guard — invoked indirectly via the captured
// BullMQ processor function, since executeLinkedinStep/advanceEnrollment aren't
// exported. This covers the actual bug fix: a send must only be attempted when this
// run wins the claim on the linkedinOutreachJobs row via claimNext — if another
// concurrent advance-job run already claimed it, this run must not send at all.
// ---------------------------------------------------------------------------

const LINKEDIN_STEP_ROW = {
  enrollmentStepId: "estep-li-1",
  stepId: "step-li-1",
  scheduledAt: PAST_DATE,
  stepOrder: 1,
  stepType: "linkedin",
  linkedinAction: "connect",
  subject: null,
  bodyTemplate: null,
};

function makeLinkedinWorkerDb(stepOverrides: Record<string, unknown> = {}) {
  const select = vi.fn();
  select.mockReturnValueOnce(selectChain([ENROLLMENT_ROW])); // load enrollment
  select.mockReturnValueOnce(selectChain([])); // bounced check
  select.mockReturnValueOnce(selectChain([])); // reply check
  select.mockReturnValueOnce(selectChain([])); // awaiting call disposition (none)
  select.mockReturnValueOnce(selectChain([{ ...LINKEDIN_STEP_ROW, ...stepOverrides }])); // pending step
  select.mockReturnValueOnce(selectChain([])); // A/B/C variants (none)

  const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  const update = vi.fn().mockReturnValue({ set: updateSet });
  return { select, update, updateSet };
}

describe("sequence-enrollment worker — LinkedIn step claimNext race guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Worker).mockImplementation((() => ({
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    })) as any);
    vi.mocked(isBusinessHour).mockReturnValue(true);

    vi.mocked(resolveProspectFields).mockResolvedValue({
      prospectId: "p-1",
      email: "prospect@example.com",
      linkedinUrl: "https://linkedin.com/in/prospect",
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    } as any);
    vi.mocked(isSuppressed).mockResolvedValue(false);
    linkedinAccountMocks.isConfiguredForWorkspace.mockResolvedValue(true);
    linkedinAccountMocks.pickNextAccount.mockResolvedValue({ id: "acct-1", displayName: "Sender" });
    linkedinOutreachMocks.ensureJobForStep.mockResolvedValue({
      id: "job-1",
      status: "pending",
      failureReason: null,
    });
    vi.mocked(sendLinkedinOutreach).mockResolvedValue({ externalId: "ext-1" });
  });

  it("does not send when claimNext fails to win the claim (another run already claimed the job)", async () => {
    vi.mocked(claimNext).mockResolvedValueOnce(undefined);

    const { select, update } = makeLinkedinWorkerDb();
    const db = { select, update, transaction: vi.fn() };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(claimNext).toHaveBeenCalledTimes(1);
    expect(sendLinkedinOutreach).not.toHaveBeenCalled();
    expect(linkedinOutreachMocks.completeJob).not.toHaveBeenCalled();
    expect(linkedinAccountMocks.markUsed).not.toHaveBeenCalled();
  });

  it("sends via Unipile when claimNext wins the claim on the job row", async () => {
    vi.mocked(claimNext).mockResolvedValueOnce({ id: "job-1", status: "claimed" } as any);

    const { select, update } = makeLinkedinWorkerDb();
    const db = { select, update, transaction: vi.fn() };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(claimNext).toHaveBeenCalledTimes(1);
    expect(sendLinkedinOutreach).toHaveBeenCalledWith(
      BASE_CONFIG,
      expect.objectContaining({ id: "acct-1" }),
      expect.objectContaining({ action: "connect", linkedinUrl: "https://linkedin.com/in/prospect" }),
      "ws-1",
      db
    );
    expect(linkedinAccountMocks.markUsed).toHaveBeenCalledWith("acct-1");
    expect(linkedinOutreachMocks.completeJob).toHaveBeenCalledWith("ws-1", "job-1");
  });
});

// ---------------------------------------------------------------------------
// executeLinkedinStep's lease heartbeat (Finding 1) and transient-retry lease release
// (Finding 2) — final whole-branch review of the execution-intent LinkedIn outreach adoption.
// ---------------------------------------------------------------------------

describe("sequence-enrollment worker — LinkedIn step lease heartbeat + transient-retry lease release", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Worker).mockImplementation((() => ({
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    })) as any);
    vi.mocked(isBusinessHour).mockReturnValue(true);

    vi.mocked(resolveProspectFields).mockResolvedValue({
      prospectId: "p-1",
      email: "prospect@example.com",
      linkedinUrl: "https://linkedin.com/in/prospect",
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    } as any);
    vi.mocked(isSuppressed).mockResolvedValue(false);
    linkedinAccountMocks.isConfiguredForWorkspace.mockResolvedValue(true);
    linkedinAccountMocks.pickNextAccount.mockResolvedValue({ id: "acct-1", displayName: "Sender" });
    linkedinOutreachMocks.ensureJobForStep.mockResolvedValue({
      id: "job-1",
      status: "pending",
      failureReason: null,
    });
    vi.mocked(claimNext).mockResolvedValue({ id: "job-1", status: "claimed" } as any);
  });

  it("wraps only the Unipile send in withLeaseHeartbeat — markUsed/completeJob run after, not inside it", async () => {
    vi.mocked(sendLinkedinOutreach).mockResolvedValue({ externalId: "ext-1" });

    const { select, update } = makeLinkedinWorkerDb();
    const db = { select, update, transaction: vi.fn() };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(withLeaseHeartbeat).toHaveBeenCalledWith(
      db,
      "linkedinOutreachJobs",
      "job-1",
      expect.any(String),
      60_000,
      expect.any(Function)
    );
    expect(sendLinkedinOutreach).toHaveBeenCalledTimes(1);
    // markUsed/completeJob must have actually run — proves the heartbeat wrapper's mock still
    // let the wrapped work's result flow back out to the rest of the try block.
    expect(linkedinAccountMocks.markUsed).toHaveBeenCalledWith("acct-1");
    expect(linkedinOutreachMocks.completeJob).toHaveBeenCalledWith("ws-1", "job-1");
  });

  it("releases the job's lease back to pending on a transient 429/5xx failure that will retry — does not fail the job", async () => {
    vi.mocked(sendLinkedinOutreach).mockRejectedValue(new UnipileError("rate limited", 429));
    vi.mocked(recordResult).mockResolvedValue({ id: "job-1", status: "pending" } as never);

    const { select, update } = makeLinkedinWorkerDb(); // default LINKEDIN_STEP_ROW: no attemptCount → nextAttempt 1 ≤ default maxAttempts 3 → "retry"
    const db = { select, update, transaction: vi.fn() };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(recordResult).toHaveBeenCalledWith(db, "linkedinOutreachJobs", "job-1", expect.any(String), {
      status: "pending",
    });
    expect(linkedinOutreachMocks.failJob).not.toHaveBeenCalled();
  });

  it("does not separately release the lease when retries are exhausted — failJob's own recordResult(status: failed) already releases it", async () => {
    vi.mocked(sendLinkedinOutreach).mockRejectedValue(new UnipileError("rate limited", 429));

    // Force retryTransientFailure's "exhausted" branch: attemptCount already at the step's own cap.
    const { select, update } = makeLinkedinWorkerDb({ retryMaxAttempts: 1, attemptCount: 1 });
    const db = { select, update, transaction: vi.fn() };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(linkedinOutreachMocks.failJob).toHaveBeenCalledWith("ws-1", "job-1", expect.stringContaining("retry_exhausted"));
    expect(recordResult).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// executeWhatsappStep's claimNext race guard, lease heartbeat (Finding 1), and
// transient-retry lease release (Finding 2) — same shape as executeLinkedinStep's
// equivalent tests above, adapted for WhatsappOutreachService/sendWhatsappOutreach.
// ---------------------------------------------------------------------------

const WHATSAPP_STEP_ROW = {
  enrollmentStepId: "estep-wa-1",
  stepId: "step-wa-1",
  scheduledAt: PAST_DATE,
  stepOrder: 1,
  stepType: "whatsapp",
  subject: null,
  bodyTemplate: null,
};

function makeWhatsappWorkerDb(stepOverrides: Record<string, unknown> = {}) {
  const select = vi.fn();
  select.mockReturnValueOnce(selectChain([ENROLLMENT_ROW])); // load enrollment
  select.mockReturnValueOnce(selectChain([])); // bounced check
  select.mockReturnValueOnce(selectChain([])); // reply check
  select.mockReturnValueOnce(selectChain([])); // awaiting call disposition (none)
  select.mockReturnValueOnce(selectChain([{ ...WHATSAPP_STEP_ROW, ...stepOverrides }])); // pending step
  // Note: unlike the "linkedin" branch, advanceEnrollment does not call applyStepVariant
  // for "whatsapp" steps, so there is no A/B/C variants select to reserve here.

  const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  const update = vi.fn().mockReturnValue({ set: updateSet });
  return { select, update, updateSet };
}

describe("sequence-enrollment worker — WhatsApp step claimNext race guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Worker).mockImplementation((() => ({
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    })) as any);
    vi.mocked(isBusinessHour).mockReturnValue(true);

    vi.mocked(resolveProspectFields).mockResolvedValue({
      prospectId: "p-1",
      email: "prospect@example.com",
      phone: "+15551234567",
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    } as any);
    vi.mocked(isSuppressed).mockResolvedValue(false);
    linkedinAccountMocks.isConfiguredForWorkspace.mockResolvedValue(true);
    linkedinAccountMocks.pickNextAccount.mockResolvedValue({ id: "acct-1", displayName: "Sender" });
    whatsappOutreachMocks.ensureJobForStep.mockResolvedValue({
      id: "job-1",
      status: "pending",
      failureReason: null,
    });
    vi.mocked(sendWhatsappOutreach).mockResolvedValue({ externalId: "ext-1" } as any);
  });

  it("does not send when claimNext fails to win the claim (another run already claimed the job)", async () => {
    vi.mocked(claimNext).mockResolvedValueOnce(undefined);

    const { select, update } = makeWhatsappWorkerDb();
    const db = { select, update, transaction: vi.fn() };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(claimNext).toHaveBeenCalledTimes(1);
    expect(sendWhatsappOutreach).not.toHaveBeenCalled();
    expect(whatsappOutreachMocks.completeJob).not.toHaveBeenCalled();
    expect(linkedinAccountMocks.markUsed).not.toHaveBeenCalled();
  });

  it("sends via Unipile when claimNext wins the claim on the job row", async () => {
    vi.mocked(claimNext).mockResolvedValueOnce({ id: "job-1", status: "claimed" } as any);

    const { select, update } = makeWhatsappWorkerDb();
    const db = { select, update, transaction: vi.fn() };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(claimNext).toHaveBeenCalledTimes(1);
    expect(sendWhatsappOutreach).toHaveBeenCalledWith(
      BASE_CONFIG,
      expect.objectContaining({ id: "acct-1" }),
      expect.objectContaining({ phone: "+15551234567" }),
      "ws-1",
      db
    );
    expect(linkedinAccountMocks.markUsed).toHaveBeenCalledWith("acct-1");
    expect(whatsappOutreachMocks.completeJob).toHaveBeenCalledWith("ws-1", "job-1");
  });
});

describe("sequence-enrollment worker — WhatsApp step lease heartbeat + transient-retry lease release", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Worker).mockImplementation((() => ({
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    })) as any);
    vi.mocked(isBusinessHour).mockReturnValue(true);

    vi.mocked(resolveProspectFields).mockResolvedValue({
      prospectId: "p-1",
      email: "prospect@example.com",
      phone: "+15551234567",
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    } as any);
    vi.mocked(isSuppressed).mockResolvedValue(false);
    linkedinAccountMocks.isConfiguredForWorkspace.mockResolvedValue(true);
    linkedinAccountMocks.pickNextAccount.mockResolvedValue({ id: "acct-1", displayName: "Sender" });
    whatsappOutreachMocks.ensureJobForStep.mockResolvedValue({
      id: "job-1",
      status: "pending",
      failureReason: null,
    });
    vi.mocked(claimNext).mockResolvedValue({ id: "job-1", status: "claimed" } as any);
  });

  it("wraps only the Unipile send in withLeaseHeartbeat — markUsed/completeJob run after, not inside it", async () => {
    vi.mocked(sendWhatsappOutreach).mockResolvedValue({ externalId: "ext-1" } as any);

    const { select, update } = makeWhatsappWorkerDb();
    const db = { select, update, transaction: vi.fn() };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(withLeaseHeartbeat).toHaveBeenCalledWith(
      db,
      "whatsappOutreachJobs",
      "job-1",
      expect.any(String),
      60_000,
      expect.any(Function)
    );
    expect(sendWhatsappOutreach).toHaveBeenCalledTimes(1);
    expect(linkedinAccountMocks.markUsed).toHaveBeenCalledWith("acct-1");
    expect(whatsappOutreachMocks.completeJob).toHaveBeenCalledWith("ws-1", "job-1");
  });

  it("releases the job's lease back to pending on a transient 429/5xx failure that will retry — does not fail the job", async () => {
    vi.mocked(sendWhatsappOutreach).mockRejectedValue(new UnipileError("rate limited", 429));
    vi.mocked(recordResult).mockResolvedValue({ id: "job-1", status: "pending" } as never);

    const { select, update } = makeWhatsappWorkerDb(); // default WHATSAPP_STEP_ROW: no attemptCount → nextAttempt 1 ≤ default maxAttempts 3 → "retry"
    const db = { select, update, transaction: vi.fn() };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(recordResult).toHaveBeenCalledWith(db, "whatsappOutreachJobs", "job-1", expect.any(String), {
      status: "pending",
    });
    expect(whatsappOutreachMocks.failJob).not.toHaveBeenCalled();
  });

  it("does not separately release the lease when retries are exhausted — failJob's own recordResult(status: failed) already releases it", async () => {
    vi.mocked(sendWhatsappOutreach).mockRejectedValue(new UnipileError("rate limited", 429));

    // Force retryTransientFailure's "exhausted" branch: attemptCount already at the step's own cap.
    const { select, update } = makeWhatsappWorkerDb({ retryMaxAttempts: 1, attemptCount: 1 });
    const db = { select, update, transaction: vi.fn() };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(whatsappOutreachMocks.failJob).toHaveBeenCalledWith("ws-1", "job-1", expect.stringContaining("retry_exhausted"));
    expect(recordResult).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// "Manual task" step execution (R21.3) — createTaskFromSequenceStep isn't
// exported either, so this is exercised the same indirect way as the email tests.
// ---------------------------------------------------------------------------

const TASK_STEP_ROW = {
  enrollmentStepId: "estep-task-1",
  stepId: "step-task-1",
  scheduledAt: PAST_DATE,
  stepOrder: 1,
  stepType: "task",
  subject: "Call {{firstName}}",
  bodyTemplate: null,
};

describe("sequence-enrollment worker — manual task step execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Worker).mockImplementation((() => ({
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    })) as any);
    vi.mocked(isBusinessHour).mockReturnValue(true);
  });

  function makeTaskStepDb(opts: { matchedContact?: { id: string } }) {
    const select = vi.fn();
    select.mockReturnValueOnce(selectChain([ENROLLMENT_ROW])); // load enrollment
    select.mockReturnValueOnce(selectChain([])); // bounced check
    select.mockReturnValueOnce(selectChain([])); // reply check
    select.mockReturnValueOnce(selectChain([])); // awaiting-call-disposition check
    select.mockReturnValueOnce(selectChain([TASK_STEP_ROW])); // pending step
    select.mockReturnValueOnce(selectChain(opts.matchedContact ? [opts.matchedContact] : [])); // contact lookup
    select.mockReturnValueOnce(selectChain([])); // next pending step (none → completed)

    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockReturnValue({ values: insertValues });
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const update = vi.fn().mockReturnValue({ set: updateSet });
    const transaction = vi.fn();

    return { select, insert, insertValues, update, updateSet, transaction };
  }

  it("creates a CRM task due immediately, rendered from the step template, and marks the step executed", async () => {
    vi.mocked(resolveProspectFields).mockResolvedValue({
      prospectId: "p-1",
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    } as any);
    vi.mocked(renderTemplate).mockImplementation((template: string) => template.replace("{{firstName}}", "Ada"));

    const { select, insert, insertValues, update, updateSet, transaction } = makeTaskStepDb({});
    const db = { select, insert, update, transaction };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "id", disposition: "disposition", sequenceEnrollmentStepId: "sequence_enrollment_step_id" })
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        title: "Call Ada",
        type: "custom",
        relatedEntityType: undefined,
        relatedEntityId: undefined,
      })
    );
    expect(insertValues.mock.calls[0]![0].dueDate).toBeInstanceOf(Date);
    expect(update).toHaveBeenCalledWith("sequenceEnrollmentSteps");
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: "executed" }));
  });

  it("links the task to the matching CRM contact when the prospect has already been synced", async () => {
    vi.mocked(resolveProspectFields).mockResolvedValue({ prospectId: "p-1", firstName: "Ada" } as any);
    vi.mocked(renderTemplate).mockImplementation((template: string) => template);

    const { select, insert, insertValues, update, transaction } = makeTaskStepDb({
      matchedContact: { id: "contact-1" },
    });
    const db = { select, insert, update, transaction };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ relatedEntityType: "contact", relatedEntityId: "contact-1" })
    );
  });

  it("falls back to a generic title when the step has no subject and prospect lookup fails", async () => {
    vi.mocked(resolveProspectFields).mockRejectedValue(new Error("prospect_not_found"));
    vi.mocked(renderTemplate).mockImplementation((template: string) => template);

    const stepWithNoSubject = { ...TASK_STEP_ROW, subject: null };
    const select = vi.fn();
    select.mockReturnValueOnce(selectChain([ENROLLMENT_ROW]));
    select.mockReturnValueOnce(selectChain([]));
    select.mockReturnValueOnce(selectChain([]));
    select.mockReturnValueOnce(selectChain([])); // awaiting-call-disposition check
    select.mockReturnValueOnce(selectChain([stepWithNoSubject]));
    select.mockReturnValueOnce(selectChain([]));
    select.mockReturnValueOnce(selectChain([]));

    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockReturnValue({ values: insertValues });
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const update = vi.fn().mockReturnValue({ set: updateSet });
    const db = { select, insert, update, transaction: vi.fn() };

    const processor = await getProcessor(db);
    await processor({ data: JOB_PAYLOAD, attemptsMade: 1 });

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ title: "Follow up with prospect" }));
  });
});

describe("retryTransientFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const PAYLOAD = {
    enrollmentId: "enr-1",
    workspaceId: "ws-1",
    prospectId: "prospect-1",
    sequenceId: "seq-1",
  };

  function makeDb() {
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const update = vi.fn().mockReturnValue({ set: updateSet });
    return { update, _updateSet: updateSet };
  }

  it("re-enqueues with the fixed delay and increments attemptCount when under the max", async () => {
    const db = makeDb();
    const pending = {
      enrollmentStepId: "estep-1",
      stepId: "step-1",
      stepType: "linkedin",
      linkedinAction: "connect",
      subject: null,
      bodyTemplate: null,
      attemptCount: 0,
      retryMaxAttempts: 3,
      retryDelayMs: 60_000,
      retryBackoffStrategy: "fixed",
    } as any;

    const outcome = await retryTransientFailure(db as any, {} as any, PAYLOAD, pending, "rate_limited", new Date());

    expect(outcome).toBe("retry");
    expect(db._updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ attemptCount: 1, failureReason: "rate_limited" })
    );
    expect(enqueueSequenceAdvanceJob).toHaveBeenCalledWith({}, PAYLOAD, 60_000, false);
    expect(recordSequenceEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "retry_scheduled" })
    );
  });

  it("doubles the delay each attempt with exponential backoff", async () => {
    const db = makeDb();
    const pending = {
      enrollmentStepId: "estep-1",
      stepId: "step-1",
      stepType: "linkedin",
      linkedinAction: "connect",
      subject: null,
      bodyTemplate: null,
      attemptCount: 2, // this will be the 3rd attempt
      retryMaxAttempts: 5,
      retryDelayMs: 1_000,
      retryBackoffStrategy: "exponential",
    } as any;

    await retryTransientFailure(db as any, {} as any, PAYLOAD, pending, "rate_limited", new Date());

    // attempt 3 → 1000 * 2^(3-1) = 4000
    expect(enqueueSequenceAdvanceJob).toHaveBeenCalledWith({}, PAYLOAD, 4_000, false);
  });

  it("marks the step failed and emits fallback_triggered once max attempts is exceeded — never retries forever", async () => {
    const db = makeDb();
    const pending = {
      enrollmentStepId: "estep-1",
      stepId: "step-1",
      stepType: "linkedin",
      linkedinAction: "connect",
      subject: null,
      bodyTemplate: null,
      attemptCount: 3,
      retryMaxAttempts: 3,
      retryDelayMs: 60_000,
      retryBackoffStrategy: "fixed",
    } as any;

    const outcome = await retryTransientFailure(db as any, {} as any, PAYLOAD, pending, "rate_limited", new Date());

    expect(outcome).toBe("exhausted");
    expect(db._updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", failureReason: "retry_exhausted: rate_limited" })
    );
    expect(enqueueSequenceAdvanceJob).not.toHaveBeenCalled();
    expect(recordSequenceEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "fallback_triggered", reason: "retry_exhausted: rate_limited" })
    );
  });

  it("defaults to 3 max attempts and a fixed 60s delay when the step has no retry policy set", async () => {
    const db = makeDb();
    const pending = {
      enrollmentStepId: "estep-1",
      stepId: "step-1",
      stepType: "linkedin",
      linkedinAction: "connect",
      subject: null,
      bodyTemplate: null,
      // no attemptCount/retry* fields — exercises the ?? defaults
    } as any;

    const outcome = await retryTransientFailure(db as any, {} as any, PAYLOAD, pending, "rate_limited", new Date());

    expect(outcome).toBe("retry");
    expect(enqueueSequenceAdvanceJob).toHaveBeenCalledWith({}, PAYLOAD, 60_000, false);
  });
});

describe("countTrackingEvents", () => {
  function makeCountDb(rows: Array<{ n: number }>) {
    const where = vi.fn().mockResolvedValue(rows);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    return { select } as any;
  }

  it("returns the row count when events exist", async () => {
    const db = makeCountDb([{ n: 4 }]);
    const n = await countTrackingEvents(db, "ws-1", "enr-1", "open");
    expect(n).toBe(4);
  });

  it("returns 0 when no row is returned", async () => {
    const db = makeCountDb([]);
    const n = await countTrackingEvents(db, "ws-1", "enr-1", "click");
    expect(n).toBe(0);
  });
});

describe("hasMeetingBookedThread", () => {
  function makeThreadDb(rows: Array<{ id: string }>) {
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    return { select } as any;
  }

  it("returns true when the enrollment has a meeting_booked thread", async () => {
    const db = makeThreadDb([{ id: "thread-1" }]);
    expect(await hasMeetingBookedThread(db, "ws-1", "enr-1")).toBe(true);
  });

  it("returns false when no meeting_booked thread exists for the enrollment", async () => {
    const db = makeThreadDb([]);
    expect(await hasMeetingBookedThread(db, "ws-1", "enr-1")).toBe(false);
  });
});
