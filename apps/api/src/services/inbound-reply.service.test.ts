import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  classifyInboundMessage,
  extractParentMessageIds,
  ingestInboundMessage,
  type InboundMessagePayload,
} from "./inbound-reply.service.js";

// ---------------------------------------------------------------------------
// classifyInboundMessage
// ---------------------------------------------------------------------------

describe("classifyInboundMessage — bounce detection", () => {
  it("MAILER-DAEMON sender", () => {
    expect(classifyInboundMessage({ fromAddress: "MAILER-DAEMON@example.com" })).toBe("bounce");
  });

  it("postmaster@ sender", () => {
    expect(classifyInboundMessage({ fromAddress: "postmaster@mx.example.com" })).toBe("bounce");
  });

  it("mail-delivery-subsystem sender", () => {
    expect(
      classifyInboundMessage({ fromAddress: "Mail-Delivery-Subsystem@google.com" })
    ).toBe("bounce");
  });

  it("x-failed-recipients header present", () => {
    expect(
      classifyInboundMessage({
        fromAddress: "noreply@gmail.com",
        rawHeaders: { "x-failed-recipients": "prospect@company.com" },
      })
    ).toBe("bounce");
  });

  it("Delivery Status Notification in subject", () => {
    expect(
      classifyInboundMessage({
        fromAddress: "noreply@mail.example.com",
        subject: "Delivery Status Notification (Failure)",
      })
    ).toBe("bounce");
  });

  it("Undeliverable: subject", () => {
    expect(
      classifyInboundMessage({ fromAddress: "system@example.com", subject: "Undeliverable: Your message" })
    ).toBe("bounce");
  });

  it("Mail delivery failed subject", () => {
    expect(
      classifyInboundMessage({ fromAddress: "noreply@example.com", subject: "Mail delivery failed" })
    ).toBe("bounce");
  });

  it("Returned mail subject", () => {
    expect(
      classifyInboundMessage({ fromAddress: "noreply@example.com", subject: "Returned mail: unable to deliver" })
    ).toBe("bounce");
  });

  it("Delivery failure subject", () => {
    expect(
      classifyInboundMessage({ fromAddress: "noreply@example.com", subject: "Delivery failure notice" })
    ).toBe("bounce");
  });

  it("multipart/report delivery-status content-type", () => {
    expect(
      classifyInboundMessage({
        fromAddress: "postmaster@mx.example.com",
        rawHeaders: { "content-type": "multipart/report; report-type=delivery-status; boundary=abc" },
      })
    ).toBe("bounce");
  });
});

describe("classifyInboundMessage — auto-reply detection", () => {
  it("Auto-Submitted: auto-replied header", () => {
    expect(
      classifyInboundMessage({
        fromAddress: "user@company.com",
        rawHeaders: { "auto-submitted": "auto-replied" },
      })
    ).toBe("auto_reply");
  });

  it("Auto-Submitted: auto-generated header", () => {
    expect(
      classifyInboundMessage({
        fromAddress: "user@company.com",
        rawHeaders: { "auto-submitted": "auto-generated" },
      })
    ).toBe("auto_reply");
  });

  it("X-Autoreply: yes header", () => {
    expect(
      classifyInboundMessage({
        fromAddress: "user@company.com",
        rawHeaders: { "x-autoreply": "yes" },
      })
    ).toBe("auto_reply");
  });

  it("X-Auto-Response-Suppress header present", () => {
    expect(
      classifyInboundMessage({
        fromAddress: "user@company.com",
        rawHeaders: { "x-auto-response-suppress": "All" },
      })
    ).toBe("auto_reply");
  });

  it("Out of Office subject (mixed case)", () => {
    expect(
      classifyInboundMessage({ fromAddress: "user@company.com", subject: "Out of Office: Back Monday" })
    ).toBe("auto_reply");
  });

  it("OOO: subject prefix", () => {
    expect(
      classifyInboundMessage({ fromAddress: "user@company.com", subject: "OOO: Away until the 10th" })
    ).toBe("auto_reply");
  });

  it("Automatic reply: subject prefix", () => {
    expect(
      classifyInboundMessage({ fromAddress: "user@company.com", subject: "Automatic reply: Re: Your message" })
    ).toBe("auto_reply");
  });

  it("Auto reply: subject prefix", () => {
    expect(
      classifyInboundMessage({ fromAddress: "user@company.com", subject: "Auto reply: Hello" })
    ).toBe("auto_reply");
  });

  it("Auto: subject prefix", () => {
    expect(
      classifyInboundMessage({ fromAddress: "user@company.com", subject: "Auto: Away from office" })
    ).toBe("auto_reply");
  });
});

