import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "./env.js";

const validClerk = "sk_test_clerk_secret_key_12345";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadEnv auth mode (AUTH-BE-06)", () => {
  it("derives stub when AUTH_STUB=true and Clerk key is empty (e2e-style)", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTH_STUB", "true");
    vi.stubEnv("CLERK_SECRET_KEY", "");
    delete process.env.AUTH_MODE;

    const env = loadEnv();
    expect(env.AUTH_MODE).toBe("stub");
    expect(env.AUTH_USE_STUB).toBe(true);
    expect(env.AUTH_MODE_LEGACY_DERIVED).toBe(true);
  });

  it("derives clerk when legacy vars point at Clerk", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTH_STUB", "false");
    vi.stubEnv("CLERK_SECRET_KEY", validClerk);
    delete process.env.AUTH_MODE;

    const env = loadEnv();
    expect(env.AUTH_MODE).toBe("clerk");
    expect(env.AUTH_USE_STUB).toBe(false);
  });

  it("refuses production when legacy-derived stub", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_STUB", "false");
    vi.stubEnv("CLERK_SECRET_KEY", "");
    delete process.env.AUTH_MODE;

    expect(() => loadEnv()).toThrow("Production requires CLERK_SECRET_KEY and AUTH_STUB must be false");
  });

  it("refuses production + AUTH_MODE=clerk without Clerk key", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_MODE", "clerk");
    vi.stubEnv("AUTH_STUB", "false");
    vi.stubEnv("CLERK_SECRET_KEY", "");
    expect(() => loadEnv()).toThrow("Production requires CLERK_SECRET_KEY and AUTH_STUB must be false");
  });
});
