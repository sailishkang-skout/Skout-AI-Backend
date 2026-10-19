/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-10 additions).
 *   - Tables touched directly: tasks (insert), companies (read the owner)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: the workflow "create task" action, the same insert COPS-05 playbooks make.
 *   - Review date: 2026-10-19
 */
import { and, eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { appendCopsEvent, createCopsEvent } from "@skout/shared";
import { HttpError } from "../../utils/http.js";
import type { NodeHandler } from "./types.js";
import { withStepEffect } from "./step-effect.js";

const { tasks, companies } = schema;
export const TASK_TYPES = ["call", "email", "meeting", "review", "approval", "onboarding_check", "renewal_action", "ticket_follow_up", "follow_up"] as const;
const PRIORITIES = ["low", "medium", "high"] as const;

/**
 * COPS-10 "create task" (Bible p.68). Config: { title; type?; priority?; dueInHours?; assignTo? }.
 * The task belongs to the run's account and goes to the account owner unless assignTo names a
 * user. Emits TaskCreated, and runs once per step.
 */
export const createTaskActionNodeHandler: NodeHandler = async (ctx) => {
  const config = ctx.node.config as { title?: string; type?: string; priority?: string; dueInHours?: number | string; assignTo?: string };
  const title = config.title?.trim();
  if (!title) throw new HttpError("Create task needs a title", 422);
  const type = (TASK_TYPES as readonly string[]).includes(config.type ?? "") ? config.type! : "follow_up";
  const priority = (PRIORITIES as readonly string[]).includes(config.priority ?? "") ? config.priority! : "medium";
  const accountId = ctx.subject?.type === "account" ? ctx.subject.id : null;
  if (!accountId) throw new HttpError("Create task needs a run about an account", 422);
  const hours = Number(config.dueInHours ?? 24);
  const dueDate = new Date(Date.now() + (Number.isFinite(hours) && hours >= 0 ? hours : 24) * 3600_000);

  if (ctx.isSimulation) return { output: { simulated: true, title, type, priority, accountId } };

  const output = await withStepEffect(ctx, "task", async (tx) => {
    const [account] = await tx
      .select({ ownerId: companies.ownerId })
      .from(companies)
      .where(and(eq(companies.id, accountId), eq(companies.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (!account) throw new HttpError("The run's account is not in this workspace", 422);
    const [task] = await tx
      .insert(tasks)
      .values({
        workspaceId: ctx.workspaceId,
        assignedTo: config.assignTo && config.assignTo !== "account_owner" ? config.assignTo : account.ownerId ?? null,
        relatedEntityType: "company",
        relatedEntityId: accountId,
        title: title.slice(0, 500),
        type,
        dueDate,
        priority,
      })
      .returning({ id: tasks.id, assignedTo: tasks.assignedTo });
    await appendCopsEvent(
      tx as never,
      createCopsEvent({
        eventType: "TaskCreated",
        tenantId: ctx.workspaceId,
        aggregateType: "account",
        aggregateId: accountId,
        actor: { type: "system", id: null },
        correlationId: ctx.runId,
        payload: { task_id: task!.id, account_id: accountId, task_type: type },
      })
    );
    return { taskId: task!.id, assignedTo: task!.assignedTo };
  });
  return { output };
};
