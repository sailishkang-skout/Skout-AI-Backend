import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { postCreditTransaction, schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import {
  API_TERMS_VERSION,
  assertAddonEnabled,
  disableAddon,
  getAddonStatus,
  liveKeyBlock,
} from "../services/public-api-addon.service.js";

/** PAPI-020 against a real, migrated Postgres: the API add-on, terms acceptance and live-key rules. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("PAPI-020 API add-on", () => {
  let app: FastifyInstance;
  const email = `papi020-${randomUUID().slice(0, 8)}@test.com`;
  const headers = { "x-stub-user-email": email, "content-type": "application/json" };
  let workspaceId: string;
  let userId: string;

  const setRole = (role: string) =>
    app.db!
      .update(schema.workspaceMembers)
      .set({ role })
      .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
  const enable = (payload: unknown) =>
    app.inject({ method: "POST", url: "/api/v1/developer/api-addon/enable", headers: { ...headers, "x-forwarded-for": "203.0.113.9" }, payload: payload as object });

  beforeAll(async () => {
    const config = loadEnv();
    app = await buildApp({ ...config, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined });
    const status = await app.inject({ method: "GET", url: "/api/v1/developer/api-addon", headers });
    expect(status.statusCode).toBe(200);
    const [member] = await app.db!
      .select({ workspaceId: schema.workspaceMembers.workspaceId, userId: schema.workspaceMembers.userId })
      .from(schema.workspaceMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
      .where(eq(schema.users.email, email))
      .limit(1);
    workspaceId = member!.workspaceId;
    userId = member!.userId;
    await setRole("owner");
  }, 60000);

  afterAll(async () => {
    if (workspaceId) await app.db!.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await app?.close();
  });

  it("starts off: no test or live keys until an Owner enables it", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/developer/api-addon", headers });
    expect(res.json()).toMatchObject({
      enabled: false,
      currentTermsVersion: API_TERMS_VERSION,
      acceptedTermsVersion: null,
      canCreateTestKeys: false,
      canCreateLiveKeys: false,
      liveKeyBlock: "addon_disabled",
    });
  });

  it("fails without accepting the current terms, and stores nothing", async () => {
    expect((await enable({})).statusCode).toBe(422);
    expect((await enable({ accept_terms: false, terms_version: API_TERMS_VERSION })).statusCode).toBe(422);
    expect((await enable({ accept_terms: true, terms_version: "2020-01-01" })).statusCode).toBe(422);
    const rows = await app.db!.select().from(schema.apiTermsAcceptances).where(eq(schema.apiTermsAcceptances.workspaceId, workspaceId));
    expect(rows).toHaveLength(0);
    expect((await getAddonStatus(app.db!, workspaceId)).enabled).toBe(false);
  });

  it("refuses an Admin (not Owner) with 403", async () => {
    await setRole("admin");
    try {
      const res = await enable({ accept_terms: true, terms_version: API_TERMS_VERSION });
      expect(res.statusCode).toBe(403);
      expect((await getAddonStatus(app.db!, workspaceId)).enabled).toBe(false);
    } finally {
      await setRole("owner");
    }
  });

  it("lets the Owner enable it, recording user, time, IP and terms version, the entitlement and an audit row", async () => {
    const res = await enable({ accept_terms: true, terms_version: API_TERMS_VERSION });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, acceptedTermsVersion: API_TERMS_VERSION, canCreateTestKeys: true });
    const [acc] = await app.db!.select().from(schema.apiTermsAcceptances).where(eq(schema.apiTermsAcceptances.workspaceId, workspaceId));
    expect(acc).toMatchObject({ userId, termsVersion: API_TERMS_VERSION });
    expect(acc!.acceptedAt).toBeInstanceOf(Date);
    expect(acc!.ip).toBeTruthy();
    const [ent] = await app.db!
      .select({ value: schema.entitlements.value })
      .from(schema.entitlements)
      .where(and(eq(schema.entitlements.workspaceId, workspaceId), eq(schema.entitlements.key, "api.access")));
    expect(ent!.value).toEqual({ enabled: true });
    const audits = await app.db!
      .select({ action: schema.auditLogs.action })
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.workspaceId, workspaceId), eq(schema.auditLogs.action, "api_addon.enabled")));
    expect(audits).toHaveLength(1);
  });

  it("keeps a trial workspace on test keys until it buys credits or CustomerOps allows live access", async () => {
    await app.db!
      .insert(schema.entitlements)
      .values({ workspaceId, key: "subscription", value: { status: "trial", trial_ends_at: new Date(Date.now() + 7 * 864e5).toISOString() }, source: "test" })
      .onConflictDoUpdate({
        target: [schema.entitlements.workspaceId, schema.entitlements.key],
        set: { value: { status: "trial", trial_ends_at: new Date(Date.now() + 7 * 864e5).toISOString() } },
      });
    expect(await liveKeyBlock(app.db!, workspaceId)).toBe("live_access_not_enabled");
    expect(await getAddonStatus(app.db!, workspaceId)).toMatchObject({ canCreateTestKeys: true, canCreateLiveKeys: false });

    await app.db!.update(schema.workspaceApiSettings).set({ liveAccessForTrial: true }).where(eq(schema.workspaceApiSettings.workspaceId, workspaceId));
    expect(await liveKeyBlock(app.db!, workspaceId)).toBeNull();
    await app.db!.update(schema.workspaceApiSettings).set({ liveAccessForTrial: false }).where(eq(schema.workspaceApiSettings.workspaceId, workspaceId));

    await postCreditTransaction(app.db!, { workspaceId, amount: 100, kind: "purchase", action: "razorpay_purchase", referenceId: `pay_${randomUUID()}` });
    expect(await liveKeyBlock(app.db!, workspaceId)).toBeNull();
  });

  it("can be disabled by CustomerOps with a reason; every key check then gets 403 addon_disabled", async () => {
    await expect(disableAddon(app.db!, { workspaceId, actorId: "ops-staff-1", actorType: "staff", reason: "  " })).rejects.toThrow();
    await disableAddon(app.db!, { workspaceId, actorId: "ops-staff-1", actorType: "staff", reason: "abuse report" });
    const status = await getAddonStatus(app.db!, workspaceId);
    expect(status).toMatchObject({ enabled: false, disabledReason: "abuse report", canCreateTestKeys: false, liveKeyBlock: "addon_disabled" });
    await expect(assertAddonEnabled(app.db!, workspaceId)).rejects.toMatchObject({ statusCode: 403, message: "addon_disabled" });
    const [ent] = await app.db!
      .select({ value: schema.entitlements.value })
      .from(schema.entitlements)
      .where(and(eq(schema.entitlements.workspaceId, workspaceId), eq(schema.entitlements.key, "api.access")));
    expect(ent!.value).toEqual({ enabled: false });
  });
});
