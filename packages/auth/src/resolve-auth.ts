import type { VerifiedIdentity } from "./auth-provider.js";
import { peekJwtAlgorithm, peekJwtIssuer } from "./jwt-peek.js";
import { AuthTokenInvalidError } from "./auth-token.js";
import { clerkAuthProvider } from "./clerk-provider.js";

export type ResolveAuthConfig = {
  /** Clerk session JWT issuer (AUTH-ADI-03 / CLERK_JWT_ISSUER). */
  clerkJwtIssuer: string;
  clerkSecretKey: string;
  authorizedParties: string[];
};

/** Configured issuers → provider (Skout issuer added in a later ticket). */
function providerForIssuer(issuer: string, config: ResolveAuthConfig) {
  if (issuer === config.clerkJwtIssuer) return clerkAuthProvider;
  return null;
}

/**
 * Peek `iss` without trusting the token, dispatch to a configured provider, and verify with
 * provider-controlled algorithms/keys (never honor alg from the unsigned header).
 */
export async function resolveAuth(token: string, config: ResolveAuthConfig): Promise<VerifiedIdentity> {
  const alg = peekJwtAlgorithm(token);
  if (alg?.toLowerCase() === "none") {
    throw new AuthTokenInvalidError();
  }

  const issuer = peekJwtIssuer(token);
  if (!issuer) {
    throw new AuthTokenInvalidError();
  }

  const provider = providerForIssuer(issuer, config);
  if (!provider) {
    throw new AuthTokenInvalidError();
  }

  return provider.verify(token, {
    clerkSecretKey: config.clerkSecretKey,
    authorizedParties: config.authorizedParties,
  });
}
