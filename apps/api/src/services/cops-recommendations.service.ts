import { createHash, randomUUID } from "node:crypto";
import { OpenAI } from "openai";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { appendActivityRecorded, appendCopsEvent, createCopsEvent, TICKET_OPEN_STATUSES } from "@skout/shared";
import { createLogger } from "@skout/observability";
import type { AutomationGraph } from "./automation-graph.js";
import { pinAiClaim } from "./ai-evidence.service.js";
import { createAutomationRunOnce } from "./automation-run.service.js";
import { AutomationService } from "./automation.service.js";
import { recommendationCandidates, type AccountContext, type Candidate, type EvidenceRef, type SuggestedAction } from "./cops-recommendation-rules.js";

/**
 * COPS-13 AI recommendations (Bible p.83, p.61, p.86), built on the next-best-action suggestions.
 *
 * - Candidates come from rules over the account's structured data, each with evidence refs.
 * - The context is built only from what the caller may read: tenant-scoped, commercial, billing,
 *   onboarding and ticket data only with the matching read permission, and customer-safe ticket
 *   comments only (internal notes never enter it).
 * - The model words the rationale and must cite evidence ids from the candidate; any other answer
 *   is discarded and the rule's own wording is used.
 * - Every recommendation is pinned in the evidence ledger (pinAiClaim) with the model and prompt
 *   versions; the prompt text is not stored, only its hash.
 * - Nothing runs until a person approves; approve runs one allow-listed action, dismiss needs a
 *   reason, and both are audited.
 *
 * DOCUMENTED READ-MODEL EXCEPTION (docs/adr/0003-read-model-exceptions.md, COPS-13 row).
 *   - Tables touched directly: companies (read), tasks (insert on approve), activities (insert,
 *     timeline), all owned by apps/crm
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: the context is one read of the account, and approving writes the task and its
 *     timeline entry in the same transaction as the decision
 *   - Review date: revisit with the analytics warehouse (COPS-13 question 1)
 */
const log = createLogger("cops-recommendations.service");
const {
  companies,
  subscriptions,
  subscriptionItems,
  subscriptionInvoices,
  copsProvisionings,
  copsOnboardingInstances,
  copsOnboardingSignals,
  engineeringTickets,
  ticketComments,
  slaClocks,
  copsOutbox,
  copsHealthScores,
  nextBestActionSuggestions,
  tasks,
  activities,
  automations,
  auditLogs,
} = schema;

export const RECOMMENDATION_VERSION_NAME = "cops-recommendation";
const PENDING_TTL_DAYS = 14;

export class RecommendationError extends Error {
  constructor(
    public code: "NOT_FOUND" | "FORBIDDEN" | "BUSINESS_STATE_CONFLICT" | "REASON_REQUIRED",
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
  }
  get status() {
    return { NOT_FOUND: 404, FORBIDDEN: 403, BUSINESS_STATE_CONFLICT: 409, REASON_REQUIRED: 422 }[this.code];
  }
}

export interface RecContext {
  workspaceId: string;
  userId: string;
  requestId: string;
  permissions: readonly string[];
}

/** Calls the model with the messages and returns its raw answer. Injected in tests. */
export type RationaleModel = (messages: { role: "system" | "user"; content: string }[]) => Promise<string>;

export function openRouterModel(apiKey: string | undefined): RationaleModel | null {
  if (!apiKey) return null;
  const client = new OpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1", defaultHeaders: { "HTTP-Referer": "https://skoutai.io", "X-Title": "Skout AI" } });
  return async (messages) => {
    const r = await client.chat.completions.create({ model: process.env.AI_MODEL ?? "openai/gpt-4o-mini", max_tokens: 300, temperature: 0.3, response_format: { type: "json_object" }, messages });
    return r.choices[0]?.message?.content ?? "{}";
  };
}

const can = (ctx: RecContext, key: string) => ctx.permissions.includes(key);

