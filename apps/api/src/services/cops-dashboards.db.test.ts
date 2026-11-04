import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { COPS_METRICS, metricsForDashboard } from "@skout/shared";
import { aggregate, dashboard, drill, type DashboardFilters, type MetricRow } from "./cops-dashboards.service.js";
import { funnelCohorts } from "./cops-funnel.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/**
 * COPS-13 acceptance against real Postgres: every leadership KPI traces to source events, and the
 * drill-through rows add up to the headline number, with and without filters. Another workspace's
 * data never counts.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-13 dashboards (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  const now = new Date();
  const days = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();
  let ws: string;
  let owner: string;
  const ids: Record<string, string> = {};

  async function event(tenant: string, type: string, payload: Record<string, unknown>, at: string, aggregateId = randomUUID()) {
    const id = randomUUID();
    const envelope = { event_id: id, event_type: type, schema_version: 1, tenant_id: tenant, aggregate_type: "x", aggregate_id: aggregateId, occurred_at: at, actor: { type: "system", id: null }, correlation_id: randomUUID(), causation_id: null, payload };
    await sql`insert into cops_outbox (id, tenant_id, event_type, aggregate_type, aggregate_id, envelope, published_at) values (${id}, ${tenant}, ${type}, 'x', ${aggregateId}, ${sql.json(envelope)}, now())`;
    return id;
  }

  async function seed(name: string) {
    const [w] = await sql`insert into workspaces (name, slug) values (${name}, ${"dash-" + randomUUID()}) returning id`;
    const [p] = await sql`insert into pipelines (workspace_id, name) values (${w.id}, 'Default') returning id`;
    const [st] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${p.id}, 'Qualified', 0) returning id`;
    const company = async (n: string, employees: number, location: string, ownerId: string | null, health?: [number, string]) => {
      const [c] = await sql`insert into companies (workspace_id, name, employee_count, location, owner_id, health_score, health_state)
        values (${w.id}, ${n}, ${employees}, ${location}, ${ownerId}, ${health?.[0] ?? null}, ${health?.[1] ?? null}) returning id`;
      return c.id as string;
    };
    const deal = async (companyId: string, amount: number, currency: string, status = "open") => {
      const [d] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name, amount, currency, status)
        values (${w.id}, ${companyId}, ${p.id}, ${st.id}, 'Deal', ${amount}, ${currency}, ${status}) returning id`;
      return d.id as string;
    };
    const sub = async (accountId: string, oppId: string, status: string, currency: string, qty: number, unit: number, termEnd: string, renewalOpp: string | null = null) => {
      const [s] = await sql`insert into subscriptions (workspace_id, account_id, opportunity_id, status, billing, currency, cadence, term_months, term_start, term_end, renewal_opportunity_id)
        values (${w.id}, ${accountId}, ${oppId}, ${status}, 'invoiced', ${currency}, 'monthly', 12, ${days(-300)}, ${termEnd}, ${renewalOpp}) returning id`;
      await sql`insert into subscription_items (workspace_id, subscription_id, kind, quantity, unit_amount_minor) values (${w.id}, ${s.id}, 'seats', ${qty}, ${unit})`;
      return s.id as string;
    };
    return { ws: w.id as string, company, deal, sub };
  }

  beforeAll(async () => {
    const [u] = await sql`insert into users (email) values (${`dash-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
    owner = u.id;
    const a = await seed("Dash A");
    ws = a.ws;
    const acme = await a.company("Acme", 50, "Mumbai, India", owner, [30, "at_risk"]);
    const globex = await a.company("Globex", 2000, "Berlin, Germany", null, [80, "healthy"]);
    const initech = await a.company("Initech", 500, "Austin, USA", null);
    Object.assign(ids, { acme, globex, initech });

    const acmeDeal = await a.deal(acme, 1000, "INR");
    const globexDeal = await a.deal(globex, 500, "USD");
    const initechRenewal = await a.deal(initech, 300, "USD", "won");
    const initechOrig = await a.deal(initech, 300, "USD", "won");
    await a.sub(acme, acmeDeal, "active", "INR", 2, 50_000, days(30));
    const globexSub = await a.sub(globex, globexDeal, "past_due", "USD", 1, 100_000, days(200));
    await a.sub(initech, initechOrig, "closed", "USD", 1, 30_000, days(-10), initechRenewal);
    await sql`insert into subscription_invoices (workspace_id, subscription_id, period_start, period_end, due_at, amount_minor, currency)
      values (${ws}, ${globexSub}, ${days(-35)}, ${days(-5)}, ${days(-5)}, 100000, 'USD')`;

    await sql`insert into cops_provisionings (workspace_id, account_id, opportunity_id, idempotency_key, status, request, trial_ends_at)
      values (${ws}, ${acme}, ${acmeDeal}, ${randomUUID()}, 'succeeded', '{}'::jsonb, ${days(7)}),
             (${ws}, ${initech}, ${initechOrig}, ${randomUUID()}, 'succeeded', '{}'::jsonb, ${days(5)})`;

    const [t1] = await sql`insert into engineering_tickets (workspace_id, account_id, title, priority, status) values (${ws}, ${acme}, 'Down', 'p1', 'assigned') returning id`;
    const [t2] = await sql`insert into engineering_tickets (workspace_id, account_id, title, priority, status, created_at) values (${ws}, ${initech}, 'Slow', 'p3', 'resolved', ${days(-3)}) returning id`;
    const [inc] = await sql`insert into incidents (workspace_id, title, severity, status, source) values (${ws}, 'Outage', 'high', 'investigating', 'manual') returning id`;
    await sql`insert into incident_ticket_links (workspace_id, incident_id, ticket_id) values (${ws}, ${inc.id}, ${t1.id})`;

    await event(ws, "OpportunityQualified", { opportunity_id: acmeDeal, account_id: acme }, days(-10));
    await event(ws, "OpportunityQualified", { opportunity_id: globexDeal, account_id: globex }, days(-9));
    await event(ws, "ProposalSent", { proposal_id: randomUUID(), opportunity_id: acmeDeal }, days(-9));
    await event(ws, "WorkspaceProvisioned", { account_id: acme, workspace_id: randomUUID() }, days(-8));
    await event(ws, "WorkspaceProvisioned", { account_id: initech, workspace_id: randomUUID() }, days(-7));
    await event(ws, "CustomerActivated", { account_id: acme, rule_version: "1" }, days(-6));
    await event(ws, "PaymentSucceeded", { payment_request_id: randomUUID(), opportunity_id: acmeDeal }, days(-5));
    await event(ws, "SubscriptionStatusChanged", { subscription_id: globexSub, account_id: globex, from: "active", to: "past_due", day: 5 }, days(-4));
    await event(ws, "RenewalOpened", { subscription_id: randomUUID(), account_id: initech, opportunity_id: initechRenewal, original_opportunity_id: initechOrig, term_end: days(-10) }, days(-40));
    await event(ws, "HealthSignalDetected", { account_id: acme, signal: "low_adoption", cycle: "c1", health_score: 30, evidence: [] }, days(-2));
    await event(ws, "TicketCreated", { ticket_id: t1.id, account_id: acme, severity: "critical" }, days(-1));
    await event(ws, "TicketResolved", { ticket_id: t2.id, account_id: initech }, new Date(new Date(days(-3)).getTime() + 120 * 60_000).toISOString());
    const trigger = await event(ws, "TicketEscalated", { ticket_id: t1.id, account_id: acme, severity: "critical" }, days(-1));

    const [auto] = await sql`insert into automations (workspace_id, name) values (${ws}, 'Flow') returning id`;
    const [ver] = await sql`insert into automation_versions (automation_id, version, graph) values (${auto.id}, 1, '{}'::jsonb) returning id`;
    await sql`insert into automation_runs (workspace_id, automation_id, automation_version_id, trigger_type, trigger_ref, status, subject_type, subject_id, finished_at)
      values (${ws}, ${auto.id}, ${ver.id}, 'event', ${trigger}, 'failed', 'account', ${acme}, ${days(-1)}),
             (${ws}, ${auto.id}, ${ver.id}, 'event', ${trigger}, 'failed', 'account', ${acme}, ${days(-1)})`;
    await sql`update automation_runs set is_simulation = true where id = (select id from automation_runs where workspace_id = ${ws} order by id limit 1)`;

    // Another workspace with its own revenue and events: none of it may count above.
    const b = await seed("Dash B");
    const other = await b.company("Other", 50, "Mumbai, India", null, [10, "at_risk"]);
    const otherDeal = await b.deal(other, 9999, "INR");
    await b.sub(other, otherDeal, "active", "INR", 10, 99_999, days(20));
    await event(b.ws, "WorkspaceProvisioned", { account_id: other, workspace_id: randomUUID() }, days(-3));
    await event(b.ws, "OpportunityQualified", { opportunity_id: otherDeal, account_id: other }, days(-3));
  });
  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  const all = () => true;
  async function allRows(metricId: string, f: DashboardFilters): Promise<{ rows: MetricRow[]; total: number }> {
    const rows: MetricRow[] = [];
    let cursor: string | undefined;
    let total = 0;
    do {
      const page = await drill(db, ws, metricId, f, { cursor, limit: 1 }, now);
      rows.push(...page.rows);
      total = page.total;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return { rows, total };
  }

  it("the leadership dashboard shows the Bible p.59 KPIs with the right values, by currency where money", async () => {
    const d = await dashboard(db, ws, "leadership", {}, all, now);
    const k = Object.fromEntries(d.kpis.map((x) => [x.metric_id, x]));
    expect(k["revenue.arr"]).toMatchObject({ value: null, by_currency: [{ currency: "INR", value: 1_200_000 }, { currency: "USD", value: 1_200_000 }], metric_version: 1 });
    expect(k["revenue.mrr"]!.by_currency).toEqual([{ currency: "INR", value: 100_000 }, { currency: "USD", value: 100_000 }]);
    expect(k["revenue.pipeline"]!.by_currency).toEqual([{ currency: "INR", value: 100_000 }, { currency: "USD", value: 50_000 }]);
    expect(k["revenue.renewal_exposure"]!.by_currency).toEqual([{ currency: "INR", value: 1_200_000 }]);
    expect(k["revenue.retention"]).toMatchObject({ value: 1, numerator: 1, denominator: 1 });
    expect(k["trials.active"]!.value).toBe(1);
    expect(k["activation.rate"]).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });
    expect(k["conversion.trial_to_paid"]).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });
    expect(k["cs.at_risk"]!.value).toBe(1);
    expect(k["engineering.critical_open"]!.value).toBe(1);
    expect(k["ops.workflow_failures"]!.value).toBe(1);
    expect(d.window.to).toBe(now.toISOString());
  });

  it("every leadership KPI traces to source events, and its drill-through rows add up to the headline", async () => {
    for (const f of [{}, { geo: "india" }, { segment: "enterprise" as const }, { owner }] as DashboardFilters[]) {
      const d = await dashboard(db, ws, "leadership", f, all, now);
      for (const kpi of d.kpis) {
        const def = COPS_METRICS.find((m) => m.id === kpi.metric_id)!;
        const { rows, total } = await allRows(kpi.metric_id, f);
        expect(total, kpi.metric_id).toBe(rows.length);
        const again = aggregate(def, rows);
        expect(again.value, `${kpi.metric_id} ${JSON.stringify(f)}`).toEqual(kpi.value);
        expect(again.by_currency).toEqual(kpi.by_currency);
        if (def.unit === "count") expect(kpi.value).toBe(total);
        for (const r of rows) {
          expect(r.source_event_ids.length, `${kpi.metric_id} row ${r.record.id} has no source event`).toBeGreaterThan(0);
          const found = await sql`select count(*)::int as n from cops_outbox where tenant_id = ${ws} and id = any(${r.source_event_ids}::uuid[])`;
          expect(found[0].n).toBe(r.source_event_ids.length);
        }
      }
    }
  });

  it("every other dashboard's KPIs match their drill-through too", async () => {
    for (const key of ["sales", "cs", "engineering", "finance"] as const) {
      const d = await dashboard(db, ws, key, {}, all, now);
      expect(d.kpis.map((x) => x.metric_id)).toEqual(metricsForDashboard(key).map((m) => m.id));
      for (const kpi of d.kpis) {
        const def = COPS_METRICS.find((m) => m.id === kpi.metric_id)!;
        const { rows } = await allRows(kpi.metric_id, {});
        expect(aggregate(def, rows).value, kpi.metric_id).toEqual(kpi.value);
      }
    }
    const fin = Object.fromEntries((await dashboard(db, ws, "finance", {}, all, now)).kpis.map((x) => [x.metric_id, x]));
    expect(fin["finance.overdue"]!.by_currency).toEqual([{ currency: "USD", value: 100_000 }]);
    expect(fin["finance.past_due_subscriptions"]!.value).toBe(1);
    const eng = Object.fromEntries((await dashboard(db, ws, "engineering", {}, all, now)).kpis.map((x) => [x.metric_id, x]));
    expect(eng["engineering.mttr"]!.value).toBe(120);
    expect(eng["engineering.open_incidents"]!.value).toBe(1);
  });

  it("filters narrow by segment, geography and owner", async () => {
    const arr = async (f: DashboardFilters) => (await dashboard(db, ws, "leadership", f, all, now)).kpis.find((x) => x.metric_id === "revenue.arr")!;
    expect((await arr({ segment: "enterprise" })).by_currency).toEqual([{ currency: "USD", value: 1_200_000 }]);
    expect((await arr({ geo: "INDIA" })).by_currency).toEqual([{ currency: "INR", value: 1_200_000 }]);
    expect((await arr({ owner })).by_currency).toEqual([{ currency: "INR", value: 1_200_000 }]);
    expect((await arr({ geo: "nowhere" })).value).toBe(0);
  });

  it("a KPI whose resource the caller cannot read is restricted, with no value", async () => {
    const d = await dashboard(db, ws, "leadership", {}, (r) => r !== "commercial", now);
    const arr = d.kpis.find((x) => x.metric_id === "revenue.arr")!;
    expect(arr).toMatchObject({ restricted: true, value: null });
    expect(arr.by_currency).toBeUndefined();
    expect(d.kpis.find((x) => x.metric_id === "engineering.critical_open")!.restricted).toBe(false);
  });

  it("funnel cohorts count each stage from the outbox events", async () => {
    const f = await funnelCohorts(db, ws, {}, now);
    expect(f.cohorts).toHaveLength(1);
    expect(f.cohorts[0]!.counts).toEqual({ qualified: 2, commercial: 1, provisioned: 1, first_login: 0, activated: 1, paid: 1, renewed: 0 });
    expect((await funnelCohorts(db, ws, { segment: "enterprise" }, now)).cohorts[0]!.counts.qualified).toBe(1);
  });
});
