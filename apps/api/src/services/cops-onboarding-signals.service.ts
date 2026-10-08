import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { appendCopsEvent, createCopsEvent } from "@skout/shared";
import { createLogger } from "@skout/observability";
import { canContact } from "./cops-can-contact.js";
import { evaluateActivation, openInstances } from "./cops-activation.service.js";
import { startFollowUp, type FollowUpDeps } from "./cops-follow-up.service.js";
import { stopAccountFollowUps } from "./cops-stop.service.js";

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-05 additions).
 *   - Tables touched directly: companies, deals, meetings - read (owner, open/lost opportunities, booked
 *     meetings); tasks - write (playbook and handoff tasks) (owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: each trigger fires once; the signal row, its task and the TaskCreated event commit in one
 *     transaction, which an HTTP call into apps/crm cannot join.
 *   - Review date: revisit when apps/crm's internal API covers transactional writes
 */

/**
 * COPS-05 scheduled onboarding evaluator (Bible p.43, p.46-47):
 * - activation from product data (cops-activation.service)
 * - stalled-onboarding playbooks: each trigger creates one task per instance (unique signal row)
 * - stop triggers for the follow-up: opt-out, hard bounce (also a rep task), meeting booked,
 *   opportunity closed/lost
 * - CS handoff on activation, exactly once; Sales keeps the account (owner unchanged)
 * - safety net: a sent onboarding email whose WelcomeEmailSent was never turned into a follow-up
 */
const log = createLogger("cops-onboarding-signals");
const {
  copsOnboardingInstances,
  copsOnboardingSignals,
  copsOnboardingEmailSends,
  copsOnboardingMilestones,
  copsFollowUps,
  copsOutbox,
  copsProvisionings,
  companies,
  deals,
  meetings,
  tasks,
  authEvents,
  workspaceMembers,
  crmConnections,
  creditBalances,
} = schema;

const HOUR = 3_600_000;

export const PLAYBOOK_TRIGGERS = {
  no_delivery: { title: "Onboarding email did not reach the customer: verify the contact and re-send", type: "email" },
  delivered_no_login: { title: "Customer has not signed in 24h after onboarding: personal outreach", type: "call" },
  login_no_value: { title: "Customer signed in but has no first result: offer guided help (CS assist)", type: "meeting" },
  no_activity_72h: { title: "No product activity for 72h: personal check-in", type: "call" },
  integration_error: { title: "Integration error on the customer workspace: open an engineering escalation", type: "ticket_follow_up" },
  low_credits: { title: "High usage, low credits: top-up or conversion conversation", type: "call" },
  trial_ending: { title: "Trial ends within 3 days: review call and conversion or extension", type: "meeting" },
  hard_bounce: { title: "Onboarding email hard-bounced: find a working contact", type: "email" },
  first_login: { title: "Customer signed in for the first time: congratulate and guide them to the next milestone", type: "email" },
} as const;
export type PlaybookTrigger = keyof typeof PLAYBOOK_TRIGGERS;

interface InstanceRow {
  id: string;
  workspaceId: string;
  accountId: string;
  customerWorkspaceId: string | null;
  provisioningId: string | null;
  firstLoginAt: Date | null;
  activatedAt: Date | null;
  handoffTaskId: string | null;
  createdAt: Date;
}

/** Creates the playbook task for a trigger once per instance (unique index); returns whether it fired now. */
export async function fireTrigger(db: Db, inst: InstanceRow, trigger: PlaybookTrigger, detail: string, correlationId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [signal] = await tx
      .insert(copsOnboardingSignals)
      .values({ workspaceId: inst.workspaceId, instanceId: inst.id, trigger })
      .onConflictDoNothing()
      .returning({ id: copsOnboardingSignals.id });
    if (!signal) return false;
    const [account] = await tx.select({ name: companies.name, ownerId: companies.ownerId }).from(companies).where(eq(companies.id, inst.accountId));
    const spec = PLAYBOOK_TRIGGERS[trigger];
    const [task] = await tx
      .insert(tasks)
      .values({
        workspaceId: inst.workspaceId,
        assignedTo: account?.ownerId ?? null,
        relatedEntityType: "company",
        relatedEntityId: inst.accountId,
        title: `${account?.name ?? "Account"}: ${spec.title}. ${detail}`.slice(0, 500),
        type: spec.type,
        dueDate: new Date(),
        priority: trigger === "hard_bounce" || trigger === "trial_ending" ? "high" : "medium",
      })
      .returning({ id: tasks.id });
    await tx.update(copsOnboardingSignals).set({ taskId: task!.id }).where(eq(copsOnboardingSignals.id, signal.id));
    await appendCopsEvent(
      tx as never,
      createCopsEvent({
        eventType: "TaskCreated",
        tenantId: inst.workspaceId,
        aggregateType: "account",
        aggregateId: inst.accountId,
        actor: { type: "system", id: null },
        correlationId,
        payload: { task_id: task!.id, account_id: inst.accountId, task_type: spec.type },
      })
    );
    return true;
  });
}

