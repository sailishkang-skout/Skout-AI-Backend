import { and, asc, desc, eq, isNull, like, ne, or, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { appendCopsEvent, createCopsEvent } from "@skout/shared";
import { writeCopsAudit } from "./cops-platform.service.js";
import { stopAccountFollowUps } from "./cops-stop.service.js";
import { segmentOf } from "./cops-onboarding-templates.js";

/**
 * COPS-05 activation (Bible p.44-45): value-based, weighted milestones per template version.
 * - An instance is created per provisioned account and pinned to the template version it started
 *   with, so a template change never rewrites past activations.
 * - A milestone completes once, from a product event or (for manual ones) a reasoned human action;
 *   every source is kept as evidence and a repeated source is a no-op.
 * - activation_pct = completed weight / total weight. The account activates when every required
 *   milestone is complete and at least one required milestone exists, so login alone never
 *   activates (first_login is weight 0, not required, in the default template).
 * - Activation stops the onboarding follow-up (stop reason ACTIVATED).
 */
const {
  copsActivationTemplates,
  copsOnboardingInstances,
  copsOnboardingMilestones,
  copsMilestoneEvents,
  copsProvisionings,
  workspaceInvites,
  workspaceMembers,
  authEvents,
  crmConnections,
  creditTransactions,
} = schema;

export const DEFAULT_ACTIVATION_TEMPLATE = "default_trial";

interface TemplateMilestone {
  key: string;
  label: string;
  weight: number;
  required: boolean;
  source: "event" | "manual";
  event_types: string[];
}

export class ActivationError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "NOT_PROVISIONED" | "BUSINESS_STATE_CONFLICT",
    message: string
  ) {
    super(message);
  }
  get status(): number {
    return this.code === "BUSINESS_STATE_CONFLICT" ? 409 : 404;
  }
}

/** Creates the account's activation instance (once) from the newest template version. */
export async function ensureActivationInstance(db: Db, workspaceId: string, accountId: string): Promise<string | null> {
  const [existing] = await db
    .select({ id: copsOnboardingInstances.id })
    .from(copsOnboardingInstances)
    .where(and(eq(copsOnboardingInstances.workspaceId, workspaceId), eq(copsOnboardingInstances.accountId, accountId)));
  if (existing) return existing.id;

  const [prov] = await db
    .select({ id: copsProvisionings.id, customerWs: copsProvisionings.provisionedWorkspaceId })
    .from(copsProvisionings)
    .where(and(eq(copsProvisionings.workspaceId, workspaceId), eq(copsProvisionings.accountId, accountId), eq(copsProvisionings.status, "succeeded")))
    .limit(1);
  if (!prov?.customerWs) return null;

  // Most specific first: this segment, then any segment; the workspace's own over the system
  // default; the newest version.
  const [company] = await db
    .select({ employeeCount: schema.companies.employeeCount })
    .from(schema.companies)
    .where(and(eq(schema.companies.workspaceId, workspaceId), eq(schema.companies.id, accountId)));
  const segment = segmentOf(company?.employeeCount);
  const [template] = await db
    .select()
    .from(copsActivationTemplates)
    .where(
      and(
        eq(copsActivationTemplates.key, DEFAULT_ACTIVATION_TEMPLATE),
        or(eq(copsActivationTemplates.workspaceId, workspaceId), isNull(copsActivationTemplates.workspaceId)),
        or(eq(copsActivationTemplates.segment, segment), isNull(copsActivationTemplates.segment))
      )
    )
    .orderBy(
      sql`${copsActivationTemplates.segment} is null`,
      sql`${copsActivationTemplates.workspaceId} is null`,
      desc(copsActivationTemplates.version)
    )
    .limit(1);
  if (!template) return null;

  return db.transaction(async (tx) => {
    const [inst] = await tx
      .insert(copsOnboardingInstances)
      .values({
        workspaceId,
        accountId,
        provisioningId: prov.id,
        customerWorkspaceId: prov.customerWs,
        templateId: template.id,
        templateKey: template.key,
        templateVersion: template.version,
      })
      .onConflictDoNothing()
      .returning({ id: copsOnboardingInstances.id });
    if (!inst) {
      const [winner] = await tx
        .select({ id: copsOnboardingInstances.id })
        .from(copsOnboardingInstances)
        .where(and(eq(copsOnboardingInstances.workspaceId, workspaceId), eq(copsOnboardingInstances.accountId, accountId)));
      return winner?.id ?? null;
    }
    const ms = template.milestones as TemplateMilestone[];
    if (ms.length > 0) {
      await tx.insert(copsOnboardingMilestones).values(
        ms.map((m) => ({
          workspaceId,
          instanceId: inst.id,
          key: m.key,
          label: m.label,
          weight: m.weight,
          required: m.required,
          source: m.source,
        }))
      );
    }
    return inst.id;
  });
}