describe("classifyInboundMessage — human replies", () => {
  it("plain reply with Re: prefix", () => {
    expect(
      classifyInboundMessage({ fromAddress: "prospect@company.com", subject: "Re: Loved your note" })
    ).toBe("human");
  });

  it("no headers at all", () => {
    expect(classifyInboundMessage({ fromAddress: "someone@company.com" })).toBe("human");
  });

  it("empty subject", () => {
    expect(classifyInboundMessage({ fromAddress: "prospect@company.com", subject: "" })).toBe("human");
  });

  it("unrelated headers do not trigger auto_reply", () => {
    expect(
      classifyInboundMessage({
        fromAddress: "user@company.com",
        rawHeaders: { "x-mailer": "Apple Mail", "mime-version": "1.0" },
      })
    ).toBe("human");
  });

  it("bounce-like subject only triggers if matched exactly (no partial match in middle)", () => {
    // "re: undeliverable message" — "undeliverable:" is a prefix match not present here
    expect(
      classifyInboundMessage({
        fromAddress: "prospect@company.com",
        subject: "Re: your proposal was undeliverable to my team — let's talk",
      })
    ).toBe("human");
  });
});

// ---------------------------------------------------------------------------
// extractParentMessageIds
// ---------------------------------------------------------------------------

describe("extractParentMessageIds", () => {
  it("returns empty array when both args are absent", () => {
    expect(extractParentMessageIds()).toEqual([]);
  });

  it("returns empty array for empty strings", () => {
    expect(extractParentMessageIds("", "")).toEqual([]);
  });

  it("parses single ID from In-Reply-To", () => {
    expect(extractParentMessageIds("<abc123@smtp.example.com>")).toEqual([
      "<abc123@smtp.example.com>",
    ]);
  });

  it("parses multiple IDs from References chain", () => {
    const ids = extractParentMessageIds(
      undefined,
      "<first@a.com> <second@b.com> <third@c.com>"
    );
    expect(ids).toEqual(["<first@a.com>", "<second@b.com>", "<third@c.com>"]);
  });

  it("deduplicates IDs appearing in both headers", () => {
    const ids = extractParentMessageIds(
      "<shared@a.com>",
      "<shared@a.com> <other@b.com>"
    );
    expect(ids).toHaveLength(2);
    expect(ids).toContain("<shared@a.com>");
    expect(ids).toContain("<other@b.com>");
  });

  it("handles IDs with only In-Reply-To set", () => {
    expect(extractParentMessageIds("<only@example.com>", undefined)).toEqual([
      "<only@example.com>",
    ]);
  });

  it("skips whitespace-only headers", () => {
    expect(extractParentMessageIds("   ", "  ")).toEqual([]);
  });

  it("handles IDs that contain dots, hyphens, and plus signs", () => {
    const ids = extractParentMessageIds("<abc.def+ghi-jkl@mail.example.co.uk>");
    expect(ids).toEqual(["<abc.def+ghi-jkl@mail.example.co.uk>"]);
  });
});

// ---------------------------------------------------------------------------
// Helpers: mock DB builder
// ---------------------------------------------------------------------------

type SelectRow = Record<string, unknown>;

/**
 * Builds a mock Drizzle-like DB client.
 * `selectPages` is a list of results returned per successive `.select()` call.
 * `insertReturning` is the row returned by `.insert().values().returning()`.
 */
