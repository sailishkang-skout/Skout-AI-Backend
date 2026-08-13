import { describe, expect, it, vi, beforeEach } from "vitest";
import { AiDraftService } from "./ai-draft.service.js";
import { HttpError } from "../utils/http.js";

function chain(result: unknown) {
  const c: Record<string, ReturnType<typeof vi.fn> | undefined> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.leftJoin = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockReturnValue(c);
  c.limit = vi.fn().mockReturnValue(c);
  c.offset = vi.fn().mockResolvedValue(result);
  c.returning = vi.fn().mockResolvedValue(Array.isArray(result) ? result : [result]);
  // terminal for count queries
  c.then = undefined;
  return c;
}

function makeDb(handlers: {
  select?: Array<unknown>;
  insert?: unknown;
  update?: unknown[];
}) {
  const selectResults = [...(handlers.select ?? [])];
  const db = {
    select: vi.fn(() => {
      const next = selectResults.shift() ?? [];
      const c = chain(next);
      // count() path resolves via await on where()
      c.where = vi.fn().mockImplementation(() => {
        if (Array.isArray(next) && next[0] && typeof next[0] === "object" && "value" in (next[0] as object)) {
          return Promise.resolve(next);
        }
        return c;
      });
      c.offset = vi.fn().mockResolvedValue(Array.isArray(next) ? next : [next]);
      c.limit = vi.fn().mockReturnValue(c);
      return c;
    }),
    insert: vi.fn(() => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {};
      c.values = vi.fn().mockReturnValue(c);
      c.returning = vi.fn().mockResolvedValue([handlers.insert]);
      return c;
    }),
    update: vi.fn(() => {
      const updates = [...(handlers.update ?? [])];
      const c: Record<string, ReturnType<typeof vi.fn>> = {};
      c.set = vi.fn().mockReturnValue(c);
      c.where = vi.fn().mockReturnValue(c);
      c.returning = vi.fn().mockResolvedValue(updates.length ? [updates.shift()] : []);
      return c;
    }),
  };
  return db as any;
}

const baseDraft = {
  id: "11111111-1111-1111-1111-111111111111",
  workspaceId: "ws-1",
  prospectId: "p-1",
  threadId: null,
  enrollmentStepId: null,
  subject: "Hello",
  body: "Body text",
  status: "pending_review",
  model: "openai/gpt-4o-mini",
  confidenceScore: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  reviewedAt: null,
  reviewedBy: null,
};

