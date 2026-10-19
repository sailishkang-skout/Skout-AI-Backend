import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { schema } from "@skout/db";
import { randomUUID } from "node:crypto";

// COPS-10: what the member holds in the workspace; each test sets it.
const permissions = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("@skout/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@skout/auth")>()),
  getMemberPermissions: vi.fn(async () => permissions.list),
}));

let app: FastifyInstance;

beforeAll(async () => {
  const config = loadEnv();
  // No Redis: runs are advanced inline below, never by a worker that may share this database.
  app = await buildApp({ ...config, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, EXPORTS_BUCKET: undefined, REDIS_URL: undefined });
}, 30000);

afterAll(async () => {
  await app?.close();
});

const headers = { "x-stub-user-email": "automation-permissions@test.com", "content-type": "application/json" };

describe("automation routes: permissions and graph checks", () => {
  it("a member without workspace:manage can list workflows but not create one", async () => {
    permissions.list = ["crm:read"];
    const list = await app.inject({ method: "GET", url: "/api/v1/automations", headers });
    expect(list.statusCode).toBe(200);
    const create = await app.inject({ method: "POST", url: "/api/v1/automations", headers, payload: { name: "Nope" } });
    expect(create.statusCode).toBe(403);
  });

  it("refuses a node type outside the allowlist and an incomplete graph on publish", async () => {
    permissions.list = ["workspace:manage"];
    const create = await app.inject({ method: "POST", url: "/api/v1/automations", headers, payload: { name: "Checked" } });
    expect(create.statusCode).toBe(201);
    const { id } = create.json().data;

    const draft = await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/versions`,
      headers,
      payload: { graph: { nodes: [{ id: "x", type: "run_code", config: {} }], edges: [] } },
    });
    expect(draft.statusCode).toBe(422);
    expect(JSON.stringify(draft.json())).toContain("run_code is not allowed");

    const publish = await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/versions/publish`,
      headers,
      payload: { graph: { nodes: [{ id: "t", type: "trigger", config: {} }, { id: "n", type: "action_notification", config: {} }], edges: [{ id: "e", source: "t", target: "n" }] } },
    });
    expect(publish.statusCode).toBe(422);
    expect(JSON.stringify(publish.json())).toContain("action_notification needs title");
  });

  it("records the trigger payload and subject; history filters by workflow, version and account", async () => {
    permissions.list = ["workspace:manage"];
    const create = await app.inject({ method: "POST", url: "/api/v1/automations", headers, payload: { name: "History" } });
    const { id, workspaceId } = create.json().data;
    const [account] = await app.db!.insert(schema.companies).values({ workspaceId, name: `Hist ${randomUUID().slice(0, 6)}` }).returning();
    const [other] = await app.db!.insert(schema.workspaces).values({ name: "Other", slug: `other-${randomUUID()}` }).returning();
    const [foreign] = await app.db!.insert(schema.companies).values({ workspaceId: other!.id, name: "Foreign" }).returning();

    const graph = (title: string) => ({
      nodes: [
        { id: "t", type: "trigger", config: {} },
        { id: "c", type: "condition", config: { match: "all", rules: [{ sourceNodeId: "t", field: "account.tier", op: "equals", value: "enterprise" }] } },
        { id: "n", type: "action_notification", config: { title } },
      ],
      edges: [
        { id: "e1", source: "t", target: "c" },
        { id: "e2", source: "c", target: "n", branch: "true" },
      ],
    });
    const run = async (subjectId: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/automations/${id}/run`,
        headers,
        payload: { payload: { account: { tier: "enterprise" } }, subject: { type: "account", id: subjectId } },
      });

    await app.inject({ method: "POST", url: `/api/v1/automations/${id}/versions/publish`, headers, payload: { graph: graph("v1") } });
    const first = await run(account!.id);
    expect(first.statusCode).toBe(202);
    expect(first.json().data).toMatchObject({ subjectType: "account", subjectId: account!.id, triggerPayload: { account: { tier: "enterprise" } } });
    expect((await run(foreign!.id)).statusCode).toBe(422);

    // The trigger passes its payload on, so the condition reads it.
    const { advanceAutomationRun } = await import("../workers/automation-run.worker.js");
    for (let i = 0; i < 3; i++) await advanceAutomationRun(app.db!, loadEnv(), { automationRunId: first.json().data.id, workspaceId });
    const detail = await app.inject({ method: "GET", url: `/api/v1/automations/runs/${first.json().data.id}`, headers });
    const cond = detail.json().data.steps.find((s: { nodeId: string }) => s.nodeId === "c");
    expect(cond.output).toMatchObject({ matches: true, rules: [{ field: "account.tier", actual: "enterprise", matched: true }] });

    await app.inject({ method: "POST", url: `/api/v1/automations/${id}/versions/publish`, headers, payload: { graph: graph("v2") } });
    await run(account!.id);

    const all = await app.inject({ method: "GET", url: `/api/v1/automations/${id}/runs`, headers });
    expect(all.json().data.map((r: { version: number }) => r.version)).toEqual([2, 1]);
    const v1 = await app.inject({ method: "GET", url: `/api/v1/automations/${id}/runs?version=1`, headers });
    expect(v1.json().data).toHaveLength(1);
    const byAccount = await app.inject({ method: "GET", url: `/api/v1/automations/runs?account_id=${account!.id}`, headers });
    expect(byAccount.json().data).toHaveLength(2);
    const paged = await app.inject({ method: "GET", url: `/api/v1/automations/${id}/runs?limit=1`, headers });
    expect(paged.json().next_before).toBeTruthy();
  });
});
