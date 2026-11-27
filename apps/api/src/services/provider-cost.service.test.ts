// cSpell:ignore wiza contactout lusha
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createDb } from "@skout/db";
import type { AttemptLog } from "@skout/pal";
import {
  createProviderCostRecorder,
  parseProviderUnitCosts,
  providerCallCostMicros,
  providerCallsFromAttempts,
  type ProviderCall,
} from "./provider-cost.service.js";
import { fetchWizaDeepList, searchVendors } from "./vendor-search.service.js";

const COSTS = JSON.stringify({ "wiza:search": { perCall: 1000, perUnit: 20000 }, "lusha:fetchPhone": { perCall: 50000 } });

describe("provider cost (PAPI-013)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prices calls from config, never guesses, and charges nothing on the workspace's own key", () => {
    const costs = parseProviderUnitCosts(COSTS);
    const call = (over: Partial<ProviderCall>): ProviderCall => ({ provider: "wiza", operation: "search", outcome: "ok", units: 3, ...over });
    expect(providerCallCostMicros(costs, call({}))).toBe(1000 + 3 * 20000);
    expect(providerCallCostMicros(costs, call({ outcome: "error", units: 0 }))).toBe(1000);
    expect(providerCallCostMicros(costs, call({ provider: "contactout" }))).toBeNull();
    expect(providerCallCostMicros(costs, call({ credentialSource: "workspace" }))).toBe(0);
    expect(parseProviderUnitCosts("{not json").size).toBe(0);
  });

  it("turns waterfall attempts into calls, keeping failures and dropping cache hits, gates and skips", () => {
    const attempts: AttemptLog[] = [
      { order: 1, provider: "internal_graph", operation: "lookupCompany", status: "ok", latencyMs: 0 },
      { order: 2, provider: "pdl", operation: "fetchCompany", status: "ok", latencyMs: 120, credentialSource: "platform" },
      { order: 3, provider: "hunter", operation: "findEmail", status: "miss", latencyMs: 90, credentialSource: "workspace" },
      { order: 4, provider: "lusha", operation: "fetchPhone", status: "error", latencyMs: 30, detail: "HTTP 500", credentialSource: "platform" },
      { order: 5, provider: "wiza", operation: "findEmail", status: "skipped", latencyMs: 0, credentialSource: "platform" },
      { order: 6, provider: "phone-gate", operation: "gate", status: "skipped", latencyMs: 0 },
    ];
    expect(providerCallsFromAttempts(attempts)).toEqual([
      { provider: "pdl", operation: "fetchCompany", outcome: "ok", units: 1, latencyMs: 120, credentialSource: "platform", errorMessage: undefined },
      { provider: "hunter", operation: "findEmail", outcome: "miss", units: 0, latencyMs: 90, credentialSource: "workspace", errorMessage: undefined },
      { provider: "lusha", operation: "fetchPhone", outcome: "error", units: 0, latencyMs: 30, credentialSource: "platform", errorMessage: "HTTP 500" },
    ]);
  });

  it("reports every search vendor call, the failed and empty ones too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("wiza.test")
          ? new Response("down", { status: 503 })
          : new Response(JSON.stringify({ profiles: {}, metadata: { total_results: 0 } }), { status: 200 })
      )
    );
    const calls: ProviderCall[] = [];
    const env = { WIZA_API_KEY: "w", CONTACTOUT_API_KEY: "c", WIZA_BASE_URL: "https://wiza.test", CONTACTOUT_BASE_URL: "https://co.test" } as never;
    await searchVendors(env, { jobTitle: "CTO" }, 25, 1, (c) => calls.push(c));
    expect(calls.map((c) => [c.provider, c.operation, c.outcome, c.units]).sort()).toEqual([
      ["contactout", "search", "miss", 0],
      ["wiza", "search", "error", 0],
    ]);
    expect(calls.find((c) => c.provider === "wiza")!.errorMessage).toContain("503");
  });

  it("reports a failed Wiza deep-list fetch once, then rethrows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const calls: ProviderCall[] = [];
    const env = { WIZA_API_KEY: "w", WIZA_BASE_URL: "https://wiza.test" } as never;
    await expect(fetchWizaDeepList(env, { jobTitle: "CTO" }, 100, { onCall: (c) => calls.push(c) })).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: "wiza", operation: "deep_list", outcome: "error", units: 0 });
  });

  it("never throws when the insert fails, and skips a stand-in db", async () => {
    const failing = { insert: () => ({ values: async () => Promise.reject(new Error("db down")) }) } as never;
    await expect(createProviderCostRecorder(failing)([{ provider: "x", operation: "y", outcome: "ok", units: 1 }], { source: "search" })).resolves.toBeUndefined();
    await expect(createProviderCostRecorder({} as never)([{ provider: "x", operation: "y", outcome: "ok", units: 1 }], { source: "search" })).resolves.toBeUndefined();
  });
});

const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("provider_cost_events rows (Postgres)", () => {
  const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (
    u: string,
    o?: object
  ) => any;
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  const ws = randomUUID();

  afterAll(async () => {
    await sql`delete from workspaces where id = ${ws}`;
    await sql.end();
    await dbSql.end();
  });

  it("writes one row per call, failed ones included, with cost and credential source", async () => {
    await sql`insert into workspaces (id, name, slug) values (${ws}, 'PAPI-013 test', ${"papi013-" + ws})`;
    const record = createProviderCostRecorder(db, COSTS);
    await record(
      [
        { provider: "wiza", operation: "search", outcome: "ok", units: 2, latencyMs: 300 },
        { provider: "lusha", operation: "fetchPhone", outcome: "error", units: 0, latencyMs: 40, errorMessage: "x".repeat(900) },
        { provider: "hunter", operation: "findEmail", outcome: "miss", units: 0, credentialSource: "workspace" },
      ],
      { source: "search", workspaceId: ws, requestId: "req_123" }
    );
    const rows = await sql`
      select provider, outcome, units, cost_micros, credential_source, request_id, length(error_message) as err_len
      from provider_cost_events where workspace_id = ${ws} order by provider`;
    expect(rows).toEqual([
      { provider: "hunter", outcome: "miss", units: 0, cost_micros: 0, credential_source: "workspace", request_id: "req_123", err_len: null },
      { provider: "lusha", outcome: "error", units: 0, cost_micros: 50000, credential_source: "platform", request_id: "req_123", err_len: 500 },
      { provider: "wiza", outcome: "ok", units: 2, cost_micros: 41000, credential_source: "platform", request_id: "req_123", err_len: null },
    ]);
  });
});