/** CS handoff on activation (default criterion, COPS-05 Q3): one task, never twice; Sales stays owner. */
export async function ensureHandoff(db: Db, inst: InstanceRow, correlationId: string): Promise<boolean> {
  if (!inst.activatedAt || inst.handoffTaskId) return false;
  return db.transaction(async (tx) => {
    const [locked] = (await tx.execute(sql`select handoff_task_id from cops_onboarding_instances where id = ${inst.id} for update`)) as unknown as Array<{ handoff_task_id: string | null }>;
    if (!locked || locked.handoff_task_id) return false;
    const [cs] = (await tx.execute(sql`
      select wmr.user_id from workspace_member_roles wmr join roles r on r.id = wmr.role_id
       where wmr.workspace_id = ${inst.workspaceId} and r.key = 'cs' order by wmr.user_id limit 1`)) as unknown as Array<{ user_id: string }>;
    const [account] = await tx.select({ name: companies.name, ownerId: companies.ownerId }).from(companies).where(eq(companies.id, inst.accountId));
    const done = await tx
      .select({ label: copsOnboardingMilestones.label })
      .from(copsOnboardingMilestones)
      .where(and(eq(copsOnboardingMilestones.instanceId, inst.id), sql`${copsOnboardingMilestones.completedAt} is not null`));
    const [task] = await tx
      .insert(tasks)
      .values({
        workspaceId: inst.workspaceId,
        assignedTo: cs?.user_id ?? account?.ownerId ?? null,
        relatedEntityType: "company",
        relatedEntityId: inst.accountId,
        title: `CS handoff: ${account?.name ?? "account"} activated (${done.map((d) => d.label).join(", ")}). Review commitments, stakeholders and open risks; Sales keeps visibility.`.slice(0, 500),
        type: "review",
        dueDate: new Date(Date.now() + 24 * HOUR),
        priority: "high",
      })
      .returning({ id: tasks.id });
    await tx.update(copsOnboardingInstances).set({ handoffTaskId: task!.id, updatedAt: new Date() }).where(eq(copsOnboardingInstances.id, inst.id));
    await appendCopsEvent(
      tx as never,
      createCopsEvent({
        eventType: "TaskCreated",
        tenantId: inst.workspaceId,
        aggregateType: "account",
        aggregateId: inst.accountId,
        actor: { type: "system", id: null },
        correlationId,
        payload: { task_id: task!.id, account_id: inst.accountId, task_type: "review" },
      })
    );
    return true;
  });
}

