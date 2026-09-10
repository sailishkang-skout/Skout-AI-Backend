import { describe, expect, it, vi } from "vitest";
import {
  createSmartList,
  getSmartListRefresh,
  listSmartListRefreshes,
  revertSmartListRefresh,
  summarizeSearchFilters,
  updateSmartListRefreshSchedule,
} from "./smart-list.service.js";
import { HttpError } from "../utils/http.js";

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

describe("summarizeSearchFilters", () => {
  it("renders active filters as a readable, labeled list", () => {
    expect(summarizeSearchFilters({ industry: "SaaS", minEmployees: 50 })).toBe(
      "industry: SaaS · min employees: 50"
    );
  });

  it("renders array filters (including signal-based ones) joined by comma", () => {
    expect(summarizeSearchFilters({ contactSignals: ["recent_funding", "tech_adoption"] })).toBe(
      "contact signals: recent_funding, tech_adoption"
    );
  });

  it("renders a true boolean filter as its label alone, and skips a false one", () => {
    expect(summarizeSearchFilters({ currentlyHiring: true, excludeDuplicates: false })).toBe("currently hiring");
  });

  it("skips undefined, null, empty-string, and empty-array values", () => {
    expect(summarizeSearchFilters({ industry: undefined, companyName: "", contactSignals: [] })).toBe(
      "no filters set (matches everything)"
    );
  });

  it("returns the empty-filters message for a list with no criteria at all", () => {
    expect(summarizeSearchFilters({})).toBe("no filters set (matches everything)");
  });
});

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
    expect(result[0]).toMatchObject({
      id: "refresh-1",
      status: "completed",
      addedCount: 2,
      droppedCount: 1,
      // The list now carries each refresh's full diff, not just counts.
      addedProspects: [{ prospectId: "p1" }],
      droppedProspects: [{ prospectId: "p2" }],
    });
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

describe("revertSmartListRefresh", () => {
  const REFRESH_ROW = {
    id: "refresh-2",
    workspaceId: WORKSPACE,
    smartListId: LIST_ID,
    status: "completed",
    matchedCount: 10,
    addedCount: 1,
    droppedCount: 1,
    addedProspects: [{ prospectId: "p1" }],
    droppedProspects: [{ prospectId: "p2" }],
    creditsCharged: 3,
    requiredCredits: null,
    availableCredits: null,
    errorMessage: null,
    startedAt: new Date(),
    completedAt: new Date(),
    createdAt: new Date(),
  };

  function insertValues(result: unknown) {
    return { values: vi.fn().mockResolvedValue(result) };
  }

  function insertValuesReturning(result: unknown[]) {
    return { values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) };
  }

  function deleteWhere() {
    return { where: vi.fn().mockResolvedValue(undefined) };
  }

  it("returns null when the list isn't found in the workspace", async () => {
    const db = { select: vi.fn().mockReturnValueOnce(selectChain([])) };
    const result = await revertSmartListRefresh(db as never, WORKSPACE, LIST_ID, "refresh-2");
    expect(result).toBeNull();
  });

  it("rejects reverting a refresh that isn't the most recent one", async () => {
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([EXISTING_LIST_ROW]))
        .mockReturnValueOnce(selectChain([REFRESH_ROW]))
        .mockReturnValueOnce(selectChain([{ id: "refresh-3" }], "limit")),
    };
    await expect(revertSmartListRefresh(db as never, WORKSPACE, LIST_ID, "refresh-2")).rejects.toThrow(
      HttpError
    );
  });

  it("rejects reverting a refresh that isn't completed (e.g. already reverted)", async () => {
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([EXISTING_LIST_ROW]))
        .mockReturnValueOnce(selectChain([{ ...REFRESH_ROW, status: "reverted" }])),
    };
    await expect(revertSmartListRefresh(db as never, WORKSPACE, LIST_ID, "refresh-2")).rejects.toThrow(
      HttpError
    );
  });

  it("swaps membership back and records the reverse as a new history entry", async () => {
    const revertRow = {
      ...REFRESH_ROW,
      id: "revert-1",
      status: "reverted",
      addedCount: 1,
      droppedCount: 1,
      addedProspects: [{ prospectId: "p2" }],
      droppedProspects: [{ prospectId: "p1" }],
    };
    const deleteSpy = vi.fn().mockReturnValue(deleteWhere());
    const insertSpy = vi
      .fn()
      .mockReturnValueOnce(insertValues(undefined)) // re-add dropped prospects to smartListMembers
      .mockReturnValueOnce(insertValuesReturning([revertRow])); // new "reverted" history row
    const updateSpy = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([EXISTING_LIST_ROW]))
        .mockReturnValueOnce(selectChain([REFRESH_ROW]))
        .mockReturnValueOnce(selectChain([{ id: "refresh-2" }], "limit")),
      delete: deleteSpy,
      insert: insertSpy,
      update: updateSpy,
    };

    const result = await revertSmartListRefresh(db as never, WORKSPACE, LIST_ID, "refresh-2");

    expect(deleteSpy).toHaveBeenCalledTimes(1); // removed the prospects the original refresh added
    expect(insertSpy).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      id: "revert-1",
      status: "reverted",
      addedProspects: [{ prospectId: "p2" }],
      droppedProspects: [{ prospectId: "p1" }],
    });
  });

  it("returns null in memory mode (no db)", async () => {
    const result = await revertSmartListRefresh(null, WORKSPACE, LIST_ID, "refresh-2");
    expect(result).toBeNull();
  });
});
