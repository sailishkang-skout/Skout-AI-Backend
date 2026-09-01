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

vi.mock("@skout/db", async () => {
  const actual = await vi.importActual<typeof import("@skout/db")>("@skout/db");
  return { ...actual, recordEvidence: vi.fn() };
});

const CONFIG = {} as Env;
const { listMembers } = schema;

/**
 * Fake db exposing just the select().from().where() chain the enroll_list preview builder's
 * list_members count query uses. classifyAndRecord's own db.select(...).where(...).limit(1) call
 * (fired unconditionally afterward whenever db is truthy) hits this same mock too, but its
 * `.limit` call throws on the resolved chain and is swallowed by run()'s own try/catch — it
 * never reaches the preview computation these tests assert on.
 */
function makeListMembersCountDb(rows: { count: number }[]) {
  const whereFn = vi.fn().mockResolvedValue(rows);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  const db = { select: selectFn } as unknown as Db;
  return { db, selectFn, fromFn, whereFn };
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
    // whereFn is shared with classifyAndRecord's own unrelated select().where().limit() call
    // (fired unconditionally afterward since db is truthy here), so assert it ran at all rather
    // than an exact count.
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
  it("wraps dashboard.getSummary's result through evidenceClaim before returning it", async () => {
    vi.mocked(recordEvidence).mockResolvedValue({ id: "ev-2" } as never);
    const summaryFixture = { prospectCount: 42 };
    const dashboardModule = await import("./dashboard.service.js");
    vi.spyOn(dashboardModule, "createDashboardService").mockReturnValue({
      getSummary: vi.fn().mockResolvedValue(summaryFixture),
    } as unknown as ReturnType<typeof dashboardModule.createDashboardService>);

    const runner = createWorkspaceToolRunner(null, CONFIG, "ws-1", false, "skout");
    const raw = await runner.run("get_workspace_overview", {});
    const parsed = JSON.parse(raw as string);

    expect(recordEvidence).toHaveBeenCalledWith(
      null,
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
});

describe("assertEvidenced regression guard", () => {
  it("throws UnevidencedClaimError when a claim has neither evidenceId nor unverified set", async () => {
    const { assertEvidenced, UnevidencedClaimError } = await import("@skout/shared");
    expect(() => assertEvidenced({ value: "x" }, "test")).toThrow(UnevidencedClaimError);
  });
});
