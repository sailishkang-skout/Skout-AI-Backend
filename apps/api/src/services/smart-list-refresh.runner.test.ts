import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@skout/db";
import type { ProspectDocument } from "@skout/opensearch";
import { InsufficientCreditsError } from "./enrichment/types.js";

const runCorpusScore = vi.fn();
const invalidateSmartList = vi.fn().mockResolvedValue(undefined);

vi.mock("@skout/opensearch", async () => {
  const actual = await vi.importActual<typeof import("@skout/opensearch")>("@skout/opensearch");
  return {
    ...actual,
    runSmartListQueryWithFallback: vi.fn(),
    prospectIdsStillMatching: vi.fn().mockResolvedValue(new Set()),
    fetchProspectFacets: vi.fn().mockRejectedValue(new Error("facets unavailable in tests")),
  };
});

vi.mock("./enrichment/index.js", async () => {
  const actual = await vi.importActual<typeof import("./enrichment/index.js")>("./enrichment/index.js");
  return {
    ...actual,
    buildEnrichmentService: vi.fn(() => ({ runCorpusScore })),
  };
});

vi.mock("./search-cache.service.js", () => ({
  createSearchCacheService: vi.fn(() => ({ invalidateSmartList })),
}));

vi.mock("./smart-list.mapper.js", () => ({
  prospectToSnapshot: (doc: ProspectDocument) => ({
    prospectId: doc.prospectId,
    companyDomain: doc.companyDomain,
  }),
}));

const { runSmartListQueryWithFallback, prospectIdsStillMatching } = await import("@skout/opensearch");
const { runSmartListRefreshJob } = await import("./smart-list-refresh.runner.js");

const { smartLists, smartListMembers, smartListRefreshes, asyncJobs } = schema;

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const LIST_ID = "10000000-0000-4000-8000-000000000001";
const JOB_ID = "20000000-0000-4000-8000-000000000001";

function doc(prospectId: string, companyDomain = "acme.com"): ProspectDocument {
  return {
    prospectId,
    companyId: `company-${prospectId}`,
    fullName: `Prospect ${prospectId}`,
    title: "VP Sales",
    companyDomain,
    updatedAt: new Date().toISOString(),
  };
}

interface MockDbHandle {
  db: {
    select: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  inserts: { table: unknown; values: unknown }[];
  updates: { table: unknown; set: unknown }[];
  deletes: { table: unknown }[];
}

function createMockDb(opts: {
  list: (typeof smartLists.$inferSelect) | undefined;
  previousMembers: (typeof smartListMembers.$inferSelect)[];
}): MockDbHandle {
  const inserts: { table: unknown; values: unknown }[] = [];
  const updates: { table: unknown; set: unknown }[] = [];
  const deletes: { table: unknown }[] = [];

  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(async () => {
          if (table === smartLists) return opts.list ? [opts.list] : [];
          if (table === smartListMembers) return opts.previousMembers;
          return [];
        }),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        inserts.push({ table, values });
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((set: unknown) => ({
        where: vi.fn(async () => {
          updates.push({ table, set });
        }),
      })),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(async () => {
        deletes.push({ table });
      }),
    })),
  };

  return { db, inserts, updates, deletes };
}

/** asyncJobs is updated twice (running, then final) — grab the last matching update. */
function lastUpdate(updates: MockDbHandle["updates"], table: unknown) {
  return [...updates].reverse().find((u) => u.table === table);
}

