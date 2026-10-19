import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import type { Env } from "../config/env.js";
import { AutomationService } from "../services/automation.service.js";
import { createAutomationRun } from "../services/automation-run.service.js";
import { validateAutomationGraph } from "../services/automation-graph-validate.js";
import type { AutomationGraph } from "../services/automation-graph.js";

vi.mock("./automation-run.queue.js", () => ({ AUTOMATION_RUN_QUEUE: "test", enqueueAutomationRunAdvance: vi.fn(async () => undefined) }));
const { advanceAutomationRun } = await import("./automation-run.worker.js");
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/** COPS-10 actions (create task, create ticket, update allowed fields, notify) and exactly-once, on Postgres. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-10 workflow actions (Postgres)", () => {
  const sql = postgres(url as string, { max: 1 });
  const { db } = createDb(url as string);

  it("each action makes its effect once, even when its step runs again after a crash", async () => {
    const tag = randomUUID().slice(0, 8);
    const [ws] = await sql`insert into workspaces (name, slug) values (${`wf-${tag}`}, ${`wf-act-${tag}`}) returning id`;
    const [owner] = await sql`insert into users (email) values (${`owner-${tag}@skout.test`}) returning id`;
    await sql`insert into workspace_members (workspace_id, user_id, role) values (${ws.id}, ${owner.id}, 'owner')`;
    const [acc] = await sql`insert into companies (workspace_id, name, owner_id) values (${ws.id}, ${`Acc ${tag}`}, ${owner.id}) returning id`;
    const [contact] = await sql`insert into contacts (workspace_id, company_id, first_name, email, title) values (${ws.id}, ${acc.id}, 'Ada', ${`ada-${tag}@acme.test`}, 'Manager') returning id`;

    const graph: AutomationGraph = {
      nodes: [
        { id: "t", type: "trigger", config: {} },
        { id: "task", type: "action_create_task", config: { title: "Call {{t.reason}}", type: "call", priority: "high", dueInHours: 4 } },
        { id: "ticket", type: "action_create_ticket", config: { title: "Login fails", severity: "high" } },
        { id: "upd", type: "action_update_fields", config: { entityType: "contact", entityId: contact.id, fields: { title: "VP Sales" } } },
        { id: "n", type: "action_notification", config: { title: "Done" } },
      ],
      edges: [
        { id: "e1", source: "t", target: "task" },
        { id: "e2", source: "task", target: "ticket" },
        { id: "e3", source: "ticket", target: "upd" },
        { id: "e4", source: "upd", target: "n" },
      ],
    };
    expect(validateAutomationGraph(graph, { strict: true })).toEqual([]);
    const svc = new AutomationService(db);
    const auto = await svc.createAutomation(ws.id, { name: "Actions", createdBy: owner.id });
    const version = await svc.publishVersion(ws.id, auto.id, graph, owner.id);
    const run = await createAutomationRun(db, {
      automationId: auto.id,
      automationVersionId: version.id,
      workspaceId: ws.id,
      triggerType: "manual",
      graph,
      idempotencyKey: `act:${tag}`,
      triggerPayload: { reason: "the renewal" },
      subject: { type: "account", id: acc.id },
    });
    const r = { automationRunId: run.id, workspaceId: ws.id as string };
    for (let i = 0; i < 6; i++) await advanceAutomationRun(db, {} as Env, r);

    const [{ status }] = await sql`select status from automation_runs where id = ${run.id}`;
    expect(status).toBe("succeeded");
    const taskRows = await sql`select title, type, priority, assigned_to from tasks where workspace_id = ${ws.id}`;
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]).toMatchObject({ title: "Call the renewal", type: "call", priority: "high", assigned_to: owner.id });
    const tickets = await sql`select title, severity, created_by from engineering_tickets where workspace_id = ${ws.id}`;
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ title: "Login fails", severity: "high", created_by: owner.id });
    const [c] = await sql`select title from contacts where id = ${contact.id}`;
    expect(c.title).toBe("VP Sales");
    expect((await sql`select count(*)::int as n from automation_step_effects where automation_run_id = ${run.id}`)[0].n).toBe(4);
    expect((await sql`select count(*)::int as n from cops_outbox where tenant_id = ${ws.id} and event_type = 'TaskCreated'`)[0].n).toBe(1);

    // A crash after the task committed but before its step was marked done: the step runs again.
    await sql`update automation_run_steps set status = 'pending', lease_owner = null, lease_expires_at = null where automation_run_id = ${run.id} and node_id = 'task'`;
    await sql`update automation_runs set status = 'running', finished_at = null where id = ${run.id}`;
    await advanceAutomationRun(db, {} as Env, r);
    expect((await sql`select count(*)::int as n from tasks where workspace_id = ${ws.id}`)[0].n).toBe(1);
    const [step] = await sql`select status, output from automation_run_steps where automation_run_id = ${run.id} and node_id = 'task'`;
    expect(step.status).toBe("succeeded");
    expect(step.output).toMatchObject({ replayed: true });
  });

  it("refuses a field the CRM sync does not own, and an HTTP call to a private host", async () => {
    const bad: AutomationGraph = {
      nodes: [
        { id: "t", type: "trigger", config: {} },
        { id: "h", type: "action_http", config: { url: "http://169.254.169.254/latest/meta-data" } },
        { id: "h2", type: "action_http", config: { url: "https://localhost:8080/admin" } },
        { id: "h3", type: "action_http", config: { url: "https://hooks.example.com/{{t.path}}" } },
      ],
      edges: [
        { id: "e1", source: "t", target: "h" },
        { id: "e2", source: "h", target: "h2" },
        { id: "e3", source: "h2", target: "h3" },
      ],
    };
    expect(validateAutomationGraph(bad, { strict: true }).map((i) => i.path)).toEqual(["nodes[1].config.url", "nodes[2].config.url"]);

    const { updateFieldsActionNodeHandler } = await import("../services/automation-nodes/action-update-fields.node.js");
    await expect(
      updateFieldsActionNodeHandler({
        db,
        config: {} as Env,
        workspaceId: randomUUID(),
        runId: randomUUID(),
        isSimulation: false,
        node: { id: "u", type: "action_update_fields", config: { entityType: "contact", entityId: randomUUID(), fields: { workspaceId: randomUUID() } } },
        priorOutputs: {},
      })
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});