/** The account's data the caller may see, as the rules need it. */
export async function buildAccountContext(db: Db, ctx: RecContext, accountId: string, now = new Date()): Promise<{ context: AccountContext; customerUpdates: { ticketId: string; body: string }[] }> {
  const ws = ctx.workspaceId;
  const [acc] = await db
    .select({ id: companies.id, name: companies.name, healthScore: companies.healthScore, healthState: companies.healthState, healthComputedAt: companies.healthComputedAt })
    .from(companies)
    .where(and(eq(companies.workspaceId, ws), eq(companies.id, accountId), isNull(companies.deletedAt)))
    .limit(1);
  if (!acc) throw new RecommendationError("NOT_FOUND", "Account not found");
  const [score] = await db
    .select({ id: copsHealthScores.id })
    .from(copsHealthScores)
    .where(and(eq(copsHealthScores.workspaceId, ws), eq(copsHealthScores.accountId, accountId)))
    .orderBy(desc(copsHealthScores.computedAt))
    .limit(1);
  const context: AccountContext = { now, account: { ...acc, healthScoreId: score?.id ?? null }, signals: [] };
  const customerUpdates: { ticketId: string; body: string }[] = [];

  if (can(ctx, "commercial:read")) {
    const subs = await db
      .select({
        id: subscriptions.id,
        status: subscriptions.status,
        termEnd: subscriptions.termEnd,
        currency: subscriptions.currency,
        arrMinor: sql<number>`((select coalesce(sum(${subscriptionItems.quantity} * ${subscriptionItems.unitAmountMinor}), 0) from ${subscriptionItems} where ${subscriptionItems.subscriptionId} = ${subscriptions.id}) * 12)::float8`,
      })
      .from(subscriptions)
      .where(and(eq(subscriptions.workspaceId, ws), eq(subscriptions.accountId, accountId)));
    context.subscriptions = subs.map((s) => ({ ...s, arrMinor: Number(s.arrMinor) }));
  }
  if (can(ctx, "billing:read") || can(ctx, "commercial:read")) {
    context.overdueInvoices = await db
      .select({ id: subscriptionInvoices.id, dueAt: subscriptionInvoices.dueAt, amountMinor: subscriptionInvoices.amountMinor, currency: subscriptionInvoices.currency })
      .from(subscriptionInvoices)
      .innerJoin(subscriptions, eq(subscriptions.id, subscriptionInvoices.subscriptionId))
      .where(and(eq(subscriptionInvoices.workspaceId, ws), eq(subscriptions.accountId, accountId), eq(subscriptionInvoices.status, "open"), lt(subscriptionInvoices.dueAt, now)));
  }
  if (can(ctx, "onboarding:read") || can(ctx, "crm:read")) {
    const trials = await db
      .select({ id: copsProvisionings.id, trialEndsAt: copsProvisionings.trialEndsAt })
      .from(copsProvisionings)
      .where(and(eq(copsProvisionings.workspaceId, ws), eq(copsProvisionings.accountId, accountId), eq(copsProvisionings.status, "succeeded"), isNotNull(copsProvisionings.trialEndsAt)));
    const instances = await db
      .select({ id: copsOnboardingInstances.id, activatedAt: copsOnboardingInstances.activatedAt })
      .from(copsOnboardingInstances)
      .where(and(eq(copsOnboardingInstances.workspaceId, ws), eq(copsOnboardingInstances.accountId, accountId)));
    const stalled = instances.length
      ? await db
          .select({ id: copsOnboardingSignals.id, trigger: copsOnboardingSignals.trigger, firedAt: copsOnboardingSignals.firedAt })
          .from(copsOnboardingSignals)
          .where(and(eq(copsOnboardingSignals.workspaceId, ws), inArray(copsOnboardingSignals.instanceId, instances.map((i) => i.id)), gte(copsOnboardingSignals.firedAt, new Date(now.getTime() - 14 * 86_400_000))))
      : [];
    context.onboarding = {
      trials: trials.map((t) => ({ id: t.id, trialEndsAt: t.trialEndsAt! })),
      activated: instances.some((i) => i.activatedAt !== null),
      stalledSignals: stalled,
    };
  }
  if (can(ctx, "tickets:read")) {
    const open = await db
      .select({ id: engineeringTickets.id, title: engineeringTickets.title, priority: engineeringTickets.priority, severity: engineeringTickets.severity })
      .from(engineeringTickets)
      .where(and(eq(engineeringTickets.workspaceId, ws), eq(engineeringTickets.accountId, accountId), inArray(engineeringTickets.status, [...TICKET_OPEN_STATUSES])));
    const ids = open.map((t) => t.id);
    const breached = ids.length
      ? await db.select({ id: slaClocks.id, ticketId: slaClocks.ticketId }).from(slaClocks).where(and(eq(slaClocks.workspaceId, ws), inArray(slaClocks.ticketId, ids), isNotNull(slaClocks.breachedAt)))
      : [];
    context.tickets = open.map((t) => ({ ...t, breachedClockIds: breached.filter((b) => b.ticketId === t.id).map((b) => b.id) }));
    if (ids.length) {
      // Customer-safe comments only. Internal notes never enter the model's context.
      const updates = await db
        .select({ ticketId: ticketComments.ticketId, body: ticketComments.body })
        .from(ticketComments)
        .where(and(eq(ticketComments.workspaceId, ws), inArray(ticketComments.ticketId, ids), eq(ticketComments.visibility, "customer")))
        .orderBy(desc(ticketComments.createdAt))
        .limit(5);
      customerUpdates.push(...updates.map((u) => ({ ticketId: u.ticketId, body: u.body.slice(0, 300) })));
    }
  }
  const signals = await db
    .select({ id: copsOutbox.id, envelope: copsOutbox.envelope })
    .from(copsOutbox)
    .where(and(eq(copsOutbox.tenantId, ws), eq(copsOutbox.eventType, "HealthSignalDetected"), sql`${copsOutbox.envelope}->'payload'->>'account_id' = ${accountId}`))
    .orderBy(desc(copsOutbox.createdAt))
    .limit(10);
  context.signals = signals.map((s) => {
    const e = s.envelope as { occurred_at: string; payload: { signal: string } };
    return { eventId: s.id, signal: e.payload.signal, at: new Date(e.occurred_at) };
  });
  return { context, customerUpdates };
}

