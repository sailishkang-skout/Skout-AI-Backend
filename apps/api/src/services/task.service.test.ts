import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveNotificationsForEntity = vi.fn().mockResolvedValue(0);

vi.mock("./notification.service.js", () => ({
  resolveNotificationsForEntity: (...args: unknown[]) => resolveNotificationsForEntity(...args),
}));

const { updateTaskStatus } = await import("./task.service.js");

const WORKSPACE = "ws-1";
const TASK_ID = "task-1";

const ROW = {
  id: TASK_ID,
  workspaceId: WORKSPACE,
  assignedTo: "user-1",
  title: "Follow up with Acme",
  dueDate: new Date("2026-01-05T00:00:00.000Z"),
  priority: "medium",
  status: "open",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function updateReturning(result: unknown[]) {
  return {
    set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("updateTaskStatus", () => {
  it("returns null when no matching task is found", async () => {
    const db = { update: vi.fn().mockReturnValue(updateReturning([])) };
    const result = await updateTaskStatus(db as never, WORKSPACE, TASK_ID, "completed");
    expect(result).toBeNull();
    expect(resolveNotificationsForEntity).not.toHaveBeenCalled();
  });

  it("updates status and returns the serialized record without resolving reminders when reopening", async () => {
    const row = { ...ROW, status: "open" };
    const db = { update: vi.fn().mockReturnValue(updateReturning([row])) };
    const result = await updateTaskStatus(db as never, WORKSPACE, TASK_ID, "open");
    expect(result).toMatchObject({ id: TASK_ID, status: "open" });
    expect(resolveNotificationsForEntity).not.toHaveBeenCalled();
  });

  it("resolves any pending reminder for the task when marked completed", async () => {
    const row = { ...ROW, status: "completed" };
    const db = { update: vi.fn().mockReturnValue(updateReturning([row])) };
    const result = await updateTaskStatus(db as never, WORKSPACE, TASK_ID, "completed");
    expect(result).toMatchObject({ id: TASK_ID, status: "completed" });
    expect(resolveNotificationsForEntity).toHaveBeenCalledWith(db, "task", TASK_ID);
  });
});
