import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@skout/db";

const createNotification = vi.fn().mockResolvedValue({ id: "notif-1" });

vi.mock("../services/notification.service.js", () => ({
  createNotification: (...args: unknown[]) => createNotification(...args),
}));

const { sweepTasks, sweepSequenceSteps, sweepAiDrafts } = await import("./reminder-sweep.worker.js");

const { tasks, sequenceEnrollmentSteps, sequenceSteps, sequenceEnrollments, aiDrafts, notifications } = schema;

const NOW = new Date("2026-01-01T00:00:00.000Z");
const LEAD_CUTOFF = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
const STALE_CUTOFF = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

function selectChain(result: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.innerJoin = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockResolvedValue(result);
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sweepTasks", () => {
  it("creates a task_reminder notification for each due task", async () => {
    const due = [
      {
        id: "task-1",
        workspaceId: "ws-1",
        assignedTo: "user-1",
        title: "Follow up with Acme",
        type: "custom",
        dueDate: new Date("2026-01-01T12:00:00.000Z"),
      },
    ];
    const db = { select: vi.fn().mockReturnValue(selectChain(due)) };

    await sweepTasks(db as never, tasks, notifications, LEAD_CUTOFF);

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        workspaceId: "ws-1",
        userId: "user-1",
        type: "task_reminder",
        entityType: "task",
        entityId: "task-1",
        title: 'Task "Follow up with Acme" is due soon',
      })
    );
  });

  it("prefixes the reminder title with the task type when it isn't \"custom\"", async () => {
    const due = [
      {
        id: "task-3",
        workspaceId: "ws-1",
        assignedTo: "user-1",
        title: "Call Jane",
        type: "call",
        dueDate: new Date("2026-01-01T12:00:00.000Z"),
      },
    ];
    const db = { select: vi.fn().mockReturnValue(selectChain(due)) };

    await sweepTasks(db as never, tasks, notifications, LEAD_CUTOFF);

    expect(createNotification).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ title: 'Call "Call Jane" is due soon' })
    );
  });

  it("does nothing when no tasks are due", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };

    await sweepTasks(db as never, tasks, notifications, LEAD_CUTOFF);

    expect(createNotification).not.toHaveBeenCalled();
  });

  it("broadcasts (userId null) when the task is unassigned", async () => {
    const due = [
      {
        id: "task-2",
        workspaceId: "ws-1",
        assignedTo: null,
        title: "Unassigned task",
        type: "custom",
        dueDate: new Date("2026-01-01T12:00:00.000Z"),
      },
    ];
    const db = { select: vi.fn().mockReturnValue(selectChain(due)) };

    await sweepTasks(db as never, tasks, notifications, LEAD_CUTOFF);

    expect(createNotification).toHaveBeenCalledWith(db, expect.objectContaining({ userId: null }));
  });
});

describe("sweepSequenceSteps", () => {
  it("creates a sequence_reminder notification for each due manual step", async () => {
    const due = [
      {
        id: "step-1",
        workspaceId: "ws-1",
        scheduledAt: new Date("2026-01-01T12:00:00.000Z"),
        linkedinAction: "connect",
      },
    ];
    const db = { select: vi.fn().mockReturnValue(selectChain(due)) };

    await sweepSequenceSteps(
      db as never,
      sequenceEnrollmentSteps,
      sequenceSteps,
      sequenceEnrollments,
      notifications,
      LEAD_CUTOFF
    );

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        workspaceId: "ws-1",
        type: "sequence_reminder",
        entityType: "sequence_enrollment_step",
        entityId: "step-1",
        title: "LinkedIn connect is due soon",
      })
    );
  });

  it("does nothing when no steps are due", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };

    await sweepSequenceSteps(
      db as never,
      sequenceEnrollmentSteps,
      sequenceSteps,
      sequenceEnrollments,
      notifications,
      LEAD_CUTOFF
    );

    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe("sweepAiDrafts", () => {
  it("creates a draft_reminder notification for each stale draft", async () => {
    const due = [
      {
        id: "draft-1",
        workspaceId: "ws-1",
        subject: "Intro email",
        createdAt: new Date("2025-12-30T00:00:00.000Z"),
      },
    ];
    const db = { select: vi.fn().mockReturnValue(selectChain(due)) };

    await sweepAiDrafts(db as never, aiDrafts, notifications, STALE_CUTOFF);

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        workspaceId: "ws-1",
        type: "draft_reminder",
        entityType: "ai_draft",
        entityId: "draft-1",
        title: 'AI draft "Intro email" is awaiting review',
      })
    );
  });

  it("does nothing when no drafts are stale", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };

    await sweepAiDrafts(db as never, aiDrafts, notifications, STALE_CUTOFF);

    expect(createNotification).not.toHaveBeenCalled();
  });

  it("continues processing remaining drafts if one createNotification call fails", async () => {
    const due = [
      { id: "draft-1", workspaceId: "ws-1", subject: "First", createdAt: new Date("2025-12-30T00:00:00.000Z") },
      { id: "draft-2", workspaceId: "ws-1", subject: "Second", createdAt: new Date("2025-12-30T00:00:00.000Z") },
    ];
    const db = { select: vi.fn().mockReturnValue(selectChain(due)) };
    createNotification.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce({ id: "notif-2" });

    await sweepAiDrafts(db as never, aiDrafts, notifications, STALE_CUTOFF);

    expect(createNotification).toHaveBeenCalledTimes(2);
  });
});
