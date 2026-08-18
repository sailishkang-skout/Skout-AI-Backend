import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../config/env.js";
import { applyReplyTagActions } from "./reply-tag-actions.service.js";

vi.mock("./suppression.service.js", () => ({
  addSuppression: vi.fn(async () => {}),
  isSuppressed: vi.fn(async () => false),
}));
vi.mock("./notifications.service.js", () => ({
  createNotification: vi.fn(async () => ({})),
}));

import { addSuppression, isSuppressed } from "./suppression.service.js";
import { createNotification } from "./notifications.service.js";

const fakeConfig = {} as Env;

function makeDb(thread: Record<string, unknown> | null, email?: string) {
  const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  };

  // First select: thread; second select (unsubscribe only): activation
  selectChain.limit
    .mockResolvedValueOnce(thread ? [thread] : [])
    .mockResolvedValueOnce(
      email ? [{ snapshot: { email } }] : [{ snapshot: {} }]
    );

  const insertValues = vi.fn().mockReturnValue({
    returning: vi.fn().mockImplementation(() =>
      Promise.resolve([
        {
          id: "sig-1",
          entityType: "prospect",
          entityId: "p1",
          signalType: "negative_sentiment",
          value: {},
          confidence: null,
          detectedAt: new Date(),
          source: null,
          provenance: {},
          createdAt: new Date(),
        },
      ])
    ),
  });

  return {
    select: vi.fn().mockReturnValue(selectChain),
    update: vi.fn().mockReturnValue({ set: updateSet }),
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    _updateSet: updateSet,
    _insertValues: insertValues,
  } as any;
}

describe("applyReplyTagActions", () => {
  beforeEach(() => {
    vi.mocked(addSuppression).mockClear();
    vi.mocked(createNotification).mockClear();
  });

  it("marks meeting_booked on meeting_request", async () => {
    const db = makeDb({ id: "t1", prospectId: "p1", status: "replied" });
    await applyReplyTagActions(db, fakeConfig, "ws1", "t1", "meeting_request");
    expect(db.update).toHaveBeenCalled();
    expect(db._updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "meeting_booked" })
    );
    expect(addSuppression).not.toHaveBeenCalled();
  });

  it("closes thread and suppresses on unsubscribe", async () => {
    const db = makeDb({ id: "t1", prospectId: "p1", status: "replied" }, "ada@ae.example");
    await applyReplyTagActions(db, fakeConfig, "ws1", "t1", "unsubscribe");
    expect(db._updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "closed" })
    );
    expect(addSuppression).toHaveBeenCalledWith(db, "ws1", "ada@ae.example", "unsubscribed");
  });

  it("no-ops for neutral", async () => {
    const db = makeDb({ id: "t1", prospectId: "p1", status: "replied" });
    await applyReplyTagActions(db, fakeConfig, "ws1", "t1", "neutral");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("records a negative_sentiment signal with a quoted snippet on negative", async () => {
    const db = makeDb({ id: "t1", prospectId: "p1", status: "replied" });
    await applyReplyTagActions(db, fakeConfig, "ws1", "t1", "negative", {
      bodyText: "This isn't working for us, please stop emailing.",
    });
    expect(db._insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "prospect",
        entityId: "p1",
        signalType: "negative_sentiment",
        value: expect.objectContaining({ reason: expect.stringContaining("This isn't working for us") }),
      })
    );
  });

  it("still records a signal (without a snippet) when no bodyText is passed", async () => {
    const db = makeDb({ id: "t1", prospectId: "p1", status: "replied" });
    await applyReplyTagActions(db, fakeConfig, "ws1", "t1", "negative");
    expect(db._insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ signalType: "negative_sentiment" })
    );
  });

  it("suppresses on a negative reply tagged do_not_contact, not just a plain not_interested", async () => {
    const db = makeDb({ id: "t1", prospectId: "p1", status: "replied" }, "ada@ae.example");
    await applyReplyTagActions(db, fakeConfig, "ws1", "t1", "negative", {
      negativeSubtype: "do_not_contact",
    });
    expect(addSuppression).toHaveBeenCalledWith(db, "ws1", "ada@ae.example", "do_not_contact");
  });

  it("does not suppress on a plain not_interested negative reply", async () => {
    const db = makeDb({ id: "t1", prospectId: "p1", status: "replied" }, "ada@ae.example");
    await applyReplyTagActions(db, fakeConfig, "ws1", "t1", "negative", {
      negativeSubtype: "not_interested",
    });
    expect(addSuppression).not.toHaveBeenCalled();
  });

  it("routes a low-confidence classification to manual review instead of auto-applying the branch", async () => {
    const db = makeDb({ id: "t1", prospectId: "p1", status: "replied" }, "ada@ae.example");
    await applyReplyTagActions(db, fakeConfig, "ws1", "t1", "unsubscribe", { confidence: 0.4 });
    expect(addSuppression).not.toHaveBeenCalled();
    expect(db._updateSet).not.toHaveBeenCalledWith(expect.objectContaining({ status: "closed" }));
    expect(createNotification).toHaveBeenCalledWith(
      db,
      fakeConfig,
      expect.objectContaining({ workspaceId: "ws1", type: "reply_needs_review", entityId: "t1" })
    );
  });

  it("auto-applies silently at or above the auto-confidence threshold — no notification at all", async () => {
    const db = makeDb({ id: "t1", prospectId: "p1", status: "replied" }, "ada@ae.example");
    await applyReplyTagActions(db, fakeConfig, "ws1", "t1", "unsubscribe", { confidence: 0.85 });
    expect(addSuppression).toHaveBeenCalledWith(db, "ws1", "ada@ae.example", "unsubscribed");
    expect(createNotification).not.toHaveBeenCalled();
  });

  it("applies the action AND sends a non-blocking FYI notification in the cautious band (0.60–0.84)", async () => {
    const db = makeDb({ id: "t1", prospectId: "p1", status: "replied" }, "ada@ae.example");
    await applyReplyTagActions(db, fakeConfig, "ws1", "t1", "unsubscribe", { confidence: 0.6 });
    // Cautious still applies the real action — this is not manual review.
    expect(addSuppression).toHaveBeenCalledWith(db, "ws1", "ada@ae.example", "unsubscribed");
    expect(createNotification).toHaveBeenCalledWith(
      db,
      fakeConfig,
      expect.objectContaining({ workspaceId: "ws1", type: "reply_auto_processed_fyi", entityId: "t1" })
    );
  });

  it("just below the cautious band routes to manual review instead", async () => {
    const db = makeDb({ id: "t1", prospectId: "p1", status: "replied" }, "ada@ae.example");
    await applyReplyTagActions(db, fakeConfig, "ws1", "t1", "unsubscribe", { confidence: 0.59 });
    expect(addSuppression).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledWith(
      db,
      fakeConfig,
      expect.objectContaining({ type: "reply_needs_review" })
    );
  });
});

