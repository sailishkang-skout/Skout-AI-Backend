import { and, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { appendActivityRecorded, appendCopsEvent, createCopsEvent } from "@skout/shared";
import type { MailOptions, SendMailResult } from "./mail.service.js";
import { escapeHtml, renderTransactionalLayout } from "./mail.service.js";
import { canContact, CAN_CONTACT_MESSAGE, type CanContactBlock } from "./cops-can-contact.js";

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-05 additions).
 *   - Tables touched directly: companies, contacts - read; activities, tasks, meetings - write (owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: the action, its activity and its ActivityRecorded event commit in one transaction
 *     ("every one-click action writes a timeline activity").
 *   - Review date: revisit when apps/crm's internal API covers transactional writes
 */

/**
 * COPS-05 one-click actions from the rep queue (Bible p.64): call, email, meeting, task. Every
 * action writes an activity on the account with its ActivityRecorded event, in the same transaction
 * as the action itself; an email goes through canContact(outreach) first. Acting on a queue item
 * that is a task (due task or playbook task) completes that task.
 */
const { companies, contacts, activities, tasks, meetings, copsOnboardingSignals } = schema;

export type FollowUpActionKind = "call" | "email" | "meeting" | "task";

export interface FollowUpActionInput {
  kind: FollowUpActionKind;
  account_id: string;
  contact_id?: string;
  queue_item_id?: string;
  subject?: string;
  body?: string;
  due_at?: string;
  outcome?: string;
}

export class FollowUpActionError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "VALIDATION_FAILED" | "CONTACT_BLOCKED" | "EMAIL_NOT_SENT",
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
  get status(): number {
    return { NOT_FOUND: 404, VALIDATION_FAILED: 422, CONTACT_BLOCKED: 409, EMAIL_NOT_SENT: 502 }[this.code];
  }
}

export interface FollowUpActionDeps {
  config: Parameters<typeof canContact>[1];
  send: (mail: MailOptions) => Promise<SendMailResult>;
}

/** The task a queue item points at: `task:<id>` directly, `signal:<id>` through the playbook signal. */
async function queueTaskId(db: Db, workspaceId: string, queueItemId?: string): Promise<string | null> {
  if (!queueItemId) return null;
  const [prefix, id] = queueItemId.split(":");
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (prefix === "task") return id;
  if (prefix === "signal") {
    const [s] = await db
      .select({ taskId: copsOnboardingSignals.taskId })
      .from(copsOnboardingSignals)
      .where(and(eq(copsOnboardingSignals.workspaceId, workspaceId), eq(copsOnboardingSignals.id, id)));
    return s?.taskId ?? null;
  }
  return null;
}

