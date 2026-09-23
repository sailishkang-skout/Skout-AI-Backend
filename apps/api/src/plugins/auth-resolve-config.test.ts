import { describe, expect, it } from "vitest";
import { computeAuthorizedParties } from "@skout/auth";
import { buildApiResolveAuthConfig } from "./auth-resolve-config.js";

describe("buildApiResolveAuthConfig", () => {
  it("uses the same authorizedParties as computeAuthorizedParties for API env", () => {
    const config = buildApiResolveAuthConfig({
      CLERK_SECRET_KEY: "sk_test",
      CLERK_JWT_ISSUER: "https://clerk.example",
      CORS_ORIGIN: ["https://app.example.com"],
      FRONTEND_URL: "https://app.example.com",
    });

    expect(config.authorizedParties).toEqual(
      computeAuthorizedParties({
        corsOrigin: ["https://app.example.com"],
        frontendUrl: "https://app.example.com",
      })
    );
  });
});