export function activationPct(milestones: Array<{ weight: number; completedAt: Date | null }>): number {
  const total = milestones.reduce((s, m) => s + m.weight, 0);
  if (total === 0) return 0;
  const done = milestones.filter((m) => m.completedAt).reduce((s, m) => s + m.weight, 0);
  return Math.round((done / total) * 100);
}

export function isActivated(milestones: Array<{ required: boolean; completedAt: Date | null }>): boolean {
  const required = milestones.filter((m) => m.required);
  return required.length > 0 && required.every((m) => m.completedAt);
}

export interface MilestoneSignal {
  key: string;
  sourceRef: string;
  sourceType: string;
  occurredAt: Date;
  evidence?: Record<string, unknown>;
}

export type MilestoneOutcome = "completed" | "already_complete" | "duplicate" | "unknown_milestone";

/**
 * Completes one milestone from a signal. Idempotent per (milestone, sourceRef). Returns whether the
 * account activated with this signal.
 */
export async function completeMilestone(
  db: Db,
  input: { workspaceId: string; instanceId: string; signal: MilestoneSignal; actor: { type: "user" | "system"; id: string | null }; reason?: string; correlationId: string }
): Promise<{ outcome: MilestoneOutcome; activated: boolean; accountId: string }> {
  const { signal } = input;
  const result = await db.transaction(async (tx) => {
    const [inst] = (await tx.execute(sql`
      select id, account_id as "accountId", template_key as "templateKey", template_version as "templateVersion",
             activated_at as "activatedAt", first_login_at as "firstLoginAt"
        from cops_onboarding_instances where id = ${input.instanceId} and workspace_id = ${input.workspaceId} for update`)) as unknown as Array<{
      id: string;
      accountId: string;
      templateKey: string;
      templateVersion: number;
      activatedAt: Date | null;
      firstLoginAt: Date | null;
    }>;
    if (!inst) throw new ActivationError("NOT_FOUND", "Activation instance not found");
    const [milestone] = await tx
      .select()
      .from(copsOnboardingMilestones)
      .where(and(eq(copsOnboardingMilestones.instanceId, inst.id), eq(copsOnboardingMilestones.key, signal.key)));
    if (!milestone) return { outcome: "unknown_milestone" as const, activated: false, accountId: inst.accountId };

    const [ev] = await tx
      .insert(copsMilestoneEvents)
      .values({
        workspaceId: input.workspaceId,
        milestoneId: milestone.id,
        sourceRef: signal.sourceRef,
        sourceType: signal.sourceType,
        actorId: input.actor.type === "user" ? input.actor.id : null,
        reason: input.reason ?? null,
        occurredAt: signal.occurredAt,
      })
      .onConflictDoNothing()
      .returning({ id: copsMilestoneEvents.id });
    if (!ev) return { outcome: "duplicate" as const, activated: false, accountId: inst.accountId };
    if (milestone.completedAt) return { outcome: "already_complete" as const, activated: false, accountId: inst.accountId };

    const evidence = { source_type: signal.sourceType, source_ref: signal.sourceRef, ...(input.reason ? { reason: input.reason, actor_id: input.actor.id } : {}), ...(signal.evidence ?? {}) };
    await tx
      .update(copsOnboardingMilestones)
      .set({ completedAt: signal.occurredAt, evidence })
      .where(eq(copsOnboardingMilestones.id, milestone.id));

    const all = await tx
      .select({ weight: copsOnboardingMilestones.weight, required: copsOnboardingMilestones.required, completedAt: copsOnboardingMilestones.completedAt })
      .from(copsOnboardingMilestones)
      .where(eq(copsOnboardingMilestones.instanceId, inst.id));
    const pct = activationPct(all);
    const activatedNow = !inst.activatedAt && isActivated(all);
    const firstLogin = signal.key === "first_login" && !inst.firstLoginAt;
    await tx
      .update(copsOnboardingInstances)
      .set({
        activationPct: pct,
        updatedAt: new Date(),
        ...(activatedNow ? { activatedAt: new Date() } : {}),
        ...(firstLogin ? { firstLoginAt: signal.occurredAt } : {}),
      })
      .where(eq(copsOnboardingInstances.id, inst.id));

    const base = {
      tenantId: input.workspaceId,
      aggregateType: "account",
      aggregateId: inst.accountId,
      actor: input.actor.type === "user" ? { type: "user" as const, id: input.actor.id } : { type: "system" as const, id: null },
      correlationId: input.correlationId,
    };
    if (firstLogin) {
      await appendCopsEvent(
        tx as never,
        createCopsEvent({ ...base, eventType: "FirstLogin", payload: { account_id: inst.accountId, user_id: String(signal.evidence?.user_id ?? signal.sourceRef) } })
      );
    }
    await appendCopsEvent(
      tx as never,
      createCopsEvent({ ...base, eventType: "ActivationMilestoneCompleted", payload: { account_id: inst.accountId, milestone_id: milestone.id } })
    );
    if (activatedNow) {
      await appendCopsEvent(
        tx as never,
        createCopsEvent({ ...base, eventType: "CustomerActivated", payload: { account_id: inst.accountId, rule_version: `${inst.templateKey}@v${inst.templateVersion}` } })
      );
    }
    if (input.actor.type === "user") {
      await writeCopsAudit(tx, {
        tenantId: input.workspaceId,
        actor: { type: "user", id: input.actor.id },
        entityType: "onboarding_milestone",
        entityId: milestone.id,
        action: "milestone.completed",
        after: { key: milestone.key, activation_pct: pct, activated: activatedNow },
        reason: input.reason ?? null,
        override: true,
        correlationId: input.correlationId,
        sourceChannel: "api",
      });
    }
    return { outcome: "completed" as const, activated: activatedNow, accountId: inst.accountId };
  });

  if (result.activated) {
    await stopAccountFollowUps(db, {
      workspaceId: input.workspaceId,
      accountId: result.accountId,
      reason: "ACTIVATED",
      actor: { type: "system", id: null },
      correlationId: input.correlationId,
    });
  }
  return result;
}

