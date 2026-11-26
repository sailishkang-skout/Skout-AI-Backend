import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, schema } from "@skout/db";
import { registerPublicApiAuth } from "../plugins/public-api-auth.js";
import { createMemoryFailedAuthLimiter } from "../lib/failed-auth-limiter.js";
import { createMemoryQuotaStore } from "../lib/api-quota.js";
import { ApiPricingService } from "../services/api-pricing.service.js";
import { createPublicApiKey, PUBLIC_API_SCOPES, type PublicApiScope } from "../services/public-api-keys.service.js";
import { publicApiPlugin } from "./plugin.js";
import { createPublicIdCodec } from "./ids.js";
import { assertEndpointScope, PUBLIC_API_SCOPE_MAP, scopeKey } from "./scopes.js";
import { createPublicEndpoints } from "./index.js";
import type { PublicEndpoint } from "./pipeline.js";

describe("the static scope map (PAPI-045, PRD §7.3)", () => {
  it("lists every v1 endpoint with its PRD scope, and every scope is a real one", () => {
    expect(Object.keys(PUBLIC_API_SCOPE_MAP)).toHaveLength(16);
    for (const scope of Object.values(PUBLIC_API_SCOPE_MAP)) {
      expect(scope === "any" || (PUBLIC_API_SCOPES as readonly string[]).includes(scope)).toBe(true);
    }
    expect(PUBLIC_API_SCOPE_MAP["POST /contacts/email/find"]).toBe("contacts:reveal");
    expect(PUBLIC_API_SCOPE_MAP["GET /jobs/:id"]).toBe("any");
  });

  it("refuses to register an endpoint that is missing from the map or has another scope", () => {
    expect(() => assertEndpointScope({ method: "POST", path: "/people/search", scope: "search:read" })).not.toThrow();
    expect(() => assertEndpointScope({ method: "POST", path: "/people/search", scope: "people:read" })).toThrow(/scope map says search:read/);
    expect(() => assertEndpointScope({ method: "GET", path: "/secret/admin", scope: "any" })).toThrow(/not in PUBLIC_API_SCOPE_MAP/);
  });

  it("covers every endpoint the API actually registers", () => {
    for (const ep of createPublicEndpoints({ env: {} as never, db: {} as never })) expect(() => assertEndpointScope(ep)).not.toThrow();
  });
});

const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PEPPER = randomBytes(32).toString("base64");

maybe("every endpoint, with and without its scope (PAPI-045)", () => {
  const { db, sql } = createDb(url as string);
  let app: FastifyInstance;
  let ws: string;
  let userId: string;
  const reached = new Map<string, number>();
  /** A test key holding every scope except one, per scope; and one holding them all. */
  const without = new Map<PublicApiScope, string>();
  let allScopes: string;

  // Real endpoints as they land in Phase 5; a stub for each mapped endpoint not built yet.
  const real = new Map(createPublicEndpoints({ env: {} as never, db: {} as never }).map((ep) => [scopeKey(ep.method, ep.path), ep]));
  const endpoints: PublicEndpoint[] = Object.entries(PUBLIC_API_SCOPE_MAP).map(([k, scope]) => {
    const existing = real.get(k);
    if (existing) return existing;
    const [method, path] = k.split(" ") as ["GET" | "POST" | "DELETE", string];
    const hit = () => void reached.set(k, (reached.get(k) ?? 0) + 1);
    return {
      method,
      path,
      scope,
      operation: null,
      input: z.object({ id: z.string().optional() }).strict(),
      maxCost: () => 0,
      handle: async () => (hit(), { data: { ok: true }, charge: 0 }),
      fixture: () => (hit(), { ok: true }),
    };
  });

  const request = (k: string, key: string) => {
    const [method, path] = k.split(" ") as ["GET" | "POST" | "DELETE", string];
    return app.inject({
      method,
      url: `/api/public/v1${path.replace(/:id/g, "per_x")}`,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      ...(method === "POST" ? { payload: "{}" } : {}),
    });
  };

  beforeAll(async () => {
    ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-045", slug: `papi045-${ws}` });
    const [u] = await db.insert(schema.users).values({ email: `papi045-${ws.slice(0, 8)}@test.com`, isActive: true }).returning();
    userId = u!.id;
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId, role: "owner" });
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true, maxActiveKeys: 30 });
    const cfg = { pepper: PEPPER, maxActiveKeys: 30 };
    const actor = { workspaceId: ws, userId };
    for (const scope of PUBLIC_API_SCOPES) {
      const others = PUBLIC_API_SCOPES.filter((s) => s !== scope);
      without.set(scope, (await createPublicApiKey(db, cfg, actor, { name: `no ${scope}`, type: "test", scopes: others })).key);
    }
    allScopes = (await createPublicApiKey(db, cfg, actor, { name: "all", type: "test", scopes: [...PUBLIC_API_SCOPES] })).key;

    app = Fastify({ genReqId: () => randomUUID() });
    app.decorate("config", { API_KEY_PEPPER: PEPPER, PUBLIC_API_MAX_ACTIVE_KEYS: 30 } as never);
    app.decorate("db", db);
    app.decorate("publicKeyCache", null);
    registerPublicApiAuth(app, { limiter: createMemoryFailedAuthLimiter({ perMinute: 1000, blockMinutes: 15 }) });
    await app.register(publicApiPlugin, {
      prefix: "/api/public/v1",
      deps: {
        db,
        pricing: new ApiPricingService(db, { INTERNAL_WORKSPACE_ID: randomUUID(), searchCreditCost: 1 }),
        quotas: createMemoryQuotaStore(),
        limitDefaults: { verifyDailyQuota: 5000, searchDailyQuota: 10000 },
        enabled: true,
        ids: createPublicIdCodec(PEPPER),
      },
      endpoints,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await sql.end();
  });

  it("refuses each endpoint to a key without its scope, before the handler", async () => {
    const failures: string[] = [];
    for (const [k, scope] of Object.entries(PUBLIC_API_SCOPE_MAP)) {
      if (scope === "any") continue;
      const before = reached.get(k) ?? 0;
      const res = await request(k, without.get(scope)!);
      if (res.statusCode !== 403 || res.json().error?.code !== "scope_missing") failures.push(`${k} -> ${res.statusCode} ${res.body}`);
      if ((reached.get(k) ?? 0) !== before) failures.push(`${k}: handler reached without ${scope}`);
    }
    expect(failures).toEqual([]);
  });

  it("lets each endpoint through with its scope", async () => {
    const failures: string[] = [];
    for (const [k, scope] of Object.entries(PUBLIC_API_SCOPE_MAP)) {
      const keys = scope === "any" ? [...without.values()] : [allScopes];
      for (const key of keys) {
        const res = await request(k, key);
        if (res.statusCode === 403) failures.push(`${k} -> 403 ${res.body}`);
        if (!real.has(k) && res.statusCode !== 200) failures.push(`${k} -> ${res.statusCode} ${res.body}`);
      }
    }
    expect(failures).toEqual([]);
    for (const k of Object.keys(PUBLIC_API_SCOPE_MAP)) if (!real.has(k)) expect(reached.get(k), k).toBeGreaterThan(0);
  });
});
