/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-11 additions).
 *   - Tables touched directly: companies, users, workspace_members (test fixtures only)
 *   - Owning service: apps/crm
 *   - Reason: the routes need an account, a CSM in the workspace and a user outside it.
 *   - Review date: 2026-10-20
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { schema } from "@skout/db";
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

const headers = { "x-stub-user-email": `cs-routes-${randomUUID().slice(0, 6)}@test.com`, "content-type": "application/json" };

describe("COPS-11 customer success routes", () => {
  it("scores an account, explains it, keeps the trend, and shows it on the overview", async () => {
    permissions.list = ["crm:read", "crm:manage", "workspace:manage"];
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers });
    const workspaceId = me.json().workspaceId ?? me.json().data?.workspaceId;
    const [acc] = await app.db!.insert(schema.companies).values({ workspaceId, name: `CS ${randomUUID().slice(0, 6)}`, status: "customer" }).returning();
    await app.db!.insert(schema.engineeringTickets).values({ workspaceId, accountId: acc!.id, title: "Export fails", severity: "critical", status: "new" } as never);

    const recompute = await app.inject({ method: "POST", url: `/api/v1/accounts/${acc!.id}/health/recompute`, headers });
    expect(recompute.statusCode).toBe(200);
    const health = await app.inject({ method: "GET", url: `/api/v1/accounts/${acc!.id}/health`, headers });
    const h = health.json().data.health;
    expect(h.factors.some((f: { reason: string }) => f.reason === "1 open high or critical ticket(s)")).toBe(true);
    await app.inject({ method: "POST", url: `/api/v1/accounts/${acc!.id}/health/recompute`, headers });
    const history = await app.inject({ method: "GET", url: `/api/v1/accounts/${acc!.id}/health/history`, headers });
    expect(history.json().data).toHaveLength(2);

    const overview = await app.inject({ method: "GET", url: "/api/v1/customer-success/overview", headers });
    expect(overview.statusCode).toBe(200);
    const o = overview.json().data;
    expect(o.distribution.healthy + o.distribution.watch + o.distribution.at_risk).toBeGreaterThanOrEqual(1);
    expect(o).toHaveProperty("renewalExposure");
    expect(o).toHaveProperty("playbooks");
  });

  it("sets a CSM only from this workspace, and refuses an invalid model", async () => {
    permissions.list = ["crm:read", "crm:manage", "workspace:manage"];
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers });
    const workspaceId = me.json().workspaceId ?? me.json().data?.workspaceId;
    const userId = me.json().userId ?? me.json().data?.userId;
    const [acc] = await app.db!.insert(schema.companies).values({ workspaceId, name: `CSM ${randomUUID().slice(0, 6)}` }).returning();
    const [stranger] = await app.db!.insert(schema.users).values({ email: `stranger-${randomUUID().slice(0, 6)}@test.com` } as never).returning();

    expect((await app.inject({ method: "PUT", url: `/api/v1/accounts/${acc!.id}/csm`, headers, payload: { csm_id: stranger!.id } })).statusCode).toBe(422);
    const ok = await app.inject({ method: "PUT", url: `/api/v1/accounts/${acc!.id}/csm`, headers, payload: { csm_id: userId } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/v1/accounts/${acc!.id}/health`, headers })).json().data.csmId).toBe(userId);

    expect((await app.inject({ method: "PUT", url: "/api/v1/customer-success/model", headers, payload: { thresholds: { healthy: 30, atRisk: 60 } } })).statusCode).toBe(422);
    const model = await app.inject({ method: "PUT", url: "/api/v1/customer-success/model", headers, payload: { weights: { support: 40 } } });
    expect(model.json().data).toMatchObject({ version: 1, weights: { support: 40 } });
  });

  it("installs the playbooks for admins only; members can read", async () => {
    permissions.list = ["crm:read"];
    expect((await app.inject({ method: "POST", url: "/api/v1/customer-success/playbooks/install", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/customer-success/playbooks", headers })).statusCode).toBe(200);
    permissions.list = ["workspace:manage", "crm:read"];
    const install = await app.inject({ method: "POST", url: "/api/v1/customer-success/playbooks/install", headers });
    expect(install.json().data.installed).toHaveLength(5);
    const list = await app.inject({ method: "GET", url: "/api/v1/customer-success/playbooks", headers });
    expect(list.json().data.every((p: { automationId: string | null }) => p.automationId)).toBe(true);
  });
});