/** A manual milestone (e.g. success review) completed by a person with a reason. Event-driven ones refuse. */
export async function completeManualMilestone(
  db: Db,
  ctx: { workspaceId: string; userId: string; requestId: string },
  accountId: string,
  key: string,
  reason: string,
  idempotencyKey: string
) {
  const instanceId = await ensureActivationInstance(db, ctx.workspaceId, accountId);
  if (!instanceId) throw new ActivationError("NOT_PROVISIONED", "The account has no provisioned workspace yet");
  const [m] = await db
    .select({ source: copsOnboardingMilestones.source, completedAt: copsOnboardingMilestones.completedAt })
    .from(copsOnboardingMilestones)
    .where(and(eq(copsOnboardingMilestones.instanceId, instanceId), eq(copsOnboardingMilestones.key, key)));
  if (!m) throw new ActivationError("NOT_FOUND", `No milestone "${key}" on this account's template`);
  if (m.source !== "manual") throw new ActivationError("BUSINESS_STATE_CONFLICT", "This milestone is completed by product events, not by hand");
  const res = await completeMilestone(db, {
    workspaceId: ctx.workspaceId,
    instanceId,
    signal: { key, sourceRef: `manual:${idempotencyKey}`, sourceType: "manual", occurredAt: new Date() },
    actor: { type: "user", id: ctx.userId },
    reason,
    correlationId: ctx.requestId,
  });
  if (res.outcome === "already_complete") throw new ActivationError("BUSINESS_STATE_CONFLICT", "The milestone is already complete");
  return loadActivation(db, ctx.workspaceId, accountId);
}

/**
 * Product signals for the event-driven milestones, read from the customer workspace's own data:
 * invite accepted, first login, CRM connected, first search, first export, a teammate invited.
 * The earliest qualifying row is the evidence.
 */
