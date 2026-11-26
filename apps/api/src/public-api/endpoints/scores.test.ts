import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const osGet = vi.fn();
vi.mock("@skout/opensearch", async (orig) => ({
  ...(await orig<typeof import("@skout/opensearch")>()),
  getProspectById: (...a: unknown[]) => osGet(...a),
}));

import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, postCreditTransaction, schema } from "@skout/db";
import { registerPublicApiAuth } from "../../plugins/public-api-auth.js";
import { createMemoryFailedAuthLimiter } from "../../lib/failed-auth-limiter.js";
import { createMemoryQuotaStore } from "../../lib/api-quota.js";
import { ApiPricingService } from "../../services/api-pricing.service.js";
import { createPublicApiKey } from "../../services/public-api-keys.service.js";
import { availableCredits } from "../../services/api-credits.service.js";
import type { IcpConfig, ScoreInput, ScoreResult } from "../../services/enrichment/ai-client.js";
import { publicApiPlugin } from "../plugin.js";
import { createPublicIdCodec } from "../ids.js";
import { createScoresEndpoint } from "./scores.js";

/** PAPI-059: POST /scores on real Postgres; the scorer, ICP and index faked. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const PEPPER = randomBytes(32).toString("base64");
const codec = createPublicIdCodec(PEPPER);
const env = { OPENSEARCH_URL: "https://os.test" } as never;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const result = (input: ScoreInput, icpScore: number): ScoreResult => ({
  prospectId: input.prospectId,
  icpScore,
  icpBand: icpScore >= 75 ? "strong" : "medium",
  intentScore: 55.4,
  painPoints: ["manual prospecting"],
  painPointsRationale: null,
  outreachReadiness: "warm",
  reasoning: `Fits on ${input.industry ?? input.title ?? "company"}`,
  source: "heuristic",
  dimensions: {},
});

maybe("scores endpoint (PAPI-059)", () => {
  const { db, sql } = createDb(url as string);
  let app: FastifyInstance;
  const users: string[] = [];
  const seen: ScoreInput[] = [];
  let icp: IcpConfig = { industries: ["Software"] };
  let scorer: (input: ScoreInput) => Promise<ScoreResult> = async (i) => result(i, i.industry === "Software" ? 82.6 : 40);
  const A = { ws: "", key: "", testKey: "", narrowKey: "" };
  const P = { ws: "", key: "" };

  async function workspace(scoreCost?: number) {
    const ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-059", slug: `papi059-${ws}` });
    const [u] = await db.insert(schema.users).values({ email: `papi059-${ws.slice(0, 8)}@test.com`, isActive: true }).returning();
    users.push(u!.id);
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId: u!.id, role: "owner" });
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, addonEnabled: true });
    await postCreditTransaction(db, { workspaceId: ws, amount: 100, kind: "purchase", action: "test" });
    // The app's own scoring price for this workspace: the API follows it (PRD §8).
    if (scoreCost !== undefined) await db.insert(schema.entitlements).values({ workspaceId: ws, key: "enrichment.score_credit_cost", value: scoreCost, source: "test" });
    const mk = (type: "live" | "test", scopes: string[]) =>
      createPublicApiKey(db, { pepper: PEPPER, maxActiveKeys: 10 }, { workspaceId: ws, userId: u!.id }, { name: type, type, scopes });
    return {
      ws,
      key: (await mk("live", ["scores:write"])).key,
      testKey: (await mk("test", ["scores:write"])).key,
      narrowKey: (await mk("live", ["people:read"])).key,
    };
  }
  const post = (key: string, records: unknown[]) =>
    app.inject({
      method: "POST",
      url: "/api/public/v1/scores",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      payload: JSON.stringify({ records }),
    });
  const balance = async (ws: string) => (await availableCredits(db, ws)).balance;

  beforeAll(async () => {
    Object.assign(A, await workspace());
    Object.assign(P, await workspace(4));
    app = Fastify({ genReqId: () => randomUUID() });
    app.decorate("config", { API_KEY_PEPPER: PEPPER, PUBLIC_API_MAX_ACTIVE_KEYS: 10 } as never);
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
        ids: codec,
      },
      endpoints: [
        createScoresEndpoint({
          env,
          db,
          score: async (input) => (seen.push(input), scorer(input)),
          loadIcp: async () => icp,
        }) as never,
      ],
    });
    await app.ready();
  });

  beforeEach(() => {
    seen.length = 0;
    icp = { industries: ["Software"] };
    scorer = async (i) => result(i, i.industry === "Software" ? 82.6 : 40);
    osGet.mockReset();
    osGet.mockResolvedValue(null);
  });

  afterAll(async () => {
    await app.close();
    for (const ws of [A.ws, P.ws]) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    for (const u of users) await db.delete(schema.users).where(eq(schema.users.id, u));
    await sql.end();
  });

  it("scores people and companies against the ICP, echoing refs, at the app's scoring price per record", async () => {
    const before = await balance(P.ws);
    const res = await post(P.key, [
      { ref: "crm-1", title: "VP Sales", industry: "Software", company_domain: "https://www.acme.com" },
      { ref: "crm-2", type: "company", company_name: "Steel Co", industry: "Manufacturing", employee_count: 900 },
    ]);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({ scored: 2, failed: 0 });
    expect(data.results[0]).toEqual({
      ref: "crm-1",
      person_id: null,
      type: "person",
      score: 83,
      band: "strong",
      intent_score: 55,
      readiness: "warm",
      reasoning: "Fits on Software",
      pain_points: ["manual prospecting"],
    });
    expect(data.results[1]).toMatchObject({ ref: "crm-2", type: "company", score: 40 });
    expect(seen[0]).toMatchObject({ companyDomain: "acme.com", title: "VP Sales" });
    expect(res.headers["x-credits-charged"]).toBe("8");
    expect(await balance(P.ws)).toBe(before - 8);
    expect(res.body).not.toMatch(UUID_RE);
    expect(res.body).not.toContain("heuristic");
  });

  it("fills a person_id record from the index and charges only scored records", async () => {
    const prospectId = randomBytes(32).toString("hex");
    osGet.mockImplementation(async (_c: unknown, id: string) =>
      id === prospectId ? { prospectId, companyId: "c", fullName: "Ada", title: "CTO", industry: "Software", companyDomain: "acme.com", employeeCount: 250 } : null
    );
    const before = await balance(A.ws);
    const pid = codec.encode("person", prospectId);
    const res = await post(A.key, [{ person_id: pid }, { person_id: codec.encode("person", "missing") }, { person_id: "per_forged" }]);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({ scored: 1, failed: 2 });
    expect(data.results[0]).toMatchObject({ person_id: pid, score: 83 });
    expect(data.results[1]).toMatchObject({ error: "not_found" });
    expect(seen[0]).toMatchObject({ prospectId, title: "CTO", industry: "Software", employeeCount: 250 });
    // Default price follows SCORE_CREDIT_COST (2): one scored record.
    expect(res.headers["x-credits-charged"]).toBe("2");
    expect(await balance(A.ws)).toBe(before - 2);
  });

  it("refuses without an ICP and charges nothing when scoring fails", async () => {
    const before = await balance(A.ws);
    icp = {};
    const noIcp = await post(A.key, [{ title: "CTO" }]);
    expect(noIcp.statusCode).toBe(422);
    expect(noIcp.json().error.message).toMatch(/ideal customer profile/);
    icp = { industries: ["Software"] };
    scorer = async () => {
      throw new Error("scorer down");
    };
    expect((await post(A.key, [{ title: "CTO" }, { industry: "Software" }])).statusCode).toBe(503);
    scorer = async (i) => {
      if (i.title === "Breaks") throw new Error("one bad record");
      return result(i, 70);
    };
    const mixed = await post(A.key, [{ title: "Breaks" }, { title: "Fine" }]);
    expect(mixed.json().data).toMatchObject({ scored: 1, failed: 1 });
    expect(mixed.json().data.results[0]).toMatchObject({ error: "scoring_failed" });
    expect(await balance(A.ws)).toBe(before - 2);
  });

  it("validates strictly, needs scores:write, and serves test keys a free fixture", async () => {
    const many = Array.from({ length: 101 }, () => ({ title: "CTO" }));
    for (const records of [[], many, [{}], [{ ref: "x" }], [{ type: "company", title: "CTO" }], [{ type: "company", person_id: "per_x" }], [{ title: "CTO", workspace_id: P.ws }]]) {
      expect((await post(A.key, records)).statusCode, JSON.stringify(records).slice(0, 80)).toBe(422);
    }
    expect((await post(A.narrowKey, [{ title: "CTO" }])).statusCode).toBe(403);
    const before = await balance(A.ws);
    const fx = await post(A.testKey, [{ ref: "r", title: "CTO" }]);
    expect(fx.statusCode).toBe(200);
    expect(fx.json().data.results[0]).toMatchObject({ ref: "r", score: 80 });
    expect(seen).toHaveLength(0);
    expect(await balance(A.ws)).toBe(before);
  });
});
