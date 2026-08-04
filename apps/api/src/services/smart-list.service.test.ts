import { describe, expect, it, vi } from "vitest";
import {
  createSmartList,
  getSmartListRefresh,
  listSmartListRefreshes,
  updateSmartListRefreshSchedule,
} from "./smart-list.service.js";

const WORKSPACE = "ws-1";
const LIST_ID = "list-1";

// select chain that terminates at the specified method (mirrors list.service.test.ts).
function selectChain(result: unknown[], terminal: "orderBy" | "where" | "limit" = "where") {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = terminal === "where" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.orderBy = terminal === "orderBy" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.limit = terminal === "limit" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  return c;
}

function updateReturning(result: unknown[]) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(result),
      }),
    }),
  };
}

function makeDb(selectResults: ReturnType<typeof selectChain>[], updates: ReturnType<typeof updateReturning>[] = []) {
  const db = { select: vi.fn(), update: vi.fn() };
  for (const chain of selectResults) db.select.mockReturnValueOnce(chain);
  for (const upd of updates) db.update.mockReturnValueOnce(upd);
  return db;
}

const EXISTING_LIST_ROW = {
  id: LIST_ID,
  workspaceId: WORKSPACE,
  name: "Test list",
  filters: {},
  lastRunCount: 5,
  refreshCadence: "off",
  nextRefreshAt: null,
  lastRefreshedAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("updateSmartListRefreshSchedule", () => {
  it("returns null when the list doesn't belong to the workspace", async () => {
    const db = makeDb([selectChain([{ ...EXISTING_LIST_ROW, workspaceId: "other-ws" }])]);
    const result = await updateSmartListRefreshSchedule(db as never, WORKSPACE, LIST_ID, "daily");
    expect(result).toBeNull();
  });

  it("returns null when the list doesn't exist", async () => {
    const db = makeDb([selectChain([])]);
    const result = await updateSmartListRefreshSchedule(db as never, WORKSPACE, LIST_ID, "daily");
    expect(result).toBeNull();
  });

  it("sets cadence and computes nextRefreshAt for 'daily'", async () => {
    const updatedRow = { ...EXISTING_LIST_ROW, refreshCadence: "daily", nextRefreshAt: new Date() };
    const db = makeDb([selectChain([EXISTING_LIST_ROW])], [updateReturning([updatedRow])]);

    const result = await updateSmartListRefreshSchedule(db as never, WORKSPACE, LIST_ID, "daily");

    expect(result?.refreshCadence).toBe("daily");
    const updateCall = db.update.mock.calls[0];
    expect(updateCall).toBeDefined();
  });

  it("clears nextRefreshAt when cadence is set to 'off'", async () => {
    const db = makeDb([selectChain([EXISTING_LIST_ROW])]);
    const setSpy = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ ...EXISTING_LIST_ROW }]) }),
    });
    db.update.mockReturnValueOnce({ set: setSpy });

    await updateSmartListRefreshSchedule(db as never, WORKSPACE, LIST_ID, "off");

    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ refreshCadence: "off", nextRefreshAt: null })
    );
  });

  it("in-memory fallback (no db) stores the cadence on the created record", async () => {
    const created = await createSmartList(null, "mem-ws", "Memory list", {});
    const result = await updateSmartListRefreshSchedule(null, "mem-ws", created.id, "weekly");
    expect(result?.refreshCadence).toBe("weekly");
    expect(result?.nextRefreshAt).not.toBeNull();
  });
});

describe("listSmartListRefreshes", () => {
  it("returns [] when the list isn't found in the workspace", async () => {
    const db = makeDb([selectChain([])]);
    const result = await listSmartListRefreshes(db as never, WORKSPACE, LIST_ID);
    expect(result).toEqual([]);
  });

  it("returns [] in memory mode (no db)", async () => {
    const result = await listSmartListRefreshes(null, WORKSPACE, LIST_ID);
    expect(result).toEqual([]);
  });

  it("maps refresh rows to summaries", async () => {
    const refreshRow = {
      id: "refresh-1",
      workspaceId: WORKSPACE,
      smartListId: LIST_ID,
      status: "completed",
      matchedCount: 10,
      addedCount: 2,
      droppedCount: 1,
      addedProspects: [{ prospectId: "p1" }],
      droppedProspects: [{ prospectId: "p2" }],
      creditsCharged: 4,
      requiredCredits: null,
      availableCredits: null,
      errorMessage: null,
      startedAt: new Date("2026-01-01T00:00:00Z"),
      completedAt: new Date("2026-01-01T00:05:00Z"),
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    const db = makeDb([selectChain([EXISTING_LIST_ROW]), selectChain([refreshRow], "limit")]);

    const result = await listSmartListRefreshes(db as never, WORKSPACE, LIST_ID);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "refresh-1", status: "completed", addedCount: 2, droppedCount: 1 });
    // Lean summary shape — no diff payload.
    expect(result[0]).not.toHaveProperty("addedProspects");
  });
});

describe("getSmartListRefresh", () => {
  it("returns null in memory mode (no db)", async () => {
    const result = await getSmartListRefresh(null, WORKSPACE, LIST_ID, "refresh-1");
    expect(result).toBeNull();
  });

  it("returns null when the refresh belongs to a different workspace", async () => {
    const db = makeDb([
      selectChain([
        {
          id: "refresh-1",
          workspaceId: "other-ws",
          smartListId: LIST_ID,
          status: "completed",
          matchedCount: 0,
          addedCount: 0,
          droppedCount: 0,
          addedProspects: [],
          droppedProspects: [],
          creditsCharged: 0,
          requiredCredits: null,
          availableCredits: null,
          errorMessage: null,
          startedAt: null,
          completedAt: null,
          createdAt: new Date(),
        },
      ]),
    ]);
    const result = await getSmartListRefresh(db as never, WORKSPACE, LIST_ID, "refresh-1");
    expect(result).toBeNull();
  });

  it("returns the full diff detail when found", async () => {
    const row = {
      id: "refresh-1",
      workspaceId: WORKSPACE,
      smartListId: LIST_ID,
      status: "skipped_insufficient_credits",
      matchedCount: 5,
      addedCount: 3,
      droppedCount: 0,
      addedProspects: [{ prospectId: "p1", fullName: "Alice" }],
      droppedProspects: [],
      creditsCharged: 0,
      requiredCredits: 6,
      availableCredits: 2,
      errorMessage: null,
      startedAt: new Date(),
      completedAt: new Date(),
      createdAt: new Date(),
    };
    const db = makeDb([selectChain([row])]);

    const result = await getSmartListRefresh(db as never, WORKSPACE, LIST_ID, "refresh-1");

    expect(result?.addedProspects).toEqual([{ prospectId: "p1", fullName: "Alice" }]);
    expect(result?.requiredCredits).toBe(6);
    expect(result?.status).toBe("skipped_insufficient_credits");
  });
});