const SYSTEM_PROMPT = `You write the rationale for one customer-success recommendation that a person will review.
Use only the facts given. Do not invent numbers, names or events. Be specific and short (1-3 sentences).
Reply with ONLY valid JSON: {"rationale": "...", "evidence_ids": ["<id>", ...]}
evidence_ids must be ids from the EVIDENCE list that support the rationale (at least one).`;

/** The prompt for one candidate. Only the candidate's facts and customer-safe updates are in it. */
export function rationalePrompt(account: AccountContext["account"], c: Candidate, customerUpdates: { ticketId: string; body: string }[]) {
  const evidenceIds = new Set(c.evidence.map((e) => e.id));
  const updates = customerUpdates.filter((u) => evidenceIds.has(u.ticketId));
  const lines = [
    `ACCOUNT: ${account.name}`,
    `RECOMMENDATION: ${c.headline}`,
    `SUGGESTED ACTION: ${c.action.params.title}`,
    "EVIDENCE:",
    ...c.evidence.map((e) => `- id=${e.id} kind=${e.kind}: ${e.label}`),
    ...(updates.length ? ["LATEST CUSTOMER UPDATES ON THESE TICKETS:", ...updates.map((u) => `- ticket ${u.ticketId}: ${u.body}`)] : []),
  ];
  return [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: lines.join("\n") },
  ];
}

/** Accepts the model's answer only when it cites the candidate's own evidence. */
export function acceptRationale(raw: string, c: Candidate): string | null {
  try {
    const parsed = JSON.parse(raw) as { rationale?: unknown; evidence_ids?: unknown };
    const text = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
    const cited = Array.isArray(parsed.evidence_ids) ? parsed.evidence_ids.filter((x): x is string => typeof x === "string") : [];
    const allowed = new Set(c.evidence.map((e) => e.id));
    if (text.length < 20 || text.length > 800 || cited.length === 0 || cited.some((id) => !allowed.has(id))) return null;
    return text;
  } catch {
    return null;
  }
}

export function recommendationDto(r: typeof nextBestActionSuggestions.$inferSelect) {
  return {
    id: r.id,
    account_id: r.entityId,
    type: r.recommendationType,
    headline: r.headline,
    rationale: r.rationale,
    evidence_refs: r.evidenceRefs as EvidenceRef[],
    suggested_action: r.suggestedAction as SuggestedAction | null,
    confidence: r.confidence,
    status: r.status,
    source: r.source,
    evidence_id: r.evidenceId,
    model_version_id: r.modelVersionId,
    prompt_version_id: r.promptVersionId,
    decided_by: r.decidedBy,
    decided_at: r.decidedAt?.toISOString() ?? null,
    decision_reason: r.decisionReason,
    effect: r.effect,
    expires_at: r.expiresAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
  };
}