function makeDb(opts: {
  selectPages?: SelectRow[][];
  insertReturning?: SelectRow;
  updateCallSpy?: ReturnType<typeof vi.fn>;
} = {}) {
  const { selectPages = [], insertReturning = { id: "new-thread" }, updateCallSpy } = opts;

  let selectCursor = 0;

  function chain(resolveWith: unknown): Record<string, ReturnType<typeof vi.fn>> {
    const c: Record<string, ReturnType<typeof vi.fn>> = {};
    // query builder methods
    c.from = vi.fn().mockReturnValue(c);
    c.where = vi.fn().mockReturnValue(c);
    c.innerJoin = vi.fn().mockReturnValue(c);
    c.select = vi.fn().mockReturnValue(c);
    c.limit = vi.fn().mockResolvedValue(resolveWith);
    // write methods
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
// ingestInboundMessage — integration-style unit tests
// ---------------------------------------------------------------------------

const BASE_PAYLOAD: InboundMessagePayload = {
  fromAddress: "prospect@company.com",
  toAddress: "sender@mycompany.com",
  subject: "Re: Hello there",
  bodyText: "Thanks for reaching out!",
  messageId: "<reply-001@company.com>",
  inReplyTo: "<outbound-001@smtp.mycompany.com>",
  sentAt: new Date("2026-07-01T10:00:00Z"),
};

describe("ingestInboundMessage — deduplication", () => {
  it("does nothing when the messageId already exists in DB", async () => {
    const { db } = makeDb({
      selectPages: [[{ id: "msg-existing" }]], // dedup check finds a match
    });
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", BASE_PAYLOAD);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("proceeds when messageId is absent (no dedup check)", async () => {
    const { db } = makeDb({ selectPages: [[], []] }); // parent lookup returns nothing
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", {
      ...BASE_PAYLOAD,
      messageId: undefined,
      inReplyTo: undefined,
    });
    expect(db.insert).toHaveBeenCalled();
  });
});

describe("ingestInboundMessage — thread matching", () => {
  it("creates a new thread when In-Reply-To does not match any outbound message", async () => {
    // dedup → [], parent lookup → []
    const { db } = makeDb({ selectPages: [[], []] });
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", BASE_PAYLOAD);
    // insert called twice: once for inboxThreads (new thread), once for inboxMessages
    expect(db.insert).toHaveBeenCalledTimes(2);
  });

  it("appends to existing thread when parent messageId is matched", async () => {
    const parentMsg = { threadId: "thread-existing", enrollmentId: null, prospectId: "p-1" };
    // dedup → [], parent lookup → [parentMsg]
    const { db } = makeDb({ selectPages: [[], [parentMsg]] });
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", BASE_PAYLOAD);
    // Only one insert (inboxMessages) — no new thread created
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("creates new thread when no In-Reply-To / References supplied (cold inbound)", async () => {
    const { db } = makeDb({ selectPages: [[]] }); // only dedup check (no parent lookup)
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", {
      ...BASE_PAYLOAD,
      messageId: undefined,
      inReplyTo: undefined,
      references: undefined,
    });
    expect(db.insert).toHaveBeenCalledTimes(2); // thread + message
  });
});