export async function performFollowUpAction(
  db: Db,
  ctx: { workspaceId: string; userId: string; requestId: string },
  input: FollowUpActionInput,
  deps: FollowUpActionDeps
): Promise<{ activity_id: string; task_id: string | null; email_send_id: string | null; meeting_id: string | null }> {
  const ws = ctx.workspaceId;
  const [account] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.workspaceId, ws), eq(companies.id, input.account_id), isNull(companies.deletedAt)));
  if (!account) throw new FollowUpActionError("NOT_FOUND", "Account not found");
  const contact = input.contact_id
    ? (
        await db
          .select({ id: contacts.id, email: contacts.email, firstName: contacts.firstName, prospectId: contacts.sourceProspectId })
          .from(contacts)
          .where(and(eq(contacts.workspaceId, ws), eq(contacts.id, input.contact_id), eq(contacts.companyId, account.id)))
      )[0]
    : undefined;
  if (input.contact_id && !contact) throw new FollowUpActionError("NOT_FOUND", "Contact not found on this account");
  const due = input.due_at ? new Date(input.due_at) : null;
  if ((input.kind === "meeting" || input.kind === "task") && (!due || Number.isNaN(due.getTime()))) {
    throw new FollowUpActionError("VALIDATION_FAILED", "due_at is required for a meeting or a task", { fields: [{ path: "due_at", message: "Required" }] });
  }

  // An email is sent before anything is written, so a refused or failed send leaves no activity.
  let emailMessageId: string | null = null;
  if (input.kind === "email") {
    if (!contact?.email) throw new FollowUpActionError("VALIDATION_FAILED", "An email needs a contact with an email address", { fields: [{ path: "contact_id", message: "Required" }] });
    if (!input.subject || !input.body) {
      throw new FollowUpActionError("VALIDATION_FAILED", "An email needs a subject and a body", { fields: [{ path: input.subject ? "body" : "subject", message: "Required" }] });
    }
    const gate = await canContact(db, deps.config, { workspaceId: ws, email: contact.email, contactId: contact.id, prospectId: contact.prospectId, purpose: "outreach" });
    if (!gate.allowed) throw new FollowUpActionError("CONTACT_BLOCKED", CAN_CONTACT_MESSAGE[gate.reason as CanContactBlock], { reason: gate.reason });
    const sent = await deps
      .send({
        to: contact.email,
        subject: input.subject,
        text: input.body,
        html: renderTransactionalLayout({ preheader: input.subject, title: input.subject, bodyHtml: `<p style="white-space:pre-wrap;margin:0;">${escapeHtml(input.body)}</p>` }),
      })
      .catch(() => ({ sent: false }) as SendMailResult);
    if (!sent.sent) throw new FollowUpActionError("EMAIL_NOT_SENT", "The email provider did not accept the message");
    emailMessageId = sent.messageId ?? null;
  }

  const completesTaskId = await queueTaskId(db, ws, input.queue_item_id);
  const subject =
    input.kind === "call"
      ? `Call${contact?.firstName ? ` with ${contact.firstName}` : ""}: ${input.outcome ?? input.subject ?? "logged"}`
      : input.kind === "email"
        ? `Email: ${input.subject}`
        : input.kind === "meeting"
          ? `Meeting booked: ${input.subject ?? "follow-up"}`
          : `Task: ${input.subject ?? "follow-up"}`;

  return db.transaction(async (tx) => {
    let taskId: string | null = null;
    let meetingId: string | null = null;
    if (input.kind === "task") {
      const [t] = await tx
        .insert(tasks)
        .values({
          workspaceId: ws,
          assignedTo: ctx.userId,
          relatedEntityType: "company",
          relatedEntityId: account.id,
          title: input.subject ?? "Follow-up",
          type: "follow-up",
          dueDate: due,
        })
        .returning({ id: tasks.id });
      taskId = t!.id;
      await appendCopsEvent(
        tx as never,
        createCopsEvent({
          eventType: "TaskCreated",
          tenantId: ws,
          aggregateType: "account",
          aggregateId: account.id,
          actor: { type: "user", id: ctx.userId },
          correlationId: ctx.requestId,
          payload: { task_id: taskId, account_id: account.id, task_type: "follow-up" },
        })
      );
    }
    if (input.kind === "meeting") {
      const [m] = await tx
        .insert(meetings)
        .values({
          workspaceId: ws,
          companyId: account.id,
          contactId: contact?.id ?? null,
          organizerId: ctx.userId,
          title: input.subject ?? `Follow-up with ${account.name}`,
          scheduledAt: due!,
        })
        .returning({ id: meetings.id });
      meetingId = m!.id;
    }
    const [activity] = await tx
      .insert(activities)
      .values({
        workspaceId: ws,
        entityType: "company",
        entityId: account.id,
        activityType: input.kind,
        subject,
        body: input.kind === "email" ? input.body! : (input.body ?? input.outcome ?? null),
        ownerId: ctx.userId,
      })
      .returning({ id: activities.id });
    await appendActivityRecorded(tx as never, {
      workspaceId: ws,
      activityId: activity!.id,
      activityType: input.kind,
      entityType: "company",
      entityId: account.id,
      subject,
      actorUserId: ctx.userId,
      correlationId: ctx.requestId,
    });
    if (completesTaskId) {
      const [done] = await tx
        .update(tasks)
        .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(tasks.workspaceId, ws), eq(tasks.id, completesTaskId), eq(tasks.status, "open")))
        .returning({ id: tasks.id, type: tasks.type });
      if (done) {
        await appendCopsEvent(
          tx as never,
          createCopsEvent({
            eventType: "TaskCompleted",
            tenantId: ws,
            aggregateType: "task",
            aggregateId: done.id,
            actor: { type: "user", id: ctx.userId },
            correlationId: ctx.requestId,
            payload: { task_id: done.id, account_id: account.id, task_type: done.type },
          })
        );
      }
    }
    return { activity_id: activity!.id, task_id: taskId, email_send_id: emailMessageId, meeting_id: meetingId };
  });
}
