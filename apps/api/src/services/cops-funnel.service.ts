import { sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { FUNNEL_STAGE_EVENTS, FUNNEL_STAGES, resolveWindow, type FunnelStage } from "@skout/shared";
import { DashboardError, type DashboardFilters } from "./cops-dashboards.service.js";

/**
 * COPS-13 funnel cohorts (Bible p.87): qualified → commercial → provisioned → first login →
 * activated → paid → renewed. A cohort is the accounts whose first OpportunityQualified falls in a
 * month of the window; each stage counts the accounts of that cohort with an event of the stage,
 * read from the outbox. Events that name an opportunity map to its account. "Renewed" needs the
 * renewal opportunity to be won, not just opened.
 *
 * DOCUMENTED READ-MODEL EXCEPTION (docs/adr/0003-read-model-exceptions.md, COPS-13 row): reads
 * companies and deals (apps/crm) to map events to accounts and apply the account filters.
 */
const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];

export async function funnelCohorts(db: Db, workspaceId: string, f: DashboardFilters, now = new Date()) {
  let w: { from: Date; to: Date };
  try {
    w = resolveWindow(f.from, f.to, now);
  } catch {
    throw new DashboardError("VALIDATION_FAILED", "The window is not valid");
  }
  const filter = [
    f.segment === "smb" ? sql`coalesce(c.employee_count, 0) < 200` : null,
    f.segment === "mid_market" ? sql`c.employee_count >= 200 and c.employee_count < 1000` : null,
    f.segment === "enterprise" ? sql`c.employee_count >= 1000` : null,
    f.owner ? sql`c.owner_id = ${f.owner}::uuid` : null,
    f.geo ? sql`c.location ilike ${"%" + f.geo.replace(/[\\%_]/g, (ch) => "\\" + ch) + "%"}` : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);
  const accountFilter = filter.length ? sql.join(filter, sql` and `) : sql`true`;

  const stageCases = sql.join(
    FUNNEL_STAGES.map((stage) => {
      const types = sql.join(FUNNEL_STAGE_EVENTS[stage].map((t) => sql`${t}`), sql`, `);
      const won = stage === "renewed" ? sql` and exists (select 1 from deals rd where rd.id::text = e.envelope->'payload'->>'opportunity_id' and rd.status = 'won')` : sql``;
      return sql`count(distinct q.account_id) filter (where exists (
        select 1 from cops_outbox e left join deals ed on ed.id::text = e.envelope->'payload'->>'opportunity_id'
        where e.tenant_id = ${workspaceId}::uuid and e.event_type in (${types})
          and coalesce(e.envelope->'payload'->>'account_id', ed.company_id::text) = q.account_id${won}))::int as ${sql.raw(stage)}`;
    }),
    sql`, `
  );

  const rows = rowsOf<Record<string, string | number>>(
    await db.execute(sql`
      with q as (
        select distinct on (o.envelope->'payload'->>'account_id') o.envelope->'payload'->>'account_id' as account_id,
               (o.envelope->>'occurred_at')::timestamptz as qualified_at
        from cops_outbox o
        where o.tenant_id = ${workspaceId}::uuid and o.event_type = 'OpportunityQualified'
        order by o.envelope->'payload'->>'account_id', (o.envelope->>'occurred_at')::timestamptz
      ), q2 as (
        select q.* from q join companies c on c.id::text = q.account_id and c.workspace_id = ${workspaceId}::uuid
        where q.qualified_at >= ${w.from.toISOString()}::timestamptz and q.qualified_at < ${w.to.toISOString()}::timestamptz and ${accountFilter}
      )
      select to_char(date_trunc('month', q.qualified_at at time zone 'UTC'), 'YYYY-MM') as cohort, ${stageCases}
      from q2 q group by 1 order by 1`)
  );
  return {
    window: { from: w.from.toISOString(), to: w.to.toISOString() },
    stages: FUNNEL_STAGES,
    cohorts: rows.map((r) => ({
      cohort: String(r.cohort),
      counts: Object.fromEntries(FUNNEL_STAGES.map((s) => [s, Number(r[s] ?? 0)])) as Record<FunnelStage, number>,
    })),
  };
}
