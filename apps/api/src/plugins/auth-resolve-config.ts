import {
  buildClerkAppResolveAuthConfig,
  parseAcceptedIssuers,
  type ResolveAuthConfig,
} from "@skout/auth";
import type { Env } from "../config/env.js";

export type ApiResolveAuthEnv = Pick<
  Env,
  "CLERK_SECRET_KEY" | "CLERK_JWT_ISSUER" | "CORS_ORIGIN" | "FRONTEND_URL"
> &
  Partial<
    Pick<
      Env,
      | "AUTH_ACCEPTED_ISSUERS"
      | "AUTH_MODE"
      | "AUTH_JWT_ISSUER"
      | "AUTH_JWT_AUDIENCE"
      | "AUTH_JWT_PUBLIC_KEY_SET"
    >
  >;

/** Shared `resolveAuth` config for the API auth plugin and POST /auth/step-up. */
export function buildApiResolveAuthConfig(config: ApiResolveAuthEnv): ResolveAuthConfig {
  return buildClerkAppResolveAuthConfig({
    clerkSecretKey: config.CLERK_SECRET_KEY,
    clerkJwtIssuer: config.CLERK_JWT_ISSUER,
    corsOrigin: config.CORS_ORIGIN,
    frontendUrl: config.FRONTEND_URL,
    acceptedIssuers: parseAcceptedIssuers(config.AUTH_ACCEPTED_ISSUERS, config.AUTH_MODE),
    skoutJwtIssuer: config.AUTH_JWT_ISSUER,
    skoutJwtAudience: config.AUTH_JWT_AUDIENCE,
    skoutJwtPublicKeySet: config.AUTH_JWT_PUBLIC_KEY_SET,
  });
}
