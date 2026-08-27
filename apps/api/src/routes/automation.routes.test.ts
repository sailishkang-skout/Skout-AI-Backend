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
