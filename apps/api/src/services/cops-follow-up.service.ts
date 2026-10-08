import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { appendCopsEvent, createCopsEvent } from "@skout/shared";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { canContact } from "./cops-can-contact.js";
import { SequenceService } from "./sequence.service.js";
import { ensureFollowUpSequence, FOLLOW_UP_TEMPLATE_KEY } from "./cops-cadence.service.js";

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-05 additions).
 *   - Tables touched directly: contacts, companies - read (prospect link, account owner); tasks - write
 *     (the enrollment task) (owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: the follow-up row, the task and the TaskCreated event commit in one transaction so a
 *     WelcomeEmailSent can never end with neither an enrollment nor a task.
 *   - Review date: revisit when apps/crm's internal API covers transactional writes
 */

/**
 * COPS-05 follow-up (Bible p.42-43): every WelcomeEmailSent yields exactly one follow-up, never
 * none. The configured onboarding sequence (template_key `cops_onboarding_followup`, active and
 * published) is used when the contact maps to a prospect and canContact() allows outreach;
 * otherwise the rep gets an enrollment task with the reason. Redelivered events are no-ops
 * (unique source_event_id).
 */
const log = createLogger("cops-follow-up");
const { copsFollowUps, copsOnboardingEmailSends, contacts, companies, sequenceEnrollments, sequenceVersions, tasks } = schema;

export const FOLLOW_UP_SEQUENCE_TEMPLATE_KEY = FOLLOW_UP_TEMPLATE_KEY;

export type FollowUpTaskReason =
  | "no_sequence_configured"
  | "no_contact"
  | "contact_without_prospect"
  | "contact_blocked"
  | "enroll_failed";

export interface FollowUpDeps {
  config: Pick<Env, "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS">;
  /** Schedules the first step of a new enrollment (BullMQ in the worker; a fake in tests). */
  scheduleFirstStep: (input: { enrollmentId: string; workspaceId: string; prospectId: string; sequenceId: string; firstStepAt: Date | null }) => Promise<void>;
}

export interface FollowUpDto {
  id: string;
  account_id: string;
  mode: "sequence" | "task";
  enrollment_id: string | null;
  task_id: string | null;
  task_reason: string | null;
  created_at: string;
}

const toDto = (r: typeof copsFollowUps.$inferSelect): FollowUpDto => ({
  id: r.id,
  account_id: r.accountId,
  mode: r.mode as "sequence" | "task",
  enrollment_id: r.enrollmentId,
  task_id: r.taskId,
  task_reason: r.taskReason,
  created_at: r.createdAt.toISOString(),
});

interface WelcomeEvent {
  event_id: string;
  tenant_id: string;
  correlation_id: string;
  payload: { account_id: string; email_send_id: string };
}

export async function startFollowUp(db: Db, event: WelcomeEvent, deps: FollowUpDeps): Promise<FollowUpDto> {
  const ws = event.tenant_id;
  const existing = await findFollowUp(db, ws, event.event_id);
  if (existing) return existing;

  const [send] = await db
    .select()
    .from(copsOnboardingEmailSends)
    .where(and(eq(copsOnboardingEmailSends.workspaceId, ws), eq(copsOnboardingEmailSends.id, event.payload.email_send_id)));
  const accountId = event.payload.account_id;
  const [account] = await db
    .select({ name: companies.name, ownerId: companies.ownerId })
    .from(companies)
    .where(and(eq(companies.workspaceId, ws), eq(companies.id, accountId)));
  const contact = send?.contactId
    ? (
        await db
          .select({ id: contacts.id, prospectId: contacts.sourceProspectId, firstName: contacts.firstName })
          .from(contacts)
          .where(and(eq(contacts.workspaceId, ws), eq(contacts.id, send.contactId)))
      )[0]
    : undefined;

  // The workspace's follow-up sequence; the default cadence is created on first use.
  const sequenceId = await ensureFollowUpSequence(db, ws).catch((err) => {
    log.warn("could not create the default follow-up sequence", { err, workspaceId: ws });
    return null;
  });
  const sequence = sequenceId ? { id: sequenceId } : undefined;

  let taskReason: FollowUpTaskReason | null = null;
  let blockedBy: string | null = null;
  if (!sequence) taskReason = "no_sequence_configured";
  else if (!contact) taskReason = "no_contact";
  else if (!contact.prospectId) taskReason = "contact_without_prospect";
  else {
    const gate = await canContact(db, deps.config, {
      workspaceId: ws,
      email: send!.toEmail,
      contactId: contact.id,
      prospectId: contact.prospectId,
      purpose: "outreach",
    });
    if (!gate.allowed) {
      taskReason = "contact_blocked";
      blockedBy = gate.reason;
    }
  }

  let enrollment: { enrollmentId: string; prospectId: string; firstStepScheduledAt: Date | null; isNew: boolean } | null = null;
  if (!taskReason) {
    try {
      const result = await new SequenceService(db).enroll(sequence!.id, ws, { prospectIds: [contact!.prospectId!] });
      const fresh = result.newEnrollments[0];
      if (fresh) enrollment = { ...fresh, isNew: true };
      else {
        // Already in this sequence: the follow-up is that active enrollment.
        const [active] = await db
          .select({ id: sequenceEnrollments.id })
          .from(sequenceEnrollments)
          .where(
            and(
              eq(sequenceEnrollments.sequenceId, sequence!.id),
              eq(sequenceEnrollments.prospectId, contact!.prospectId!),
              eq(sequenceEnrollments.status, "active")
            )
          );
        if (active) enrollment = { enrollmentId: active.id, prospectId: contact!.prospectId!, firstStepScheduledAt: null, isNew: false };
        else taskReason = "enroll_failed";
      }
    } catch (err) {
      log.warn("follow-up enrollment failed, creating a task instead", { err, accountId, eventId: event.event_id });
      taskReason = "enroll_failed";
    }
  }

  const actor = { type: "system" as const, id: null };
  const row = await db.transaction(async (tx) => {
    if (enrollment) {
      const [inserted] = await tx
        .insert(copsFollowUps)
        .values({ workspaceId: ws, accountId, sourceEventId: event.event_id, emailSendId: send?.id ?? null, mode: "sequence", enrollmentId: enrollment.enrollmentId })
        .onConflictDoNothing()
        .returning();
      if (!inserted) return null;
      const [version] = await tx
        .select({ version: sequenceVersions.version })
        .from(sequenceEnrollments)
        .leftJoin(sequenceVersions, eq(sequenceVersions.id, sequenceEnrollments.sequenceVersionId))
        .where(eq(sequenceEnrollments.id, enrollment.enrollmentId));
      await appendCopsEvent(
        tx as never,
        createCopsEvent({
          eventType: "SequenceEnrolled",
          tenantId: ws,
          aggregateType: "account",
          aggregateId: accountId,
          actor,
          correlationId: event.correlation_id,
          causationId: event.event_id,
          payload: { account_id: accountId, enrollment_id: enrollment.enrollmentId, template_version: String(version?.version ?? 0) },
        })
      );
      return inserted;
    }

    const who = contact?.firstName ? `${contact.firstName} (${send?.toEmail ?? "customer"})` : send?.toEmail ?? "the customer";
    const reasonText: Record<FollowUpTaskReason, string> = {
      no_sequence_configured: "no onboarding follow-up sequence is configured",
      no_contact: "the recipient is not a contact on the account",
      contact_without_prospect: "the contact cannot be enrolled in a sequence",
      contact_blocked: `the contact must not receive outreach (${blockedBy ?? "blocked"})`,
      enroll_failed: "the sequence enrollment failed",
    };
    const [task] = await tx
      .insert(tasks)
      .values({
        workspaceId: ws,
        assignedTo: account?.ownerId ?? send?.actorId ?? null,
        relatedEntityType: "company",
        relatedEntityId: accountId,
        title: `Onboarding follow-up for ${account?.name ?? "the account"}: personal follow-up with ${who}`,
        type: "onboarding_check",
        dueDate: new Date(),
        priority: "high",
      })
      .returning({ id: tasks.id });
    const [inserted] = await tx
      .insert(copsFollowUps)
      .values({
        workspaceId: ws,
        accountId,
        sourceEventId: event.event_id,
        emailSendId: send?.id ?? null,
        mode: "task",
        taskId: task!.id,
        taskReason: `${taskReason}: ${reasonText[taskReason!]}`,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) throw new RollbackDuplicate();
    await appendCopsEvent(
      tx as never,
      createCopsEvent({
        eventType: "TaskCreated",
        tenantId: ws,
        aggregateType: "account",
        aggregateId: accountId,
        actor,
        correlationId: event.correlation_id,
        causationId: event.event_id,
        payload: { task_id: task!.id, account_id: accountId, task_type: "onboarding_check" },
      })
    );
    return inserted;
  }).catch((err) => {
    if (err instanceof RollbackDuplicate) return null;
    throw err;
  });

  if (!row) return (await findFollowUp(db, ws, event.event_id))!;
  if (enrollment?.isNew) {
    await deps
      .scheduleFirstStep({
        enrollmentId: enrollment.enrollmentId,
        workspaceId: ws,
        prospectId: enrollment.prospectId,
        sequenceId: sequence!.id,
        firstStepAt: enrollment.firstStepScheduledAt,
      })
      .catch((err) => log.error("failed to schedule the first follow-up step", err, { enrollmentId: enrollment!.enrollmentId }));
  }
  return toDto(row);
}

class RollbackDuplicate extends Error {}

async function findFollowUp(db: Db, workspaceId: string, sourceEventId: string): Promise<FollowUpDto | null> {
  const [row] = await db
    .select()
    .from(copsFollowUps)
    .where(and(eq(copsFollowUps.workspaceId, workspaceId), eq(copsFollowUps.sourceEventId, sourceEventId)));
  return row ? toDto(row) : null;
}

export async function latestFollowUp(db: Db, workspaceId: string, accountId: string): Promise<FollowUpDto | null> {
  const [row] = await db
    .select()
    .from(copsFollowUps)
    .where(and(eq(copsFollowUps.workspaceId, workspaceId), eq(copsFollowUps.accountId, accountId)))
    .orderBy(desc(copsFollowUps.createdAt))
    .limit(1);
  return row ? toDto(row) : null;
}

export interface FollowUpView {
  mode: "sequence" | "task";
  task_reason: string | null;
  enrollment: {
    id: string;
    sequence_id: string;
    template_version: number | null;
    status: string;
    stop_reason: string | null;
    current_step: number | null;
    next_action: { kind: string; scheduled_at: string | null } | null;
  } | null;
  task: { id: string; title: string; due_at: string | null; status: string } | null;
}

/** The account's latest follow-up as the contract's FollowUp (Onboarding Control sequence card). */
export async function getFollowUpView(db: Db, workspaceId: string, accountId: string): Promise<FollowUpView | null> {
  const fu = await latestFollowUp(db, workspaceId, accountId);
  if (!fu) return null;
  if (fu.mode === "task") {
    const [t] = fu.task_id
      ? await db
          .select({ id: tasks.id, title: tasks.title, dueDate: tasks.dueDate, status: tasks.status })
          .from(tasks)
          .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, fu.task_id)))
      : [];
    return {
      mode: "task",
      task_reason: fu.task_reason,
      enrollment: null,
      task: t ? { id: t.id, title: t.title, due_at: t.dueDate?.toISOString() ?? null, status: t.status } : null,
    };
  }
  const [e] = await db
    .select({
      id: sequenceEnrollments.id,
      sequenceId: sequenceEnrollments.sequenceId,
      status: sequenceEnrollments.status,
      stopReason: sequenceEnrollments.stopReason,
      version: sequenceVersions.version,
    })
    .from(sequenceEnrollments)
    .leftJoin(sequenceVersions, eq(sequenceVersions.id, sequenceEnrollments.sequenceVersionId))
    .where(and(eq(sequenceEnrollments.workspaceId, workspaceId), eq(sequenceEnrollments.id, fu.enrollment_id!)));
  if (!e) return { mode: "sequence", task_reason: null, enrollment: null, task: null };
  const steps = await db
    .select({ status: schema.sequenceEnrollmentSteps.status, scheduledAt: schema.sequenceEnrollmentSteps.scheduledAt, order: schema.sequenceSteps.stepOrder, type: schema.sequenceSteps.stepType })
    .from(schema.sequenceEnrollmentSteps)
    .innerJoin(schema.sequenceSteps, eq(schema.sequenceSteps.id, schema.sequenceEnrollmentSteps.stepId))
    .where(eq(schema.sequenceEnrollmentSteps.enrollmentId, e.id))
    .orderBy(schema.sequenceSteps.stepOrder);
  const next = steps.find((s) => s.status === "scheduled" || s.status === "executing") ?? null;
  const done = steps.filter((s) => s.status === "executed").length;
  return {
    mode: "sequence",
    task_reason: null,
    enrollment: {
      id: e.id,
      sequence_id: e.sequenceId,
      template_version: e.version ?? null,
      status: e.status,
      stop_reason: e.stopReason,
      current_step: next ? next.order : done > 0 ? done : null,
      next_action: next && (e.status === "active" || e.status === "paused") ? { kind: next.type, scheduled_at: next.scheduledAt?.toISOString() ?? null } : null,
    },
    task: null,
  };
}
