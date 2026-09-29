import type { VerifiedIdentity } from "./auth-provider.js";
import { peekJwtAlgorithm, peekJwtIssuer } from "./jwt-peek.js";
import { AuthTokenInvalidError } from "./auth-token.js";
import { clerkAuthProvider } from "./clerk-provider.js";
import { emitAuthVerifyMetric } from "./auth-metrics.js";
import { getTestAuthProvider } from "./test-auth-registry.js";

import { skoutAuthProvider } from "./skout-provider.js";

export type AcceptedIssuer = "clerk" | "skout";

export type ResolveAuthConfig = {
  /** Configured allowed issuers (clerk, skout, or both). Defaults to ["clerk"] if omitted. */
  acceptedIssuers?: AcceptedIssuer[];
  /** Clerk session JWT issuer (AUTH-ADI-03 / CLERK_JWT_ISSUER). */
  clerkJwtIssuer?: string;
  clerkSecretKey?: string;
  authorizedParties?: string[];
  /** Skout own-auth JWT issuer & key material (AUTH-BE-19). */
  skoutJwtIssuer?: string;
  skoutJwtAudience?: string;
  skoutJwtPublicKeySet?: string;
};

/** Configured issuers → provider (Clerk, Skout, or registered test providers). */
function providerForIssuer(issuer: string, config: ResolveAuthConfig) {
  const testProvider = getTestAuthProvider(issuer);
  if (testProvider) {
    if (config.acceptedIssuers && !config.acceptedIssuers.includes(testProvider.id as AcceptedIssuer)) {
      return null;
    }
    return testProvider;
  }

  const accepted = config.acceptedIssuers ?? ["clerk"];
  if (accepted.includes("clerk") && config.clerkJwtIssuer && issuer === config.clerkJwtIssuer) {
    return clerkAuthProvider;
  }
  if (accepted.includes("skout") && config.skoutJwtIssuer && issuer === config.skoutJwtIssuer) {
    return skoutAuthProvider;
  }
  return null;
}

/**
 * Peek `iss` without trusting the token, dispatch to a configured provider, and verify with
 * provider-controlled algorithms/keys (never honor alg from the unsigned header).
 */
export async function resolveAuth(token: string, config: ResolveAuthConfig): Promise<VerifiedIdentity> {
  const alg = peekJwtAlgorithm(token);
  if (alg?.toLowerCase() === "none") {
    emitAuthVerifyMetric({ issuer: "unknown", result: "failure" });
    throw new AuthTokenInvalidError();
  }

  // AUTH-BE-20 — peeked before verification succeeds/fails, purely for the metric tag; never
  // trusted for anything security-relevant (the provider below re-derives and verifies it).
  const issuer = peekJwtIssuer(token);
  if (!issuer) {
    emitAuthVerifyMetric({ issuer: "unknown", result: "failure" });
    throw new AuthTokenInvalidError();
  }

  const provider = providerForIssuer(issuer, config);
  if (!provider) {
    emitAuthVerifyMetric({ issuer, result: "failure" });
    throw new AuthTokenInvalidError();
  }

  try {
    const identity = await provider.verify(token, {
      clerkSecretKey: config.clerkSecretKey,
      authorizedParties: config.authorizedParties,
      skoutJwtIssuer: config.skoutJwtIssuer,
      skoutJwtAudience: config.skoutJwtAudience,
      skoutJwtPublicKeySet: config.skoutJwtPublicKeySet,
    });
    // No userId tag here: resolveAuth only resolves the external provider identity, not the
    // internal users.id (Ground Rule 7's actual identity) — that mapping happens one layer up
    // in resolveOrProvisionUser, called separately by each service's auth plugin.
    emitAuthVerifyMetric({ issuer, result: "success" });
    return identity;
  } catch (err) {
    emitAuthVerifyMetric({ issuer, result: "failure" });
    throw err;
  }
}
