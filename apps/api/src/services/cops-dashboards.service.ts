import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@skout/db";
import { getMetric, metricsForDashboard, resolveWindow, TICKET_OPEN_STATUSES, type CopsDashboard, type MetricDefinition } from "@skout/shared";

/**
 * COPS-13 role dashboards and drill-through (Bible p.59, p.88).
 *
 * DOCUMENTED READ-MODEL EXCEPTION (see docs/adr/0003-read-model-exceptions.md, COPS-13 row).
 *   - Tables touched directly: companies, deals, tasks, contacts (owned by apps/crm), read only
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: a KPI and its drill-through must be one query over the account filters (segment,
 *     owner, geography); splitting it into per-table HTTP calls would let the headline and the
 *     drill-through disagree, which the acceptance forbids
 *   - Review date: revisit with the analytics warehouse (COPS-13 question 1)
 *
 * Every KPI is computed from the rows `metricRows` returns, and the drill-through pages through
 * the same rows, so the headline and the drill-through cannot disagree. Each row names the outbox
 * events behind it (`source_event_ids`).
 */

export interface DashboardFilters {
  from?: string;
  to?: string;
  segment?: "smb" | "mid_market" | "enterprise";
  owner?: string;
  geo?: string;
  /** COPS-14 data scope: set by the route, never by the caller. Accounts this user owns or is CSM of. */
  ownedBy?: string;
}

export interface MetricRow {
  account_id: string | null;
  account_name: string | null;
  record: { kind: string; id: string };
  value: number | null;
  currency: string | null;
  occurred_at: string | null;
  /** Percent KPIs: whether the row is in the numerator. */
  counted?: boolean;
  source_event_ids: string[];
}

export interface Kpi {
  metric_id: string;
  metric_version: number;
  label: string;
  unit: string;
  value: number | null;
  by_currency?: { currency: string; value: number }[];
  numerator?: number;
  denominator?: number;
  restricted: boolean;
  window: { from: string; to: string };
}

export class DashboardError extends Error {
  constructor(
    public code: "VALIDATION_FAILED" | "NOT_FOUND" | "FORBIDDEN",
    message: string
  ) {
    super(message);
  }
}

type Ctx = { ws: string; from: Date; to: Date; now: Date; f: DashboardFilters };

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/** The account filters on a companies alias `c`. With no filter it matches every row, including rows with no account. */
function accountFilter(f: DashboardFilters): SQL {
  const parts: SQL[] = [];
  if (f.segment === "smb") parts.push(sql`coalesce(c.employee_count, 0) < 200`);
  if (f.segment === "mid_market") parts.push(sql`c.employee_count >= 200 and c.employee_count < 1000`);
  if (f.segment === "enterprise") parts.push(sql`c.employee_count >= 1000`);
  if (f.owner) parts.push(sql`c.owner_id = ${f.owner}::uuid`);
  if (f.geo) parts.push(sql`c.location ilike ${"%" + f.geo.replace(/[\\%_]/g, (ch) => "\\" + ch) + "%"}`);
  if (f.ownedBy) parts.push(sql`(c.owner_id = ${f.ownedBy}::uuid or c.csm_id = ${f.ownedBy}::uuid)`);
  if (parts.length === 0) return sql`true`;
  return sql`(c.id is not null and ${sql.join(parts, sql` and `)})`;
}

/** The latest outbox events of the given types about an account (by account_id or one of its opportunities). */
function accountEvents(ws: string, accountExpr: SQL, types: readonly string[]): SQL {
  if (types.length === 0) return sql`'{}'::text[]`;
  return sql`(select coalesce(array_agg(x.id::text), '{}') from (
      select o.id from cops_outbox o
      left join deals od on od.id::text = o.envelope->'payload'->>'opportunity_id'
      where o.tenant_id = ${ws}::uuid and o.event_type in (${list(types)})
        and (o.envelope->'payload'->>'account_id' = (${accountExpr})::text or od.company_id = ${accountExpr})
      order by o.created_at desc limit 5) x)`;
}

const MONTHLY_MINOR = sql`(select coalesce(sum(si.quantity * si.unit_amount_minor), 0) from subscription_items si where si.subscription_id = s.id)`;

