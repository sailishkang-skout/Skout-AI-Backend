import { computeAuthorizedParties } from "./authorized-parties.js";
import type { AcceptedIssuer, ResolveAuthConfig } from "./resolve-auth.js";

export function buildResolveAuthConfig(input: {
  acceptedIssuers?: AcceptedIssuer[];
  clerkSecretKey?: string;
  clerkJwtIssuer?: string;
  corsOrigin: string[];
  frontendUrl?: string;
  skoutJwtIssuer?: string;
  skoutJwtAudience?: string;
  skoutJwtPublicKeySet?: string;
}): ResolveAuthConfig {
  const accepted = input.acceptedIssuers ?? ["clerk"];
  return {
    acceptedIssuers: accepted,
    clerkSecretKey: input.clerkSecretKey,
    clerkJwtIssuer: input.clerkJwtIssuer,
    authorizedParties: computeAuthorizedParties({
      corsOrigin: input.corsOrigin,
      frontendUrl: input.frontendUrl,
    }),
    skoutJwtIssuer: input.skoutJwtIssuer,
    skoutJwtAudience: input.skoutJwtAudience,
    skoutJwtPublicKeySet: input.skoutJwtPublicKeySet,
  };
}

/** Env-shaped helper for apps/api and apps/crm auth plugins (AUTH-BE-04 / AUTH-BE-05 / AUTH-BE-19). */
export function buildClerkAppResolveAuthConfig(config: {
  acceptedIssuers?: AcceptedIssuer[];
  clerkSecretKey?: string;
  clerkJwtIssuer?: string;
  corsOrigin: string[];
  frontendUrl?: string;
  skoutJwtIssuer?: string;
  skoutJwtAudience?: string;
  skoutJwtPublicKeySet?: string;
}): ResolveAuthConfig {
  const accepted = config.acceptedIssuers ?? ["clerk"];
  if (accepted.includes("clerk") && !config.clerkJwtIssuer) {
    throw new Error("CLERK_JWT_ISSUER is required when Clerk auth is enabled (see AUTH-ADI-03)");
  }
  return buildResolveAuthConfig({
    acceptedIssuers: accepted,
    clerkSecretKey: config.clerkSecretKey,
    clerkJwtIssuer: config.clerkJwtIssuer,
    corsOrigin: config.corsOrigin,
    frontendUrl: config.frontendUrl,
    skoutJwtIssuer: config.skoutJwtIssuer,
    skoutJwtAudience: config.skoutJwtAudience,
    skoutJwtPublicKeySet: config.skoutJwtPublicKeySet,
  });
}