export async function collectProductSignals(db: Db, instance: { customerWorkspaceId: string | null; provisioningId: string | null }): Promise<MilestoneSignal[]> {
  const ws = instance.customerWorkspaceId;
  if (!ws) return [];
  const signals: MilestoneSignal[] = [];
  const [prov] = instance.provisioningId
    ? await db.select({ inviteId: copsProvisionings.inviteId }).from(copsProvisionings).where(eq(copsProvisionings.id, instance.provisioningId))
    : [];

  if (prov?.inviteId) {
    const [inv] = await db
      .select({ id: workspaceInvites.id, acceptedAt: workspaceInvites.acceptedAt })
      .from(workspaceInvites)
      .where(eq(workspaceInvites.id, prov.inviteId));
    if (inv?.acceptedAt) signals.push({ key: "invitation_accepted", sourceRef: inv.id, sourceType: "invite.accepted", occurredAt: inv.acceptedAt });
  }

  const [login] = await db
    .select({ id: authEvents.id, userId: authEvents.userId, at: authEvents.createdAt })
    .from(authEvents)
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.userId, authEvents.userId), eq(workspaceMembers.workspaceId, ws)))
    .where(eq(authEvents.type, "login_success"))
    .orderBy(asc(authEvents.createdAt))
    .limit(1);
  if (login) signals.push({ key: "first_login", sourceRef: login.id, sourceType: "auth.login_success", occurredAt: login.at, evidence: { user_id: login.userId } });

  const [crm] = await db
    .select({ id: crmConnections.id, at: crmConnections.connectedAt, provider: crmConnections.provider })
    .from(crmConnections)
    .where(and(eq(crmConnections.workspaceId, ws), eq(crmConnections.status, "connected")))
    .orderBy(asc(crmConnections.connectedAt))
    .limit(1);
  if (crm) signals.push({ key: "crm_connected", sourceRef: crm.id, sourceType: "integration.crm_connected", occurredAt: crm.at, evidence: { provider: crm.provider } });

  const [search] = await db
    .select({ id: creditTransactions.id, at: creditTransactions.createdAt })
    .from(creditTransactions)
    .where(and(eq(creditTransactions.workspaceId, ws), eq(creditTransactions.action, "search")))
    .orderBy(asc(creditTransactions.createdAt))
    .limit(1);
  if (search) signals.push({ key: "first_search", sourceRef: search.id, sourceType: "product.search", occurredAt: search.at });

  const [exp] = await db
    .select({ id: creditTransactions.id, at: creditTransactions.createdAt, action: creditTransactions.action })
    .from(creditTransactions)
    .where(and(eq(creditTransactions.workspaceId, ws), like(creditTransactions.action, "export%")))
    .orderBy(asc(creditTransactions.createdAt))
    .limit(1);
  if (exp) signals.push({ key: "first_export", sourceRef: exp.id, sourceType: "product.export", occurredAt: exp.at, evidence: { action: exp.action } });

  const [team] = await db
    .select({ id: workspaceInvites.id, at: workspaceInvites.createdAt })
    .from(workspaceInvites)
    .where(and(eq(workspaceInvites.workspaceId, ws), ...(prov?.inviteId ? [ne(workspaceInvites.id, prov.inviteId)] : [])))
    .orderBy(asc(workspaceInvites.createdAt))
    .limit(1);
  if (team) signals.push({ key: "team_invited", sourceRef: team.id, sourceType: "invite.sent", occurredAt: team.at });

  return signals;
}

/** Applies every product signal to the instance's open event milestones. */
export async function evaluateActivation(db: Db, workspaceId: string, instanceId: string, correlationId: string) {
  const [inst] = await db
    .select({ customerWorkspaceId: copsOnboardingInstances.customerWorkspaceId, provisioningId: copsOnboardingInstances.provisioningId })
    .from(copsOnboardingInstances)
    .where(and(eq(copsOnboardingInstances.workspaceId, workspaceId), eq(copsOnboardingInstances.id, instanceId)));
  if (!inst) return { completed: 0, activated: false };
  const open = await db
    .select({ key: copsOnboardingMilestones.key })
    .from(copsOnboardingMilestones)
    .where(and(eq(copsOnboardingMilestones.instanceId, instanceId), eq(copsOnboardingMilestones.source, "event"), isNull(copsOnboardingMilestones.completedAt)));
  const wanted = new Set(open.map((m) => m.key));
  let completed = 0;
  let activated = false;
  for (const s of (await collectProductSignals(db, inst)).filter((x) => wanted.has(x.key))) {
    const r = await completeMilestone(db, { workspaceId, instanceId, signal: s, actor: { type: "system", id: null }, correlationId });
    if (r.outcome === "completed") completed += 1;
    activated ||= r.activated;
  }
  return { completed, activated };
}

