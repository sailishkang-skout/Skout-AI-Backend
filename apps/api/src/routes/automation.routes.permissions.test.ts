import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

// COPS-10: what the member holds in the workspace; each test sets it.
const permissions = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("@skout/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@skout/auth")>()),
  getMemberPermissions: vi.fn(async () => permissions.list),
}));

let app: FastifyInstance;

beforeAll(async () => {
  const config = loadEnv();
  app = await buildApp({ ...config, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, EXPORTS_BUCKET: undefined });
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
});
