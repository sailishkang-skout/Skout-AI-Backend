import { beforeEach, describe, expect, it, vi } from "vitest";

const perms = vi.hoisted(() => ({ value: [] as string[] }));
vi.mock("@skout/auth", () => ({ getMemberPermissions: vi.fn(async () => perms.value) }));

import { opsAccessEnforced, opsAccessGuard, opsAccessState } from "./ops-access.service.js";

const INTERNAL = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "22222222-2222-4222-8222-222222222222";
const db = {} as never;
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

  it("fails closed when enforced but the internal workspace is not configured", async () => {
    perms.value = ["ops:access"];
    const r = await call(opsAccessGuard(db, { INTERNAL_WORKSPACE_ID: undefined, OPS_ACCESS_ENFORCED: "true" }, isPublic), INTERNAL);
    expect(r.status).toBe(403);
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

  it("enforces as soon as the internal workspace is set; OPS_ACCESS_ENFORCED=false is only an emergency switch", () => {
    expect(opsAccessEnforced({ INTERNAL_WORKSPACE_ID: INTERNAL, OPS_ACCESS_ENFORCED: undefined })).toBe(true);
    expect(opsAccessEnforced({ INTERNAL_WORKSPACE_ID: INTERNAL, OPS_ACCESS_ENFORCED: "false" })).toBe(false);
    expect(opsAccessEnforced({ INTERNAL_WORKSPACE_ID: undefined, OPS_ACCESS_ENFORCED: undefined })).toBe(false);
  });
});
