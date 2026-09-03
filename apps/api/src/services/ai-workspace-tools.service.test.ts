import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceToolRunner,
  evidenceClaim,
  requiresConfirmation,
  type ActionPreview,
} from "./ai-workspace-tools.service.js";
import type { Env } from "../config/env.js";
import type { Db } from "@skout/db";
import { recordEvidence, schema } from "@skout/db";
import { and, eq } from "drizzle-orm";

vi.mock("@skout/db", async () => {
  const actual = await vi.importActual<typeof import("@skout/db")>("@skout/db");
  return { ...actual, recordEvidence: vi.fn() };
});

const CONFIG = {} as Env;
const { listMembers, lists } = schema;

/**
 * Fake db exposing just the select().from().innerJoin().where() chain the enroll_list preview
 * builder's list_members count query uses (joined through `lists` so the count is
 * workspace-scoped). classifyAndRecord's own db.select(...).where(...).limit(1) call (fired
 * unconditionally afterward whenever db is truthy) hits this same mock too, but its `.where`
 * call throws on the resolved chain (this mock's `.from()` return value only exposes
 * `innerJoin`) and is swallowed by run()'s own try/catch around the classifyAndRecord call — it
 * never reaches the preview computation these tests assert on.
 */
function makeListMembersCountDb(rows: { count: number }[]) {
  const whereFn = vi.fn().mockResolvedValue(rows);
  const innerJoinFn = vi.fn().mockReturnValue({ where: whereFn });
  const fromFn = vi.fn().mockReturnValue({ innerJoin: innerJoinFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  const db = { select: selectFn } as unknown as Db;
  return { db, selectFn, fromFn, innerJoinFn, whereFn };
}

describe("requiresConfirmation", () => {
  const base: ActionPreview = {
    toolName: "x",
    scope: "does x",
    assumptions: [],
    affectedRecordCount: 1,
    creditCost: 0,
    externalSideEffects: [],
  };

  it("is false when affectedRecordCount<=1, creditCost=0, no side effects", () => {
    expect(requiresConfirmation(base)).toBe(false);
  });

  it("is true when affectedRecordCount > 1", () => {
    expect(requiresConfirmation({ ...base, affectedRecordCount: 2 })).toBe(true);
  });

  it("is true when creditCost > 0", () => {
    expect(requiresConfirmation({ ...base, creditCost: 1 })).toBe(true);
  });

  it("is true when externalSideEffects is non-empty", () => {
    expect(requiresConfirmation({ ...base, externalSideEffects: ["sends an email"] })).toBe(true);
  });
});

describe("createWorkspaceToolRunner — create_outbound_sequence preview gate", () => {
  it("returns a preview instead of executing when the sequence has more than one step and confirmed is not set", async () => {
    const runner = createWorkspaceToolRunner(null, CONFIG, "ws-1", false, "skout");
    const raw = await runner.run("create_outbound_sequence", {
      name: "Test Seq",
      steps: [
        { stepType: "email", delayDays: 0 },
        { stepType: "email", delayDays: 3 },
      ],
    });
    const parsed = JSON.parse(raw as string);
    expect(parsed.preview).toBeDefined();
    expect(parsed.preview.toolName).toBe("create_outbound_sequence");
    expect(parsed.preview.affectedRecordCount).toBe(2);
    // Finding 1: the gated response also carries explicit guidance so the model relays the
    // preview and stops instead of self-confirming within the same turn.
    expect(parsed.requiresConfirmation).toBe(true);
    expect(typeof parsed.nextStep).toBe("string");
    expect(parsed.nextStep.length).toBeGreaterThan(0);
  });

  it("executes when confirmed is true, even with multiple steps", async () => {
    const runner = createWorkspaceToolRunner(null, CONFIG, "ws-1", false, "skout");
    const raw = await runner.run("create_outbound_sequence", {
      name: "Test Seq",
      steps: [
        { stepType: "email", delayDays: 0 },
        { stepType: "email", delayDays: 3 },
      ],
      confirmed: true,
    });
    const parsed = JSON.parse(raw as string);
    // db is null, so the real handler throws "database_unavailable" -- proves execution was
    // actually attempted (not gated), which is what this test checks for.
    expect(parsed.error).toBe("database_unavailable");
  });

  it("executes immediately for a single-step sequence with no confirmed flag (requiresConfirmation is false)", async () => {
    const runner = createWorkspaceToolRunner(null, CONFIG, "ws-1", false, "skout");
    const raw = await runner.run("create_outbound_sequence", {
      name: "Test Seq",
      steps: [{ stepType: "email", delayDays: 0 }],
    });
    const parsed = JSON.parse(raw as string);
    expect(parsed.preview).toBeUndefined();
    expect(parsed.error).toBe("database_unavailable");
  });
});

describe("createWorkspaceToolRunner — enroll_list preview gate", () => {
  it("returns error for missing listId/sequenceId without needing a preview", async () => {
    const runner = createWorkspaceToolRunner(null, CONFIG, "ws-1", false, "skout");
    const raw = await runner.run("enroll_list", {});
    const parsed = JSON.parse(raw as string);
    expect(parsed.preview).toBeDefined();
    expect(parsed.preview.affectedRecordCount).toBe(0);
    // affectedRecordCount=0 with no side effects and no credit cost would normally skip
    // confirmation, but externalSideEffects is always non-empty for enroll_list, so it always
    // requires confirmation regardless of count -- this is intentional (it always enqueues jobs
    // and dispatches webhooks even for 0 new enrollments in the general case).
  });

  it("queries the real list_members count for the given listId and surfaces it as affectedRecordCount", async () => {
    const { db, fromFn, whereFn } = makeListMembersCountDb([{ count: 3 }]);
    const runner = createWorkspaceToolRunner(db, CONFIG, "ws-1", false, "skout");
    const raw = await runner.run("enroll_list", { listId: "list-1", sequenceId: "seq-1" });
    const parsed = JSON.parse(raw as string);
    expect(parsed.preview).toBeDefined();
    // Proves the query actually executed and its row was parsed -- not the {}-args fallback.
    expect(parsed.preview.affectedRecordCount).toBe(3);
    expect(fromFn).toHaveBeenCalledWith(listMembers);
    expect(whereFn).toHaveBeenCalled();
  });

  it("does not run the count query when listId is missing, even with a real db (falls back to 0)", async () => {
    const { db, fromFn } = makeListMembersCountDb([{ count: 7 }]);
    const runner = createWorkspaceToolRunner(db, CONFIG, "ws-1", false, "skout");
    const raw = await runner.run("enroll_list", { sequenceId: "seq-1" });
    const parsed = JSON.parse(raw as string);
    // If the listMembers query had run against this mock it would have returned 7, not 0 --
    // proves the `db && listId` guard actually skipped the query rather than the query itself
    // returning empty.
    expect(parsed.preview.affectedRecordCount).toBe(0);
    expect(fromFn).not.toHaveBeenCalledWith(listMembers);
  });

  // Finding 4 regression test: the count query used to be a bare
  // `where(eq(listMembers.listId, listId))` with no ownership check at all -- a listId from a
  // DIFFERENT workspace would return that other workspace's real member count in the preview.
  // The fix joins through `lists` and additionally filters on `lists.workspaceId`, so a foreign
  // listId now matches zero rows (no lists row satisfies both the id AND this workspaceId), not
  // the leaked real count. Asserting the exact join/where arguments (rather than just the
  // resulting number) proves the workspace scoping is actually wired into the query, not just
  // that the query happens to produce the right output for this fixture.
  it("scopes the preview count through a join on `lists` filtered by the calling workspace (Finding 4 — cross-tenant leak fix)", async () => {
    const { db, fromFn, innerJoinFn, whereFn } = makeListMembersCountDb([{ count: 3 }]);
    const runner = createWorkspaceToolRunner(db, CONFIG, "ws-1", false, "skout");
    await runner.run("enroll_list", { listId: "list-1", sequenceId: "seq-1" });

    expect(fromFn).toHaveBeenCalledWith(listMembers);
    expect(innerJoinFn).toHaveBeenCalledWith(lists, eq(lists.id, listMembers.listId));
    expect(whereFn).toHaveBeenCalledWith(
      and(eq(lists.workspaceId, "ws-1"), eq(listMembers.listId, "list-1"))
    );
  });

  it("returns affectedRecordCount 0 (not a leaked count) when the join/filter matches no rows, as happens for a foreign-workspace listId", async () => {
    // A listId belonging to a different workspace never satisfies `lists.workspaceId = ws-1` in
    // the join, so the real query returns zero rows -- simulated here directly by the mock
    // resolving an empty array instead of a real row with the other workspace's count.
    const { db } = makeListMembersCountDb([]);
    const runner = createWorkspaceToolRunner(db, CONFIG, "ws-1", false, "skout");
    const raw = await runner.run("enroll_list", { listId: "foreign-list", sequenceId: "seq-1" });
    const parsed = JSON.parse(raw as string);
    expect(parsed.preview.affectedRecordCount).toBe(0);
  });
});

describe("createWorkspaceToolRunner — preview builder failure isolation (Finding 1)", () => {
  it("returns a serialized error instead of throwing/rejecting when the preview builder itself throws", async () => {
    // A db whose select().from().innerJoin().where() chain rejects, simulating a transient DB
    // error inside enroll_list's preview count query. Before the fix, this throw propagated out
    // of run() entirely (previewBuilder was awaited outside any try/catch); after the fix it
    // must be caught and surfaced the same way handler errors are: serialize({ error: message }).
    const boom = new Error("connection reset");
    const whereFn = vi.fn().mockRejectedValue(boom);
    const innerJoinFn = vi.fn().mockReturnValue({ where: whereFn });
    const fromFn = vi.fn().mockReturnValue({ innerJoin: innerJoinFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Db;

    const runner = createWorkspaceToolRunner(db, CONFIG, "ws-1", false, "skout");

    // run() must resolve (not reject) with a normal serialized-error string.
    await expect(
      runner.run("enroll_list", { listId: "list-1", sequenceId: "seq-1" })
    ).resolves.toEqual(expect.any(String));

    const raw = await runner.run("enroll_list", { listId: "list-1", sequenceId: "seq-1" });
    const parsed = JSON.parse(raw as string);
    expect(parsed).toEqual({ error: "connection reset" });
  });
});

describe("createWorkspaceToolRunner — enroll_list actor guard (Finding 5)", () => {
  it("returns {error: 'actor_unknown'} and never calls enrollListWithSideEffects when userId is absent", async () => {
    const sequenceServiceModule = await import("./sequence.service.js");
    const enrollSpy = vi.spyOn(sequenceServiceModule, "enrollListWithSideEffects");

    // A real (mocked) db so the preview builder's own count query succeeds -- this test is about
    // the actor guard in the handler, not the preview gate, so confirmed:true is passed to reach
    // the handler at all.
    const { db } = makeListMembersCountDb([{ count: 1 }]);
    // No userId passed to createWorkspaceToolRunner (the 6th arg, optional).
    const runner = createWorkspaceToolRunner(db, CONFIG, "ws-1", false, "skout");
    const raw = await runner.run("enroll_list", {
      listId: "list-1",
      sequenceId: "seq-1",
      confirmed: true,
    });
    const parsed = JSON.parse(raw as string);

    expect(parsed).toEqual({ error: "actor_unknown" });
    expect(enrollSpy).not.toHaveBeenCalled();

    enrollSpy.mockRestore();
  });
});

describe("evidenceClaim", () => {
  it("records evidence with the given entityType/entityId/attribute/source, and returns the value wrapped with the new evidenceId", async () => {
    vi.mocked(recordEvidence).mockResolvedValue({ id: "ev-1" } as never);
    const fakeDb = {} as Db;

    const result = await evidenceClaim(fakeDb, "ws-1", "get_market_tam", "country_industry_tam", "US:51", {
      tam: 1_000_000,
    });

    expect(recordEvidence).toHaveBeenCalledWith(fakeDb, {
      workspaceId: "ws-1",
      entityType: "country_industry_tam",
      entityId: "US:51",
      attribute: "get_market_tam",
      value: { tam: 1_000_000 },
      source: "ai-workspace-tools:get_market_tam",
      observedAt: expect.any(Date),
      confidence: 100,
    });
    expect(result).toEqual({ value: { tam: 1_000_000 }, evidenceId: "ev-1" });
  });
});

describe("createWorkspaceToolRunner — get_workspace_overview evidence wiring", () => {
  it("wraps dashboard.getSummary's result through evidenceClaim before returning it, when db is available", async () => {
    vi.mocked(recordEvidence).mockResolvedValue({ id: "ev-2" } as never);
    const summaryFixture = { prospectCount: 42 };
    const dashboardModule = await import("./dashboard.service.js");
    vi.spyOn(dashboardModule, "createDashboardService").mockReturnValue({
      getSummary: vi.fn().mockResolvedValue(summaryFixture),
    } as unknown as ReturnType<typeof dashboardModule.createDashboardService>);

    const fakeDb = {} as Db;
    const runner = createWorkspaceToolRunner(fakeDb, CONFIG, "ws-1", false, "skout");
    const raw = await runner.run("get_workspace_overview", {});
    const parsed = JSON.parse(raw as string);

    expect(recordEvidence).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        workspaceId: "ws-1",
        entityType: "workspace",
        entityId: "ws-1",
        attribute: "get_workspace_overview",
        source: "ai-workspace-tools:get_workspace_overview",
        confidence: 100,
      })
    );
    expect(parsed.evidenceId).toBe("ev-2");
    expect(parsed.value).toEqual(summaryFixture);
  });

  // §6.1 anti-hallucination contract: when db is unavailable, get_workspace_overview must fail
  // loud (never silently degrade to an unevidenced/unattributed response) -- same as the other
  // six evidence-converged tools. The `!db` guard must throw before evidenceClaim/recordEvidence
  // is ever reached, so this also proves recordEvidence's call count doesn't increase.
  it("fails loud with database_unavailable when db is null, never reaching evidenceClaim/recordEvidence", async () => {
    vi.mocked(recordEvidence).mockClear();
    const runner = createWorkspaceToolRunner(null, CONFIG, "ws-1", false, "skout");
    const raw = await runner.run("get_workspace_overview", {});
    const parsed = JSON.parse(raw as string);

    expect(parsed).toEqual({ error: "database_unavailable" });
    expect(recordEvidence).not.toHaveBeenCalled();
  });
});

describe("assertEvidenced regression guard", () => {
  it("throws UnevidencedClaimError when a claim has neither evidenceId nor unverified set", async () => {
    const { assertEvidenced, UnevidencedClaimError } = await import("@skout/shared");
    expect(() => assertEvidenced({ value: "x" }, "test")).toThrow(UnevidencedClaimError);
  });
});
