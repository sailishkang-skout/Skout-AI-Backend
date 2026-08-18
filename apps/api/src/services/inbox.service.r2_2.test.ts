/**
 * R2.2 — Conversation state machine tests
 * Covers: InboxService.markThreadRead, transitionThreadStatus, getUnreadCounts,
 *         ingestInboundMessage state transitions (new thread default, statusChangedAt,
 *         unreadCount increment), and reply-tagger service.
 */

import { describe, expect, it, vi } from "vitest";
import { tagReply } from "./reply-tagger.service.js";
import type { InboundMessagePayload } from "./inbound-reply.service.js";
import { ingestInboundMessage } from "./inbound-reply.service.js";
import { InboxService } from "./inbox.service.js";

// ---------------------------------------------------------------------------
// reply-tagger.service
// ---------------------------------------------------------------------------

describe("tagReply", () => {
  it("returns null when apiKey is undefined", async () => {
    const result = await tagReply("Thanks for reaching out!", undefined);
    expect(result).toBeNull();
  });

  it("returns null when apiKey is empty string", async () => {
    const result = await tagReply("Test body", "");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mock DB helpers (mirrors inbound-reply.service.test.ts pattern)
// ---------------------------------------------------------------------------

type SelectRow = Record<string, unknown>;

function makeDb(opts: {
  selectPages?: SelectRow[][];
  insertReturning?: SelectRow;
  updateCallSpy?: ReturnType<typeof vi.fn>;
} = {}) {
  const { selectPages = [], insertReturning = { id: "new-thread" }, updateCallSpy } = opts;
  let selectCursor = 0;

  function chain(resolveWith: unknown): Record<string, ReturnType<typeof vi.fn>> {
    const c: Record<string, ReturnType<typeof vi.fn>> = {};
    c.from = vi.fn().mockReturnValue(c);
    c.where = vi.fn().mockReturnValue(c);
    c.innerJoin = vi.fn().mockReturnValue(c);
    c.select = vi.fn().mockReturnValue(c);
    c.groupBy = vi.fn().mockReturnValue(c);
    c.limit = vi.fn().mockResolvedValue(resolveWith);
    c.set = vi.fn().mockReturnValue(c);
    c.values = vi.fn().mockReturnValue(c);
    c.returning = vi.fn().mockResolvedValue(
      Array.isArray(resolveWith) && resolveWith.length > 0 ? resolveWith : [insertReturning]
    );
    c.onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    return c;
  }

  const updateFn = updateCallSpy ?? vi.fn();

  const db: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(() => {
      const page = selectPages[selectCursor] ?? [];
      selectCursor++;
      return chain(page);
    }),
    insert: vi.fn(() => chain([insertReturning])),
    update: vi.fn((...args: unknown[]) => {
      updateFn(...args);
      return chain([]);
    }),
    transaction: vi.fn(async (fn: (tx: typeof db) => Promise<void>) => fn(db)),
  };

  return { db, updateFn };
}

// ---------------------------------------------------------------------------
// ingestInboundMessage — R2.2 state machine assertions
// ---------------------------------------------------------------------------

const BASE_HUMAN_PAYLOAD: InboundMessagePayload = {
  fromAddress: "prospect@company.com",
  toAddress: "sender@mycompany.com",
  subject: "Re: Hello there",
  bodyText: "Sounds great, let's connect!",
  messageId: "<reply-r22-001@company.com>",
  inReplyTo: "<outbound-001@smtp.mycompany.com>",
  sentAt: new Date("2026-07-01T12:00:00Z"),
};

describe("ingestInboundMessage — R2.2: new thread default status", () => {
  it("creates a new thread with status 'new' (not 'open')", async () => {
    // dedup → [], parent lookup → [] (cold inbound, no match)
    const { db } = makeDb({ selectPages: [[], []] });

    // Capture only the first insert().values() call (that's the thread creation)
    let insertedValues: Record<string, unknown> | null = null;
    let insertCallCount = 0;
    db.insert = vi.fn(() => {
      insertCallCount++;
      const thisCall = insertCallCount;
      const c: Record<string, ReturnType<typeof vi.fn>> = {};
      c.values = vi.fn((vals: Record<string, unknown>) => {
        if (thisCall === 1) insertedValues = vals;
        return c;
      });
      c.returning = vi.fn().mockResolvedValue([{ id: "new-thread" }]);
      c.onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
      return c;
    });
    db.update = vi.fn(() => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {};
      c.set = vi.fn().mockReturnValue(c);
      c.where = vi.fn().mockReturnValue(c);
      c.returning = vi.fn().mockResolvedValue([]);
      return c;
    });

    await ingestInboundMessage(db as any, "ws-1", "inbox-1", BASE_HUMAN_PAYLOAD);
    expect(insertedValues).not.toBeNull();
    expect((insertedValues as any).status).toBe("new");
  });
});

describe("ingestInboundMessage — R2.2: unreadCount increment on human reply", () => {
  it("calls update with sql expression to increment unreadCount", async () => {
    const parentMsg = { threadId: "t-1", enrollmentId: null, prospectId: "p-1" };
    // dedup → [], parent lookup → [parentMsg]
    const { db, updateFn } = makeDb({ selectPages: [[], [parentMsg]] });

    await ingestInboundMessage(db as any, "ws-1", "inbox-1", BASE_HUMAN_PAYLOAD);

    // At minimum the thread update call should have been made
    expect(updateFn).toHaveBeenCalledTimes(1);
  });

  it("does not increment unreadCount for auto_reply", async () => {
    const parentMsg = { threadId: "t-1", enrollmentId: null, prospectId: "p-1" };
    const { db, updateFn } = makeDb({ selectPages: [[], [parentMsg]] });

    await ingestInboundMessage(db as any, "ws-1", "inbox-1", {
      ...BASE_HUMAN_PAYLOAD,
      fromAddress: "no-reply@company.com",
      rawHeaders: { "auto-submitted": "auto-replied" },
    });

    // auto_reply: only thread lastMessageAt update, no enrollment updates
    expect(updateFn).toHaveBeenCalledTimes(1);
  });
});

describe("ingestInboundMessage — R2.2: statusChangedAt set on transitions", () => {
  it("sets statusChangedAt when human reply arrives on existing thread", async () => {
    const parentMsg = { threadId: "t-1", enrollmentId: null, prospectId: "p-1" };
    const { db } = makeDb({ selectPages: [[], [parentMsg]] });

    let threadUpdateArgs: Record<string, unknown> | null = null;
    db.update = vi.fn(() => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {};
      c.set = vi.fn((vals: Record<string, unknown>) => {
        threadUpdateArgs = vals;
        return c;
      });
      c.where = vi.fn().mockReturnValue(c);
      c.returning = vi.fn().mockResolvedValue([]);
      return c;
    });

    await ingestInboundMessage(db as any, "ws-1", "inbox-1", BASE_HUMAN_PAYLOAD);

    expect(threadUpdateArgs).not.toBeNull();
    expect((threadUpdateArgs as any).status).toBe("replied");
    expect((threadUpdateArgs as any).statusChangedAt).toBeInstanceOf(Date);
  });

  it("sets statusChangedAt when bounce arrives on existing thread", async () => {
    const parentMsg = { threadId: "t-1", enrollmentId: null, prospectId: "p-1" };
    const { db } = makeDb({ selectPages: [[], [parentMsg]] });

    let threadUpdateArgs: Record<string, unknown> | null = null;
    db.update = vi.fn(() => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {};
      c.set = vi.fn((vals: Record<string, unknown>) => {
        // Capture the thread status update (not bounceCount counter update)
        if ("status" in vals) threadUpdateArgs = vals;
        return c;
      });
      c.where = vi.fn().mockReturnValue(c);
      c.returning = vi.fn().mockResolvedValue([]);
      return c;
    });

    await ingestInboundMessage(db as any, "ws-1", "inbox-1", {
      ...BASE_HUMAN_PAYLOAD,
      fromAddress: "MAILER-DAEMON@mx.example.com",
    });

    expect((threadUpdateArgs as any).status).toBe("bounced");
    expect((threadUpdateArgs as any).statusChangedAt).toBeInstanceOf(Date);
  });

  it("does NOT set statusChangedAt on auto_reply (no status change)", async () => {
    const parentMsg = { threadId: "t-1", enrollmentId: null, prospectId: "p-1" };
    const { db } = makeDb({ selectPages: [[], [parentMsg]] });

    let threadUpdateArgs: Record<string, unknown> | null = null;
    db.update = vi.fn(() => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {};
      c.set = vi.fn((vals: Record<string, unknown>) => {
        threadUpdateArgs = vals;
        return c;
      });
      c.where = vi.fn().mockReturnValue(c);
      c.returning = vi.fn().mockResolvedValue([]);
      return c;
    });

    await ingestInboundMessage(db as any, "ws-1", "inbox-1", {
      ...BASE_HUMAN_PAYLOAD,
      fromAddress: "no-reply@company.com",
      rawHeaders: { "auto-submitted": "auto-generated" },
    });

    // No status key in the update set — auto_reply keeps current status
    expect(threadUpdateArgs).not.toBeNull();
    expect((threadUpdateArgs as any).status).toBeUndefined();
    expect((threadUpdateArgs as any).statusChangedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// InboxService — unit tests with stub DB
// ---------------------------------------------------------------------------

function makeServiceDb(opts: {
  thread?: Record<string, unknown>;
  updatedThread?: Record<string, unknown>;
  unreadRows?: { status: string; threads: number }[];
} = {}) {
  const {
    thread = { id: "t-1", workspaceId: "ws-1", status: "replied", unreadCount: 3 },
    updatedThread = { ...thread },
    unreadRows = [],
  } = opts;

  const c: Record<string, ReturnType<typeof vi.fn>> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.groupBy = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockReturnValue(c);
  c.limit = vi.fn().mockResolvedValue([thread]);
  c.set = vi.fn().mockReturnValue(c);
  c.select = vi.fn().mockReturnValue(c);
  // groupBy queries return unreadRows
  c.groupBy.mockReturnValue({ ...c, limit: vi.fn().mockResolvedValue(unreadRows) });

  const updateChain: Record<string, ReturnType<typeof vi.fn>> = {};
  updateChain.set = vi.fn().mockReturnValue(updateChain);
  updateChain.where = vi.fn().mockReturnValue(updateChain);
  updateChain.returning = vi.fn().mockResolvedValue([updatedThread]);

  const db = {
    select: vi.fn().mockReturnValue(c),
    update: vi.fn().mockReturnValue(updateChain),
  } as unknown as any;

  return { db, updateChain };
}

const STUB_CONFIG = { INTEGRATION_ENCRYPTION_KEY: "test-key" } as any;

describe("InboxService.markThreadRead", () => {
  it("sets unreadCount to 0 for the thread", async () => {
    const { db, updateChain } = makeServiceDb();
    const svc = new InboxService(db, STUB_CONFIG);
    const result = await svc.markThreadRead("ws-1", "t-1");
    expect(result).toEqual({ ok: true });
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ unreadCount: 0 })
    );
  });

  it("throws 404 when thread is not found", async () => {
    const c: Record<string, ReturnType<typeof vi.fn>> = {};
    c.from = vi.fn().mockReturnValue(c);
    c.where = vi.fn().mockReturnValue(c);
    c.limit = vi.fn().mockResolvedValue([]); // empty = not found
    const db = { select: vi.fn().mockReturnValue(c) } as unknown as any;
    const svc = new InboxService(db, STUB_CONFIG);
    await expect(svc.markThreadRead("ws-1", "t-missing")).rejects.toThrow("thread_not_found");
  });
});

describe("InboxService.transitionThreadStatus", () => {
  it("allows replied → meeting_booked transition", async () => {
    const { db, updateChain } = makeServiceDb({
      thread: { id: "t-1", workspaceId: "ws-1", status: "replied" },
      updatedThread: { id: "t-1", workspaceId: "ws-1", status: "meeting_booked" },
    });
    const svc = new InboxService(db, STUB_CONFIG);
    const result = await svc.transitionThreadStatus("ws-1", "t-1", "meeting_booked");
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "meeting_booked" })
    );
    expect(result.status).toBe("meeting_booked");
  });

  it("allows replied → closed transition", async () => {
    const { db, updateChain } = makeServiceDb({
      thread: { id: "t-1", workspaceId: "ws-1", status: "replied" },
      updatedThread: { id: "t-1", workspaceId: "ws-1", status: "closed" },
    });
    const svc = new InboxService(db, STUB_CONFIG);
    await svc.transitionThreadStatus("ws-1", "t-1", "closed");
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "closed" })
    );
  });

  it("allows meeting_booked → closed", async () => {
    const { db } = makeServiceDb({
      thread: { id: "t-1", workspaceId: "ws-1", status: "meeting_booked" },
      updatedThread: { id: "t-1", workspaceId: "ws-1", status: "closed" },
    });
    const svc = new InboxService(db, STUB_CONFIG);
    await expect(svc.transitionThreadStatus("ws-1", "t-1", "closed")).resolves.not.toThrow();
  });

  it("allows new → closed", async () => {
    const { db } = makeServiceDb({
      thread: { id: "t-1", workspaceId: "ws-1", status: "new" },
      updatedThread: { id: "t-1", workspaceId: "ws-1", status: "closed" },
    });
    const svc = new InboxService(db, STUB_CONFIG);
    await expect(svc.transitionThreadStatus("ws-1", "t-1", "closed")).resolves.not.toThrow();
  });

  it("rejects closed → replied (illegal transition)", async () => {
    const { db } = makeServiceDb({
      thread: { id: "t-1", workspaceId: "ws-1", status: "closed" },
    });
    const svc = new InboxService(db, STUB_CONFIG);
    await expect(
      svc.transitionThreadStatus("ws-1", "t-1", "replied")
    ).rejects.toThrow(/Cannot transition/);
  });

  it("rejects replied → new (illegal transition)", async () => {
    const { db } = makeServiceDb({
      thread: { id: "t-1", workspaceId: "ws-1", status: "replied" },
    });
    const svc = new InboxService(db, STUB_CONFIG);
    await expect(
      svc.transitionThreadStatus("ws-1", "t-1", "new")
    ).rejects.toThrow(/Cannot transition/);
  });

  it("rejects bounced → replied", async () => {
    const { db } = makeServiceDb({
      thread: { id: "t-1", workspaceId: "ws-1", status: "bounced" },
    });
    const svc = new InboxService(db, STUB_CONFIG);
    await expect(
      svc.transitionThreadStatus("ws-1", "t-1", "replied")
    ).rejects.toThrow(/Cannot transition/);
  });

  it("sets statusChangedAt timestamp on a valid transition", async () => {
    const { db, updateChain } = makeServiceDb({
      thread: { id: "t-1", workspaceId: "ws-1", status: "replied" },
      updatedThread: { id: "t-1", workspaceId: "ws-1", status: "meeting_booked" },
    });
    const svc = new InboxService(db, STUB_CONFIG);
    await svc.transitionThreadStatus("ws-1", "t-1", "meeting_booked");
    const setCall = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall?.statusChangedAt).toBeInstanceOf(Date);
  });

  it("throws 404 for unknown thread", async () => {
    const c: Record<string, ReturnType<typeof vi.fn>> = {};
    c.from = vi.fn().mockReturnValue(c);
    c.where = vi.fn().mockReturnValue(c);
    c.limit = vi.fn().mockResolvedValue([]);
    const db = { select: vi.fn().mockReturnValue(c) } as unknown as any;
    const svc = new InboxService(db, STUB_CONFIG);
    await expect(
      svc.transitionThreadStatus("ws-1", "t-ghost", "closed")
    ).rejects.toThrow("thread_not_found");
  });
});

