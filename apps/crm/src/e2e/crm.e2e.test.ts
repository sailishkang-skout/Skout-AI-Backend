import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("CRM service E2E", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadEnv();
    app = await buildApp({
      ...config,
      CLERK_SECRET_KEY: undefined,
      AUTH_STUB: true,
      LOG_LEVEL: "fatal",
    });
  }, 60000);

  afterAll(async () => {
    await app?.close();
  });

  function asUser(email: string) {
    return { "x-stub-user-email": email };
  }

  it("health → companies → deals summary flow for one workspace", async () => {
    const email = "crm-e2e@test.com";
    const headers = asUser(email);

    const health = await app.inject({
      method: "GET",
      url: "/api/v1/crm/health",
    });
    expect(health.statusCode).toBe(200);

    const companies = await app.inject({
      method: "GET",
      url: "/api/v1/companies",
      headers,
    });
    expect(companies.statusCode).toBe(200);
    const companiesBody = companies.json() as { workspaceId: string };
    const workspaceId = companiesBody.workspaceId;

    const contacts = await app.inject({
      method: "GET",
      url: "/api/v1/contacts",
      headers,
    });
    expect(contacts.statusCode).toBe(200);
    expect((contacts.json() as { workspaceId: string }).workspaceId).toBe(workspaceId);

    const summary = await app.inject({
      method: "GET",
      url: "/api/v1/deals/summary",
      headers,
    });
    expect(summary.statusCode).toBe(200);
    expect((summary.json() as { workspaceId: string }).workspaceId).toBe(workspaceId);
  });
});
