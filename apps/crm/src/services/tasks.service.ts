import { and, eq, gte, isNull, lt, lte } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { TaskCreateInput, TaskUpdateInput } from "@skout/shared";
import { HttpError } from "@skout/auth";
import type { AuditService } from "./audit.service.js";
import { createNotification, resolveNotificationsForEntity } from "./notifications.service.js";
import { serviceLog } from "../lib/obs.js";

const log = serviceLog("tasks");
const { tasks, workspaceMembers } = schema;

const TERMINAL_STATUSES = new Set(["done", "skipped"]);

export interface TaskDto {
  id: string;
  workspaceId: string;
  assignedTo: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  title: string;
  type: string;
  dueDate: string | null;
  priority: string;
  status: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toDto(row: typeof tasks.$inferSelect): TaskDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    assignedTo: row.assignedTo,
    relatedEntityType: row.relatedEntityType,
    relatedEntityId: row.relatedEntityId,
    title: row.title,
    type: row.type,
    dueDate: row.dueDate?.toISOString() ?? null,
    priority: row.priority,
    status: row.status,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function reminderTitle(task: { type: string; title: string }): string {
  return `${task.type === "custom" ? "Task" : task.type[0]!.toUpperCase() + task.type.slice(1)} "${task.title}" is due soon`;
}

export class TasksService {
  constructor(
    private readonly db: Db,
    private readonly auditService: AuditService,
    private readonly reminderLeadHours: number
  ) {}

  async list(
    workspaceId: string,
    options: {
      limit: number;
      offset: number;
      assignedTo?: string;
      status?: string;
      type?: string;
      relatedEntityType?: string;
      relatedEntityId?: string;
      dueBefore?: string;
      dueAfter?: string;
    }
  ): Promise<{ data: TaskDto[]; total: number }> {
    const conditions = [eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)];
    if (options.assignedTo) conditions.push(eq(tasks.assignedTo, options.assignedTo));
    if (options.status) conditions.push(eq(tasks.status, options.status));
    if (options.type) conditions.push(eq(tasks.type, options.type));
    if (options.relatedEntityType) conditions.push(eq(tasks.relatedEntityType, options.relatedEntityType));
    if (options.relatedEntityId) conditions.push(eq(tasks.relatedEntityId, options.relatedEntityId));
    if (options.dueBefore) conditions.push(lte(tasks.dueDate, new Date(options.dueBefore)));
    if (options.dueAfter) conditions.push(gte(tasks.dueDate, new Date(options.dueAfter)));

    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(...conditions))
      .limit(options.limit)
      .offset(options.offset);

