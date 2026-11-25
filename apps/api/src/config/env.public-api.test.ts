import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv public API config (PAPI-002)", () => {
  let prev: NodeJS.ProcessEnv;
  beforeEach(() => {
    prev = { ...process.env };
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = prev;
    vi.restoreAllMocks();
  });
  const withEnv = (extra: Record<string, string | undefined>) => {
    process.env = { ...prev, NODE_ENV: "test", CORS_ORIGIN: prev.CORS_ORIGIN ?? "http://localhost:3000", ...extra } as NodeJS.ProcessEnv;
    return loadEnv();
  };

  it("is off by default and uses the PRD defaults", () => {
    const env = withEnv({ PUBLIC_API_ENABLED: undefined, API_KEY_PEPPER: undefined });
    expect(env.PUBLIC_API_ENABLED).toBe("false");
    expect(env.PUBLIC_API_BASE_URL).toBe("https://www.skoutai.io/api/public/v1");
    expect([env.PUBLIC_API_RATE_PER_SECOND, env.PUBLIC_API_RATE_PER_MINUTE, env.PUBLIC_API_BATCH_RATE_PER_MINUTE]).toEqual([10, 600, 10]);
    expect([env.PUBLIC_API_FAILED_AUTH_PER_MINUTE, env.PUBLIC_API_FAILED_AUTH_BLOCK_MINUTES]).toEqual([20, 15]);
    expect([env.PUBLIC_API_VERIFY_DAILY_QUOTA, env.PUBLIC_API_SEARCH_DAILY_QUOTA]).toEqual([5000, 10000]);
    expect([env.PUBLIC_API_MAX_ACTIVE_KEYS, env.PUBLIC_API_LOW_BALANCE_THRESHOLD]).toEqual([10, 100]);
  });

  it("refuses to boot when enabled without a pepper", () => {
    expect(() => withEnv({ PUBLIC_API_ENABLED: "true", API_KEY_PEPPER: undefined })).toThrow("Invalid environment configuration");
  });

  it("refuses a short or placeholder pepper", () => {
    expect(() => withEnv({ PUBLIC_API_ENABLED: "true", API_KEY_PEPPER: "too-short-pepper" })).toThrow();
    expect(() => withEnv({ PUBLIC_API_ENABLED: "true", API_KEY_PEPPER: "replace-me" })).toThrow();
  });

  it("boots when enabled with 32 random bytes", () => {
    const env = withEnv({ PUBLIC_API_ENABLED: "true", API_KEY_PEPPER: randomBytes(32).toString("base64") });
    expect(env.PUBLIC_API_ENABLED).toBe("true");
  });
});