/** Events of the given types in the window, joined to their account for the filters. */
async function eventRows(db: Db, c: Ctx, types: readonly string[], extra: SQL = sql`true`): Promise<MetricRow[]> {
  const rows = rowsOf<MetricRow & { event_type: string }>(
    await db.execute(sql`
      select coalesce(c.id::text, null) as account_id, c.name as account_name,
             json_build_object('kind', 'event', 'id', o.id::text) as record,
             null::float8 as value, null::text as currency,
             (o.envelope->>'occurred_at') as occurred_at,
             array[o.id::text] as source_event_ids
      from cops_outbox o
      left join deals od on od.id::text = o.envelope->'payload'->>'opportunity_id'
      left join companies c on c.workspace_id = o.tenant_id
        and c.id::text = coalesce(o.envelope->'payload'->>'account_id', od.company_id::text)
      where o.tenant_id = ${c.ws}::uuid and o.event_type in (${list(types)})
        and (o.envelope->>'occurred_at')::timestamptz >= ${c.from.toISOString()}::timestamptz
        and (o.envelope->>'occurred_at')::timestamptz < ${c.to.toISOString()}::timestamptz
        and ${accountFilter(c.f)} and ${extra}
      order by (o.envelope->>'occurred_at')::timestamptz desc, o.id`)
  );
  return rows;
}

/** Accounts provisioned in the window; `counted` when one of `numeratorTypes` exists for them. */
async function provisionedCohortRows(db: Db, c: Ctx, numeratorTypes: readonly string[], numeratorByOpportunity: boolean): Promise<MetricRow[]> {
  const numerator = numeratorByOpportunity
    ? sql`exists (select 1 from cops_outbox n join deals nd on nd.id::text = n.envelope->'payload'->>'opportunity_id'
                  where n.tenant_id = ${c.ws}::uuid and n.event_type in (${list(numeratorTypes)}) and nd.company_id = c.id)`
    : sql`exists (select 1 from cops_outbox n where n.tenant_id = ${c.ws}::uuid and n.event_type in (${list(numeratorTypes)})
                  and n.envelope->'payload'->>'account_id' = c.id::text)`;
  return rowsOf<MetricRow>(
    await db.execute(sql`
      with p as (
        select distinct on (o.envelope->'payload'->>'account_id') o.envelope->'payload'->>'account_id' as account_id, o.id, o.envelope->>'occurred_at' as occurred_at
        from cops_outbox o
        where o.tenant_id = ${c.ws}::uuid and o.event_type = 'WorkspaceProvisioned'
          and (o.envelope->>'occurred_at')::timestamptz >= ${c.from.toISOString()}::timestamptz
          and (o.envelope->>'occurred_at')::timestamptz < ${c.to.toISOString()}::timestamptz
        order by o.envelope->'payload'->>'account_id', (o.envelope->>'occurred_at')::timestamptz
      )
      select c.id::text as account_id, c.name as account_name,
             json_build_object('kind', 'account', 'id', c.id::text) as record,
             null::float8 as value, null::text as currency, p.occurred_at,
             ${numerator} as counted,
             array[p.id::text] || ${accountEvents(c.ws, sql`c.id`, numeratorTypes)} as source_event_ids
      from p join companies c on c.id::text = p.account_id and c.workspace_id = ${c.ws}::uuid
      where ${accountFilter(c.f)}
      order by p.occurred_at desc, c.id`)
  );
}

/** Subscription rows with their monthly or annual value. */
async function subscriptionRows(db: Db, c: Ctx, where: SQL, multiplier: number, types: readonly string[]): Promise<MetricRow[]> {
  return rowsOf<MetricRow>(
    await db.execute(sql`
      select c.id::text as account_id, c.name as account_name,
             json_build_object('kind', 'subscription', 'id', s.id::text) as record,
             (${MONTHLY_MINOR} * ${multiplier})::float8 as value, s.currency,
             s.term_end::text as occurred_at,
             ${accountEvents(c.ws, sql`c.id`, types)} as source_event_ids
      from subscriptions s join companies c on c.id = s.account_id
      where s.workspace_id = ${c.ws}::uuid and ${where} and ${accountFilter(c.f)}
      order by value desc, s.id`)
  );
}

