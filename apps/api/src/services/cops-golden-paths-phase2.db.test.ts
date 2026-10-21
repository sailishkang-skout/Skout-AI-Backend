import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { evaluateFieldConflict, getPendingConflictFields, recordCrmConflict, resolveCrmConflict } from "./crm-conflict.service.js";
import { createMockEsignAdapter, mockEsignSignature } from "./esign/esign-adapter.js";
import { handleEsignWebhook } from "./cops-esign.service.js";
import { createTicket, type TicketContext } from "./cops-tickets.service.js";
import { runSlaSweep } from "./cops-sla-sweep.service.js";
import { runRenewals } from "./cops-renewals.service.js";
import { projectCopsEventToTimelineRow } from "./cops-timeline.service.js";
import { dashboard, drill } from "./cops-dashboards.service.js";
import { generateRecommendations } from "./cops-recommendations.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/**
 * COPS-13 Phase 2 golden paths (Bible p.90, p.98), on a real Postgres, from the business event to
 * the dashboards: external CRM conflict, e-sign delay, SLA breach, renewal. Each path ends with a
 * replay: delivering the same events or running the same pass again changes nothing (no second
 * event, no second timeline row, the same KPI).
 *
 * What is stood in: the e-sign provider (the mock adapter, signed webhooks) and the event worker
 * (the timeline projector is called with the outbox event, as the worker does).
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const SECRET = "golden-phase2-esign-secret";
const ALL = ["crm:read", "crm:write", "commercial:read", "commercial:write", "billing:read", "onboarding:read", "tickets:read", "analytics:read"];

