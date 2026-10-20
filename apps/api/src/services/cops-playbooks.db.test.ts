import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import type { Env } from "../config/env.js";
import { installSuccessPlaybooks, listPlaybookEnrollments, PLAYBOOK_TEMPLATES } from "./cops-playbooks.service.js";
import { recordAccountHealth, sweepWorkspaceHealth } from "./cops-health.service.js";
import { dispatchWorkflowEvents } from "./automation-triggers.service.js";
import { validateAutomationGraph } from "./automation-graph-validate.js";

vi.mock("../workers/automation-run.queue.js", () => ({ AUTOMATION_RUN_QUEUE: "test", enqueueAutomationRunAdvance: vi.fn(async () => undefined) }));
const { advanceAutomationRun } = await import("../workers/automation-run.worker.js");
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/** COPS-11 success playbooks on the COPS-10 engine, against real Postgres. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-11 success playbooks (Postgres)", () => {
  const sql = postgres(url as string, { max: 1 });
  const { db } = createDb(url as string);

  async function setup() {
    const tag = randomUUID().slice(0, 8);
    const [ws] = await sql`insert into workspaces (name, slug) values (${`pb-${tag}`}, ${`cs-pb-${tag}`}) returning id`;
    const [owner] = await sql`insert into users (email) values (${`sales-${tag}@skout.test`}) returning id`;
    const [csm] = await sql`insert into users (email) values (${`csm-${tag}@skout.test`}) returning id`;
    const [acc] = await sql`insert into companies (workspace_id, name, status, owner_id, csm_id) values (${ws.id}, ${`Acc ${tag}`}, 'customer', ${owner.id}, ${csm.id}) returning id`;
    await installSuccessPlaybooks(db, ws.id, owner.id);
    return { workspaceId: ws.id as string, accountId: acc.id as string, ownerId: owner.id as string, csmId: csm.id as string };
  }
  const runAll = async (workspaceId: string) => {
    const { started } = await dispatchWorkflowEvents(db, new Date(), { tenantIds: [workspaceId] });
    for (const r of started) for (let i = 0; i < 3; i++) await advanceAutomationRun(db, {} as Env, r);
    return started;
  };

  it("installs the five playbooks once, each a valid published workflow", async () => {
    const f = await setup();
    expect((await installSuccessPlaybooks(db, f.workspaceId, null)).installed).toEqual([]);
    const rows = await sql`select template_key, status, current_version from automations where workspace_id = ${f.workspaceId} order by template_key`;
    expect(rows.map((r: { template_key: string }) => r.template_key)).toEqual(PLAYBOOK_TEMPLATES.map((t) => t.key).sort());
    expect(rows.every((r: { status: string; current_version: number }) => r.status === "active" && r.current_version === 1)).toBe(true);
    for (const t of PLAYBOOK_TEMPLATES) expect(validateAutomationGraph(t.graph, { strict: true })).toEqual([]);
  });

  it("a ticket-heavy account enrolls once per cycle: a CSM task with evidence, on the timeline", async () => {
    const f = await setup();
    for (let i = 0; i < 3; i++) {
      await sql`insert into engineering_tickets (workspace_id, account_id, title, severity, status) values (${f.workspaceId}, ${f.accountId}, ${`T${i}`}, 'high', 'new')`;
    }
    await recordAccountHealth(db, f.workspaceId, f.accountId, { requestId: randomUUID() });
    const started = await runAll(f.workspaceId);
    expect(started).toHaveLength(1);

    const enrollments = await listPlaybookEnrollments(db, f.workspaceId, { accountId: f.accountId });
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0]).toMatchObject({ templateKey: "cs_ticket_heavy", status: "succeeded", accountId: f.accountId });
    const [task] = await sql`select title, assigned_to, type from tasks where workspace_id = ${f.workspaceId}`;
    expect(task.assigned_to).toBe(f.csmId);
    expect(task.title).toMatch(/^Ticket-heavy account: run a technical success review — .*3 open ticket\(s\)/);
    const timeline = await sql`select subject from activities where workspace_id = ${f.workspaceId} and entity_id = ${f.accountId} and activity_type = 'workflow' order by occurred_at`;
    expect(timeline.map((t: { subject: string }) => t.subject)).toEqual(["Playbook: ticket-heavy account started", "Playbook: ticket-heavy account completed"]);

    // Same cycle: the signal is not raised again, so nothing enrolls twice.
    await recordAccountHealth(db, f.workspaceId, f.accountId, { requestId: randomUUID() });
    expect(await runAll(f.workspaceId)).toHaveLength(0);
    expect(await listPlaybookEnrollments(db, f.workspaceId, { accountId: f.accountId })).toHaveLength(1);
  });

  it("an expansion signal routes to the sales owner with its evidence", async () => {
    const f = await setup();
    await sweepWorkspaceHealth(db, f.workspaceId, [{ companyId: f.accountId, signalType: "funding_round", detectedAt: "2026-10-15T00:00:00Z" }]);
    await runAll(f.workspaceId);
    const [task] = await sql`select title, assigned_to from tasks where workspace_id = ${f.workspaceId} and title like 'Expansion signal%'`;
    expect(task.assigned_to).toBe(f.ownerId);
    expect(task.title).toBe("Expansion signal — New funding round signal on 2026-10-15");
  });
});