export interface ActivationDto {
  instance_id: string;
  template_key: string;
  template_version: number;
  activation_pct: number;
  activated_at: string | null;
  first_login_at: string | null;
  milestones: Array<{ key: string; label: string; weight: number; required: boolean; source: string; completed_at: string | null; evidence: unknown }>;
}

export async function loadActivation(db: Db, workspaceId: string, accountId: string): Promise<ActivationDto | null> {
  const [inst] = await db
    .select()
    .from(copsOnboardingInstances)
    .where(and(eq(copsOnboardingInstances.workspaceId, workspaceId), eq(copsOnboardingInstances.accountId, accountId)));
  if (!inst) return null;
  const ms = await db
    .select()
    .from(copsOnboardingMilestones)
    .where(eq(copsOnboardingMilestones.instanceId, inst.id))
    .orderBy(desc(copsOnboardingMilestones.required), desc(copsOnboardingMilestones.weight), asc(copsOnboardingMilestones.key));
  return {
    instance_id: inst.id,
    template_key: inst.templateKey,
    template_version: inst.templateVersion,
    activation_pct: inst.activationPct,
    activated_at: inst.activatedAt?.toISOString() ?? null,
    first_login_at: inst.firstLoginAt?.toISOString() ?? null,
    milestones: ms.map((m) => ({
      key: m.key,
      label: m.label,
      weight: m.weight,
      required: m.required,
      source: m.source,
      completed_at: m.completedAt?.toISOString() ?? null,
      evidence: m.evidence ?? null,
    })),
  };
}

/** Open (not activated) instances, oldest first, for the scheduled evaluator. */
export async function openInstances(db: Db, limit = 200) {
  return db
    .select({ id: copsOnboardingInstances.id, workspaceId: copsOnboardingInstances.workspaceId, accountId: copsOnboardingInstances.accountId })
    .from(copsOnboardingInstances)
    .where(isNull(copsOnboardingInstances.activatedAt))
    .orderBy(asc(copsOnboardingInstances.updatedAt))
    .limit(limit);
}


export interface ProductEventInput {
  /** The provisioned customer workspace the event happened in. */
  workspace_id: string;
  /** Analytics event name, matched against the template's milestone event_types (e.g. product.export). */
  event_type: string;
  /** Unique id of the analytics event; a repeat is a no-op. */
  event_id: string;
  occurred_at?: string;
  properties?: Record<string, unknown>;
}

/**
 * Product analytics events satisfy milestones automatically (Bible p.45): the event is matched to
 * the open milestones of every onboarding instance for that customer workspace whose template
 * lists the event type. The instance keeps the template version it started with.
 */
export async function applyProductEvent(db: Db, input: ProductEventInput, correlationId: string) {
  const instances = await db
    .select({ id: copsOnboardingInstances.id, workspaceId: copsOnboardingInstances.workspaceId, templateId: copsOnboardingInstances.templateId })
    .from(copsOnboardingInstances)
    .where(eq(copsOnboardingInstances.customerWorkspaceId, input.workspace_id));
  let completed = 0;
  let activated = false;
  for (const inst of instances) {
    const [tpl] = await db.select({ milestones: copsActivationTemplates.milestones }).from(copsActivationTemplates).where(eq(copsActivationTemplates.id, inst.templateId));
    const keys = ((tpl?.milestones ?? []) as TemplateMilestone[]).filter((m) => m.source === "event" && m.event_types.includes(input.event_type)).map((m) => m.key);
    for (const key of keys) {
      const r = await completeMilestone(db, {
        workspaceId: inst.workspaceId,
        instanceId: inst.id,
        signal: {
          key,
          sourceRef: `analytics:${input.event_id}`,
          sourceType: input.event_type,
          occurredAt: input.occurred_at ? new Date(input.occurred_at) : new Date(),
          evidence: { analytics_event_id: input.event_id },
        },
        actor: { type: "system", id: null },
        correlationId,
      });
      if (r.outcome === "completed") completed += 1;
      activated ||= r.activated;
    }
  }
  return { matched_instances: instances.length, completed, activated };
}
