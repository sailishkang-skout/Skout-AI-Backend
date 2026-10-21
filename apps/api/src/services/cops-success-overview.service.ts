/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-11 additions).
 *   - Tables touched directly: companies, tasks (read only)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: the Customer Success screen lists accounts by health with each one's next task.
 *   - Review date: 2026-10-20
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import type { HealthFactor } from "./cops-health.service.js";
import { listPlaybookEnrollments } from "./cops-playbooks.service.js";

const { companies, tasks, subscriptions, copsOnboardingInstances, copsOnboardingMilestones, copsHealthScores, copsOutbox } = schema;
const DAY = 86_400_000;

/**
 * The Customer Success screen in one read (Bible p.66): health distribution, renewal exposure,
 * adoption, the at-risk list with the reason and the next action, expansion signals and playbook
 * enrollments.
 */
export async function getCustomerSuccessOverview(db: Db, workspaceId: string, now = new Date()) {
  const live = and(eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt));

  const dist = await db
    .select({ state: companies.healthState, n: sql<number>`count(*)::int` })
    .from(companies)
    .where(and(live, sql`(${companies.status} = 'customer' or ${companies.healthState} is not null)`))
    .groupBy(companies.healthState);
  const distribution = { healthy: 0, watch: 0, at_risk: 0, unscored: 0 };
  for (const d of dist) distribution[(d.state ?? "unscored") as keyof typeof distribution] += d.n;

  const renewals = await db
    .select({
      accountId: companies.id,
      name: companies.name,
      termEnd: subscriptions.termEnd,
      healthState: companies.healthState,
      renewalRisk: companies.renewalRisk,
      currency: subscriptions.currency,
      // Annual value up for renewal: the monthly line items times twelve, in minor units.
      arrMinor: sql<number>`(select coalesce(sum(si.quantity * si.unit_amount_minor), 0) * 12 from subscription_items si where si.subscription_id = ${subscriptions.id})::float8`,
    })
    .from(subscriptions)
    .innerJoin(companies, eq(subscriptions.accountId, companies.id))
    .where(and(eq(subscriptions.workspaceId, workspaceId), sql`${subscriptions.status} <> 'closed'`, lte(subscriptions.termEnd, new Date(now.getTime() + 90 * DAY)), live))
    .orderBy(asc(subscriptions.termEnd))
    .limit(50);

  const [adoption] = await db
    .select({
      total: sql<number>`count(*)::int`,
      activated: sql<number>`count(*) filter (where ${copsOnboardingInstances.activatedAt} is not null)::int`,
      signedIn: sql<number>`count(*) filter (where ${copsOnboardingInstances.firstLoginAt} is not null)::int`,
      under50: sql<number>`count(*) filter (where ${copsOnboardingInstances.activationPct} < 50)::int`,
      avgPct: sql<number>`coalesce(round(avg(${copsOnboardingInstances.activationPct})), 0)::int`,
    })
    .from(copsOnboardingInstances)
    .where(eq(copsOnboardingInstances.workspaceId, workspaceId));

  // Adoption milestones: for each milestone, how many open onboardings reached it.
  const milestones = await db
    .select({
      key: copsOnboardingMilestones.key,
      label: sql<string>`min(${copsOnboardingMilestones.label})`,
      reached: sql<number>`count(*) filter (where ${copsOnboardingMilestones.completedAt} is not null)::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(copsOnboardingMilestones)
    .where(eq(copsOnboardingMilestones.workspaceId, workspaceId))
    .groupBy(copsOnboardingMilestones.key)
    .orderBy(asc(copsOnboardingMilestones.key));

  const risky = await db
    .select({ accountId: companies.id, name: companies.name, score: companies.healthScore, state: companies.healthState, renewalRisk: companies.renewalRisk, csmId: companies.csmId, ownerId: companies.ownerId })
    .from(companies)
    .where(and(live, inArray(companies.healthState, ["at_risk", "watch"])))
    .orderBy(asc(companies.healthScore))
    .limit(50);
  const ids = risky.map((r) => r.accountId);
  const latest = ids.length
    ? await db
        .selectDistinctOn([copsHealthScores.accountId], { accountId: copsHealthScores.accountId, factors: copsHealthScores.factors })
        .from(copsHealthScores)
        .where(and(eq(copsHealthScores.workspaceId, workspaceId), inArray(copsHealthScores.accountId, ids)))
        .orderBy(copsHealthScores.accountId, desc(copsHealthScores.computedAt))
    : [];
  const next = ids.length
    ? await db
        .selectDistinctOn([tasks.relatedEntityId], { accountId: tasks.relatedEntityId, title: tasks.title, dueDate: tasks.dueDate, assignedTo: tasks.assignedTo })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.relatedEntityType, "company"), inArray(tasks.relatedEntityId, ids), sql`${tasks.status} not in ('done', 'cancelled')`))
        .orderBy(tasks.relatedEntityId, asc(tasks.dueDate))
    : [];
  const reasonsBy = new Map(
    latest.map((l) => [
      l.accountId,
      (l.factors as HealthFactor[])
        .filter((f) => f.points < 0)
        .sort((a, b) => a.points - b.points)
        .slice(0, 2)
        .map((f) => f.reason),
    ])
  );
  const nextBy = new Map(next.map((t) => [t.accountId, t]));
  const atRisk = risky.map((r) => ({
    ...r,
    reasons: reasonsBy.get(r.accountId) ?? [],
    nextAction: nextBy.get(r.accountId) ? { title: nextBy.get(r.accountId)!.title, dueDate: nextBy.get(r.accountId)!.dueDate } : null,
  }));

  const expansion = await db
    .select({ id: copsOutbox.id, accountId: copsOutbox.aggregateId, envelope: copsOutbox.envelope, at: copsOutbox.createdAt })
    .from(copsOutbox)
    .where(and(eq(copsOutbox.tenantId, workspaceId), eq(copsOutbox.eventType, "HealthSignalDetected"), gte(copsOutbox.createdAt, new Date(now.getTime() - 30 * DAY)), sql`${copsOutbox.envelope}->'payload'->>'signal' = 'expansion_signal'`))
    .orderBy(desc(copsOutbox.createdAt))
    .limit(50);
  const names = new Map(
    expansion.length
      ? (await db.select({ id: companies.id, name: companies.name }).from(companies).where(and(live, inArray(companies.id, expansion.map((e) => e.accountId))))).map((c) => [c.id, c.name])
      : []
  );
  const expansionSignals = expansion.map((e) => ({
    accountId: e.accountId,
    name: names.get(e.accountId) ?? null,
    evidence: ((e.envelope as { payload?: { evidence?: { reason: string }[] } }).payload?.evidence ?? []).map((x) => x.reason),
    at: e.at,
  }));

  const playbooks = await listPlaybookEnrollments(db, workspaceId, { limit: 50 });
  return { distribution, renewalExposure: renewals, adoption: { ...adoption, milestones }, atRisk, expansionSignals, playbooks };
}
