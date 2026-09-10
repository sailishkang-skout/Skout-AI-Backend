import { describe, expect, it, vi } from "vitest";
import { markInboxUsed, pickNextInbox, recordBounce, recordSpam } from "./inbox-rotation.service.js";
import type { Env } from "../config/env.js";

const config = {
  INBOX_BOUNCE_RATE_THRESHOLD: 0.05,
  INBOX_SPAM_RATE_THRESHOLD: 0.01,
  INBOX_MIN_SENT_BEFORE_HEALTH_CHECK: 20,
} as unknown as Env;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function selectChain(result: unknown[]) {
  const c = {} as Record<string, ReturnType<typeof vi.fn>>;
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockResolvedValue(result);
  c.limit = vi.fn().mockResolvedValue(result);
  return c;
}

function updateChain() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  return { set, where };
}

// ---------------------------------------------------------------------------
// pickNextInbox
// ---------------------------------------------------------------------------

describe("pickNextInbox", () => {
  it("returns the first active inbox under its daily send cap", async () => {
    const inboxRow = { id: "inbox-1", status: "active", dailySendLimit: 50 };
    const countChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ sentToday: 0 }]),
    };
    const listChain = selectChain([inboxRow]);
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(listChain)
        .mockReturnValueOnce(countChain),
    } as any;
    await expect(pickNextInbox(db, "ws-1")).resolves.toEqual(inboxRow);
  });

  it("skips inboxes that have hit their daily send limit", async () => {
    const capped = { id: "inbox-1", status: "active", dailySendLimit: 50 };
    const available = { id: "inbox-2", status: "active", dailySendLimit: 50 };
    const listChain = selectChain([capped, available]);
    const cappedCount = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ sentToday: 50 }]),
    };
    const availableCount = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ sentToday: 10 }]),
    };
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(listChain)
        .mockReturnValueOnce(cappedCount)
        .mockReturnValueOnce(availableCount),
    } as any;
    await expect(pickNextInbox(db, "ws-1")).resolves.toEqual(available);
  });

  it("returns null when no active inbox exists", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) } as any;
    await expect(pickNextInbox(db, "ws-1")).resolves.toBeNull();
  });

  it("returns null when every active inbox is at its daily cap", async () => {
    const capped = { id: "inbox-1", status: "active", dailySendLimit: 10 };
    const listChain = selectChain([capped]);
    const countChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ sentToday: 10 }]),
    };
    const db = {
      select: vi.fn().mockReturnValueOnce(listChain).mockReturnValueOnce(countChain),
    } as any;
    await expect(pickNextInbox(db, "ws-1")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// markInboxUsed
// ---------------------------------------------------------------------------

describe("markInboxUsed", () => {
  it("updates lastUsedAt and updatedAt for the given inbox", async () => {
    const chain = updateChain();
    const db = { update: vi.fn().mockReturnValue(chain) } as any;

    await markInboxUsed(db, "inbox-1");

    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        lastUsedAt: expect.any(Date),
        updatedAt: expect.any(Date),
        sentCount: expect.anything(),
      })
    );
    expect(chain.where).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// recordBounce
// ---------------------------------------------------------------------------

describe("recordBounce", () => {
  it("increments bounceCount on the inbox", async () => {
    const incrementChain = updateChain();
    const inbox = { id: "inbox-1", sentCount: 5, bounceCount: 0, spamCount: 0 };

    const db = {
      update: vi.fn().mockReturnValue(incrementChain),
      select: vi.fn().mockReturnValue(selectChain([inbox])),
    } as any;

    await recordBounce(db, "inbox-1", config);

    expect(incrementChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ bounceCount: expect.anything() })
    );
  });

  it("does not auto-pause when sentCount is below the health-check minimum", async () => {
    const incrementChain = updateChain();
    const inbox = { id: "inbox-1", sentCount: 5, bounceCount: 1, spamCount: 0 };

    const db = {
      update: vi.fn().mockReturnValue(incrementChain),
      select: vi.fn().mockReturnValue(selectChain([inbox])),
    } as any;

    await recordBounce(db, "inbox-1", config);

    // update should only be called once (for incrementing) — not a second time for pausing
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("auto-pauses the inbox when bounce rate exceeds threshold", async () => {
    const pauseChain = updateChain();
    // sentCount=100, bounceCount=10 → 10% bounce rate > 5% threshold
    const inbox = { id: "inbox-1", sentCount: 100, bounceCount: 10, spamCount: 0 };

    const db = {
      update: vi.fn()
        .mockReturnValueOnce(updateChain()) // increment
        .mockReturnValueOnce(pauseChain),   // pause
      select: vi.fn().mockReturnValue(selectChain([inbox])),
    } as any;

    await recordBounce(db, "inbox-1", config);

    expect(db.update).toHaveBeenCalledTimes(2);
    expect(pauseChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused" })
    );
  });

  it("does not auto-pause when bounce rate is within threshold", async () => {
    // sentCount=100, bounceCount=4 → 4% bounce rate < 5% threshold
    const inbox = { id: "inbox-1", sentCount: 100, bounceCount: 4, spamCount: 0 };

    const db = {
      update: vi.fn().mockReturnValue(updateChain()),
      select: vi.fn().mockReturnValue(selectChain([inbox])),
    } as any;

    await recordBounce(db, "inbox-1", config);

    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("does nothing when inbox is not found after increment", async () => {
    const db = {
      update: vi.fn().mockReturnValue(updateChain()),
      select: vi.fn().mockReturnValue(selectChain([])),
    } as any;

    await expect(recordBounce(db, "inbox-missing", config)).resolves.toBeUndefined();
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// recordSpam
// ---------------------------------------------------------------------------

describe("recordSpam", () => {
  it("increments spamCount on the inbox", async () => {
    const incrementChain = updateChain();
    const inbox = { id: "inbox-1", sentCount: 5, bounceCount: 0, spamCount: 0 };

    const db = {
      update: vi.fn().mockReturnValue(incrementChain),
      select: vi.fn().mockReturnValue(selectChain([inbox])),
    } as any;

    await recordSpam(db, "inbox-1", config);

    expect(incrementChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ spamCount: expect.anything() })
    );
  });

  it("auto-pauses when spam rate exceeds threshold", async () => {
    const pauseChain = updateChain();
    // sentCount=100, spamCount=2 → 2% spam rate > 1% threshold
    const inbox = { id: "inbox-1", sentCount: 100, bounceCount: 0, spamCount: 2 };

    const db = {
      update: vi.fn()
        .mockReturnValueOnce(updateChain())
        .mockReturnValueOnce(pauseChain),
      select: vi.fn().mockReturnValue(selectChain([inbox])),
    } as any;

    await recordSpam(db, "inbox-1", config);

    expect(db.update).toHaveBeenCalledTimes(2);
    expect(pauseChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused" })
    );
  });

  it("does not auto-pause when spam rate is within threshold", async () => {
    // sentCount=100, spamCount=1 → 1% spam rate = threshold (not exceeded)
    const inbox = { id: "inbox-1", sentCount: 100, bounceCount: 0, spamCount: 1 };

    const db = {
      update: vi.fn().mockReturnValue(updateChain()),
      select: vi.fn().mockReturnValue(selectChain([inbox])),
    } as any;

    await recordSpam(db, "inbox-1", config);

    expect(db.update).toHaveBeenCalledTimes(1);
  });
});
