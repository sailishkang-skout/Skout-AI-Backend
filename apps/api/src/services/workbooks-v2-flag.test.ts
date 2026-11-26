import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@skout/db";
import { invalidateWorkspaceAccess, loadWorkspaceAccess } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { accessGuard } from "./access-guard.js";

/**
 * WB2-002: the WORKBOOKS_V2 switch (entitlement `feature.workbooks_v2`) is opt-in, per workspace, and
 * decided by the server from the signed-in user's own workspace.
 */
const base = loadEnv();
const hasDatabase = Boolean(base.DATABASE_URL);
const V2 = "/api/v1/workbooks-v2/status";

describe.skipIf(!hasDatabase)("WORKBOOKS_V2 feature flag", () => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  let n = 0;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const as = (email: string, extra: Record<string, string> = {}) => ({ "x-stub-user-email": email, ...extra });

  /** A provisioned, active stub user. `flag`: undefined = no row, otherwise the stored entitlement value. */
  async function userIn(flag?: unknown, others: Record<string, boolean> = {}) {
    const email = `wb2-flag-${suffix}-${++n}@test.com`;
    await app.inject({ method: "GET", url: "/api/v1/me", headers: as(email) });
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u!.id));
    await db.update(schema.workspaces).set({ accessStatus: "active" }).where(eq(schema.workspaces.id, m!.workspaceId));
    const rows: Record<string, unknown> = { ...others };
    if (flag !== undefined) rows.workbooks_v2 = flag;
    for (const [f, value] of Object.entries(rows)) {
      await db.insert(schema.entitlements).values({ workspaceId: m!.workspaceId, key: `feature.${f}`, value, source: "test" });
    }
    invalidateWorkspaceAccess(m!.workspaceId);
    return { email, userId: u!.id, workspaceId: m!.workspaceId };
  }

  beforeAll(async () => {
    app = await buildApp({ ...base, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, EARLY_ACCESS_GATE_ENABLED: "true" });
  });
  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("1. a workspace with no switch is OFF: V2 is refused, the flag reads false, the legacy Workbooks API still works", async () => {
    const a = await userIn();
    const v2 = await app.inject({ method: "GET", url: V2, headers: as(a.email) });
    expect(v2.statusCode).toBe(403);
    expect(v2.json()).toMatchObject({ code: "feature_disabled", feature: "workbooks_v2" });

    const access = await app.inject({ method: "GET", url: "/api/v1/access-request", headers: as(a.email) });
    expect(access.json().data.features.workbooks_v2).toBe(false);
    expect(access.json().data.features.enrichment).toBe(true);

    const legacy = await app.inject({ method: "GET", url: "/api/v1/workbooks", headers: as(a.email) });
    expect(legacy.statusCode).toBe(200);
  });

  it("2. a workspace with the switch ON reaches V2 and sees the flag", async () => {
    const b = await userIn(true);
    const v2 = await app.inject({ method: "GET", url: V2, headers: as(b.email) });
    expect(v2.statusCode).toBe(200);
    expect(v2.json()).toEqual({ data: { enabled: true } });

    const access = await app.inject({ method: "GET", url: "/api/v1/access-request", headers: as(b.email) });
    expect(access.json().data.features.workbooks_v2).toBe(true);
  });

  it("3. a disabled workspace cannot reach V2 directly, including through an encoded path", async () => {
    const a = await userIn(false);
    for (const url of [V2, "/api/v1/%77orkbooks-v2/status", `${V2}?x=1`]) {
      const res = await app.inject({ method: "GET", url, headers: as(a.email) });
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ code: "feature_disabled", feature: "workbooks_v2" });
    }
  });

  it("4. a user cannot borrow another workspace's flag through the workspace header", async () => {
    const b = await userIn(true); // enabled, and the user below is NOT a member
    const a = await userIn();
    const borrowed = await app.inject({ method: "GET", url: V2, headers: as(a.email, { "x-workspace-id": b.workspaceId }) });
    expect(borrowed.statusCode).toBe(403);
    expect(borrowed.json()).not.toMatchObject({ data: { enabled: true } });
    const stolen = await app.inject({ method: "GET", url: "/api/v1/access-request", headers: as(a.email, { "x-workspace-id": b.workspaceId }) });
    expect(stolen.statusCode).toBe(403);

    // A malformed id is refused, not ignored.
    const bad = await app.inject({ method: "GET", url: V2, headers: as(a.email, { "x-workspace-id": "not-a-uuid" }) });
    expect(bad.statusCode).toBe(400);
  });

  it("4b. a member of both workspaces gets each workspace's own flag, never the other's", async () => {
    const on = await userIn(true);
    const off = await userIn();
    await db.insert(schema.workspaceMembers).values({ workspaceId: on.workspaceId, userId: off.userId, role: "member" });
    const viaOff = await app.inject({ method: "GET", url: V2, headers: as(off.email) });
    expect(viaOff.statusCode).toBe(403);
    const viaOn = await app.inject({ method: "GET", url: V2, headers: as(off.email, { "x-workspace-id": on.workspaceId }) });
    expect(viaOn.statusCode).toBe(200);
    const backToOff = await app.inject({ method: "GET", url: V2, headers: as(off.email, { "x-workspace-id": off.workspaceId }) });
    expect(backToOff.statusCode).toBe(403);
  });

  it("5. legacy Workbooks keep working with the flag off, create to read", async () => {
    const a = await userIn(false);
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/workbooks",
      headers: { ...as(a.email), "content-type": "application/json" },
      payload: { name: "Legacy still works", fields: ["company"] },
    });
    expect(create.statusCode).toBeLessThan(300);
    const id = create.json().data?.id ?? create.json().id;
    const get = await app.inject({ method: "GET", url: `/api/v1/workbooks/${id}`, headers: as(a.email) });
    expect(get.statusCode).toBe(200);
    await db.delete(schema.enrichmentWorkbooks).where(eq(schema.enrichmentWorkbooks.id, id));
  });

  it("5b. the V2 switch is independent of the legacy one: turning enrichment off still hides legacy, not the reverse", async () => {
    const both = await userIn(true, { enrichment: false });
    const legacy = await app.inject({ method: "GET", url: "/api/v1/workbooks", headers: as(both.email) });
    expect(legacy.json()).toMatchObject({ code: "feature_disabled", feature: "enrichment" });
    const v2 = await app.inject({ method: "GET", url: V2, headers: as(both.email) });
    expect(v2.statusCode).toBe(200);
  });

  it("6. anything other than a stored boolean true leaves V2 OFF", async () => {
    // (A JSON string "true" is not tested: the driver parses JSON-looking strings on read for every
    // entitlement. Writes are platform-managed and COPS validates them as booleans.)
    for (const value of [1, "yes", {}, [true]]) {
      const u = await userIn(value);
      const res = await app.inject({ method: "GET", url: V2, headers: as(u.email) });
      expect(res.statusCode, JSON.stringify(value)).toBe(403);
    }
  });

  it("6b. if the flag cannot be loaded the request is not let through", async () => {
    const broken = { select: () => { throw new Error("db down"); } } as unknown as Db;
    const guard = accessGuard(broken, { NODE_ENV: "test", EARLY_ACCESS_GATE_ENABLED: "true" });
    let sent = false;
    const reply = { code: () => reply, send: () => { sent = true; return reply; } };
    // A fresh uuid so nothing is cached for it.
    const request = { workspaceId: randomUUID(), url: V2, routeOptions: { url: "/api/v1/workbooks-v2/status" } };
    await expect(guard(request as never, reply as never)).rejects.toThrow("db down");
    expect(sent).toBe(false); // the guard threw, so Fastify answers 500 and the handler never runs
  });

  it("a pseudo workspace (external email-intel caller) never holds V2", async () => {
    const access = await loadWorkspaceAccess(db, "external-email-intel");
    expect(access.features.workbooks_v2).toBe(false);
    expect(access.features.enrichment).toBe(true);
  });

  it("a switch row of one workspace does not change another's", async () => {
    const on = await userIn(true);
    const other = await userIn();
    expect((await loadWorkspaceAccess(db, on.workspaceId)).features.workbooks_v2).toBe(true);
    expect((await loadWorkspaceAccess(db, other.workspaceId)).features.workbooks_v2).toBe(false);
  });

  it("feature.workbooks_v2 is platform-managed: a customer cannot grant it to themselves", async () => {
    const a = await userIn();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/entitlements/feature.workbooks_v2",
      headers: { ...as(a.email), "content-type": "application/json" },
      payload: { value: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "platform_managed_entitlement" });
    const still = await app.inject({ method: "GET", url: V2, headers: as(a.email) });
    expect(still.statusCode).toBe(403);
  });
});
