import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { resolveNotificationsForEntity } from "./notification.service.js";

const { tasks } = schema;

export const TASK_STATUSES = ["open", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskRecord {
  id: string;
  workspaceId: string;
  assignedTo: string | null;
  title: string;
  dueDate: string | null;
  priority: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

function serialize(row: typeof tasks.$inferSelect): TaskRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    assignedTo: row.assignedTo,
    title: row.title,
    dueDate: row.dueDate?.toISOString() ?? null,
    priority: row.priority,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Minimal task status transition (R17.2) — just enough surface to prove reminder auto-resolve
 * (AC2). Full task CRUD (create/list/assign) is out of scope for this ticket.
 */
export async function updateTaskStatus(
  db: Db,
  workspaceId: string,
  taskId: string,
  status: TaskStatus
): Promise<TaskRecord | null> {
  const [row] = await db
    .update(tasks)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)))
    .returning();
  if (!row) return null;

  if (status === "completed") {
    await resolveNotificationsForEntity(db, "task", taskId);
  }

  return serialize(row);
}