function baseList(overrides: Partial<typeof smartLists.$inferSelect> = {}): typeof smartLists.$inferSelect {
  const now = new Date();
  return {
    id: LIST_ID,
    workspaceId: WORKSPACE,
    name: "Test list",
    filters: {},
    lastRunCount: null,
    refreshCadence: "daily",
    nextRefreshAt: now,
    lastRefreshedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const config = { OPENSEARCH_URL: "http://os.test" } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runSmartListRefreshJob", () => {
  it("marks the job failed and stops when the smart list is missing", async () => {
    const { db, updates, inserts } = createMockDb({ list: undefined, previousMembers: [] });

    await runSmartListRefreshJob(db as never, config, JOB_ID, WORKSPACE, LIST_ID);

    const jobFailedUpdate = lastUpdate(updates, asyncJobs);
    expect(jobFailedUpdate?.set).toMatchObject({ status: "failed", errorMessage: "smart_list_not_found" });
    expect(inserts).toHaveLength(0);
    expect(runSmartListQueryWithFallback).not.toHaveBeenCalled();
  });

  it("computes the added/dropped diff and scores only newly-added prospects on success", async () => {
    vi.mocked(runSmartListQueryWithFallback).mockResolvedValue({
      hits: [doc("A"), doc("C")],
      total: 2,
      demo: false,
    });
    runCorpusScore.mockResolvedValue({ scored: 1, skipped: 0, results: [], creditsUsed: 2 });

    const previousMembers = [
      { smartListId: LIST_ID, prospectId: "A", snapshot: { prospectId: "A", fullName: "Prospect A" }, addedAt: new Date() },
      { smartListId: LIST_ID, prospectId: "B", snapshot: { prospectId: "B", fullName: "Prospect B" }, addedAt: new Date() },
    ];
    const { db, inserts, updates, deletes } = createMockDb({ list: baseList(), previousMembers });

    await runSmartListRefreshJob(db as never, config, JOB_ID, WORKSPACE, LIST_ID);

    // Only the newly-added prospect (C) is scored — A was already a member.
    expect(runCorpusScore).toHaveBeenCalledTimes(1);
    expect(runCorpusScore).toHaveBeenCalledWith(WORKSPACE, [{ prospectId: "C", companyDomain: "acme.com" }]);

    // Membership replaced wholesale: dropped B, added C (kept A).
    expect(deletes.some((d) => d.table === smartListMembers)).toBe(true);
    const memberInsert = inserts.find((i) => i.table === smartListMembers);
    expect(memberInsert?.values).toEqual([
      expect.objectContaining({ prospectId: "A" }),
      expect.objectContaining({ prospectId: "C" }),
    ]);

    const listUpdate = updates.find((u) => u.table === smartLists);
    expect(listUpdate?.set).toMatchObject({ lastRunCount: 2 });

    const refreshInsert = inserts.find((i) => i.table === smartListRefreshes);
    expect(refreshInsert?.values).toMatchObject({
      status: "completed",
      matchedCount: 2,
      addedCount: 1,
      droppedCount: 1,
      creditsCharged: 2,
    });

    const jobUpdate = lastUpdate(updates, asyncJobs);
    expect(jobUpdate?.set).toMatchObject({ status: "completed" });

    expect(invalidateSmartList).toHaveBeenCalledWith(WORKSPACE, LIST_ID);
  });

  it("attaches a matchReason to added/dropped entries explaining which filters moved them", async () => {
    vi.mocked(runSmartListQueryWithFallback).mockResolvedValue({
      hits: [doc("A"), doc("C")],
      total: 2,
      demo: false,
    });
    runCorpusScore.mockResolvedValue({ scored: 1, skipped: 0, results: [], creditsUsed: 2 });

    const previousMembers = [
      { smartListId: LIST_ID, prospectId: "A", snapshot: { prospectId: "A", fullName: "Prospect A" }, addedAt: new Date() },
      { smartListId: LIST_ID, prospectId: "B", snapshot: { prospectId: "B", fullName: "Prospect B" }, addedAt: new Date() },
    ];
    const list = baseList({ filters: { industry: "SaaS", contactSignals: ["recent_funding"] } });
    const { db, inserts } = createMockDb({ list, previousMembers });

    await runSmartListRefreshJob(db as never, config, JOB_ID, WORKSPACE, LIST_ID);

    const refreshInsert = inserts.find((i) => i.table === smartListRefreshes);
    const values = refreshInsert?.values as {
      addedProspects: { prospectId: string; matchReason?: string }[];
      droppedProspects: { prospectId: string; matchReason?: string }[];
    };

    expect(values.addedProspects[0]?.matchReason).toBe("Now matches: industry: SaaS · contact signals: recent_funding");
    expect(values.droppedProspects[0]?.matchReason).toBe(
      "No longer matches: industry: SaaS · contact signals: recent_funding"
    );
  });

  it("skips the refresh and leaves membership untouched when credits are insufficient", async () => {
    vi.mocked(runSmartListQueryWithFallback).mockResolvedValue({
      hits: [doc("A"), doc("C")],
      total: 2,
      demo: false,
    });
    runCorpusScore.mockRejectedValue(new InsufficientCreditsError(4, 1));

    const previousMembers = [
      { smartListId: LIST_ID, prospectId: "A", snapshot: {}, addedAt: new Date() },
      { smartListId: LIST_ID, prospectId: "B", snapshot: {}, addedAt: new Date() },
    ];
    const { db, inserts, updates, deletes } = createMockDb({ list: baseList(), previousMembers });

    await runSmartListRefreshJob(db as never, config, JOB_ID, WORKSPACE, LIST_ID);

    // Membership must NOT be replaced — refresh was skipped entirely, not partially applied.
    expect(deletes.some((d) => d.table === smartListMembers)).toBe(false);
    expect(inserts.some((i) => i.table === smartListMembers)).toBe(false);

    const refreshInsert = inserts.find((i) => i.table === smartListRefreshes);
    expect(refreshInsert?.values).toMatchObject({
      status: "skipped_insufficient_credits",
      requiredCredits: 4,
      availableCredits: 1,
      creditsCharged: 0,
      matchedCount: 2,
      addedCount: 1,
      droppedCount: 1,
    });

    // lastRunCount/lastRefreshedAt must NOT be touched, but nextRefreshAt still advances
    // so the sweep doesn't retry this list every cycle.
    const listUpdate = updates.find((u) => u.table === smartLists);
    expect(listUpdate?.set).not.toHaveProperty("lastRunCount");
    expect(listUpdate?.set).toHaveProperty("nextRefreshAt");

    const jobUpdate = lastUpdate(updates, asyncJobs);
    expect(jobUpdate?.set).toMatchObject({ status: "completed" });
    expect((jobUpdate?.set as { result: { skipped: boolean } }).result.skipped).toBe(true);
  });

  it("records a failed refresh, still advances nextRefreshAt, and rethrows on unexpected errors", async () => {
    vi.mocked(runSmartListQueryWithFallback).mockRejectedValue(new Error("opensearch exploded"));

    const { db, inserts, updates } = createMockDb({ list: baseList(), previousMembers: [] });

    await expect(runSmartListRefreshJob(db as never, config, JOB_ID, WORKSPACE, LIST_ID)).rejects.toThrow(
      "opensearch exploded"
    );

    const refreshInsert = inserts.find((i) => i.table === smartListRefreshes);
    expect(refreshInsert?.values).toMatchObject({ status: "failed", errorMessage: "opensearch exploded" });

    const listUpdate = updates.find((u) => u.table === smartLists);
    expect(listUpdate?.set).toHaveProperty("nextRefreshAt");

    const jobUpdate = lastUpdate(updates, asyncJobs);
    expect(jobUpdate?.set).toMatchObject({ status: "failed", errorMessage: "opensearch exploded" });
  });
});

