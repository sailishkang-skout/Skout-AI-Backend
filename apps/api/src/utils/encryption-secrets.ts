import type { Env } from "../config/env.js";
import { isConfiguredSecret } from "@skout/observability";

/**
 * Gets the integration encryption key, following strict production rules:
 * - In production: fails hard if INTEGRATION_ENCRYPTION_KEY is missing or is a placeholder
 * - In non-production: falls back to a dev default only if no valid key is provided
 * Never uses CLERK_SECRET_KEY as a fallback anymore (AUTH-BE-07)
 */
export function getIntegrationEncryptionSecret(config: Env): string {
  const { NODE_ENV, INTEGRATION_ENCRYPTION_KEY } = config;
  
  if (isConfiguredSecret(INTEGRATION_ENCRYPTION_KEY)) {
    return INTEGRATION_ENCRYPTION_KEY!;
  }

  // In production, fail hard if we don't have a valid key
  if (NODE_ENV === "production") {
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY must be set to a valid non-placeholder value in production. " +
      "Please configure this secret in your environment before starting the server."
    );
  }

  // In development/test, use the dev fallback
  return "dev-integration-encryption-key-change-me";
}

/**
 * Gets the HubSpot OAuth state secret, following strict production rules:
 * - In production: fails hard if HUBSPOT_CLIENT_SECRET is missing or is a placeholder
 * - In non-production: falls back to a dev default only if no valid key is provided
 * Never uses CLERK_SECRET_KEY as a fallback anymore (AUTH-BE-07)
 */
export function getHubSpotOAuthSecret(config: Env): string {
  const { NODE_ENV, HUBSPOT_CLIENT_SECRET } = config;
  
  if (isConfiguredSecret(HUBSPOT_CLIENT_SECRET)) {
    return HUBSPOT_CLIENT_SECRET!;
  }

  // In production, fail hard if we don't have a valid key
  if (NODE_ENV === "production") {
    throw new Error(
      "HUBSPOT_CLIENT_SECRET must be set to a valid non-placeholder value in production. " +
      "Please configure this secret in your environment before starting the server."
    );
  }

  // In development/test, use the dev fallback
  return "dev-oauth-state";
}