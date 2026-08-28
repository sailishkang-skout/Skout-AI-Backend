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
import { sendLinkedinOutreach } from "../services/linkedin-account.service.js";
import { claimNext } from "@skout/shared";
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

function makeLinkedinWorkerDb() {
  const select = vi.fn();
  select.mockReturnValueOnce(selectChain([ENROLLMENT_ROW])); // load enrollment
  select.mockReturnValueOnce(selectChain([])); // bounced check
  select.mockReturnValueOnce(selectChain([])); // reply check
  select.mockReturnValueOnce(selectChain([])); // awaiting call disposition (none)
  select.mockReturnValueOnce(selectChain([LINKEDIN_STEP_ROW])); // pending step
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
