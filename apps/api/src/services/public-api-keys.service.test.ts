import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import {
  createPublicApiKey,
  generatePublicApiKey,
  listPublicApiKeys,
  maskKey,
  parsePublicApiKey,
  revokePublicApiKey,
  rotatePublicApiKey,
  verifyPublicApiKey,
  type KeyServiceConfig,
} from "./public-api-keys.service.js";
import { generateApiKey, keyMatches } from "./cops-api-credentials.service.js";

const PEPPER = randomBytes(32).toString("base64");
const DAY = 86_400_000;

describe("public API key format (PAPI-021, KEY-1)", () => {
  it("generates sk_live_/sk_test_ keys with a 12-hex prefix and a 43-char secret, and parses them back", () => {
    const live = generatePublicApiKey("live", PEPPER);
    expect(live.key).toMatch(/^sk_live_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(parsePublicApiKey(live.key)).toEqual({ type: "live", prefix: live.prefix });
    expect(parsePublicApiKey(generatePublicApiKey("test", PEPPER).key)?.type).toBe("test");
    expect(live.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(live.hmac).not.toContain(live.key);
  });

  it("rejects malformed tokens, other key families and the docs placeholder (DOC-7)", () => {
    const { key } = generatePublicApiKey("live", PEPPER);
    for (const bad of [
      "",
      key.slice(0, -1),
      `${key}x`,
      key.replace("sk_live_", "sk_prod_"),
      key.replace(/_[0-9a-f]{12}_/, "_ABCDEF123456_"),
      "sk_test_xxxxxxxxxxxx_" + "x".repeat(43),
      generateApiKey().key,
    ]) {
      expect(parsePublicApiKey(bad)).toBeNull();
    }
  });

  it("keeps the COPS key helpers working after moving them to the shared module", () => {
    const { key, hash } = generateApiKey();
    expect(key).toMatch(/^sk_cops_[0-9a-f]{12}_[A-Za-z0-9_-]{32}$/);
    expect(keyMatches(key, hash)).toBe(true);
    expect(keyMatches(`${key}x`, hash)).toBe(false);
  });

  it("masks keys for display", () => {
    expect(maskKey("live", "0123456789ab")).toBe("sk_live_0123456789ab_••••");
  });
});

const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("public API key service (Postgres)", () => {
  const { db, sql } = createDb(url as string);
  const cfg: KeyServiceConfig = { pepper: PEPPER, maxActiveKeys: 10 };
  let ws: string;
  let userId: string;
  const actor = () => ({ workspaceId: ws, userId });
  const create = (over: Partial<Parameters<typeof createPublicApiKey>[3]> = {}, now?: Date) =>
    createPublicApiKey(db, cfg, actor(), { name: "Server key", type: "live", scopes: ["search:read"], ...over }, now);

  beforeAll(async () => {
    ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-021 test", slug: `papi021-${ws}` });
    const [u] = await db.insert(schema.users).values({ email: `papi021-${ws.slice(0, 8)}@test.com` }).returning();
    userId = u!.id;
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true });
  });

  afterAll(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await sql.end();
  });

  it("creates a key, returns it once, stores only its HMAC, and verifies it", async () => {
    const created = await create({ scopes: ["search:read", "search:read", "people:read"], ipAllowlist: ["203.0.113.0/24", "2001:db8::1"] });
    expect(created.key).toMatch(/^sk_live_/);
    expect(created).toMatchObject({ status: "active", scopes: ["search:read", "people:read"], masked_key: expect.stringMatching(/••••$/) });
    const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, created.id));
    expect(JSON.stringify(row)).not.toContain(created.key);
    const listed = await listPublicApiKeys(db, ws);
    expect(JSON.stringify(listed)).not.toContain(created.key);
    const ok = await verifyPublicApiKey(db, cfg, created.key);
    expect(ok.ok && ok.key.id).toBe(created.id);
    const [audit] = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.entityId, created.id), eq(schema.auditLogs.action, "api_key.created")));
    expect(JSON.stringify(audit)).not.toContain(created.key);
    await revokePublicApiKey(db, actor(), created.id, "cleanup");
  });

  it("refuses a wrong secret and an unknown prefix with the same error", async () => {
    const created = await create();
    const wrongSecret = created.key.slice(0, -4) + (created.key.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(await verifyPublicApiKey(db, cfg, wrongSecret)).toEqual({ ok: false, error: "authentication_failed" });
    const unknown = generatePublicApiKey("live", PEPPER).key;
    expect(await verifyPublicApiKey(db, cfg, unknown)).toEqual({ ok: false, error: "authentication_failed" });
    expect(await verifyPublicApiKey(db, cfg, "not-a-key")).toEqual({ ok: false, error: "authentication_failed" });
    // The same secret under a different pepper doesn't match either.
    expect(await verifyPublicApiKey(db, { ...cfg, pepper: randomBytes(32).toString("base64") }, created.key)).toEqual({
      ok: false,
      error: "authentication_failed",
    });
    await revokePublicApiKey(db, actor(), created.id, "cleanup");
  });

  it("reports an expired key and a revoked key", async () => {
    const past = new Date(Date.now() - 10 * DAY);
    const expiring = await create({ expiresInDays: 5 }, past);
    expect(await verifyPublicApiKey(db, cfg, expiring.key)).toEqual({ ok: false, error: "key_expired" });

    const revoked = await create();
    await expect(revokePublicApiKey(db, actor(), revoked.id, " ")).rejects.toThrow(/reason/);
    const view = await revokePublicApiKey(db, actor(), revoked.id, "leaked in a log");
    expect(view).toMatchObject({ status: "revoked", revoke_reason: "leaked in a log" });
    expect(await verifyPublicApiKey(db, cfg, revoked.key)).toEqual({ ok: false, error: "key_revoked" });
  });

  it("rejects a 91-day expiry and caps rotation grace at the old key's own expiry", async () => {
    await expect(create({ expiresInDays: 91 })).rejects.toMatchObject({ statusCode: 422 });
    await expect(create({ expiresInDays: 0 })).rejects.toMatchObject({ statusCode: 422 });
    const shortLived = await create({ expiresInDays: 2 });
    const { old, replacement } = await rotatePublicApiKey(db, cfg, actor(), shortLived.id, 168);
    expect(new Date(old.grace_until!).getTime()).toBe(new Date(shortLived.expires_at).getTime());
    expect(new Date(replacement.expires_at).getTime() - new Date(replacement.created_at).getTime()).toBe(90 * DAY);
    await revokePublicApiKey(db, actor(), old.id, "cleanup");
    await revokePublicApiKey(db, actor(), replacement.id, "cleanup");
  });

  it("keeps a rotated key working inside its grace period, then refuses it", async () => {
    const created = await create();
    const now = new Date();
    const { old, replacement } = await rotatePublicApiKey(db, cfg, actor(), created.id, 24, now);
    expect(old.status).toBe("grace");
    expect(old.replaced_by).toBe(replacement.id);
    expect((await verifyPublicApiKey(db, cfg, created.key, new Date(now.getTime() + 23 * 3_600_000))).ok).toBe(true);
    expect(await verifyPublicApiKey(db, cfg, created.key, new Date(now.getTime() + 25 * 3_600_000))).toEqual({ ok: false, error: "key_revoked" });
    expect((await verifyPublicApiKey(db, cfg, replacement.key)).ok).toBe(true);
    await expect(rotatePublicApiKey(db, cfg, actor(), created.id, 24)).rejects.toMatchObject({ statusCode: 409 });

    const immediate = await rotatePublicApiKey(db, cfg, actor(), replacement.id, 0);
    expect(immediate.old.status).toBe("revoked");
    expect(await verifyPublicApiKey(db, cfg, replacement.key)).toEqual({ ok: false, error: "key_revoked" });
    await expect(rotatePublicApiKey(db, cfg, actor(), immediate.replacement.id, 12)).rejects.toMatchObject({ statusCode: 422 });
    for (const id of [old.id, immediate.replacement.id]) await revokePublicApiKey(db, actor(), id, "cleanup");
  });

  it("enforces the 10-active-key limit, counting only keys that still work", async () => {
    const made = [];
    for (let i = 0; i < 10; i++) made.push(await create({ name: `k${i}`, type: i % 2 ? "test" : "live" }));
    await expect(create({ name: "eleventh" })).rejects.toMatchObject({ statusCode: 409, message: "key_limit_reached" });
    await revokePublicApiKey(db, actor(), made[0]!.id, "make room");
    const eleventh = await create({ name: "eleventh" });
    await expect(create({ name: "twelfth" })).rejects.toMatchObject({ statusCode: 409 });
    // A per-workspace override from CustomerOps raises the limit.
    await db.update(schema.workspaceApiSettings).set({ maxActiveKeys: 11 }).where(eq(schema.workspaceApiSettings.workspaceId, ws));
    const twelfth = await create({ name: "twelfth" });
    for (const k of [...made.slice(1), eleventh, twelfth]) await revokePublicApiKey(db, actor(), k.id, "cleanup");
    await db.update(schema.workspaceApiSettings).set({ maxActiveKeys: null }).where(eq(schema.workspaceApiSettings.workspaceId, ws));
  });

  it("validates scopes, IP allowlist and caps", async () => {
    await expect(create({ scopes: [] })).rejects.toMatchObject({ statusCode: 422 });
    await expect(create({ scopes: ["admin:all"] })).rejects.toMatchObject({ statusCode: 422 });
    await expect(create({ ipAllowlist: ["10.0.0.0/33"] })).rejects.toMatchObject({ statusCode: 422 });
    await expect(create({ ipAllowlist: ["example.com"] })).rejects.toMatchObject({ statusCode: 422 });
    await expect(create({ dailyCreditCap: -1 })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("allows test keys only for a trial workspace, and nothing once the add-on is off (PAPI-020)", async () => {
    await db.insert(schema.entitlements).values({
      workspaceId: ws,
      key: "subscription",
      value: { status: "trial", trial_ends_at: new Date(Date.now() + 7 * DAY).toISOString() },
      source: "test",
    });
    await expect(create({ type: "live" })).rejects.toMatchObject({ statusCode: 403, message: "live_access_not_enabled" });
    const testKey = await create({ type: "test" });
    await revokePublicApiKey(db, actor(), testKey.id, "cleanup");
    await db.delete(schema.entitlements).where(and(eq(schema.entitlements.workspaceId, ws), eq(schema.entitlements.key, "subscription")));

    await db.update(schema.workspaceApiSettings).set({ addonEnabled: false }).where(eq(schema.workspaceApiSettings.workspaceId, ws));
    await expect(create({ type: "test" })).rejects.toMatchObject({ statusCode: 403, message: "addon_disabled" });
    await db.update(schema.workspaceApiSettings).set({ addonEnabled: true }).where(eq(schema.workspaceApiSettings.workspaceId, ws));
  });

  it("refuses to work without a pepper", async () => {
    await expect(verifyPublicApiKey(db, { ...cfg, pepper: undefined }, "x")).rejects.toMatchObject({ statusCode: 503 });
  });
});
