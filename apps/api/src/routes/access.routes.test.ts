import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess, resolveOrProvisionUser } from "@skout/auth";
import { PLAN_PRESETS } from "@skout/shared";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { approveAccessRequest } from "../services/access.service.js";

const base = loadEnv();
const hasDatabase = Boolean(base.DATABASE_URL);

describe.skipIf(!hasDatabase)("early access customer routes", () => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  let n = 0;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const as = (email: string) => ({ "x-stub-user-email": email, "content-type": "application/json" });

  /** A pending self-signup the stub header resolves to (stub users are found by email). */
  async function pendingUser() {
    const email = `ea-routes-${suffix}-${++n}@test.com`;
    const r = await resolveOrProvisionUser(db, { provider: "password", subject: email, email, emailVerified: true, name: "Lee" }, undefined, undefined, undefined, {
      selfSignup: { method: "password" },
    });
    const [req] = await db.select().from(schema.accessRequests).where(eq(schema.accessRequests.workspaceId, r.workspaceId));
    return { email, ...r, requestId: req!.id };
  }

  beforeAll(async () => {
    app = await buildApp({ ...base, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, EARLY_ACCESS_GATE_ENABLED: "true" });
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("an active workspace sees active, every feature on and no request", async () => {
    const email = `ea-routes-active-${suffix}@test.com`;
    const res = await app.inject({ method: "GET", url: "/api/v1/access-request", headers: as(email) });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.status).toBe("active");
    expect(data.request).toBeNull();
    expect(Object.values(data.features).every(Boolean)).toBe(true);
    expect(Object.keys(data.features)).toHaveLength(12);
  });

  it("a pending user can save and read back their answers", async () => {
    const u = await pendingUser();
    const post = await app.inject({
      method: "POST",
      url: "/api/v1/access-request",
      headers: as(u.email),
      payload: { company: "Acme", role_title: "Founder", use_case: "Outbound to EU" },
    });
    expect(post.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/api/v1/access-request", headers: as(u.email) });
    expect(get.json().data).toMatchObject({
      status: "pending",
      request: { company: "Acme", role_title: "Founder", use_case: "Outbound to EU", submitted: true },
    });
  });

  it("answers need company and role", async () => {
    const u = await pendingUser();
    const res = await app.inject({ method: "POST", url: "/api/v1/access-request", headers: as(u.email), payload: { company: "Acme" } });
    expect(res.statusCode).toBe(422);
  });

  it("an active workspace cannot post answers", async () => {
    const email = `ea-routes-active2-${suffix}@test.com`;
    const res = await app.inject({ method: "POST", url: "/api/v1/access-request", headers: as(email), payload: { company: "A", role_title: "B" } });
    expect(res.statusCode).toBe(409);
  });

  it("a wrong code is invalid_code", async () => {
    const u = await pendingUser();
    const res = await app.inject({ method: "POST", url: "/api/v1/access-request/redeem", headers: as(u.email), payload: { code: "ZZZZ-ZZZZ" } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "invalid_code" });
  });

  it("the sixth redeem attempt in an hour is rate limited", async () => {
    const u = await pendingUser();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({ method: "POST", url: "/api/v1/access-request/redeem", headers: as(u.email), payload: { code: "ZZZZ-ZZZZ" } });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 422)).toBe(true);
    expect(codes[5]).toBe(429);
  });

  it("approve then redeem unlocks the product", async () => {
    const u = await pendingUser();
    const operator = `ea-routes-op-${suffix}@test.com`;
    const op = await resolveOrProvisionUser(db, { provider: "password", subject: operator, email: operator, emailVerified: true });
    let code = "";
    await approveAccessRequest(
      db,
      { operatorWorkspaceId: op.workspaceId, actorId: op.userId, requestId: `r-${suffix}` },
      u.requestId,
      { plan: "full", credits: 500, features: PLAN_PRESETS.full.features },
      { sendEmail: vi.fn(async (_to: string, c: string) => ((code = c), true)) }
    );
    const before = await app.inject({ method: "GET", url: "/api/v1/lists", headers: as(u.email) });
    expect(before.json()).toMatchObject({ code: "access_pending" });
    const redeem = await app.inject({ method: "POST", url: "/api/v1/access-request/redeem", headers: as(u.email), payload: { code } });
    expect(redeem.statusCode).toBe(200);
    expect(redeem.json()).toEqual({ data: { status: "active" } });
    invalidateWorkspaceAccess(u.workspaceId);
    const after = await app.inject({ method: "GET", url: "/api/v1/lists", headers: as(u.email) });
    expect(after.statusCode).not.toBe(403);
  });
});