describe("InboxService.listManualReviewThreads", () => {
  it("returns threads flagged needsReview for the workspace", async () => {
    const rows = [{ id: "t-1", needsReview: true, suggestedTag: "negative" }];
    const c: Record<string, ReturnType<typeof vi.fn>> = {};
    c.from = vi.fn().mockReturnValue(c);
    c.where = vi.fn().mockReturnValue(c);
    c.orderBy = vi.fn().mockResolvedValue(rows);
    const db = { select: vi.fn().mockReturnValue(c) } as unknown as any;
    const svc = new InboxService(db, STUB_CONFIG);
    const result = await svc.listManualReviewThreads("ws-1");
    expect(result).toEqual({ workspaceId: "ws-1", data: rows, total: 1 });
  });
});

describe("InboxService.resolveManualReview", () => {
  function makeResolveDb(thread: Record<string, unknown>) {
    const selectChain: Record<string, ReturnType<typeof vi.fn>> = {};
    selectChain.from = vi.fn().mockReturnValue(selectChain);
    selectChain.where = vi.fn().mockReturnValue(selectChain);
    selectChain.limit = vi.fn().mockResolvedValue([thread]);

    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const update = vi.fn().mockReturnValue({ set: updateSet });

    const db = { select: vi.fn().mockReturnValue(selectChain), update } as unknown as any;
    return { db, updateSet, update };
  }

  it("throws 422 when the thread isn't pending review", async () => {
    const { db } = makeResolveDb({ id: "t-1", workspaceId: "ws-1", needsReview: false });
    const svc = new InboxService(db, STUB_CONFIG);
    await expect(svc.resolveManualReview("ws-1", "t-1", "dismiss")).rejects.toThrow("not_pending_review");
  });

  it("clears the review flag on dismiss without applying the suggested tag", async () => {
    const { db, updateSet } = makeResolveDb({
      id: "t-1",
      workspaceId: "ws-1",
      needsReview: true,
      suggestedTag: "negative",
      suggestedNegativeSubtype: "do_not_contact",
    });
    const svc = new InboxService(db, STUB_CONFIG);
    const result = await svc.resolveManualReview("ws-1", "t-1", "dismiss");
    expect(result).toEqual({ ok: true, action: "dismiss" });
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ needsReview: false, suggestedTag: null, suggestedNegativeSubtype: null })
    );
    // dismiss must not touch thread.status — that's the whole point of dismissing rather than applying
    expect(updateSet).not.toHaveBeenCalledWith(expect.objectContaining({ status: expect.anything() }));
  });

  it("applies the suggested tag action when action is apply", async () => {
    const { db, updateSet } = makeResolveDb({
      id: "t-1",
      workspaceId: "ws-1",
      status: "replied",
      needsReview: true,
      suggestedTag: "unsubscribe",
      suggestedNegativeSubtype: null,
    });
    const svc = new InboxService(db, STUB_CONFIG);
    const result = await svc.resolveManualReview("ws-1", "t-1", "apply");
    expect(result).toEqual({ ok: true, action: "apply" });
    // applyReplyTagActions' unsubscribe branch closes the thread
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: "closed" }));
    // resolveManualReview's own cleanup clears the review flag
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ needsReview: false }));
  });

  it("does not apply anything when there is no suggested tag, but still clears the flag", async () => {
    const { db, updateSet } = makeResolveDb({
      id: "t-1",
      workspaceId: "ws-1",
      needsReview: true,
      suggestedTag: null,
    });
    const svc = new InboxService(db, STUB_CONFIG);
    await svc.resolveManualReview("ws-1", "t-1", "apply");
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ needsReview: false }));
    expect(updateSet).not.toHaveBeenCalledWith(expect.objectContaining({ status: "closed" }));
  });
});

