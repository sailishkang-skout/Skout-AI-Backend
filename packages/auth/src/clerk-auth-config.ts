import { computeAuthorizedParties } from "./authorized-parties.js";
import type { ResolveAuthConfig } from "./resolve-auth.js";

export function buildResolveAuthConfig(input: {
  clerkSecretKey: string;
  clerkJwtIssuer: string;
  corsOrigin: string[];
  frontendUrl?: string;
}): ResolveAuthConfig {
  return {
    clerkSecretKey: input.clerkSecretKey,
    clerkJwtIssuer: input.clerkJwtIssuer,
    authorizedParties: computeAuthorizedParties({
      corsOrigin: input.corsOrigin,
      frontendUrl: input.frontendUrl,
    }),
  };
}

/** Env-shaped helper for apps/api and apps/crm auth plugins (AUTH-BE-04 / AUTH-BE-05). */
export function buildClerkAppResolveAuthConfig(config: {
  clerkSecretKey: string;
  clerkJwtIssuer?: string;
  corsOrigin: string[];
  frontendUrl?: string;
}): ResolveAuthConfig {
  const clerkJwtIssuer = config.clerkJwtIssuer;
  if (!clerkJwtIssuer) {
    throw new Error("CLERK_JWT_ISSUER is required when Clerk auth is enabled (see AUTH-ADI-03)");
  }
  return buildResolveAuthConfig({
    clerkSecretKey: config.clerkSecretKey,
    clerkJwtIssuer,
    corsOrigin: config.corsOrigin,
    frontendUrl: config.frontendUrl,
  });
}
