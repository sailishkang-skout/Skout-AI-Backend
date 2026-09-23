import { describe, expect, it } from "vitest";
import { buildClerkAppResolveAuthConfig, buildResolveAuthConfig } from "./clerk-auth-config.js";
import { computeAuthorizedParties } from "./authorized-parties.js";

describe("buildClerkAppResolveAuthConfig", () => {
  it("delegates authorizedParties to computeAuthorizedParties", () => {
    const config = buildClerkAppResolveAuthConfig({
      clerkSecretKey: "sk_test",
      clerkJwtIssuer: "https://clerk.example",
      corsOrigin: ["https://app.example.com"],
      frontendUrl: "https://app.example.com",
    });

    expect(config.authorizedParties).toEqual(
      computeAuthorizedParties({
        corsOrigin: ["https://app.example.com"],
        frontendUrl: "https://app.example.com",
      })
    );
    expect(config).toEqual(
      buildResolveAuthConfig({
        clerkSecretKey: "sk_test",
        clerkJwtIssuer: "https://clerk.example",
        corsOrigin: ["https://app.example.com"],
        frontendUrl: "https://app.example.com",
      })
    );
  });

  it("requires CLERK_JWT_ISSUER", () => {
    expect(() =>
      buildClerkAppResolveAuthConfig({
        clerkSecretKey: "sk_test",
        corsOrigin: ["http://localhost:3000"],
      })
    ).toThrow(/CLERK_JWT_ISSUER/);
  });
});