const ACTIVE_SUB = sql`s.status in ('active', 'past_due')`;

/** One rows function per metric id. */
const ROWS: Record<string, (db: Db, c: Ctx, d: MetricDefinition) => Promise<MetricRow[]>> = {
  "revenue.arr": (db, c, d) => subscriptionRows(db, c, ACTIVE_SUB, 12, d.sourceEvents),
  "revenue.mrr": (db, c, d) => subscriptionRows(db, c, ACTIVE_SUB, 1, d.sourceEvents),
  "revenue.renewal_exposure": (db, c, d) =>
    subscriptionRows(db, c, sql`${ACTIVE_SUB} and s.term_end >= ${c.now.toISOString()}::timestamptz and s.term_end < ${new Date(c.now.getTime() + 90 * 86_400_000).toISOString()}::timestamptz`, 12, d.sourceEvents),
  "cs.renewals_due": (db, c, d) =>
    subscriptionRows(db, c, sql`${ACTIVE_SUB} and s.term_end >= ${c.now.toISOString()}::timestamptz and s.term_end < ${new Date(c.now.getTime() + 90 * 86_400_000).toISOString()}::timestamptz`, 12, d.sourceEvents),
  "revenue.retention": async (db, c, d) =>
    rowsOf<MetricRow>(
      await db.execute(sql`
        select c.id::text as account_id, c.name as account_name,
               json_build_object('kind', 'subscription', 'id', s.id::text) as record,
               null::float8 as value, null::text as currency, s.term_end::text as occurred_at,
               coalesce((select rd.status = 'won' from deals rd where rd.id = s.renewal_opportunity_id), false) as counted,
               ${accountEvents(c.ws, sql`c.id`, d.sourceEvents)} as source_event_ids
        from subscriptions s join companies c on c.id = s.account_id
        where s.workspace_id = ${c.ws}::uuid
          and s.term_end >= ${c.from.toISOString()}::timestamptz and s.term_end < ${c.to.toISOString()}::timestamptz
          and ${accountFilter(c.f)}
        order by s.term_end desc, s.id`)
    ),
  "revenue.pipeline": async (db, c, d) =>
    rowsOf<MetricRow>(
      await db.execute(sql`
        select c.id::text as account_id, c.name as account_name,
               json_build_object('kind', 'opportunity', 'id', dl.id::text) as record,
               round(dl.amount * 100)::float8 as value, dl.currency, dl.close_date::text as occurred_at,
               ${accountEvents(c.ws, sql`dl.company_id`, d.sourceEvents)} as source_event_ids
        from deals dl left join companies c on c.id = dl.company_id
        where dl.workspace_id = ${c.ws}::uuid and dl.status = 'open' and dl.deleted_at is null and dl.amount is not null
          and ${accountFilter(c.f)}
        order by value desc, dl.id`)
    ),
  "trials.active": async (db, c, d) =>
    rowsOf<MetricRow>(
      await db.execute(sql`
        select c.id::text as account_id, c.name as account_name,
               json_build_object('kind', 'provisioning', 'id', p.id::text) as record,
               null::float8 as value, null::text as currency, p.trial_ends_at::text as occurred_at,
               ${accountEvents(c.ws, sql`c.id`, d.sourceEvents)} as source_event_ids
        from cops_provisionings p join companies c on c.id = p.account_id
        where p.workspace_id = ${c.ws}::uuid and p.status = 'succeeded'
          and p.trial_ends_at > ${c.now.toISOString()}::timestamptz
          and not exists (select 1 from subscriptions s where s.account_id = c.id and ${ACTIVE_SUB})
          and ${accountFilter(c.f)}
        order by p.trial_ends_at, p.id`)
    ),
  "activation.rate": (db, c) => provisionedCohortRows(db, c, ["CustomerActivated"], false),
  "conversion.trial_to_paid": (db, c) => provisionedCohortRows(db, c, ["PaymentSucceeded"], true),
  "sales.qualified": (db, c, d) => eventRows(db, c, d.sourceEvents),
  "finance.payments": (db, c, d) => eventRows(db, c, d.sourceEvents),
  "engineering.sla_breaches": (db, c, d) => eventRows(db, c, d.sourceEvents),
  "engineering.mttr": async (db, c) =>
    rowsOf<MetricRow>(
      await db.execute(sql`
        select c.id::text as account_id, c.name as account_name,
               json_build_object('kind', 'ticket', 'id', t.id::text) as record,
               round(extract(epoch from ((o.envelope->>'occurred_at')::timestamptz - t.created_at)) / 60)::float8 as value,
               null::text as currency, (o.envelope->>'occurred_at') as occurred_at,
               array[o.id::text] as source_event_ids
        from cops_outbox o
        join engineering_tickets t on t.id::text = o.envelope->'payload'->>'ticket_id' and t.workspace_id = o.tenant_id
        left join companies c on c.id = t.account_id
        where o.tenant_id = ${c.ws}::uuid and o.event_type = 'TicketResolved'
          and (o.envelope->>'occurred_at')::timestamptz >= ${c.from.toISOString()}::timestamptz
          and (o.envelope->>'occurred_at')::timestamptz < ${c.to.toISOString()}::timestamptz
          and ${accountFilter(c.f)}
        order by occurred_at desc, o.id`)
    ),
  "sales.follow_up_completion": async (db, c, d) =>
    rowsOf<MetricRow>(
      await db.execute(sql`
        with ft as (
          select t.id, t.status, t.completed_at, t.due_date,
                 coalesce(f.account_id,
                          case when t.related_entity_type = 'company' then t.related_entity_id end,
                          (select ct.company_id from contacts ct where t.related_entity_type = 'contact' and ct.id = t.related_entity_id)) as account_id
          from tasks t left join cops_follow_ups f on f.task_id = t.id
          where t.workspace_id = ${c.ws}::uuid and t.deleted_at is null
            and (t.sequence_enrollment_id is not null or f.id is not null)
            and t.due_date >= ${c.from.toISOString()}::timestamptz and t.due_date < ${c.to.toISOString()}::timestamptz
        )
        select c.id::text as account_id, c.name as account_name,
               json_build_object('kind', 'task', 'id', ft.id::text) as record,
               null::float8 as value, null::text as currency, ft.due_date::text as occurred_at,
               (ft.status = 'done' or ft.completed_at is not null) as counted,
               ${accountEvents(c.ws, sql`ft.account_id`, d.sourceEvents)} as source_event_ids
        from ft left join companies c on c.id = ft.account_id
        where ${accountFilter(c.f)}
        order by ft.due_date desc, ft.id`)
    ),
  "cs.at_risk": async (db, c, d) =>
    rowsOf<MetricRow>(
      await db.execute(sql`
        select c.id::text as account_id, c.name as account_name,
               json_build_object('kind', 'account', 'id', c.id::text) as record,
               c.health_score::float8 as value, null::text as currency, c.health_computed_at::text as occurred_at,
               ${accountEvents(c.ws, sql`c.id`, d.sourceEvents)} as source_event_ids
        from companies c
        where c.workspace_id = ${c.ws}::uuid and c.deleted_at is null and c.health_state = 'at_risk' and ${accountFilter(c.f)}
        order by c.health_score nulls last, c.id`)
    ),
  "cs.avg_health": async (db, c, d) =>
    rowsOf<MetricRow>(
      await db.execute(sql`
        select c.id::text as account_id, c.name as account_name,
               json_build_object('kind', 'account', 'id', c.id::text) as record,
               c.health_score::float8 as value, null::text as currency, c.health_computed_at::text as occurred_at,
               ${accountEvents(c.ws, sql`c.id`, d.sourceEvents)} as source_event_ids
        from companies c
        where c.workspace_id = ${c.ws}::uuid and c.deleted_at is null and c.health_score is not null and ${accountFilter(c.f)}
        order by c.health_score, c.id`)
    ),
  "engineering.critical_open": async (db, c, d) =>
    rowsOf<MetricRow>(
      await db.execute(sql`
        select c.id::text as account_id, c.name as account_name,
               json_build_object('kind', 'ticket', 'id', t.id::text) as record,
               null::float8 as value, null::text as currency, t.created_at::text as occurred_at,
               (select coalesce(array_agg(o.id::text), '{}') from cops_outbox o
                 where o.tenant_id = ${c.ws}::uuid and o.event_type in (${list(d.sourceEvents)})
                   and o.envelope->'payload'->>'ticket_id' = t.id::text) as source_event_ids
        from engineering_tickets t left join companies c on c.id = t.account_id
        where t.workspace_id = ${c.ws}::uuid and t.priority in ('p1', 'p2') and t.status in (${list(TICKET_OPEN_STATUSES)})
          and ${accountFilter(c.f)}
        order by t.priority, t.created_at, t.id`)
    ),
  "engineering.open_incidents": async (db, c) => {
    const filtered = c.f.segment || c.f.owner || c.f.geo || c.f.ownedBy;
    return rowsOf<MetricRow>(
      await db.execute(sql`
        select null::text as account_id, null::text as account_name,
               json_build_object('kind', 'incident', 'id', i.id::text) as record,
               null::float8 as value, null::text as currency, i.detected_at::text as occurred_at,
               (select coalesce(array_agg(o.id::text), '{}') from cops_outbox o join incident_ticket_links l on l.ticket_id::text = o.envelope->'payload'->>'ticket_id'
                 where o.tenant_id = ${c.ws}::uuid and o.event_type in ('TicketCreated', 'TicketEscalated') and l.incident_id = i.id) as source_event_ids
        from incidents i
        where i.workspace_id = ${c.ws}::uuid and i.status in ('open', 'investigating')
          and (${filtered ? sql`false` : sql`true`} or exists (
            select 1 from incident_ticket_links l join engineering_tickets t on t.id = l.ticket_id
            left join companies c on c.id = t.account_id where l.incident_id = i.id and ${accountFilter(c.f)}))
        order by i.detected_at desc, i.id`)
    );
  },
  "finance.overdue": async (db, c, d) =>
    rowsOf<MetricRow>(
      await db.execute(sql`
        select c.id::text as account_id, c.name as account_name,
               json_build_object('kind', 'invoice', 'id', inv.id::text) as record,
               inv.amount_minor::float8 as value, inv.currency, inv.due_at::text as occurred_at,
               ${accountEvents(c.ws, sql`c.id`, d.sourceEvents)} as source_event_ids
        from subscription_invoices inv join subscriptions s on s.id = inv.subscription_id join companies c on c.id = s.account_id
        where inv.workspace_id = ${c.ws}::uuid and inv.status = 'open' and inv.due_at < ${c.now.toISOString()}::timestamptz
          and ${accountFilter(c.f)}
        order by inv.due_at, inv.id`)
    ),
  "finance.past_due_subscriptions": (db, c, d) => subscriptionRows(db, c, sql`s.status in ('past_due', 'restricted', 'suspended')`, 1, d.sourceEvents),
  "ops.workflow_failures": async (db, c) =>
    rowsOf<MetricRow>(
      await db.execute(sql`
        select c.id::text as account_id, c.name as account_name,
               json_build_object('kind', 'workflow_run', 'id', r.id::text) as record,
               null::float8 as value, null::text as currency, coalesce(r.finished_at, r.created_at)::text as occurred_at,
               case when r.trigger_ref ~ '^[0-9a-f-]{36}$' then array[r.trigger_ref] else '{}'::text[] end as source_event_ids
        from automation_runs r left join companies c on r.subject_type = 'account' and c.id = r.subject_id
        where r.workspace_id = ${c.ws}::uuid and r.status = 'failed' and r.is_simulation = false
          and coalesce(r.finished_at, r.created_at) >= ${c.from.toISOString()}::timestamptz
          and coalesce(r.finished_at, r.created_at) < ${c.to.toISOString()}::timestamptz
          and ${accountFilter(c.f)}
        order by occurred_at desc, r.id`)
    ),
};