async function loadInstance(db: Db, instanceId: string): Promise<InstanceRow | null> {
  const [row] = await db
    .select({
      id: copsOnboardingInstances.id,
      workspaceId: copsOnboardingInstances.workspaceId,
      accountId: copsOnboardingInstances.accountId,
      customerWorkspaceId: copsOnboardingInstances.customerWorkspaceId,
      provisioningId: copsOnboardingInstances.provisioningId,
      firstLoginAt: copsOnboardingInstances.firstLoginAt,
      activatedAt: copsOnboardingInstances.activatedAt,
      handoffTaskId: copsOnboardingInstances.handoffTaskId,
      createdAt: copsOnboardingInstances.createdAt,
    })
    .from(copsOnboardingInstances)
    .where(eq(copsOnboardingInstances.id, instanceId));
  return row ?? null;
}

/** Runs every rule for one instance. `now` is injectable for tests. */
export async function evaluateOnboarding(
  db: Db,
  instanceId: string,
  deps: Pick<FollowUpDeps, "config">,
  opts: { now?: Date; correlationId: string }
): Promise<{ fired: PlaybookTrigger[]; stopped: string[]; handoff: boolean }> {
  const now = opts.now ?? new Date();
  const fired: PlaybookTrigger[] = [];
  const stopped: string[] = [];
  let inst = await loadInstance(db, instanceId);
  if (!inst) return { fired, stopped, handoff: false };
  const ws = inst.workspaceId;

  if (!inst.activatedAt) await evaluateActivation(db, ws, inst.id, opts.correlationId);
  inst = (await loadInstance(db, instanceId))!;

  const [email] = await db
    .select()
    .from(copsOnboardingEmailSends)
    .where(and(eq(copsOnboardingEmailSends.workspaceId, ws), eq(copsOnboardingEmailSends.accountId, inst.accountId)))
    .orderBy(desc(copsOnboardingEmailSends.createdAt))
    .limit(1);

  const fire = async (t: PlaybookTrigger, detail: string) => {
    if (await fireTrigger(db, inst!, t, detail, opts.correlationId)) fired.push(t);
  };
  const stop = async (reason: "OPTED_OUT" | "HARD_BOUNCE" | "MEETING_BOOKED" | "OPPORTUNITY_CLOSED") => {
    const n = await stopAccountFollowUps(db, { workspaceId: ws, accountId: inst!.accountId, reason, actor: { type: "system", id: null }, correlationId: opts.correlationId });
    if (n > 0) stopped.push(reason);
  };

  if (email) {
    const gate = await canContact(db, deps.config, { workspaceId: ws, email: email.toEmail, contactId: email.contactId, purpose: "transactional" });
    if (!gate.allowed && (gate.reason === "suppressed" || gate.reason === "channel_suppressed")) await stop("OPTED_OUT");
    if ((!gate.allowed && gate.reason === "hard_bounce") || email.status === "bounced") {
      await stop("HARD_BOUNCE");
      await fire("hard_bounce", `Recipient ${email.toEmail}.`);
    }
    const sentAt = email.sentAt ?? email.createdAt;
    if ((email.status === "failed" || email.status === "bounced") && now.getTime() - email.createdAt.getTime() > HOUR) {
      await fire("no_delivery", `Last attempt: ${email.status}${email.error ? ` (${email.error})` : ""}.`);
    }
    if (email.status !== "failed" && email.status !== "bounced" && !inst.firstLoginAt && now.getTime() - sentAt.getTime() > 24 * HOUR) {
      await fire("delivered_no_login", `Onboarding email sent ${sentAt.toISOString().slice(0, 10)}.`);
    }
  }

  // Bible p.43 cadence: first login -> congratulate + guide to the next milestone.
  if (!inst.activatedAt && inst.firstLoginAt) await fire("first_login", `First sign-in ${inst.firstLoginAt.toISOString().slice(0, 10)}.`);

  if (!inst.activatedAt && inst.firstLoginAt && now.getTime() - inst.firstLoginAt.getTime() > 72 * HOUR) {
    const [anyRequired] = await db
      .select({ id: copsOnboardingMilestones.id })
      .from(copsOnboardingMilestones)
      .where(and(eq(copsOnboardingMilestones.instanceId, inst.id), eq(copsOnboardingMilestones.required, true), sql`${copsOnboardingMilestones.completedAt} is not null`))
      .limit(1);
    if (!anyRequired) await fire("login_no_value", `First login ${inst.firstLoginAt.toISOString().slice(0, 10)}, no value milestone since.`);
  }

  if (!inst.activatedAt && inst.firstLoginAt && inst.customerWorkspaceId) {
    const [recent] = await db
      .select({ id: authEvents.id })
      .from(authEvents)
      .innerJoin(workspaceMembers, and(eq(workspaceMembers.userId, authEvents.userId), eq(workspaceMembers.workspaceId, inst.customerWorkspaceId)))
      .where(and(eq(authEvents.type, "login_success"), gt(authEvents.createdAt, new Date(now.getTime() - 72 * HOUR))))
      .limit(1);
    if (!recent && now.getTime() - inst.firstLoginAt.getTime() > 72 * HOUR) await fire("no_activity_72h", "No sign-in in the last 72 hours.");
  }

  if (inst.customerWorkspaceId) {
    const [broken] = await db
      .select({ provider: crmConnections.provider, status: crmConnections.status })
      .from(crmConnections)
      .where(and(eq(crmConnections.workspaceId, inst.customerWorkspaceId), inArray(crmConnections.status, ["error", "expired", "revoked"])))
      .limit(1);
    if (broken) await fire("integration_error", `${broken.provider} is ${broken.status}.`);

    const [prov] = inst.provisioningId
      ? await db.select({ request: copsProvisionings.request }).from(copsProvisionings).where(eq(copsProvisionings.id, inst.provisioningId))
      : [];
    const granted = Number((prov?.request as { credits?: number } | undefined)?.credits ?? 0);
    const [bal] = await db.select({ balance: creditBalances.balance }).from(creditBalances).where(eq(creditBalances.workspaceId, inst.customerWorkspaceId));
    if (granted > 0 && bal && bal.balance <= granted * 0.2) await fire("low_credits", `Balance ${bal.balance} of ${granted} trial credits.`);
  }

  if (!inst.activatedAt && inst.provisioningId) {
    const [prov] = await db.select({ trialEndsAt: copsProvisionings.trialEndsAt }).from(copsProvisionings).where(eq(copsProvisionings.id, inst.provisioningId));
    if (prov?.trialEndsAt && prov.trialEndsAt.getTime() > now.getTime() && prov.trialEndsAt.getTime() - now.getTime() <= 72 * HOUR) {
      await fire("trial_ending", `Trial ends ${prov.trialEndsAt.toISOString().slice(0, 10)}.`);
    }
  }

  const [followUp] = await db
    .select({ createdAt: copsFollowUps.createdAt })
    .from(copsFollowUps)
    .where(and(eq(copsFollowUps.workspaceId, ws), eq(copsFollowUps.accountId, inst.accountId)))
    .orderBy(asc(copsFollowUps.createdAt))
    .limit(1);
  if (followUp) {
    const [meeting] = await db
      .select({ id: meetings.id })
      .from(meetings)
      .where(and(eq(meetings.workspaceId, ws), eq(meetings.companyId, inst.accountId), gt(meetings.createdAt, followUp.createdAt)))
      .limit(1);
    if (meeting) await stop("MEETING_BOOKED");
    const opps = await db
      .select({ status: deals.status })
      .from(deals)
      .where(and(eq(deals.workspaceId, ws), eq(deals.companyId, inst.accountId), isNull(deals.deletedAt)));
    if (opps.length > 0 && opps.every((d) => d.status === "lost")) await stop("OPPORTUNITY_CLOSED");
  }

  const handoff = await ensureHandoff(db, inst, opts.correlationId);
  return { fired, stopped, handoff };
}

