import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

const permissions = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("@skout/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@skout/auth")>()),
  getMemberPermissions: vi.fn(async () => permissions.list),
}));
vi.mock("../workers/automation-run.queue.js", () => ({ AUTOMATION_RUN_QUEUE: "test", enqueueAutomationRunAdvance: vi.fn(async () => undefined) }));

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ ...loadEnv(), CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, EXPORTS_BUCKET: undefined });
}, 30000);
afterAll(async () => {
  await app?.close();
});

const headers = { "x-stub-user-email": `an-routes-${randomUUID().slice(0, 6)}@test.com` };
const get = (url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers });

describe("COPS-13 analytics routes", () => {
  it("serves the catalog and each dashboard with metric ids, versions and the window", async () => {
    permissions.list = ["analytics:read", "commercial:read", "crm:read", "onboarding:read", "tickets:read", "billing:read"];
    const catalog = await get("/cops/metrics/catalog");
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().data.find((d: { id: string }) => d.id === "revenue.arr")).toMatchObject({ unit: "money", resource: "commercial" });

    for (const key of ["leadership", "sales", "cs", "engineering", "finance"]) {
      const res = await get(`/cops/dashboards/${key}?from=2026-01-01T00:00:00Z`);
      expect(res.statusCode, key).toBe(200);
      const d = res.json().data;
      expect(d.dashboard).toBe(key);
      expect(d.window.from).toBe("2026-01-01T00:00:00.000Z");
      for (const k of d.kpis) {
        expect(k).toHaveProperty("metric_id");
        expect(k.metric_version).toBeGreaterThanOrEqual(1);
        expect(k.window).toEqual(d.window);
      }
    }
    const drill = await get("/cops/dashboards/kpis/revenue.arr/drill?limit=5");
    expect(drill.statusCode).toBe(200);
    expect(drill.json().data).toMatchObject({ metric_id: "revenue.arr", metric_version: 1 });
    expect((await get("/cops/funnel")).json().data.stages[0]).toBe("qualified");
  });

  it("needs analytics:read; Finance reaches its own dashboard with billing:read", async () => {
    permissions.list = ["crm:read"];
    const res = await get("/cops/dashboards/leadership");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    expect((await get("/cops/funnel")).statusCode).toBe(403);

    permissions.list = ["billing:read", "commercial:read"];
    expect((await get("/cops/dashboards/finance")).statusCode).toBe(200);
    expect((await get("/cops/dashboards/leadership")).statusCode).toBe(403);
    expect((await get("/cops/dashboards/kpis/finance.overdue/drill")).statusCode).toBe(200);
  });

  it("restricts money KPIs without commercial:read and refuses their drill-through", async () => {
    permissions.list = ["analytics:read", "tickets:read", "crm:read"];
    const d = (await get("/cops/dashboards/leadership")).json().data;
    expect(d.kpis.find((k: { metric_id: string }) => k.metric_id === "revenue.arr")).toMatchObject({ restricted: true, value: null });
    expect(d.kpis.find((k: { metric_id: string }) => k.metric_id === "engineering.critical_open").restricted).toBe(false);
    const drill = await get("/cops/dashboards/kpis/revenue.arr/drill");
    expect(drill.statusCode).toBe(403);
  });

  it("validates the window and filters, and names unknown dashboards and metrics", async () => {
    permissions.list = ["analytics:read", "commercial:read"];
    expect((await get("/cops/dashboards/leadership?from=2026-10-22T00:00:00Z&to=2026-10-21T00:00:00Z")).statusCode).toBe(422);
    expect((await get("/cops/dashboards/leadership?segment=huge")).json()).toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await get("/cops/dashboards/leadership?owner=not-a-uuid")).statusCode).toBe(422);
    expect((await get("/cops/dashboards/nope")).statusCode).toBe(404);
    expect((await get("/cops/dashboards/kpis/nope/drill")).statusCode).toBe(404);
  });
});
