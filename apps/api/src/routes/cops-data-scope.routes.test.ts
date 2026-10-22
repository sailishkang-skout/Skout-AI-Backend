/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-14 additions).
 *   - Tables touched directly: companies (test fixture only)
 *   - Owning service: apps/crm
 *   - Reason: the scope check needs accounts with a known owner in the caller's workspace.
 *   - Review date: 2026-10-22
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
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

const email = `scope-${randomUUID().slice(0, 6)}@test.com`;
const headers = { "x-stub-user-email": email, "content-type": "application/json" };

describe("COPS-14 own-accounts data scope", () => {
  it("a limited member gets 404 on other accounts, sees their own, and dashboards count only their accounts", async () => {
    permissions.list = ["crm:read", "analytics:read", "tickets:read", "admin:admin"];
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers });
    const workspaceId = me.json().workspaceId ?? me.json().data?.workspaceId;
    const [user] = await app.db!.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const db = app.db!;
    const [mine] = await db.insert(schema.companies).values({ workspaceId, name: `Mine ${randomUUID().slice(0, 4)}`, ownerId: user!.id }).returning();
    const [theirs] = await db.insert(schema.companies).values({ workspaceId, name: `Theirs ${randomUUID().slice(0, 4)}` }).returning();
    for (const acc of [mine!, theirs!]) {
      await db.insert(schema.engineeringTickets).values({ workspaceId, accountId: acc.id, title: "Down", priority: "p1", severity: "critical", status: "new" } as never);
    }

    // No scope yet: both accounts are visible.
    expect((await app.inject({ method: "GET", url: `/api/v1/accounts/${theirs!.id}/recommendations`, headers })).statusCode).toBe(200);
    const drillAll = await app.inject({ method: "GET", url: "/api/v1/cops/dashboards/kpis/engineering.critical_open/drill", headers });
    const allIds = drillAll.json().data.rows.map((r: { account_id: string }) => r.account_id);
    expect(allIds).toEqual(expect.arrayContaining([mine!.id, theirs!.id]));

    // An owner cannot be limited; the stub user is the workspace owner, so limit them directly.
    const refuse = await app.inject({ method: "PUT", url: `/api/v1/cops/members/${user!.id}/data-scope`, headers, payload: { scope: "own_accounts", reason: "Test" } });
    expect(refuse.statusCode).toBe(409);
    await db.insert(schema.copsMemberDataScopes).values({ workspaceId, userId: user!.id, scope: "own_accounts", reason: "test fixture" });

    const other = await app.inject({ method: "GET", url: `/api/v1/accounts/${theirs!.id}/recommendations`, headers });
    expect(other.statusCode).toBe(404);
    expect(other.json()).toMatchObject({ code: "NOT_FOUND" });
    expect((await app.inject({ method: "GET", url: `/api/v1/account-360/${theirs!.id}`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/v1/accounts/${mine!.id}/recommendations`, headers })).statusCode).toBe(200);

    const drillMine = await app.inject({ method: "GET", url: "/api/v1/cops/dashboards/kpis/engineering.critical_open/drill", headers });
    const mineIds = drillMine.json().data.rows.map((r: { account_id: string }) => r.account_id);
    expect(mineIds).toContain(mine!.id);
    expect(mineIds).not.toContain(theirs!.id);

    const scope = await app.inject({ method: "GET", url: `/api/v1/cops/members/${user!.id}/data-scope`, headers });
    expect(scope.json().data.scope).toBe("own_accounts");
  });
});
