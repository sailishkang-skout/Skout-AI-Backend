import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@skout/auth";

const createNotification = vi.fn().mockResolvedValue(undefined);
const resolveNotificationsForEntity = vi.fn().mockResolvedValue(undefined);

vi.mock("./notifications.service.js", () => ({
  createNotification: (...args: unknown[]) => createNotification(...args),
  resolveNotificationsForEntity: (...args: unknown[]) => resolveNotificationsForEntity(...args),
}));

const { TasksService } = await import("./tasks.service.js");

const WORKSPACE = "ws-1";
const NOW = new Date("2026-01-01T00:00:00.000Z");
const LEAD_HOURS = 24;

const BASE_TASK_ROW = {
  id: "task-1",
  workspaceId: WORKSPACE,
  assignedTo: null,
  relatedEntityType: null,
  relatedEntityId: null,
  title: "Follow up",
  type: "custom",
  dueDate: null,
  priority: "medium",
  status: "open",
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function selectChain(result: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.limit = vi.fn().mockResolvedValue(result);
  return c;
}

function auditService() {
  return { record: vi.fn().mockResolvedValue(undefined) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

/** The service writes the task and its TaskCreated event in one transaction; the mock runs it inline. */
function withTx(db: Record<string, unknown>): never {
  const tx = { ...db, insert: db.insert };
  return { ...db, transaction: (fn: (t: unknown) => unknown) => fn(tx) } as never;
}

describe("TasksService.create — workspace-member validation (R21.1 AC1)", () => {
  it("throws 422 and does not insert when assignedTo isn't a workspace member", async () => {
    const select = vi.fn().mockReturnValueOnce(selectChain([])); // membership check: no match
    const insert = vi.fn();
    const db = withTx({ select, insert });
    const service = new TasksService(db, auditService(), LEAD_HOURS);

    await expect(
      service.create(WORKSPACE, undefined, {
        title: "Assign to outsider",
        assignedTo: "not-a-member",
        type: "custom",
        priority: "medium",
      })
    ).rejects.toThrow(HttpError);
    expect(insert).not.toHaveBeenCalled();
  });

  it("proceeds when assignedTo is a real workspace member", async () => {
    const select = vi.fn().mockReturnValueOnce(selectChain([{ userId: "member-1" }]));
    const returning = vi.fn().mockResolvedValue([{ ...BASE_TASK_ROW, assignedTo: "member-1" }]);
    const insert = vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning }) });
    const db = withTx({ select, insert });
    const service = new TasksService(db, auditService(), LEAD_HOURS);

    const result = await service.create(WORKSPACE, undefined, {
      title: "Assign to member",
      assignedTo: "member-1",
      type: "custom",
      priority: "medium",
    });
    expect(result.assignedTo).toBe("member-1");
  });
});