function ctxOf(workspaceId: string, f: DashboardFilters, now: Date): Ctx {
  let w: { from: Date; to: Date };
  try {
    w = resolveWindow(f.from, f.to, now);
  } catch (e) {
    throw new DashboardError("VALIDATION_FAILED", e instanceof Error && e.message === "WINDOW_TOO_LONG" ? "The window can be at most two years" : "The window is not valid");
  }
  return { ws: workspaceId, from: w.from, to: w.to, now, f };
}

export async function metricRows(db: Db, workspaceId: string, metricId: string, f: DashboardFilters, now = new Date()): Promise<{ def: MetricDefinition; rows: MetricRow[]; window: { from: string; to: string } }> {
  const def = getMetric(metricId);
  const fn = def ? ROWS[def.id] : undefined;
  if (!def || !fn) throw new DashboardError("NOT_FOUND", "Unknown metric");
  const c = ctxOf(workspaceId, f, now);
  const rows = (await fn(db, c, def)).map((r) => ({ ...r, value: r.value === null || r.value === undefined ? null : Number(r.value), source_event_ids: r.source_event_ids ?? [] }));
  return { def, rows, window: { from: c.from.toISOString(), to: c.to.toISOString() } };
}

/** The headline of a KPI from its rows. The only place a KPI value is computed. */
export function aggregate(def: MetricDefinition, rows: MetricRow[]): Pick<Kpi, "value" | "by_currency" | "numerator" | "denominator"> {
  switch (def.unit) {
    case "count":
      return { value: rows.length };
    case "money": {
      const byCurrency = new Map<string, number>();
      for (const r of rows) byCurrency.set(r.currency ?? "XXX", (byCurrency.get(r.currency ?? "XXX") ?? 0) + (r.value ?? 0));
      const by_currency = [...byCurrency.entries()].map(([currency, value]) => ({ currency, value })).sort((a, b) => a.currency.localeCompare(b.currency));
      return { value: by_currency.length === 1 ? by_currency[0]!.value : by_currency.length === 0 ? 0 : null, by_currency };
    }
    case "percent": {
      const numerator = rows.filter((r) => r.counted).length;
      return { value: rows.length ? numerator / rows.length : null, numerator, denominator: rows.length };
    }
    case "minutes":
    case "score": {
      const vals = rows.map((r) => r.value).filter((v): v is number => v !== null);
      return { value: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null };
    }
  }
}

