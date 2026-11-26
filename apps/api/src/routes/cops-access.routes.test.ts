import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { resolveOrProvisionUser } from "@skout/auth";
import { PLAN_PRESETS } from "@skout/shared";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

const base = loadEnv();
const hasDatabase = Boolean(base.DATABASE_URL);

describe.skipIf(!hasDatabase)("COPS early access routes", () => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  let n = 0;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const OPS = `ea-cops-${suffix}@test.com`;
  const OUTSIDER = `ea-cops-out-${suffix}@test.com`;
  let opsWorkspaceId = "";

  const call = (email: string, method: "GET" | "POST" | "PUT", path: string, body?: unknown, key: string | null = randomUUID()) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { "x-stub-user-email": email, "content-type": "application/json", ...(method !== "GET" && key ? { "idempotency-key": key } : {}) },
      ...(body !== undefined ? { payload: body as object } : {}),
    });

  async function pending() {
    const email = `ea-cops-p-${suffix}-${++n}@test.com`;
    const r = await resolveOrProvisionUser(db, { provider: "password", subject: email, email, emailVerified: true, name: "Sam" }, undefined, undefined, undefined, {
      selfSignup: { method: "google" },
    });
    const [req] = await db.select().from(schema.accessRequests).where(eq(schema.accessRequests.workspaceId, r.workspaceId));
    return { email, ...r, requestId: req!.id };
  }

  async function setRole(email: string, roleKey: string) {
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u!.id));
    const [role] = await db.select({ id: schema.roles.id }).from(schema.roles).where(and(eq(schema.roles.key, roleKey), isNull(schema.roles.workspaceId)));
    await db.delete(schema.workspaceMemberRoles).where(and(eq(schema.workspaceMemberRoles.workspaceId, m!.workspaceId), eq(schema.workspaceMemberRoles.userId, u!.id)));
    await db.insert(schema.workspaceMemberRoles).values({ workspaceId: m!.workspaceId, userId: u!.id, roleId: role!.id });
    return m!.workspaceId;
  }

  const approveBody = (over: Record<string, unknown> = {}) => ({ plan: "full", credits: 500, features: { ...PLAN_PRESETS.full.features }, ...over });

  beforeAll(async () => {
    // No mail provider: a test must never send real email (the invite send then reports not sent).
    app = await buildApp({
      ...base,
      CLERK_SECRET_KEY: undefined,
      LOG_LEVEL: "fatal",
      OPENSEARCH_URL: undefined,
      EARLY_ACCESS_GATE_ENABLED: "true",
      SMTP_HOST: undefined,
      RESEND_API_KEY: undefined,
    });
    await call(OPS, "GET", "/me");
    await call(OUTSIDER, "GET", "/me");
    opsWorkspaceId = await setRole(OPS, "owner");
    await setRole(OUTSIDER, "member");
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("refuses a caller without access:manage", async () => {
    const p = await pending();
    for (const [method, path] of [
      ["GET", "/cops/access-requests"],
      ["POST", `/cops/access-requests/${p.requestId}/approve`],
      ["POST", `/cops/access-requests/${p.requestId}/reject`],
      ["GET", "/cops/workspaces"],
      ["PUT", `/cops/workspaces/${p.workspaceId}/features`],
    ] as const) {
      const res = await call(OUTSIDER, method, path, method === "GET" ? undefined : {});
      expect(res.statusCode, `${method} ${path}`).toBe(403);
    }
  });

  it("lists the pending request a self-signup created", async () => {
    const p = await pending();
    const res = await call(OPS, "GET", "/cops/access-requests?status=pending&limit=200");
    expect(res.statusCode).toBe(200);
    const row = (res.json().data as Array<{ id: string }>).find((r) => r.id === p.requestId);
    expect(row).toMatchObject({ email: p.email, signup_method: "google", status: "pending", workspace_status: "pending" });
  });

  it("approves once: same key replays, a new key conflicts", async () => {
    const p = await pending();
    const key = randomUUID();
    const first = await call(OPS, "POST", `/cops/access-requests/${p.requestId}/approve`, approveBody(), key);
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ status: "approved", workspace_status: "invited", credits_granted: 500 });
    const replay = await call(OPS, "POST", `/cops/access-requests/${p.requestId}/approve`, approveBody(), key);
    expect(replay.statusCode).toBe(200);
    const again = await call(OPS, "POST", `/cops/access-requests/${p.requestId}/approve`, approveBody());
    expect(again.statusCode).toBe(409);
    const [bal] = await db.select().from(schema.creditBalances).where(eq(schema.creditBalances.workspaceId, p.workspaceId));
    expect(bal!.balance).toBe(500);
  });

  it("rejects a request", async () => {
    const p = await pending();
    const res = await call(OPS, "POST", `/cops/access-requests/${p.requestId}/reject`, { note: "later" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: "rejected", workspace_status: "rejected", decision_note: "later" });
  });

  it("validates approve input", async () => {
    const p = await pending();
    const res = await call(OPS, "POST", `/cops/access-requests/${p.requestId}/approve`, approveBody({ credits: -1 }));
    expect(res.statusCode).toBe(422);
  });

  it("switching a feature off applies to the customer at once", async () => {
    const email = `ea-cops-cust-${suffix}@test.com`;
    await call(email, "GET", "/me");
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u!.id));
    const before = await call(email, "GET", "/sequences");
    expect(before.statusCode).not.toBe(403);
    const put = await call(OPS, "PUT", `/cops/workspaces/${m!.workspaceId}/features`, { features: { sequences: false } });
    expect(put.statusCode).toBe(200);
    expect(put.json().data.features.sequences).toBe(false);
    const after = await call(email, "GET", "/sequences");
    expect(after.json()).toMatchObject({ code: "feature_disabled", feature: "sequences" });
  });

  it("COPS switches WORKBOOKS_V2 on for one workspace only, and off again, at once", async () => {
    const mine = `ea-cops-v2-${suffix}@test.com`;
    const theirs = `ea-cops-v2b-${suffix}@test.com`;
    const wsOf = async (email: string) => {
      await call(email, "GET", "/me");
      const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
      const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u!.id));
      return m!.workspaceId;
    };
    const mineWs = await wsOf(mine);
    await wsOf(theirs);
    expect((await call(mine, "GET", "/workbooks-v2/status")).statusCode).toBe(403);

    const on = await call(OPS, "PUT", `/cops/workspaces/${mineWs}/features`, { features: { workbooks_v2: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json().data.features.workbooks_v2).toBe(true);
    expect((await call(mine, "GET", "/workbooks-v2/status")).statusCode).toBe(200);
    expect((await call(theirs, "GET", "/workbooks-v2/status")).statusCode).toBe(403);

    const off = await call(OPS, "PUT", `/cops/workspaces/${mineWs}/features`, { features: { workbooks_v2: false } });
    expect(off.json().data.features.workbooks_v2).toBe(false);
    expect((await call(mine, "GET", "/workbooks-v2/status")).statusCode).toBe(403);
  });

  it("approving with the original twelve keys still works and leaves WORKBOOKS_V2 off", async () => {
    const p = await pending();
    const { workbooks_v2: _omit, ...twelve } = PLAN_PRESETS.full.features;
    const res = await call(OPS, "POST", `/cops/access-requests/${p.requestId}/approve`, approveBody({ features: twelve }));
    expect(res.statusCode).toBe(200);
    const detail = await call(OPS, "GET", `/cops/workspaces/${p.workspaceId}`);
    expect(detail.json().data.features.workbooks_v2).toBe(false);
    expect(detail.json().data.features.sequences).toBe(true);
  });

  it("sets the plan and grants or removes credits", async () => {
    const p = await pending();
    const plan = await call(OPS, "PUT", `/cops/workspaces/${p.workspaceId}/plan`, { plan: "multichannel" });
    expect(plan.json().data.plan_code).toBe("multichannel");
    const grant = await call(OPS, "POST", `/cops/workspaces/${p.workspaceId}/credits`, { amount: 300, reason: "pilot" });
    expect(grant.statusCode).toBe(201);
    expect(grant.json().data.credit_balance).toBe(300);
    const zero = await call(OPS, "POST", `/cops/workspaces/${p.workspaceId}/credits`, { amount: 0, reason: "x" });
    expect(zero.statusCode).toBe(422);
    const tooMuch = await call(OPS, "POST", `/cops/workspaces/${p.workspaceId}/credits`, { amount: -1000, reason: "x" });
    expect(tooMuch.statusCode).toBe(409);
  });

  it("lists workspaces without the caller's own", async () => {
    const res = await call(OPS, "GET", "/cops/workspaces?limit=200");
    expect(res.statusCode).toBe(200);
    expect((res.json().data as Array<{ id: string }>).some((w) => w.id === opsWorkspaceId)).toBe(false);
  });
});
