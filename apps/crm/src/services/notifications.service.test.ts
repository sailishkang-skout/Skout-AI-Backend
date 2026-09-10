import { describe, expect, it, vi } from "vitest";
import { createNotification, resolveNotificationsForEntity } from "./notifications.service.js";

describe("createNotification", () => {
  it("inserts a notification row with the given fields", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn().mockReturnValue({ values }) };

    await createNotification(db as never, {
      workspaceId: "ws-1",
      userId: "user-1",
      type: "task_reminder",
      entityType: "task",
      entityId: "task-1",
      title: "Task due soon",
      body: "Due 2026-01-01T00:00:00.000Z",
    });

    expect(values).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "user-1",
      type: "task_reminder",
      entityType: "task",
      entityId: "task-1",
      title: "Task due soon",
      body: "Due 2026-01-01T00:00:00.000Z",
    });
  });

  it("defaults userId and body to null when omitted (broadcast notification)", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn().mockReturnValue({ values }) };

    await createNotification(db as never, {
      workspaceId: "ws-1",
      type: "sequence_reminder",
      entityType: "sequence_enrollment_step",
      entityId: "step-1",
      title: "LinkedIn step is due soon",
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null, body: null })
    );
  });
});

describe("resolveNotificationsForEntity", () => {
  it("marks unread notifications for the entity as read", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockReturnValue({ where });
    const db = { update: vi.fn().mockReturnValue({ set }) };

    await resolveNotificationsForEntity(db as never, "task", "task-1");

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ readAt: expect.any(Date) }));
    expect(where).toHaveBeenCalled();
  });
});