/** Safety net for "100% of WelcomeEmailSent yield an enrollment or a task": completes missed ones. */
export async function sweepMissedFollowUps(db: Db, deps: FollowUpDeps, olderThanMs = 10 * 60_000): Promise<number> {
  const missed = await db
    .select({ envelope: copsOutbox.envelope })
    .from(copsOutbox)
    .where(
      and(
        eq(copsOutbox.eventType, "WelcomeEmailSent"),
        lt(copsOutbox.createdAt, new Date(Date.now() - olderThanMs)),
        sql`not exists (select 1 from cops_follow_ups f where f.workspace_id = ${copsOutbox.tenantId} and f.source_event_id = ${copsOutbox.id})`
      )
    )
    .limit(100);
  let done = 0;
  for (const m of missed) {
    try {
      await startFollowUp(db, m.envelope as never, deps);
      done += 1;
    } catch (err) {
      log.error("sweep could not complete a follow-up", err);
    }
  }
  return done;
}

/** One evaluator pass over every open instance plus activated ones still waiting for a handoff. */
export async function runOnboardingEvaluator(db: Db, deps: FollowUpDeps, correlationId: string) {
  const swept = await sweepMissedFollowUps(db, deps);
  const ids = new Set((await openInstances(db)).map((i) => i.id));
  const pendingHandoff = await db
    .select({ id: copsOnboardingInstances.id })
    .from(copsOnboardingInstances)
    .where(and(sql`${copsOnboardingInstances.activatedAt} is not null`, isNull(copsOnboardingInstances.handoffTaskId)))
    .limit(200);
  for (const p of pendingHandoff) ids.add(p.id);
  let fired = 0;
  for (const id of ids) {
    try {
      const r = await evaluateOnboarding(db, id, deps, { correlationId });
      fired += r.fired.length;
    } catch (err) {
      log.error("onboarding evaluation failed", err, { instanceId: id });
    }
  }
  return { swept, evaluated: ids.size, fired };
}

