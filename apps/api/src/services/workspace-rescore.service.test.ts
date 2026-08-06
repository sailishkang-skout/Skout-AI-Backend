import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IcpConfig } from "./enrichment/ai-client.js";

const prepareWorkspaceRescore = vi.fn();
const runWorkspaceRescore = vi.fn();
const isRedisAvailable = vi.fn();
const enqueueWorkspaceRescoreJob = vi.fn();

vi.mock("./enrichment/index.js", () => ({
  buildEnrichmentService: vi.fn(() => ({ prepareWorkspaceRescore, runWorkspaceRescore })),
}));

vi.mock("../lib/redis.js", () => ({
  isRedisAvailable: (...args: unknown[]) => isRedisAvailable(...args),
}));

vi.mock("../workers/workspace-rescore.queue.js", () => ({
  enqueueWorkspaceRescoreJob: (...args: unknown[]) => enqueueWorkspaceRescoreJob(...args),
}));

const { isAutoRescoreEnabled, startWorkspaceRescoreIfEnabled } = await import(
  "./workspace-rescore.service.js"
);

const WORKSPACE = "ws-1";
const CONFIGURED_ICP: IcpConfig = { industries: ["Software"] };
const config = {} as never;

function mockDb(insertedRow: { id: string } = { id: "job-1" }) {
  const updates: { set: unknown }[] = [];
  return {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([insertedRow]),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((set: unknown) => {
        updates.push({ set });
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
    __updates: updates,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prepareWorkspaceRescore.mockResolvedValue({ snapshots: [{ prospectId: "p1" }], totalCost: 2 });
});

describe("isAutoRescoreEnabled", () => {
  it("defaults to enabled when unset", () => {
    expect(isAutoRescoreEnabled({})).toBe(true);
  });

  it("is enabled when explicitly true", () => {
    expect(isAutoRescoreEnabled({ autoRescoreOnChange: true })).toBe(true);
  });

  it("is disabled only when explicitly false", () => {
    expect(isAutoRescoreEnabled({ autoRescoreOnChange: false })).toBe(false);
  });
});

describe("startWorkspaceRescoreIfEnabled", () => {
  it("returns null when there is no db", async () => {
    const result = await startWorkspaceRescoreIfEnabled(null, config, WORKSPACE, CONFIGURED_ICP, 2, 1);
    expect(result).toBeNull();
  });

  it("returns null on the first save (icpVersion <= 1)", async () => {
    const db = mockDb();
    const result = await startWorkspaceRescoreIfEnabled(db as never, config, WORKSPACE, CONFIGURED_ICP, 1, 0);
    expect(result).toBeNull();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("returns null when the version didn't actually advance", async () => {
    const db = mockDb();
    const result = await startWorkspaceRescoreIfEnabled(db as never, config, WORKSPACE, CONFIGURED_ICP, 2, 2);
    expect(result).toBeNull();
  });

  it("returns null when the ICP isn't configured", async () => {
    const db = mockDb();
    const result = await startWorkspaceRescoreIfEnabled(db as never, config, WORKSPACE, {}, 2, 1);
    expect(result).toBeNull();
  });

  it("returns null when the toggle is disabled", async () => {
    const db = mockDb();
    const result = await startWorkspaceRescoreIfEnabled(
      db as never,
      config,
      WORKSPACE,
      { ...CONFIGURED_ICP, autoRescoreOnChange: false },
      2,
      1
    );
    expect(result).toBeNull();
    expect(prepareWorkspaceRescore).not.toHaveBeenCalled();
  });

  it("returns null when there are no activated prospects to rescore", async () => {
    prepareWorkspaceRescore.mockResolvedValue({ snapshots: [], totalCost: 0 });
    const db = mockDb();
    const result = await startWorkspaceRescoreIfEnabled(db as never, config, WORKSPACE, CONFIGURED_ICP, 2, 1);
    expect(result).toBeNull();
  });

  it("enqueues a background job and returns pending status when Redis is available", async () => {
    isRedisAvailable.mockResolvedValue(true);
    const db = mockDb({ id: "job-42" });

    const result = await startWorkspaceRescoreIfEnabled(db as never, config, WORKSPACE, CONFIGURED_ICP, 2, 1);

    expect(result).toEqual({ jobId: "job-42", status: "pending" });
    expect(enqueueWorkspaceRescoreJob).toHaveBeenCalledWith(config, {
      jobId: "job-42",
      workspaceId: WORKSPACE,
      icpVersion: 2,
    });
    expect(runWorkspaceRescore).not.toHaveBeenCalled();
  });

  it("marks the job failed and returns null when enqueueing fails", async () => {
    isRedisAvailable.mockResolvedValue(true);
    enqueueWorkspaceRescoreJob.mockRejectedValue(new Error("queue down"));
    const db = mockDb({ id: "job-42" });

    const result = await startWorkspaceRescoreIfEnabled(db as never, config, WORKSPACE, CONFIGURED_ICP, 2, 1);

    expect(result).toBeNull();
    expect(db.__updates[0]?.set).toMatchObject({ status: "failed", errorMessage: "queue_unavailable" });
  });

  it("falls back to running synchronously when Redis is unavailable", async () => {
    isRedisAvailable.mockResolvedValue(false);
    runWorkspaceRescore.mockResolvedValue({ scored: 3, skipped: 0, creditsUsed: 6, results: [] });
    const db = mockDb();

    const result = await startWorkspaceRescoreIfEnabled(db as never, config, WORKSPACE, CONFIGURED_ICP, 2, 1);

    expect(result).toEqual({ status: "completed", scored: 3, skipped: 0, creditsUsed: 6, results: [] });
    expect(runWorkspaceRescore).toHaveBeenCalledWith(WORKSPACE, 2);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
