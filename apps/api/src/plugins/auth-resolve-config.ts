import { buildResolveAuthConfig, type ResolveAuthConfig } from "@skout/auth";
import type { Env } from "../config/env.js";

/** Shared Clerk `resolveAuth` config for the API auth plugin and POST /auth/step-up. */
export function buildApiResolveAuthConfig(
  config: Pick<Env, "CLERK_SECRET_KEY" | "CLERK_JWT_ISSUER" | "CORS_ORIGIN" | "FRONTEND_URL">
): ResolveAuthConfig {
  const clerkJwtIssuer = config.CLERK_JWT_ISSUER;
  if (!clerkJwtIssuer) {
    throw new Error("CLERK_JWT_ISSUER is required when Clerk auth is enabled (see AUTH-ADI-03)");
  }
  return buildResolveAuthConfig({
    clerkSecretKey: config.CLERK_SECRET_KEY!,
    clerkJwtIssuer,
    corsOrigin: config.CORS_ORIGIN,
    frontendUrl: config.FRONTEND_URL,
  });
}
