import type { AuthProvider, AuthVerifyContext, VerifiedIdentity } from "./auth-provider.js";
import { peekJwtIssuer, peekJwtPayloadClaims } from "./jwt-peek.js";
import { AuthTokenInvalidError } from "./auth-token.js";

const identitiesByToken = new Map<string, VerifiedIdentity>();

export function registerFixtureTokenIdentity(token: string, identity: VerifiedIdentity): void {
  identitiesByToken.set(token, identity);
}

export function clearFixtureTokenIdentities(): void {
  identitiesByToken.clear();
}

function defaultIdentityForToken(token: string, providerId: string): VerifiedIdentity {
  const claims = peekJwtPayloadClaims(token);
  const subject = typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : "test-subject";
  const email = typeof claims.email === "string" ? claims.email : "test@example.com";
  const name = typeof claims.name === "string" ? claims.name : "Test User";
  const emailVerified =
    typeof claims.email_verified === "boolean" ? claims.email_verified : true;

  return {
    provider: providerId,
    subject,
    email,
    emailVerified,
    name,
  };
}

export function createFixtureAuthProvider(providerId: string): AuthProvider {
  return {
    id: providerId,
    async verify(token: string, _ctx: AuthVerifyContext): Promise<VerifiedIdentity> {
      if (token.includes("token-with-wrong-kid")) {
        throw new AuthTokenInvalidError();
      }

      const registered = identitiesByToken.get(token);
      if (registered) {
        return registered;
      }

      const issuer = peekJwtIssuer(token);
      if (!issuer) {
        throw new AuthTokenInvalidError();
      }

      return defaultIdentityForToken(token, providerId);
    },
  };
}
