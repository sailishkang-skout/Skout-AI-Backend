/** Vitest stub — real @clerk/backend is used at runtime in production. */
export async function verifyToken(_token: string, _opts: { secretKey: string }) {
  return {
    sub: "clerk_test_user",
    email: "test@example.com",
    name: "Test User",
  };
}
