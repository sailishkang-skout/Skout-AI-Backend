import { generateKeyPair, exportJWK } from "jose";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

async function buildTestApp(overrides: Record<string, unknown> = {}) {
  const config = loadEnv();
  return buildApp({
    ...config,
    CLERK_SECRET_KEY: undefined,
    LOG_LEVEL: "fatal",
    OPENSEARCH_URL: undefined,
    ...overrides,
  } as never);
}

describe("GET /.well-known/jwks.json", () => {
  it("is public — no Authorization header required", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/.well-known/jwks.json" });
    expect(res.statusCode).not.toBe(401);
    await app.close();
  });

  it("returns 503 when own-auth keys are not configured", async () => {
    const app = await buildTestApp({ AUTH_JWT_PUBLIC_KEY_SET: undefined });
    const res = await app.inject({ method: "GET", url: "/.well-known/jwks.json" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("serves the configured public key set with no private material", async () => {
    const { publicKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-kid";
    const app = await buildTestApp({ AUTH_JWT_PUBLIC_KEY_SET: JSON.stringify({ keys: [jwk] }) });
    const res = await app.inject({ method: "GET", url: "/.well-known/jwks.json" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].kid).toBe("test-kid");
    expect(body.keys[0]).not.toHaveProperty("d");
    await app.close();
  });
});
