import { jwtVerify, createLocalJWKSet, errors as joseErrors } from "jose";
import type { JSONWebKeySet } from "jose";
import type { AuthProvider, AuthVerifyContext, VerifiedIdentity } from "./auth-provider.js";
import { AuthTokenExpiredError, AuthTokenInvalidError } from "./auth-token.js";

const jwksCache = new Map<string, ReturnType<typeof createLocalJWKSet>>();

function getJwksVerifier(jwksJson: string) {
  let verifier = jwksCache.get(jwksJson);
  if (!verifier) {
    const jwks = JSON.parse(jwksJson) as JSONWebKeySet;
    verifier = createLocalJWKSet(jwks);
    if (jwksCache.size > 4) jwksCache.clear();
    jwksCache.set(jwksJson, verifier);
  }
  return verifier;
}

/** AUTH-BE-19 — own-auth JWT verification provider for the shared verifier. */
export class SkoutAuthProvider implements AuthProvider {
  readonly id = "skout";

  async verify(token: string, ctx: AuthVerifyContext): Promise<VerifiedIdentity> {
    if (!ctx.skoutJwtPublicKeySet || !ctx.skoutJwtIssuer || !ctx.skoutJwtAudience) {
      throw new AuthTokenInvalidError();
    }

    try {
      const verifier = getJwksVerifier(ctx.skoutJwtPublicKeySet);
      const { payload } = await jwtVerify(token, verifier, {
        issuer: ctx.skoutJwtIssuer,
        audience: ctx.skoutJwtAudience,
        algorithms: ["RS256"],
        clockTolerance: 5,
      });

      const subject = payload.sub;
      const sessionId = payload.sid;

      if (typeof subject !== "string" || !subject || typeof sessionId !== "string" || !sessionId) {
        throw new AuthTokenInvalidError();
      }

      return {
        provider: "skout",
        subject,
        sessionId,
        emailVerified: true,
      };
    } catch (err) {
      if (err instanceof AuthTokenInvalidError) throw err;
      if (err instanceof joseErrors.JWTExpired) {
        throw new AuthTokenExpiredError("jwt is expired");
      }
      throw new AuthTokenInvalidError();
    }
  }
}

export const skoutAuthProvider = new SkoutAuthProvider();

