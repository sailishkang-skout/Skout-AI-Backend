/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-13 additions).
 *   - Tables touched directly: companies (test fixture only)
 *   - Owning service: apps/crm
 *   - Reason: the routes need an account in the caller's workspace.
 *   - Review date: 2026-10-21
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
  app = await buildApp({ ...loadEnv(), CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, EXPORTS_BUCKET: undefined, OPENROUTER_API_KEY: undefined });
}, 30000);
afterAll(async () => {
  await app?.close();
});

const headers = { "x-stub-user-email": `rec-routes-${randomUUID().slice(0, 6)}@test.com`, "content-type": "application/json" };

describe("COPS-13 recommendation routes", () => {
  it("generates, lists, dismisses with a reason; errors use the COPS envelope", async () => {
    permissions.list = ["crm:read", "crm:write", "tickets:read"];
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers });
    const workspaceId = me.json().workspaceId ?? me.json().data?.workspaceId;
    const [acc] = await app.db!.insert(schema.companies).values({ workspaceId, name: `Rec ${randomUUID().slice(0, 6)}` }).returning();
    for (const title of ["A", "B", "C"]) await app.db!.insert(schema.engineeringTickets).values({ workspaceId, accountId: acc!.id, title, severity: "high", status: "new" } as never);

    const gen = await app.inject({ method: "POST", url: `/api/v1/accounts/${acc!.id}/recommendations/generate`, headers });
    expect(gen.statusCode).toBe(200);
    expect(gen.json().data[0]).toMatchObject({ type: "ticket_heavy", status: "pending", source: "rules" });
    const list = await app.inject({ method: "GET", url: `/api/v1/accounts/${acc!.id}/recommendations?status=pending`, headers });
    const rec = list.json().data[0];
    expect(rec.evidence_refs.length).toBe(3);

    const noReason = await app.inject({ method: "POST", url: `/api/v1/recommendations/${rec.id}/dismiss`, headers, payload: {} });
    expect(noReason.statusCode).toBe(422);
    expect(noReason.json()).toMatchObject({ code: "REASON_REQUIRED" });
    const ok = await app.inject({ method: "POST", url: `/api/v1/recommendations/${rec.id}/dismiss`, headers, payload: { reason: "Handled in the weekly review" } });
    expect(ok.json().data.status).toBe("dismissed");
    const again = await app.inject({ method: "POST", url: `/api/v1/recommendations/${rec.id}/approve`, headers, payload: {} });
    expect(again.statusCode).toBe(409);

    expect((await app.inject({ method: "GET", url: `/api/v1/accounts/${randomUUID()}/recommendations`, headers })).json().data).toEqual([]);
    expect((await app.inject({ method: "POST", url: `/api/v1/accounts/${randomUUID()}/recommendations/generate`, headers })).statusCode).toBe(404);
  });

  it("needs crm:read to read and crm:write to act", async () => {
    permissions.list = ["tickets:read"];
    expect((await app.inject({ method: "GET", url: `/api/v1/accounts/${randomUUID()}/recommendations`, headers })).statusCode).toBe(403);
    permissions.list = ["crm:read"];
    expect((await app.inject({ method: "POST", url: `/api/v1/recommendations/${randomUUID()}/approve`, headers, payload: {} })).statusCode).toBe(403);
  });
});
