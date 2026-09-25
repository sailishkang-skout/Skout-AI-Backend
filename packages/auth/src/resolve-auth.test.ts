import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthTokenInvalidError } from "./auth-token.js";
import {
  ensureTestAuthHarness,
  resetTestAuthHarness,
  TEST_CLERK_ISSUER,
  TEST_SKOUT_AUTH_ISSUER,
} from "./build-test-auth.js";
import { resolveAuth, type AcceptedIssuer } from "./resolve-auth.js";

beforeEach(() => {
  ensureTestAuthHarness();
});

afterEach(() => {
  resetTestAuthHarness();
});

const ISSUER = TEST_CLERK_ISSUER;

function jwt(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const b64 = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64(header)}.${b64(payload)}.signature`;
}

const config = {
  clerkJwtIssuer: ISSUER,
  clerkSecretKey: "sk_test",
  authorizedParties: ["http://localhost:3000"],
};

describe("resolveAuth (AUTH-BE-03)", () => {
  it("rejects unknown issuer", async () => {
    const token = jwt({ alg: "RS256", kid: "k1" }, { iss: "https://evil.example", sub: "user_1" });
    await expect(resolveAuth(token, config)).rejects.toBeInstanceOf(AuthTokenInvalidError);
  });

  it("rejects alg:none before verification", async () => {
    const token = jwt({ alg: "none", typ: "JWT" }, { iss: ISSUER, sub: "user_1" });
    await expect(resolveAuth(token, config)).rejects.toBeInstanceOf(AuthTokenInvalidError);
  });

  it("rejects wrong-kid tokens from Clerk verification", async () => {
    const token = `token-with-wrong-kid.${jwt({ alg: "RS256" }, { iss: ISSUER, sub: "user_wrong_kid" }).split(".")[1]}.sig`;
    await expect(resolveAuth(token, config)).rejects.toBeInstanceOf(AuthTokenInvalidError);
  });

  it("returns verified identity for allowlisted issuer", async () => {
    const token = jwt({ alg: "RS256", kid: "k1" }, { iss: ISSUER, sub: "user_ok" });
    const identity = await resolveAuth(token, config);
    expect(identity).toMatchObject({
      provider: "clerk",
      subject: "user_ok",
      email: "test@example.com",
      emailVerified: true,
    });
  });

  describe("Dual-verify with Skout issuer (AUTH-BE-19)", () => {
    it("returns verified identity for Skout issuer when acceptedIssuers includes skout", async () => {
      const token = jwt({ alg: "RS256", kid: "k1" }, { iss: TEST_SKOUT_AUTH_ISSUER, sub: "user_skout_1" });
      const dualConfig = {
        ...config,
        acceptedIssuers: ["clerk", "skout"] as AcceptedIssuer[],
        skoutJwtIssuer: TEST_SKOUT_AUTH_ISSUER,
        skoutJwtAudience: "skout-api",
      };
      const identity = await resolveAuth(token, dualConfig);
      expect(identity).toMatchObject({
        provider: "skout",
        subject: "user_skout_1",
      });
    });

    it("rejects Skout token when acceptedIssuers is clerk-only", async () => {
      const token = jwt({ alg: "RS256", kid: "k1" }, { iss: TEST_SKOUT_AUTH_ISSUER, sub: "user_skout_1" });
      const clerkOnlyConfig = {
        ...config,
        acceptedIssuers: ["clerk"] as AcceptedIssuer[],
        skoutJwtIssuer: TEST_SKOUT_AUTH_ISSUER,
      };
      await expect(resolveAuth(token, clerkOnlyConfig)).rejects.toBeInstanceOf(AuthTokenInvalidError);
    });

    it("rejects Clerk token when acceptedIssuers is skout-only", async () => {
      const token = jwt({ alg: "RS256", kid: "k1" }, { iss: ISSUER, sub: "user_ok" });
      const skoutOnlyConfig = {
        ...config,
        acceptedIssuers: ["skout"] as AcceptedIssuer[],
        skoutJwtIssuer: TEST_SKOUT_AUTH_ISSUER,
      };
      await expect(resolveAuth(token, skoutOnlyConfig)).rejects.toBeInstanceOf(AuthTokenInvalidError);
    });

    it("accepts both Clerk and Skout tokens when in dual mode", async () => {
      const dualConfig = {
        ...config,
        acceptedIssuers: ["clerk", "skout"] as AcceptedIssuer[],
        skoutJwtIssuer: TEST_SKOUT_AUTH_ISSUER,
      };

      const clerkToken = jwt({ alg: "RS256", kid: "k1" }, { iss: ISSUER, sub: "user_clerk" });
      const clerkId = await resolveAuth(clerkToken, dualConfig);
      expect(clerkId.provider).toBe("clerk");

      const skoutToken = jwt({ alg: "RS256", kid: "k1" }, { iss: TEST_SKOUT_AUTH_ISSUER, sub: "user_skout" });
      const skoutId = await resolveAuth(skoutToken, dualConfig);
      expect(skoutId.provider).toBe("skout");
    });
  });
});
