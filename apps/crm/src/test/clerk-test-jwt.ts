export const TEST_CLERK_ISSUER = "https://clerk.test.skout";

export function buildFakeClerkJwt(issuer = TEST_CLERK_ISSUER, subject = "jwt-peek-subject"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: issuer, sub: subject })).toString("base64url");
  return `${header}.${payload}.mock-signature`;
}
