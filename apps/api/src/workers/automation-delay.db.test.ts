import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import type { Env } from "../config/env.js";
import { cancelRun, createAutomationRun, decideApproval, listRunsWithDueSteps, replayRun } from "../services/automation-run.service.js";
import { upsertActionMode } from "../services/policy-gateway.service.js";
import type { AutomationGraph } from "../services/automation-graph.js";
import { AutomationService } from "../services/automation.service.js";

// The queue is Redis; here each "job" is a direct advanceAutomationRun call, and the delays the
// worker asks for are recorded.
const queued = vi.hoisted(() => ({ delays: [] as number[] }));
vi.mock("./automation-run.queue.js", () => ({
  AUTOMATION_RUN_QUEUE: "test",
  enqueueAutomationRunAdvance: vi.fn(async (_config: unknown, _payload: unknown, delayMs = 0) => {
    queued.delays.push(delayMs);
  }),
}));

const { advanceAutomationRun } = await import("./automation-run.worker.js");
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/** COPS-10 durable delay against real Postgres. Runs only when COPS_TEST_DATABASE_URL is set. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const config = {} as Env;

const graph: AutomationGraph = {
  nodes: [
    { id: "t", type: "trigger", config: {} },
    { id: "wait", type: "delay", config: { seconds: 3600 } },
    { id: "notify", type: "action_notification", config: { title: "Delay fired" } },
  ],
  edges: [
    { id: "e1", source: "t", target: "wait" },
    { id: "e2", source: "wait", target: "notify" },
  ],
};

maybe("COPS-10 durable delay (Postgres)", () => {
  const sql = postgres(url as string, { max: 1 });
  const { db } = createDb(url as string);

  async function startRun(isSimulation = false) {
    const tag = randomUUID().slice(0, 8);
    const [ws] = await sql`insert into workspaces (name, slug) values (${`wf-${tag}`}, ${`wf-delay-${tag}`}) returning id`;
    const [auto] = await sql`insert into automations (workspace_id, name, status, current_version) values (${ws.id}, 'Delay', 'active', 1) returning id`;
    const [version] = await sql`insert into automation_versions (automation_id, version, graph, status) values (${auto.id}, 1, ${sql.json(graph)}, 'published') returning id`;
    const run = await createAutomationRun(db, {
      automationId: auto.id,
      automationVersionId: version.id,
      workspaceId: ws.id,
      triggerType: "manual",
      graph,
      idempotencyKey: `test:${tag}`,
      isSimulation,
    });
    return { workspaceId: ws.id as string, runId: run.id };
  }

  const advance = (r: { workspaceId: string; runId: string }) => advanceAutomationRun(db, config, { automationRunId: r.runId, workspaceId: r.workspaceId });
  const fired = async (workspaceId: string) => (await sql`select count(*)::int as n from notifications where workspace_id = ${workspaceId} and title = 'Delay fired'`)[0].n as number;
  const stepOf = async (runId: string, nodeId: string) => (await sql`select status, run_after, attempt_count from automation_run_steps where automation_run_id = ${runId} and node_id = ${nodeId}`)[0];

  it("a restart mid-delay resumes from the database and the action fires once", async () => {
    queued.delays = [];
    const r = await startRun();
    await advance(r); // trigger
    await advance(r); // delay: records when it may run and hands the step back
    const waiting = await stepOf(r.runId, "wait");
    expect(waiting.status).toBe("pending");
    expect(new Date(waiting.run_after).getTime()).toBeGreaterThan(Date.now() + 3500_000);
    expect(waiting.attempt_count).toBe(0);
    expect(queued.delays).toContain(3600_000);

    // A "restarted" worker has nothing in memory; an early job finds nothing it may claim.
    await advance(r);
    expect(await fired(r.workspaceId)).toBe(0);
    expect((await listRunsWithDueSteps(db, new Date())).some((d) => d.automationRunId === r.runId)).toBe(false);

    // Time passes: the step is due, and the sweep finds the run even though its queued job is gone.
    await sql`update automation_run_steps set run_after = now() - interval '1 second' where automation_run_id = ${r.runId} and node_id = 'wait'`;
    expect((await listRunsWithDueSteps(db, new Date())).some((d) => d.automationRunId === r.runId)).toBe(true);

    // The delayed job and the sweep's job both arrive: the step completes once.
    await Promise.all([advance(r), advance(r)]);
    expect((await stepOf(r.runId, "wait")).status).toBe("succeeded");
    await advance(r); // notify
    await advance(r); // nothing left
    expect(await fired(r.workspaceId)).toBe(1);
    const [run] = await sql`select status from automation_runs where id = ${r.runId}`;
    expect(run.status).toBe("succeeded");
  });

  it("a simulation does not wait", async () => {
    const r = await startRun(true);
    await advance(r);
    await advance(r);
    const step = await stepOf(r.runId, "wait");
    expect(step.status).toBe("succeeded");
    expect(step.run_after).toBeNull();
  });

  it("rollback makes an earlier version live again and leaves an in-flight run on its own version", async () => {
    const tag = randomUUID().slice(0, 8);
    const [ws] = await sql`insert into workspaces (name, slug) values (${`wf-${tag}`}, ${`wf-rollback-${tag}`}) returning id`;
    const svc = new AutomationService(db);
    const auto = await svc.createAutomation(ws.id, { name: "Rollback" });
    const titled = (title: string): AutomationGraph => ({
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === "notify" ? { ...n, config: { title } } : n)),
    });

    const v1 = await svc.publishVersion(ws.id, auto.id, titled("from v1"));
    const inflight = await createAutomationRun(db, { automationId: auto.id, automationVersionId: v1.id, workspaceId: ws.id, triggerType: "manual", graph: titled("from v1"), idempotencyKey: `rb:${tag}` });
    const r = { workspaceId: ws.id as string, runId: inflight.id };
    await advance(r);
    await advance(r); // now waiting on the delay
    await svc.publishVersion(ws.id, auto.id, titled("from v2"));

    const rolled = await svc.rollbackToVersion(ws.id, auto.id, 1);
    expect(rolled).toMatchObject({ version: 3, restoredFrom: 1 });
    expect((await svc.getLatestPublishedVersion(auto.id))!.graph).toEqual(titled("from v1"));
    await expect(svc.rollbackToVersion(ws.id, auto.id, 3)).rejects.toMatchObject({ statusCode: 409 });
    await expect(svc.rollbackToVersion(ws.id, auto.id, 9)).rejects.toMatchObject({ statusCode: 404 });
    const [audit] = await sql`select action, after_state from audit_logs where entity_id = ${auto.id} and action = 'automation.rolled_back'`;
    expect(audit.after_state).toEqual({ version: 3, restoredFrom: 1 });

    // The in-flight run is still on v1 and finishes with v1's step.
    const [pinned] = await sql`select automation_version_id from automation_runs where id = ${inflight.id}`;
    expect(pinned.automation_version_id).toBe(v1.id);
    await sql`update automation_run_steps set run_after = now() - interval '1 second' where automation_run_id = ${inflight.id} and node_id = 'wait'`;
    for (let i = 0; i < 3; i++) await advance(r);
    const [sent] = await sql`select title from notifications where workspace_id = ${ws.id}`;
    expect(sent.title).toBe("from v1");
  });

  async function runOf(g: AutomationGraph, extra: { payload?: Record<string, unknown> } = {}) {
    const tag = randomUUID().slice(0, 8);
    const [ws] = await sql`insert into workspaces (name, slug) values (${`wf-${tag}`}, ${`wf-ctl-${tag}`}) returning id`;
    const [auto] = await sql`insert into automations (workspace_id, name, status, current_version) values (${ws.id}, 'Ctl', 'active', 1) returning id`;
    const [version] = await sql`insert into automation_versions (automation_id, version, graph, status) values (${auto.id}, 1, ${sql.json(g)}, 'published') returning id`;
    const run = await createAutomationRun(db, { automationId: auto.id, automationVersionId: version.id, workspaceId: ws.id, triggerType: "manual", graph: g, idempotencyKey: `ctl:${tag}`, triggerPayload: extra.payload });
    return { workspaceId: ws.id as string, runId: run.id, versionId: version.id as string };
  }
  const approvalGraph: AutomationGraph = {
    nodes: [
      { id: "t", type: "trigger", config: {} },
      { id: "ok", type: "approval", config: { entityType: "account", entityId: "acc-1" } },
      { id: "notify", type: "action_notification", config: { title: "Delay fired" } },
    ],
    edges: [
      { id: "e1", source: "t", target: "ok" },
      { id: "e2", source: "ok", target: "notify" },
    ],
  };
  const runStatus = async (runId: string) => (await sql`select status from automation_runs where id = ${runId}`)[0].status as string;

  it("an approval step waits for a decision; approve runs it once, reject cancels the run", async () => {
    const a = await runOf(approvalGraph);
    await upsertActionMode(db, a.workspaceId, "workflow.step_approval", "approve");
    await advance(a); // trigger
    await advance(a); // approval: the gateway denies it, so it waits
    expect(await runStatus(a.runId)).toBe("awaiting_approval");
    expect((await stepOf(a.runId, "ok")).status).toBe("awaiting_approval");
    await advance(a); // a stray job runs nothing and asks the gateway nothing
    expect((await sql`select count(*)::int as n from policy_decisions where workspace_id = ${a.workspaceId}`)[0].n).toBe(1);

    await decideApproval(db, a.workspaceId, a.runId, "approve", undefined, "looks right");
    await expect(decideApproval(db, a.workspaceId, a.runId, "approve", undefined, null)).rejects.toMatchObject({ statusCode: 409 });
    await advance(a); // approval again, now allowed
    await advance(a); // notify
    await advance(a);
    expect((await stepOf(a.runId, "ok")).status).toBe("succeeded");
    expect(await fired(a.workspaceId)).toBe(1);
    expect(await runStatus(a.runId)).toBe("succeeded");

    const b = await runOf(approvalGraph);
    await upsertActionMode(db, b.workspaceId, "workflow.step_approval", "approve");
    await advance(b);
    await advance(b);
    await decideApproval(db, b.workspaceId, b.runId, "reject", undefined, "wrong account");
    expect(await runStatus(b.runId)).toBe("cancelled");
    await advance(b);
    expect(await fired(b.workspaceId)).toBe(0);
    const [audit] = await sql`select action from audit_logs where entity_id = ${b.runId}`;
    expect(audit.action).toBe("automation.step_rejected");
  });

  it("cancel stops a waiting run for good; replay starts a new run with the same payload and version", async () => {
    const r = await runOf(graph, { payload: { account: { tier: "enterprise" } } });
    await advance(r);
    await advance(r); // waiting on the delay
    await cancelRun(db, r.workspaceId, r.runId, undefined, "customer churned");
    expect(await runStatus(r.runId)).toBe("cancelled");
    expect((await stepOf(r.runId, "wait")).status).toBe("skipped");
    await sql`update automation_run_steps set run_after = now() - interval '1 second' where automation_run_id = ${r.runId}`;
    expect((await listRunsWithDueSteps(db, new Date())).some((d) => d.automationRunId === r.runId)).toBe(false);
    await advance(r);
    expect(await fired(r.workspaceId)).toBe(0);
    await expect(cancelRun(db, r.workspaceId, r.runId, undefined, null)).rejects.toMatchObject({ statusCode: 409 });

    const replay = await replayRun(db, r.workspaceId, r.runId, undefined, "same");
    expect(replay.id).not.toBe(r.runId);
    expect(replay).toMatchObject({ automationVersionId: r.versionId, triggerRef: `replay:${r.runId}`, triggerPayload: { account: { tier: "enterprise" } }, status: "pending" });
  });
});
