import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { complianceRoutes } from "./compliance.routes.js";
import { dsarRoutes } from "./dsar.routes.js";

/** Minimal app: injects role/workspace on the request, no DB — role gates must fire before any DB use. */
async function buildApp(role: string | null) {
  const app = Fastify();
  app.decorate("db", {} as never);
  app.addHook("onRequest", async (request) => {
    (request as any).workspaceId = "ws-1";
    (request as any).userId = "u1";
    (request as any).role = role;
  });
  await app.register(complianceRoutes, { prefix: "/api/v1" });
  await app.register(dsarRoutes, { prefix: "/api/v1" });
  await app.ready();
  return app;
}

describe("compliance / DSAR role gates", () => {
  it.each([
    ["POST", "/api/v1/suppressions", { email: "a@b.co" }],
    ["DELETE", "/api/v1/suppressions/11111111-1111-1111-1111-111111111111", undefined],
    ["POST", "/api/v1/dsar", { requestType: "erasure", subjectEmail: "a@b.co" }],
    ["PATCH", "/api/v1/dsar/11111111-1111-1111-1111-111111111111", { status: "completed" }],
  ] as const)("%s %s is 403 for a member", async (method, url, payload) => {
    const app = await buildApp("member");
    const res = await app.inject({ method, url, payload: payload as any });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("is 403 when the role is missing", async () => {
    const app = await buildApp(null);
    const res = await app.inject({ method: "POST", url: "/api/v1/dsar", payload: { requestType: "erasure", subjectEmail: "a@b.co" } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("lets an admin past the gate (fails validation, not authorization)", async () => {
    const app = await buildApp("admin");
    const res = await app.inject({ method: "POST", url: "/api/v1/dsar", payload: { requestType: "bogus" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().details?.fieldErrors ?? res.json().error).toBeTruthy();
    await app.close();
  });

  it("lets a member read the DSAR list gate-wise (GET is not role-gated)", async () => {
    const app = await buildApp("member");
    const res = await app.inject({ method: "GET", url: "/api/v1/dsar" });
    // {} stub db can't run the query → 500 is fine; the point is it is not 403.
    expect(res.statusCode).not.toBe(403);
    await app.close();
  });
});

vi.setConfig({ testTimeout: 20_000 });
