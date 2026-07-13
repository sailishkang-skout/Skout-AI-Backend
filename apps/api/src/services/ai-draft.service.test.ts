import { describe, expect, it, vi, beforeEach } from "vitest";
import { AiDraftService } from "./ai-draft.service.js";
import { HttpError } from "../utils/http.js";

function chain(result: unknown) {
  const c: Record<string, ReturnType<typeof vi.fn>> = {};
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

  it("rejects approving an already approved draft", async () => {
    const db = makeDb({});
    db.select = vi.fn(() => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {};
      c.from = vi.fn().mockReturnValue(c);
      c.where = vi.fn().mockReturnValue(c);
      c.limit = vi.fn().mockResolvedValue([{ ...baseDraft, status: "approved" }]);
      return c;
    });
    const svc = new AiDraftService(db);
    await expect(svc.approve("ws-1", baseDraft.id)).rejects.toBeInstanceOf(HttpError);
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