export async function dashboard(
  db: Db,
  workspaceId: string,
  key: CopsDashboard,
  f: DashboardFilters,
  canRead: (resource: string) => boolean,
  now = new Date()
): Promise<{ dashboard: CopsDashboard; window: { from: string; to: string }; filters: DashboardFilters; kpis: Kpi[] }> {
  const c = ctxOf(workspaceId, f, now);
  const window = { from: c.from.toISOString(), to: c.to.toISOString() };
  const kpis: Kpi[] = [];
  for (const def of metricsForDashboard(key)) {
    const base = { metric_id: def.id, metric_version: def.version, label: def.label, unit: def.unit, window };
    if (!canRead(def.resource)) {
      kpis.push({ ...base, value: null, restricted: true });
      continue;
    }
    const { rows } = await metricRows(db, workspaceId, def.id, f, now);
    kpis.push({ ...base, ...aggregate(def, rows), restricted: false });
  }
  const filters = Object.fromEntries(Object.entries({ segment: f.segment, owner: f.owner, geo: f.geo }).filter(([, v]) => v)) as DashboardFilters;
  return { dashboard: key, window, filters, kpis };
}

/** Drill-through page. `total` and the rows are the same set the KPI value was computed from. */
export async function drill(db: Db, workspaceId: string, metricId: string, f: DashboardFilters, page: { cursor?: string; limit?: number }, now = new Date()) {
  const { def, rows, window } = await metricRows(db, workspaceId, metricId, f, now);
  const limit = Math.min(Math.max(page.limit ?? 50, 1), 200);
  const offset = page.cursor ? Math.max(parseInt(Buffer.from(page.cursor, "base64url").toString("utf8"), 10) || 0, 0) : 0;
  const slice = rows.slice(offset, offset + limit);
  const next = offset + limit < rows.length ? Buffer.from(String(offset + limit), "utf8").toString("base64url") : null;
  return { metric_id: def.id, metric_version: def.version, window, total: rows.length, headline: aggregate(def, rows), rows: slice, next_cursor: next };
}
