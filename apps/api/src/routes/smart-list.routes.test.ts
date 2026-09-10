import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const hasDatabase = Boolean(process.env.DATABASE_URL);

async function buildTestApp() {
  const config = loadEnv();
  return buildApp({
    ...config,
    CLERK_SECRET_KEY: undefined,
    LOG_LEVEL: "fatal",
    AI_SERVICE_URL: undefined,
    OPENSEARCH_URL: undefined,
    DEMO_CORPUS_SIZE: 5300,
    REDIS_URL: "",
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
        filters: { industry: "Software & SaaS", country: "US" },
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
  }, 120000);

  // Seeds the `lists.source_filters` column directly rather than going through
  // smart-list activation (whose per-member insert loop is expensive against the shared dev DB
  // at real demo-corpus scale, and is already covered by the test above) — this test is only
  // about the read/convert path once that column is populated, which activation itself sets.
  it.skipIf(!hasDatabase)(
    "R10.3: a list with recorded sourceFilters shows them and converts back to a smart list",
    async () => {
      const app = await buildTestApp();
      const { db, sql } = createDb(process.env.DATABASE_URL!);
      const { lists } = schema;

      try {
        const create = await app.inject({
          method: "POST",
          url: "/api/v1/lists",
          headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
          payload: { name: "Pre-filtered List", mode: "static" },
        });
        expect(create.statusCode).toBe(201);
        const { id: listId } = create.json() as { id: string };

        // Simulates what the activate flow's setSourceFilters call records.
        await db
          .update(lists)
          .set({ sourceFilters: { industry: "Software & SaaS", country: "US" } })
          .where(eq(lists.id, listId));

        const showList = await app.inject({
          method: "GET",
          url: `/api/v1/lists/${listId}`,
          headers: { "x-workspace-id": WORKSPACE },
        });
        expect(showList.statusCode).toBe(200);
        const detail = showList.json() as { sourceFilters: Record<string, unknown> | null };
        expect(detail.sourceFilters).toMatchObject({ industry: "Software & SaaS", country: "US" });

        const convert = await app.inject({
          method: "POST",
          url: `/api/v1/lists/${listId}/convert-to-smart-list`,
          headers: { "x-workspace-id": WORKSPACE },
        });
        expect(convert.statusCode).toBe(201);
        const converted = convert.json() as { id: string; kind: string; filters: Record<string, unknown> };
        expect(converted.kind).toBe("smart");
        expect(converted.filters).toMatchObject({ industry: "Software & SaaS", country: "US" });
      } finally {
        await sql.end();
        await app.close();
      }
    },
    30000
  );

  it("POST /lists defaults to creating a smart list (R10.1 AC1)", async () => {
    const app = await buildTestApp();

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: { name: "Default Flow List", filters: { industry: "Fintech" } },
    });

    expect(create.statusCode).toBe(201);
    const body = create.json() as { id: string; kind: string; filters: Record<string, unknown>; refreshCadence: string };
    expect(body.kind).toBe("smart");
    expect(body.filters).toMatchObject({ industry: "Fintech" });
    expect(body.refreshCadence).toBe("off");

    await app.close();
  }, 30000);

  it("POST /lists with mode: static still creates a plain static list (R10.1 AC2)", async () => {
    const app = await buildTestApp();

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: { name: "Manual Static List", mode: "static" },
    });

    expect(create.statusCode).toBe(201);
    const body = create.json() as { id: string; kind: string; prospectCount: number };
    expect(body.kind).toBe("static");
    expect(body.prospectCount).toBe(0);

    // Not reconstructable — no filters were ever recorded for a manually-created static list.
    const convert = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${body.id}/convert-to-smart-list`,
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(convert.statusCode).toBe(422);
    expect(convert.json()).toMatchObject({ error: "not_convertible" });

    await app.close();
  }, 30000);
});
