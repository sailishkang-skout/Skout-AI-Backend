import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv OpenRouter alias", () => {
  it("maps OPEN_ROUTER_API_KEY onto OPENROUTER_API_KEY", () => {
    const prev = { ...process.env };
    try {
      process.env = {
        ...prev,
        NODE_ENV: "test",
        OPENROUTER_API_KEY: undefined,
        OPEN_ROUTER_API_KEY: "sk-or-alias-test",
      } as NodeJS.ProcessEnv;
      // CORS_ORIGIN may be required — keep existing or set default
      if (!process.env.CORS_ORIGIN) process.env.CORS_ORIGIN = "http://localhost:3000";
      const env = loadEnv();
      expect(env.OPENROUTER_API_KEY).toBe("sk-or-alias-test");
    } finally {
      process.env = prev;
    }
  });
});