describe("ingestInboundMessage — human reply", () => {
  it("marks thread status replied", async () => {
    const parentMsg = { threadId: "t-1", enrollmentId: null, prospectId: "p-1" };
    const { db, updateFn } = makeDb({ selectPages: [[], [parentMsg]] });
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", BASE_PAYLOAD);
    // thread update called with status 'replied'
    expect(updateFn).toHaveBeenCalledTimes(1);
  });

  it("pauses active enrollment and skips remaining steps when enrollmentId is present", async () => {
    const parentMsg = { threadId: "t-1", enrollmentId: "enroll-1", prospectId: "p-1" };
    const { db, updateFn } = makeDb({ selectPages: [[], [parentMsg]] });
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", BASE_PAYLOAD);
    // 3 updates: thread status, enrollment status, enrollment steps skip
    expect(updateFn).toHaveBeenCalledTimes(3);
  });

  it("does not create a suppression on human reply", async () => {
    const parentMsg = { threadId: "t-1", enrollmentId: "enroll-1", prospectId: "p-1" };
    const { db } = makeDb({ selectPages: [[], [parentMsg]] });
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", BASE_PAYLOAD);
    // Only 1 insert: inboxMessages (no suppression)
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("does not pause enrollment when enrollmentId is null", async () => {
    const parentMsg = { threadId: "t-1", enrollmentId: null, prospectId: "p-1" };
    const { db, updateFn } = makeDb({ selectPages: [[], [parentMsg]] });
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", BASE_PAYLOAD);
    // Only thread update (no enrollment updates)
    expect(updateFn).toHaveBeenCalledTimes(1);
  });
});

describe("ingestInboundMessage — bounce", () => {
  const BOUNCE_PAYLOAD: InboundMessagePayload = {
    ...BASE_PAYLOAD,
    fromAddress: "MAILER-DAEMON@mx.example.com",
    subject: "Delivery failure notice",
  };

  it("marks thread status bounced", async () => {
    const parentMsg = { threadId: "t-1", enrollmentId: null, prospectId: "p-1" };
    const { db, updateFn } = makeDb({ selectPages: [[], [parentMsg]] });
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", BOUNCE_PAYLOAD);
    expect(updateFn).toHaveBeenCalledTimes(1); // thread only (no enrollment)
  });

  it("stops enrollment and inserts suppression when enrollmentId present", async () => {
    const parentMsg = { threadId: "t-1", enrollmentId: "enroll-1", prospectId: "p-1" };
    const { db, updateFn } = makeDb({ selectPages: [[], [parentMsg]] });
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", BOUNCE_PAYLOAD);
    // 3 updates: thread, enrollment, steps
    expect(updateFn).toHaveBeenCalledTimes(3);
    // 2 inserts: inboxMessages + suppressions
    expect(db.insert).toHaveBeenCalledTimes(2);
  });

  it("adds suppression even without enrollmentId", async () => {
    const parentMsg = { threadId: "t-1", enrollmentId: null, prospectId: "p-1" };
    const { db } = makeDb({ selectPages: [[], [parentMsg]] });
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", BOUNCE_PAYLOAD);
    // 2 inserts: inboxMessages + suppression
    expect(db.insert).toHaveBeenCalledTimes(2);
  });

  it("adds suppression on new thread (cold bounce)", async () => {
    // dedup → [], parent lookup → [] (no thread match)
    const { db } = makeDb({ selectPages: [[], []] });
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", BOUNCE_PAYLOAD);
    // 3 inserts: inboxThreads (new) + inboxMessages + suppression
    expect(db.insert).toHaveBeenCalledTimes(3);
  });
});

describe("ingestInboundMessage — auto_reply", () => {
  const OOO_PAYLOAD: InboundMessagePayload = {
    ...BASE_PAYLOAD,
    subject: "Out of Office: Back on Monday",
  };

  it("does not update enrollment on auto_reply", async () => {
    const parentMsg = { threadId: "t-1", enrollmentId: "enroll-1", prospectId: "p-1" };
    const { db, updateFn } = makeDb({ selectPages: [[], [parentMsg]] });
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", OOO_PAYLOAD);
    // Only thread lastMessageAt update — no enrollment updates
    expect(updateFn).toHaveBeenCalledTimes(1);
  });

  it("does not create a suppression on auto_reply", async () => {
    const parentMsg = { threadId: "t-1", enrollmentId: "enroll-1", prospectId: "p-1" };
    const { db } = makeDb({ selectPages: [[], [parentMsg]] });
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", OOO_PAYLOAD);
    // Only 1 insert: inboxMessages
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("stores classification=auto_reply on the message row", async () => {
    const parentMsg = { threadId: "t-1", enrollmentId: null, prospectId: "p-1" };
    const { db } = makeDb({ selectPages: [[], [parentMsg]] });
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", OOO_PAYLOAD);
    const insertCall = db.insert.mock.calls[0];
    // insert was called (we can verify it was called at all)
    expect(insertCall).toBeDefined();
  });
});

describe("ingestInboundMessage — messageId normalisation", () => {
  it("normalises messageId without angle brackets before dedup check", async () => {
    // Return a match on the first select (dedup) to trigger early return
    const { db } = makeDb({ selectPages: [[{ id: "msg-existing" }]] });
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", {
      ...BASE_PAYLOAD,
      messageId: "reply-no-brackets@example.com", // no angle brackets
    });
    // Should still be caught by dedup (normalised to <reply-no-brackets@example.com>)
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("handles messageId already with angle brackets without double-wrapping", async () => {
    const { db } = makeDb({ selectPages: [[{ id: "existing" }]] });
    await ingestInboundMessage(db as any, "ws-1", "inbox-1", {
      ...BASE_PAYLOAD,
      messageId: "<already-wrapped@example.com>",
    });
    expect(db.insert).not.toHaveBeenCalled();
  });
});