/** Commercial and billing recommendations stay hidden from a caller who cannot read that data. */
const visibleTypes = (ctx: RecContext) => {
  const hidden = new Set<string>();
  if (!can(ctx, "commercial:read")) hidden.add("renewal_risk");
  if (!can(ctx, "billing:read") && !can(ctx, "commercial:read")) hidden.add("payment_past_due");
  if (!can(ctx, "tickets:read")) (hidden.add("ticket_heavy"), hidden.add("sla_breached"));
  return hidden;
};

export async function listRecommendations(db: Db, ctx: RecContext, accountId: string, status?: string, now = new Date()) {
  // Pending recommendations past their expiry are marked expired first.
  await db
    .update(nextBestActionSuggestions)
    .set({ status: "expired" })
    .where(and(eq(nextBestActionSuggestions.workspaceId, ctx.workspaceId), eq(nextBestActionSuggestions.entityType, "account"), eq(nextBestActionSuggestions.status, "pending"), lt(nextBestActionSuggestions.expiresAt, now)));
  const rows = await db
    .select()
    .from(nextBestActionSuggestions)
    .where(
      and(
        eq(nextBestActionSuggestions.workspaceId, ctx.workspaceId),
        eq(nextBestActionSuggestions.entityType, "account"),
        eq(nextBestActionSuggestions.entityId, accountId),
        ...(status ? [eq(nextBestActionSuggestions.status, status)] : [])
      )
    )
    .orderBy(desc(nextBestActionSuggestions.createdAt))
    .limit(100);
  const hidden = visibleTypes(ctx);
  return rows.filter((r) => !hidden.has(r.recommendationType ?? "")).map(recommendationDto);
}

/** Generates now. One pending recommendation per candidate: regenerating adds nothing new. */
export async function generateRecommendations(db: Db, ctx: RecContext, accountId: string, model: RationaleModel | null, now = new Date()) {
  const { context, customerUpdates } = await buildAccountContext(db, ctx, accountId, now);
  const candidates = recommendationCandidates(context);
  let generated = 0;
  for (const c of candidates) {
    const [existing] = await db
      .select({ id: nextBestActionSuggestions.id })
      .from(nextBestActionSuggestions)
      .where(and(eq(nextBestActionSuggestions.workspaceId, ctx.workspaceId), eq(nextBestActionSuggestions.dedupeKey, c.dedupeKey), eq(nextBestActionSuggestions.status, "pending")))
      .limit(1);
    if (existing) continue;

    const messages = rationalePrompt(context.account, c, customerUpdates);
    const inputHash = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
    let rationale = c.rationale;
    let source: "llm" | "rules" = "rules";
    if (model) {
      try {
        const accepted = acceptRationale(await model(messages), c);
        if (accepted) (rationale = accepted), (source = "llm");
        else log.warn("model rationale refused; using the rule's wording", { type: c.type });
      } catch (err) {
        log.warn("model rationale failed; using the rule's wording", { err, type: c.type });
      }
    }

    const pin = await pinAiClaim(db, {
      workspaceId: ctx.workspaceId,
      entityType: "company",
      entityId: accountId,
      attribute: "cops_recommendation",
      value: { type: c.type, headline: c.headline, rationale, evidence_refs: c.evidence, suggested_action: c.action, confidence: c.confidence, source, input_hash: inputHash },
      source: source === "llm" ? "cops_recommendation_model" : "cops_recommendation_rules",
      method: source === "llm" ? "llm_rationale" : "rule",
      versionName: RECOMMENDATION_VERSION_NAME,
      confidence: c.confidence,
    });
    const inserted = await db
      .insert(nextBestActionSuggestions)
      .values({
        workspaceId: ctx.workspaceId,
        entityType: "account",
        entityId: accountId,
        actionType: c.action.kind,
        headline: c.headline,
        rationale,
        createdBy: ctx.userId,
        status: "pending",
        recommendationType: c.type,
        confidence: c.confidence,
        evidenceRefs: c.evidence,
        suggestedAction: c.action,
        source,
        evidenceId: pin.evidenceId,
        modelVersionId: pin.modelVersionId,
        promptVersionId: pin.promptVersionId,
        inputHash,
        dedupeKey: c.dedupeKey,
        expiresAt: new Date(now.getTime() + PENDING_TTL_DAYS * 86_400_000),
      })
      .onConflictDoNothing()
      .returning({ id: nextBestActionSuggestions.id });
    if (inserted.length) generated++;
  }
  return { generated, data: await listRecommendations(db, ctx, accountId, "pending", now) };
}

