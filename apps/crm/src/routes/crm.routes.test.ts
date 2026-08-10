import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { buildRouteTestApp } from "../test/build-route-test-app.js";
import type { FastifyInstance } from "fastify";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe("companies routes (unit)", () => {
  it("GET /companies returns 503 without a database", async () => {
    const app = await buildRouteTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/companies",
    });

    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe("deals routes (unit)", () => {
  it("GET /deals/summary returns zeroed pipeline summary", async () => {
    const app = await buildRouteTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/deals/summary",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      openDeals: 0,
      pipelineValue: 0,
      currency: "USD",
    });

    await app.close();
  });
});

describe("contacts routes (unit)", () => {
  it("GET /contacts returns 503 without a database", async () => {
    const app = await buildRouteTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/contacts",
    });

    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe("pipelines routes (unit)", () => {
  it("GET /pipelines returns 503 without a database", async () => {
    const app = await buildRouteTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/pipelines",
    });

    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe("tasks routes (unit)", () => {
  it("GET /tasks returns 503 without a database", async () => {
    const app = await buildRouteTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tasks",
    });

    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe("activities routes (unit)", () => {
  it("GET /activities returns 503 without a database", async () => {
    const app = await buildRouteTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/activities?entityType=deal&entityId=aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
    });

    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe("audit routes (unit)", () => {
  it("GET /audit-logs returns 503 without a database", async () => {
    const app = await buildRouteTestApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/audit-logs?entityType=company&entityId=aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee`,
    });

    expect(res.statusCode).toBe(503);

    await app.close();
  });

  it.each(["contact", "company", "deal", "task", "pipeline"])(
    "GET /audit-logs accepts entityType=%s (fails on DB availability, not validation)",
    async (entityType) => {
      const app = await buildRouteTestApp();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/audit-logs?entityType=${entityType}&entityId=aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee`,
      });

      expect(res.statusCode).toBe(503);

      await app.close();
    }
  );

  it("GET /audit-logs rejects invalid entityId with a 400 validation error", async () => {
    const app = await buildRouteTestApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/audit-logs?entityType=deal&entityId=invalid-id`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "validation_error" });

    await app.close();
  });

  it("GET /audit-logs rejects invalid entityType with a 400 validation error", async () => {
    const app = await buildRouteTestApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/audit-logs?entityType=invalid&entityId=aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "validation_error" });

    await app.close();
  });

  it("GET /audit-logs without required query params returns a 400 validation error", async () => {
    const app = await buildRouteTestApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/audit-logs`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "validation_error" });

    await app.close();
  });
});

describe("meetings routes (unit)", () => {
  it("GET /meetings returns 503 without a database", async () => {
    const app = await buildRouteTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/meetings",
    });

    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe("dashboard routes (unit)", () => {
  it("GET /dashboard/overview returns zeroed overview without a database", async () => {
    const app = await buildRouteTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/overview",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      companies: 0,
      contacts: 0,
      openDeals: 0,
      openTasks: 0,
      upcomingMeetings: 0,
      recentActivities: [],
    });

    await app.close();
  });
});

describe.skipIf(!hasDatabase)("CRM routes (integration)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadEnv();
    app = await buildApp({
      ...config,
      CLERK_SECRET_KEY: undefined,
      AUTH_STUB: true,
      LOG_LEVEL: "fatal",
    });
  }, 30000);

  afterAll(async () => {
    await app?.close();
  });

  function asUser(email: string) {
    return { "x-stub-user-email": email };
  }

  it("GET /companies provisions stub user and returns workspace id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/companies",
      headers: asUser("crm-companies@test.com"),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { workspaceId: string };
    expect(body.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("GET /deals/summary shares workspace with companies for same stub user", async () => {
    const email = "crm-deals@test.com";
    const companies = await app.inject({
      method: "GET",
      url: "/api/v1/companies",
      headers: asUser(email),
    });
    const deals = await app.inject({
      method: "GET",
      url: "/api/v1/deals/summary",
      headers: asUser(email),
    });

    expect(companies.statusCode).toBe(200);
    expect(deals.statusCode).toBe(200);
    expect((deals.json() as { workspaceId: string }).workspaceId).toBe(
      (companies.json() as { workspaceId: string }).workspaceId
    );
  });
});