// ---------------------------------------------------------------------------
// wrong_person escalation — sequential select mock since this path issues
// several distinct db.select() calls in a fixed order (thread, current prospect's
// companyDomain, alternate-contact candidates, workspace owners).
// ---------------------------------------------------------------------------

function makeWrongPersonDb(opts: {
  thread?: Record<string, unknown> | null;
  companyDomain?: string | null;
  candidates?: Array<{ prospectId: string; email: string | null; fullName: string | null }>;
  owners?: Array<{ userId: string }>;
}) {
  const {
    thread = { id: "t1", prospectId: "p1", status: "replied" },
    companyDomain = "acme.com",
    candidates = [],
    owners = [{ userId: "u1" }],
  } = opts;

  const pages = [
    thread ? [thread] : [],
    companyDomain ? [{ companyDomain }] : [],
    candidates,
    owners,
  ];
  let cursor = 0;

  const insertValues = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([]),
  });
  const select = vi.fn(() => {
    const page = pages[cursor] ?? [];
    cursor++;
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(page),
      // workspaceMembers select has no .limit() call in the real code
      then: (resolve: (v: unknown) => void) => resolve(page),
    };
  });

  return {
    select,
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    update: vi.fn(),
    _insertValues: insertValues,
  } as any;
}

describe("applyReplyTagActions — wrong_person escalation", () => {
  beforeEach(() => {
    vi.mocked(createNotification).mockClear();
    vi.mocked(isSuppressed).mockClear();
    vi.mocked(isSuppressed).mockResolvedValue(false);
  });

  it("creates a follow-up task and notifies owners when an alternate contact is found", async () => {
    const db = makeWrongPersonDb({
      candidates: [{ prospectId: "p2", email: "other@acme.com", fullName: "Bob Smith" }],
    });
    await applyReplyTagActions(db, fakeConfig, "ws1", "t1", "negative", {
      negativeSubtype: "wrong_person",
    });
    expect(db._insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        prospectId: "p2",
        relatedEntityType: "wrong_person_escalation",
        title: expect.stringContaining("Bob Smith"),
      })
    );
    expect(createNotification).toHaveBeenCalledWith(
      db,
      fakeConfig,
      expect.objectContaining({ userId: "u1", type: "reminder" })
    );
  });

  it("skips a candidate that is already suppressed and falls through to the next one", async () => {
    vi.mocked(isSuppressed).mockImplementation(async (_db, _ws, email) => email === "suppressed@acme.com");
    const db = makeWrongPersonDb({
      candidates: [
        { prospectId: "p2", email: "suppressed@acme.com", fullName: "Suppressed Sam" },
        { prospectId: "p3", email: "good@acme.com", fullName: "Good Gina" },
      ],
    });
    await applyReplyTagActions(db, fakeConfig, "ws1", "t1", "negative", {
      negativeSubtype: "wrong_person",
    });
    expect(db._insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ prospectId: "p3" })
    );
  });

  it("does nothing when no alternate contact exists at the account", async () => {
    const db = makeWrongPersonDb({ candidates: [] });
    await applyReplyTagActions(db, fakeConfig, "ws1", "t1", "negative", {
      negativeSubtype: "wrong_person",
    });
    expect(db._insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({ relatedEntityType: "wrong_person_escalation" })
    );
    expect(createNotification).not.toHaveBeenCalled();
  });

  it("does nothing when the current prospect has no known company domain", async () => {
    const db = makeWrongPersonDb({ companyDomain: null });
    await applyReplyTagActions(db, fakeConfig, "ws1", "t1", "negative", {
      negativeSubtype: "wrong_person",
    });
    expect(db._insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({ relatedEntityType: "wrong_person_escalation" })
    );
  });

  it("does not escalate a plain not_interested negative reply", async () => {
    const db = makeWrongPersonDb({
      candidates: [{ prospectId: "p2", email: "other@acme.com", fullName: "Bob Smith" }],
    });
    await applyReplyTagActions(db, fakeConfig, "ws1", "t1", "negative", {
      negativeSubtype: "not_interested",
    });
    expect(db._insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({ relatedEntityType: "wrong_person_escalation" })
    );
  });
});
