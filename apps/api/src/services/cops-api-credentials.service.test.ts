import { describe, expect, it } from "vitest";
import { generateApiKey, keyMatches, parseApiKey, scopeAllows } from "./cops-api-credentials.service.js";

describe("COPS-14 scoped API keys", () => {
  it("makes a key whose prefix parses back and whose hash matches only that key", () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key.startsWith(`sk_cops_${prefix}_`)).toBe(true);
    expect(parseApiKey(key)).toEqual({ prefix });
    expect(keyMatches(key, hash)).toBe(true);
    expect(keyMatches(`${key}x`, hash)).toBe(false);
    expect(keyMatches(generateApiKey().key, hash)).toBe(false);
  });

  it("rejects strings that are not a well-formed key", () => {
    expect(parseApiKey("sk_cops_short")).toBeNull();
    expect(parseApiKey("Bearer something")).toBeNull();
  });

  it("allows only the routes its scopes list", () => {
    expect(scopeAllows(["accounts:read"], "GET", "/api/v1/accounts/abc/360?fields=header")).toBe(true);
    expect(scopeAllows(["accounts:read"], "POST", "/api/v1/accounts/abc/health/recompute")).toBe(false);
    expect(scopeAllows(["tickets:read"], "PATCH", "/api/v1/tickets/2f1c7a52-6e7b-4b4e-9a3c-1d2e3f4a5b6c")).toBe(false);
    expect(scopeAllows(["tickets:write"], "POST", "/api/v1/tickets")).toBe(true);
    expect(scopeAllows(["tickets:write"], "PATCH", "/api/v1/tickets/2f1c7a52-6e7b-4b4e-9a3c-1d2e3f4a5b6c")).toBe(true);
  });

  it("never opens admin, auth or billing routes, whatever the scopes", () => {
    const all = ["accounts:read", "tickets:read", "tickets:write", "incidents:read", "analytics:read"];
    expect(scopeAllows(all, "GET", "/api/v1/cops/roles")).toBe(false);
    expect(scopeAllows(all, "POST", "/api/v1/cops/apps")).toBe(false);
    expect(scopeAllows(all, "GET", "/api/v1/billing/credits")).toBe(false);
    expect(scopeAllows(all, "POST", "/api/v1/auth/logout")).toBe(false);
    expect(scopeAllows(["made:up"], "GET", "/api/v1/accounts")).toBe(false);
  });
});