describe("runSmartListRefreshJob — correctness fixes", () => {
  const twoMembers = () => [
    { smartListId: LIST_ID, prospectId: "A", snapshot: { prospectId: "A", fullName: "Prospect A" }, addedAt: new Date() },
    { smartListId: LIST_ID, prospectId: "B", snapshot: { prospectId: "B", fullName: "Prospect B" }, addedAt: new Date() },
  ];

  it("in production, refuses to refresh on demo data and records a failed refresh instead", async () => {
    vi.mocked(runSmartListQueryWithFallback).mockResolvedValue({ hits: [doc("Z")], total: 1, demo: true });
    const { db, inserts } = createMockDb({ list: baseList(), previousMembers: twoMembers() });
    const prodConfig = { OPENSEARCH_URL: "http://os.test", NODE_ENV: "production" } as never;

    await expect(runSmartListRefreshJob(db as never, prodConfig, JOB_ID, WORKSPACE, LIST_ID)).rejects.toThrow(/demo/i);

    expect(runCorpusScore).not.toHaveBeenCalled();
    expect(inserts.find((i) => i.table === smartListMembers)).toBeUndefined();
    expect(inserts.find((i) => i.table === smartListRefreshes)?.values).toMatchObject({ status: "failed" });
  });

  it("stores the true number of matches, not just the hits kept", async () => {
    vi.mocked(runSmartListQueryWithFallback).mockResolvedValue({ hits: [doc("A"), doc("C")], total: 4200, demo: false });
    runCorpusScore.mockResolvedValue({ scored: 1, skipped: 0, results: [], creditsUsed: 0 });
    const { db, updates, inserts } = createMockDb({ list: baseList(), previousMembers: twoMembers() });

    await runSmartListRefreshJob(db as never, config, JOB_ID, WORKSPACE, LIST_ID);

    expect(updates.find((u) => u.table === smartLists)?.set).toMatchObject({ lastRunCount: 4200 });
    expect(inserts.find((i) => i.table === smartListRefreshes)?.values).toMatchObject({ matchedCount: 4200 });
  });

  it("does not report a member as dropped when it still matches but was past the 1,000-hit cap", async () => {
    vi.mocked(runSmartListQueryWithFallback).mockResolvedValue({ hits: [doc("A"), doc("C")], total: 4200, demo: false });
    vi.mocked(prospectIdsStillMatching).mockResolvedValue(new Set(["B"]));
    runCorpusScore.mockResolvedValue({ scored: 1, skipped: 0, results: [], creditsUsed: 0 });
    const { db, inserts } = createMockDb({ list: baseList(), previousMembers: twoMembers() });

    await runSmartListRefreshJob(db as never, config, JOB_ID, WORKSPACE, LIST_ID);

    expect(prospectIdsStillMatching).toHaveBeenCalledWith(expect.anything(), expect.anything(), ["B"]);
    const refresh = inserts.find((i) => i.table === smartListRefreshes)?.values as { droppedCount: number };
    expect(refresh.droppedCount).toBe(0);
    const members = inserts.find((i) => i.table === smartListMembers)?.values as { prospectId: string }[];
    expect(members.map((m) => m.prospectId).sort()).toEqual(["A", "B", "C"]);
  });

  it("only checks past-the-cap members when the list actually exceeded the cap", async () => {
    vi.mocked(runSmartListQueryWithFallback).mockResolvedValue({ hits: [doc("A"), doc("C")], total: 2, demo: false });
    runCorpusScore.mockResolvedValue({ scored: 1, skipped: 0, results: [], creditsUsed: 0 });
    const { db, inserts } = createMockDb({ list: baseList(), previousMembers: twoMembers() });

    await runSmartListRefreshJob(db as never, config, JOB_ID, WORKSPACE, LIST_ID);

    expect(prospectIdsStillMatching).not.toHaveBeenCalled();
    expect(inserts.find((i) => i.table === smartListRefreshes)?.values).toMatchObject({ droppedCount: 1 });
  });

  it("refreshes with filters resolved to stored values (\"India\" also matches \"IN\")", async () => {
    vi.mocked(runSmartListQueryWithFallback).mockResolvedValue({ hits: [], total: 0, demo: false });
    const { db } = createMockDb({ list: baseList({ filters: { country: "India", seniority: "VP" } }), previousMembers: [] });

    await runSmartListRefreshJob(db as never, config, JOB_ID, WORKSPACE, LIST_ID);

    expect(runSmartListQueryWithFallback).toHaveBeenCalledWith(
      expect.anything(),
      { countries: ["IN", "IND", "India"], seniorities: ["vp"] }
    );
  });
});