async function lockPending(tx: Db, ctx: RecContext, id: string) {
  const [row] = await tx
    .select()
    .from(nextBestActionSuggestions)
    .where(and(eq(nextBestActionSuggestions.workspaceId, ctx.workspaceId), eq(nextBestActionSuggestions.id, id), eq(nextBestActionSuggestions.entityType, "account")))
    .for("update")
    .limit(1);
  if (!row || visibleTypes(ctx).has(row.recommendationType ?? "")) throw new RecommendationError("NOT_FOUND", "Recommendation not found");
  if (row.status !== "pending") throw new RecommendationError("BUSINESS_STATE_CONFLICT", `This recommendation is ${row.status}`, { status: row.status });
  return row;
}

/** Extra write permission (any of) a recommendation type needs on top of crm:write. */
const WRITE_FOR: Record<string, string[]> = { renewal_risk: ["commercial:write"], payment_past_due: ["commercial:write", "billing:write"] };

/**
 * Approves and runs the one action. A start_playbook whose playbook is not installed creates the
 * playbook's task instead, so an approval never dead-ends. Returns the run to enqueue, if any.
 */
export async function approveRecommendation(db: Db, ctx: RecContext, id: string, note: string | undefined, now = new Date()) {
  if (!can(ctx, "crm:write")) throw new RecommendationError("FORBIDDEN", "Approving needs crm:write", { required_permission: "crm:write" });
  let runToEnqueue: string | null = null;
  const result = await db.transaction(async (tx) => {
    const row = await lockPending(tx as never, ctx, id);
    const needed = WRITE_FOR[row.recommendationType ?? ""];
    if (needed && !needed.some((k) => can(ctx, k))) throw new RecommendationError("FORBIDDEN", `Approving this recommendation needs ${needed.join(" or ")}`, { required_permission: needed.join(" or ") });
    const action = row.suggestedAction as SuggestedAction;
    const [acc] = await tx.select({ id: companies.id, ownerId: companies.ownerId, csmId: companies.csmId }).from(companies).where(and(eq(companies.workspaceId, ctx.workspaceId), eq(companies.id, row.entityId))).limit(1);
    if (!acc) throw new RecommendationError("NOT_FOUND", "Account not found");

    let effect: { kind: "task" | "workflow_run"; id: string; fallback?: string } | null = null;
    if (action.kind === "start_playbook" && action.params.playbook_key) {
      const [playbook] = await tx
        .select({ id: automations.id })
        .from(automations)
        .where(and(eq(automations.workspaceId, ctx.workspaceId), eq(automations.templateKey, action.params.playbook_key)))
        .limit(1);
      const version = playbook ? await new AutomationService(tx as never).getLatestPublishedVersion(playbook.id) : null;
      if (playbook && version) {
        const { run } = await createAutomationRunOnce(tx as never, {
          automationId: playbook.id,
          automationVersionId: version.id,
          workspaceId: ctx.workspaceId,
          triggerType: "manual",
          triggerRef: ctx.userId,
          correlationId: ctx.requestId,
          graph: version.graph as AutomationGraph,
          idempotencyKey: `recommendation:${row.id}`,
          triggerPayload: { account_id: acc.id, recommendation_id: row.id, evidence: (row.evidenceRefs as EvidenceRef[]).map((e) => ({ factor: e.kind, reason: e.label })) },
          subject: { type: "account", id: acc.id },
        });
        effect = { kind: "workflow_run", id: run.id };
        runToEnqueue = run.id;
      }
    }
    if (!effect) {
      const assignee = action.params.assign_to === "csm" ? (acc.csmId ?? acc.ownerId ?? ctx.userId) : (acc.ownerId ?? ctx.userId);
      const [task] = await tx
        .insert(tasks)
        .values({
          workspaceId: ctx.workspaceId,
          assignedTo: assignee,
          relatedEntityType: "company",
          relatedEntityId: acc.id,
          title: action.params.title.slice(0, 200),
          type: action.kind === "renewal_prep_task" ? "renewal_action" : action.params.task_type,
          priority: action.params.priority,
          dueDate: new Date(now.getTime() + action.params.due_in_hours * 3_600_000),
        })
        .returning({ id: tasks.id });
      await appendCopsEvent(
        tx as never,
        createCopsEvent({
          eventType: "TaskCreated",
          tenantId: ctx.workspaceId,
          aggregateType: "account",
          aggregateId: acc.id,
          actor: { type: "user", id: ctx.userId },
          correlationId: ctx.requestId,
          payload: { task_id: task!.id, account_id: acc.id, task_type: action.params.task_type },
        })
      );
      effect = { kind: "task", id: task!.id, ...(action.kind === "start_playbook" ? { fallback: "playbook_not_installed" } : {}) };
    }

    const [updated] = await tx
      .update(nextBestActionSuggestions)
      .set({
        status: "approved",
        decidedBy: ctx.userId,
        decidedAt: now,
        decisionReason: note?.trim() || null,
        effect,
        acceptedAt: now,
        acceptedAction: effect.kind === "task" ? "create_task" : "start_playbook",
        acceptedRefId: effect.id,
      })
      .where(eq(nextBestActionSuggestions.id, row.id))
      .returning();
    await recordDecision(tx as never, ctx, row, "approved", note?.trim() || null, effect);
    return recommendationDto(updated!);
  });
  return { data: result, runToEnqueue };
}

