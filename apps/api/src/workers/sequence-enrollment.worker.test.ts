import { describe, expect, it, vi, beforeEach } from "vitest";

// Hoisted mocks — must appear before any imports that transitively load these modules
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
  },
}));

vi.mock("./sequence-enrollment.queue.js", () => ({
  SEQUENCE_ENROLLMENT_QUEUE: "skout-sequence-enrollment",
  enqueueSequenceAdvanceJob: vi.fn().mockResolvedValue(undefined),
  getSequenceEnrollmentQueue: vi.fn().mockReturnValue({
    add: vi.fn().mockResolvedValue({}),
  }),
}));

import { startSequenceEnrollmentWorker } from "./sequence-enrollment.worker.js";
import { Worker } from "bullmq";
import { createDb } from "@skout/db";

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
