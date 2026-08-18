import { randomUUID } from "node:crypto";
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
  return { ...{ "x-stub-user-email": email }, "content-type": "application/json" };
}

describe("POST /lists/:id/import-to-crm", () => {
  it("returns 404 for a list that doesn't exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${randomUUID()}/import-to-crm`,
      headers: asUser("import-404@test.com"),
    });
    if (res.statusCode === 503) return;
    expect(res.statusCode).toBe(404);
  });

  it("imports list members as company+contact records and is idempotent", async () => {
    const email = "import-e2e@test.com";
    const headers = asUser(email);

    const createList = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers,
      payload: { name: "Import Test List" },
    });
    if (createList.statusCode === 503) return;
    expect(createList.statusCode).toBe(201);
    const { id: listId } = createList.json() as { id: string };

    const prospectId = `prospect-${randomUUID()}`;
    const addMembers = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${listId}/members`,
      headers,
      payload: { prospectIds: [prospectId] },
    });
    expect(addMembers.statusCode).toBe(200);

    const firstImport = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${listId}/import-to-crm`,
      headers,
    });
    expect(firstImport.statusCode).toBe(200);
    const firstResult = firstImport.json() as { imported: number; created: number; updated: number };
    expect(firstResult.imported).toBe(1);
    expect(firstResult.created).toBe(2); // one company + one contact

    const secondImport = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${listId}/import-to-crm`,
      headers,
    });
    expect(secondImport.statusCode).toBe(200);
    const secondResult = secondImport.json() as { imported: number; created: number; updated: number };
    expect(secondResult.imported).toBe(1);
    expect(secondResult.created).toBe(0);
    expect(secondResult.updated).toBe(2);
  });
});
