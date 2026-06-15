import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";

async function buildTestApp() {
  const config = loadEnv();
  return buildApp({
    ...config,
    CLERK_SECRET_KEY: undefined,
    LOG_LEVEL: "fatal",
    AI_SERVICE_URL: undefined,
    OPENSEARCH_URL: undefined,
  });
}

describe("smart list API", () => {
  it("creates a smart list, runs it, and activates matches into a prospect list", async () => {
    const app = await buildTestApp();

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/smart-lists",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: {
        name: "Software US",
        filters: { industry: "Software", country: "US" },
      },
    });
    expect(create.statusCode).toBe(201);
    const smartList = create.json() as { id: string; name: string };

    const run = await app.inject({
      method: "POST",
      url: `/api/v1/smart-lists/${smartList.id}/run`,
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(run.statusCode).toBe(200);
    const runBody = run.json() as { total: number; hits: unknown[]; demo?: boolean };
    expect(runBody.total).toBeGreaterThan(0);
    expect(runBody.hits.length).toBe(runBody.total);
    expect(runBody.demo).toBe(true);

    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/smart-lists/${smartList.id}/activate`,
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: { listName: "Software US — activated" },
    });
    expect(activate.statusCode).toBe(201);
    const activated = activate.json() as {
      list: { id: string; name: string; prospectCount: number };
      activated: number;
      total: number;
    };
    expect(activated.list.name).toBe("Software US — activated");
    expect(activated.activated).toBe(activated.total);
    expect(activated.list.prospectCount).toBe(activated.activated);

    const lists = await app.inject({
      method: "GET",
      url: "/api/v1/lists",
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(lists.statusCode).toBe(200);
    const listData = lists.json() as { data: { id: string; prospectCount: number }[] };
    expect(listData.data.some((l) => l.id === activated.list.id)).toBe(true);

    await app.close();
  });
});