export interface BlockerDto {
  kind: string;
  detail: string;
  since: string;
  task_id: string | null;
}

/** Open blockers for Onboarding Control: fired triggers whose task is still open. */
export async function listBlockers(db: Db, workspaceId: string, accountId: string): Promise<BlockerDto[]> {
  const rows = await db
    .select({ trigger: copsOnboardingSignals.trigger, firedAt: copsOnboardingSignals.firedAt, taskId: copsOnboardingSignals.taskId, title: tasks.title, status: tasks.status })
    .from(copsOnboardingSignals)
    .innerJoin(copsOnboardingInstances, eq(copsOnboardingInstances.id, copsOnboardingSignals.instanceId))
    .leftJoin(tasks, eq(tasks.id, copsOnboardingSignals.taskId))
    .where(and(eq(copsOnboardingSignals.workspaceId, workspaceId), eq(copsOnboardingInstances.accountId, accountId), ne(sql`coalesce(${tasks.status}, 'open')`, "done")))
    .orderBy(desc(copsOnboardingSignals.firedAt));
  return rows
    .filter((r) => r.status !== "skipped")
    .map((r) => ({ kind: r.trigger, detail: r.title ?? r.trigger, since: r.firedAt.toISOString(), task_id: r.taskId }));
}

export async function loadHandoff(db: Db, workspaceId: string, accountId: string) {
  const [row] = await db
    .select({ taskId: copsOnboardingInstances.handoffTaskId, createdAt: tasks.createdAt })
    .from(copsOnboardingInstances)
    .leftJoin(tasks, eq(tasks.id, copsOnboardingInstances.handoffTaskId))
    .where(and(eq(copsOnboardingInstances.workspaceId, workspaceId), eq(copsOnboardingInstances.accountId, accountId)));
  return row?.taskId ? { task_id: row.taskId, created_at: row.createdAt?.toISOString() ?? null } : null;
}