export async function dismissRecommendation(db: Db, ctx: RecContext, id: string, reason: string | undefined, now = new Date()) {
  if (!can(ctx, "crm:write")) throw new RecommendationError("FORBIDDEN", "Dismissing needs crm:write", { required_permission: "crm:write" });
  const why = reason?.trim() ?? "";
  if (why.length < 3) throw new RecommendationError("REASON_REQUIRED", "Say why the recommendation is dismissed");
  return db.transaction(async (tx) => {
    const row = await lockPending(tx as never, ctx, id);
    const [updated] = await tx
      .update(nextBestActionSuggestions)
      .set({ status: "dismissed", decidedBy: ctx.userId, decidedAt: now, decisionReason: why.slice(0, 1000) })
      .where(eq(nextBestActionSuggestions.id, row.id))
      .returning();
    await recordDecision(tx as never, ctx, row, "dismissed", why, null);
    return recommendationDto(updated!);
  });
}

/** Audit row and a timeline entry for every decision. */
async function recordDecision(tx: Db, ctx: RecContext, row: typeof nextBestActionSuggestions.$inferSelect, decision: "approved" | "dismissed", reason: string | null, effect: unknown) {
  await tx.insert(auditLogs).values({
    workspaceId: ctx.workspaceId,
    actorType: "user",
    actorId: ctx.userId,
    action: `recommendation.${decision}`,
    entityType: "company",
    entityId: row.entityId,
    beforeState: { recommendation_id: row.id, status: row.status, type: row.recommendationType },
    afterState: { status: decision, effect },
    reason: reason ?? (decision === "approved" ? "Approved" : null),
    correlationId: ctx.requestId,
    sourceChannel: "api",
  });
  const subject = `Recommendation ${decision}: ${row.headline}`.slice(0, 250);
  const [act] = await tx
    .insert(activities)
    .values({ workspaceId: ctx.workspaceId, entityType: "company", entityId: row.entityId, activityType: "workflow", subject, body: `Recommendation ${row.id}`, ownerId: ctx.userId })
    .returning({ id: activities.id });
  await appendActivityRecorded(tx as never, { workspaceId: ctx.workspaceId, activityId: act!.id, activityType: "workflow", entityType: "company", entityId: row.entityId, subject, actorUserId: ctx.userId, correlationId: ctx.requestId });
}

export const newRequestId = () => randomUUID();
