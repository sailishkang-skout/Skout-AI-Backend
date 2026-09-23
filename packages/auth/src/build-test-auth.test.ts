import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthTokenInvalidError } from "./auth-token.js";
import {
  TEST_CLERK_ISSUER,
  TEST_SKOUT_AUTH_ISSUER,
  buildTestAuth,
  buildTestAuthToken,
  ensureTestAuthHarness,
  resetTestAuthHarness,
} from "./build-test-auth.js";
import { resolveAuth } from "./resolve-auth.js";

beforeEach(() => {
  ensureTestAuthHarness();
});

afterEach(() => {
  resetTestAuthHarness();
});

describe("buildTestAuth (AUTH-BE-09)", () => {
  it("verifies clerk-shaped tokens via the fixture provider", async () => {
    const auth = buildTestAuth({
      subject: "user_clerk_1",
      email: "clerk@example.com",
      provider: "clerk",
    });

    const identity = await resolveAuth(auth.token, auth.resolveAuthConfig);
    expect(identity).toMatchObject({
      provider: "clerk",
      subject: "user_clerk_1",
      email: "clerk@example.com",
      emailVerified: true,
    });
  });

  it("verifies skout own-auth issuer tokens (BE-19 prep)", async () => {
    const auth = buildTestAuth({
      provider: "skout",
      subject: "skout_user_42",
      email: "own@skout.test",
      issuer: TEST_SKOUT_AUTH_ISSUER,
    });

    const identity = await resolveAuth(auth.token, {
      clerkJwtIssuer: TEST_SKOUT_AUTH_ISSUER,
      clerkSecretKey: "sk_test",
      authorizedParties: ["http://localhost:3000"],
    });
    expect(identity).toMatchObject({
      provider: "skout",
      subject: "skout_user_42",
      email: "own@skout.test",
    });
  });

  it("rejects unknown issuers without a registered test provider", async () => {
    const token = buildTestAuthToken("https://evil.example", "sub");
    await expect(
      resolveAuth(token, {
        clerkJwtIssuer: TEST_CLERK_ISSUER,
        clerkSecretKey: "sk_test",
        authorizedParties: [],
      })
    ).rejects.toBeInstanceOf(AuthTokenInvalidError);
  });
});
