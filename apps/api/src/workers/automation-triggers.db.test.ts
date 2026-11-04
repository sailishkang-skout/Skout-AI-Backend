import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import type { Env } from "../config/env.js";
import { AutomationService } from "../services/automation.service.js";
import { dispatchWorkflowEvents, runScheduledWorkflows } from "../services/automation-triggers.service.js";
import type { AutomationGraph } from "../services/automation-graph.js";

vi.mock("./automation-run.queue.js", () => ({ AUTOMATION_RUN_QUEUE: "test", enqueueAutomationRunAdvance: vi.fn(async () => undefined) }));
const { advanceAutomationRun } = await import("./automation-run.worker.js");
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/** COPS-10 event, state-change and schedule triggers and stop events, against real Postgres. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-10 workflow triggers (Postgres)", () => {
  const sql = postgres(url as string, { max: 1 });
  const { db } = createDb(url as string);

  const flow = (trigger: Record<string, unknown>): AutomationGraph => ({
    nodes: [
      { id: "t", type: "trigger", config: trigger },
      { id: "wait", type: "delay", config: { seconds: 3600 } },
      { id: "n", type: "action_notification", config: { title: "Triggered" } },
    ],
    edges: [
      { id: "e1", source: "t", target: "wait" },
      { id: "e2", source: "wait", target: "n" },
    ],
  });

  async function setup(trigger: Record<string, unknown>) {
    const tag = randomUUID().slice(0, 8);
    const [ws] = await sql`insert into workspaces (name, slug) values (${`wf-${tag}`}, ${`wf-trig-${tag}`}) returning id`;
    const [acc] = await sql`insert into companies (workspace_id, name) values (${ws.id}, ${`Acc ${tag}`}) returning id`;
    const svc = new AutomationService(db);
    const auto = await svc.createAutomation(ws.id, { name: "Triggered" });
    await svc.publishVersion(ws.id, auto.id, flow(trigger));
    return { workspaceId: ws.id as string, accountId: acc.id as string, automationId: auto.id };
  }

  async function emit(workspaceId: string, eventType: string, payload: Record<string, unknown>, createdAt?: Date) {
    const id = randomUUID();
    const aggregateId = String(payload.account_id ?? id);
    const envelope = {
      event_id: id,
      event_type: eventType,
      schema_version: 1,
      tenant_id: workspaceId,
      aggregate_type: "account",
      aggregate_id: aggregateId,
      occurred_at: new Date().toISOString(),
      actor: { type: "system", id: null },
      correlation_id: randomUUID(),
      causation_id: null,
      payload,
    };
    await sql`insert into cops_outbox (id, tenant_id, event_type, aggregate_type, aggregate_id, envelope, created_at)
      values (${id}, ${workspaceId}, ${eventType}, ${"account"}, ${aggregateId}, ${sql.json(envelope)}, ${createdAt ?? new Date()})`;
    return id;
  }
  const runsOf = (automationId: string) =>
    sql`select id, status, trigger_type, subject_id, trigger_payload, idempotency_key from automation_runs where automation_id = ${automationId} order by created_at`;
  const sweep = (workspaceId: string) => dispatchWorkflowEvents(db, new Date(), { tenantIds: [workspaceId] });

  it("an event starts one run per event for its account; an earlier event and a repeat sweep start none", async () => {
    const f = await setup({ kind: "event", eventType: "TicketCreated", stopOn: ["CustomerActivated"] });
    await emit(f.workspaceId, "TicketCreated", { ticket_id: "t-1", account_id: f.accountId, severity: "high" }, new Date(Date.now() - 3600_000));
    const eventId = await emit(f.workspaceId, "TicketCreated", { ticket_id: "t-2", account_id: f.accountId, severity: "high" });
    await emit(f.workspaceId, "TicketResolved", { ticket_id: "t-2", account_id: f.accountId });

    expect((await sweep(f.workspaceId)).started).toHaveLength(1);
    expect((await sweep(f.workspaceId)).started).toHaveLength(0);
    const runs = await runsOf(f.automationId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger_type: "event", subject_id: f.accountId, idempotency_key: `event:${eventId}` });
    expect(runs[0].trigger_payload).toMatchObject({ event_type: "TicketCreated", ticket_id: "t-2" });

    // While it waits on the delay, the account activates: the stop event cancels the run.
    const r = { automationRunId: runs[0].id, workspaceId: f.workspaceId };
    await advanceAutomationRun(db, {} as Env, r);
    await advanceAutomationRun(db, {} as Env, r);
    await emit(f.workspaceId, "CustomerActivated", { account_id: f.accountId, rule_version: "1" });
    expect((await sweep(f.workspaceId)).cancelled).toBe(1);
    expect((await runsOf(f.automationId))[0].status).toBe("cancelled");
  });

  it("a state-change trigger matches the dimension and the state it moved into", async () => {
    const f = await setup({ kind: "state_change", eventType: "LifecycleTransitioned", dimension: "onboarding", toState: "stalled" });
    const move = (to: string, dimension = "onboarding") =>
      emit(f.workspaceId, "LifecycleTransitioned", { dimension, entity_id: randomUUID(), from: "active", to, account_id: f.accountId });
    await move("completed");
    await move("stalled", "health");
    await move("stalled");
    expect((await sweep(f.workspaceId)).started).toHaveLength(1);
  });

  it("a schedule starts one run per slot, however often the sweep runs", async () => {
    const f = await setup({ kind: "schedule", everyMinutes: 15 });
    await sql`update automation_versions set published_at = now() - interval '1 day' where automation_id = ${f.automationId}`;
    const now = new Date();
    const a = await runScheduledWorkflows(db, now, { tenantIds: [f.workspaceId] });
    const b = await runScheduledWorkflows(db, new Date(now.getTime() + 1000), { tenantIds: [f.workspaceId] });
    const sameSlot = Math.floor(now.getTime() / 900_000) === Math.floor((now.getTime() + 1000) / 900_000);
    expect(a.length + b.length).toBe(sameSlot ? 1 : 2);
    const next = await runScheduledWorkflows(db, new Date(now.getTime() + 15 * 60_000), { tenantIds: [f.workspaceId] });
    expect(next).toHaveLength(1);
    expect((await runsOf(f.automationId)).every((r: { trigger_type: string }) => r.trigger_type === "schedule")).toBe(true);
  });
});