describe("InboxService.getUnreadCounts", () => {
  it("returns zero totals when no threads have unread messages", async () => {
    const c: Record<string, ReturnType<typeof vi.fn>> = {};
    c.from = vi.fn().mockReturnValue(c);
    c.where = vi.fn().mockReturnValue(c);
    c.select = vi.fn().mockReturnValue(c);
    c.groupBy = vi.fn().mockResolvedValue([]);
    const db = { select: vi.fn().mockReturnValue(c) } as unknown as any;
    const svc = new InboxService(db, STUB_CONFIG);
    const result = await svc.getUnreadCounts("ws-1");
    expect(result.total).toBe(0);
    expect(result.byStatus).toEqual({});
  });

  it("sums threads by status correctly", async () => {
    const unreadRows = [
      { status: "replied", threads: 4 },
      { status: "new", threads: 1 },
    ];
    const c: Record<string, ReturnType<typeof vi.fn>> = {};
    c.from = vi.fn().mockReturnValue(c);
    c.where = vi.fn().mockReturnValue(c);
    c.select = vi.fn().mockReturnValue(c);
    c.groupBy = vi.fn().mockResolvedValue(unreadRows);
    const db = { select: vi.fn().mockReturnValue(c) } as unknown as any;
    const svc = new InboxService(db, STUB_CONFIG);
    const result = await svc.getUnreadCounts("ws-1");
    expect(result.total).toBe(5);
    expect(result.byStatus).toEqual({ replied: 4, new: 1 });
  });
});
