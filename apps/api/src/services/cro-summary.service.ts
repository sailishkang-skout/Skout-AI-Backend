import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";

const { companies, contacts, deals, activities, users, tasks } = schema;

const STALE_DEAL_DAYS = 14;

/**
 * R19.1/R19.2 — CRO Copilot's data source for the "get_cro_summary" chat tool. Deliberately a
 * self-contained query set (not a call into apps/crm's DashboardService) since apps/api and
 * apps/crm are separately deployed services that happen to share one Postgres — apps/api
 * already reads/writes CRM tables directly elsewhere in Phase 1 (see R20.3, R20.4) for the
 * same reason. Mirrors apps/crm/src/services/dashboard.service.ts#croSummary's shape closely
 * enough that the two won't drift in meaning, just not in code.
 */
export async function computeCroSummary(db: Db, workspaceId: string) {
  const [companyRows, contactRows, openDealRows, staleDealRows, repActivityRows, overdueTaskRows] = await Promise.all([
    db.select({ id: companies.id }).from(companies).where(and(eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt))),
    db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.workspaceId, workspaceId), isNull(contacts.deletedAt))),
    db
      .select({ amount: deals.amount, currency: deals.currency })
      .from(deals)
      .where(and(eq(deals.workspaceId, workspaceId), eq(deals.status, "open"), isNull(deals.deletedAt))),
    db
      .select({ id: deals.id, name: deals.name, amount: deals.amount, currency: deals.currency, updatedAt: deals.updatedAt })
      .from(deals)
      .where(
        and(
          eq(deals.workspaceId, workspaceId),
          eq(deals.status, "open"),
          isNull(deals.deletedAt),
          lt(deals.updatedAt, sql`now() - interval '${sql.raw(String(STALE_DEAL_DAYS))} days'`)
        )
      )
      .orderBy(deals.updatedAt)
      .limit(10),
    db
      .select({
        name: sql<string>`coalesce(${users.fullName}, ${users.email}, 'Unassigned')`,
        activityCount7d: sql<number>`count(*)`,
      })
      .from(activities)
      .leftJoin(users, eq(users.id, activities.ownerId))
      .where(and(eq(activities.workspaceId, workspaceId), sql`${activities.occurredAt} >= now() - interval '7 days'`))
      .groupBy(users.fullName, users.email)
      .orderBy(desc(sql`count(*)`))
      .limit(10),
    db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          eq(tasks.status, "open"),
          isNull(tasks.deletedAt),
          sql`${tasks.dueDate} < now()`
        )
      ),
  ]);

  const pipelineValue = openDealRows.reduce((sum, d) => sum + (d.amount ? Number(d.amount) : 0), 0);
  const currency = openDealRows[0]?.currency ?? "USD";

  return {
    companies: companyRows.length,
    contacts: contactRows.length,
    openDeals: openDealRows.length,
    pipelineValue,
    currency,
    overdueTasks: overdueTaskRows.length,
    staleDeals: staleDealRows.map((d) => ({
      name: d.name,
      amount: d.amount ? Number(d.amount) : null,
      currency: d.currency,
      daysSinceUpdate: Math.floor((Date.now() - d.updatedAt.getTime()) / (1000 * 60 * 60 * 24)),
    })),
    repActivity7d: repActivityRows.map((r) => ({ name: r.name, activityCount: Number(r.activityCount7d) })),
  };
}