    const all = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(...conditions));

    return { data: rows.map(toDto), total: all.length };
  }

  async getById(workspaceId: string, id: string): Promise<TaskDto | null> {
    const [row] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)))
      .limit(1);
    return row ? toDto(row) : null;
  }

  /** Assignment is restricted to real workspace members (R21.1 AC1). */
  private async assertWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
    const [member] = await this.db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .limit(1);
    if (!member) throw new HttpError("assignee_not_a_workspace_member", 422);
  }

  private async maybeScheduleReminder(dto: TaskDto): Promise<void> {
    if (dto.status !== "open" || !dto.dueDate) return;
    const leadCutoff = new Date(Date.now() + this.reminderLeadHours * 60 * 60 * 1000);
    if (new Date(dto.dueDate) > leadCutoff) return;

    await createNotification(this.db, {
      workspaceId: dto.workspaceId,
      userId: dto.assignedTo,
      type: "task_reminder",
      entityType: "task",
      entityId: dto.id,
      title: reminderTitle(dto),
      body: `Due ${dto.dueDate}`,
    });
  }

  async create(workspaceId: string, assignedTo: string | undefined, input: TaskCreateInput): Promise<TaskDto> {
    const owner = input.assignedTo ?? assignedTo;
    if (owner) await this.assertWorkspaceMember(workspaceId, owner);

    const [row] = await this.db
      .insert(tasks)
      .values({
        workspaceId,
        assignedTo: owner,
        relatedEntityType: input.relatedEntityType,
        relatedEntityId: input.relatedEntityId,
        title: input.title,
        type: input.type,
        dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
        priority: input.priority,
      })
      .returning();

    const dto = toDto(row!);
    await this.auditService.record(workspaceId, assignedTo, "create", "task", dto.id, null, dto);
    log.info("task created", { workspaceId, taskId: row!.id, status: row!.status });

    // R21.3 AC1 — creating a task with a near-term due date auto-schedules its reminder
    // immediately, rather than waiting for the next periodic sweep tick to notice it.
    await this.maybeScheduleReminder(dto);

    return dto;
  }

  async update(
    workspaceId: string,
    id: string,
    actorId: string | undefined,
    input: TaskUpdateInput
  ): Promise<TaskDto | null> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return null;

    if (input.assignedTo) await this.assertWorkspaceMember(workspaceId, input.assignedTo);

    const nextStatus = input.status ?? existing.status;
    const enteringTerminal = input.status !== undefined && TERMINAL_STATUSES.has(input.status) && !TERMINAL_STATUSES.has(existing.status);
    const leavingTerminal = input.status !== undefined && !TERMINAL_STATUSES.has(input.status) && TERMINAL_STATUSES.has(existing.status);

    const [row] = await this.db
      .update(tasks)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.assignedTo !== undefined ? { assignedTo: input.assignedTo } : {}),
        ...(input.relatedEntityType !== undefined ? { relatedEntityType: input.relatedEntityType } : {}),
        ...(input.relatedEntityId !== undefined ? { relatedEntityId: input.relatedEntityId } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.dueDate !== undefined ? { dueDate: new Date(input.dueDate) } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(enteringTerminal ? { completedAt: new Date() } : {}),
        ...(leavingTerminal ? { completedAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)))
      .returning();

    const dto = row ? toDto(row) : null;
    if (dto) {
      await this.auditService.record(workspaceId, actorId, "update", "task", id, existing, dto);
    }
    if (row) log.info("task updated", { workspaceId, taskId: id, status: row.status });

    if (dto) {
      if (TERMINAL_STATUSES.has(nextStatus)) {
        // R21.3 AC2 — done or skipped cancels any pending reminder.
        await resolveNotificationsForEntity(this.db, "task", id);
      } else if (input.dueDate !== undefined) {
        // Due date changed on a still-open task — the old reminder (if any) referenced the
        // stale due date, so clear it and let a fresh one reflect the new date (R21.3 AC1).
        await resolveNotificationsForEntity(this.db, "task", id);
        await this.maybeScheduleReminder(dto);
      }
    }

    return dto;
  }

  async complete(workspaceId: string, id: string): Promise<TaskDto | null> {
    return this.update(workspaceId, id, undefined, { status: "done" });
  }

  async skip(workspaceId: string, id: string): Promise<TaskDto | null> {
    return this.update(workspaceId, id, undefined, { status: "skipped" });
  }

  async softDelete(workspaceId: string, id: string, actorId: string | undefined): Promise<boolean> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return false;

    const [row] = await this.db
      .update(tasks)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)))
      .returning();

    const dto = row ? toDto(row) : null;
    if (dto) {
      await this.auditService.record(workspaceId, actorId, "delete", "task", id, existing, dto);
    }
    await resolveNotificationsForEntity(this.db, "task", id);
    log.info("task soft-deleted", { workspaceId, taskId: id });
    return true;
  }

  /** Open, overdue, and due-today task counts for the dashboard overview (R21.2). */
  async counts(workspaceId: string): Promise<{ open: number; overdue: number; dueToday: number }> {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

    const openRows = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "open"), isNull(tasks.deletedAt)));

    const overdueRows = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          eq(tasks.status, "open"),
          isNull(tasks.deletedAt),
          lt(tasks.dueDate, startOfToday)
        )
      );

    const dueTodayRows = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          eq(tasks.status, "open"),
          isNull(tasks.deletedAt),
          gte(tasks.dueDate, startOfToday),
          lt(tasks.dueDate, startOfTomorrow)
        )
      );

    return { open: openRows.length, overdue: overdueRows.length, dueToday: dueTodayRows.length };
  }
}

export function buildTasksService(
  db: Db | null,
  auditService: AuditService | null,
  reminderLeadHours: number
): TasksService | null {
  return db && auditService ? new TasksService(db, auditService, reminderLeadHours) : null;
}
