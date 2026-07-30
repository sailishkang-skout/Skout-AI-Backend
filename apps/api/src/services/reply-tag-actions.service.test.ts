import { describe, expect, it, vi, beforeEach } from "vitest";
import { applyReplyTagActions } from "./reply-tag-actions.service.js";

vi.mock("./suppression.service.js", () => ({
  addSuppression: vi.fn(async () => {}),
}));

import { addSuppression } from "./suppression.service.js";

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

  return {
    select: vi.fn().mockReturnValue(selectChain),
    update: vi.fn().mockReturnValue({ set: updateSet }),
    _updateSet: updateSet,
  } as any;
}

describe("applyReplyTagActions", () => {
  beforeEach(() => {
    vi.mocked(addSuppression).mockClear();
  });

  it("marks meeting_booked on meeting_request", async () => {
    const db = makeDb({ id: "t1", prospectId: "p1", status: "replied" });
    await applyReplyTagActions(db, "ws1", "t1", "meeting_request");
    expect(db.update).toHaveBeenCalled();
    expect(db._updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "meeting_booked" })
    );
    expect(addSuppression).not.toHaveBeenCalled();
  });

  it("closes thread and suppresses on unsubscribe", async () => {
    const db = makeDb({ id: "t1", prospectId: "p1", status: "replied" }, "ada@ae.example");
    await applyReplyTagActions(db, "ws1", "t1", "unsubscribe");
    expect(db._updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "closed" })
    );
    expect(addSuppression).toHaveBeenCalledWith(db, "ws1", "ada@ae.example", "unsubscribed");
  });

  it("no-ops for neutral", async () => {
    const db = makeDb({ id: "t1", prospectId: "p1", status: "replied" });
    await applyReplyTagActions(db, "ws1", "t1", "neutral");
    expect(db.update).not.toHaveBeenCalled();
  });
});
