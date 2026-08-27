import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeAll(async () => {
  const config = loadEnv();
  app = await buildApp({
    ...config,
    CLERK_SECRET_KEY: undefined,
    LOG_LEVEL: "fatal",
    OPENSEARCH_URL: undefined,
    EXPORTS_BUCKET: undefined,
  });
}, 30000);

afterAll(async () => {
  await app?.close();
});

function asUser(email: string) {
  return { "x-stub-user-email": email };
}

describe("automation routes", () => {
  it("POST /automations creates a draft automation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/automations",
      headers: { ...asUser("automation-create@test.com"), "content-type": "application/json" },
      payload: { name: "My automation" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe("draft");
  });

  it("PATCH /automations/:id renames the automation", async () => {
    const email = "automation-rename@test.com";
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/automations",
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { name: "Untitled automation" },
    });
    const { id } = create.json().data;

    const rename = await app.inject({
      method: "PATCH",
      url: `/api/v1/automations/${id}`,
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { name: "Lead enrichment" },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().data.name).toBe("Lead enrichment");

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/automations/${id}`,
      headers: asUser(email),
    });
    expect(get.json().data.name).toBe("Lead enrichment");
  });

  it("POST /automations/runs/:runId/retry resets a failed run's steps and reopens it", async () => {
    const email = "automation-retry@test.com";
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/automations",
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { name: "Retry test automation" },
    });
    const { id, workspaceId } = create.json().data;

    // A node type with no registered handler fails deterministically regardless of simulation —
    // every real node type short-circuits before doing anything risky when isSimulation is true.
    const graph = { nodes: [{ id: "n1", type: "not_a_real_node_type", config: {} }], edges: [] };
    await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/versions/publish`,
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { graph },
    });

    const run = await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/run`,
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { isSimulation: true },
    });
    const runId = run.json().data.id;

    // Directly advance the run inline (no worker/Redis in this test env) until it fails.
    const { advanceAutomationRun } = await import("../workers/automation-run.worker.js");
    const config = loadEnv();
    await advanceAutomationRun(app.db!, config, { automationRunId: runId, workspaceId });

    const failed = await app.inject({ method: "GET", url: `/api/v1/automations/runs/${runId}`, headers: asUser(email) });
    expect(failed.json().data.run.status).toBe("failed");

    const retry = await app.inject({
      method: "POST",
      url: `/api/v1/automations/runs/${runId}/retry`,
      headers: { ...asUser(email), "content-type": "application/json" },
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().data.status).toBe("running");

    const reopened = await app.inject({ method: "GET", url: `/api/v1/automations/runs/${runId}`, headers: asUser(email) });
    expect(reopened.json().data.run.status).toBe("running");
    expect(reopened.json().data.steps.every((s: { status: string }) => s.status !== "failed")).toBe(true);
  });

  it("POST /automations/runs/:runId/retry returns 422 for a run that isn't failed", async () => {
    const email = "automation-retry-422@test.com";
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/automations",
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { name: "Not-failed automation" },
    });
    const { id } = create.json().data;
    const graph = { nodes: [{ id: "n1", type: "delay", config: { seconds: 1 } }], edges: [] };
    await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/versions/publish`,
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { graph },
    });
    const run = await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/run`,
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { isSimulation: true },
    });
    const runId = run.json().data.id;

    const retry = await app.inject({
      method: "POST",
      url: `/api/v1/automations/runs/${runId}/retry`,
      headers: { ...asUser(email), "content-type": "application/json" },
    });
    expect(retry.statusCode).toBe(422);
  });

  it("POST /automations/:id/run returns 422 when the automation has no published version", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/automations",
      headers: { ...asUser("automation-run-422@test.com"), "content-type": "application/json" },
      payload: { name: "Unpublished automation" },
    });
    const { id } = create.json().data;

    const run = await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/run`,
      headers: { ...asUser("automation-run-422@test.com"), "content-type": "application/json" },
      payload: {},
    });
    expect(run.statusCode).toBe(422);
  });

  it("POST /automations/:id/run simulates off the saved draft without requiring a publish first", async () => {
    const email = "automation-simulate-draft@test.com";
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/automations",
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { name: "Draft-only automation" },
    });
    const { id } = create.json().data;

    const graph = {
      nodes: [{ id: "n1", type: "delay", config: { seconds: 1 } }],
      edges: [],
    };

    const saveDraft = await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/versions`,
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { graph },
    });
    expect(saveDraft.statusCode).toBe(201);
    expect(saveDraft.json().data.status).toBe("draft");

    const run = await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/run`,
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { isSimulation: true },
    });
    expect(run.statusCode).toBe(202);
    expect(run.json().data.isSimulation).toBe(true);

    // A non-simulation run still requires an actual publish — the draft alone isn't enough.
    const realRun = await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/run`,
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { isSimulation: false },
    });
    expect(realRun.statusCode).toBe(422);
  });

  it("publishes a version and runs it in simulation mode end to end", async () => {
    const email = "automation-e2e@test.com";
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/automations",
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { name: "E2E automation" },
    });
    const { id } = create.json().data;

    const graph = {
      nodes: [{ id: "n1", type: "delay", config: { seconds: 1 } }],
      edges: [],
    };

    const publish = await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/versions/publish`,
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { graph },
    });
    expect(publish.statusCode).toBe(201);
    expect(publish.json().data.status).toBe("published");

    const run = await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/run`,
      headers: { ...asUser(email), "content-type": "application/json" },
      payload: { isSimulation: true },
    });
    expect(run.statusCode).toBe(202);
    expect(run.json().data.status).toBe("pending");
  });
});
