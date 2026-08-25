import { beforeEach, describe, expect, it, vi } from "vitest";

const runWorkspaceRescore = vi.fn();
const invalidateById = vi.fn().mockResolvedValue(undefined);

vi.mock("./enrichment/index.js", () => ({
  buildEnrichmentService: vi.fn(() => ({ runWorkspaceRescore })),
}));

vi.mock("./search-cache.service.js", () => ({
  createSearchCacheService: vi.fn(() => ({ invalidateById })),
}));

const { runWorkspaceRescoreJob } = await import("./workspace-rescore.runner.js");

const WORKSPACE = "ws-1";
const JOB_ID = "job-1";
const config = {} as never;

function mockDb(initialStatus = "pending") {
  const updates: { set: unknown }[] = [];
  let status = initialStatus;
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockImplementation(() => Promise.resolve([{ status }])),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((set: unknown) => {
        updates.push({ set });
        if (set && typeof set === "object" && "status" in set) {
          status = (set as { status: string }).status;
        }
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
  };
  return { db, updates, setStatus: (next: string) => (status = next) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runWorkspaceRescoreJob", () => {
  it("marks the job running, then completed, and invalidates the search cache per prospect on success", async () => {
    const { db, updates } = mockDb();
    const results = [
      { prospectId: "p1", icpScore: 80, icpBand: "hot" },
      { prospectId: "p2", icpScore: 40, icpBand: "cold" },
    ];
    runWorkspaceRescore.mockResolvedValue({ icpVersion: 2, scored: 2, skipped: 0, creditsUsed: 4, results });

    const result = await runWorkspaceRescoreJob(db as never, config, JOB_ID, WORKSPACE, 2);

    expect(updates[0]?.set).toMatchObject({ status: "running" });
    expect(updates.at(-1)?.set).toMatchObject({
      status: "completed",
      result: { workspaceId: WORKSPACE, icpVersion: 2, scored: 2, skipped: 0, creditsUsed: 4, results },
    });
    expect(result).toEqual({ workspaceId: WORKSPACE, icpVersion: 2, scored: 2, skipped: 0, creditsUsed: 4, results });
    expect(invalidateById).toHaveBeenCalledTimes(2);
    expect(invalidateById).toHaveBeenCalledWith(WORKSPACE, "p1");
    expect(invalidateById).toHaveBeenCalledWith(WORKSPACE, "p2");
  });

  it("streams progress updates to the async job row as prospects are scored", async () => {
    const { db, updates } = mockDb();
    runWorkspaceRescore.mockImplementation(async (_ws: string, _v: number, opts: { onProgress: (p: unknown) => Promise<void> }) => {
      await opts.onProgress({ scored: 1, total: 2, creditsUsed: 2, results: [{ prospectId: "p1", icpScore: 80, icpBand: "hot" }] });
      return { icpVersion: 2, scored: 2, skipped: 0, creditsUsed: 4, results: [] };
    });

    await runWorkspaceRescoreJob(db as never, config, JOB_ID, WORKSPACE, 2);

    const progressUpdate = updates.find(
      (u) => (u.set as { result?: { scored?: number } }).result?.scored === 1
    );
    expect(progressUpdate?.set).toMatchObject({
      result: { workspaceId: WORKSPACE, icpVersion: 2, scored: 1, total: 2, creditsUsed: 2 },
    });
  });

  it("marks the job failed and rethrows on error, without invalidating any cache entries", async () => {
    const { db, updates } = mockDb();
    runWorkspaceRescore.mockRejectedValue(new Error("ICP_NOT_CONFIGURED"));

    await expect(runWorkspaceRescoreJob(db as never, config, JOB_ID, WORKSPACE, 2)).rejects.toThrow(
      "ICP_NOT_CONFIGURED"
    );

    expect(updates.at(-1)?.set).toMatchObject({ status: "failed", errorMessage: "ICP_NOT_CONFIGURED" });
    expect(invalidateById).not.toHaveBeenCalled();
  });

  it("stops at the next progress tick and marks cancelled when cancelled mid-run", async () => {
    const { db, updates, setStatus } = mockDb();
    runWorkspaceRescore.mockImplementation(
      async (_ws: string, _v: number, opts: { onProgress: (p: unknown) => Promise<void> }) => {
        await opts.onProgress({
          scored: 1,
          total: 2,
          creditsUsed: 2,
          results: [{ prospectId: "p1", icpScore: 80, icpBand: "hot" }],
        });
        setStatus("cancelled"); // simulate a cancel request landing between ticks
        await opts.onProgress({
          scored: 2,
          total: 2,
          creditsUsed: 4,
          results: [{ prospectId: "p1", icpScore: 80, icpBand: "hot" }],
        });
        return { icpVersion: 2, scored: 2, skipped: 0, creditsUsed: 4, results: [] };
      }
    );

    await expect(runWorkspaceRescoreJob(db as never, config, JOB_ID, WORKSPACE, 2)).rejects.toThrow(
      "cancelled"
    );

    expect(updates.at(-1)?.set).toMatchObject({ status: "cancelled" });
    expect(invalidateById).not.toHaveBeenCalled();
  });

  it("never starts and leaves the row alone if already cancelled before the worker picks it up", async () => {
    const { db, updates } = mockDb("cancelled");

    await expect(runWorkspaceRescoreJob(db as never, config, JOB_ID, WORKSPACE, 2)).rejects.toThrow(
      "cancelled"
    );

    expect(runWorkspaceRescore).not.toHaveBeenCalled();
    // The cancel endpoint already wrote status: "cancelled" — the runner has nothing to update.
    expect(updates).toHaveLength(0);
  });
});
