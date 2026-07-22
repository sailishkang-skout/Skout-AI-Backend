import { and, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { TaskCreateInput, TaskUpdateInput } from "@skout/shared";
import type { AuditService } from "./audit.service.js";

const { tasks } = schema;

export interface TaskDto {
  id: string;
  workspaceId: string;
  assignedTo: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  title: string;
  dueDate: string | null;
  priority: string;
  status: string;
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
    dueDate: row.dueDate?.toISOString() ?? null,
    priority: row.priority,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class TasksService {
  constructor(
    private readonly db: Db,
    private readonly auditService: AuditService
  ) {}

  async list(
    workspaceId: string,
    options: {
      limit: number;
      offset: number;
      assignedTo?: string;
      status?: string;
      relatedEntityType?: string;
      relatedEntityId?: string;
    }
  ): Promise<{ data: TaskDto[]; total: number }> {
    const conditions = [eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)];
    if (options.assignedTo) conditions.push(eq(tasks.assignedTo, options.assignedTo));
    if (options.status) conditions.push(eq(tasks.status, options.status));
    if (options.relatedEntityType) conditions.push(eq(tasks.relatedEntityType, options.relatedEntityType));
    if (options.relatedEntityId) conditions.push(eq(tasks.relatedEntityId, options.relatedEntityId));

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

  async create(workspaceId: string, assignedTo: string | undefined, input: TaskCreateInput): Promise<TaskDto> {
    const [row] = await this.db
      .insert(tasks)
      .values({
        workspaceId,
        assignedTo: input.assignedTo ?? assignedTo,
        relatedEntityType: input.relatedEntityType,
        relatedEntityId: input.relatedEntityId,
        title: input.title,
        dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
        priority: input.priority,
      })
      .returning();

    const dto = toDto(row);
    await this.auditService.record(workspaceId, assignedTo, "create", "task", dto.id, null, dto);
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

    const [row] = await this.db
      .update(tasks)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.assignedTo !== undefined ? { assignedTo: input.assignedTo } : {}),
        ...(input.relatedEntityType !== undefined ? { relatedEntityType: input.relatedEntityType } : {}),
        ...(input.relatedEntityId !== undefined ? { relatedEntityId: input.relatedEntityId } : {}),
        ...(input.dueDate !== undefined ? { dueDate: new Date(input.dueDate) } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)))
      .returning();

    const dto = row ? toDto(row) : null;
    if (dto) {
      await this.auditService.record(workspaceId, actorId, "update", "task", id, existing, dto);
    }
    return dto;
  }

  async complete(workspaceId: string, id: string): Promise<TaskDto | null> {
    return this.update(workspaceId, id, undefined, { status: "done" });
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
    return true;
  }

  /** Open + overdue task counts for the dashboard overview. */
  async counts(workspaceId: string): Promise<{ open: number; overdue: number }> {
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
          lt(tasks.dueDate, new Date())
        )
      );

    return { open: openRows.length, overdue: overdueRows.length };
  }
}

export function buildTasksService(db: Db | null, auditService: AuditService | null): TasksService | null {
  return db && auditService ? new TasksService(db, auditService) : null;
}
