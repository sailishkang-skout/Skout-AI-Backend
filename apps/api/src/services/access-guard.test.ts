import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

const base = loadEnv();
const hasDatabase = Boolean(base.DATABASE_URL);

async function buildTestApp(gate: "true" | "false") {
  return buildApp({ ...base, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, EARLY_ACCESS_GATE_ENABLED: gate });
}

describe.skipIf(!hasDatabase)("early access guard", () => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  let n = 0;
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let appGateOff: Awaited<ReturnType<typeof buildTestApp>>;

  const as = (email: string, extra: Record<string, string> = {}) => ({ "x-stub-user-email": email, ...extra });

  /** A stub user (provisioned on first request) whose workspace is then put in the given state. */
  async function userIn(status: "pending" | "invited" | "active" | "rejected", features: Record<string, boolean> = {}) {
    const email = `ea-guard-${suffix}-${++n}@test.com`;
    await app.inject({ method: "GET", url: "/api/v1/me", headers: as(email) });
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u!.id));
    await db.update(schema.workspaces).set({ accessStatus: status }).where(eq(schema.workspaces.id, m!.workspaceId));
    for (const [f, on] of Object.entries(features)) {
      await db.insert(schema.entitlements).values({ workspaceId: m!.workspaceId, key: `feature.${f}`, value: on, source: "test" });
    }
    invalidateWorkspaceAccess(m!.workspaceId);
    return { email, userId: u!.id, workspaceId: m!.workspaceId };
  }

  beforeAll(async () => {
    app = await buildTestApp("true");
    appGateOff = await buildTestApp("false");
  });

  afterAll(async () => {
    await app.close();
    await appGateOff.close();
    await sql.end();
  });

  it("a pending workspace is refused product routes", async () => {
    const u = await userIn("pending");
    const res = await app.inject({ method: "GET", url: "/api/v1/sequences", headers: as(u.email) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "access_pending" });
  });

  it("an invited workspace is still refused until the code is redeemed", async () => {
    const u = await userIn("invited");
    const res = await app.inject({ method: "GET", url: "/api/v1/lists", headers: as(u.email) });
    expect(res.json()).toMatchObject({ code: "access_pending" });
  });

  it("a pending workspace can still reach the allowlist", async () => {
    const u = await userIn("pending");
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: as(u.email) });
    expect(me.statusCode).toBe(200);
    const auth = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: as(u.email) });
    expect(auth.statusCode).not.toBe(403);
  });

  it("a rejected workspace gets access_rejected", async () => {
    const u = await userIn("rejected");
    const res = await app.inject({ method: "GET", url: "/api/v1/sequences", headers: as(u.email) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "access_rejected" });
  });

  it("an active workspace with a feature off is refused that area only", async () => {
    const u = await userIn("active", { sequences: false });
    const off = await app.inject({ method: "GET", url: "/api/v1/sequences", headers: as(u.email) });
    expect(off.statusCode).toBe(403);
    expect(off.json()).toMatchObject({ code: "feature_disabled", feature: "sequences" });
    const lists = await app.inject({ method: "GET", url: "/api/v1/lists", headers: as(u.email) });
    expect(lists.statusCode).not.toBe(403);
  });

  it("an active workspace with no switches set keeps every area", async () => {
    const u = await userIn("active");
    const res = await app.inject({ method: "GET", url: "/api/v1/sequences", headers: as(u.email) });
    expect(res.statusCode).not.toBe(403);
  });

  it("explicit workspace header does not bypass the gate", async () => {
    const team = await userIn("active");
    const u = await userIn("pending");
    await db.insert(schema.workspaceMembers).values({ workspaceId: team.workspaceId, userId: u.userId, role: "member" });
    const viaDefault = await app.inject({ method: "GET", url: "/api/v1/lists", headers: as(u.email) });
    expect(viaDefault.statusCode).not.toBe(403);
    const viaHeader = await app.inject({ method: "GET", url: "/api/v1/lists", headers: as(u.email, { "x-workspace-id": u.workspaceId }) });
    expect(viaHeader.statusCode).toBe(403);
    expect(viaHeader.json()).toMatchObject({ code: "access_pending" });
  });

  it("with the gate off a pending workspace passes, but feature switches still apply", async () => {
    const u = await userIn("pending", { sequences: false });
    const lists = await appGateOff.inject({ method: "GET", url: "/api/v1/lists", headers: as(u.email) });
    expect(lists.statusCode).not.toBe(403);
    const seq = await appGateOff.inject({ method: "GET", url: "/api/v1/sequences", headers: as(u.email) });
    expect(seq.json()).toMatchObject({ code: "feature_disabled" });
  });

  it("feature keys are platform-managed", async () => {
    const u = await userIn("active");
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/entitlements/feature.ai",
      headers: { ...as(u.email), "content-type": "application/json" },
      payload: { value: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "platform_managed_entitlement" });
    const plan = await app.inject({
      method: "PUT",
      url: "/api/v1/entitlements/plan.code",
      headers: { ...as(u.email), "content-type": "application/json" },
      payload: { value: "multichannel" },
    });
    expect(plan.statusCode).toBe(403);
  });

  it("a percent-encoded path cannot dodge a switched-off feature", async () => {
    const u = await userIn("active", { sequences: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/%73equences", headers: as(u.email) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "feature_disabled", feature: "sequences" });
  });

  it("a metered AI action outside /ai is refused when ai is off", async () => {
    const u = await userIn("active", { ai: false });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${u.workspaceId}/recommendations/generate`,
      headers: { ...as(u.email), "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "feature_disabled", feature: "ai" });
  });

  it("a pending workspace's AI call is refused before it is metered", async () => {
    const u = await userIn("pending");
    const res = await app.inject({ method: "POST", url: "/api/v1/ai/chat", headers: { ...as(u.email), "content-type": "application/json" }, payload: { message: "hi" } });
    expect(res.statusCode).toBe(403);
    const used = await db.select().from(schema.copsUsageCounters).where(eq(schema.copsUsageCounters.workspaceId, u.workspaceId));
    expect(used.reduce((n, r) => n + r.count, 0)).toBe(0);
  });
});
