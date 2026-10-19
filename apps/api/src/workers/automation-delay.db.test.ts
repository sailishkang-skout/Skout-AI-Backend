import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import type { Env } from "../config/env.js";
import { createAutomationRun, listRunsWithDueSteps } from "../services/automation-run.service.js";
import type { AutomationGraph } from "../services/automation-graph.js";

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
});
