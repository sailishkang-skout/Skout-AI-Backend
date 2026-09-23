import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { loadEnv } from "../config/env.js";
import { authPlugin } from "./auth.js";

describe("API auth plugin boot (AUTH-BE-06)", () => {
  it("registers stub auth when legacy-derived stub config is passed at runtime", async () => {
    const base = loadEnv();
    const app = Fastify({ logger: { level: "fatal" } });
    app.decorate("config", {
      ...base,
      CLERK_SECRET_KEY: undefined,
      AUTH_STUB: false,
      AUTH_MODE_LEGACY_DERIVED: true,
    });
    app.decorate("db", {} as never);
    await app.register(authPlugin);
    await app.ready();
    await app.close();
  });

  it("refuses AUTH_MODE=custom until own-auth verification is wired", async () => {
    const base = loadEnv();
    const app = Fastify({ logger: { level: "fatal" } });
    app.decorate("config", {
      ...base,
      AUTH_MODE: "custom" as const,
      AUTH_MODE_LEGACY_DERIVED: false,
      AUTH_USE_STUB: false,
      AUTH_USE_CLERK_JWT: false,
      AUTH_STUB: false,
      CLERK_SECRET_KEY: "sk_test",
      AUTH_JWT_PUBLIC_KEY_SET: '{"keys":[]}',
      AUTH_JWT_PRIVATE_KEY: "{}",
      AUTH_JWT_KID: "kid",
    });
    app.decorate("db", {} as never);
    await expect(app.register(authPlugin)).rejects.toThrow(/AUTH_MODE=custom/);
  });
});