maybe("COPS-13 Phase 2 golden paths (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  let ws: string;
  let userId: string;
  let accountId: string;
  let pipelineId: string;
  let stageId: string;
  const all = () => true;

  const events = async (type: string, key: string, value: string) =>
    (await sql`select id, envelope from cops_outbox where tenant_id = ${ws} and event_type = ${type} and envelope->'payload'->>${key} = ${value} order by created_at`) as { id: string; envelope: any }[];
  const timelineRows = async (eventId: string) => (await sql`select count(*)::int as n from cops_timeline_events where workspace_id = ${ws} and source_event_id = ${eventId}`)[0].n as number;
  /** Delivers an outbox event to the timeline projector twice: the second delivery is a no-op. */
  async function replayToTimeline(eventId: string, envelope: any) {
    await projectCopsEventToTimelineRow(db, envelope);
    const once = await timelineRows(eventId);
    await projectCopsEventToTimelineRow(db, envelope);
    expect(await timelineRows(eventId)).toBe(once);
  }

  beforeAll(async () => {
    const [w] = await sql`insert into workspaces (name, slug) values ('Golden P2', ${"gp2-" + randomUUID()}) returning id`;
    ws = w.id;
    const [u] = await sql`insert into users (email) values (${`gp2-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
    userId = u.id;
    await sql`insert into workspace_members (workspace_id, user_id, role) values (${ws}, ${userId}, 'owner')`;
    const [c] = await sql`insert into companies (workspace_id, name, employee_count, owner_id, location) values (${ws}, 'Golden Co', 120, ${userId}, 'Pune, India') returning id`;
    accountId = c.id;
    const [p] = await sql`insert into pipelines (workspace_id, name) values (${ws}, 'Sales') returning id`;
    const [s] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${p.id}, 'Qualified', 0) returning id`;
    pipelineId = p.id;
    stageId = s.id;
  });
  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  it("external CRM conflict: manual review blocks the overwrite until resolved; a replayed change does not queue twice", async () => {
    const [conn] = await sql`insert into crm_connections (workspace_id, provider, status, settings) values (${ws}, 'hubspot', 'connected', ${sql.json({ syncEnabled: true })}) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name, amount, currency) values (${ws}, ${accountId}, ${pipelineId}, ${stageId}, 'Golden deal', 1200, 'USD') returning id`;
    const inbound = { workspaceId: ws, connectionId: conn.id, entityType: "deal" as const, entityId: deal.id, externalId: "hs-1", fieldName: "amount", skoutValue: "1200", externalValue: "900", policy: "manual_review" as const };

    expect(evaluateFieldConflict({ fieldName: "amount", skoutValue: "1200", externalValue: "900", policy: "manual_review" }).action).toBe("manual_review");
    const first = await recordCrmConflict(db, inbound);
    expect(await getPendingConflictFields(db, ws, conn.id, "deal", deal.id)).toEqual(new Set(["amount"]));
    const [still] = await sql`select amount from deals where id = ${deal.id}`;
    expect(Number(still.amount)).toBe(1200);

    // The provider sends the same change again (a replayed webhook or poll): one conflict, not two.
    expect(await recordCrmConflict(db, inbound)).toBe(first);
    expect((await sql`select count(*)::int as n from crm_conflicts where entity_id = ${deal.id}`)[0].n).toBe(1);

    await resolveCrmConflict(db, ws, first, { choice: "external", resolvedBy: userId });
    const [after] = await sql`select amount from deals where id = ${deal.id}`;
    expect(Number(after.amount)).toBe(900);
    expect((await getPendingConflictFields(db, ws, conn.id, "deal", deal.id)).size).toBe(0);
    await expect(resolveCrmConflict(db, ws, first, { choice: "skout", resolvedBy: userId })).rejects.toMatchObject({ statusCode: 409 });

    // The pipeline KPI reads the resolved value.
    const pipeline = (await dashboard(db, ws, "sales", {}, all)).kpis.find((k) => k.metric_id === "revenue.pipeline")!;
    expect(pipeline.by_currency).toEqual([{ currency: "USD", value: 90_000 }]);
  });

  it("e-sign delay: the signature arrives before the earlier events and again later; the contract is signed once", async () => {
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name, amount, currency) values (${ws}, ${accountId}, ${pipelineId}, ${stageId}, 'MSA deal', 500, 'USD') returning id`;
    const [contract] = await sql`insert into contracts (workspace_id, opportunity_id, kind, title, status) values (${ws}, ${deal.id}, 'msa', 'MSA', 'sent') returning id`;
    await sql`insert into contract_versions (workspace_id, contract_id, version, document_url, file_sha256) values (${ws}, ${contract.id}, 1, 'https://docs.example.test/msa.pdf', ${"c".repeat(64)})`;
    const ref = `mock_${randomUUID()}`;
    await sql`insert into signature_envelopes (workspace_id, contract_id, contract_version, provider, provider_ref, status, signers, sent_at)
      values (${ws}, ${contract.id}, 1, 'mock', ${ref}, 'sent', ${sql.json([{ name: "Test Signer", email: "signer@example.test", role: "Signer" }])}, now())`;
    const adapter = createMockEsignAdapter({ secret: SECRET, enabled: true });
    const post = (event: Record<string, unknown>) => {
      const body = JSON.stringify({ event_id: randomUUID(), occurred_at: new Date().toISOString(), envelope_ref: ref, ...event });
      return handleEsignWebhook(db, adapter, body, { "x-esign-signature": mockEsignSignature(SECRET, body) }, randomUUID());
    };

    const signedEvent = { event_id: `sig-${ref}`, event_type: "envelope.signed", occurred_at: "2026-10-20T10:30:00.000Z" };
    await post(signedEvent);
    await post({ event_type: "envelope.viewed", occurred_at: "2026-10-20T10:00:00.000Z" });
    await post({ event_type: "envelope.sent", occurred_at: "2026-10-20T09:00:00.000Z" });
    // Replay: the provider retries the signature.
    const retry = await post(signedEvent);
    expect(retry).toMatchObject({ kind: "duplicate" });

    const [c] = await sql`select status from contracts where id = ${contract.id}`;
    expect(c.status).toBe("signed");
    const signed = await events("ContractSigned", "contract_id", contract.id);
    expect(signed).toHaveLength(1);
    await replayToTimeline(signed[0]!.id, signed[0]!.envelope);
  });

  it("SLA breach: the sweep warns, breaches once, the engineering dashboard counts it and a recommendation cites it", async () => {
    const ctx: TicketContext = { workspaceId: ws, userId, requestId: randomUUID() };
    const { ticket } = await createTicket(db, ctx, { account_id: accountId, title: "Golden outage", priority: "p1", severity: "critical" } as never);
    // Five hours later the 4h P1 resolution target has passed.
    const later = new Date(Date.now() + 5 * 3_600_000);
    await runSlaSweep(db, later);
    await runSlaSweep(db, later);
    const breaches = await events("TicketSlaBreached", "ticket_id", ticket.id);
    expect(breaches.map((b) => b.envelope.payload.clock).sort()).toEqual(["resolution", "response"]);
    await replayToTimeline(breaches[0]!.id, breaches[0]!.envelope);

    const window = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(later.getTime() + 60_000).toISOString() };
    const kpi = (await dashboard(db, ws, "engineering", window, all)).kpis.find((k) => k.metric_id === "engineering.sla_breaches")!;
    expect(kpi.value).toBe(2);
    const d = await drill(db, ws, "engineering.sla_breaches", window, {});
    expect(d.rows.flatMap((r) => r.source_event_ids).sort()).toEqual(breaches.map((b) => b.id).sort());
    // Running the sweep again changes nothing.
    await runSlaSweep(db, new Date(later.getTime() + 3_600_000));
    expect(await events("TicketSlaBreached", "ticket_id", ticket.id)).toHaveLength(2);

    const recs = await generateRecommendations(db, { workspaceId: ws, userId, requestId: randomUUID(), permissions: ALL }, accountId, null);
    const sla = recs.data.find((r) => r.type === "sla_breached")!;
    expect(sla.evidence_refs.map((e) => e.id)).toContain(ticket.id);
  });

  // The workspace runs on the default renewal policy (COPS-08): a renewal opens ahead of the term end.
  it("renewal: one renewal opportunity per term, and the CS dashboard drills to the subscription", async () => {
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name, amount, currency, owner_id) values (${ws}, ${accountId}, ${pipelineId}, ${stageId}, 'Annual', 1000, 'INR', ${userId}) returning id`;
    const termEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const [sub] = await sql`insert into subscriptions (workspace_id, account_id, opportunity_id, status, billing, currency, cadence, term_months, term_start, term_end)
      values (${ws}, ${accountId}, ${deal.id}, 'active', 'invoiced', 'INR', 'monthly', 12, ${new Date(Date.now() - 335 * 86_400_000).toISOString()}, ${termEnd}) returning id`;
    await sql`insert into subscription_items (workspace_id, subscription_id, kind, quantity, unit_amount_minor) values (${ws}, ${sub.id}, 'seats', 4, 25000)`;

    const opened = await runRenewals(db, new Date(), { workspaceId: ws });
    expect(opened).toHaveLength(1);
    // Replay: a second pass, and a concurrent one, open nothing more.
    const again = await Promise.all([runRenewals(db, new Date(), { workspaceId: ws }), runRenewals(db, new Date(), { workspaceId: ws })]);
    expect(again.flat()).toHaveLength(0);
    const renewal = await events("RenewalOpened", "subscription_id", sub.id);
    expect(renewal).toHaveLength(1);
    await replayToTimeline(renewal[0]!.id, renewal[0]!.envelope);

    const due = await drill(db, ws, "cs.renewals_due", {}, {});
    const row = due.rows.find((r) => r.record.id === sub.id)!;
    expect(row).toMatchObject({ account_id: accountId, value: 1_200_000, currency: "INR" });
    expect(row.source_event_ids).toContain(renewal[0]!.id);
    const exposure = (await dashboard(db, ws, "leadership", {}, all)).kpis.find((k) => k.metric_id === "revenue.renewal_exposure")!;
    expect(exposure.by_currency).toEqual([{ currency: "INR", value: 1_200_000 }]);
  });
});
