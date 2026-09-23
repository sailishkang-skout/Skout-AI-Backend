import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { AuthErrorCode, AuthErrorMessage } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { authPlugin } from "./auth.js";
import { TEST_CLERK_ISSUER } from "../test/clerk-test-jwt.js";

async function buildCrmAuthProbe() {
  const config = {
    ...loadEnv(),
    CLERK_SECRET_KEY: "sk_test_clerk",
    CLERK_JWT_ISSUER: TEST_CLERK_ISSUER,
    AUTH_STUB: false,
  };
  const app = Fastify({ logger: { level: "fatal" } });
  app.decorate("config", config);
  app.decorate("db", {} as never);
  await app.register(authPlugin);
  app.get("/api/v1/__auth_probe", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("CRM auth plugin — structured error codes (AUTH-BE-08)", () => {
  it("returns AUTH_MISSING_TOKEN for missing bearer", async () => {
    const app = await buildCrmAuthProbe();
    const res = await app.inject({ method: "GET", url: "/api/v1/__auth_probe" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      error: AuthErrorMessage.MISSING_BEARER,
      code: AuthErrorCode.AUTH_MISSING_TOKEN,
    });
    await app.close();
  });
});
