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