describe("AiDraftService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists drafts with total", async () => {
    const db = makeDb({
      select: [[{ value: 1 }], [{ ...baseDraft, prospectName: "Ada", prospectTitle: "VP", companyName: "Acme", icpScore: 82 }]],
    });
    const svc = new AiDraftService(db);
    const result = await svc.list("ws-1", { status: "pending_review" });
    expect(result.total).toBe(1);
    expect(result.data[0]?.prospectName).toBe("Ada");
    expect(result.data[0]?.icpScore).toBe(82);
  });

  it("creates a pending_review draft", async () => {
    const db = makeDb({ insert: baseDraft });
    const svc = new AiDraftService(db);
    const row = await svc.create("ws-1", {
      prospectId: "p-1",
      subject: "Hello",
      body: "Body text",
      model: "openai/gpt-4o-mini",
    });
    expect(row.status).toBe("pending_review");
    expect(db.insert).toHaveBeenCalled();
  });

  describe("R13.2 auto-approve on create", () => {
    /** Queue-based select mock: each `.select().from().where().limit()` call resolves the next
     * entry of `results` in order — settings, then icpScore, then (if reached) always-review list. */
    function makeAutoApproveDb(results: unknown[][], insertRow: unknown) {
      let i = 0;
      return {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve(results[i++] ?? [])),
            })),
          })),
        })),
        insert: vi.fn(() => ({
          values: vi.fn((values: unknown) => ({
            returning: vi.fn().mockResolvedValue([{ ...(insertRow as object), ...(values as object) }]),
          })),
        })),
      } as any;
    }

    it("auto-approves when settings are enabled and the draft clears both thresholds", async () => {
      const db = makeAutoApproveDb(
        [
          [{ workspaceId: "ws-1", enabled: true, minIcpScore: 80, minConfidence: 0.9, alwaysReviewListIds: [], updatedBy: null, updatedAt: new Date() }],
          [{ score: 90 }],
        ],
        baseDraft
      );
      const svc = new AiDraftService(db);
      const row = await svc.create("ws-1", {
        prospectId: "p-1",
        subject: "Hello",
        body: "Body text",
        confidenceScore: 0.95,
      });
      expect(row.status).toBe("approved");
      expect(row.autoApproved).toBe(true);
    });

    it("stays pending_review when auto-approve settings are disabled", async () => {
      const db = makeAutoApproveDb(
        [[{ workspaceId: "ws-1", enabled: false, minIcpScore: null, minConfidence: null, alwaysReviewListIds: [], updatedBy: null, updatedAt: new Date() }]],
        baseDraft
      );
      const svc = new AiDraftService(db);
      const row = await svc.create("ws-1", { prospectId: "p-1", subject: "Hello", body: "Body text" });
      expect(row.status).toBe("pending_review");
      expect(row.autoApproved).toBe(false);
    });

    it("stays pending_review when the prospect is on an always-review list, even above threshold", async () => {
      const db = makeAutoApproveDb(
        [
          [{ workspaceId: "ws-1", enabled: true, minIcpScore: 80, minConfidence: 0.9, alwaysReviewListIds: ["list-1"], updatedBy: null, updatedAt: new Date() }],
          [{ score: 95 }],
          [{ listId: "list-1" }],
        ],
        baseDraft
      );
      const svc = new AiDraftService(db);
      const row = await svc.create("ws-1", {
        prospectId: "p-1",
        subject: "Hello",
        body: "Body text",
        confidenceScore: 0.99,
      });
      expect(row.status).toBe("pending_review");
      expect(row.autoApproved).toBe(false);
    });

    it("skips auto-approve entirely when the caller opts out (skipAutoApprove)", async () => {
      const db = makeAutoApproveDb([], baseDraft);
      const svc = new AiDraftService(db);
      const row = await svc.create("ws-1", {
        prospectId: "p-1",
        subject: "Hello",
        body: "Body text",
        skipAutoApprove: true,
      });
      expect(row.status).toBe("pending_review");
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  it("approves a reviewable draft", async () => {
    const approved = { ...baseDraft, status: "approved", reviewedAt: new Date(), reviewedBy: "u-1" };
    const db = makeDb({
      select: [[baseDraft]],
      update: [approved],
    });
    // requireDraft uses select().from().where().limit()
    db.select = vi.fn(() => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {};
      c.from = vi.fn().mockReturnValue(c);
      c.where = vi.fn().mockReturnValue(c);
      c.limit = vi.fn().mockResolvedValue([baseDraft]);
      return c;
    });
    db.update = vi.fn(() => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {};
      c.set = vi.fn().mockReturnValue(c);
      c.where = vi.fn().mockReturnValue(c);
      c.returning = vi.fn().mockResolvedValue([approved]);
      return c;
    });

    const svc = new AiDraftService(db);
    const row = await svc.approve("ws-1", baseDraft.id, "u-1");
    expect(row.status).toBe("approved");
    expect(row.reviewedBy).toBe("u-1");
  });

  it("returns an already approved draft without error (idempotent for retry send)", async () => {
    const db = makeDb({});
    db.select = vi.fn(() => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {};
      c.from = vi.fn().mockReturnValue(c);
      c.where = vi.fn().mockReturnValue(c);
      c.limit = vi.fn().mockResolvedValue([{ ...baseDraft, status: "approved" }]);
      return c;
    });
    const svc = new AiDraftService(db);
    const row = await svc.approve("ws-1", baseDraft.id);
    expect(row.status).toBe("approved");
  });

  it("bulk-approves matching reviewable ids", async () => {
    const db = makeDb({});
    db.update = vi.fn(() => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {};
      c.set = vi.fn().mockReturnValue(c);
      c.where = vi.fn().mockReturnValue(c);
      c.returning = vi.fn().mockResolvedValue([{ id: baseDraft.id }]);
      return c;
    });
    const svc = new AiDraftService(db);
    const result = await svc.bulkApprove("ws-1", [baseDraft.id, baseDraft.id], "u-1");
    expect(result.approved).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("marks edits as edited status", async () => {
    const edited = { ...baseDraft, subject: "New", status: "edited" };
    const db = makeDb({});
    db.select = vi.fn(() => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {};
      c.from = vi.fn().mockReturnValue(c);
      c.where = vi.fn().mockReturnValue(c);
      c.limit = vi.fn().mockResolvedValue([baseDraft]);
      return c;
    });
    db.update = vi.fn(() => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {};
      c.set = vi.fn().mockReturnValue(c);
      c.where = vi.fn().mockReturnValue(c);
      c.returning = vi.fn().mockResolvedValue([edited]);
      return c;
    });
    const svc = new AiDraftService(db);
    const row = await svc.update("ws-1", baseDraft.id, { subject: "New" }, "u-1");
    expect(row.status).toBe("edited");
    expect(row.subject).toBe("New");
  });
});