describe("TasksService.create — reminder auto-scheduling (R21.3 AC1)", () => {
  it("schedules a reminder when the due date is inside the lead window", async () => {
    const dueSoon = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
    const returning = vi.fn().mockResolvedValue([{ ...BASE_TASK_ROW, dueDate: dueSoon }]);
    const insert = vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning }) });
    const db = withTx({ select: vi.fn(), insert });
    const service = new TasksService(db, auditService(), LEAD_HOURS);

    await service.create(WORKSPACE, undefined, {
      title: "Due soon",
      dueDate: dueSoon.toISOString(),
      type: "custom",
      priority: "medium",
    });

    expect(createNotification).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ workspaceId: WORKSPACE, entityType: "task", entityId: "task-1", type: "task_reminder" })
    );
  });

  it("does not schedule a reminder when the due date is far in the future", async () => {
    const farFuture = new Date(NOW.getTime() + 90 * 24 * 60 * 60 * 1000);
    const returning = vi.fn().mockResolvedValue([{ ...BASE_TASK_ROW, dueDate: farFuture }]);
    const insert = vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning }) });
    const db = withTx({ select: vi.fn(), insert });
    const service = new TasksService(db, auditService(), LEAD_HOURS);

    await service.create(WORKSPACE, undefined, {
      title: "Not due soon",
      dueDate: farFuture.toISOString(),
      type: "custom",
      priority: "medium",
    });

    expect(createNotification).not.toHaveBeenCalled();
  });

  it("does not schedule a reminder when there is no due date", async () => {
    const returning = vi.fn().mockResolvedValue([{ ...BASE_TASK_ROW }]);
    const insert = vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning }) });
    const db = withTx({ select: vi.fn(), insert });
    const service = new TasksService(db, auditService(), LEAD_HOURS);

    await service.create(WORKSPACE, undefined, { title: "No due date", type: "custom", priority: "medium" });

    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe("TasksService.update — completedAt + reminder cancellation (R21.1 AC3, R21.3 AC2)", () => {
  it("sets completedAt and cancels the reminder when status moves to done", async () => {
    const select = vi.fn().mockReturnValueOnce(selectChain([BASE_TASK_ROW])); // getById (existing)
    const updateSet = vi.fn();
    const update = vi.fn().mockReturnValue({
      set: updateSet.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...BASE_TASK_ROW, status: "done", completedAt: NOW }]),
        }),
      }),
    });
    const db = { select, update } as never;
    const service = new TasksService(db, auditService(), LEAD_HOURS);

    const result = await service.update(WORKSPACE, "task-1", "actor-1", { status: "done" });

    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ completedAt: NOW, status: "done" }));
    expect(resolveNotificationsForEntity).toHaveBeenCalledWith(db, "task", "task-1");
    expect(result?.status).toBe("done");
  });

  it("sets completedAt and cancels the reminder when status moves to skipped", async () => {
    const select = vi.fn().mockReturnValueOnce(selectChain([BASE_TASK_ROW]));
    const updateSet = vi.fn();
    const update = vi.fn().mockReturnValue({
      set: updateSet.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...BASE_TASK_ROW, status: "skipped", completedAt: NOW }]),
        }),
      }),
    });
    const db = { select, update } as never;
    const service = new TasksService(db, auditService(), LEAD_HOURS);

    await service.update(WORKSPACE, "task-1", "actor-1", { status: "skipped" });

    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ completedAt: NOW, status: "skipped" }));
    expect(resolveNotificationsForEntity).toHaveBeenCalledWith(db, "task", "task-1");
  });

  it("clears completedAt when a done task is reopened", async () => {
    const doneRow = { ...BASE_TASK_ROW, status: "done", completedAt: NOW };
    const select = vi.fn().mockReturnValueOnce(selectChain([doneRow]));
    const updateSet = vi.fn();
    const update = vi.fn().mockReturnValue({
      set: updateSet.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...BASE_TASK_ROW, status: "open", completedAt: null }]),
        }),
      }),
    });
    const db = { select, update } as never;
    const service = new TasksService(db, auditService(), LEAD_HOURS);

    await service.update(WORKSPACE, "task-1", "actor-1", { status: "open" });

    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ completedAt: null, status: "open" }));
    // Reopening isn't itself a "new due date" — no fresh reminder should be scheduled.
    expect(createNotification).not.toHaveBeenCalled();
  });

  it("re-schedules the reminder when the due date changes on an open task", async () => {
    const select = vi.fn().mockReturnValueOnce(selectChain([BASE_TASK_ROW]));
    const newDue = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);
    const updateSet = vi.fn();
    const update = vi.fn().mockReturnValue({
      set: updateSet.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...BASE_TASK_ROW, dueDate: newDue }]),
        }),
      }),
    });
    const db = { select, update } as never;
    const service = new TasksService(db, auditService(), LEAD_HOURS);

    await service.update(WORKSPACE, "task-1", "actor-1", { dueDate: newDue.toISOString() });

    expect(resolveNotificationsForEntity).toHaveBeenCalledWith(db, "task", "task-1");
    expect(createNotification).toHaveBeenCalledWith(db, expect.objectContaining({ entityId: "task-1" }));
  });

  it("returns null when the task doesn't exist", async () => {
    const select = vi.fn().mockReturnValueOnce(selectChain([]));
    const db = { select, update: vi.fn() } as never;
    const service = new TasksService(db, auditService(), LEAD_HOURS);

    const result = await service.update(WORKSPACE, "missing", "actor-1", { status: "done" });
    expect(result).toBeNull();
  });
});

describe("TasksService.softDelete — cancels the reminder too", () => {
  it("resolves any pending reminder when a task is deleted", async () => {
    const select = vi.fn().mockReturnValueOnce(selectChain([BASE_TASK_ROW]));
    const update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...BASE_TASK_ROW, deletedAt: NOW }]),
        }),
      }),
    });
    const db = { select, update } as never;
    const service = new TasksService(db, auditService(), LEAD_HOURS);

    await service.softDelete(WORKSPACE, "task-1", "actor-1");

    expect(resolveNotificationsForEntity).toHaveBeenCalledWith(db, "task", "task-1");
  });
});

describe("TasksService.create — CustomerOps TaskCreated event", () => {
  const TASK_ID = "11111111-1111-4111-8111-111111111111";
  const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
  const WS = "33333333-3333-4333-8333-333333333333";

  it("writes TaskCreated in the same transaction when the task belongs to an account", async () => {
    const returning = vi.fn().mockResolvedValue([{ ...BASE_TASK_ROW, id: TASK_ID, workspaceId: WS, relatedEntityType: "company", relatedEntityId: ACCOUNT_ID, type: "call" }]);
    const values = vi.fn().mockReturnValue({ returning });
    const insert = vi.fn().mockReturnValue({ values });
    const service = new TasksService(withTx({ select: vi.fn(), insert }), auditService(), LEAD_HOURS);
    await service.create(WS, undefined, { title: "Kickoff call", type: "call", relatedEntityType: "company", relatedEntityId: ACCOUNT_ID } as never);
    expect(insert).toHaveBeenCalledTimes(2);
    const outbox = values.mock.calls[1]![0] as { eventType: string; aggregateId: string };
    expect(outbox.eventType).toBe("TaskCreated");
    expect(outbox.aggregateId).toBe(ACCOUNT_ID);
  });

  it("writes no event for a task that is not tied to an account", async () => {
    const returning = vi.fn().mockResolvedValue([{ ...BASE_TASK_ROW, id: TASK_ID, workspaceId: WS, relatedEntityType: null, relatedEntityId: null }]);
    const insert = vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning }) });
    const service = new TasksService(withTx({ select: vi.fn(), insert }), auditService(), LEAD_HOURS);
    await service.create(WS, undefined, { title: "Personal note", type: "todo" } as never);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
