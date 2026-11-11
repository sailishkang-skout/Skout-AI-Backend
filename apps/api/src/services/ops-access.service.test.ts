import { beforeEach, describe, expect, it, vi } from "vitest";

const perms = vi.hoisted(() => ({ value: [] as string[] }));
vi.mock("@skout/auth", () => ({ getMemberPermissions: vi.fn(async () => perms.value) }));

import { canGrantOpsAccess, isInternalWorkspace, opsAccessEnforced, opsAccessGuard, opsAccessState } from "./ops-access.service.js";

const INTERNAL = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "22222222-2222-4222-8222-222222222222";
const db = {} as never;
/** A db whose "does this workspace have an Ops access holder?" query answers from `holders`. */
function holderDb(holders: string[]) {
  let ws = "";
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.innerJoin = () => chain;
  chain.where = (cond: unknown) => {
    // The workspace id is a bound value somewhere inside drizzle's (circular) condition object.
    const seen = new WeakSet<object>();
    const find = (v: unknown): string => {
      if (typeof v === "string") return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v) ? v : "";
      if (!v || typeof v !== "object" || seen.has(v)) return "";
      seen.add(v);
      for (const x of Object.values(v)) {
        const hit = find(x);
        if (hit) return hit;
      }
      return "";
    };
    ws = find(cond);
    return chain;
  };
  chain.limit = async () => (holders.includes(ws) ? [{ userId: "u-1" }] : []);
  return chain as never;
}
const isPublic = (url: string) => url.startsWith("/api/v1/billing/webhooks/");

function call(guard: ReturnType<typeof opsAccessGuard>, workspaceId: string, url = "/api/v1/cops/usage") {
  const warn = vi.fn();
  const reply = { statusCode: 200, body: null as unknown, status(code: number) { this.statusCode = code; return this; }, send(b: unknown) { this.body = b; return this; } };
  const request = { url, method: "GET", workspaceId, userId: "u-1", headers: {}, log: { warn } };
  return guard(request as never, reply as never).then(() => ({ status: reply.statusCode, body: reply.body as { message?: string } | null, warned: warn.mock.calls.length > 0 }));
}

describe("COPS-15 ops:access guard", () => {
  beforeEach(() => {
    perms.value = [];
  });

  it("lets an internal member with ops:access through", async () => {
    perms.value = ["ops:access", "crm:read"];
    const r = await call(opsAccessGuard(db, { INTERNAL_WORKSPACE_ID: INTERNAL, OPS_ACCESS_ENFORCED: "true" }, isPublic), INTERNAL);
    expect(r.status).toBe(200);
  });

  it("refuses a customer workspace Owner (all their workspace permissions, but not internal) with 403", async () => {
    perms.value = ["crm:read", "commercial:read", "billing:manage", "ops:access"];
    const r = await call(opsAccessGuard(db, { INTERNAL_WORKSPACE_ID: INTERNAL, OPS_ACCESS_ENFORCED: "true" }, isPublic), CUSTOMER);
    expect(r.status).toBe(403);
    expect(r.body?.message).toMatch(/Skout staff/);
  });

  it("refuses an internal member without ops:access with 403", async () => {
    perms.value = ["crm:read", "admin:admin"];
    const r = await call(opsAccessGuard(db, { INTERNAL_WORKSPACE_ID: INTERNAL, OPS_ACCESS_ENFORCED: "true" }, isPublic), INTERNAL);
    expect(r.status).toBe(403);
  });

  it("without a setting, the Skout workspace is the one whose members hold Ops access (chain of trust)", async () => {
    const cfg = { INTERNAL_WORKSPACE_ID: undefined, OPS_ACCESS_ENFORCED: undefined, NODE_ENV: "production" as const };
    perms.value = ["ops:access"];
    expect((await call(opsAccessGuard(holderDb([INTERNAL]), cfg, isPublic), INTERNAL)).status).toBe(200);
    // A customer workspace has no holder, so even a role that somehow carried ops:access is refused.
    expect((await call(opsAccessGuard(holderDb([INTERNAL]), cfg, isPublic), CUSTOMER)).status).toBe(403);
    expect(await isInternalWorkspace(holderDb([INTERNAL]), cfg, CUSTOMER)).toBe(false);
  });

  it("only an Owner or Admin who holds Ops access can give it", async () => {
    const cfg = { INTERNAL_WORKSPACE_ID: undefined };
    perms.value = ["ops:access"];
    expect(await canGrantOpsAccess(holderDb([INTERNAL]), cfg, INTERNAL, "u-1", "admin")).toBe(true);
    expect(await canGrantOpsAccess(holderDb([INTERNAL]), cfg, INTERNAL, "u-1", "member")).toBe(false);
    expect(await canGrantOpsAccess(holderDb([INTERNAL]), cfg, CUSTOMER, "u-1", "owner")).toBe(false);
    perms.value = ["admin:admin"];
    expect(await canGrantOpsAccess(holderDb([INTERNAL]), cfg, INTERNAL, "u-1", "owner")).toBe(false);
  });

  it("only logs when switched off for an emergency (OPS_ACCESS_ENFORCED=false)", async () => {
    const r = await call(opsAccessGuard(db, { INTERNAL_WORKSPACE_ID: INTERNAL, OPS_ACCESS_ENFORCED: "false" }, isPublic), CUSTOMER);
    expect(r.status).toBe(200);
    expect(r.warned).toBe(true);
  });

  it("skips public routes (provider webhooks authenticate by signature)", async () => {
    const r = await call(opsAccessGuard(db, { INTERNAL_WORKSPACE_ID: INTERNAL, OPS_ACCESS_ENFORCED: "true" }, isPublic), CUSTOMER, "/api/v1/billing/webhooks/razorpay/payment-links");
    expect(r.status).toBe(200);
  });

  it("reports the state /auth/me returns", async () => {
    perms.value = ["ops:access"];
    expect(await opsAccessState(db, { INTERNAL_WORKSPACE_ID: INTERNAL, OPS_ACCESS_ENFORCED: "false" }, INTERNAL, "u-1")).toEqual({ allowed: true, enforced: false, internalWorkspace: true, hasPermission: true });
    expect((await opsAccessState(db, { INTERNAL_WORKSPACE_ID: INTERNAL, OPS_ACCESS_ENFORCED: "true" }, CUSTOMER, "u-1")).allowed).toBe(false);
  });

  it("refuses a customer with only the internal workspace set (no other setting needed)", async () => {
    const r = await call(opsAccessGuard(db, { INTERNAL_WORKSPACE_ID: INTERNAL, OPS_ACCESS_ENFORCED: undefined }, isPublic), CUSTOMER);
    expect(r.status).toBe(403);
  });

  it("production always enforces with no setting; OPS_ACCESS_ENFORCED=false is only an emergency switch", () => {
    expect(opsAccessEnforced({ INTERNAL_WORKSPACE_ID: undefined, OPS_ACCESS_ENFORCED: undefined, NODE_ENV: "production" })).toBe(true);
    expect(opsAccessEnforced({ INTERNAL_WORKSPACE_ID: undefined, OPS_ACCESS_ENFORCED: "false", NODE_ENV: "production" })).toBe(false);
    expect(opsAccessEnforced({ INTERNAL_WORKSPACE_ID: INTERNAL, OPS_ACCESS_ENFORCED: undefined, NODE_ENV: "development" })).toBe(true);
    expect(opsAccessEnforced({ INTERNAL_WORKSPACE_ID: undefined, OPS_ACCESS_ENFORCED: undefined, NODE_ENV: "development" })).toBe(false);
  });
});
