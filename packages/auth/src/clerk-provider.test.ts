import { describe, expect, it, vi } from "vitest";
import { clerkAuthProvider } from "./clerk-provider.js";
import { AuthTokenExpiredError, AuthTokenInvalidError } from "./auth-token.js";

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async () => {
    throw new Error("jwt is expired");
  }),
}));

describe("ClerkAuthProvider", () => {
  it("maps Clerk expired failures to AuthTokenExpiredError with original message", async () => {
    await expect(
      clerkAuthProvider.verify("token", {
        clerkSecretKey: "sk_test",
        authorizedParties: ["http://localhost:3000"],
      })
    ).rejects.toBeInstanceOf(AuthTokenExpiredError);

    await expect(
      clerkAuthProvider.verify("token", {
        clerkSecretKey: "sk_test",
        authorizedParties: ["http://localhost:3000"],
      })
    ).rejects.toMatchObject({ message: "jwt is expired" });
  });

  it("maps other Clerk failures to AuthTokenInvalidError", async () => {
    const { verifyToken } = await import("@clerk/backend");
    vi.mocked(verifyToken).mockRejectedValueOnce(new Error("invalid signature"));

    await expect(
      clerkAuthProvider.verify("token", {
        clerkSecretKey: "sk_test",
        authorizedParties: ["http://localhost:3000"],
      })
    ).rejects.toBeInstanceOf(AuthTokenInvalidError);
  });
});
