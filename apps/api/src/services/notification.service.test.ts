import { describe, expect, it, vi } from "vitest";
import {
  createNotification,
  getUnreadCount,
  listNotifications,
  markAllRead,
  markRead,
  resolveNotificationsForEntity,
} from "./notification.service.js";

const WORKSPACE = "ws-1";
const USER = "user-1";

const ROW = {
  id: "notif-1",
  workspaceId: WORKSPACE,
  userId: USER,
  type: "task_reminder",
  entityType: "task",
  entityId: "task-1",
  title: "Task due soon",
  body: null,
  readAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function selectChain(result: unknown[], terminal: "where" | "orderBy" | "limit" = "where") {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = terminal === "where" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.orderBy = terminal === "orderBy" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.limit = terminal === "limit" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  return c;
}

function insertReturning(result: unknown[]) {
  return { values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) };
}

function updateReturning(result: unknown[]) {
  return { set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) }) };
}

describe("createNotification", () => {
  it("inserts a row and returns the serialized record", async () => {
    const db = { insert: vi.fn().mockReturnValue(insertReturning([ROW])) };
    const result = await createNotification(db as never, {
      workspaceId: WORKSPACE,
      userId: USER,
      type: "task_reminder",
      entityType: "task",
      entityId: "task-1",
      title: "Task due soon",
    });
    expect(result).toMatchObject({ id: "notif-1", type: "task_reminder", readAt: null });
  });
});

describe("listNotifications", () => {
  it("returns [] when nothing matches", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([], "limit")) };
    const result = await listNotifications(db as never, WORKSPACE, USER);
    expect(result).toEqual([]);
  });

  it("serializes rows with ISO date strings and null readAt", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([ROW], "limit")) };
    const result = await listNotifications(db as never, WORKSPACE, USER);
    expect(result).toEqual([
      {
        id: "notif-1",
        workspaceId: WORKSPACE,
        userId: USER,
        type: "task_reminder",
        entityType: "task",
        entityId: "task-1",
        title: "Task due soon",
        body: null,
        readAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("passes the limit through to the query", async () => {
    const chain = selectChain([], "limit");
    const db = { select: vi.fn().mockReturnValue(chain) };
    await listNotifications(db as never, WORKSPACE, USER, { limit: 5 });
    expect((chain.limit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(5);
  });

  it("defaults the limit to 50", async () => {
    const chain = selectChain([], "limit");
    const db = { select: vi.fn().mockReturnValue(chain) };
    await listNotifications(db as never, WORKSPACE, USER);
    expect((chain.limit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(50);
  });
});

describe("getUnreadCount", () => {
  it("returns the count from the aggregate row", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([{ value: 3 }], "where")) };
    const result = await getUnreadCount(db as never, WORKSPACE, USER);
    expect(result).toBe(3);
  });

  it("returns 0 when no row comes back", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([], "where")) };
    const result = await getUnreadCount(db as never, WORKSPACE, USER);
    expect(result).toBe(0);
  });
});

describe("markRead", () => {
  it("returns the updated record when found", async () => {
    const readRow = { ...ROW, readAt: new Date("2026-01-02T00:00:00.000Z") };
    const db = { update: vi.fn().mockReturnValue(updateReturning([readRow])) };
    const result = await markRead(db as never, WORKSPACE, USER, "notif-1");
    expect(result?.readAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("returns null when nothing matched (already read, wrong workspace, etc.)", async () => {
    const db = { update: vi.fn().mockReturnValue(updateReturning([])) };
    const result = await markRead(db as never, WORKSPACE, USER, "notif-1");
    expect(result).toBeNull();
  });
});

describe("markAllRead", () => {
  it("returns the count of rows marked", async () => {
    const db = { update: vi.fn().mockReturnValue(updateReturning([{ id: "a" }, { id: "b" }])) };
    const result = await markAllRead(db as never, WORKSPACE, USER);
    expect(result).toBe(2);
  });
});

describe("resolveNotificationsForEntity", () => {
  it("marks matching unread notifications as read and returns the count", async () => {
    const db = { update: vi.fn().mockReturnValue(updateReturning([{ id: "notif-1" }])) };
    const result = await resolveNotificationsForEntity(db as never, "task", "task-1");
    expect(result).toBe(1);
  });

  it("returns 0 when nothing was unread for that entity", async () => {
    const db = { update: vi.fn().mockReturnValue(updateReturning([])) };
    const result = await resolveNotificationsForEntity(db as never, "task", "task-1");
    expect(result).toBe(0);
  });
});
