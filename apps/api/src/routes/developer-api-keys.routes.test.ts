import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { issueStepUpToken } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

const sent = vi.hoisted(() => ({ mails: [] as { to: string; subject: string; text: string }[] }));
vi.mock("../services/mail.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/mail.service.js")>()),
  sendMail: vi.fn(async (_cfg: unknown, m: { to: string; subject: string; text: string }) => {
    sent.mails.push(m);
    return { sent: true };
  }),
}));

/** PAPI-027 against a real, migrated Postgres: key management routes for Owners and Admins. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PEPPER = randomBytes(32).toString("base64");
const STEP_UP_SECRET = randomBytes(24).toString("hex");

maybe("PAPI-027 key management routes", () => {
  let app: FastifyInstance;
  const email = `papi027-${randomUUID().slice(0, 8)}@test.com`;
  let workspaceId: string;
  let userId: string;
  const others: { id: string; email: string; role: string }[] = [];
  const base = { "x-stub-user-email": email, "content-type": "application/json" };
  const stepUp = () => ({ ...base, "x-reauth-token": issueStepUpToken(STEP_UP_SECRET, userId) });
  const setRole = (role: string) =>
    app.db!.update(schema.workspaceMembers).set({ role }).where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
  const req = (method: "GET" | "POST" | "PATCH", path: string, payload?: unknown, headers: Record<string, string> = base) =>
    app.inject({ method, url: `/api/v1/developer/keys${path}`, headers, payload: payload as object });
  const createTest = () => req("POST", "", { name: "Test key", type: "test", scopes: ["search:read"] });
  const createLive = () => req("POST", "", { name: "Prod key", type: "live", scopes: ["search:read", "people:read"] }, stepUp());

  beforeAll(async () => {
    const config = loadEnv();
    app = await buildApp({
      ...config,
      CLERK_SECRET_KEY: undefined,
      LOG_LEVEL: "fatal",
      OPENSEARCH_URL: undefined,
      API_KEY_PEPPER: PEPPER,
      STEP_UP_SIGNING_SECRET: STEP_UP_SECRET,
      INVITE_BASE_URL: "https://www.skoutai.io/app",
    });
    await app.inject({ method: "GET", url: "/api/v1/developer/api-addon", headers: base });
    const [m] = await app.db!
      .select({ workspaceId: schema.workspaceMembers.workspaceId, userId: schema.workspaceMembers.userId })
      .from(schema.workspaceMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
      .where(eq(schema.users.email, email))
      .limit(1);
    workspaceId = m!.workspaceId;
    userId = m!.userId;
    // A user signed up through auth starts inactive (ADD-3); this one has verified their email.
    await app.db!.update(schema.users).set({ isActive: true }).where(eq(schema.users.id, userId));
    await setRole("owner");
    await app.db!.insert(schema.workspaceApiSettings).values({ workspaceId, addonEnabled: true }).onConflictDoUpdate({
      target: schema.workspaceApiSettings.workspaceId,
      set: { addonEnabled: true },
    });
    for (const role of ["owner", "admin", "member"]) {
      const e = `papi027-${role}-${randomUUID().slice(0, 6)}@test.com`;
      const [u] = await app.db!.insert(schema.users).values({ email: e, isActive: true }).returning();
      await app.db!.insert(schema.workspaceMembers).values({ workspaceId, userId: u!.id, role });
      others.push({ id: u!.id, email: e, role });
    }
  }, 60000);

  afterAll(async () => {
    if (workspaceId) await app.db!.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    for (const o of others) await app.db!.delete(schema.users).where(eq(schema.users.id, o.id));
    await app?.close();
  });

  beforeEach(async () => {
    sent.mails = [];
    await setRole("owner");
  });

  it("refuses a Member with 403 on every key route", async () => {
    await setRole("member");
    expect((await req("GET", "")).statusCode).toBe(403);
    expect((await createTest()).statusCode).toBe(403);
    expect((await req("POST", `/${randomUUID()}/revoke`, { reason: "x" })).statusCode).toBe(403);
    expect((await req("PATCH", `/${randomUUID()}`, { name: "x" })).statusCode).toBe(403);
  });

  it("requires step-up for a live key, but not for a test key", async () => {
    await setRole("admin");
    const noStepUp = await req("POST", "", { name: "Prod key", type: "live", scopes: ["search:read"] });
    expect(noStepUp.statusCode).toBe(401);
    expect(JSON.stringify(noStepUp.json())).toContain("step_up_required");
    const stale = await req("POST", "", { name: "Prod key", type: "live", scopes: ["search:read"] }, { ...base, "x-reauth-token": issueStepUpToken(STEP_UP_SECRET, userId, Date.now() - 60 * 60_000) });
    expect(stale.statusCode).toBe(401);
    const otherUsers = await req("POST", "", { name: "Prod key", type: "live", scopes: ["search:read"] }, { ...base, "x-reauth-token": issueStepUpToken(STEP_UP_SECRET, others[0]!.id) });
    expect(otherUsers.statusCode).toBe(401);
    expect((await createLive()).statusCode).toBe(201);
    expect((await createTest()).statusCode).toBe(201);
  });

  it("returns the full key only from create and rotate", async () => {
    const created = await createLive();
    expect(created.statusCode).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    const { key, id } = created.json().data as { key: string; id: string };
    expect(key).toMatch(/^sk_live_[0-9a-f]{12}_/);

    const list = await req("GET", "");
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(key);
    expect(list.json().data.find((k: { id: string }) => k.id === id).masked_key).toMatch(/••••$/);

    const patched = await req("PATCH", `/${id}`, { name: "Renamed", scopes: ["search:read"], daily_credit_cap: 500 });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data).toMatchObject({ name: "Renamed", scopes: ["search:read"], daily_credit_cap: 500 });
    expect(patched.json().data.key).toBeUndefined();

    const rotated = await req("POST", `/${id}/rotate`, { grace_hours: 24 }, stepUp());
    expect(rotated.statusCode).toBe(200);
    const replacement = rotated.json().data.replacement;
    expect(replacement.key).toMatch(/^sk_live_/);
    expect(replacement.key).not.toBe(key);
    expect(rotated.json().data.old.key).toBeUndefined();

    const revoked = await req("POST", `/${replacement.id}/revoke`, { reason: "done testing" });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().data).toMatchObject({ status: "revoked", revoke_reason: "done testing" });
    expect(JSON.stringify(revoked.json())).not.toContain(replacement.key);
  });

  it("emails every Owner about each new live key, including a rotation, but not about test keys", async () => {
    const owners = [email, others.find((o) => o.role === "owner")!.email].sort();
    const created = await createLive();
    expect(sent.mails.map((m) => m.to).sort()).toEqual(owners);
    expect(sent.mails[0]!.subject).toContain("live API key was created");
    expect(sent.mails[0]!.text).toContain("sk_live_");
    expect(sent.mails[0]!.text).not.toContain(created.json().data.key);

    sent.mails = [];
    await req("POST", `/${created.json().data.id}/rotate`, { grace_hours: 0 }, stepUp());
    expect(sent.mails.map((m) => m.to).sort()).toEqual(owners);
    expect(sent.mails[0]!.subject).toContain("rotated");

    sent.mails = [];
    await createTest();
    expect(sent.mails).toHaveLength(0);
  });

  it("only shortens expiry, validates input, and audits every change", async () => {
    const created = (await createTest()).json().data as { id: string; expires_at: string };
    const later = new Date(new Date(created.expires_at).getTime() + 86_400_000).toISOString();
    expect((await req("PATCH", `/${created.id}`, { expires_at: later })).statusCode).toBe(422);
    expect((await req("PATCH", `/${created.id}`, { expires_at: new Date(Date.now() - 1000).toISOString() })).statusCode).toBe(422);
    const sooner = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const shortened = await req("PATCH", `/${created.id}`, { expires_at: sooner });
    expect(shortened.statusCode).toBe(200);
    expect(new Date(shortened.json().data.expires_at).toISOString()).toBe(sooner);

    expect((await req("PATCH", `/${created.id}`, { scopes: ["admin:all"] })).statusCode).toBe(422);
    expect((await req("PATCH", `/${created.id}`, { workspace_id: randomUUID() })).statusCode).toBe(422);
    expect((await req("POST", "", { name: "x", type: "live", scopes: ["search:read"], expires_in_days: 91 }, stepUp())).statusCode).toBe(422);
    expect((await req("POST", `/${created.id}/rotate`, { grace_hours: 12 })).statusCode).toBe(422);
    expect((await req("POST", `/${created.id}/revoke`, {})).statusCode).toBe(422);
    expect((await req("POST", `/${randomUUID()}/revoke`, { reason: "x" })).statusCode).toBe(404);

    await req("POST", `/${created.id}/revoke`, { reason: "audit check" });
    const audits = await app.db!
      .select({ action: schema.auditLogs.action, before: schema.auditLogs.beforeState, after: schema.auditLogs.afterState })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.entityId, created.id));
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toEqual(["api_key.created", "api_key.revoked", "api_key.updated"]);
    const update = audits.find((a) => a.action === "api_key.updated")!;
    expect(update.after).toMatchObject({ expires_at: sooner });
    expect(update.before).toHaveProperty("expires_at");
  });
});
