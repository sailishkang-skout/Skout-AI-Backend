/** Vitest stub — production resolves `@clerk/backend` from packages/auth only. */
export async function verifyToken(token: string, _opts: { secretKey: string }) {
  if (token.includes("token-with-wrong-kid")) {
    throw new Error("JWK kid not found");
  }
  return {
    sub: "clerk_test_user",
    email: "test@example.com",
    email_verified: true,
    name: "Test User",
  };
}
