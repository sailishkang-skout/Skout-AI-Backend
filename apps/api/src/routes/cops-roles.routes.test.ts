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

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ ...loadEnv(), CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, EXPORTS_BUCKET: undefined, OPENROUTER_API_KEY: undefined });
}, 30000);
afterAll(async () => {
  await app?.close();
});

const headers = { "x-stub-user-email": `roles-routes-${randomUUID().slice(0, 6)}@test.com`, "content-type": "application/json" };

describe("COPS-14 custom role routes", () => {
  it("need admin:admin; errors use the COPS envelope", async () => {
    permissions.list = ["crm:read", "admin:read"];
    const res = await app.inject({ method: "GET", url: "/api/v1/cops/roles", headers });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN", details: { required_permission: "admin:admin" } });
  });

  it("create, edit with a reason, and grant a custom role to a member", async () => {
    permissions.list = ["admin:admin", "crm:read", "crm:write"];
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers });
    const userId = me.json().userId ?? me.json().data?.userId ?? me.json().user?.id;

    const created = await app.inject({ method: "POST", url: "/api/v1/cops/roles", headers, payload: { name: `Desk ${randomUUID().slice(0, 6)}`, permission_keys: ["crm:read"] } });
    expect(created.statusCode).toBe(200);
    const role = created.json().data;
    expect(role).toMatchObject({ kind: "custom", permission_keys: ["crm:read"] });

    const escalate = await app.inject({ method: "POST", url: "/api/v1/cops/roles", headers, payload: { name: `Up ${randomUUID().slice(0, 6)}`, permission_keys: ["billing:refund"] } });
    expect(escalate.statusCode).toBe(403);

    const noReason = await app.inject({ method: "PATCH", url: `/api/v1/cops/roles/${role.id}`, headers, payload: { permission_keys: ["crm:read", "crm:write"] } });
    expect(noReason.statusCode).toBe(422);
    expect(noReason.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    const edited = await app.inject({ method: "PATCH", url: `/api/v1/cops/roles/${role.id}`, headers, payload: { permission_keys: ["crm:read", "crm:write"], reason: "Desk now edits records" } });
    expect(edited.json().data.permission_keys).toEqual(["crm:read", "crm:write"]);

    const list = await app.inject({ method: "GET", url: "/api/v1/cops/roles", headers });
    expect(list.json().data.some((r: { id: string }) => r.id === role.id)).toBe(true);

    if (userId) {
      const granted = await app.inject({ method: "PUT", url: `/api/v1/cops/members/${userId}/roles`, headers, payload: { role_ids: [role.id], reason: "Joins the desk" } });
      expect(granted.statusCode).toBe(200);
      expect(granted.json().data.roles.some((r: { id: string }) => r.id === role.id)).toBe(true);
    }
    expect((await app.inject({ method: "GET", url: `/api/v1/cops/members/${randomUUID()}/roles`, headers })).statusCode).toBe(404);
  });
});
