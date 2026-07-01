import { describe, expect, it, vi } from "vitest";
import { markInboxUsed, pickNextInbox } from "./inbox-rotation.service.js";

function selectChain(result: unknown[]) {
  const c = {} as Record<string, ReturnType<typeof vi.fn>>;
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockReturnValue(c);
  c.limit = vi.fn().mockResolvedValue(result);
  return c;
}

describe("inbox-rotation.service", () => {
  describe("pickNextInbox", () => {
    it("returns the first active inbox ordered by lastUsedAt", async () => {
      const inboxRow = { id: "inbox-1", status: "active" };
      const db = { select: vi.fn().mockReturnValue(selectChain([inboxRow])) } as any;

      await expect(pickNextInbox(db, "ws-1")).resolves.toEqual(inboxRow);
    });

    it("returns null when no active inbox exists", async () => {
      const db = { select: vi.fn().mockReturnValue(selectChain([])) } as any;
      await expect(pickNextInbox(db, "ws-1")).resolves.toBeNull();
    });
  });

  describe("markInboxUsed", () => {
    it("updates lastUsedAt and updatedAt for the given inbox", async () => {
      const where = vi.fn().mockResolvedValue(undefined);
      const set = vi.fn().mockReturnValue({ where });
      const db = { update: vi.fn().mockReturnValue({ set }) } as any;

      await markInboxUsed(db, "inbox-1");

      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ lastUsedAt: expect.any(Date), updatedAt: expect.any(Date) })
      );
      expect(where).toHaveBeenCalled();
    });
  });
});
